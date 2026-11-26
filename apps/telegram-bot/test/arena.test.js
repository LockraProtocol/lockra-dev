import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArena, memoryArenaFile, parseLogs, TOPICS, fmt } from '../src/arena.js';

const pad = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const at = (a) => '0x' + a.slice(2).padStart(64, '0');
const HOST = '0x' + '1'.repeat(40), CH = '0x' + '2'.repeat(40), ZERO = '0x' + '0'.repeat(40);
const E18 = 10n ** 18n;
const lg = (topics, data = '0x', tx = '0xabc') => ({ topics, data, transactionHash: tx, blockNumber: '0x10' });

const created = lg([TOPICS.created, pad(7), at(HOST), at(ZERO)], pad(50000n * E18));
const joined = lg([TOPICS.joined, pad(7), at(CH)], pad(1700000000));
const rev1 = lg([TOPICS.revealed, pad(7), at(HOST)], pad(1)); // rock
const rev2 = lg([TOPICS.revealed, pad(7), at(CH)], pad(3)); // scissors
const won = lg([TOPICS.won, pad(7), at(HOST), at(CH)], '0x' + pad(95000n * E18).slice(2) + pad(5000n * E18).slice(2));

test('parseLogs reads every event and attaches the revealed moves', () => {
  const ev = parseLogs([created, joined, rev1, rev2, won]);
  assert.deepEqual(ev.map((e) => e.type), ['created', 'joined', 'won']);
  assert.equal(ev[0].stake, 50000n * E18);
  assert.equal(ev[2].winner, HOST);
  assert.equal(ev[2].moves[HOST], 1);
  assert.equal(ev[2].moves[CH], 3);
  assert.equal(fmt(95000n * E18), '95,000');
});

test('posts created, joined and won to every chat, then tracks the board', async () => {
  const sent = [];
  let head = 100; const batches = [[created, joined, rev1, rev2, won]];
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x' + head.toString(16) : batches.shift() || []);
  const a = createArena({ address: '0x' + 'a'.repeat(40), rpc, file: memoryArenaFile(), chats: ['-1', '-2'], send: async (c, html, b) => { sent.push({ c, html, b }); }, explorer: 'https://x' });
  await a.tick(); // first tick only sets the start block
  head = 110; await a.tick();
  assert.equal(sent.length, 6);
  assert.match(sent[0].html, /New Arena challenge #7/);
  assert.match(sent[0].html, /50,000 \$LOCKRA/);
  assert.match(sent[0].b[0][0].url, /arena\?game=7/);
  assert.match(sent[2].html, /accepted/);
  assert.match(sent[4].html, /✊ Rock beats ✌️ Scissors/);
  assert.match(sent[4].html, /95,000 \$LOCKRA/);
  assert.match(sent[4].html, /5,000 \$LOCKRA<\/b> burned/);
  const b = await a.board();
  assert.match(b, /1 game played/);
  assert.match(b, /1W 0L/);
});

test('draws report the shared move and no fee', async () => {
  const d = lg([TOPICS.drawn, pad(9)]);
  const r1 = lg([TOPICS.revealed, pad(9), at(HOST)], pad(2));
  const r2 = lg([TOPICS.revealed, pad(9), at(CH)], pad(2));
  const sent = [];
  let head = 1; const batches = [[r1, r2, d]];
  const a = createArena({ address: '0x' + 'a'.repeat(40), rpc: async (m) => (m === 'eth_blockNumber' ? '0x' + (head++).toString(16) : batches.shift() || []), file: memoryArenaFile(), chats: ['-1'], send: async (c, html) => { sent.push(html); } });
  await a.tick(); await a.tick();
  assert.match(sent[0], /draw/);
  assert.match(sent[0], /Both picked ✋ Paper/);
});
