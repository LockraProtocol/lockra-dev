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

function explorerFetch(items, token = {}) {
  return async (url) => ({
    ok: true,
    json: async () => (url.includes('/token-transfers') ? { items: items.map((x) => ({ from: { hash: x.from }, to: { hash: x.to }, token: { address_hash: x.token }, total: { value: x.value }, timestamp: x.timestamp, block_number: x.block, log_index: 0 })), next_page_params: null } : token),
  });
}

describe('createInfo', () => {
  test('raffle shows tickets, burned and countdown', async () => {
    const info = createInfo({ explorer: 'https://x', rpc: async () => '0x0', token: TOKEN, raffle, now: () => end - 3600, fetch: explorerFetch([burn('0xa', 100_000, '2026-11-13T14:00:00Z', 1), burn('0xb', 50_000, '2026-11-13T14:10:00Z', 2)]) });
    const text = await info.raffle();
    assert.match(text, /Tickets: <b>3<\/b> from 2 wallets/);
    assert.match(text, /Burned: 150,000 \$LOCKRA/);
    assert.match(text, /Closes in <b>1h 0m<\/b>/);
    assert.match(text, /\$500 jackpot by FOBO/);
  });

  test('stats shows holders, burned share and market cap', async () => {
    const supply = 1_000_000_000n * E18;
    const info = createInfo({
      explorer: 'https://x', token: TOKEN, raffle,
      rpc: async () => '0x' + (10_000_000n * E18).toString(16),
      fetch: explorerFetch([], { total_supply: supply.toString(), holders_count: '1234', exchange_rate: '0.002' }),
    });
    const text = await info.stats();
    assert.match(text, /Holders: 1,234/);
    assert.match(text, /Burned forever: 10,000,000 \$LOCKRA \(1\.00%\)/);
    assert.match(text, /Market cap: \$1\.98M/); // 0.002 * 990M
    assert.match(text, /Price: \$0\.00200/);
  });
});

describe('/raffle and /stats commands', () => {
  test('reply in groups with the info text and a burn button', async () => {
    const calls = [];
    const bot = createBot({ call: async (m, p) => { calls.push({ m, p }); return {}; }, username: 'Lockra_bot', info: { raffle: async () => 'R', stats: async () => 'S', raffleUrl: 'https://lockra.buzz/raffle' } });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, text: '/raffle@Lockra_bot', chat: { id: -1, type: 'supergroup' }, from: { id: 2 } } });
    assert.equal(calls[0].p.text, 'R');
    assert.equal(calls[0].p.reply_markup.inline_keyboard[0][0].url, 'https://lockra.buzz/raffle');
    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, text: '/stats', chat: { id: -1, type: 'supergroup' }, from: { id: 2 } } });
    assert.equal(calls[1].p.text, 'S');
  });

  test('a failed lookup gives a friendly message', async () => {
    const calls = [];
    const bot = createBot({ call: async (m, p) => { calls.push(p); return {}; }, username: 'B', info: { raffle: async () => { throw new Error('down'); }, stats: async () => '' } });
    await bot.handleUpdate({ update_id: 3, message: { message_id: 3, text: '/raffle', chat: { id: -1, type: 'group' }, from: { id: 2 } } });
    assert.match(calls[0].text, /Could not load/);
  });
});
