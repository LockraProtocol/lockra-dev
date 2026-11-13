import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, SEALS_PER_HOUR, MAX_MESSAGE } from '../src/bot.js';
import { createBeacon } from '../../../packages/sdk/test/helpers.js';

let nextId = 1;
const dm = (text, extra = {}) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: 100, type: 'private' }, from: { id: 7, username: 'alice' }, ...extra } });
const group = (text, extra = {}) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: -500, type: 'supergroup' }, from: { id: 8, username: 'bob' }, ...extra } });

function setup() {
  const beacon = createBeacon();
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    return { message_id: 999 };
  };
  const bot = createBot({ call, username: 'LockraBot', sdkOptions: { chain: beacon.chain, fetch: beacon.fetch } });
  const last = () => calls.at(-1);
  const linkFrom = (c) => /<code>(https:\/\/lockra\.buzz\/[^<]+)<\/code>/.exec(c.params.text)[1].replace(/&amp;/g, '&');
  return { beacon, calls, bot, last, linkFrom };
}

describe('/seal', () => {
  test('seals in a private chat and returns a working link', async () => {
    const { bot, last, linkFrom, beacon } = setup();
    await bot.handleUpdate(dm('/seal 30d BTC 150k <by> summer & more'));
    const r = last();
    assert.equal(r.method, 'sendMessage');
    assert.equal(r.params.parse_mode, 'HTML');
    assert.match(r.params.text, /Sealed until .* UTC<\/b> \(in 30d\)/);
    const link = linkFrom(r);
    assert.match(link, /^https:\/\/lockra\.buzz\/#by=%40alice&c=/);
    assert.equal(r.params.reply_markup.inline_keyboard[0][0].url, link);
    assert.ok(r.params.reply_markup.inline_keyboard[1][0].url.startsWith('https://t.me/share/url?url='));

    beacon.state.published = Infinity;
    await bot.handleUpdate(dm(`/open ${link}`));
    assert.match(last().params.text, /Opened\.<\/b>\nby @alice/);
    assert.ok(last().params.text.endsWith('BTC 150k &lt;by&gt; summer &amp; more'));
  });

  test('explains usage for missing or bad input', async () => {
    const { bot, last } = setup();
    await bot.handleUpdate(dm('/seal'));
    assert.match(last().params.text, /Tell me <b>when<\/b>/);
    await bot.handleUpdate(dm('/seal 30d'));
    assert.match(last().params.text, /Tell me <b>when<\/b>/);
    await bot.handleUpdate(dm('/seal tomorrow hello'));
    assert.match(last().params.text, /did not understand when/);
    await bot.handleUpdate(dm(`/seal 1d ${'x'.repeat(MAX_MESSAGE + 1)}`));
    assert.match(last().params.text, /too long/);
  });

  test('never seals in a group: deletes the secret and points to a private chat', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(group('/seal 7d my secret call'));
    assert.deepEqual(calls.map((c) => c.method), ['deleteMessage', 'sendMessage']);
    assert.equal(calls[0].params.chat_id, -500);
    assert.equal(calls[1].params.reply_markup.inline_keyboard[0][0].url, 'https://t.me/LockraBot?start=seal');
    assert.equal(JSON.stringify(calls).includes('my secret call'), false);
  });

  test('still points to a private chat when the bot cannot delete', async () => {
    const calls = [];
    const call = async (method, params) => {
      calls.push(method);
      if (method === 'deleteMessage') throw new Error('not enough rights');
      return {};
    };
    const bot = createBot({ call, username: 'LockraBot' });
    await bot.handleUpdate(group('/seal 7d secret'));
    assert.deepEqual(calls, ['deleteMessage', 'sendMessage']);
  });

  test('rate limits each user', async () => {
    const { bot, calls } = setup();
    for (let i = 0; i < SEALS_PER_HOUR; i++) await bot.handleUpdate(dm(`/seal 1h msg ${i}`));
    await bot.handleUpdate(dm('/seal 1h one too many'));
    assert.match(calls.at(-1).params.text, /try again later/);
    assert.equal(calls.filter((c) => /Sealed until/.test(c.params.text)).length, SEALS_PER_HOUR);
  });
});

