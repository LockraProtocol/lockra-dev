// /raffle and /stats: live numbers for the group, read from the Blockscout explorer and the chain.
// Ticket rules match lockra.buzz/raffle: one ticket per full `ticketSize` in a single burn,
// burns inside the campaign window only, at most `maxPerWallet` tickets per wallet.

import { formatUnits, formatUsd, DEAD } from './alerts.js';

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

  async function burnsSince(start) {
    const out = [];
    let params = new URLSearchParams({ type: 'ERC-20', filter: 'to', token: o.token });
    for (let page = 0; page < 50; page++) {
      const r = await doFetch(`${o.explorer}/api/v2/addresses/${DEAD}/token-transfers?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`explorer ${r.status}`);
      const j = await r.json();
      let older = false;
      for (const it of j.items || []) {
        if (Date.parse(it.timestamp) / 1000 < start) older = true;
        out.push({ from: it.from?.hash, to: it.to?.hash, value: it.total?.value ?? '0', timestamp: it.timestamp, token: it.token?.address_hash ?? it.token?.address, block: it.block_number, logIndex: it.log_index });
      }
      if (!j.next_page_params || older) break;
      params = new URLSearchParams({ type: 'ERC-20', filter: 'to', token: o.token, ...Object.fromEntries(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])) });
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

  async function stats() {
    const [tok, deadBal] = await Promise.all([
      doFetch(`${o.explorer}/api/v2/tokens/${o.token}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => ({})),
      o.rpc('eth_call', [{ to: o.token, data: '0x70a08231' + DEAD.slice(2).padStart(64, '0') }, 'latest']).then((h) => BigInt(h)).catch(() => null),
    ]);
    const supply = tok.total_supply ? BigInt(tok.total_supply) : null;
    const price = Number(tok.exchange_rate) || o.lastPrice?.() || null;
    const circ = supply != null && deadBal != null ? supply - deadBal : supply;
    const mc = price && circ != null ? price * (Number(circ) / 10 ** decimals) : null;
    return [
      '📊 <b>$LOCKRA stats</b>',
      '',
      price ? `💵 Price: $${price < 0.01 ? price.toPrecision(3) : price.toFixed(4)}` : null,
      mc ? `📈 Market cap: ${formatUsd(mc)}` : null,
      tok.holders_count ?? tok.holders ? `👥 Holders: ${Number(tok.holders_count ?? tok.holders).toLocaleString('en')}` : null,
      deadBal != null ? `🔥 Burned forever: ${formatUnits(deadBal, decimals)} $LOCKRA${supply ? ` (${((Number(deadBal) / Number(supply)) * 100).toFixed(2)}%)` : ''}` : null,
      supply != null ? `🪙 Supply: ${formatUnits(supply, decimals)}` : null,
    ].filter((l) => l != null).join('\n');
  }

  return { raffle, stats };
}
