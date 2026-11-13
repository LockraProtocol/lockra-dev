import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countTickets, countdown, createInfo } from '../src/info.js';
import { createBot } from '../src/bot.js';

const TOKEN = '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const E18 = 10n ** 18n;
const start = Date.parse('2026-11-13T13:30:00Z') / 1000;
const end = Date.parse('2026-11-16T16:00:00Z') / 1000;
const raffle = { start, end, ticketSize: 50_000n * E18, maxPerWallet: 5, prize: '$500 jackpot by FOBO' };
const burn = (from, tokens, iso, block, extra = {}) => ({ from, to: DEAD, token: TOKEN, value: String(BigInt(tokens) * E18), timestamp: iso, block, logIndex: 0, ...extra });

describe('countTickets', () => {
  test('one ticket per full 50k, capped at 5 per wallet, inside the window only', () => {
    const r = countTickets([
      burn('0xa', 100_000, '2026-11-13T14:00:00Z', 1), // 2
      burn('0xa', 200_000, '2026-11-13T15:00:00Z', 2), // 4 more, capped to 3
      burn('0xb', 49_999, '2026-11-13T15:00:00Z', 3),  // 0
      burn('0xc', 50_000, '2026-11-13T10:00:00Z', 0),  // before start
      burn('0xd', 50_000, '2026-11-16T16:00:00Z', 9),  // at close: not counted
    ], { token: TOKEN, ...raffle });
    assert.equal(r.tickets, 5);
    assert.equal(r.wallets, 1);
    assert.equal(r.burned, 349_999n * E18);
  });

  test('countdown', () => {
    assert.equal(countdown(2 * 86400 + 3 * 3600 + 5 * 60 + 9), '2d 3h 5m');
    assert.equal(countdown(125), '2m');
    assert.equal(countdown(0), 'closed');
  });
});

// A fake chain: block n has timestamp T0 + n seconds.
const T0 = start - 1000;
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
function chain(burns, { latest = 400_000, maxRange = 50_000 } = {}) {
  const calls = { getLogs: 0 };
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + latest.toString(16);
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (T0 + parseInt(params[0], 16)).toString(16) };
    if (method === 'eth_getLogs') {
      calls.getLogs++;
      const f = parseInt(params[0].fromBlock, 16); const t = parseInt(params[0].toBlock, 16);
      if (t - f > maxRange) throw new Error('block range too large');
      return burns.filter((b) => b.block >= f && b.block <= t).map((b, i) => ({ blockNumber: '0x' + b.block.toString(16), logIndex: '0x' + i.toString(16), topics: ['0xddf2', pad(b.from), pad(DEAD.toLowerCase())], data: '0x' + (BigInt(b.tokens) * E18).toString(16) }));
    }
    if (method === 'eth_call') return params[0].data === '0x18160ddd' ? '0x' + (1_000_000_000n * E18).toString(16) : '0x' + (10_000_000n * E18).toString(16);
    throw new Error(method);
  };
  return { rpc, calls };
}

describe('createInfo', () => {
  test('raffle reads burns from the chain, splitting large log ranges', async () => {
    const at = (iso) => Date.parse(iso) / 1000 - T0; // block for a time
    const c = chain([
      { from: '0x00000000000000000000000000000000000000aa', tokens: 100_000, block: at('2026-11-13T14:00:00Z') },
      { from: '0x00000000000000000000000000000000000000bb', tokens: 50_000, block: at('2026-11-14T10:00:00Z') },
      { from: '0x00000000000000000000000000000000000000cc', tokens: 50_000, block: 10 }, // before the start
    ]);
    const info = createInfo({ explorer: 'https://x', rpc: c.rpc, token: TOKEN, raffle, now: () => end - 3600 });
    const text = await info.raffle();
    assert.match(text, /Tickets: <b>3<\/b> from 2 wallets/);
    assert.match(text, /Burned: 150,000 \$LOCKRA/);
    assert.match(text, /Closes in <b>1h 0m<\/b>/);
    assert.match(text, /\$500 jackpot by FOBO/);
    assert.ok(c.calls.getLogs > 1, 'range was split');
  });

  test('stats uses DexScreener for price and the chain for supply and burns', async () => {
    const c = chain([]);
    const fetch = async (url) => ({
      ok: !url.includes('blockscout'),
      status: 403,
      json: async () => ({ pairs: [{ priceUsd: '0.002', marketCap: 1_980_000, liquidity: { usd: 50_000 }, volume: { h24: 12_345 }, priceChange: { h24: 12.5 } }] }),
    });
    const info = createInfo({ explorer: 'https://robinhoodchain.blockscout.com', token: TOKEN, raffle, rpc: c.rpc, fetch });
    const text = await info.stats();
    assert.match(text, /Price: \$0\.00200 \(\+12\.5% 24h\)/);
    assert.match(text, /Market cap: \$1\.98M/);
    assert.match(text, /Liquidity: \$50,000/);
    assert.match(text, /Burned forever: 10,000,000 \$LOCKRA \(1\.00%\)/);
    assert.doesNotMatch(text, /Holders/);
  });
});

describe('/raffle and /stats commands', () => {
  test('reply in groups with the info text and a burn button', async () => {
    const calls = [];
    const bot = createBot({ call: async (m, p) => { calls.push({ m, p }); return {}; }, username: 'Lockra_bot', info: { raffle: async () => 'R', stats: async () => 'S', raffleUrl: 'https://lockra.buzz/raffle' } });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, text: '/raffle@Lockra_bot', chat: { id: -1, type: 'supergroup' }, from: { id: 2 } } });
    assert.equal(calls[0].p.text, 'R');
    assert.equal(calls[0].p.reply_markup.inline_keyboard[0][0].url, 'https://lockra.buzz/raffle');
    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, text: '/lockra', chat: { id: -1, type: 'supergroup' }, from: { id: 2 } } });
    assert.equal(calls[1].p.text, 'S');
  });

  test('a failed lookup gives a friendly message', async () => {
    const calls = [];
    const bot = createBot({ call: async (m, p) => { calls.push(p); return {}; }, username: 'B', info: { raffle: async () => { throw new Error('down'); }, stats: async () => '' } });
    await bot.handleUpdate({ update_id: 3, message: { message_id: 3, text: '/raffle', chat: { id: -1, type: 'group' }, from: { id: 2 } } });
    assert.match(calls[0].text, /Could not load/);
  });
});
