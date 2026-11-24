// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";

/// @title LOCKRA Arena
/// @notice One-versus-one Rock, Paper, Scissors with a $LOCKRA stake held in escrow by this contract.
///
/// How a game works:
///   1. The host opens a game with a stake and a sealed move (a commitment hash).
///   2. A challenger matches the stake and seals their own move.
///   3. Both players reveal. The contract checks every reveal against its commitment.
///   4. The winner receives both stakes minus the arena fee, which is burned.
///
/// Neither player can see the other's move before both are sealed, and nobody, the LOCKRA team
/// included, can move the escrowed tokens anywhere other than back to the players or to the burn
/// address. If a payout ever fails (for example the token refuses one address), the amount is kept
/// for that address and can be pulled later with `withdraw`, so one bad transfer can never lock a
/// game or the other player's tokens. If a player refuses to reveal, the other player can claim the pot once the reveal
/// window closes. If nobody reveals, both stakes are refunded in full.
///
/// @dev Commitments are `keccak256(abi.encode(address(this), block.chainid, player, move, salt))`.
///      Binding the player address stops a challenger from copying the host's commitment, and
///      binding the contract and chain stops a commitment from being replayed on another deployment.
///      The stake token is expected to be a standard ERC-20; deposits are checked by balance delta,
///      so a token that takes a fee on transfer is rejected instead of silently under-funding a pot.
contract LockraArena {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum Move {
        None,
        Rock,
        Paper,
        Scissors
    }

    enum Status {
        None,
        Open,
        Active,
        Settled,
        Cancelled
    }

    /// @dev Packed into six storage slots.
    struct Game {
        address host; //                  slot 0
        uint40 createdAt; //              slot 0
        uint40 revealDeadline; //         slot 0
        Status status; //                 slot 0
        Move hostMove; //                 slot 0
        address challenger; //            slot 1
        Move challengerMove; //           slot 1
        uint16 feeBps; //                 slot 1: fee locked in when the game was opened
        uint128 stake; //                 slot 2
        address invited; //               slot 3: zero for an open game, else the only allowed challenger
        bytes32 hostCommitment; //        slot 4
        bytes32 challengerCommitment; //  slot 5
    }

    // ---------------------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------------------

    /// @notice Where the arena fee goes. Tokens sent here are gone for good.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Hard ceiling for the arena fee: 5%.
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice Bounds for the reveal window the owner may configure.
    uint32 public constant MIN_REVEAL_WINDOW = 10 minutes;
    uint32 public constant MAX_REVEAL_WINDOW = 3 days;

    uint256 private constant BPS = 10_000;

    /// @notice The token every stake is paid in ($LOCKRA).
    IERC20 public immutable token;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @notice Arena owner. It can tune limits for new games and pause new games. It can never
    ///         touch tokens held in escrow, and changes never affect games already in progress.
    address public owner;
    address public pendingOwner;

    /// @notice When true, no new game can be opened or joined. Reveals, claims and cancels still work,
    ///         so players can always get their tokens out.
    bool public paused;

    /// @notice Fee in basis points for new games, burned from the pot when a game has a winner.
    ///         Draws and refunds are free. Each game keeps the fee it was opened with.
    uint16 public feeBps;

    /// @notice Seconds both players have to reveal once a challenger joins.
    uint32 public revealWindow;

    /// @notice Smallest and largest stake accepted for a new game, in token base units.
    uint128 public minStake;
    uint128 public maxStake;

    /// @notice Number of games ever opened. Game ids start at 1.
    uint256 public gameCount;

    mapping(uint256 gameId => Game) private _games;

    /// @notice Payouts that could not be sent when a game settled, waiting to be withdrawn.
    mapping(address account => uint256) public owed;

    /// @dev Reentrancy lock: 1 = unlocked, 2 = locked.
    uint256 private _lock = 1;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event GameCreated(uint256 indexed gameId, address indexed host, address indexed invited, uint256 stake);
    event GameJoined(uint256 indexed gameId, address indexed challenger, uint256 revealDeadline);
    event MoveRevealed(uint256 indexed gameId, address indexed player, Move move);
    event GameWon(
        uint256 indexed gameId, address indexed winner, address indexed loser, uint256 payout, uint256 burned
    );
    event GameDrawn(uint256 indexed gameId);
    event GameRefunded(uint256 indexed gameId);
    event GameCancelled(uint256 indexed gameId);
    event PayoutDeferred(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    event FeeUpdated(uint16 feeBps);
    event RevealWindowUpdated(uint32 revealWindow);
    event StakeLimitsUpdated(uint128 minStake, uint128 maxStake);
    event Paused(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error NotOwner();
    error NotPendingOwner();
    error ArenaPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroCommitment();
    error StakeOutOfRange(uint256 stake, uint256 min, uint256 max);
    error InvalidLimits();
    error FeeTooHigh();
    error RevealWindowOutOfRange();
    error GameNotFound();
    error WrongStatus(Status expected, Status actual);
    error NotInvited();
    error CannotPlayYourself();
    error NotAPlayer();
    error AlreadyRevealed();
    error InvalidMove();
    error CommitmentMismatch();
    error RevealWindowClosed();
    error RevealWindowOpen();
    error OnlyHost();
    error TransferFailed();
    error DepositMismatch(uint256 expected, uint256 received);
    error NothingOwed();

    // ---------------------------------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ArenaPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    /// @param token_        The stake token ($LOCKRA).
    /// @param owner_        Initial owner.
    /// @param feeBps_       Arena fee in basis points (at most 5%).
    /// @param revealWindow_ Seconds to reveal after a challenger joins.
    /// @param minStake_     Smallest accepted stake.
    /// @param maxStake_     Largest accepted stake.
    constructor(
        IERC20 token_,
        address owner_,
        uint16 feeBps_,
        uint32 revealWindow_,
        uint128 minStake_,
        uint128 maxStake_
    ) {
        if (address(token_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        _setFee(feeBps_);
        _setRevealWindow(revealWindow_);
        _setStakeLimits(minStake_, maxStake_);
    }

    // ---------------------------------------------------------------------------------------------
    // Playing
    // ---------------------------------------------------------------------------------------------

    /// @notice Open a game and seal your move.
    /// @param stake      Tokens each player puts in. Approve this contract for `stake` first.
    /// @param commitment `commitmentFor(msg.sender, move, salt)`, computed off-chain with a secret salt.
    /// @param invited    Optional: the only address allowed to join. Zero opens the game to anyone.
    /// @return gameId    Id of the new game.
    function createGame(uint128 stake, bytes32 commitment, address invited)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 gameId)
    {
        if (stake < minStake || stake > maxStake) revert StakeOutOfRange(stake, minStake, maxStake);
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (invited == msg.sender) revert CannotPlayYourself();

        gameId = ++gameCount;
        Game storage g = _games[gameId];
        g.host = msg.sender;
        g.createdAt = uint40(block.timestamp);
        g.status = Status.Open;
        g.feeBps = feeBps;
        g.stake = stake;
        g.invited = invited;
        g.hostCommitment = commitment;

        _pull(msg.sender, stake);
        emit GameCreated(gameId, msg.sender, invited, stake);
    }

    /// @notice Join an open game by matching its stake and sealing your move.
    /// @param gameId     The game to join.
    /// @param commitment `commitmentFor(msg.sender, move, salt)`.
    function joinGame(uint256 gameId, bytes32 commitment) external nonReentrant whenNotPaused {
        Game storage g = _existing(gameId);
        if (g.status != Status.Open) revert WrongStatus(Status.Open, g.status);
        if (msg.sender == g.host) revert CannotPlayYourself();
        if (g.invited != address(0) && msg.sender != g.invited) revert NotInvited();
        if (commitment == bytes32(0)) revert ZeroCommitment();

        uint40 deadline = uint40(block.timestamp + revealWindow);
        g.challenger = msg.sender;
        g.challengerCommitment = commitment;
        g.revealDeadline = deadline;
        g.status = Status.Active;

        _pull(msg.sender, g.stake);
        emit GameJoined(gameId, msg.sender, deadline);
    }

    /// @notice Reveal your sealed move. Settles the game as soon as both moves are in.
    /// @param gameId The game.
    /// @param move   The move you sealed.
    /// @param salt   The secret salt you sealed it with.
    function reveal(uint256 gameId, Move move, bytes32 salt) external nonReentrant {
        Game storage g = _existing(gameId);
        if (g.status != Status.Active) revert WrongStatus(Status.Active, g.status);
        if (block.timestamp > g.revealDeadline) revert RevealWindowClosed();
        if (move == Move.None || uint8(move) > uint8(Move.Scissors)) revert InvalidMove();

        bool isHost = msg.sender == g.host;
        if (!isHost && msg.sender != g.challenger) revert NotAPlayer();

        bytes32 expected = isHost ? g.hostCommitment : g.challengerCommitment;
        if (commitmentFor(msg.sender, move, salt) != expected) revert CommitmentMismatch();

        if (isHost) {
            if (g.hostMove != Move.None) revert AlreadyRevealed();
            g.hostMove = move;
        } else {
            if (g.challengerMove != Move.None) revert AlreadyRevealed();
            g.challengerMove = move;
        }
        emit MoveRevealed(gameId, msg.sender, move);

        if (g.hostMove != Move.None && g.challengerMove != Move.None) _settle(gameId, g);
    }

    /// @notice Close a game whose reveal window has passed. Anyone may call it; tokens only ever
    ///         go to the players (and the fee to the burn address).
    ///         One reveal: that player wins the pot. No reveals: both stakes are refunded in full.
    function claimTimeout(uint256 gameId) external nonReentrant {
        Game storage g = _existing(gameId);
        if (g.status != Status.Active) revert WrongStatus(Status.Active, g.status);
        if (block.timestamp <= g.revealDeadline) revert RevealWindowOpen();

        bool hostIn = g.hostMove != Move.None;
        bool challengerIn = g.challengerMove != Move.None;

        g.status = Status.Settled;
        if (hostIn) {
            _payWinner(gameId, g, g.host, g.challenger);
        } else if (challengerIn) {
            _payWinner(gameId, g, g.challenger, g.host);
        } else {
            emit GameRefunded(gameId);
            _push(g.host, g.stake);
            _push(g.challenger, g.stake);
        }
    }

    /// @notice Withdraw a game nobody has joined yet. The host gets the stake back in full.
    function cancelGame(uint256 gameId) external nonReentrant {
        Game storage g = _existing(gameId);
        if (g.status != Status.Open) revert WrongStatus(Status.Open, g.status);
        if (msg.sender != g.host) revert OnlyHost();

        g.status = Status.Cancelled;
        emit GameCancelled(gameId);
        _push(g.host, g.stake);
    }

    /// @notice Pull a payout that could not be sent automatically. You may send it to another address
    ///         you control, for example when your own address cannot receive the token.
    function withdraw(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, to, amount);
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The commitment a player must submit for `move` sealed with `salt`.
    function commitmentFor(address player, Move move, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, player, move, salt));
    }

    /// @notice Full state of a game.
    function getGame(uint256 gameId) external view returns (Game memory) {
        return _games[gameId];
    }

    /// @notice What the winner of a new game with this stake would receive, and what would be burned.
    function payoutFor(uint256 stake) external view returns (uint256 payout, uint256 burned) {
        return _split(stake, feeBps);
    }

    /// @notice 0 = draw, 1 = first move wins, 2 = second move wins.
    function outcome(Move a, Move b) public pure returns (uint8) {
        if (a == b) return 0;
        // Rock(1) beats Scissors(3), Paper(2) beats Rock(1), Scissors(3) beats Paper(2).
        return (uint8(a) + 3 - uint8(b)) % 3 == 1 ? 1 : 2;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    function setRevealWindow(uint32 revealWindow_) external onlyOwner {
        _setRevealWindow(revealWindow_);
    }

    function setStakeLimits(uint128 minStake_, uint128 maxStake_) external onlyOwner {
        _setStakeLimits(minStake_, maxStake_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Start a two-step ownership transfer. The new owner must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Give up ownership for good. Fee, limits and pause state stay frozen as they are.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _settle(uint256 gameId, Game storage g) private {
        g.status = Status.Settled;
        uint8 result = outcome(g.hostMove, g.challengerMove);
        if (result == 0) {
            emit GameDrawn(gameId);
            _push(g.host, g.stake);
            _push(g.challenger, g.stake);
        } else if (result == 1) {
            _payWinner(gameId, g, g.host, g.challenger);
        } else {
            _payWinner(gameId, g, g.challenger, g.host);
        }
    }

    function _payWinner(uint256 gameId, Game storage g, address winner, address loser) private {
        (uint256 payout, uint256 burned) = _split(g.stake, g.feeBps);
        emit GameWon(gameId, winner, loser, payout, burned);
        _push(winner, payout);
        if (burned != 0) _push(BURN_ADDRESS, burned);
    }

    function _split(uint256 stake, uint256 fee) private pure returns (uint256 payout, uint256 burned) {
        uint256 pot = stake * 2;
        burned = (pot * fee) / BPS;
        payout = pot - burned;
    }

    function _existing(uint256 gameId) private view returns (Game storage g) {
        g = _games[gameId];
        if (g.status == Status.None) revert GameNotFound();
    }

    function _pull(address from, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert DepositMismatch(amount, received);
    }

    /// @dev Never reverts: if the transfer fails, the amount is kept for `to` to withdraw later.
    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))))) return;
        owed[to] += amount;
        emit PayoutDeferred(to, amount);
    }

    /// @dev Accepts tokens that return nothing as well as tokens that return a bool.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _setFee(uint16 feeBps_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function _setRevealWindow(uint32 revealWindow_) private {
        if (revealWindow_ < MIN_REVEAL_WINDOW || revealWindow_ > MAX_REVEAL_WINDOW) revert RevealWindowOutOfRange();
        revealWindow = revealWindow_;
        emit RevealWindowUpdated(revealWindow_);
    }

    function _setStakeLimits(uint128 minStake_, uint128 maxStake_) private {
        if (minStake_ == 0 || minStake_ > maxStake_) revert InvalidLimits();
        minStake = minStake_;
        maxStake = maxStake_;
        emit StakeLimitsUpdated(minStake_, maxStake_);
    }
}
