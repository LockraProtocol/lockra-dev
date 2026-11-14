// Buy and burn alerts for $LOCKRA on Robinhood Chain. Reads the chain over JSON-RPC, no API keys.
//
// How a buy is recognised: in one transaction, an address (the pool) sends $LOCKRA to a wallet
// and receives another token (the quote, usually WETH) in return. This covers Uniswap V2/V3-style
// pools and routers without hard-coding a DEX. Set `pools` to only trust specific pool addresses.

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
/** Marks a buy paid in the chain's native ETH. */
export const NATIVE = 'native';
/** Dollar stablecoins, valued 1:1 (USDG is common on Robinhood Chain). */
export const STABLE = /^(USDG|USDC(\.E)?|USDT0?|USD₮0?|DAI|USDS|USDE|PYUSD|FDUSD)$/i;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const topicAddr = (t) => '0x' + t.slice(-40).toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Decode an ERC-20 Transfer log, or null if it is not one. */
export function decodeTransfer(log) {
  if (!log || log.topics?.[0] !== TRANSFER || log.topics.length !== 3) return null;
  return {
    token: log.address.toLowerCase(),
    from: topicAddr(log.topics[1]),
    to: topicAddr(log.topics[2]),
    value: BigInt(log.data === '0x' ? 0 : log.data),
    tx: log.transactionHash,
    logIndex: Number(log.logIndex),
  };
}

/** Format token units for people: 1234567.891 → "1,234,568", 0.0523 → "0.0523". */
export function formatUnits(units, decimals, sig = 4) {
  const n = Number(units) / 10 ** decimals;
  if (n === 0) return '0';
  if (n >= 1000) return Math.round(n).toLocaleString('en');
  if (n >= 1) return n.toLocaleString('en', { maximumFractionDigits: 2 });
  return n.toPrecision(sig).replace(/0+$/, '').replace(/\.$/, '');
}

export const formatUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `$${Math.round(n).toLocaleString('en')}` : `$${n.toFixed(2)}`);

/**
 * Turn the logs of one transaction into events.
 * @param {object[]} logs   all logs of the transaction (from its receipt)
 * @param {{ token: string, pools?: string[] }} cfg
 * @returns {{ type: 'buy', buyer: string, pool: string, amount: bigint, quote?: { token: string, value: bigint } }[] | { type: 'burn', from: string, amount: bigint }[]}
 */
export function classify(logs, { token, pools = [], contracts = null, signer = null }) {
  const t = token.toLowerCase();
  const trusted = new Set(pools.map((p) => p.toLowerCase()));
  const transfers = logs.map(decodeTransfer).filter(Boolean).sort((a, b) => a.logIndex - b.logIndex);
  const events = [];
  for (const x of transfers) {
    if (x.token !== t || x.value === 0n) continue;
    if (x.to === DEAD || x.to === ZERO) {
      events.push({ type: 'burn', from: x.from, amount: x.value, tx: x.tx });
      continue;
    }
    // The sender must be a pool: a trusted one, or a contract that is paid another token in this tx.
    const paid = transfers.find((y) => y.token !== t && y.to === x.from && y.value > 0n);
    const isPool = trusted.size ? trusted.has(x.from) : !!paid && (!contracts || contracts.has(x.from));
    if (!isPool) continue;
    // Follow router hops to the wallet that ends up holding the tokens.
    let buyer = x.to;
    for (let at = x.logIndex, hop; (hop = transfers.find((y) => y.token === t && y.from === buyer && y.logIndex > at && y.to !== DEAD)); at = hop.logIndex) buyer = hop.to;
    if (trusted.has(buyer) || (contracts && !trusted.size && buyer === x.from)) continue;
    events.push({ type: 'buy', buyer, pool: x.from, amount: x.value, tx: x.tx, quote: paid ? { token: paid.token, value: paid.value } : undefined });
  }
  // The wallet that signed the transaction tells buys from sells: if it ends up with fewer tokens,
  // it sold, whatever route the aggregator took (some routes look like a buy into the pool).
  if (signer) {
    const me = signer.toLowerCase();
    const delta = transfers.reduce((d, y) => (y.token !== t ? d : d + (y.to === me ? y.value : 0n) - (y.from === me ? y.value : 0n)), 0n);
    if (delta < 0n) return events.filter((e) => e.type !== 'buy');
  }
  // One swap is one buy. A pool or router can split its output (a fee or referral cut to another
  // address, then the rest to the buyer); keep only the main recipient: the signer if it is one of
  // them, otherwise the largest amount.
  // What was paid is what the signer actually spent. Routers and aggregators forward the same funds
  // through several contracts, so the transfer into the last pool alone (or a sum over hops) can be
  // wrong: e.g. 68 USDG relayed through three contracts must not read as 204 USDG.
  for (const e of events) {
    if (e.type !== 'buy' || !e.quote) continue;
    // The signer, else the buyer; with relayers the funds can come from the buyer's own wallet.
    for (const who of [signer?.toLowerCase(), e.buyer]) {
      if (!who) continue;
      const spent = -transfers.reduce((d, y) => (y.token !== e.quote.token ? d : d + (y.to === who ? y.value : 0n) - (y.from === who ? y.value : 0n)), 0n);
      if (spent > 0n) { e.quote = { token: e.quote.token, value: spent }; break; }
    }
  }
  const buys = events.filter((e) => e.type === 'buy');
  if (buys.length > 1) {
    const me = signer?.toLowerCase();
    const mine = buys.filter((b) => b.buyer === me);
    const main = (mine.length ? mine : buys).reduce((a, b) => (b.amount > a.amount ? b : a));
    // The amount is what the buyer really ended up with in this transaction, not one leg of it.
    const net = transfers.reduce((d, y) => (y.token !== t ? d : d + (y.to === main.buyer ? y.value : 0n) - (y.from === main.buyer ? y.value : 0n)), 0n);
    if (net > 0n) main.amount = net;
    return events.filter((e) => e.type !== 'buy' || e === main);
  }
  return events;
}

