// "Notify me when it opens": a user taps the bell under a sealed capsule and gets a private
// message from the bot (with the usual Telegram sound) the moment the capsule can be read.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MAX_SHOWN = 3500;
const MAX_PER_USER = 50;
const empty = () => ({ capsules: {}, subs: [] });

export function remindersFile(path) {
  let data = null; let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || !data.capsules || !Array.isArray(data.subs)) data = empty();
      return data;
    },
    save() {
      chain = chain.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); });
      return chain;
    },
  };
}
export function memoryRemindersFile() { const d = empty(); return { load: async () => d, save: async () => {} }; }

/**
 * @param {{ file: object, call: Function, open: Function, username?: string, now?: () => number, log?: Function, newId?: () => string }} o
 */
export function createReminders({ file, call, open, username = 'Lockra_bot', now = Date.now, log = () => {}, newId = () => randomBytes(5).toString('hex') }) {
  /** Register a sealed capsule and return the bell button for it. */
  async function button(link, unlockAt, label = '') {
    const d = await file.load();
    let id = Object.keys(d.capsules).find((k) => d.capsules[k].link === link);
    if (!id) { id = newId(); d.capsules[id] = { link, unlockAt: +unlockAt, label }; await file.save(); }
    return { text: '🔔 Notify me when it opens', callback_data: `rm:${id}` };
  }

  /** Tap on the bell. Returns true when the callback was ours. */
  async function handleCallback(q) {
    const m = /^rm:([0-9a-f]+)$/.exec(q?.data || '');
    if (!m) return false;
    const answer = (text, alert = false) => call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert }).catch(() => {});
    const d = await file.load();
    const cap = d.capsules[m[1]];
    if (!cap) { await answer('This capsule is no longer available.'); return true; }
    if (cap.unlockAt <= now()) { await answer('It is already open! Tap the link to read it.'); return true; }
    const userId = q.from.id;
    if (d.subs.some((s) => s.cap === m[1] && s.userId === userId)) { await answer('🔔 You are already on the list for this one.'); return true; }
    if (d.subs.filter((s) => s.userId === userId).length >= MAX_PER_USER) { await answer('You have too many reminders. Wait for some to open.', true); return true; }
    // A bot can only message people who started it: check by sending the confirmation now.
    try {
      await call('sendMessage', { chat_id: userId, text: `🔔 <b>Reminder set.</b>${cap.label ? `\n${esc(cap.label)}` : ''}\nI will message you the moment it opens.`, parse_mode: 'HTML', disable_notification: true });
    } catch {
      await answer(`First open a chat with @${username} and press Start, then tap the bell again.`, true);
      return true;
    }
    d.subs.push({ cap: m[1], userId, at: now() });
    await file.save();
    await answer('🔔 Done! I will message you when it opens.');
    return true;
  }

  /** Send the reminders that are due. */
  async function tick() {
    const d = await file.load();
    const due = d.subs.filter((s) => d.capsules[s.cap] && d.capsules[s.cap].unlockAt <= now());
    if (!due.length) return 0;
    let sent = 0;
    const byCap = new Map();
    for (const s of due) (byCap.get(s.cap) || byCap.set(s.cap, []).get(s.cap)).push(s);
    for (const [id, subs] of byCap) {
      const cap = d.capsules[id];
      let r;
      try { r = await open(cap.link); } catch (e) { log(`reminder open failed: ${e?.message ?? e}`); continue; }
      if (r.status === 'sealed') continue; // beacon not published yet: try next tick
      const body = r.passwordProtected ? '🔐 It is password-protected. Open it on lockra.buzz with the password.'
        : r.message ? esc(r.message.length > MAX_SHOWN ? `${r.message.slice(0, MAX_SHOWN)}…` : r.message) : '';
      const text = [`🔓 <b>Your capsule just opened!</b>`, cap.label ? `<b>${esc(cap.label)}</b>` : null, '', body, r.file ? `📎 Contains a file (${esc(r.file.name)}). Open it on lockra.buzz.` : null].filter((l) => l != null).join('\n');
      for (const s of subs) {
        await call('sendMessage', { chat_id: s.userId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'View on lockra.buzz', url: cap.link }]] } })
          .then(() => { sent += 1; }).catch((e) => log(`reminder send failed: ${e?.message ?? e}`));
      }
      d.subs = d.subs.filter((s) => s.cap !== id);
    }
    // Forget capsules nobody waits for once they are a week past their date.
    for (const [id, c] of Object.entries(d.capsules)) if (c.unlockAt < now() - 7 * 86_400_000 && !d.subs.some((s) => s.cap === id)) delete d.capsules[id];
    await file.save();
    return sent;
  }

  async function run({ signal, every = 15_000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`reminders tick failed: ${e?.message ?? e}`));
      await new Promise((res) => { const t = setTimeout(res, every); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    }
  }

  return { button, handleCallback, tick, run };
}
