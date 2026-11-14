import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decodeTransfer, decodeString, buyMessage, burnMessage, formatUnits, createAlerts, TRANSFER, DEAD } from '../src/alerts.js';

const TOKEN = '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const E18 = 10n ** 18n;
let li = 0;
const tr = (token, from, to, value, tx = '0xaa') => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: '0x' + value.toString(16).padStart(64, '0'), transactionHash: tx, logIndex: '0x' + (li++).toString(16) });

describe('classify', () => {
  test('a swap where the pool receives WETH and sends LOCKRA is a buy', () => {
    const logs = [tr(WETH, ROUTER, POOL, E18 / 20n), tr(TOKEN, POOL, BUYER, 120_000n * E18)];
    const [ev] = classify(logs, { token: TOKEN });
    assert.equal(ev.type, 'buy');
    assert.equal(ev.buyer, BUYER);
    assert.equal(ev.pool, POOL);
    assert.equal(ev.amount, 120_000n * E18);
    assert.deepEqual(ev.quote, { token: WETH, value: E18 / 20n });
  });

  test('a sell is not a buy (the seller is a wallet, not a contract)', () => {
    const logs = [tr(TOKEN, BUYER, POOL, 1000n * E18), tr(WETH, POOL, BUYER, E18 / 100n)];
    assert.deepEqual(classify(logs, { token: TOKEN, contracts: new Set([POOL, ROUTER]) }), []);
  });

  test('a plain wallet-to-wallet transfer is ignored', () => {
    assert.deepEqual(classify([tr(TOKEN, ROUTER, BUYER, 5n * E18)], { token: TOKEN }), []);
  });

  test('a pool to router to buyer route reports only the final buyer', () => {
    const logs = [tr(WETH, BUYER, POOL, E18), tr(TOKEN, POOL, ROUTER, 10n * E18), tr(TOKEN, ROUTER, BUYER, 10n * E18)];
    const evs = classify(logs, { token: TOKEN, contracts: new Set([POOL, ROUTER]) });
    assert.equal(evs.length, 1);
    assert.equal(evs[0].buyer, BUYER);
  });

  test('transfers to the dead address are burns', () => {
    const [ev] = classify([tr(TOKEN, BUYER, DEAD, 50_000n * E18)], { token: TOKEN });
    assert.equal(ev.type, 'burn');
    assert.equal(ev.from, BUYER);
  });

  test('with trusted pools, only those pools count', () => {
    const logs = [tr(WETH, ROUTER, POOL, E18), tr(TOKEN, POOL, BUYER, 10n * E18)];
    assert.equal(classify(logs, { token: TOKEN, pools: [ROUTER] }).length, 0);
    assert.equal(classify(logs, { token: TOKEN, pools: [POOL.toUpperCase().replace('0X', '0x')] }).length, 1);
  });

  test('ignores non-Transfer logs', () => {
    assert.equal(decodeTransfer({ address: TOKEN, topics: ['0x1234'], data: '0x' }), null);
  });
});

describe('messages', () => {
  const links = { explorer: 'https://robinhoodchain.blockscout.com' };
  test('buy message shows paid, received, buyer, tx and market cap', () => {
    const ev = { type: 'buy', buyer: BUYER, tx: '0xabc', amount: 100_000n * E18, quote: { token: WETH, value: E18 / 10n } };
    const html = buyMessage({ ev, symbol: 'LOCKRA', decimals: 18, quoteSymbol: 'WETH', quoteDecimals: 18, quoteUsd: 3000, supply: 1_000_000_000n * E18, links });
    assert.match(html, /<b>\$LOCKRA Buy!<\/b>/);
    assert.match(html, /↗ 0\.1 WETH \(\$300\.00\)/);
    assert.match(html, /↙ 100K \$LOCKRA/);
    assert.match(html, /address\/0x3333/);
    assert.match(html, /Market cap \$3\.00M/); // 300 / 100k * 1B
    assert.equal((html.match(/🟢/g) || []).length, 30);
  });

  test('burn message counts raffle tickets', () => {
    const html = burnMessage({ ev: { from: BUYER, tx: '0xdef', amount: 150_000n * E18 }, symbol: 'LOCKRA', decimals: 18, links, ticketSize: 50_000n * E18 });
    assert.match(html, /150,000 \$LOCKRA gone forever/);
    assert.match(html, /🎟 3 raffle tickets/);
  });

  test('formatUnits', () => {
    assert.equal(formatUnits(1_234_567n * E18, 18), '1,234,567');
    assert.equal(formatUnits(E18 / 20n, 18), '0.05');
    assert.equal(formatUnits(12n * E18 + E18 / 2n, 18), '12.5');
  });

  test('decodeString handles ABI strings and bytes32', () => {
    const abi = '0x' + '20'.padStart(64, '0') + '6'.padStart(64, '0') + Buffer.from('LOCKRA').toString('hex').padEnd(64, '0');
    assert.equal(decodeString(abi), 'LOCKRA');
    assert.equal(decodeString('0x' + Buffer.from('WETH').toString('hex').padEnd(64, '0')), 'WETH');
  });
});