describe('/open', () => {
  test('reports time left while sealed, in groups too', async () => {
    const { bot, last, linkFrom } = setup();
    await bot.handleUpdate(dm('/seal 2d hidden'));
    const link = linkFrom(last());
    await bot.handleUpdate(group(`/open ${link}`));
    assert.match(last().params.text, /Still sealed\.<\/b>\nby @alice\nOpens .* UTC \(in (1d 23h|2d)\)/);
    assert.equal(last().params.text.includes('hidden'), false);
  });

  test('opens a capsule from a replied-to message', async () => {
    const { bot, last, linkFrom, beacon } = setup();
    await bot.handleUpdate(dm('/seal 1h replied'));
    const link = linkFrom(last());
    beacon.state.published = Infinity;
    await bot.handleUpdate(group('/open', { reply_to_message: { message_id: 1, text: `check this ${link}` } }));
    assert.match(last().params.text, /replied$/);
  });

  test('handles missing, invalid and tampered capsules', async () => {
    const { bot, last, linkFrom, beacon } = setup();
    await bot.handleUpdate(dm('/open'));
    assert.match(last().params.text, /Send me a capsule link/);
    await bot.handleUpdate(dm(`/open https://lockra.buzz/#c=${'A'.repeat(300)}`));
    assert.match(last().params.text, /does not look like a LOCKRA capsule/);

    await bot.handleUpdate(dm('/seal 1h original'));
    const link = linkFrom(last()).replace('by=%40alice', 'by=%40mallory');
    beacon.state.published = Infinity;
    await bot.handleUpdate(dm(`/open ${link}`));
    assert.match(last().params.text, /tampered with/);
  });

  test('reports when drand cannot be reached', async () => {
    const { bot, last, linkFrom, beacon } = setup();
    await bot.handleUpdate(dm('/seal 1h x'));
    const link = linkFrom(last());
    for (const relay of beacon.chain.relays) beacon.state.overrides.set(relay, () => new Response('down', { status: 503 }));
    await bot.handleUpdate(dm(`/open ${link}`));
    assert.match(last().params.text, /could not be reached/);
  });
});

describe('other messages', () => {
  test('/start, /help and /start seal', async () => {
    const { bot, last } = setup();
    await bot.handleUpdate(dm('/start'));
    assert.match(last().params.text, /The encrypted time capsule/);
    await bot.handleUpdate(dm('/start seal'));
    assert.match(last().params.text, /Tell me <b>when<\/b>/);
    await bot.handleUpdate(group('/help@LockraBot'));
    assert.match(last().params.text, /Never seal seed phrases/);
  });

  test('ignores plain text, unknown commands and other bots', async () => {
    const { bot, calls } = setup();
    for (const t of ['hello', '/unknown', '/seal@OtherBot 1d x']) await bot.handleUpdate(dm(t));
    await bot.handleUpdate({ update_id: 1, edited_message: { text: '/help' } });
    await bot.handleUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 1, type: 'private' }, photo: [] } });
    assert.equal(calls.length, 0);
  });

  test('unexpected failures get a polite reply', async () => {
    const calls = [];
    const logs = [];
    const call = async (method, params) => {
      calls.push(params);
      if (calls.length === 1) throw new Error('boom');
      return {};
    };
    const bot = createBot({ call, username: 'LockraBot', log: (m) => logs.push(m) });
    await bot.handleUpdate(dm('/help'));
    assert.match(calls.at(-1).text, /Something went wrong/);
    assert.match(logs[0], /boom/);
  });
});

describe('alert media', () => {
  test('a video sent in a private chat returns the ALERT_MEDIA value', async () => {
    const { bot, last } = setup();
    await bot.handleUpdate(dm(undefined, { video: { file_id: 'BAACAgQ_x' } }));
    assert.match(last().params.text, /<code>video:BAACAgQ_x<\/code>/);
    await bot.handleUpdate(dm(undefined, { animation: { file_id: 'CgACAg_y' } }));
    assert.match(last().params.text, /<code>animation:CgACAg_y<\/code>/);
  });

  test('media in a group is ignored', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(group(undefined, { video: { file_id: 'x' } }));
    assert.equal(calls.length, 0);
  });
});

test('a custom emoji sent in a private chat returns its id', async () => {
  const { bot, last } = setup();
  await bot.handleUpdate(dm('🔒', { entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5368324170671202286' }] }));
  assert.match(last().params.text, /<code>5368324170671202286<\/code>/);
});
