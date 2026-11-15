// Prediction leaderboard. When a sealed prediction is revealed, the group votes on it for a while
// (✅ Called it / ❌ Missed it). When voting closes, the majority decides and the author's record on
// /leaderboard is updated. One vote per person (it can be changed); authors cannot vote on their own.
//
// State is a small JSON file next to the predictions file. Losing it only resets the leaderboard.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const VOTE_HOURS = 24;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const empty = () => ({ polls: {}, users: {} });

/** A JSON object kept in a file. Writes are serialized and atomic. */
export function jsonFile(path) {
  let data = null;
  let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || !data.polls || !data.users) data = empty();
      return data;
    },
    save() {
      chain = chain.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(data));
        await rename(`${path}.tmp`, path);
      });
      return chain;
    },
  };
}

/** In-memory version, for tests. */
export function memoryFile() {
  const data = empty();
  return { load: async () => data, save: async () => {} };
}

/** Inline buttons for a poll. */
export function voteKeyboard(poll, link) {
  const yes = Object.values(poll.votes).filter((v) => v === 1).length;
  const no = Object.values(poll.votes).length - yes;
  const rows = poll.closed
    ? [[{ text: `${poll.result === 'called' ? '✅ Called it' : poll.result === 'missed' ? '❌ Missed it' : '🤷 No verdict'} · ${yes}–${no}`, callback_data: `pv:${poll.id}:x` }]]
    : [[{ text: `✅ Called it · ${yes}`, callback_data: `pv:${poll.id}:1` }, { text: `❌ Missed it · ${no}`, callback_data: `pv:${poll.id}:0` }]];
  if (link) rows.push([{ text: 'Verify on lockra.buzz', url: link }]);
  return { inline_keyboard: rows };
}

/**
 * @param {{ file: { load: Function, save: Function }, now?: () => number, voteMs?: number, newId?: () => string }} o
 */
export function createScores({ file, now = Date.now, voteMs = VOTE_HOURS * 3_600_000, newId = () => randomBytes(5).toString('hex') }) {
  const authorKey = (p) => (p.byId != null ? `id:${p.byId}` : p.by ? `name:${String(p.by).toLowerCase()}` : null);

  /** Register a poll before the reveal is posted; returns it (with its id for the buttons). */
  async function create({ chatId, by, byId, link }) {
    const d = await file.load();
    const poll = { id: newId(), chatId, by: by || '', byId: byId ?? null, link: link || '', messageId: null, closesAt: now() + voteMs, votes: {}, closed: false, result: null };
    d.polls[poll.id] = poll;
    await file.save();
    return poll;
  }

  async function attach(id, messageId) {
    const d = await file.load();
    if (!d.polls[id]) return;
    d.polls[id].messageId = messageId;
    await file.save();
  }

  /** @returns {{ ok: boolean, text: string, poll?: object }} */
  async function vote(id, userId, yes) {
    const d = await file.load();
    const p = d.polls[id];
    if (!p) return { ok: false, text: 'This vote is no longer available.' };
    if (p.closed || now() >= p.closesAt) return { ok: false, text: 'Voting on this prediction is closed.' };
    if (p.byId != null && String(p.byId) === String(userId)) return { ok: false, text: 'You cannot vote on your own prediction 😉' };
    const v = yes ? 1 : 0;
    if (p.votes[userId] === v) return { ok: false, text: 'You already voted that.' };
    p.votes[userId] = v;
    await file.save();
    return { ok: true, text: yes ? 'Voted: called it ✅' : 'Voted: missed it ❌', poll: p };
  }

  /** Close polls whose time is up and score their authors. Returns the polls just closed. */
  async function closeDue() {
    const d = await file.load();
    const done = [];
    for (const p of Object.values(d.polls)) {
      if (p.closed || now() < p.closesAt) continue;
      const yes = Object.values(p.votes).filter((v) => v === 1).length;
      const no = Object.values(p.votes).length - yes;
      p.closed = true;
      p.result = yes > no ? 'called' : no > yes ? 'missed' : 'none';
      p.yes = yes; p.no = no;
      const key = authorKey(p);
      if (key && p.result !== 'none') {
        const u = d.users[key] || (d.users[key] = { name: p.by, called: 0, missed: 0 });
        if (p.by) u.name = p.by;
        u[p.result] += 1;
      }
      done.push(p);
    }
    // Keep closed polls a week so late taps get a clear answer, then drop them.
    for (const [id, p] of Object.entries(d.polls)) if (p.closed && now() - p.closesAt > 7 * 86_400_000) delete d.polls[id];
    if (done.length) await file.save();
    return done;
  }

  async function top(n = 10) {
    const d = await file.load();
    return Object.values(d.users)
      .filter((u) => u.called + u.missed > 0)
      .map((u) => ({ ...u, total: u.called + u.missed, rate: u.called / (u.called + u.missed) }))
      .sort((a, b) => b.called - a.called || b.rate - a.rate || a.missed - b.missed || String(a.name).localeCompare(String(b.name)))
      .slice(0, n);
  }

  async function leaderboardText(n = 10) {
    const rows = await top(n);
    if (!rows.length) {
      return ['🏆 <b>Prediction leaderboard</b>', '', 'No predictions scored yet.', 'Seal one with /predict in a private chat with me. When it opens, the group votes: called it or missed it.'].join('\n');
    }
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return [
      '🏆 <b>Prediction leaderboard</b>',
      '',
      ...rows.map((u, i) => `${medal(i)} ${esc(u.name || 'anon')} · <b>${u.called}</b> called · ${u.missed} missed (${Math.round(u.rate * 100)}%)`),
      '',
      'Sealed with /predict. Revealed by drand. Judged by the group.',
    ].join('\n');
  }

  return { create, attach, vote, closeDue, top, leaderboardText };
}
