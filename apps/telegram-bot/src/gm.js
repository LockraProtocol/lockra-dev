// GM streaks. Say gm in the group once a day (Madrid time) to keep your streak alive.
// Miss a day and it goes back to 1. Badges at 7, 14 and 30 days; at 30 days the bot also gives a
// "GM Legend" title (admin with no permissions) so it shows next to the name in the group.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const GM_BADGES = [
  { days: 7, emoji: '🥉', name: 'GM Week' },
  { days: 14, emoji: '🥈', name: 'GM Two Weeks' },
  { days: 30, emoji: '🥇', name: 'GM Month' },
];
export const LEGEND_TITLE = 'GM Legend';
const GM_RE = /^\s*(gm+|good\s*morning|buenos\s*d[ií]as)\b/i;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Calendar day in Madrid for a timestamp, as YYYY-MM-DD. */
export function madridDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
const prevDay = (day) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
export const isGm = (text) => GM_RE.test(String(text || ''));

export function gmFile(path) {
  let data = null; let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || !data.users) data = { users: {} };
      return data;
    },
    save() {
      chain = chain.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); });
      return chain;
    },
  };
}
export function memoryGmFile() { const data = { users: {} }; return { load: async () => data, save: async () => {} }; }

const badgesOf = (u) => GM_BADGES.filter((b) => u.best >= b.days);
const badgeLine = (u) => badgesOf(u).map((b) => b.emoji).join('');

/**
 * @param {{ file: object, call: Function, now?: () => number, log?: Function }} o
 */
export function createGm({ file, call, now = Date.now, log = () => {} }) {
  const reply = (msg, text) => call('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, link_preview_options: { is_disabled: true } });
  const nameOf = (f) => (f.username ? `@${f.username}` : [f.first_name, f.last_name].filter(Boolean).join(' ') || 'anon');

  async function giveLegend(chatId, userId) {
    try {
      await call('promoteChatMember', { chat_id: chatId, user_id: userId, can_manage_chat: false, can_delete_messages: false, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, is_anonymous: false });
      await call('setChatAdministratorCustomTitle', { chat_id: chatId, user_id: userId, custom_title: LEGEND_TITLE });
      return true;
    } catch (e) { log(`gm legend title failed: ${e?.message ?? e}`); return false; }
  }

  /** Count a gm. Returns the reply text, or null when it was already counted today. */
  async function record(msg) {
    const d = await file.load();
    const key = `${msg.chat.id}:${msg.from.id}`;
    const today = madridDay(now());
    const u = d.users[key] || (d.users[key] = { chatId: msg.chat.id, userId: msg.from.id, name: '', streak: 0, best: 0, last: null, total: 0, legend: false });
    u.name = nameOf(msg.from);
    if (u.last === today) return null;
    const lost = u.last && u.last !== prevDay(today) && u.streak > 1 ? u.streak : 0;
    u.streak = u.last === prevDay(today) ? u.streak + 1 : 1;
    u.last = today; u.total += 1;
    const before = u.best;
    u.best = Math.max(u.best, u.streak);
    const unlocked = GM_BADGES.filter((b) => before < b.days && u.best >= b.days);
    let legendNow = false;
    if (u.streak >= 30 && !u.legend) legendNow = u.legend = await giveLegend(msg.chat.id, msg.from.id);
    await file.save();
    const who = esc(u.name);
    if (unlocked.length) {
      const b = unlocked[unlocked.length - 1];
      return [`🏅 <b>${who} unlocked ${b.emoji} ${b.name}!</b>`, `${u.streak} days of GM in a row 🔥`, legendNow ? `👑 New title in the group: <b>${LEGEND_TITLE}</b>` : null].filter(Boolean).join('\n');
    }
    if (lost) return `☀️ GM ${who} · streak reset (was ${lost} days) 😅 Day 1 again.`;
    const next = GM_BADGES.find((b) => u.streak < b.days);
    return `☀️ GM ${who} · 🔥 ${u.streak}-day streak${badgeLine(u) ? ' ' + badgeLine(u) : ''}${next ? ` · ${next.days - u.streak} to ${next.emoji}` : ''}`;
  }

  async function board(chatId, n = 10) {
    const d = await file.load();
    const today = madridDay(now()); const y = prevDay(today);
    const rows = Object.values(d.users)
      .filter((u) => String(u.chatId) === String(chatId))
      .map((u) => ({ ...u, live: u.last === today || u.last === y ? u.streak : 0 }))
      .filter((u) => u.live > 0 || u.best >= 7)
      .sort((a, b) => b.live - a.live || b.best - a.best || b.total - a.total)
      .slice(0, n);
    if (!rows.length) return '☀️ <b>GM streaks</b>\n\nNo streaks yet. Say gm every day to start one!';
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return ['☀️ <b>GM streaks</b>', '', ...rows.map((u, i) => `${medal(i)} ${esc(u.name)} · 🔥 <b>${u.live}</b> days${badgeLine(u) ? ' ' + badgeLine(u) : ''}`), '', 'Say gm once a day. 7 days 🥉 · 14 days 🥈 · 30 days 🥇 + GM Legend title.'].join('\n');
  }

  async function me(msg) {
    const d = await file.load();
    const u = d.users[`${msg.chat.id}:${msg.from.id}`];
    if (!u) return `☀️ ${esc(nameOf(msg.from))}, you have no GM streak yet. Say gm to start!`;
    const today = madridDay(now());
    const live = u.last === today || u.last === prevDay(today) ? u.streak : 0;
    const next = GM_BADGES.find((b) => live < b.days);
    return [
      `☀️ <b>${esc(u.name)}</b>`,
      '',
      `🔥 Current streak: <b>${live}</b> day${live === 1 ? '' : 's'}${u.last === today ? '' : live ? ' (say gm today to keep it!)' : ''}`,
      `🏆 Best streak: ${u.best} days`,
      `📅 Total GMs: ${u.total}`,
      `🏅 Badges: ${badgesOf(u).map((b) => `${b.emoji} ${b.name}`).join(', ') || 'none yet'}`,
      u.legend ? `👑 ${LEGEND_TITLE}` : null,
      next ? `\nNext: ${next.emoji} ${next.name} in ${next.days - live} day${next.days - live === 1 ? '' : 's'}` : null,
    ].filter((l) => l != null).join('\n');
  }

  /** Handle a group message. Returns true when it was handled. */
  async function handleMessage(msg, cmd) {
    if (!msg?.from || msg.from.is_bot || !['group', 'supergroup'].includes(msg.chat?.type)) return false;
    if (cmd?.name === 'streaks' || cmd?.name === 'gmtop') { await reply(msg, await board(msg.chat.id)); return true; }
    if (cmd?.name === 'me' || cmd?.name === 'streak') { await reply(msg, await me(msg)); return true; }
    if (!cmd && isGm(msg.text)) { const t = await record(msg); if (t) await reply(msg, t); return true; }
    return false;
  }

  return { record, board, me, handleMessage };
}
