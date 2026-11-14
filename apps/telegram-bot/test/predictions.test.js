import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../src/bot.js';
import { memoryStore, fileStore, createRevealer } from '../src/predictions.js';
import { formatDate } from '../src/parse.js';
import { createBeacon } from '../../../packages/sdk/test/helpers.js';

let nextId = 1;
const dm = (text) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: 100, type: 'private' }, from: { id: 7, username: 'alice' } } });
const group = (text) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: -500, type: 'supergroup' }, from: { id: 8, username: 'bob' } } });

function setup() {
  const beacon = createBeacon();
  const calls = [];
  let mid = 1000;
  const call = async (method, params) => { calls.push({ method, params }); return { message_id: mid++ }; };
  const store = memoryStore();
  const sdkOptions = { chain: beacon.chain, fetch: beacon.fetch };
  let clock = Date.now();
  const now = () => clock;
  const bot = createBot({ call, username: 'LockraBot', sdkOptions, now, predictions: { chats: ['-500'], store } });
  const revealer = createRevealer({ call, store, now, sdkOptions, formatDate });
  return { beacon, calls, bot, store, revealer, advance: (ms) => { clock += ms; } };
}

describe('/predict', () => {
  test('seals in private, announces sealed in the group, reveals it there when due', async () => {
    const { bot, calls, store, revealer, beacon, advance } = setup();
    await bot.handleUpdate(dm('/predict 7d $LOCKRA hits 300K <mc>'));
    const announce = calls.find((c) => c.params.chat_id === '-500');
    assert.match(announce.params.text, /New sealed prediction<\/b> by @alice/);
    assert.equal(JSON.stringify(announce).includes('300K'), false, 'the prediction is not visible in the group');
    assert.match(calls.at(-1).params.text, /Sealed and announced in the group/);
    const [saved] = await store.all();
    assert.equal(saved.chatId, '-500');
    assert.equal(saved.messageId, announce.params && 1000);

    await revealer.tick(); // not due yet
    assert.equal((await store.all()).length, 1);

    advance(7 * 86400_000 + 10_000);
    beacon.state.published = Infinity;
    await revealer.tick();
    const reveal = calls.at(-1);
    assert.equal(reveal.params.chat_id, '-500');
    assert.equal(reveal.params.reply_parameters.message_id, 1000);
    assert.match(reveal.params.text, /Prediction revealed<\/b> · by @alice/);
    assert.match(reveal.params.text, /\$LOCKRA hits 300K &lt;mc&gt;/);
    assert.equal((await store.all()).length, 0);
  });

  test('in a group it deletes the command and points to a private chat', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(group('/predict 7d secret call'));
    assert.deepEqual(calls.map((c) => c.method), ['deleteMessage', 'sendMessage']);
    assert.equal(calls[1].params.reply_markup.inline_keyboard[0][0].url, 'https://t.me/LockraBot?start=predict');
    assert.equal(JSON.stringify(calls).includes('secret call'), false);
  });

  test('validates input', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(dm('/predict'));
    assert.match(calls.at(-1).params.text, /Seal a prediction/);
    await bot.handleUpdate(dm('/predict 30m too soon'));
    assert.match(calls.at(-1).params.text, /at least 1 hour/);
    await bot.handleUpdate(dm('/predict 2y too far'));
    assert.match(calls.at(-1).params.text, /at most 1 year/);
    await bot.handleUpdate(dm(`/predict 1d ${'x'.repeat(281)}`));
    assert.match(calls.at(-1).params.text, /280 characters/);
  });

  test('without prediction chats it says so', async () => {
    const calls = [];
    const bot = createBot({ call: async (m, p) => { calls.push(p); return {}; }, username: 'B' });
    await bot.handleUpdate(dm('/predict 1d x'));
    assert.match(calls[0].text, /not set up/);
  });
});

test('fileStore survives restarts and tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pred-'));
  const path = join(dir, 'sub', 'p.json');
  const a = fileStore(path);
  assert.deepEqual(await a.all(), []);
  await a.add({ link: 'x', unlockAt: 1 });
  const b = fileStore(path);
  assert.equal((await b.all())[0].link, 'x');
  await b.remove('x');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 0);
});