describe('createAlerts', () => {
  function chain() {
    let head = 100;
    const logs = [];
    const receipts = {};
    const str = (s) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');
    const rpc = async (method, params) => {
      if (method === 'eth_blockNumber') return '0x' + head.toString(16);
      if (method === 'eth_getLogs') { const f = parseInt(params[0].fromBlock, 16); const t = parseInt(params[0].toBlock, 16); return logs.filter((l) => l.block >= f && l.block <= t); }
      if (method === 'eth_getTransactionReceipt') return receipts[params[0]];
      if (method === 'eth_getCode') return [POOL, ROUTER].includes(params[0]) ? '0x6080' : '0x';
      if (method === 'eth_call') {
        const { to, data } = params[0];
        if (data === '0x313ce567') return '0x' + (18).toString(16).padStart(64, '0');
        if (data === '0x95d89b41') return str(to === WETH ? 'WETH' : 'LOCKRA');
        if (data === '0x18160ddd') return '0x' + (1_000_000_000n * E18).toString(16);
      }
      throw new Error('unexpected ' + method);
    };
    return {
      rpc,
      mine(txLogs, hash) { head += 1; txLogs.forEach((l) => { l.block = head; l.transactionHash = hash; logs.push(l); }); receipts[hash] = { status: '0x1', logs: txLogs }; },
    };
  }

  test('posts one alert per buy, starting from the current block', async () => {
    const c = chain();
    const sent = [];
    const alerts = createAlerts({ rpc: c.rpc, send: async (chat, html, _b, type) => sent.push({ chat, html, type }), chats: ['-100'], token: TOKEN, explorer: 'https://x', ethUsd: async () => 3000, burns: true, ticketSize: 50_000n * E18 });
    c.mine([tr(WETH, ROUTER, POOL, E18), tr(TOKEN, POOL, BUYER, E18)], '0xold');
    await alerts.tick(); // first tick only sets the starting block
    assert.equal(sent.length, 0);
    c.mine([tr(WETH, ROUTER, POOL, E18 / 10n), tr(TOKEN, POOL, BUYER, 100_000n * E18)], '0xbuy');
    c.mine([tr(TOKEN, BUYER, DEAD, 50_000n * E18)], '0xburn');
    await alerts.tick();
    await alerts.tick();
    assert.equal(sent.length, 2);
    assert.match(sent[0].html, /Buy!.*\n.*\n\n↗ 0\.1 WETH \(\$300\.00\)/s);
    assert.match(sent[1].html, /Burn!/);
    assert.deepEqual(sent.map((x) => x.type), ['buy', 'burn']);
    assert.match(sent[1].html, /🎟 1 raffle ticket\n👤/);
  });

  test('does not post sells', async () => {
    const c = chain();
    const sent = [];
    const alerts = createAlerts({ rpc: c.rpc, send: async (chat, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x', ethUsd: async () => 3000 });
    await alerts.tick();
    c.mine([tr(TOKEN, BUYER, POOL, 1000n * E18), tr(WETH, POOL, BUYER, E18 / 100n)], '0xsell');
    await alerts.tick();
    assert.equal(sent.length, 0);
  });

  test('respects the minimum buy in USD', async () => {
    const c = chain();
    const sent = [];
    const alerts = createAlerts({ rpc: c.rpc, send: async (chat, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x', ethUsd: async () => 3000, minUsd: 50 });
    await alerts.tick();
    c.mine([tr(WETH, ROUTER, POOL, E18 / 1000n), tr(TOKEN, POOL, BUYER, 100n * E18)], '0xsmall');
    await alerts.tick();
    assert.equal(sent.length, 0);
  });
});

test('run() does not pile up abort listeners while polling', async () => {
  const { getEventListeners } = await import('node:events');
  const c = new AbortController();
  const alerts = createAlerts({ rpc: async () => '0x1', send: async () => {}, chats: ['-1'], token: TOKEN, explorer: 'https://x' });
  const running = alerts.run({ signal: c.signal, intervalMs: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(getEventListeners(c.signal, 'abort').length <= 1);
  c.abort();
  await running;
});

test('an aggregator sell that looks like a buy into the pool is not a buy', () => {
  const SELLER = '0x4444444444444444444444444444444444444444';
  // seller -> aggregator (LOCKRA), aggregator -> pool (LOCKRA), pool -> aggregator (WETH), aggregator -> seller (WETH)
  const logs = [tr(TOKEN, SELLER, ROUTER, 1000n * E18), tr(TOKEN, ROUTER, POOL, 1000n * E18), tr(WETH, POOL, ROUTER, E18 / 10n), tr(WETH, ROUTER, SELLER, E18 / 10n)];
  const contracts = new Set([ROUTER, POOL]);
  assert.equal(classify(logs, { token: TOKEN, contracts }).filter((e) => e.type === 'buy').length, 1, 'shape alone is fooled');
  assert.equal(classify(logs, { token: TOKEN, contracts, signer: SELLER }).length, 0, 'the signer check catches it');
});

test('a normal buy signed by the buyer still counts', () => {
  const logs = [tr(WETH, ROUTER, POOL, E18), tr(TOKEN, POOL, BUYER, 10n * E18)];
  assert.equal(classify(logs, { token: TOKEN, contracts: new Set([POOL, ROUTER]), signer: BUYER }).length, 1);
});

test('ETH price comes from DexScreener priceUsd / priceNative', async () => {
  const { createEthPrice } = await import('../src/alerts.js');
  const fetch = async (url) => ({ ok: true, json: async () => (url.includes('dexscreener') ? { pairs: [{ quoteToken: { symbol: 'WETH' }, priceUsd: '0.003', priceNative: '0.000001', liquidity: { usd: 1 } }] } : {}) });
  assert.equal(Math.round(await createEthPrice('https://x', fetch, TOKEN)()), 3000);
});

test('stablecoin buys are valued 1:1 and small ones are filtered by the minimum', async () => {
  const USDG = '0x5555555555555555555555555555555555555555';
  let head = 1;
  const logs = []; const receipts = {};
  const str = (x) => '0x' + '20'.padStart(64, '0') + x.length.toString(16).padStart(64, '0') + Buffer.from(x).toString('hex').padEnd(64, '0');
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') return logs.filter((l) => l.block >= parseInt(p[0].fromBlock, 16) && l.block <= parseInt(p[0].toBlock, 16));
    if (m === 'eth_getTransactionReceipt') return receipts[p[0]];
    if (m === 'eth_getCode') return p[0] === POOL ? '0x60' : '0x';
    if (m === 'eth_call') {
      if (p[0].data === '0x313ce567') return '0x' + (p[0].to === USDG ? 6 : 18).toString(16).padStart(64, '0');
      if (p[0].data === '0x95d89b41') return str(p[0].to === USDG ? 'USDG' : 'LOCKRA');
      if (p[0].data === '0x18160ddd') return '0x' + (1_000_000_000n * E18).toString(16);
      return '0x0';
    }
  };
  const mine = (txLogs, h) => { head++; txLogs.forEach((l) => { l.block = head; l.transactionHash = h; logs.push(l); }); receipts[h] = { status: '0x1', logs: txLogs }; };
  const sent = [];
  const alerts = createAlerts({ rpc, send: async (c, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x', minUsd: 50 });
  await alerts.tick();
  mine([tr(USDG, ROUTER, POOL, 256_500n), tr(TOKEN, POOL, BUYER, 1693n * E18)], '0xsmall'); // $0.26
  mine([tr(USDG, ROUTER, POOL, 120_000_000n), tr(TOKEN, POOL, BUYER, 800_000n * E18)], '0xbig'); // $120
  await alerts.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /↗ 120 USDG \(\$120\.00\)/);
  assert.equal((sent[0].match(/🟢/g) || []).length, 12);
  assert.match(sent[0], /Market cap \$150,000/); // 120 / 800k * 1B
});

test('position: new holder or growth of an existing bag', async () => {
  const { buyMessage, formatCompact } = await import('../src/alerts.js');
  const base = { ev: { buyer: BUYER, tx: '0x1', amount: 100n * E18, quote: { token: WETH, value: E18 } }, symbol: 'LOCKRA', decimals: 18, quoteSymbol: 'WETH', quoteDecimals: 18, links: { explorer: 'https://x' } };
  assert.match(buyMessage({ ...base, before: 0n }), /🆕 New holder/);
  assert.match(buyMessage({ ...base, before: 862n * E18 }), /Position \+11\.6%/);
  assert.doesNotMatch(buyMessage(base), /Position|New holder/);
  assert.equal(formatCompact(99_812.4), '99.8K');
  assert.equal(formatCompact(2_530_000), '2.53M');
  assert.equal(formatCompact(1_000), '1K');
});

test('ETH price falls back to Coinbase when DexScreener has no pair', async () => {
  const { createEthPrice } = await import('../src/alerts.js');
  const fetch = async (url) => ({ ok: true, json: async () => (url.includes('coinbase') ? { data: { amount: '2500.12' } } : { pairs: [] }) });
  assert.equal(await createEthPrice('https://x', fetch, TOKEN)(), 2500.12);
});

test('the RPC client retries rate-limited calls', async () => {
  const { createRpc } = await import('../src/alerts.js');
  let n = 0;
  const fetch = async () => (++n < 3 ? { status: 429, json: async () => ({}) } : { status: 200, json: async () => ({ result: '0x2a' }) });
  const rpc = createRpc('https://rpc', fetch, { wait: async () => {} });
  assert.equal(await rpc('eth_blockNumber', []), '0x2a');
  assert.equal(n, 3);
  const bad = createRpc('https://rpc', async () => ({ status: 200, json: async () => ({ error: { message: 'execution reverted' } }) }), { wait: async () => {} });
  await assert.rejects(bad('eth_call', []), /execution reverted/);
});

test('a buy whose receipt fails is retried on the next tick, not lost', async () => {
  let head = 1; let failReceipt = true;
  const logs = []; const receipts = {};
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') return logs.filter((l) => l.block >= parseInt(p[0].fromBlock, 16) && l.block <= parseInt(p[0].toBlock, 16));
    if (m === 'eth_getTransactionReceipt') { if (failReceipt) { failReceipt = false; throw new Error('Too Many Requests'); } return receipts[p[0]]; }
    if (m === 'eth_getCode') return p[0] === POOL ? '0x60' : '0x';
    if (m === 'eth_call') return p[0].data === '0x313ce567' ? '0x12' : p[0].data === '0x18160ddd' ? '0x' + (10n ** 27n).toString(16) : '0x0';
  };
  const sent = [];
  const alerts = createAlerts({ rpc, send: async (c, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x' });
  await alerts.tick();
  head++;
  const txLogs = [tr(WETH, ROUTER, POOL, E18), tr(TOKEN, POOL, BUYER, 10n * E18)];
  txLogs.forEach((l) => { l.block = head; l.blockNumber = '0x' + head.toString(16); l.transactionHash = '0xretry'; logs.push(l); });
  receipts['0xretry'] = { status: '0x1', logs: txLogs };
  await alerts.tick();
  assert.equal(sent.length, 0);
  await alerts.tick();
  assert.equal(sent.length, 1);
});

test('a buy paid in native ETH (no ERC-20 into the pool) is posted', async () => {
  const PM = '0x6666666666666666666666666666666666666666'; // v4-style pool manager
  let head = 1; const logs = []; const receipts = {}; const txs = {};
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') return logs.filter((l) => l.block >= parseInt(p[0].fromBlock, 16) && l.block <= parseInt(p[0].toBlock, 16));
    if (m === 'eth_getTransactionReceipt') return receipts[p[0]];
    if (m === 'eth_getTransactionByHash') return txs[p[0]];
    if (m === 'eth_getCode') return p[0] === PM ? '0x60' : '0x';
    if (m === 'eth_call') return p[0].data === '0x313ce567' ? '0x12' : p[0].data === '0x18160ddd' ? '0x' + (10n ** 27n).toString(16) : '0x0';
  };
  const sent = [];
  const alerts = createAlerts({ rpc, send: async (c, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x', ethUsd: async () => 2000, minUsd: 50 });
  await alerts.tick();
  head++;
  const l = tr(TOKEN, PM, BUYER, 1_770_000n * E18); l.block = head; l.blockNumber = '0x' + head.toString(16); l.transactionHash = '0xv4'; logs.push(l);
  receipts['0xv4'] = { status: '0x1', from: BUYER, logs: [l] };
  txs['0xv4'] = { value: '0x' + (122n * 10n ** 15n).toString(16) }; // 0.122 ETH = $244
  await alerts.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /↗ 0\.122 ETH \(\$244\.00\)/);
  assert.match(sent[0], /↙ 1\.77M \$/);
  assert.match(sent[0], /0x3333…3333/);
});

test('a native ETH sell is not posted', async () => {
  const { classify, netChange } = await import('../src/alerts.js');
  const PM = '0x6666666666666666666666666666666666666666';
  const logs = [tr(TOKEN, BUYER, PM, 1000n * E18)];
  assert.ok(netChange(logs, TOKEN, BUYER) < 0n);
  assert.equal(classify(logs, { token: TOKEN, contracts: new Set([PM]), signer: BUYER }).length, 0);
});

test('a swap that splits its output (fee cut + buyer) is one buy, for the buyer', () => {
  const FEE = '0x7777777777777777777777777777777777777777';
  const logs = [tr(WETH, ROUTER, POOL, E18 / 10n), tr(TOKEN, POOL, FEE, 7_900n * E18), tr(TOKEN, POOL, BUYER, 921_000n * E18)];
  const buys = classify(logs, { token: TOKEN, contracts: new Set([POOL, ROUTER]), signer: BUYER }).filter((e) => e.type === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].buyer, BUYER);
  assert.equal(buys[0].amount, 921_000n * E18);
  const noSigner = classify(logs, { token: TOKEN, contracts: new Set([POOL, ROUTER]) }).filter((e) => e.type === 'buy');
  assert.equal(noSigner.length, 1);
  assert.equal(noSigner[0].buyer, BUYER, 'largest recipient wins');
});

test('dust before a buy counts as a new holder', async () => {
  const { buyMessage } = await import('../src/alerts.js');
  const ev = { buyer: BUYER, tx: '0x1', amount: 921_000n * E18, quote: { token: WETH, value: E18 } };
  const html = buyMessage({ ev, symbol: 'LOCKRA', decimals: 18, quoteSymbol: 'WETH', quoteDecimals: 18, links: { explorer: 'https://x' }, before: 1_820n * E18 });
  assert.match(html, /New holder/);
});

test('two legs to the same buyer in one swap are one buy with the total', () => {
  const POOL2 = '0x8888888888888888888888888888888888888888';
  const logs = [tr(WETH, ROUTER, POOL, E18), tr(TOKEN, POOL, BUYER, 10_300n * E18), tr(WETH, ROUTER, POOL2, E18), tr(TOKEN, POOL2, BUYER, 1_010_000n * E18)];
  const buys = classify(logs, { token: TOKEN, contracts: new Set([POOL, POOL2, ROUTER]), signer: BUYER }).filter((e) => e.type === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].amount, 1_020_300n * E18);
});

test('market cap comes from the market, not from one buy', async () => {
  const { buyMessage, createMarketCap } = await import('../src/alerts.js');
  const ev = { buyer: BUYER, tx: '0x1', amount: 498_000n * E18, quote: { token: WETH, value: 204n * 10n ** 18n } };
  const base = { ev, symbol: 'LOCKRA', decimals: 18, quoteSymbol: 'USDG', quoteDecimals: 18, quoteUsd: 1, supply: 995_000_000n * E18, links: { explorer: 'https://x' } };
  assert.match(buyMessage(base), /Market cap \$407/);
  assert.match(buyMessage({ ...base, marketCap: 148_870 }), /Market cap \$148,870/);
  const mc = createMarketCap(TOKEN, async () => ({ ok: true, json: async () => ({ pairs: [{ marketCap: 148870, liquidity: { usd: 1 } }, { marketCap: 9, liquidity: { usd: 0 } }] }) }));
  assert.equal(await mc(), 148870);
});

test('paid is what the signer spent, not the same funds counted at each hop', () => {
  const RELAY = '0x9999999999999999999999999999999999999999';
  const USDG = '0x5555555555555555555555555555555555555555';
  const v = 67_979_525n; // 67.98 USDG (6 decimals)
  const logs = [tr(USDG, BUYER, RELAY, v), tr(USDG, RELAY, ROUTER, v), tr(USDG, ROUTER, POOL, v), tr(TOKEN, POOL, BUYER, 498_000n * E18)];
  const [ev] = classify(logs, { token: TOKEN, contracts: new Set([RELAY, ROUTER, POOL]), signer: BUYER }).filter((e) => e.type === 'buy');
  assert.equal(ev.quote.value, v);
  assert.equal(ev.amount, 498_000n * E18);
});

test('with a relayer signing, the buyer\'s own spend counts', () => {
  const RELAYER = '0xaaaa000000000000000000000000000000000001';
  const USDG = '0x5555555555555555555555555555555555555555';
  const logs = [tr(USDG, BUYER, ROUTER, 68n), tr(USDG, ROUTER, POOL, 68n), tr(TOKEN, POOL, BUYER, 498n * E18)];
  const [ev] = classify(logs, { token: TOKEN, contracts: new Set([ROUTER, POOL]), signer: RELAYER }).filter((e) => e.type === 'buy');
  assert.equal(ev.quote.value, 68n);
});
