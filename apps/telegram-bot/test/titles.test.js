import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaily, memoryDailyFile, rankTitle } from '../src/daily.js';

test('rankTitle fits the 16-character admin title', () => {
  assert.equal(rankTitle({ wins: 0, prestige: 0 }), '');
  assert.equal(rankTitle({ wins: 1, prestige: 0 }), '🌱 Rookie');
  assert.equal(rankTitle({ wins: 8, prestige: 1 }), '⭐ 🔮 Oracle');
  assert.equal(rankTitle({ wins: 60, prestige: 0 }), '👑 Legend');
  for (let p = 0; p <= 4; p++) for (const w of [1, 3, 7, 15, 25, 40, 60]) assert.ok([...rankTitle({ wins: w, prestige: p })].length <= 16);
});

const make = (member) => {
  const calls = [];
  const call = async (m, p) => { calls.push([m, p]); if (m === 'getChatMember') return member(p.user_id); return { message_id: 1 }; };
  const file = memoryDailyFile();
  const daily = createDaily({ file, call, chats: ['-100'], price: async () => 1, seal: async () => 'x', now: () => 0 });
  return { calls, file, daily };
};

test('/titles gives members their rank title and skips real admins', async () => {
  const { calls, file, daily } = make((id) => (id === 1 ? { status: 'creator' } : id === 2 ? { status: 'member' } : id === 3 ? { status: 'administrator', can_be_edited: false, can_delete_messages: true } : { status: 'member' }));
  const d = await file.load();
  d.users[2] = { id: 2, name: 'a', wins: 3, prestige: 0, total: 3 };
  d.users[3] = { id: 3, name: 'b', wins: 7, prestige: 0, total: 7 };
  d.users[4] = { id: 4, name: 'c', wins: 0, prestige: 0, total: 2 };
  await daily.handleMessage({ chat: { id: '-100' }, from: { id: 1 }, message_id: 9 }, { name: 'titles' });
  const titles = calls.filter(([m]) => m === 'setChatAdministratorCustomTitle').map(([, p]) => [p.user_id, p.custom_title]);
  assert.deepEqual(titles, [[2, '👁️ Seer']]);
  const promo = calls.find(([m]) => m === 'promoteChatMember')[1];
  assert.equal(promo.can_delete_messages, false);
  assert.match(calls.at(-1)[1].text, /Updated 1 rank title/);
});

test('/titles is admin only', async () => {
  const { calls, daily } = make(() => ({ status: 'member' }));
  await daily.handleMessage({ chat: { id: '-100' }, from: { id: 5 }, message_id: 9 }, { name: 'titles' });
  assert.match(calls.at(-1)[1].text, /Only group admins/);
  assert.ok(!calls.some(([m]) => m === 'promoteChatMember'));
});
