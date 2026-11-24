import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaily, memoryDailyFile } from '../src/daily.js';
import { createSports } from '../src/sports.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 23, 9, 0); // 10:00 CET

test('sports client picks a top-league match and reads the result', async () => {
  const fetchFn = async (url) => ({ ok: true, json: async () => url.includes('eventsday')
    ? { events: [
      { idEvent: '1', idLeague: '9999', strHomeTeam: 'Small FC', strAwayTeam: 'Tiny FC', strTimestamp: '2026-11-23T20:00:00' },
      { idEvent: '2', idLeague: '4328', strLeague: 'English Premier League', strHomeTeam: 'Arsenal', strAwayTeam: 'Chelsea', strTimestamp: '2026-11-23T20:00:00' },
    ] }
    : { events: [{ idEvent: '2', strStatus: 'Match Finished', intHomeScore: '2', intAwayScore: '2' }] } });
  const s = createSports({ fetchFn });
  const m = await s.pick('football', '2026-11-23', T0);
  assert.equal(m.home, 'Arsenal'); assert.equal(m.draw, true);
  assert.deepEqual(await s.result('2'), { outcome: 'e', score: '2–2' });
});

test('football round: three options, closes before kick-off, scores after the final whistle', async () => {
  let t = T0; const calls = []; let res = null;
  const sports = {
    pick: async () => ({ id: '2', sport: 'football', league: 'Premier League', home: 'Arsenal', away: 'Chelsea', startsAt: T0 + 3 * HOUR, draw: true, emoji: '⚽' }),
    result: async () => res,
  };
  const d = createDaily({ file: memoryDailyFile(), call: async (m, p) => { calls.push([m, p]); return { message_id: 1 }; }, chats: ['-1'], price: async () => 100, sports, topic: () => 'football', now: () => t, newId: () => 'r1' });
  await d.tick();
  const q = calls.find(([m]) => m === 'sendMessage')[1];
  assert.match(q.text, /Arsenal vs Chelsea[\s\S]*Who wins\?/);
  assert.deepEqual(q.reply_markup.inline_keyboard[0].map((b) => b.text), ['Arsenal', 'Draw', 'Chelsea']);
  const vote = (id, k) => d.handleCallback({ id: 'q', data: `dp:r1:${k}`, from: { id, username: `u${id}` } });
  await vote(1, 'h'); await vote(2, 'e'); await vote(3, 'a');
  t = T0 + 3 * HOUR - 4 * 60_000; await d.tick(); // closed 5 min before kick-off
  t = T0 + 5 * HOUR + 1; await d.tick(); // result not in yet
  assert.ok(!calls.some(([, p]) => /Daily Prediction result/.test(p?.text || '')));
  res = { outcome: 'h', score: '3–1' };
  t += 31 * 60_000; await d.tick();
  const r = calls.find(([, p]) => /Daily Prediction result/.test(p?.text || ''))[1].text;
  assert.match(r, /Arsenal win/); assert.match(r, /1 called it/); assert.match(r, /2 missed/);
});

test('falls back to crypto when no match is on', async () => {
  const calls = [];
  const d = createDaily({ file: memoryDailyFile(), call: async (m, p) => { calls.push([m, p]); return {}; }, chats: ['-1'], price: async () => 100, sports: { pick: async () => null }, topic: () => 'tennis', now: () => T0 });
  await d.tick();
  assert.match(calls[0][1].text, /higher or lower/);
});