/** Net change of `token` for `who` across a transaction's logs. */
export function netChange(logs, token, who) {
  const t = token.toLowerCase();
  return logs.map(decodeTransfer).filter((x) => x && x.token === t).reduce((d, x) => d + (x.to === who ? x.value : 0n) - (x.from === who ? x.value : 0n), 0n);
}

/** One circle per `step` of USD (or of quote units when there is no price), 1 to 30. */
export const strength = (value, step) => Math.max(1, Math.min(30, Math.floor(value / step) || 1));

/** 99812.4 → "99.8K", 2_530_000 → "2.53M". */
export function formatCompact(n) {
  const a = Math.abs(n);
  const f = (v, u) => `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}`.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1') + u;
  if (a >= 1e9) return f(n / 1e9, 'B');
  if (a >= 1e6) return f(n / 1e6, 'M');
  if (a >= 1e3) return f(n / 1e3, 'K');
  return n >= 1 ? n.toLocaleString('en', { maximumFractionDigits: 2 }) : n.toPrecision(3);
}

/**
 * Build the alert text (HTML) for a buy.
 * `before` is the buyer's token balance before this buy (units), when known.
 */
export function buyMessage({ ev, symbol, decimals, quoteSymbol, quoteDecimals, quoteUsd, supply, links, emoji = '🟢', step = 10, before = null, marketCap = null, usdEstimate = null, usdOverride = null }) {
  const got = Number(ev.amount) / 10 ** decimals;
  const paid = ev.quote ? Number(ev.quote.value) / 10 ** quoteDecimals : null;
  // usdOverride: the buy's value read from the pool on-chain, used when the visible payment leg is only
  // part of the route (multi-pool swaps) and would understate it.
  const exact = usdOverride == null && paid != null && quoteUsd ? paid * quoteUsd : null;
  // Paid in a token we cannot price (e.g. another launchpad coin): value it at the market price instead.
  const usd = exact ?? usdOverride ?? usdEstimate;
  // Market cap from the market (DexScreener) when available. Deriving it from one buy's average price
  // overstates it: that price includes slippage, fees and multi-hop routes.
  const mc = marketCap || (usd && got && supply ? (usd / got) * (Number(supply) / 10 ** decimals) : null);
  // A previous balance under 1% of this buy is dust: call it a new holder rather than "+50,000%".
  const position = before == null ? null : before * 100n < ev.amount ? '🆕 New holder' : `📈 Position +${formatCompact((Number(ev.amount) / Number(before)) * 100)}%`;
  const lines = [
    `<b>$${esc(symbol)} Buy!</b>`,
    usd != null ? emoji.repeat(strength(usd, step)) : emoji,
    '',
    usdOverride != null ? `↗ ${formatUsd(usdOverride)}` : paid != null ? `↗ ${formatUnits(ev.quote.value, quoteDecimals)} ${esc(quoteSymbol)}${exact != null ? ` (${formatUsd(exact)})` : usd != null ? ` (~${formatUsd(usd)})` : ''}` : null,
    `↙ ${formatCompact(got)} $${esc(symbol)}`,
    '',
    `👤 <a href="${links.explorer}/address/${ev.buyer}">${short(ev.buyer)}</a>`,
    position,
    mc ? '' : null,
    mc ? `💰 Market cap ${formatUsd(mc)}` : null,
  ];
  return lines.filter((l) => l != null).join('\n');
}

