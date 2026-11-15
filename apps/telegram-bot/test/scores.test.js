import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../src/bot.js';
import { memoryStore, createRevealer } from '../src/predictions.js';
import { createScores, memoryFile, jsonFile } from '../src/scores.js';
import { formatDate } from '../src/parse.js';
import { createBeacon } from '../../../packages/sdk/test/helpers.js';

let nextId = 1;
const dm = (text, from = { id: 7, username: 'alice' }) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: 100, type: 'private' }, from } });
const group = (text) => ({ update_id: nextId, message: { message_id: nextId++, text, chat: { id: -500, type: 'supergroup' }, from: { id: 8, username: 'bob' } } });
const tap = (data, userId, message_id) => ({ update_id: nextId++, callback_query: { id: `q${nextId}`, data, from: { id: userId }, message: { message_id, chat: { id: -500 } } } });

function setup() {
  const beacon = createBeacon();
  const calls = [];
  let mid = 1000;
  const call = async (method, params) => { calls.push({ method, params }); return { message_id: mid++ }; };
  let clock = Date.now();
  const now = () => clock;
  const store = memoryStore();
  const scores = createScores({ file: memoryFile(), now });
  const sdkOptions = { chain: beacon.chain, fetch: beacon.fetch };
  const bot = createBot({ call, username: 'LockraBot', sdkOptions, now, predictions: { chats: ['-500'], store }, scores });
  const revealer = createRevealer({ call, store, scores, now, sdkOptions, formatDate });
  return { calls, bot, revealer, scores, beacon, advance: (ms) => { clock += ms; } };
}

async function revealOne(s, text = '/predict 2h BTC 100k') {
  await s.bot.handleUpdate(dm(text));
  s.advance(2 * 3_600_000 + 10_000);
  s.beacon.state.published = Infinity;
  await s.revealer.tick();
  const reveal = s.calls.findLast((c) => /Prediction revealed/.test(c.params?.text || ''));
  const id = /^pv:([0-9a-f]+):1$/.exec(reveal.params.reply_markup.inline_keyboard[0][0].callback_data)[1];
  return { reveal, id, messageId: 1000 + s.calls.indexOf(reveal) };
}

describe('prediction leaderboard', () => {
  test('a revealed prediction gets vote buttons and a verify link', async () => {
    const s = setup();
    const { reveal } = await revealOne(s);
    const kb = reveal.params.reply_markup.inline_keyboard;
    assert.equal(kb[0][0].text, '✅ Called it · 0');
    assert.equal(kb[0][1].text, '❌ Missed it · 0');
    assert.match(kb[1][0].url, /^https:\/\/lockra\.buzz\//);
    assert.match(reveal.params.text, /Vote below/);
  });

  test('votes are counted once per person, can change, and the author cannot vote', async () => {
    const s = setup();
    const { id } = await revealOne(s);
    await s.bot.handleUpdate(tap(`pv:${id}:1`, 20, 55));
    await s.bot.handleUpdate(tap(`pv:${id}:1`, 20, 55));
    await s.bot.handleUpdate(tap(`pv:${id}:0`, 21, 55));
    await s.bot.handleUpdate(tap(`pv:${id}:1`, 21, 55)); // changed mind
    await s.bot.handleUpdate(tap(`pv:${id}:1`, 7, 55)); // alice is the author
    const answers = s.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text);
    assert.deepEqual(answers, ['Voted: called it ✅', 'You already voted that.', 'Voted: missed it ❌', 'Voted: called it ✅', 'You cannot vote on your own prediction 😉']);
    const edit = s.calls.findLast((c) => c.method === 'editMessageReplyMarkup');
    assert.equal(edit.params.reply_markup.inline_keyboard[0][0].text, '✅ Called it · 2');
    assert.equal(edit.params.reply_markup.inline_keyboard[0][1].text, '❌ Missed it · 0');
  });

  test('after 24h the majority decides, the verdict is posted and the leaderboard updates', async () => {
    const s = setup();
    const { id } = await revealOne(s);
    for (const u of [20, 21, 22]) await s.bot.handleUpdate(tap(`pv:${id}:1`, u, 55));
    await s.bot.handleUpdate(tap(`pv:${id}:0`, 23, 55));
    s.advance(24 * 3_600_000 + 1000);
    await s.revealer.tick();
    const verdict = s.calls.findLast((c) => /Community verdict/.test(c.params?.text || ''));
    assert.match(verdict.params.text, /called it<\/b> \(3–1\)/);
    assert.match(verdict.params.text, /@alice gets \+1/);
    const closed = s.calls.findLast((c) => c.method === 'editMessageReplyMarkup');
    assert.equal(closed.params.reply_markup.inline_keyboard[0][0].text, '✅ Called it · 3–1');
    await s.bot.handleUpdate(tap(`pv:${id}:1`, 30, 55));
    assert.match(s.calls.findLast((c) => c.method === 'answerCallbackQuery').params.text, /closed/);
    await s.bot.handleUpdate(group('/leaderboard'));
    assert.match(s.calls.at(-1).params.text, /🥇 @alice · <b>1<\/b> called · 0 missed \(100%\)/);
  });

  test('ranking: most called first, then accuracy; no votes is not scored', async () => {
    let t = 0;
    const scores = createScores({ file: memoryFile(), now: () => t, voteMs: 10 });
    const run = async (by, byId, votes) => { const p = await scores.create({ chatId: 1, by, byId }); for (const [u, v] of votes) await scores.vote(p.id, u, v); };
    await run('@a', 1, [[9, true]]);
    await run('@a', 1, [[9, false]]);
    await run('@b', 2, [[9, true]]);
    await run('@c', 3, []);
    t = 100;
    await scores.closeDue();
    const top = await scores.top();
    assert.deepEqual(top.map((u) => [u.name, u.called, u.missed]), [['@b', 1, 0], ['@a', 1, 1]]);
  });

  test('empty leaderboard explains how to get on it', async () => {
    const s = setup();
    await s.bot.handleUpdate(group('/leaderboard'));
    assert.match(s.calls.at(-1).params.text, /No predictions scored yet/);
  });

  test('jsonFile survives a restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'lb-')), 'd', 'scores.json');
    let t = 0;
    const a = createScores({ file: jsonFile(path), now: () => t, voteMs: 10 });
    const p = await a.create({ chatId: 1, by: '@z', byId: 5 });
    await a.vote(p.id, 9, true);
    t = 50; await a.closeDue();
    const b = createScores({ file: jsonFile(path), now: () => t });
    assert.equal((await b.top())[0].name, '@z');
    assert.ok(JSON.parse(await readFile(path, 'utf8')).users);
  });
});
