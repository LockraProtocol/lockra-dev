import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
import { createKols, memoryKolsFile, parseAmount, pointsFor } from '../src/kols.js';
import { createBeacon } from '../../../packages/sdk/test/helpers.js';

const TOKEN = '0x' + 'ab'.repeat(20);
let n = 1;
const dm = (text, from = { id: 7, username: 'alice', first_name: 'Alice' }) => ({ update_id: n, message: { message_id: n++, text, chat: { id: from.id, type: 'private' }, from } });

function setup({ mc = 1_000_000, balance = 2_000_000 } = {}) {
  const beacon = createBeacon();
  const calls = [];
  let mid = 500;
  const call = async (method, params) => { calls.push({ method, params }); return { message_id: mid++ }; };
  let clock = Date.parse('2030-11-17T12:00:00Z'); // fixed and in the future: the SDK refuses unlock dates in the real past
  const market = { mc };
  const sdkOptions = { chain: beacon.chain, fetch: beacon.fetch };
  const kols = createKols({ file: memoryKolsFile(), call, now: () => clock, lookup: async () => ({ symbol: 'XYZ', marketCap: market.mc, chain: 'robinhood' }), balanceOf: async () => balance, admins: ['1'], groups: ['-100'], sdkOptions, newId: () => 'c' + n++ });
  const bot = createBot({ call, username: 'LockraBot', sdkOptions, now: () => clock, kols });
  return { calls, bot, kols, beacon, market, advance: (ms) => { clock += ms; }, last: (m) => calls.findLast((c) => c.method === m) };
}
async function verified(s) {
  await s.bot.handleUpdate(dm('/kol join @alice_x 0x' + 'cd'.repeat(20)));
  const app = s.calls.find((c) => c.params.chat_id === '1');
  assert.match(app.params.text, /KOL application/);
  await s.bot.handleUpdate({ update_id: n++, callback_query: { id: 'q', data: app.params.reply_markup.inline_keyboard[0][0].callback_data, from: { id: 1 }, message: { message_id: 9, chat: { id: 1 } } } });
}

describe('LOCKRA KOLs', () => {
  test('amounts and points', () => {
    assert.equal(parseAmount('5M'), 5e6); assert.equal(parseAmount('$500k'), 5e5); assert.equal(parseAmount('1.2B'), 1.2e9); assert.equal(parseAmount('abc'), null);
    assert.equal(pointsFor(1e6, 1e6), 10); assert.equal(pointsFor(1e6, 2e6), 20); assert.equal(pointsFor(1e6, 1e9), 100);
  });

  test('apply, only admins approve, then the KOL is verified', async () => {
    const s = setup();
    await s.bot.handleUpdate(dm('/kol join @alice_x 0x' + 'cd'.repeat(20)));
    const app = s.calls.find((c) => c.params.chat_id === '1');
    await s.bot.handleUpdate({ update_id: n++, callback_query: { id: 'q', data: app.params.reply_markup.inline_keyboard[0][0].callback_data, from: { id: 99 } } });
    assert.match(s.last('answerCallbackQuery').params.text, /Only LOCKRA admins/);
    await s.bot.handleUpdate({ update_id: n++, callback_query: { id: 'q', data: app.params.reply_markup.inline_keyboard[0][0].callback_data, from: { id: 1 } } });
    assert.match(s.calls.findLast((c) => c.params.chat_id === '7').params.text, /verified LOCKRA KOL/);
    const v = await s.kols.publicView();
    assert.equal(v.kols[0].handle, 'alice_x');
    assert.deepEqual(v.kols[0].badges, ['verified', 'silver']);
  });

  test('a call is sealed in private, announced without its contents, and scored at the deadline', async () => {
    const s = setup();
    await verified(s);
    await s.bot.handleUpdate(dm(`/call ${TOKEN} 3M 7d`));
    const announce = s.calls.find((c) => c.params.chat_id === '-100' && /New sealed call/.test(c.params.text));
    assert.ok(announce);
    assert.doesNotMatch(announce.params.text, /XYZ|3M|\$3/);
    assert.match(s.calls.findLast((c) => c.params.chat_id === 7).params.text, /XYZ to \$3M.*Worth <b>26<\/b> points/s);
    let v = await s.kols.publicView();
    assert.equal(v.kols[0].open.length, 1);
    s.market.mc = 3_400_000;
    s.advance(7 * 86_400_000 + 5000); s.beacon.state.published = Infinity;
    await s.kols.tick();
    const reveal = s.calls.findLast((c) => /called it/.test(c.params?.text || ''));
    assert.match(reveal.params.text, /\$XYZ to \$3M market cap: now <b>\$3.4M<\/b>.*\+26 points/s);
    v = await s.kols.publicView();
    assert.deepEqual([v.kols[0].season.points, v.kols[0].season.hits, v.kols[0].open.length, v.kols[0].history[0].result], [26, 1, 0, 'hit']);
  });

  test('misses count, calls in groups are refused, targets must be above the market cap', async () => {
    const s = setup();
    await verified(s);
    await s.bot.handleUpdate({ update_id: n, message: { message_id: n++, text: `/call ${TOKEN} 3M 7d`, chat: { id: -5, type: 'supergroup' }, from: { id: 7 } } });
    assert.equal(s.last('deleteMessage').params.chat_id, -5);
    await s.bot.handleUpdate(dm(`/call ${TOKEN} 500K 7d`));
    assert.match(s.calls.findLast((c) => c.params.chat_id === 7).params.text, /already at \$1M/);
    await s.bot.handleUpdate(dm(`/call ${TOKEN} 2M 1d`));
    s.advance(86_400_000 + 5000); s.beacon.state.published = Infinity;
    await s.kols.tick();
    const v = await s.kols.publicView();
    assert.deepEqual([v.kols[0].season.points, v.kols[0].season.misses], [0, 1]);
  });

  test('channel linking with a one-time code', async () => {
    const s = setup();
    await verified(s);
    await s.bot.handleUpdate(dm('/kol channel'));
    const code = /\/link ([0-9A-F]{6})/.exec(s.calls.findLast((c) => c.params.chat_id === 7).params.text)[1];
    await s.bot.handleUpdate({ update_id: n++, channel_post: { message_id: 3, text: `/link ${code}`, chat: { id: -200, type: 'channel', title: 'Alice Calls', username: 'alicecalls' } } });
    const v = await s.kols.publicView();
    assert.equal(v.kols[0].channel.url, 'https://t.me/alicecalls');
    await s.bot.handleUpdate(dm(`/call ${TOKEN} 3M 7d`));
    assert.ok(s.calls.some((c) => c.params.chat_id === -200 && /New sealed call/.test(c.params.text)));
  });

  test('the season winner is crowned when the month ends', async () => {
    const s = setup();
    await verified(s);
    await s.bot.handleUpdate(dm(`/call ${TOKEN} 2M 2d`));
    s.market.mc = 2_500_000; s.advance(2 * 86_400_000 + 5000); s.beacon.state.published = Infinity;
    await s.kols.tick();
    s.advance(14 * 86_400_000);
    await s.kols.tick();
    const v = await s.kols.publicView();
    assert.equal(v.kolOfTheMonth.handle, 'alice_x');
    assert.ok(v.kols[0].badges.includes('crown'));
    assert.ok(s.calls.some((c) => /KOL of the month: @alice_x/.test(c.params?.text || '')));
  });
});
