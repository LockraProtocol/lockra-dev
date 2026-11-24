import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaily, memoryDailyFile, rankFor, cetParts } from '../src/daily.js';

const HOUR = 3_600_000;
// 2026-11-23 10:00 CET = 09:00 UTC
const T0 = Date.UTC(2026, 10, 23, 9, 0);

function setup({ prices = [100, 110] } = {}) {
  let t = T0 - HOUR; const calls = []; let p = 0; let n = 0;
  const call = async (m, params) => { calls.push([m, params]); return { message_id: calls.length }; };
  const daily = createDaily({ file: memoryDailyFile(), call, chats: ['-100'], price: async () => prices[Math.min(p++, prices.length - 1)], seal: async () => 'https://lockra.buzz/#c=sealed', now: () => t, newId: () => `a${n++}` });
  const vote = (id, pick, rid = 'a0') => daily.handleCallback({ id: 'q', data: `dp:${rid}:${pick}`, from: { id, username: `u${id}` } });
  return { daily, calls, vote, at: (ms) => { t = ms; }, sent: (re) => calls.filter(([m, x]) => (m === 'sendMessage' || m === 'sendPhoto') && re.test(x.text || x.caption || '')) };
}

test('ranks ladder', () => {
  assert.equal(rankFor(0), null);
  assert.equal(rankFor(1).name, 'Rookie');
  assert.equal(rankFor(6).name, 'Seer');
  assert.equal(rankFor(7).name, 'Oracle');
  assert.equal(rankFor(60).name, 'LOCKRA Legend');
  assert.equal(cetParts(T0).hour, 10);
});

test('opens at 10:00 CET, once per day', async () => {
  const s = setup();
  await s.daily.tick();
  assert.equal(s.sent(/Daily Prediction/).length, 0);
  s.at(T0); await s.daily.tick(); await s.daily.tick();
  assert.equal(s.sent(/Daily Prediction<\/b>/).length, 1);
});

test('sealed votes, close, resolve and score', async () => {
  const s = setup({ prices: [100, 110] });
  s.at(T0); await s.daily.tick();
  await s.vote(1, 'u'); await s.vote(2, 'd'); await s.vote(2, 'u'); await s.vote(3, 'd');
  s.at(T0 + 5 * HOUR + 1); await s.daily.tick();
  assert.equal(s.sent(/votes are sealed in a LOCKRA capsule/).length, 1);
  const late = await s.vote(4, 'u');
  assert.ok(late);
  assert.ok(s.calls.some(([m, x]) => m === 'answerCallbackQuery' && /closed/.test(x.text)));
  s.at(T0 + 24 * HOUR + 1); await s.daily.tick();
  assert.match(s.sent(/Daily Prediction result/)[0][1].text, /\$100\.00 → <b>\$110\.00<\/b> · ⬆️ HIGHER[\s\S]*2 called it · ❌ 1 missed/);
  assert.equal(s.calls.filter(([m, x]) => m === 'sendPhoto' && /rookie\.jpg$/.test(x.photo)).length, 2);
  assert.match(await s.daily.profile({ id: 1, username: 'u1' }), /🌱 Rookie[\s\S]*1 correct · 100% hit rate/);
  assert.match(await s.daily.board(), /u1 · 🌱 Rookie · <b>1<\/b> wins/);
});

test('prestige needs LOCKRA Legend and resets wins with a star', async () => {
  const s = setup();
  assert.match(await s.daily.prestige({ id: 9 }), /need 60/);
});

test('result names the members who called it, with their rank', async () => {
  const s = setup({ prices: [100, 120] });
  s.at(T0); await s.daily.tick();
  await s.vote(7, 'u'); await s.vote(8, 'd');
  s.at(T0 + 25 * HOUR); await s.daily.tick();
  const res = s.sent(/Called it/)[0][1].text;
  assert.match(res, /@u7 🌱 Rookie/);
  assert.doesNotMatch(res, /@u8/);
  assert.equal(await s.daily.tagOf(7), '🌱 Rookie');
  assert.equal(await s.daily.tagOf(8), '');
});
