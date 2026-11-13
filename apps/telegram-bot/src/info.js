// /raffle and /stats: live numbers for the group, read from the Blockscout explorer and the chain.
// Ticket rules match lockra.buzz/raffle: one ticket per full `ticketSize` in a single burn,
// burns inside the campaign window only, at most `maxPerWallet` tickets per wallet.

import { formatUnits, formatUsd, DEAD, TRANSFER } from './alerts.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Count raffle tickets from burn transfers. */
export function countTickets(transfers, { token, ticketSize, start, end, maxPerWallet = 5 }) {
  const t = token.toLowerCase();
  const valid = transfers
    .filter((x) => String(x.token).toLowerCase() === t && String(x.to).toLowerCase() === DEAD)
    .filter((x) => { const s = Date.parse(x.timestamp) / 1000; return s >= start && s < end; })
    .sort((a, b) => (Number(a.block ?? 0) - Number(b.block ?? 0)) || (Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0)));
  const held = new Map();
  let tickets = 0;
  let burned = 0n;
  for (const x of valid) {
    const v = BigInt(x.value);
    burned += v;
    const from = String(x.from).toLowerCase();
    const add = Math.min(Number(v / ticketSize), maxPerWallet - (held.get(from) || 0));
    if (add > 0) { held.set(from, (held.get(from) || 0) + add); tickets += add; }
  }
  return { tickets, wallets: held.size, burned };
}

export function countdown(seconds) {
  if (seconds <= 0) return 'closed';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

const cet = (sec) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(sec * 1000));

/**
 * @param {{ explorer: string, rpc: Function, token: string, decimals?: number, fetch?: typeof fetch,
 *   raffle: { start: number, end: number, ticketSize: bigint, maxPerWallet?: number, url: string, prize?: string },
 *   now?: () => number, ethUsd?: () => Promise<number|null>, lastPrice?: () => number|null }} o
 */
export function createInfo(o) {
  const doFetch = o.fetch || globalThis.fetch;
  const now = o.now || (() => Date.now() / 1000);
  const decimals = o.decimals ?? 18;
  let cache = { at: 0, v: null };

  const hex = (n) => '0x' + n.toString(16);
  const blockTime = new Map();
  async function timeOf(n) {
    if (!blockTime.has(n)) blockTime.set(n, Number(BigInt((await o.rpc('eth_getBlockByNumber', [hex(n), false])).timestamp)));
    return blockTime.get(n);
  }
  let startBlock = null;
  /** First block at or after `ts`, by binary search. */
  async function blockAt(ts, latest) {
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await timeOf(mid)) < ts) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  /** eth_getLogs over a range, splitting it when the node refuses a range that is too large. */
  async function logs(filter, from, to) {
    try {
      return await o.rpc('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
    } catch (e) {
      if (to <= from) throw e;
      const mid = Math.floor((from + to) / 2);
      return [...(await logs(filter, from, mid)), ...(await logs(filter, mid + 1, to))];
    }
  }

  // Burns are read straight from the chain over RPC (explorers often block server requests).
  async function burnsSince(start) {
    const latest = Number(BigInt(await o.rpc('eth_blockNumber', [])));
    if (startBlock == null) startBlock = await blockAt(start, latest);
    const filter = { address: o.token, topics: [TRANSFER, null, '0x' + DEAD.slice(2).padStart(64, '0')] };
    const found = await logs(filter, startBlock, latest);
    const out = [];
    for (const l of found) {
      const block = Number(BigInt(l.blockNumber));
      out.push({ from: '0x' + l.topics[1].slice(-40), to: DEAD, value: BigInt(l.data).toString(), timestamp: new Date((await timeOf(block)) * 1000).toISOString(), token: o.token, block, logIndex: Number(BigInt(l.logIndex)) });
    }
    return out;
  }

  async function raffle() {
    if (Date.now() - cache.at < 30_000 && cache.v) return cache.v;
    const r = o.raffle;
    const t = now();
    const c = countTickets(await burnsSince(r.start), { token: o.token, ...r });
    const live = t >= r.start && t < r.end;
    const lines = [
      '🎟 <b>FOBO × LOCKRA Raffle</b>',
      '',
      r.prize ? `🏆 Prize: ${esc(r.prize)}` : null,
      `🎟 Tickets: <b>${c.tickets.toLocaleString('en')}</b> from ${c.wallets} wallet${c.wallets === 1 ? '' : 's'}`,
      `🔥 Burned: ${formatUnits(c.burned, decimals)} $LOCKRA`,
      live ? `⏳ Closes in <b>${countdown(r.end - t)}</b> (${esc(cet(r.end))})` : t < r.start ? `🕒 Opens ${esc(cet(r.start))}` : `🔒 Closed. The draw is on the raffle page.`,
      '',
      `Burn ${formatUnits(r.ticketSize, decimals)} $LOCKRA per ticket, max ${r.maxPerWallet ?? 5} per wallet.`,
    ].filter((l) => l != null).join('\n');
    cache = { at: Date.now(), v: lines };
    return lines;
  }

  const getJson = (url) => doFetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; LockraBot/1.0; +https://lockra.buzz)' }, signal: AbortSignal.timeout(15_000) })
    .then((r) => { if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`); return r.json(); });

  async function stats() {
    const call = (data) => o.rpc('eth_call', [{ to: o.token, data }, 'latest']).then((h) => BigInt(h));
    const [supply, deadBal, dex, tok] = await Promise.all([
      call('0x18160ddd').catch(() => null),
      call('0x70a08231' + DEAD.slice(2).padStart(64, '0')).catch(() => null),
      getJson(`https://api.dexscreener.com/latest/dex/tokens/${o.token}`).catch((e) => { o.log?.(`stats dexscreener: ${e.message}`); return null; }),
      getJson(`${o.explorer}/api/v2/tokens/${o.token}`).catch((e) => { o.log?.(`stats explorer: ${e.message}`); return null; }),
    ]);
    const pair = (dex?.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const price = Number(pair?.priceUsd) || Number(tok?.exchange_rate) || o.lastPrice?.() || null;
    const circ = supply != null && deadBal != null ? supply - deadBal : supply;
    const mc = Number(pair?.marketCap) || (price && circ != null ? price * (Number(circ) / 10 ** decimals) : null);
    const holders = tok?.holders_count ?? tok?.holders;
    const ch = pair?.priceChange?.h24;
    return [
      '📊 <b>$LOCKRA stats</b>',
      '',
      price ? `💵 Price: $${price < 0.01 ? price.toPrecision(3) : price.toFixed(4)}${ch != null ? ` (${ch > 0 ? '+' : ''}${ch}% 24h)` : ''}` : null,
      mc ? `📈 Market cap: ${formatUsd(mc)}` : null,
      pair?.liquidity?.usd ? `💧 Liquidity: ${formatUsd(pair.liquidity.usd)}` : null,
      pair?.volume?.h24 ? `🔁 Volume 24h: ${formatUsd(pair.volume.h24)}` : null,
      holders ? `👥 Holders: ${Number(holders).toLocaleString('en')}` : null,
      deadBal != null ? `🔥 Burned forever: ${formatUnits(deadBal, decimals)} $LOCKRA${supply ? ` (${((Number(deadBal) / Number(supply)) * 100).toFixed(2)}%)` : ''}` : null,
      supply != null ? `🪙 Supply: ${formatUnits(supply, decimals)}` : null,
    ].filter((l) => l != null).join('\n');
  }

  return { raffle, stats };
}
