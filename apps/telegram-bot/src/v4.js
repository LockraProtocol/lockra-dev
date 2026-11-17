// Read $LOCKRA trades straight from the Uniswap v4 PoolManager that holds FOBO liquidity.
//
// FOBO tokens trade in a single Uniswap v4 pool (FoboHook) inside the PoolManager. Every trade emits
// one Swap event there, with the pool id and the price after the trade. Using it (instead of guessing
// from token transfers) gives, for any route, wallet or aggregator:
//   - direction: $LOCKRA leaving the PoolManager is a buy, entering it is a sell
//   - amounts: $LOCKRA moved and the quote side of the swap
//   - the exact price after the trade (sqrtPriceX96), hence the market cap

import { decodeTransfer, DEAD, V4_SWAP } from './alerts.js';

/** Uniswap v4 PoolManager used by FOBO on Robinhood Chain (github.com/fobodotfun/contracts). */
export const FOBO_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
/** FOBO protocol contracts: never shown as buyers (hook buybacks, burner, revenue, vesting). */
export const FOBO_SYSTEM = new Set([
  '0x0af57f62982d03066ef917acad87f771c06528ec', // FoboHook
  '0x5541141cc427441f7ed5bd93bd16ac87a890990d', // FoboBurner
  '0x8819036a0f6940285b6ea6d6b80cdc702ce8cb54', // FoboRevenue
  '0x51d217ecf7c0e4ebf54258444b9617d012fd7d0a', // FoboVesting
]);
export const NATIVE_ETH = 'native';

const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const int = (h) => BigInt.asIntN(256, BigInt('0x' + h));
const abs = (v) => (v < 0n ? -v : v);

/** Decode a v4 PoolManager Swap log. */
export function decodeSwap(log) {
  if (log?.topics?.[0] !== V4_SWAP || !log.data || log.data.length < 2 + 64 * 3) return null;
  return {
    manager: String(log.address).toLowerCase(),
    poolId: String(log.topics[1]).toLowerCase(),
    sender: '0x' + String(log.topics[2]).slice(-40).toLowerCase(),
    amount0: int(word(log.data, 0)),
    amount1: int(word(log.data, 1)),
    sqrtPriceX96: BigInt('0x' + word(log.data, 2)),
    logIndex: Number(log.logIndex),
  };
}

/**
 * Find the $LOCKRA trade in a transaction, if it went through the v4 PoolManager.
 * @param {object[]} logs receipt logs
 * @param {{ token: string, poolManager?: string, poolId?: string|null }} o
 * @returns {null | { side: 'buy'|'sell', poolId: string, amount: bigint, quoteAmount: bigint,
 *   quoteToken: string, tokenIs0: boolean, sqrtPriceX96: bigint, buyer: string|null }}
 */
export function findV4Trade(logs, { token, poolManager = FOBO_POOL_MANAGER, poolId = null, tokenIs0: knownSide = null }) {
  const t = token.toLowerCase();
  const pm = poolManager.toLowerCase();
  const swaps = logs.map(decodeSwap).filter((s) => s && s.manager === pm).sort((a, b) => a.logIndex - b.logIndex);
  if (!swaps.length) return null;
  const transfers = logs.map(decodeTransfer).filter(Boolean).sort((a, b) => a.logIndex - b.logIndex);
  // Net $LOCKRA of the PoolManager in this tx: negative = tokens left the pool (a buy).
  const pmNet = transfers.reduce((d, x) => (x.token !== t ? d : d + (x.to === pm ? x.value : 0n) - (x.from === pm ? x.value : 0n)), 0n);
  if (pmNet === 0n) return null;
  const moved = abs(pmNet);

  // Which swaps are ours: the known pool id, or the pool whose token side adds up to what moved.
  const byPool = new Map();
  for (const s of swaps) (byPool.get(s.poolId) || byPool.set(s.poolId, []).get(s.poolId)).push(s);
  let id = poolId && byPool.has(poolId) ? poolId : null;
  let tokenIs0 = null;
  const sum = (list, k) => list.reduce((a, s) => a + abs(s[k]), 0n);
  const close = (a, b) => a === b || abs(a - b) * 1000n <= b; // within 0.1% (rounding)
  const net = (list, k) => abs(list.reduce((a, s) => a + s[k], 0n));
  const near = (a, b) => abs(a - b) * 100n <= b * 3n; // within 3% (hook fees taken outside the Swap event)
  for (const test of [close, near]) {
    for (const [pid, list] of byPool) {
      if (id && pid !== id) continue;
      if (knownSide !== false && (test(sum(list, 'amount0'), moved) || test(net(list, 'amount0'), moved))) { id = pid; tokenIs0 = true; break; }
      if (knownSide !== true && (test(sum(list, 'amount1'), moved) || test(net(list, 'amount1'), moved))) { id = pid; tokenIs0 = false; break; }
    }
    if (tokenIs0 != null) break;
  }
  // Our pool is known and swapped in this tx, but the amounts don't line up (split routes, hook
  // buybacks in the same block): trust the pool and the LOCKRA that actually left the PoolManager.
  if (tokenIs0 == null && id && knownSide != null) tokenIs0 = knownSide;
  if (!id || tokenIs0 == null) return null;
  const ours = byPool.get(id);
  const quoteAmount = ours.length > 1 ? net(ours, tokenIs0 ? 'amount1' : 'amount0') || sum(ours, tokenIs0 ? 'amount1' : 'amount0') : sum(ours, tokenIs0 ? 'amount1' : 'amount0');
  const last = ours[ours.length - 1];

  // Quote token: an ERC-20 moving into/out of the PoolManager with about the quote amount, else native ETH.
  let quoteToken = NATIVE_ETH;
  let best = null;
  for (const x of transfers) {
    if (x.token === t || (x.to !== pm && x.from !== pm) || x.value === 0n) continue;
    const diff = abs(x.value - quoteAmount);
    if (diff * 20n <= quoteAmount && (!best || diff < best.diff)) best = { token: x.token, diff };
  }
  if (best) quoteToken = best.token;

  // Buyer: follow the tokens that left the PoolManager to the wallet that ends up holding them.
  let buyer = null;
  if (pmNet < 0n) {
    const out = transfers.filter((x) => x.token === t && x.from === pm).sort((a, b) => (b.value > a.value ? 1 : -1))[0];
    if (out) {
      buyer = out.to;
      for (let at = out.logIndex, hop; (hop = transfers.find((y) => y.token === t && y.from === buyer && y.logIndex > at && y.to !== DEAD)); at = hop.logIndex) buyer = hop.to;
    }
  }
  return { side: pmNet < 0n ? 'buy' : 'sell', poolId: id, amount: moved, quoteAmount, quoteToken, tokenIs0, sqrtPriceX96: last.sqrtPriceX96, buyer };
}

/** Quote units per 1 token from a v4/v3 sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96, tokenIs0, tokenDecimals = 18, quoteDecimals = 18) {
  const raw = Number(sqrtPriceX96) ** 2 / 2 ** 192; // token1 per token0, raw units
  if (!Number.isFinite(raw) || raw === 0) return null;
  return tokenIs0 ? raw * 10 ** (tokenDecimals - quoteDecimals) : 10 ** (tokenDecimals - quoteDecimals) / raw;
}
