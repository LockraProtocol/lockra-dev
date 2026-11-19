import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGm, memoryGmFile, isGm, madridDay } from '../src/gm.js';

const DAY = 86_400_000;
const setup = () => {
  let t = Date.UTC(2026, 10, 18, 9); const calls = [];
  const gm = createGm({ file: memoryGmFile(), call: async (m, p) => { calls.push([m, p]); return {}; }, now: () => t });
  const msg = (text, id = 1) => ({ text, message_id: 1, chat: { id: -100, type: 'supergroup' }, from: { id, username: `u${id}` } });
  return { gm, msg, calls, tick: (d = 1) => { t += d * DAY; } };
};

test('gm detection', () => {
  for (const s of ['gm', 'GM fam', 'gmmm', 'Good morning', 'buenos días']) assert.ok(isGm(s), s);
  for (const s of ['gmail', 'hi', 'ngmi']) assert.ok(!isGm(s), s);
  assert.equal(madridDay(Date.UTC(2026, 10, 18, 23, 30)), '2026-11-19');
});

test('streak grows once per day and never resets', async () => {
  const { gm, msg, tick } = setup();
  assert.match(await gm.record(msg('gm')), /1-day streak/);
  assert.equal(await gm.record(msg('gm again')), null);
  tick(); assert.match(await gm.record(msg('gm')), /2-day streak/);
  tick(3); assert.match(await gm.record(msg('gm')), /3-day streak/);
});

test('badges at 7, 14, 30 and legend title at 30', async () => {
  const { gm, msg, tick, calls } = setup();
  const out = [];
  for (let i = 0; i < 30; i++) { out.push(await gm.record(msg('gm'))); tick(); }
  assert.match(out[6], /GM Week/);
  assert.match(out[13], /GM Two Weeks/);
  assert.match(out[29], /GM Month[\s\S]*GM Legend/);
  assert.ok(calls.some(([m, p]) => m === 'setChatAdministratorCustomTitle' && p.custom_title === 'GM Legend'));
  assert.match(await gm.board(-100), /u1 · 🔥 <b>30<\/b> days 🥉🥈🥇/);
});

test('ignores private chats and bots', async () => {
  const { gm } = setup();
  assert.equal(await gm.handleMessage({ text: 'gm', chat: { id: 1, type: 'private' }, from: { id: 1 } }, null), false);
  assert.equal(await gm.handleMessage({ text: 'gm', chat: { id: -1, type: 'group' }, from: { id: 2, is_bot: true } }, null), false);
});

test('welcome message once per burst, with the CA and /about', async () => {
  const { createBot } = await import('../src/bot.js');
  let t = 0; const calls = [];
  const bot = createBot({ call: async (m, p) => { calls.push([m, p]); return { message_id: calls.length }; }, username: 'Lockra_bot', now: () => t, token: '0xabc' });
  const join = (id) => ({ update_id: id, message: { message_id: id, chat: { id: -1, type: 'supergroup' }, from: { id }, new_chat_members: [{ id, first_name: `U${id}` }] } });
  await bot.handleUpdate(join(1)); await bot.handleUpdate(join(2));
  const sends = calls.filter(([m]) => m === 'sendMessage');
  assert.equal(sends.length, 1);
  assert.match(sends[0][1].text, /Welcome to LOCKRA, U1![\s\S]*CA: <code>0xabc<\/code>[\s\S]*\/about/);
  t = 61_000; await bot.handleUpdate(join(3));
  assert.ok(calls.some(([m, p]) => m === 'deleteMessage' && p.message_id === 1));
});
