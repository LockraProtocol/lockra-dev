import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegram, TelegramError } from '../src/telegram.js';

test('calls the Bot API and unwraps results', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { id: 1, username: 'LockraBot' } });
  };
  const tg = createTelegram({ token: '123:ABC', fetch });
  assert.deepEqual(await tg.call('getMe'), { id: 1, username: 'LockraBot' });
  assert.equal(seen[0].url, 'https://api.telegram.org/bot123:ABC/getMe');
});

test('surfaces API errors without leaking the token', async () => {
  const fetch = async () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });
  const tg = createTelegram({ token: '123:SECRET', fetch });
  await assert.rejects(tg.call('getMe'), (e) => e instanceof TelegramError && e.code === 401 && !e.message.includes('SECRET'));
});

test('requires a token', () => {
  assert.throws(() => createTelegram({ token: '' }), /TELEGRAM_BOT_TOKEN/);
});

test('polls, advances the offset, retries after errors and stops on abort', async () => {
  const offsets = [];
  let n = 0;
  const controller = new AbortController();
  const fetch = async (_url, init) => {
    const { offset } = JSON.parse(init.body);
    offsets.push(offset);
    n++;
    if (n === 1) return Response.json({ ok: true, result: [{ update_id: 10 }, { update_id: 11 }] });
    if (n === 2) return Response.json({ ok: false, error_code: 502, description: 'Bad Gateway' }, { status: 502 });
    controller.abort();
    return Response.json({ ok: true, result: [] });
  };
  const handled = [];
  const logs = [];
  const tg = createTelegram({ token: 't', fetch });
  await tg.poll(async (u) => handled.push(u.update_id), { signal: controller.signal, log: (m) => logs.push(m) });
  assert.deepEqual(handled, [10, 11]);
  assert.deepEqual(offsets, [0, 12, 12]);
  assert.match(logs[0], /Bad Gateway/);
});

test('one failing update does not stop the others', async () => {
  const controller = new AbortController();
  let n = 0;
  const fetch = async () => {
    if (++n > 1) controller.abort();
    return Response.json({ ok: true, result: n === 1 ? [{ update_id: 1 }, { update_id: 2 }] : [] });
  };
  const handled = [];
  const logs = [];
  await createTelegram({ token: 't', fetch }).poll(
    async (u) => {
      if (u.update_id === 1) throw new Error('bad update');
      handled.push(u.update_id);
    },
    { signal: controller.signal, log: (m) => logs.push(m) },
  );
  assert.deepEqual(handled, [2]);
  assert.match(logs.join(), /bad update/);
});
