// Sealed predictions: a prediction is sealed in a private chat, announced in the community group,
// and revealed automatically in the group when its time comes. Nobody can read it before then,
// not even its author, so nobody can claim "I called it" after the fact.
//
// State is a small JSON file (PREDICTIONS_FILE). If it is lost (e.g. a redeploy without a volume),
// nothing breaks: every announcement carries the capsule link, so anyone can reply /open to it.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open } from 'lockra-sdk';
import { voteKeyboard, VOTE_HOURS } from './scores.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A tiny JSON-file store. `load` never throws: a missing or broken file starts empty. */
export function fileStore(path) {
  let items = null;
  const load = async () => {
    if (items) return items;
    try { items = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(items)) items = []; } catch { items = []; }
    return items;
  };
  const save = async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(items));
    await rename(tmp, path);
  };
  return {
    all: load,
    add: async (item) => { (await load()).push(item); await save(); },
    remove: async (link) => { items = (await load()).filter((x) => x.link !== link); await save(); },
  };
}

/** In-memory store, for tests. */
export function memoryStore() {
  let items = [];
  return { all: async () => items, add: async (x) => { items.push(x); }, remove: async (link) => { items = items.filter((x) => x.link !== link); } };
}

/**
 * Reveal predictions that have reached their time. With `scores`, each reveal opens a group vote
 * (called it / missed it) that feeds /leaderboard.
 * @param {{ call: Function, store: ReturnType<typeof fileStore>, scores?: object, now?: () => number, sdkOptions?: object, log?: Function, formatDate: Function }} o
 */
export function createRevealer({ call, store, scores = null, now = Date.now, sdkOptions = {}, log = () => {}, formatDate }) {
  async function closeVotes() {
    if (!scores) return;
    for (const p of await scores.closeDue()) {
      if (p.messageId) {
        await call('editMessageReplyMarkup', { chat_id: p.chatId, message_id: p.messageId, reply_markup: voteKeyboard(p, p.link) })
          .catch((e) => log(`closing vote ${p.id}: ${e.message}`));
      }
      if (!p.yes && !p.no) continue;
      const who = p.by ? esc(p.by) : 'The author';
      const text = p.result === 'called'
        ? `✅ <b>Community verdict: called it</b> (${p.yes}–${p.no})\n${who} gets +1 on /leaderboard 🏆`
        : p.result === 'missed'
          ? `❌ <b>Community verdict: missed it</b> (${p.yes}–${p.no})\nIt counts on /leaderboard. Better luck next call.`
          : `🤷 <b>Tie</b> (${p.yes}–${p.no}). No verdict, not scored.`;
      await call('sendMessage', {
        chat_id: p.chatId, text, parse_mode: 'HTML',
        ...(p.messageId ? { reply_parameters: { message_id: p.messageId, allow_sending_without_reply: true } } : {}),
      }).catch((e) => log(`verdict ${p.id}: ${e.message}`));
    }
  }

  async function tick() {
    await closeVotes().catch((e) => log(`votes: ${e.message}`));
    const due = (await store.all()).filter((p) => p.unlockAt <= now());
    for (const p of due) {
      let r;
      try {
        r = await open(p.link, sdkOptions);
      } catch (e) {
        log(`prediction ${p.link.slice(0, 40)}… not opened yet: ${e.message}`);
        continue; // drand unreachable or a moment early: try again next tick
      }
      if (r.status !== 'opened') continue;
      const text = [
        `🔓 <b>Prediction revealed</b>${p.by ? ` · by ${esc(p.by)}` : ''}`,
        `Sealed ${esc(formatDate(new Date(p.sealedAt)))}`,
        '',
        `<blockquote>${esc(r.message)}</blockquote>`,
        '',
        scores ? `Called it or missed it? Vote below 👇 (open ${VOTE_HOURS}h, counts on /leaderboard)` : 'Called it or missed it? 👇',
      ].join('\n');
      const poll = scores ? await scores.create({ chatId: p.chatId, by: p.by, byId: p.byId, link: p.link }).catch((e) => { log(`vote setup failed: ${e.message}`); return null; }) : null;
      const sent = await call('sendMessage', {
        chat_id: p.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: p.messageId, allow_sending_without_reply: true },
        reply_markup: poll ? voteKeyboard(poll, p.link) : { inline_keyboard: [[{ text: 'Verify on lockra.buzz', url: p.link }]] },
      }).catch((e) => { log(`reveal to ${p.chatId} failed: ${e.message}`); return null; });
      if (poll && sent?.message_id) await scores.attach(poll.id, sent.message_id).catch((e) => log(`vote attach failed: ${e.message}`));
      await store.remove(p.link);
    }
  }
  async function run({ signal, intervalMs = 30_000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`predictions: ${e.message}`));
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
        const t = setTimeout(done, intervalMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  return { tick, run };
}
