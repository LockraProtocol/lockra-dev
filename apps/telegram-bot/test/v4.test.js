import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findV4Trade, priceFromSqrt, FOBO_POOL_MANAGER as PM, FOBO_SYSTEM } from '../src/v4.js';
import { createAlerts, TRANSFER, V4_SWAP } from '../src/alerts.js';

const TOKEN = '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898';
const USDG = '0x5555555555555555555555555555555555555555';
const ROUTER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const SMART = '0xd000000000000000000000000000000000000c76';
const POOL_ID = '0x' + 'ab'.repeat(32);
const OTHER_POOL = '0x' + 'cd'.repeat(32);
const E18 = 10n ** 18n;
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const w = (v) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');
let li = 0;
const tr = (token, from, to, value) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: '0x' + value.toString(16).padStart(64, '0'), transactionHash: '0xaa', logIndex: '0x' + (li++).toString(16) });
const swap = (poolId, a0, a1, sqrt, sender = ROUTER) => ({ address: PM, topics: [V4_SWAP, poolId, pad(sender)], data: '0x' + w(a0) + w(a1) + w(sqrt) + w(1n) + w(0n) + w(0n), transactionHash: '0xaa', logIndex: '0x' + (li++).toString(16) });

// Price 0.0000000417 ETH per LOCKRA (~$0.000125 at $3000): ETH is currency0, LOCKRA currency1.
// raw = token1/token0 = 1/0.0000000417 => sqrtPriceX96 = sqrt(raw) * 2^96
const sqrtFor = (ethPerToken) => BigInt(Math.round(Math.sqrt(1 / ethPerToken) * 2 ** 96));

test('native-ETH buy through a router: direction, amounts, buyer and price', () => {
  const logs = [
    swap(POOL_ID, -(52_720n * 10n ** 12n), 1_110_000n * E18, sqrtFor(0.0000000417)),
    tr(TOKEN, PM, ROUTER, 1_110_000n * E18),
    tr(TOKEN, ROUTER, BUYER, 1_110_000n * E18),
  ];
  const t = findV4Trade(logs, { token: TOKEN });
  assert.equal(t.side, 'buy');
  assert.equal(t.buyer, BUYER);
  assert.equal(t.amount, 1_110_000n * E18);
  assert.equal(t.quoteAmount, 52_720n * 10n ** 12n);
  assert.equal(t.quoteToken, 'native');
  assert.equal(t.tokenIs0, false);
  const p = priceFromSqrt(t.sqrtPriceX96, t.tokenIs0);
  assert.ok(Math.abs(p - 0.0000000417) / 0.0000000417 < 1e-9);
});

test('ERC-4337 sell routed through a proxy is a sell (no alert)', () => {
  const PROXY = '0x1967000000000000000000000000000000000001';
  const logs = [
    tr(TOKEN, SMART, PROXY, 1_114_115n * E18),
    tr(TOKEN, PROXY, PM, 1_114_115n * E18),
    swap(POOL_ID, -(63_551n * 10n ** 12n), 1_114_115n * E18, sqrtFor(0.000000045), PROXY),
  ];
  assert.equal(findV4Trade(logs, { token: TOKEN }).side, 'sell');
});

test('multi-hop: USDG -> ETH in another pool, then ETH -> LOCKRA in ours', () => {
  const logs = [
    tr(USDG, BUYER, PM, 750_000_000n),
    swap(OTHER_POOL, 750_000_000n, -(250n * 10n ** 15n), 1n << 96n),
    swap(POOL_ID, -(250n * 10n ** 15n), 7_400_000n * E18, sqrtFor(0.0000000338)),
    tr(TOKEN, PM, BUYER, 7_400_000n * E18),
  ];
  const t = findV4Trade(logs, { token: TOKEN });
  assert.equal(t.poolId, POOL_ID);
  assert.equal(t.amount, 7_400_000n * E18);
  assert.equal(t.quoteAmount, 250n * 10n ** 15n, 'the ETH side of OUR pool, not a partial leg');
  assert.equal(t.buyer, BUYER);
});

test('no LOCKRA through the PoolManager: not ours', () => {
  const logs = [tr(USDG, BUYER, PM, 5n), swap(OTHER_POOL, 5n, -5n, 1n << 96n)];
  assert.equal(findV4Trade(logs, { token: TOKEN }), null);
});

test('end to end: one exact alert per v4 buy, nothing for sells or hook buybacks', async () => {
  let head = 10; const logs = []; const receipts = {};
  const str = (x) => '0x' + '20'.padStart(64, '0') + x.length.toString(16).padStart(64, '0') + Buffer.from(x).toString('hex').padEnd(64, '0');
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') return logs.filter((l) => l.block >= parseInt(p[0].fromBlock, 16) && l.block <= parseInt(p[0].toBlock, 16) && l.address === TOKEN);
    if (m === 'eth_getTransactionReceipt') return receipts[p[0]];
    if (m === 'eth_getCode') return '0x';
    if (m === 'eth_call') {
      if (p[0].data === '0x313ce567') return '0x' + (18).toString(16).padStart(64, '0');
      if (p[0].data === '0x95d89b41') return str('LOCKRA');
      if (p[0].data === '0x18160ddd') return '0x' + (1_000_000_000n * E18).toString(16);
      return '0x0';
    }
  };
  const mine = (txLogs, h, from = BUYER) => { head++; txLogs.forEach((l) => { l.block = head; l.blockNumber = '0x' + head.toString(16); l.transactionHash = h; logs.push(l); }); receipts[h] = { status: '0x1', from, blockNumber: '0x' + head.toString(16), logs: txLogs }; };
  const sent = [];
  const alerts = createAlerts({ rpc, send: async (c, html) => sent.push(html), chats: ['-1'], token: TOKEN, explorer: 'https://x', ethUsd: async () => 3000, minUsd: 50 });
  await alerts.tick();
  // buy: 0.1 ETH ($300) for 2.4M LOCKRA, price after 0.0000000417 ETH => $0.0001251 => mc $125.1K
  mine([swap(POOL_ID, -(E18 / 10n), 2_400_000n * E18, sqrtFor(0.0000000417)), tr(TOKEN, PM, BUYER, 2_400_000n * E18)], '0xbuy');
  // sell
  mine([tr(TOKEN, SMART, PM, 1_000_000n * E18), swap(POOL_ID, -(E18 / 25n), 1_000_000n * E18, sqrtFor(0.00000004))], '0xsell', SMART);
  // hook buyback (floor) is not a user buy
  const HOOK = [...FOBO_SYSTEM][0];
  mine([swap(POOL_ID, -(E18 / 5n), 4_000_000n * E18, sqrtFor(0.000000043), HOOK), tr(TOKEN, PM, HOOK, 4_000_000n * E18)], '0xhook', HOOK);
  await alerts.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /↗ 0\.1 ETH \(\$300\.00\)/);
  assert.match(sent[0], /↙ 2\.4M \$LOCKRA/);
  assert.match(sent[0], /0x3333…3333/);
  assert.match(sent[0], /Market cap \$125,100/);
});
