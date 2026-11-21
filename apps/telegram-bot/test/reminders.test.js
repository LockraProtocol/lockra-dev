import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReminders, memoryRemindersFile } from '../src/reminders.js';

const setup = (opened = true, dmFails = false) => {
  let t = 1_000_000; const calls = []; let n = 0;
  const call = async (m, p) => { calls.push([m, p]); if (dmFails && m === 'sendMessage') throw new Error('Forbidden'); return {}; };
  const open = async () => (opened && t >= 2_000_000 ? { status: 'opened', message: 'secret hi' } : { status: 'sealed' });
  const r = createReminders({ file: memoryRemindersFile(), call, open, now: () => t, newId: () => `a${n++}` });
  return { r, calls, go: (v) => { t = v; } };
};
const tap = (data, id = 7) => ({ id: 'q', data, from: { id } });

test('bell -> confirmation -> message with sound when it opens, once', async () => {
  const { r, calls, go } = setup();
  const b = await r.button('https://lockra.buzz/#c=x', new Date(2_000_000), 'BTC call');
  assert.equal(b.callback_data, 'rm:a0');
  assert.ok(await r.handleCallback(tap(b.callback_data)));
  assert.ok(calls.some(([m, p]) => m === 'sendMessage' && /Reminder set/.test(p.text)));
  assert.equal(await r.tick(), 0);
  go(2_000_000);
  assert.equal(await r.tick(), 1);
  const msg = calls.filter(([m]) => m === 'sendMessage').pop()[1];
  assert.match(msg.text, /just opened[\s\S]*BTC call[\s\S]*secret hi/);
  assert.equal(msg.disable_notification, undefined);
  assert.equal(await r.tick(), 0);
});

test('user who never started the bot is told to press Start', async () => {
  const { r, calls } = setup(true, true);
  const b = await r.button('L', new Date(2_000_000));
  await r.handleCallback(tap(b.callback_data));
  assert.ok(calls.some(([m, p]) => m === 'answerCallbackQuery' && /press Start/.test(p.text)));
});

test('same capsule reuses the id; not ours returns false', async () => {
  const { r } = setup();
  const a = await r.button('L', new Date(2_000_000)); const b = await r.button('L', new Date(2_000_000));
  assert.equal(a.callback_data, b.callback_data);
  assert.equal(await r.handleCallback(tap('pv:1:1')), false);
});
