// LOCKRA KOLs: sealed calls with a public, uneditable track record.
//
// A verified KOL seals a call in a private chat with the bot: a token, a market cap target and a
// deadline. The call is sealed with drand timelock encryption, so nobody (followers, other KOLs,
// LOCKRA) can read it before the deadline. The bot announces "new sealed call" in the KOL's own
// channel and in the LOCKRA group. At the deadline drand opens the capsule, the bot checks the live
// market cap and scores the call: a hit if the market cap is at or above the target. Every call
// counts, misses included, and nothing can be deleted.
//
// The server never stores the token or target of an open call: only the capsule link. It learns
// them when drand opens the capsule, like everyone else.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal as sdkSeal, open as sdkOpen } from 'lockra-sdk';
import { parseWhen, humanDuration, formatDate } from './parse.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DAY = 86_400_000;

export const TIERS = [
  { id: 'gold', min: 5_000_000, name: 'Holder Gold' },
  { id: 'silver', min: 1_000_000, name: 'Holder Silver' },
  { id: 'bronze', min: 250_000, name: 'Holder Bronze' },
];
export const LIMITS = { openCalls: 5, callsPerDay: 3, minHours: 1, maxDays: 90 };

/** "5M", "$500k", "1.2b", "250000" -> number of USD. */
export function parseAmount(s) {
  const m = /^\$?(\d+(?:[.,]\d+)?)\s*([kmb])?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.')) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export const fmtUsd = (n) => (n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
/** Harder calls are worth more: 10 points for a target at the current market cap, +10 per doubling, max 100. */
export const pointsFor = (startMc, target) => Math.min(100, Math.round(10 * (1 + Math.log2(Math.max(1, target / startMc)))));
export const seasonOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const seasonLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const seasonEnd = (key) => { const d = new Date(`${key}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };

const empty = () => ({ kols: {}, calls: {}, crowns: {}, codes: {} });

export function kolsFile(path) {
  let data = null;
  let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || !data.kols) data = empty();
      for (const k of Object.keys(empty())) data[k] ||= {};
      return data;
    },
    save() {
      chain = chain.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(data));
        await rename(`${path}.tmp`, path);
      }).catch(() => {});
      return chain;
    },
  };
}
export function memoryKolsFile() { const d = empty(); return { load: async () => d, save: async () => {} }; }

/** Token lookup on DexScreener: { symbol, marketCap, url } for the most liquid pair, or null. */
export function dexLookup(fetchFn = globalThis.fetch) {
  return async (address) => {
    const r = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => String(p.baseToken?.address).toLowerCase() === address.toLowerCase());
    if (!pairs.length) return null;
    const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const mc = Number(p.marketCap || p.fdv);
    return mc > 0 ? { symbol: p.baseToken.symbol, marketCap: mc, url: p.url, chain: p.chainId } : null;
  };
}

/**
 * @param {{ file: object, call: Function, now?: () => number, lookup: Function, balanceOf?: Function,
 *   admins?: string[], groups?: string[], site?: string, sdkOptions?: object, log?: Function,
 *   seal?: Function, open?: Function, newId?: () => string }} o
 */
export function createKols(o) {
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const site = o.site || 'https://lockra.buzz/kols';
  const admins = new Set((o.admins || []).map(String));
  const groups = o.groups || [];
  const seal = o.seal || sdkSeal;
  const open = o.open || sdkOpen;
  const newId = o.newId || (() => randomBytes(5).toString('hex'));
  const send = (chat_id, text, extra = {}) => o.call('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const profile = (k) => `${site}#${encodeURIComponent((k.x || k.id).toLowerCase())}`;
  const nameOf = (k) => (k.x ? `@${k.x}` : k.name || 'KOL');

  // ---------- stats & badges ----------
  function statsOf(d, kolId, season = null) {
    const calls = Object.values(d.calls).filter((c) => c.kolId === kolId).sort((a, b) => a.opensAt - b.opensAt);
    const done = calls.filter((c) => c.status === 'hit' || c.status === 'miss');
    const inSeason = season ? done.filter((c) => seasonOf(c.opensAt) === season) : done;
    let streak = 0;
    for (let i = done.length - 1; i >= 0 && done[i].status === 'hit'; i--) streak++;
    const hits = inSeason.filter((c) => c.status === 'hit').length;
    return {
      points: inSeason.reduce((a, c) => a + (c.points || 0), 0),
      hits,
      misses: inSeason.length - hits,
      allHits: done.filter((c) => c.status === 'hit').length,
      allResolved: done.length,
      streak,
      open: calls.filter((c) => c.status === 'sealed'),
      history: done.slice().reverse(),
    };
  }
  function badgesOf(d, k) {
    const s = statsOf(d, k.id);
    const b = [];
    if (k.status === 'verified') b.push('verified');
    const tier = TIERS.find((t) => (k.balance || 0) >= t.min);
    if (tier) b.push(tier.id);
    if (s.allResolved >= 10 && s.allHits / s.allResolved >= 0.7) b.push('sniper');
    if (s.streak >= 5) b.push('fire');
    if (k.verifiedAt && now() - k.verifiedAt >= 30 * DAY && (k.balance || 0) >= TIERS[2].min && !k.soldDown) b.push('diamond');
    if (Object.values(d.crowns).some((c) => c.kolId === k.id)) b.push('crown');
    return b;
  }
  function ranking(d, season) {
    return Object.values(d.kols)
      .filter((k) => k.status === 'verified')
      .map((k) => ({ k, s: statsOf(d, k.id, season) }))
      .sort((a, b) => b.s.points - a.s.points || b.s.hits - a.s.hits || a.s.misses - b.s.misses || String(a.k.x).localeCompare(String(b.k.x)));
  }

  // ---------- public data for lockra.buzz/kols ----------
  async function publicView() {
    const d = await o.file.load();
    const season = seasonOf(now());
    const prev = Object.keys(d.crowns).sort().pop();
    const crown = prev && d.kols[d.crowns[prev].kolId];
    const rows = ranking(d, season);
    const view = (k, i) => {
      const s = statsOf(d, k.id, season);
      return {
        rank: i + 1,
        handle: k.x || '',
        name: k.name || '',
        channel: k.channelUsername ? { title: k.channelTitle || '', url: `https://t.me/${k.channelUsername}` } : null,
        joinedAt: k.verifiedAt || k.joinedAt,
        badges: badgesOf(d, k),
        season: { points: s.points, hits: s.hits, misses: s.misses },
        total: { hits: s.allHits, resolved: s.allResolved, streak: s.streak },
        open: s.open.map((c) => ({ sealedAt: c.sealedAt, opensAt: c.opensAt, link: c.link })),
        history: s.history.slice(0, 25).map((c) => ({ symbol: c.symbol, token: c.token, chain: c.chain, target: c.target, startMc: c.sealMc, finalMc: c.finalMc, result: c.status, points: c.points || 0, sealedAt: c.sealedAt, opensAt: c.opensAt, link: c.link })),
      };
    };
    return {
      updatedAt: now(),
      season: { key: season, label: seasonLabel(season), endsAt: seasonEnd(season) },
      kolOfTheMonth: crown ? { handle: crown.x || '', season: seasonLabel(prev), points: d.crowns[prev].points } : null,
      kols: rows.map((r, i) => view(r.k, i)),
    };
  }

  // ---------- Telegram ----------
  const HOW = [
    '🏆 <b>LOCKRA KOLs</b>',
    'Seal your calls. Build a track record nobody can fake.',
    '',
    '<b>1. Apply</b>',
    '<code>/kol join @your_x 0xYourWallet</code>',
    'The team verifies you. Your wallet\'s $LOCKRA sets your holder badge.',
    '',
    '<b>2. Link your channel</b> (optional)',
    'Add me to your Telegram channel as admin, then send <code>/kol channel</code> here.',
    '',
    '<b>3. Seal calls</b> here, in private:',
    '<code>/call 0xTokenAddress 5M 7d</code>',
    'Token, market cap target, deadline. I announce it sealed in your channel and in the LOCKRA group, and reveal it at the deadline.',
    '',
    'Hit = market cap at or above the target when the call opens. Bigger targets earn more points. Every call counts.',
    `Ranking and badges: ${site}`,
  ].join('\n');

  async function onKol(msg, args) {
    if (msg.chat.type !== 'private') return send(msg.chat.id, `🏆 LOCKRA KOLs: sealed calls, real track records.\n${site}`, { reply_markup: { inline_keyboard: [[{ text: 'Ranking', url: site }]] } });
    const d = await o.file.load();
    const id = String(msg.from.id);
    const k = d.kols[id];
    const [sub, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
    if (sub === 'join') {
      const x = (rest.find((a) => /^@?[A-Za-z0-9_]{1,15}$/.test(a) && !/^0x/i.test(a)) || '').replace(/^@/, '');
      const wallet = (rest.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) || '').toLowerCase();
      if (!x || !wallet) return send(msg.chat.id, 'Use: <code>/kol join @your_x 0xYourWallet</code>');
      if (Object.values(d.kols).some((o2) => o2.id !== id && String(o2.x).toLowerCase() === x.toLowerCase())) return send(msg.chat.id, 'That X account is already registered. Contact the LOCKRA team if it is yours.');
      d.kols[id] = { ...(k || {}), id, x, wallet, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').slice(0, 40), tg: msg.from.username || '', status: k?.status === 'verified' && k.x === x && k.wallet === wallet ? 'verified' : 'pending', joinedAt: k?.joinedAt || now() };
      await o.file.save();
      await refreshBalance(d.kols[id]);
      for (const a of admins) {
        await send(a, `🆕 <b>KOL application</b>\nX: <a href="https://x.com/${esc(x)}">@${esc(x)}</a>\nTelegram: ${msg.from.username ? '@' + esc(msg.from.username) : esc(d.kols[id].name)} (<code>${id}</code>)\nWallet: <code>${wallet}</code>\n$LOCKRA: ${Math.round(d.kols[id].balance || 0).toLocaleString('en')}`, {
          reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `kv:${id}:1` }, { text: 'Reject', callback_data: `kv:${id}:0` }]] },
        }).catch((e) => log(`admin notify failed: ${e.message}`));
      }
      return send(msg.chat.id, `✅ <b>Application received</b>\nThe LOCKRA team will check that @${esc(x)} is you and let you know here.\n\nTip: post about LOCKRA KOLs from @${esc(x)} so we can verify you faster.`);
    }
    if (sub === 'channel') {
      if (k?.status !== 'verified') return send(msg.chat.id, 'You can link a channel once you are verified.');
      const code = randomBytes(3).toString('hex').toUpperCase();
      d.codes[code] = { kolId: id, at: now() };
      await o.file.save();
      return send(msg.chat.id, `1. Add me to your channel as an admin (post and delete messages).\n2. Post this in the channel:\n\n<code>/link ${code}</code>\n\nI will delete it and confirm. The code expires in 1 hour.`);
    }
    if (!k) return send(msg.chat.id, HOW, { reply_markup: { inline_keyboard: [[{ text: 'See the ranking', url: site }]] } });
    const s = statsOf(d, id, seasonOf(now()));
    const tier = TIERS.find((t) => (k.balance || 0) >= t.min);
    return send(msg.chat.id, [
      `🏆 <b>${esc(nameOf(k))}</b> · ${k.status === 'verified' ? 'Verified' : 'Pending verification'}`,
      `Holder badge: ${tier ? tier.name : 'none yet'} (${Math.round(k.balance || 0).toLocaleString('en')} $LOCKRA)`,
      `Channel: ${k.channelUsername ? '@' + esc(k.channelUsername) : k.channel ? esc(k.channelTitle) : 'not linked'}`,
      '',
      `This season: <b>${s.points}</b> pts · ${s.hits} hits · ${s.misses} misses · ${s.open.length} open`,
      '',
      k.status === 'verified' ? 'Seal a call: <code>/call 0xToken 5M 7d</code>' : 'You can seal calls once you are verified.',
    ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: 'My profile', url: profile(k) }]] } });
  }

  async function onCall(msg, args) {
    if (msg.chat.type !== 'private') {
      await o.call('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
      return send(msg.chat.id, 'Calls are sealed in a private chat with me, so nobody sees them early 🔒');
    }
    const d = await o.file.load();
    const k = d.kols[String(msg.from.id)];
    if (k?.status !== 'verified') return send(msg.chat.id, k ? 'You can seal calls once the LOCKRA team verifies you.' : HOW);
    const [token, target, when] = (args || '').trim().split(/\s+/);
    const usage = 'Use: <code>/call 0xTokenAddress 5M 7d</code>\nToken contract, market cap target, deadline (1h to 90d, or a date like 2026-12-31).';
    if (!/^0x[0-9a-fA-F]{40}$/.test(token || '') || !target || !when) return send(msg.chat.id, usage);
    const goal = parseAmount(target);
    if (!goal) return send(msg.chat.id, `I did not understand the target "${esc(target)}". Use something like 500K, 5M or 1.2B.\n\n${usage}`);
    const parsed = parseWhen(when, now());
    if ('error' in parsed) return send(msg.chat.id, `${esc(parsed.error)}\n\n${usage}`);
    const secs = (parsed.date.getTime() - now()) / 1000;
    if (secs < LIMITS.minHours * 3600 || secs > LIMITS.maxDays * 86400) return send(msg.chat.id, `A call must stay sealed between ${LIMITS.minHours} hour and ${LIMITS.maxDays} days.`);
    const mine = Object.values(d.calls).filter((c) => c.kolId === k.id);
    if (mine.filter((c) => c.status === 'sealed').length >= LIMITS.openCalls) return send(msg.chat.id, `You already have ${LIMITS.openCalls} open calls. Wait for one to open.`);
    if (mine.filter((c) => now() - c.sealedAt < DAY).length >= LIMITS.callsPerDay) return send(msg.chat.id, `You can seal ${LIMITS.callsPerDay} calls per day.`);
    const info = await o.lookup(token).catch(() => null);
    if (!info) return send(msg.chat.id, 'I could not find that token on DexScreener. Check the contract address.');
    if (goal <= info.marketCap) return send(msg.chat.id, `${esc(info.symbol)} is already at ${fmtUsd(info.marketCap)}. A call needs a target above the current market cap.`);

    const by = nameOf(k);
    const capsule = await seal(JSON.stringify({ v: 1, token: token.toLowerCase(), chain: info.chain, target: goal, by }), { unlockAt: parsed.date, by, label: 'KOL call', ...(o.sdkOptions || {}) });
    // Only the market cap at sealing time is kept (for difficulty points), never the token or target.
    const call = { id: newId(), kolId: k.id, link: capsule.link, sealedAt: now(), opensAt: capsule.unlockAt.getTime(), sealMc: info.marketCap, status: 'sealed', posts: [] };
    d.calls[call.id] = call;
    await o.file.save();

    const left = humanDuration((call.opensAt - now()) / 1000);
    const text = [
      `🔒 <b>New sealed call by ${esc(by)}</b>`,
      '',
      `Opens ${esc(formatDate(new Date(call.opensAt)))} (in ${left}).`,
      'Token and target are sealed. Nobody can see them until then, not even LOCKRA.',
    ].join('\n');
    const kb = { inline_keyboard: [[{ text: `${by} on LOCKRA KOLs`, url: profile(k) }]] };
    for (const chat of [k.channel, ...groups].filter(Boolean)) {
      const sent = await send(chat, text, { reply_markup: kb }).catch((e) => { log(`call announce to ${chat} failed: ${e.message}`); return null; });
      if (sent?.message_id) call.posts.push({ chat, messageId: sent.message_id });
    }
    await o.file.save();
    return send(msg.chat.id, `🔒 <b>Call sealed</b>: ${esc(info.symbol)} to ${fmtUsd(goal)} (now ${fmtUsd(info.marketCap)}).\nOpens ${esc(formatDate(new Date(call.opensAt)))}. Worth <b>${pointsFor(info.marketCap, goal)}</b> points if it hits.\n\nAnnounced in ${call.posts.length} chat${call.posts.length === 1 ? '' : 's'}.`);
  }

  async function onKols(msg) {
    const v = await publicView();
    const rows = v.kols.slice(0, 10);
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const text = rows.length
      ? ['🏆 <b>LOCKRA KOLs</b> · ' + esc(v.season.label), '', ...rows.map((r, i) => `${medal(i)} @${esc(r.handle)} · <b>${r.season.points}</b> pts · ${r.season.hits}/${r.season.hits + r.season.misses} hits`), '', 'Sealed calls. Real track records.'].join('\n')
      : '🏆 <b>LOCKRA KOLs</b>\n\nNo calls scored yet this season. The first KOLs to seal calls take the top spots.';
    return send(msg.chat.id, text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, reply_markup: { inline_keyboard: [[{ text: 'Full ranking', url: site }, { text: 'Become a KOL', url: `https://t.me/${o.username || 'Lockra_bot'}?start=kol` }]] } });
  }

  /** Handle a command; returns true when it was a KOL command. */
  async function handleCommand(msg, cmd) {
    if (cmd.name === 'kol' || (cmd.name === 'start' && cmd.args === 'kol')) { await onKol(msg, cmd.name === 'kol' ? cmd.args : ''); return true; }
    if (cmd.name === 'call') { await onCall(msg, cmd.args); return true; }
    if (cmd.name === 'kols') { await onKols(msg); return true; }
    return false;
  }

  /** "/link CODE" posted in a channel by a verified KOL. */
  async function handleChannelPost(post) {
    const m = /^\/link(?:@\w+)?\s+([0-9A-F]{6})\b/i.exec(post.text || '');
    if (!m) return false;
    const d = await o.file.load();
    const c = d.codes[m[1].toUpperCase()];
    await o.call('deleteMessage', { chat_id: post.chat.id, message_id: post.message_id }).catch(() => {});
    if (!c || now() - c.at > 3_600_000 || !d.kols[c.kolId]) return true;
    const k = d.kols[c.kolId];
    Object.assign(k, { channel: post.chat.id, channelTitle: post.chat.title || '', channelUsername: post.chat.username || '' });
    delete d.codes[m[1].toUpperCase()];
    await o.file.save();
    await send(post.chat.id, `🏆 This channel is now on <b>LOCKRA KOLs</b>.\nSealed calls by ${esc(nameOf(k))} are announced here and revealed right on time.`, { reply_markup: { inline_keyboard: [[{ text: 'See the ranking', url: profile(k) }]] } }).catch(() => {});
    await send(k.id, `✅ Linked to ${esc(post.chat.title || 'your channel')}.`).catch(() => {});
    return true;
  }

  /** Admin approve / reject buttons. Returns true when handled. */
  async function handleCallback(q) {
    const m = /^kv:(\d+):([01])$/.exec(q.data || '');
    if (!m) return false;
    if (!admins.has(String(q.from.id))) { await o.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Only LOCKRA admins can do this.' }).catch(() => {}); return true; }
    const d = await o.file.load();
    const k = d.kols[m[1]];
    if (!k) { await o.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Application not found.' }).catch(() => {}); return true; }
    const ok = m[2] === '1';
    k.status = ok ? 'verified' : 'rejected';
    if (ok) k.verifiedAt ||= now();
    await o.file.save();
    await o.call('answerCallbackQuery', { callback_query_id: q.id, text: ok ? 'Approved' : 'Rejected' }).catch(() => {});
    if (q.message) await o.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: ok ? '✅ Approved' : '❌ Rejected', callback_data: 'kv:done' }]] } }).catch(() => {});
    await send(k.id, ok
      ? `🏆 <b>You are a verified LOCKRA KOL.</b>\n\nSeal your first call:\n<code>/call 0xTokenAddress 5M 7d</code>\n\nLink your channel with <code>/kol channel</code>.\nYour profile: ${profile(k)}`
      : 'Your LOCKRA KOLs application was not approved. You can contact the team in the LOCKRA group.').catch(() => {});
    return true;
  }

  // ---------- background: reveals, balances, seasons ----------
  async function refreshBalance(k) {
    if (!o.balanceOf || !k.wallet) return;
    const b = await o.balanceOf(k.wallet).catch(() => null);
    if (b == null) return;
    if (k.balance != null && b < (k.maxBalance || 0) * 0.99) k.soldDown = true;
    k.maxBalance = Math.max(k.maxBalance || 0, b);
    k.balance = b;
    k.balanceAt = now();
  }

  async function reveal(d, c) {
    let r;
    try { r = await open(c.link, o.sdkOptions || {}); } catch (e) { log(`call ${c.id} not opened yet: ${e.message}`); return; }
    if (r.status !== 'opened') return;
    let p;
    try { p = JSON.parse(r.message); } catch { c.status = 'void'; return; }
    const info = await o.lookup(p.token).catch(() => null);
    if (!info) { c.tries = (c.tries || 0) + 1; if (c.tries < 20) return; }
    Object.assign(c, { token: p.token, chain: p.chain, target: p.target, symbol: info?.symbol || '?', finalMc: info?.marketCap ?? 0, openedAt: now() });
    c.status = (info?.marketCap ?? 0) >= p.target ? 'hit' : 'miss';
    c.points = c.status === 'hit' ? pointsFor(c.sealMc || p.target, p.target) : 0;
    const k = d.kols[c.kolId];
    const text = c.status === 'hit'
      ? `✅ <b>${esc(nameOf(k))} called it</b>\n\n$${esc(c.symbol)} to ${fmtUsd(p.target)} market cap: now <b>${fmtUsd(c.finalMc)}</b>.\n+${c.points} points on LOCKRA KOLs 🏆`
      : `❌ <b>${esc(nameOf(k))} missed this one</b>\n\n$${esc(c.symbol)} to ${fmtUsd(p.target)} market cap: now ${fmtUsd(c.finalMc)}.\nEvery call counts. That is the point.`;
    for (const post of c.posts || []) {
      await send(post.chat, text, { reply_parameters: { message_id: post.messageId, allow_sending_without_reply: true }, reply_markup: { inline_keyboard: [[{ text: 'Track record', url: profile(k) }, { text: 'Verify capsule', url: c.link }]] } })
        .catch((e) => log(`call reveal to ${post.chat} failed: ${e.message}`));
    }
  }

  async function tick() {
    const d = await o.file.load();
    let changed = false;
    for (const c of Object.values(d.calls)) {
      if (c.status !== 'sealed' || c.opensAt > now()) continue;
      await reveal(d, c).catch((e) => log(`reveal ${c.id}: ${e.message}`));
      changed = true;
    }
    // Crown last month's winner once the month is over.
    const prev = seasonOf(new Date(new Date(`${seasonOf(now())}-01T00:00:00Z`).getTime() - 1).getTime());
    if (!d.crowns[prev]) {
      const top = ranking(d, prev)[0];
      if (top && top.s.points > 0) {
        d.crowns[prev] = { kolId: top.k.id, points: top.s.points };
        changed = true;
        for (const g of groups) await send(g, `👑 <b>KOL of the month: ${esc(nameOf(top.k))}</b>\n${esc(seasonLabel(prev))} · ${top.s.points} points · ${top.s.hits} hits\n\nA new season starts now.`, { reply_markup: { inline_keyboard: [[{ text: 'See the ranking', url: site }]] } }).catch(() => {});
      }
    }
    for (const k of Object.values(d.kols)) {
      if (k.status === 'verified' && (!k.balanceAt || now() - k.balanceAt > 6 * 3_600_000)) { await refreshBalance(k); changed = true; }
    }
    for (const [code, c] of Object.entries(d.codes)) if (now() - c.at > 3_600_000) { delete d.codes[code]; changed = true; }
    if (changed) await o.file.save();
  }

  async function run({ signal, intervalMs = 30_000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`kols: ${e.message}`));
      await new Promise((res) => { const t = setTimeout(res, intervalMs); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    }
  }

  return { handleCommand, handleChannelPost, handleCallback, publicView, tick, run, statsOf, badgesOf };
}
