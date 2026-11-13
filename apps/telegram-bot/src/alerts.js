// Buy and burn alerts for $LOCKRA on Robinhood Chain. Reads the chain over JSON-RPC, no API keys.
//
// How a buy is recognised: in one transaction, an address (the pool) sends $LOCKRA to a wallet
// and receives another token (the quote, usually WETH) in return. This covers Uniswap V2/V3-style
// pools and routers without hard-coding a DEX. Set `pools` to only trust specific pool addresses.

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
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
  return events;
}

/** One circle per `step` of USD (or of quote units when there is no price), 1 to 30. */
export const strength = (value, step) => Math.max(1, Math.min(30, Math.floor(value / step) || 1));

/**
 * Build the alert text (HTML) for a buy.
 */
export function buyMessage({ ev, symbol, decimals, quoteSymbol, quoteDecimals, quoteUsd, supply, links, emoji = '🟢', step = 10 }) {
  const got = Number(ev.amount) / 10 ** decimals;
  const paid = ev.quote ? Number(ev.quote.value) / 10 ** quoteDecimals : null;
  const usd = paid != null && quoteUsd ? paid * quoteUsd : null;
  const mc = usd && got && supply ? (usd / got) * (Number(supply) / 10 ** decimals) : null;
  const lines = [
    `<b>$${esc(symbol)} Buy!</b>`,
    usd != null ? emoji.repeat(strength(usd, step)) : emoji,
    '',
    paid != null ? `💰 ${formatUnits(ev.quote.value, quoteDecimals)} ${esc(quoteSymbol)}${usd != null ? ` (${formatUsd(usd)})` : ''}` : null,
    `🔒 ${formatUnits(ev.amount, decimals)} $${esc(symbol)}`,
    `👤 <a href="${links.explorer}/address/${ev.buyer}">${short(ev.buyer)}</a> · <a href="${links.explorer}/tx/${ev.tx}">TX</a>`,
    mc ? `📈 Market cap ${formatUsd(mc)}` : null,
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
    `👤 <a href="${links.explorer}/address/${ev.from}">${short(ev.from)}</a> · <a href="${links.explorer}/tx/${ev.tx}">TX</a>`,
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
        const usd = ev.quote && quoteUsd ? (Number(ev.quote.value) / 10 ** q.decimals) * quoteUsd : null;
        if (usd != null && ev.amount > 0n) lastPrice = usd / (Number(ev.amount) / 10 ** decimals);
        // With a minimum set, a buy whose dollar value is unknown is skipped rather than guessed.
        if (o.minUsd && (usd == null || usd < o.minUsd)) continue;
        html = buyMessage({ ev, symbol, decimals, quoteSymbol: q.symbol, quoteDecimals: q.decimals, quoteUsd, supply: circulating, links: { explorer: o.explorer }, emoji: o.emoji, step: o.step });
      } else {
        if (!o.burns) continue;
        html = burnMessage({ ev, symbol, decimals, links: { explorer: o.explorer }, ticketSize: o.ticketSize });
      }
      for (const chat of o.chats) await o.send(chat, html, o.buttons || [], ev.type).catch((e) => log(`send to ${chat} failed: ${e.message}`));
    }
  }

  /** Scan new blocks once. Safe to call repeatedly. */
  async function tick() {
    const head = Number(BigInt(await o.rpc('eth_blockNumber', [])));
    if (next == null) { next = head + 1; return; } // start from now, no backfill
    if (head < next) return;
    const to = Math.min(head, next + (o.maxRange || 2000) - 1);
    const logs = await o.rpc('eth_getLogs', [{ address: o.token, topics: [TRANSFER], fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16) }]);
    const txs = [...new Set(logs.map((l) => l.transactionHash))];
    for (const h of txs) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (seen.size > 5000) seen.delete(seen.values().next().value);
      await handleTx(h).catch((e) => log(`tx ${h} failed: ${e.message}`));
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
export function createRpc(url, doFetch = globalThis.fetch) {
  let id = 0;
  return async (method, params) => {
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

/**
 * ETH price in USD, cached for a minute. DexScreener first (it gives the token price in USD and in
 * the quote token, so ETH = priceUsd / priceNative), then the explorer stats.
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
    if (!v) v = Number((await get(`${explorer}/api/v2/stats`).catch(() => ({}))).coin_price) || null;
    cache = { at: Date.now(), v };
    return v;
  };
}
