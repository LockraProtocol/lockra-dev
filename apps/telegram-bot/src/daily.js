// Daily Prediction: one question a day in the group. It rotates between crypto (up or down) and
// sports (football, tennis, basketball: who wins), falling back to crypto when no big match is on.
//
//   10:00 Madrid   the bot asks "Will ETH be higher or lower tomorrow at 10:00?" with two buttons.
//   +5 hours       voting closes. Every vote is sealed in a LOCKRA capsule that opens at the result,
//                  so the votes are public and provable but nobody can read them early.
//   +24 hours      the bot checks the price, opens the capsule and scores everyone.
//
// Correct calls climb a rank ladder (Rookie → LOCKRA Legend). At LOCKRA Legend a player can
// /prestige: back to Rookie with a permanent star, like a prestige in a shooter.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const RANKS = [
  { wins: 1, id: 'rookie', name: 'Rookie', emoji: '🌱' },
  { wins: 3, id: 'seer', name: 'Seer', emoji: '👁️' },
  { wins: 7, id: 'oracle', name: 'Oracle', emoji: '🔮' },
  { wins: 15, id: 'prophet', name: 'Prophet', emoji: '⚡' },
  { wins: 25, id: 'visionary', name: 'Visionary', emoji: '💎' },
  { wins: 40, id: 'timekeeper', name: 'Timekeeper', emoji: '⏳' },
  { wins: 60, id: 'legend', name: 'LOCKRA Legend', emoji: '👑' },
];
export const PRESTIGE = ['', '⭐', '⭐⭐', '🌟', '🔱'];
export const MAX_PRESTIGE = PRESTIGE.length - 1;
/** Short rank names that fit Telegram's 16-character admin title. */
const TITLE_NAME = { legend: 'Legend' };

/** The title shown next to a member's name in the group, e.g. "⭐ 🔮 Oracle". */
export function rankTitle(u) {
  const r = [...RANKS].reverse().find((x) => (u?.wins || 0) >= x.wins);
  if (!r) return '';
  const stars = PRESTIGE[u.prestige || 0];
  const full = `${stars ? `${stars} ` : ''}${r.emoji} ${TITLE_NAME[r.id] || r.name}`;
  return [...full].length <= 16 ? full : `${r.emoji} ${TITLE_NAME[r.id] || r.name}`;
}
export const BADGES = {
  sniper: { emoji: '🎯', name: 'Sniper', rule: '5 correct calls in a row' },
  fire: { emoji: '🔥', name: 'On Fire', rule: '10 correct calls in a row' },
  ice: { emoji: '🧊', name: 'Ice Cold', rule: 'right when at least 80% of the group was wrong' },
  devotee: { emoji: '📅', name: 'Daily Devotee', rule: 'voted 30 days in a row' },
};
export const ASSETS = [
  { id: 'ETH', label: 'ETH' },
  { id: 'BTC', label: 'BTC' },
  { id: 'LOCKRA', label: '$LOCKRA market cap' },
];

/** Rank for a number of wins (null before the first win). */
export const rankFor = (wins) => [...RANKS].reverse().find((r) => wins >= r.wins) || null;

/** Midnight-based helpers in Madrid time. */
const madrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function madridParts(ms) {
  const p = Object.fromEntries(madrid.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
const prevDay = (day) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

export function dailyFile(path) {
  let data = null; let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || !data.rounds || !data.users) data = { rounds: {}, users: {} };
      return data;
    },
    save() {
      chain = chain.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); });
      return chain;
    },
  };
}
export function memoryDailyFile() { const d = { rounds: {}, users: {} }; return { load: async () => d, save: async () => {} }; }

const fmtPrice = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);

/**
 * @param {{ file: object, call: Function, chats: string[], price: (asset: string) => Promise<number|null>,
 *   seal?: (text: string, unlockAt: Date) => Promise<string>, now?: () => number, log?: Function,
 *   openHour?: number, voteHours?: number, site?: string, newId?: () => string }} o
 */
