// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LockraArena} from "../src/LockraArena.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockToken, FeeOnTransferToken, ReentrantToken, BlockingToken} from "./mocks/MockToken.sol";

contract LockraArenaTest is Test {
    LockraArena internal arena;
    MockToken internal token;

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint128 internal constant STAKE = 100_000 ether;
    uint16 internal constant FEE = 250; // 2.5%
    uint32 internal constant WINDOW = 1 hours;

    bytes32 internal constant SALT_A = keccak256("alice salt");
    bytes32 internal constant SALT_B = keccak256("bob salt");

    LockraArena.Move internal constant ROCK = LockraArena.Move.Rock;
    LockraArena.Move internal constant PAPER = LockraArena.Move.Paper;
    LockraArena.Move internal constant SCISSORS = LockraArena.Move.Scissors;

    function setUp() public {
        token = new MockToken();
        arena = new LockraArena(IERC20(address(token)), owner, FEE, WINDOW, 1_000 ether, 10_000_000 ether);
        for (uint256 i; i < 3; ++i) {
            address p = [alice, bob, carol][i];
            token.mint(p, 1_000_000 ether);
            vm.prank(p);
            token.approve(address(arena), type(uint256).max);
        }
    }

    // ----------------------------------------------------------------------------------- helpers

    /// @dev Hashed locally on purpose: an external call here would consume a pending `vm.prank`.
    function _commit(address player, LockraArena.Move move, bytes32 salt) internal view returns (bytes32) {
        return _commitOn(arena, player, move, salt);
    }

    function _commitOn(LockraArena a, address player, LockraArena.Move move, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(a), block.chainid, player, move, salt));
    }

    function _open(LockraArena.Move move) internal returns (uint256 id) {
        vm.prank(alice);
        id = arena.createGame(STAKE, _commit(alice, move, SALT_A), address(0));
    }

    function _join(uint256 id, LockraArena.Move move) internal {
        vm.prank(bob);
        arena.joinGame(id, _commit(bob, move, SALT_B));
    }

    function _play(LockraArena.Move a, LockraArena.Move b) internal returns (uint256 id) {
        id = _open(a);
        _join(id, b);
        vm.prank(alice);
        arena.reveal(id, a, SALT_A);
        vm.prank(bob);
        arena.reveal(id, b, SALT_B);
    }

    function _status(uint256 id) internal view returns (LockraArena.Status) {
        return arena.getGame(id).status;
    }

    // ------------------------------------------------------------------------------ construction

    function test_constructorSetsConfig() public view {
        assertEq(address(arena.token()), address(token));
        assertEq(arena.owner(), owner);
        assertEq(arena.feeBps(), FEE);
        assertEq(arena.revealWindow(), WINDOW);
        assertEq(arena.minStake(), 1_000 ether);
        assertEq(arena.maxStake(), 10_000_000 ether);
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(LockraArena.ZeroAddress.selector);
        new LockraArena(IERC20(address(0)), owner, FEE, WINDOW, 1, 2);
        vm.expectRevert(LockraArena.ZeroAddress.selector);
        new LockraArena(IERC20(address(token)), address(0), FEE, WINDOW, 1, 2);
        vm.expectRevert(LockraArena.FeeTooHigh.selector);
        new LockraArena(IERC20(address(token)), owner, 501, WINDOW, 1, 2);
        vm.expectRevert(LockraArena.RevealWindowOutOfRange.selector);
        new LockraArena(IERC20(address(token)), owner, FEE, 5 minutes, 1, 2);
        vm.expectRevert(LockraArena.InvalidLimits.selector);
        new LockraArena(IERC20(address(token)), owner, FEE, WINDOW, 3, 2);
    }

    // ------------------------------------------------------------------------------- happy paths

    function test_hostWins() public {
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        uint256 id = _play(ROCK, SCISSORS);

        uint256 burned = (uint256(STAKE) * 2 * FEE) / 10_000;
        assertEq(token.balanceOf(alice), aliceBefore + STAKE - burned);
        assertEq(token.balanceOf(bob), bobBefore - STAKE);
        assertEq(token.balanceOf(BURN), burned);
        assertEq(token.balanceOf(address(arena)), 0);
        assertEq(uint8(_status(id)), uint8(LockraArena.Status.Settled));
    }

    function test_challengerWins() public {
        uint256 bobBefore = token.balanceOf(bob);
        _play(ROCK, PAPER);
        uint256 burned = (uint256(STAKE) * 2 * FEE) / 10_000;
        assertEq(token.balanceOf(bob), bobBefore + STAKE - burned);
        assertEq(token.balanceOf(address(arena)), 0);
    }

    function test_drawRefundsBothWithoutFee() public {
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        _play(PAPER, PAPER);
        assertEq(token.balanceOf(alice), aliceBefore);
        assertEq(token.balanceOf(bob), bobBefore);
        assertEq(token.balanceOf(BURN), 0);
    }

    function test_revealOrderDoesNotMatter() public {
        uint256 id = _open(SCISSORS);
        _join(id, PAPER);
        vm.prank(bob);
        arena.reveal(id, PAPER, SALT_B);
        vm.prank(alice);
        arena.reveal(id, SCISSORS, SALT_A);
        assertEq(uint8(_status(id)), uint8(LockraArena.Status.Settled));
        assertGt(token.balanceOf(alice), 1_000_000 ether);
    }

    function test_outcomeTable() public view {
        LockraArena.Move[3] memory m = [ROCK, PAPER, SCISSORS];
        // expected[i][j]: result of m[i] against m[j]
        uint8[3][3] memory expected = [[uint8(0), 2, 1], [uint8(1), 0, 2], [uint8(2), 1, 0]];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                assertEq(arena.outcome(m[i], m[j]), expected[i][j]);
            }
        }
    }

    function testFuzz_settlementConservesTokens(uint8 a, uint8 b, uint128 stake) public {
        stake = uint128(bound(stake, 1_000 ether, 1_000_000 ether));
        LockraArena.Move ma = LockraArena.Move(bound(a, 1, 3));
        LockraArena.Move mb = LockraArena.Move(bound(b, 1, 3));
        uint256 total = token.balanceOf(alice) + token.balanceOf(bob);

        vm.prank(alice);
        uint256 id = arena.createGame(stake, _commit(alice, ma, SALT_A), address(0));
        vm.prank(bob);
        arena.joinGame(id, _commit(bob, mb, SALT_B));
        vm.prank(alice);
        arena.reveal(id, ma, SALT_A);
        vm.prank(bob);
        arena.reveal(id, mb, SALT_B);

        assertEq(token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(BURN), total);
        assertEq(token.balanceOf(address(arena)), 0);
    }

    function test_emitsEvents() public {
        uint256 burned = (uint256(STAKE) * 2 * FEE) / 10_000;
        vm.expectEmit(address(arena));
        emit LockraArena.GameCreated(1, alice, address(0), STAKE);
        uint256 id = _open(ROCK);

        vm.expectEmit(address(arena));
        emit LockraArena.GameJoined(id, bob, block.timestamp + WINDOW);
        _join(id, SCISSORS);

        vm.prank(alice);
        arena.reveal(id, ROCK, SALT_A);
        vm.expectEmit(address(arena));
        emit LockraArena.GameWon(id, alice, bob, uint256(STAKE) * 2 - burned, burned);
        vm.prank(bob);
        arena.reveal(id, SCISSORS, SALT_B);
    }

    // ----------------------------------------------------------------------------- invitations

    function test_privateGameOnlyInvited() public {
        vm.prank(alice);
        uint256 id = arena.createGame(STAKE, _commit(alice, ROCK, SALT_A), bob);
        vm.prank(carol);
        vm.expectRevert(LockraArena.NotInvited.selector);
        arena.joinGame(id, _commit(carol, PAPER, SALT_B));
        _join(id, PAPER);
        assertEq(arena.getGame(id).challenger, bob);
    }

    function test_cannotInviteOrJoinYourself() public {
        vm.prank(alice);
        vm.expectRevert(LockraArena.CannotPlayYourself.selector);
        arena.createGame(STAKE, _commit(alice, ROCK, SALT_A), alice);

        uint256 id = _open(ROCK);
        vm.prank(alice);
        vm.expectRevert(LockraArena.CannotPlayYourself.selector);
        arena.joinGame(id, _commit(alice, PAPER, SALT_B));
    }

    // ---------------------------------------------------------------------------- commitments

    function test_wrongSaltOrMoveIsRejected() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.startPrank(alice);
        vm.expectRevert(LockraArena.CommitmentMismatch.selector);
        arena.reveal(id, PAPER, SALT_A);
        vm.expectRevert(LockraArena.CommitmentMismatch.selector);
        arena.reveal(id, ROCK, SALT_B);
        vm.stopPrank();
    }

    function test_copiedCommitmentCannotBeRevealed() public {
        uint256 id = _open(ROCK);
        bytes32 hostCommitment = arena.getGame(id).hostCommitment;
        vm.prank(bob);
        arena.joinGame(id, hostCommitment); // bob copies alice's sealed move
        vm.prank(bob);
        vm.expectRevert(LockraArena.CommitmentMismatch.selector);
        arena.reveal(id, ROCK, SALT_A);
    }

    function test_commitmentIsBoundToContractAndChain() public {
        LockraArena other = new LockraArena(IERC20(address(token)), owner, FEE, WINDOW, 1, 2);
        assertTrue(arena.commitmentFor(alice, ROCK, SALT_A) != other.commitmentFor(alice, ROCK, SALT_A));
        bytes32 here = arena.commitmentFor(alice, ROCK, SALT_A);
        vm.chainId(4663);
        assertTrue(arena.commitmentFor(alice, ROCK, SALT_A) != here);
    }

    function test_commitmentMatchesOffchainFormula() public view {
        bytes32 expected = keccak256(abi.encode(address(arena), block.chainid, alice, uint8(2), SALT_A));
        assertEq(arena.commitmentFor(alice, PAPER, SALT_A), expected);
    }

    function test_zeroCommitmentRejected() public {
        vm.prank(alice);
        vm.expectRevert(LockraArena.ZeroCommitment.selector);
        arena.createGame(STAKE, bytes32(0), address(0));
        uint256 id = _open(ROCK);
        vm.prank(bob);
        vm.expectRevert(LockraArena.ZeroCommitment.selector);
        arena.joinGame(id, bytes32(0));
    }

    function test_noneMoveCannotBeRevealed() public {
        vm.prank(alice);
        uint256 id = arena.createGame(STAKE, _commit(alice, LockraArena.Move.None, SALT_A), address(0));
        _join(id, ROCK);
        vm.prank(alice);
        vm.expectRevert(LockraArena.InvalidMove.selector);
        arena.reveal(id, LockraArena.Move.None, SALT_A);
    }

    function test_outOfRangeMoveReverts() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.prank(alice);
        (bool ok,) = address(arena).call(abi.encodeWithSelector(LockraArena.reveal.selector, id, uint8(4), SALT_A));
        assertFalse(ok);
    }

    function test_cannotRevealTwice() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.startPrank(alice);
        arena.reveal(id, ROCK, SALT_A);
        vm.expectRevert(LockraArena.AlreadyRevealed.selector);
        arena.reveal(id, ROCK, SALT_A);
        vm.stopPrank();
    }

    function test_outsiderCannotReveal() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.prank(carol);
        vm.expectRevert(LockraArena.NotAPlayer.selector);
        arena.reveal(id, ROCK, SALT_A);
    }

    function test_cannotRevealBeforeChallengerJoins() public {
        uint256 id = _open(ROCK);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LockraArena.WrongStatus.selector, LockraArena.Status.Active, LockraArena.Status.Open)
        );
        arena.reveal(id, ROCK, SALT_A);
    }

    // -------------------------------------------------------------------------------- timeouts

    function test_onlyRevealerWinsAfterTimeout() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER); // bob would win, but never reveals
        vm.prank(alice);
        arena.reveal(id, ROCK, SALT_A);

        vm.expectRevert(LockraArena.RevealWindowOpen.selector);
        arena.claimTimeout(id);

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(carol); // anyone can close it; tokens still go to the players
        arena.claimTimeout(id);

        uint256 burned = (uint256(STAKE) * 2 * FEE) / 10_000;
        assertEq(token.balanceOf(alice), aliceBefore + uint256(STAKE) * 2 - burned);
        assertEq(token.balanceOf(carol), 1_000_000 ether);
        assertEq(token.balanceOf(address(arena)), 0);
    }

    function test_challengerWinsIfHostNeverReveals() public {
        uint256 id = _open(ROCK);
        _join(id, SCISSORS);
        vm.prank(bob);
        arena.reveal(id, SCISSORS, SALT_B);
        vm.warp(block.timestamp + WINDOW + 1);
        uint256 bobBefore = token.balanceOf(bob);
        arena.claimTimeout(id);
        assertGt(token.balanceOf(bob), bobBefore + STAKE);
    }

    function test_noRevealsRefundsBoth() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.warp(block.timestamp + WINDOW + 1);
        arena.claimTimeout(id);
        assertEq(token.balanceOf(alice), 1_000_000 ether);
        assertEq(token.balanceOf(bob), 1_000_000 ether);
        assertEq(token.balanceOf(BURN), 0);
    }

    function test_cannotRevealAfterDeadline() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(alice);
        vm.expectRevert(LockraArena.RevealWindowClosed.selector);
        arena.reveal(id, ROCK, SALT_A);
    }

    function test_revealAtExactDeadlineStillCounts() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.warp(arena.getGame(id).revealDeadline);
        vm.prank(alice);
        arena.reveal(id, ROCK, SALT_A);
        vm.expectRevert(LockraArena.RevealWindowOpen.selector);
        arena.claimTimeout(id);
    }

    function test_settledGameCannotBeClaimedAgain() public {
        uint256 id = _play(ROCK, SCISSORS);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LockraArena.WrongStatus.selector, LockraArena.Status.Active, LockraArena.Status.Settled
            )
        );
        arena.claimTimeout(id);
    }

    // ------------------------------------------------------------------------------- cancelling

    function test_hostCancelsOpenGame() public {
        uint256 id = _open(ROCK);
        assertEq(token.balanceOf(alice), 1_000_000 ether - STAKE);
        vm.prank(alice);
        arena.cancelGame(id);
        assertEq(token.balanceOf(alice), 1_000_000 ether);
        assertEq(uint8(_status(id)), uint8(LockraArena.Status.Cancelled));

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                LockraArena.WrongStatus.selector, LockraArena.Status.Open, LockraArena.Status.Cancelled
            )
        );
        arena.joinGame(id, _commit(bob, PAPER, SALT_B));
    }

    function test_onlyHostCancels() public {
        uint256 id = _open(ROCK);
        vm.prank(bob);
        vm.expectRevert(LockraArena.OnlyHost.selector);
        arena.cancelGame(id);
    }

    function test_cannotCancelActiveGame() public {
        uint256 id = _open(ROCK);
        _join(id, PAPER);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LockraArena.WrongStatus.selector, LockraArena.Status.Open, LockraArena.Status.Active)
        );
        arena.cancelGame(id);
    }

    function test_unknownGame() public {
        vm.expectRevert(LockraArena.GameNotFound.selector);
        arena.cancelGame(42);
        vm.expectRevert(LockraArena.GameNotFound.selector);
        arena.joinGame(42, bytes32(uint256(1)));
    }

    // ------------------------------------------------------------------------------ owner powers

    function test_stakeLimits() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LockraArena.StakeOutOfRange.selector, 999 ether, 1_000 ether, 10_000_000 ether)
        );
        arena.createGame(999 ether, _commit(alice, ROCK, SALT_A), address(0));

        vm.prank(owner);
        arena.setStakeLimits(1 ether, 2 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LockraArena.StakeOutOfRange.selector, 3 ether, 1 ether, 2 ether));
        arena.createGame(3 ether, _commit(alice, ROCK, SALT_A), address(0));
    }

    function test_feeChangeDoesNotAffectGamesInProgress() public {
        uint256 id = _open(ROCK);
        vm.prank(owner);
        arena.setFee(500);
        _join(id, SCISSORS);
        vm.prank(alice);
        arena.reveal(id, ROCK, SALT_A);
        vm.prank(bob);
        arena.reveal(id, SCISSORS, SALT_B);
        assertEq(token.balanceOf(BURN), (uint256(STAKE) * 2 * FEE) / 10_000);
    }

    function test_zeroFeePaysTheWholePot() public {
        vm.prank(owner);
        arena.setFee(0);
        _play(PAPER, ROCK);
        assertEq(token.balanceOf(alice), 1_000_000 ether + STAKE);
        assertEq(token.balanceOf(BURN), 0);
    }

    function test_pauseBlocksNewGamesOnly() public {
        uint256 id = _open(ROCK);
        uint256 open = _open(PAPER);
        _join(id, SCISSORS);

        vm.prank(owner);
        arena.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(LockraArena.ArenaPaused.selector);
        arena.createGame(STAKE, _commit(alice, ROCK, SALT_A), address(0));
        vm.prank(bob);
        vm.expectRevert(LockraArena.ArenaPaused.selector);
        arena.joinGame(open, _commit(bob, ROCK, SALT_B));

        // Players can always finish games and get their tokens out.
        vm.prank(alice);
        arena.reveal(id, ROCK, SALT_A);
        vm.prank(bob);
        arena.reveal(id, SCISSORS, SALT_B);
        vm.prank(alice);
        arena.cancelGame(open);
        assertEq(token.balanceOf(address(arena)), 0);
    }

    function test_onlyOwnerCanConfigure() public {
        vm.startPrank(alice);
        vm.expectRevert(LockraArena.NotOwner.selector);
        arena.setFee(0);
        vm.expectRevert(LockraArena.NotOwner.selector);
        arena.setRevealWindow(1 days);
        vm.expectRevert(LockraArena.NotOwner.selector);
        arena.setStakeLimits(1, 2);
        vm.expectRevert(LockraArena.NotOwner.selector);
        arena.setPaused(true);
        vm.expectRevert(LockraArena.NotOwner.selector);
        arena.transferOwnership(alice);
        vm.stopPrank();
    }

    function test_configBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(LockraArena.FeeTooHigh.selector);
        arena.setFee(501);
        vm.expectRevert(LockraArena.RevealWindowOutOfRange.selector);
        arena.setRevealWindow(3 days + 1);
        vm.expectRevert(LockraArena.InvalidLimits.selector);
        arena.setStakeLimits(0, 1);
        vm.stopPrank();
    }

    function test_twoStepOwnership() public {
        vm.prank(owner);
        arena.transferOwnership(carol);
        assertEq(arena.owner(), owner);

        vm.prank(bob);
        vm.expectRevert(LockraArena.NotPendingOwner.selector);
        arena.acceptOwnership();

        vm.prank(carol);
        arena.acceptOwnership();
        assertEq(arena.owner(), carol);
        assertEq(arena.pendingOwner(), address(0));

        vm.prank(carol);
        arena.renounceOwnership();
        assertEq(arena.owner(), address(0));
    }

    // ------------------------------------------------------------------------- hostile tokens

    function test_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken bad = new FeeOnTransferToken();
        LockraArena a = new LockraArena(IERC20(address(bad)), owner, FEE, WINDOW, 1, type(uint128).max);
        bad.mint(alice, STAKE);
        vm.startPrank(alice);
        bad.approve(address(a), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(LockraArena.DepositMismatch.selector, STAKE, STAKE - STAKE / 100));
        a.createGame(STAKE, _commitOn(a, alice, ROCK, SALT_A), address(0));
        vm.stopPrank();
    }

    function test_blocksReentrancyDuringPayout() public {
        ReentrantToken evil = new ReentrantToken();
        LockraArena a = new LockraArena(IERC20(address(evil)), owner, FEE, WINDOW, 1, type(uint128).max);
        evil.mint(alice, STAKE);
        evil.mint(bob, STAKE);
        vm.prank(alice);
        evil.approve(address(a), type(uint256).max);
        vm.prank(bob);
        evil.approve(address(a), type(uint256).max);

        vm.prank(alice);
        uint256 id = a.createGame(STAKE, _commitOn(a, alice, ROCK, SALT_A), address(0));
        vm.prank(alice);
        a.cancelGame(id); // warm-up: no reentry armed

        vm.prank(alice);
        id = a.createGame(STAKE, _commitOn(a, alice, ROCK, SALT_A), address(0));
        evil.arm(address(a), abi.encodeCall(LockraArena.claimTimeout, (id)));
        vm.prank(alice);
        a.cancelGame(id);

        assertTrue(evil.reentered());
        assertEq(bytes4(evil.reentryError()), LockraArena.Reentrancy.selector);
        assertEq(evil.balanceOf(alice), STAKE);
    }

    function test_blockedWinnerDoesNotLockTheGame() public {
        BlockingToken bt = new BlockingToken();
        LockraArena a = new LockraArena(IERC20(address(bt)), owner, FEE, WINDOW, 1, type(uint128).max);
        bt.mint(alice, STAKE);
        bt.mint(bob, STAKE);
        vm.prank(alice);
        bt.approve(address(a), type(uint256).max);
        vm.prank(bob);
        bt.approve(address(a), type(uint256).max);

        vm.prank(alice);
        uint256 id = a.createGame(STAKE, _commitOn(a, alice, ROCK, SALT_A), address(0));
        vm.prank(bob);
        a.joinGame(id, _commitOn(a, bob, SCISSORS, SALT_B));
        bt.block_(alice);
        vm.prank(alice);
        a.reveal(id, ROCK, SALT_A);
        vm.prank(bob);
        a.reveal(id, SCISSORS, SALT_B); // settles even though the winner cannot receive

        (uint256 payout, uint256 burned) = a.payoutFor(STAKE);
        assertEq(uint256(a.getGame(id).status), uint256(LockraArena.Status.Settled));
        assertEq(a.owed(alice), payout);
        assertEq(bt.balanceOf(BURN), burned);

        address safe = makeAddr("alice safe");
        vm.prank(alice);
        a.withdraw(safe);
        assertEq(bt.balanceOf(safe), payout);
        assertEq(a.owed(alice), 0);
        assertEq(bt.balanceOf(address(a)), 0);

        vm.prank(alice);
        vm.expectRevert(LockraArena.NothingOwed.selector);
        a.withdraw(safe);
    }

    function test_withdrawRejectsZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(LockraArena.ZeroAddress.selector);
        arena.withdraw(address(0));
    }
}
