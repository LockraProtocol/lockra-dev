# LOCKRA Arena

One-versus-one **Rock, Paper, Scissors** with a `$LOCKRA` stake held in escrow by a smart contract.
Both moves are sealed before either is shown, so nobody can react to the other player, and nobody,
the LOCKRA team included, can take the tokens in play.

## How a game works

| Step | Who | What happens |
| --- | --- | --- |
| 1. Open | Host | Puts in the stake and a **sealed move** (a commitment hash). Can invite one address or leave it open. |
| 2. Join | Challenger | Matches the stake and seals their own move. The reveal window starts. |
| 3. Reveal | Both | Each player reveals their move and secret salt. The contract checks it against the seal. |
| 4. Settle | Contract | Winner gets both stakes minus the arena fee, which is **burned**. A draw refunds both in full. |

### What if someone stops playing?

- **Nobody joined:** the host cancels and gets the stake back in full.
- **One player revealed, the other did not:** after the reveal window, the player who revealed wins the pot.
  Walking away from a losing hand never pays.
- **Nobody revealed:** after the reveal window, both stakes are refunded in full.
- Anyone can close a timed-out game. Tokens still only go to the two players.

## Sealing a move

```
commitment = keccak256(abi.encode(arenaAddress, chainId, player, move, salt))
```

- `move`: `1` Rock, `2` Paper, `3` Scissors.
- `salt`: 32 random bytes the player keeps secret until the reveal. **Losing the salt means losing the
  ability to reveal**, so the app stores it for the player.
- The player address is part of the seal, so copying someone else's commitment is useless.
- The arena address and chain id are part of the seal, so a commitment cannot be replayed elsewhere.

The contract exposes `commitmentFor(player, move, salt)` so apps can double-check their encoding.

## Fees and limits

| Setting | Default | Bounds |
| --- | --- | --- |
| Arena fee (burned, winners only) | 2.5% | 0% to 5% |
| Reveal window | 1 hour | 10 minutes to 3 days |
| Stake per player | 10,000 to 5,000,000 `$LOCKRA` | set by the owner |

Every game keeps the fee it was opened with, so a later change never affects a game in progress.

## What the owner can and cannot do

**Can:** change the fee within the bounds, the reveal window, the stake limits, pause **new** games,
and hand over or renounce ownership (two-step transfer).

**Cannot:** move, freeze or redirect tokens in escrow, change a game in progress, or stop players from
revealing, claiming or cancelling. A pause only blocks opening and joining games.

## Security notes

- Checks-effects-interactions everywhere, plus a reentrancy lock on every state-changing function.
- Deposits are verified by balance difference: fee-on-transfer tokens are rejected instead of
  under-funding a pot.
- Token calls accept both `bool`-returning and no-return ERC-20s. Deposits revert on failure.
- Payouts never block a game: if a transfer to a player fails (for example a token that refuses one
  address), the game still settles and the amount waits in `owed` for that player to `withdraw`,
  to any address they choose.
- Salts must come from a cryptographically secure random source (32 bytes from `crypto.getRandomValues`
  in the browser). There are only three moves, so a guessable salt would leak the move.
- Deploy with a multisig (for example a Safe) as the owner, never a single hot wallet.
- No `delegatecall`, no upgradability, no external dependencies.
- **Get an independent audit before deploying to mainnet.** This contract holds user funds.

## Development

Requires [Foundry](https://book.getfoundry.sh/).

```bash
cd contracts/arena
forge install foundry-rs/forge-std --no-git
forge build
forge test -vvv
```

## Deployment

Use a hardware wallet or an encrypted keystore. Never put a raw private key in a file or a command.

```bash
export ARENA_TOKEN=0x2fc6de9c65a620f918ca7d1191d3afa495ca2898   # $LOCKRA
export ARENA_OWNER=0x...                                        # team multisig recommended
forge script script/Deploy.s.sol --rpc-url $RPC_URL --account lockra-deployer --broadcast --verify
```

Deploy to a testnet first and play real games end to end before going live.