export function createDaily(o) {
  const { file, call, chats, price } = o;
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const openHour = o.openHour ?? 10;
  const voteMs = (o.voteHours ?? 5) * HOUR;
  const site = o.site || 'https://lockra.buzz';
  const newId = o.newId || (() => randomBytes(4).toString('hex'));
  const nameOf = (f) => (f.username ? `@${f.username}` : [f.first_name, f.last_name].filter(Boolean).join(' ') || 'anon');
  const send = (chat, text, extra = {}) => call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  const PRICE_OPTS = [{ k: 'u', label: '⬆️ Higher' }, { k: 'd', label: '⬇️ Lower' }];
  const optsOf = (r) => r.options || PRICE_OPTS;
  const labelOf = (r, k) => (optsOf(r).find((x) => x.k === k) || {}).label || k;
  const keyboard = (r) => r.closed
    ? { inline_keyboard: [[{ text: `🔒 Votes sealed · ${Object.keys(r.votes).length}`, callback_data: `dp:${r.id}:x` }]] }
    : { inline_keyboard: [optsOf(r).map((x) => ({ text: x.label, callback_data: `dp:${r.id}:${x.k}` })), [{ text: `🗳 ${Object.keys(r.votes).length} sealed votes`, callback_data: `dp:${r.id}:x` }]] };
  const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

  /** Today's topic: rotates through crypto and sports; falls back to crypto when no good match exists. */
  const TOPICS = ['crypto', 'football', 'tennis', 'football', 'basketball', 'crypto', 'football'];
  async function sportsRound(sport, t, day) {
    if (!o.sports) return null;
    const utcDay = new Date(t).toISOString().slice(0, 10);
    const m = await o.sports.pick(sport, utcDay, t + 90 * 60_000).catch((e) => { log(`daily sports ${sport}: ${e.message}`); return null; });
    if (!m) return null;
    const short = (n) => String(n).length > 18 ? String(n).slice(0, 17) + '…' : n;
    const options = m.draw
      ? [{ k: 'h', label: short(m.home) }, { k: 'e', label: 'Draw' }, { k: 'a', label: short(m.away) }]
      : [{ k: 'h', label: short(m.home) }, { k: 'a', label: short(m.away) }];
    return {
      kind: 'match', sport, event: m.id, label: `${m.home} vs ${m.away}`, league: m.league, emoji: m.emoji, options,
      startsAt: m.startsAt, closesAt: Math.min(t + voteMs, m.startsAt - 5 * 60_000), resolvesAt: m.startsAt + 2 * HOUR, giveUpAt: m.startsAt + 2 * DAY,
      question: `${m.emoji} <b>${esc(m.home)} vs ${esc(m.away)}</b>${m.league ? ` · ${esc(m.league)}` : ''}\nKick-off ${hhmm(m.startsAt)} CET. Who wins?`,
    };
  }

  const user = (d, from) => {
    const u = d.users[from.id] || (d.users[from.id] = { id: from.id, name: '', wins: 0, total: 0, prestige: 0, streak: 0, best: 0, voteStreak: 0, lastVoteDay: null, badges: [] });
    u.name = nameOf(from);
    return u;
  };
  const tag = (u) => {
    const r = rankFor(u.wins);
    return `${PRESTIGE[u.prestige] ? PRESTIGE[u.prestige] + ' ' : ''}${r ? `${r.emoji} ${r.name}` : 'Unranked'}`;
  };

  /** Open today's round if it is time and none exists yet. */
  async function openRound() {
    const d = await file.load();
    const t = now(); const p = madridParts(t);
    if (p.hour < openHour || Object.values(d.rounds).some((r) => r.day === p.day)) return null;
    const dayIndex = Math.floor(Date.parse(`${p.day}T00:00:00Z`) / DAY);
    const topic = o.topic ? o.topic(dayIndex) : TOPICS[dayIndex % TOPICS.length];
    let spec = topic === 'crypto' ? null : await sportsRound(topic, t, p.day);
    if (!spec) {
      const asset = ASSETS[Math.floor(dayIndex / TOPICS.length + dayIndex) % ASSETS.length];
      const start = await price(asset.id).catch(() => null);
      if (!(start > 0)) { log(`daily: no price for ${asset.id}`); return null; }
      spec = { kind: 'price', asset: asset.id, label: asset.label, start, closesAt: t + voteMs, resolvesAt: t + DAY,
        question: `Will <b>${asset.label}</b> be higher or lower than <b>${fmtPrice(start)}</b> tomorrow at ${String(openHour).padStart(2, '0')}:00 CET?` };
    }
    const r = { id: newId(), day: p.day, openedAt: t, votes: {}, closed: false, resolved: false, messages: {}, capsule: null, ...spec };
    d.rounds[r.id] = r;
    await file.save();
    for (const chat of chats) {
      const text = [
        '🔮 <b>Daily Prediction</b>',
        '',
        r.question,
        '',
        `🔒 Votes are sealed: nobody sees what anyone picked until the result. Voting closes at ${hhmm(r.closesAt)} CET.`,
        '🏅 Correct calls climb the ranks. /ranks · /rank',
      ].join('\n');
      const m = await send(chat, text, { reply_markup: keyboard(r) }).catch((e) => log(`daily send failed: ${e.message}`));
      if (m?.message_id) r.messages[chat] = m.message_id;
    }
    await file.save();
    return r;
  }

  async function handleCallback(q) {
    const m = /^dp:([0-9a-z]+):([a-z])$/.exec(q?.data || '');
    if (!m) return false;
    const answer = (text) => call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    const d = await file.load();
    const r = d.rounds[m[1]];
    if (!r) { await answer('This prediction is no longer available.'); return true; }
    if (m[2] === 'x') { await answer(r.closed ? 'Voting is closed. Votes open with the result.' : 'Votes stay sealed until the result 🔒'); return true; }
    if (r.closed || now() >= r.closesAt) { await answer('Voting is closed for today. Next one tomorrow at 10:00 CET!'); return true; }
    if (!optsOf(r).some((x) => x.k === m[2])) { await answer('That option is not available.'); return true; }
    const u = user(d, q.from);
    const pick = m[2];
    const before = r.votes[q.from.id];
    r.votes[q.from.id] = pick;
    if (!before) {
      u.voteStreak = u.lastVoteDay === prevDay(r.day) ? u.voteStreak + 1 : 1;
      u.lastVoteDay = r.day;
      if (u.voteStreak >= 30 && !u.badges.includes('devotee')) u.badges.push('devotee');
    }
    await file.save();
    await answer(`${before ? 'Changed' : 'Sealed'}: ${labelOf(r, pick)} 🔒`);
    for (const [chat, mid] of Object.entries(r.messages)) call('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: keyboard(r) }).catch(() => {});
    return true;
  }

  /** Close voting and seal the votes in a LOCKRA capsule that opens with the result. */
  async function closeRound(r) {
    r.closed = true;
    const list = Object.entries(r.votes).map(([id, v]) => `${id}:${v}`).sort().join(',');
    if (o.seal && list) {
      try { r.capsule = await o.seal(`LOCKRA Daily Prediction ${r.day} · ${r.label}${r.start ? ` from ${r.start}` : ''} · votes ${list}`, new Date(r.resolvesAt)); } catch (e) { log(`daily seal failed: ${e.message}`); }
    }
    for (const [chat, mid] of Object.entries(r.messages)) call('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: keyboard(r) }).catch(() => {});
    if (r.capsule) for (const chat of chats) await send(chat, `🔒 <b>Today's ${esc(r.label)} prediction is closed.</b> ${Object.keys(r.votes).length} votes are sealed in a LOCKRA capsule that opens with the result.`, { reply_markup: { inline_keyboard: [[{ text: 'See the sealed votes', url: r.capsule }]] } }).catch(() => {});
  }

  /** Score the round. Returns rank-ups so the caller can celebrate them. */
  async function resolveRound(d, r) {
    let outcome, line;
    if (r.kind === 'match') {
      const res = await o.sports?.result(r.event).catch(() => null);
      if (!res) {
        if (now() < r.giveUpAt) { r.resolvesAt = now() + 30 * 60_000; return false; } // not finished yet: check again later
        outcome = null; line = `${r.emoji} ${esc(r.label)}: no result found, round void.`;
      } else {
        outcome = res.outcome; r.score = res.score;
        line = `${r.emoji} ${esc(r.label)} · <b>${res.score}</b> · ${outcome === 'e' ? 'Draw' : `${esc(labelOf(r, outcome))} win`}`;
      }
    } else {
      const end = await price(r.asset).catch(() => null);
      if (!(end > 0)) return false;
      r.end = end;
      outcome = end > r.start ? 'u' : end < r.start ? 'd' : null;
      line = `${esc(r.label)}: ${fmtPrice(r.start)} → <b>${fmtPrice(end)}</b> · ${outcome === 'u' ? '⬆️ HIGHER' : outcome === 'd' ? '⬇️ LOWER' : '➡️ FLAT'}`;
    }
    r.resolved = true;
    r.outcome = outcome;
    const voters = Object.entries(r.votes);
    const winners = outcome ? voters.filter(([, v]) => v === outcome).map(([id]) => id) : [];
    const wrongShare = voters.length ? (voters.length - winners.length) / voters.length : 0;
    const ups = [];
    for (const [id, v] of voters) {
      const u = d.users[id]; if (!u) continue;
      if (!outcome) continue; // flat price: nobody scores, nobody loses a streak
      u.total += 1;
      if (v === outcome) {
        const was = rankFor(u.wins);
        u.wins += 1; u.streak += 1; u.best = Math.max(u.best, u.streak);
        const got = [];
        if (u.streak >= 5 && !u.badges.includes('sniper')) { u.badges.push('sniper'); got.push('sniper'); }
        if (u.streak >= 10 && !u.badges.includes('fire')) { u.badges.push('fire'); got.push('fire'); }
        if (voters.length >= 5 && wrongShare >= 0.8 && !u.badges.includes('ice')) { u.badges.push('ice'); got.push('ice'); }
        const is = rankFor(u.wins);
        if (is && is !== was) ups.push({ u, rank: is });
        for (const b of got) ups.push({ u, badge: b });
      } else {
        u.streak = 0;
      }
    }
    await file.save();
    const text = [
      '🔓 <b>Daily Prediction result</b>',
      '',
      line,
      voters.length ? `✅ ${winners.length} called it · ❌ ${voters.length - winners.length} missed` : 'Nobody voted this time.',
      outcome ? '' : 'No points this round.',
      'New question today at 10:00 CET 👀',
    ].filter((l) => l !== '').join('\n');
    const buttons = r.capsule ? { reply_markup: { inline_keyboard: [[{ text: '🔓 Verify the sealed votes', url: r.capsule }]] } } : {};
    for (const chat of chats) await send(chat, text, buttons).catch(() => {});
    for (const up of ups) await celebrate(up).catch((e) => log(`daily celebrate failed: ${e.message}`));
    return true;
  }

  /**
   * Show the rank next to the member's name. Telegram only allows that for admins, so the bot makes them an admin
   * with no permissions at all and sets the title. Real admins and the owner are left untouched.
   */
  async function giveTitle(chat, u) {
    const title = rankTitle(u);
    if (!title) return false;
    try {
      const m = await call('getChatMember', { chat_id: chat, user_id: u.id });
      if (m?.status === 'creator') return false;
      if (m?.status === 'administrator' && !m.can_be_edited) return false; // promoted by a person: not ours to touch
      if (m?.status === 'administrator' && (m.can_delete_messages || m.can_restrict_members || m.can_pin_messages || m.can_promote_members || m.can_change_info || m.can_invite_users || m.can_manage_chat)) return false;
      if (m?.status !== 'administrator') {
        await call('promoteChatMember', { chat_id: chat, user_id: u.id, is_anonymous: false, can_manage_chat: false, can_delete_messages: false, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_post_stories: false, can_edit_stories: false, can_delete_stories: false });
      }
      await call('setChatAdministratorCustomTitle', { chat_id: chat, user_id: u.id, custom_title: title });
      return true;
    } catch (e) { log(`daily title failed: ${e?.message ?? e}`); return false; }
  }

  async function celebrate({ u, rank, badge }) {
    if (rank) for (const chat of chats) await giveTitle(chat, u);
    for (const chat of chats) {
      if (rank) {
        await call('sendPhoto', {
          chat_id: chat,
          photo: `${site}/img/ranks/${rank.id}.jpg`,
          caption: `🏅 <b>${esc(u.name)}</b> reached ${rank.emoji} <b>${rank.name}</b> with ${u.wins} correct call${u.wins === 1 ? '' : 's'}!${rank.id === 'legend' && u.prestige < MAX_PRESTIGE ? '\n\nType /prestige to start over with a permanent star ⭐' : ''}`,
          parse_mode: 'HTML',
        }).catch((e) => log(`daily photo failed: ${e.message}`));
      } else if (badge) {
        const b = BADGES[badge];
        await send(chat, `${b.emoji} <b>${esc(u.name)}</b> unlocked <b>${b.name}</b>: ${b.rule}!`).catch(() => {});
      }
    }
  }

  /** Run whatever is due. Safe to call often. */
  async function tick() {
    await openRound();
    const d = await file.load();
    for (const r of Object.values(d.rounds)) {
      if (!r.closed && now() >= r.closesAt) { await closeRound(r); await file.save(); }
      if (r.closed && !r.resolved && now() >= r.resolvesAt) { await resolveRound(d, r); await file.save(); }
    }
    for (const [id, r] of Object.entries(d.rounds)) if (r.resolved && now() - r.resolvesAt > 7 * DAY) delete d.rounds[id];
    await file.save();
  }

  async function run({ signal, every = 30_000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`daily tick failed: ${e?.message ?? e}`));
      await new Promise((res) => { const t = setTimeout(res, every); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    }
  }

  async function profile(from) {
    const d = await file.load();
    const u = d.users[from.id];
    if (!u || !u.total && !Object.values(d.rounds).some((r) => r.votes[from.id])) return `🔮 ${esc(nameOf(from))}, you haven't made a Daily Prediction yet. Next one at 10:00 CET!`;
    const r = rankFor(u.wins);
    const next = RANKS.find((x) => x.wins > u.wins);
    return [
      `🔮 <b>${esc(u.name)}</b>`,
      `${tag(u)}${u.badges.length ? ' · ' + u.badges.map((b) => BADGES[b].emoji).join('') : ''}`,
      '',
      `✅ ${u.wins} correct · ${u.total ? Math.round((u.wins / u.total) * 100) : 0}% hit rate`,
      `🔥 ${u.streak} in a row (best ${u.best})`,
      next ? `Next: ${next.emoji} ${next.name} at ${next.wins} wins` : r && u.prestige < MAX_PRESTIGE ? 'Max rank reached. /prestige to start over with a star ⭐' : '🔱 Master Prestige. Absolute legend.',
    ].join('\n');
  }

  async function board(n = 10) {
    const d = await file.load();
    const rows = Object.values(d.users).filter((u) => u.total > 0)
      .sort((a, b) => b.prestige - a.prestige || b.wins - a.wins || b.wins / b.total - a.wins / a.total).slice(0, n);
    if (!rows.length) return '🔮 <b>Prediction ranks</b>\n\nNo calls scored yet. The Daily Prediction goes live every day at 10:00 CET.';
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return ['🔮 <b>Prediction ranks</b>', '', ...rows.map((u, i) => `${medal(i)} ${esc(u.name)} · ${tag(u)} · <b>${u.wins}</b> wins`), '', RANKS.map((x) => `${x.emoji} ${x.wins}`).join(' · ')].join('\n');
  }

  /** Admin command: give every ranked member the title for the rank they already have. */
  async function syncTitles(msg) {
    try {
      const me = await call('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id });
      if (!['creator', 'administrator'].includes(me?.status) || (me.status === 'administrator' && !me.can_promote_members)) return 'Only group admins can do that.';
    } catch { return 'Only group admins can do that.'; }
    const d = await file.load();
    let n = 0;
    for (const u of Object.values(d.users)) if (rankTitle(u) && await giveTitle(msg.chat.id, u)) n += 1;
    return n ? `🏅 Updated ${n} rank title${n === 1 ? '' : 's'}.` : 'No titles to update.';
  }

  async function prestige(from) {
    const d = await file.load();
    const u = d.users[from.id];
    if (!u || u.wins < RANKS.at(-1).wins) return `👑 You need ${RANKS.at(-1).wins} correct calls (LOCKRA Legend) to prestige.`;
    if (u.prestige >= MAX_PRESTIGE) return '🔱 You are already at Master Prestige.';
    u.prestige += 1; u.wins = 0; u.streak = 0;
    await file.save();
    for (const chat of chats) await giveTitle(chat, { ...u, wins: RANKS[0].wins });
    return `${PRESTIGE[u.prestige]} <b>${esc(u.name)}</b> entered Prestige ${u.prestige}! Back to 🌱 Rookie, star kept forever.`;
  }

  /** Handle /daily, /rank, /ranks, /prestige. Returns true when handled. */
  async function handleMessage(msg, cmd) {
    if (!cmd || !msg?.from) return false;
    const reply = (text) => call('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    if (cmd.name === 'rank') { await reply(await profile(msg.from)); return true; }
    if (cmd.name === 'ranks') { await reply(await board()); return true; }
    if (cmd.name === 'prestige') { await reply(await prestige(msg.from)); return true; }
    if (cmd.name === 'titles') { await reply(await syncTitles(msg)); return true; }
    if (cmd.name === 'daily') {
      const d = await file.load();
      const r = Object.values(d.rounds).filter((x) => !x.resolved).sort((a, b) => b.openedAt - a.openedAt)[0];
      await reply(r ? (r.closed ? `🔒 Today's prediction (${esc(r.label)}) is closed. Result after ${r.kind === 'match' ? 'the final whistle' : '10:00 CET tomorrow'}.` : `🔮 Today's question:\n${r.question}\n\nVote on the message above 👆 (closes ${hhmm(r.closesAt)} CET)`) : '🔮 The Daily Prediction goes live every day at 10:00 CET.');
      return true;
    }
    return false;
  }

  return { tick, run, handleCallback, handleMessage, profile, board, prestige, openRound };
}

/** ETH and BTC from CoinGecko, $LOCKRA market cap from DexScreener (up/down is the same either way). */
export function createDailyPrice({ fetchFn = globalThis.fetch, lookup, token }) {
  return async (asset) => {
    if (asset === 'LOCKRA') return (await lookup(token))?.marketCap ?? null;
    const id = asset === 'BTC' ? 'bitcoin' : 'ethereum';
    const r = await fetchFn(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return Number(j?.[id]?.usd) || null;
  };
}