export function burnMessage({ ev, symbol, decimals, links, ticketSize }) {
  const tickets = ticketSize ? ev.amount / ticketSize : 0n;
  return [
    `🔥 <b>$${esc(symbol)} Burn!</b>`,
    '',
    `🔥 ${formatUnits(ev.amount, decimals)} $${esc(symbol)} gone forever`,
    tickets > 0n ? `🎟 ${tickets > 5n ? '5 (max)' : tickets} raffle ticket${tickets === 1n ? '' : 's'}` : null,
    `👤 <a href="${links.explorer}/address/${ev.from}">${short(ev.from)}</a>`,
  ].filter((l) => l != null).join('\n');
}

/**
 * Watch the chain and post alerts.
 * @param {{
 *   rpc: (method: string, params: any[]) => Promise<any>,
 *   send: (chatId: string, html: string, buttons: object, type: 'buy' | 'burn') => Promise<void>,
 *   chats: string[], token: string, pools?: string[], explorer: string,
 *   minUsd?: number, step?: number, emoji?: string, burns?: boolean, ticketSize?: bigint,
 *   buttons?: { text: string, url: string }[],
 *   ethUsd?: () => Promise<number|null>, log?: (m: string) => void, maxRange?: number,
 * }} o
 */
export function createAlerts(o) {
  const log = o.log || (() => {});
  const meta = new Map(); // token -> { symbol, decimals }
  let supply = null;
  let next = null; // next block to scan
  const seen = new Set();
  const codeCache = new Map();
  let lastPrice = null; // USD per token from the latest buy

  const call = (to, data) => o.rpc('eth_call', [{ to, data }, 'latest']);
  async function tokenMeta(addr) {
    if (addr === NATIVE) return { symbol: 'ETH', decimals: 18 };
    if (meta.has(addr)) return meta.get(addr);
    let symbol = '?'; let decimals = 18;
    try { decimals = Number(BigInt(await call(addr, '0x313ce567'))); } catch { }
    try { symbol = decodeString(await call(addr, '0x95d89b41')) || '?'; } catch { }
    const m = { symbol, decimals };
    meta.set(addr, m);
    return m;
  }

  async function handleTx(hash) {
    const receipt = await o.rpc('eth_getTransactionReceipt', [hash]);
    if (!receipt || receipt.status !== '0x1') return;
    const t = o.token.toLowerCase();
    let contracts = null;
    if (!o.pools?.length) {
      // Pools are contracts; a wallet selling also "receives another token", so check code.
      const senders = [...new Set(receipt.logs.map(decodeTransfer).filter((x) => x && x.token === t).map((x) => x.from))];
      contracts = new Set();
      for (const a of senders) if (!codeCache.has(a)) codeCache.set(a, ((await o.rpc('eth_getCode', [a, 'latest'])) || '0x').length > 2);
      for (const a of senders) if (codeCache.get(a)) contracts.add(a);
    }
    const events = classify(receipt.logs, { token: o.token, pools: o.pools, contracts, signer: receipt.from });
    // Buys paid in native ETH (Uniswap v4-style pools, launchpad markets) move no ERC-20 to the pool,
    // so their shape is not visible in the logs. The signer gaining tokens while sending ETH is a buy.
    if (!events.some((e) => e.type === 'buy') && receipt.from) {
      const me = receipt.from.toLowerCase();
      const gained = netChange(receipt.logs, t, me);
      const fromContract = receipt.logs.map(decodeTransfer).some((x) => x && x.token === t && x.to === me && contracts?.has(x.from));
      if (gained > 0n && (fromContract || o.pools?.length)) {
        const tx = await o.rpc('eth_getTransactionByHash', [hash]);
        const value = tx?.value ? BigInt(tx.value) : 0n;
        if (value > 0n) events.push({ type: 'buy', buyer: me, pool: null, amount: gained, tx: hash, quote: { token: NATIVE, value } });
      }
    }
    if (!events.length) return;
    const { symbol, decimals } = await tokenMeta(o.token.toLowerCase());
    if (supply == null) supply = BigInt(await call(o.token, '0x18160ddd'));
    // Market cap uses the circulating supply: tokens in the dead address are gone.
    const burned = await call(o.token, '0x70a08231' + DEAD.slice(2).padStart(64, '0')).then(BigInt).catch(() => 0n);
    const circulating = supply - burned;
    for (const ev of events) {
      let html;
      if (ev.type === 'buy') {
        const q = ev.quote ? await tokenMeta(ev.quote.token) : { symbol: '', decimals: 18 };
        const isEth = /^W?ETH$/i.test(q.symbol);
        const quoteUsd = STABLE.test(q.symbol) ? 1 : isEth && o.ethUsd ? await o.ethUsd().catch(() => null) : null;
        let usd = ev.quote && quoteUsd ? (Number(ev.quote.value) / 10 ** q.decimals) * quoteUsd : null;
        let usdEstimate = null;
        if (usd == null && o.tokenPrice) {
          const price = await o.tokenPrice().catch(() => null);
          if (price) usd = usdEstimate = (Number(ev.amount) / 10 ** decimals) * price;
        }
        // Read the token's price from the main pool, right before and right after this block. The buy's
        // value is tokens x average of the two (independent of how the swap was routed), and the market
        // cap is the price after the buy x circulating supply. Falls back to the leg/DexScreener values.
        let usdOverride = null;
        let mcOnchain = null;
        if (o.poolPrice && receipt.blockNumber) {
          const blk = Number(BigInt(receipt.blockNumber));
          const [pBefore, pAfter] = await Promise.all([o.poolPrice(blk - 1), o.poolPrice(blk)]).catch(() => [null, null]);
          if (pAfter) {
            mcOnchain = pAfter * (Number(circulating) / 10 ** decimals);
            const onchainUsd = (Number(ev.amount) / 10 ** decimals) * ((pBefore || pAfter) + pAfter) / 2;
            // Trust the payment leg only when it matches the pool within a margin; otherwise it was
            // a partial leg of a split route (or a relayed amount counted twice).
            if (usd == null || usd < onchainUsd * 0.6 || usd > onchainUsd * 1.6) { usd = onchainUsd; usdOverride = onchainUsd; usdEstimate = null; }
          }
        }
        if (usd != null && ev.amount > 0n) lastPrice = usd / (Number(ev.amount) / 10 ** decimals);
        if (usd == null) log(`tx ${ev.tx}: no dollar value for ${formatUnits(ev.quote?.value ?? 0n, q.decimals)} ${q.symbol || '?'}`);
        // With a minimum set, a buy whose dollar value is unknown is skipped rather than guessed.
        if (o.minUsd && (usd == null || usd < o.minUsd)) continue;
        // Balance right after the buy, read at its block; minus the buy gives the balance before.
        const after = await o.rpc('eth_call', [{ to: o.token, data: '0x70a08231' + ev.buyer.slice(2).padStart(64, '0') }, receipt.blockNumber || 'latest']).then(BigInt).catch(() => null);
        const before = after != null && after >= ev.amount ? after - ev.amount : null;
        let marketCap = mcOnchain;
        if (marketCap == null && o.marketCap) {
          // DexScreener lags the chain by a few seconds: wait so the market cap includes this buy.
          if (o.marketCapDelayMs) await new Promise((r) => setTimeout(r, o.marketCapDelayMs));
          marketCap = await o.marketCap().catch(() => null);
        }
        html = buyMessage({ ev, symbol, decimals, quoteSymbol: q.symbol, quoteDecimals: q.decimals, quoteUsd, supply: circulating, links: { explorer: o.explorer }, emoji: o.emoji, step: o.step, before, marketCap, usdEstimate, usdOverride });
      } else {
        if (!o.burns) continue;
        html = burnMessage({ ev, symbol, decimals, links: { explorer: o.explorer }, ticketSize: o.ticketSize });
      }
      const buttons = typeof o.buttons === 'function' ? o.buttons(ev) : o.buttons || [];
      for (const chat of o.chats) await o.send(chat, html, buttons, ev.type).catch((e) => log(`send to ${chat} failed: ${e.message}`));
    }
  }

  /** Scan new blocks once. Safe to call repeatedly. */
  async function tick() {
    const head = Number(BigInt(await o.rpc('eth_blockNumber', [])));
    if (next == null) { next = head + 1; return; } // start from now, no backfill
    if (head < next) return;
    const to = Math.min(head, next + (o.maxRange || 2000) - 1);
    const logs = await o.rpc('eth_getLogs', [{ address: o.token, topics: [TRANSFER], fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16) }]);
    // In chain order. If a transaction cannot be read (e.g. the RPC is rate limiting), stop there and
    // retry from its block on the next tick, so no buy is skipped. Seen hashes prevent duplicates.
    const txs = [];
    for (const l of logs) if (!txs.some((t) => t.hash === l.transactionHash)) txs.push({ hash: l.transactionHash, block: Number(BigInt(l.blockNumber ?? '0x' + next.toString(16))) });
    for (const { hash, block } of txs) {
      if (seen.has(hash)) continue;
      try {
        await handleTx(hash);
      } catch (e) {
        log(`tx ${hash} failed, will retry: ${e.message}`);
        next = block;
        return;
      }
      seen.add(hash);
      if (seen.size > 5000) seen.delete(seen.values().next().value);
    }
    next = to + 1;
  }

  async function run({ signal, intervalMs = 4000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`alerts: ${e.message}`));
      await new Promise((resolve) => {
        // Remove the abort listener on every wake-up, or one would pile up per poll.
        const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
        const t = setTimeout(done, intervalMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  return { tick, run, handleTx, lastPrice: () => lastPrice };
}

/** Decode an ABI-encoded string (or a bytes32 string) returned by eth_call. */
export function decodeString(hex) {
  const h = hex.replace(/^0x/, '');
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

/** JSON-RPC client over fetch. */
export function createRpc(url, doFetch = globalThis.fetch, { retries = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let id = 0;
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      let res; let body;
      try {
        res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
        body = res.status === 429 ? { error: { message: 'Too Many Requests' } } : await res.json();
      } catch (e) {
        body = { error: { message: e.message } };
      }
      if (!body.error) return body.result;
      // Public RPCs rate limit bursts: back off and try again (1s, 2s, 4s, 8s).
      const retryable = /too many|rate|limit|timeout|fetch failed|429|5\d\d/i.test(body.error.message || '') || (res && res.status >= 500);
      if (!retryable || attempt >= retries) throw new Error(`${method}: ${body.error.message}`);
      await wait(1000 * 2 ** attempt);
    }
  };
}

/** The token's market cap and USD price from DexScreener (deepest pair), cached for a few seconds. */
export function createMarket(token, doFetch = globalThis.fetch, { maxAgeMs = 5_000 } = {}) {
  let cache = { at: 0, v: null };
  const load = async () => {
    if (Date.now() - cache.at < maxAgeMs && cache.v) return cache.v;
    const r = await doFetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    const pair = ((await r.json()).pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const v = { marketCap: Number(pair?.marketCap) || Number(pair?.fdv) || null, priceUsd: Number(pair?.priceUsd) || null, pair: pair ? { pairAddress: pair.pairAddress, quoteSymbol: pair.quoteToken?.symbol } : null };
    cache = { at: Date.now(), v };
    return v;
  };
  return { marketCap: async () => (await load()).marketCap, price: async () => (await load()).priceUsd, pair: async () => (await load()).pair };
}

/** @deprecated use createMarket(token).marketCap */
export const createMarketCap = (token, doFetch) => createMarket(token, doFetch).marketCap;

/**
 * Price of `token` in USD read from a Uniswap v3-style (slot0) or v2-style (getReserves) pool at a
 * given block. The pool is found once from DexScreener (deepest pair) and then read on-chain.
 * Returns null when the pool cannot be read (e.g. a v4 singleton), so callers fall back.
 */
export function createPoolPrice({ rpc, token, findPair, quoteUsd, decimals = 18 }) {
  const t = token.toLowerCase();
  let pool = null; let poolAt = 0;
  const call = (to, data, block) => rpc('eth_call', [{ to, data }, typeof block === 'number' ? '0x' + block.toString(16) : block]);
  const addr = (h) => '0x' + h.slice(-40).toLowerCase();
  async function info() {
    if (pool && Date.now() - poolAt < 10 * 60_000) return pool;
    const pair = await findPair();
    if (!pair?.pairAddress || !/^0x[0-9a-fA-F]{40}$/.test(pair.pairAddress)) return (pool = null);
    const p = pair.pairAddress.toLowerCase();
    const token0 = addr(await call(p, '0x0dfe1681', 'latest'));
    const token1 = addr(await call(p, '0xd21220a7', 'latest'));
    if (token0 !== t && token1 !== t) return (pool = null);
    const quote = token0 === t ? token1 : token0;
    const qd = Number(BigInt(await call(quote, '0x313ce567', 'latest')));
    let kind = 'v3';
    try { await call(p, '0x3850c7bd', 'latest'); } catch { kind = 'v2'; }
    pool = { address: p, tokenIs0: token0 === t, quote, quoteDecimals: qd, kind };
    poolAt = Date.now();
    return pool;
  }
  return async (block) => {
    const pl = await info();
    if (!pl) return null;
    let quotePerToken; // human units of quote per 1 token
    if (pl.kind === 'v3') {
      const sqrt = BigInt('0x' + (await call(pl.address, '0x3850c7bd', block)).slice(2, 66));
      if (sqrt === 0n) return null;
      const raw = Number(sqrt) ** 2 / 2 ** 192; // token1 per token0, raw units
      const p10 = raw * 10 ** ((pl.tokenIs0 ? decimals : pl.quoteDecimals) - (pl.tokenIs0 ? pl.quoteDecimals : decimals));
      quotePerToken = pl.tokenIs0 ? p10 : 1 / p10;
    } else {
      const h = (await call(pl.address, '0x0902f1ac', block)).slice(2);
      const r0 = BigInt('0x' + h.slice(0, 64)); const r1 = BigInt('0x' + h.slice(64, 128));
      const [rt, rq] = pl.tokenIs0 ? [r0, r1] : [r1, r0];
      if (rt === 0n) return null;
      quotePerToken = (Number(rq) / 10 ** pl.quoteDecimals) / (Number(rt) / 10 ** decimals);
    }
    const usd = await quoteUsd(pl.quote);
    return usd && Number.isFinite(quotePerToken) ? quotePerToken * usd : null;
  };
}

/**
 * ETH price in USD, cached for a minute. DexScreener first (it gives the token price in USD and in
 * the quote token, so ETH = priceUsd / priceNative), then Coinbase, then the explorer stats.
 */
export function createEthPrice(explorer, doFetch = globalThis.fetch, token = null) {
  let cache = { at: 0, v: null };
  const get = (url) => doFetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; LockraBot/1.0; +https://lockra.buzz)' }, signal: AbortSignal.timeout(10_000) }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  return async () => {
    if (Date.now() - cache.at < 60_000 && cache.v) return cache.v;
    let v = null;
    if (token) {
      const j = await get(`https://api.dexscreener.com/latest/dex/tokens/${token}`).catch(() => null);
      const p = (j?.pairs || []).filter((x) => /^W?ETH$/i.test(x.quoteToken?.symbol || '') && Number(x.priceNative) > 0)
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (p) v = Number(p.priceUsd) / Number(p.priceNative);
    }
    // Coinbase's public spot price works from any server and needs no key.
    if (!v) v = Number((await get('https://api.coinbase.com/v2/prices/ETH-USD/spot').catch(() => null))?.data?.amount) || null;
    if (!v) v = Number((await get(`${explorer}/api/v2/stats`).catch(() => ({}))).coin_price) || null;
    cache = { at: Date.now(), v };
    return v;
  };
}
