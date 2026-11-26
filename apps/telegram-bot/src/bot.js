// LOCKRA Telegram bot logic. Transport-agnostic: give it a Telegram `call` function.
//
// Privacy rule: capsules are only sealed in private chats. In a group, the secret would be
// visible to everyone the moment it is typed, so the bot removes the command (when it is
// allowed to) and points the user to a private chat instead.

import { seal, open, inspect, LockraError } from 'lockra-sdk';
import { parseWhen, findCapsule, parseCommand, humanDuration, formatDate } from './parse.js';
import { voteKeyboard } from './scores.js';

export const MAX_MESSAGE = 1000;
export const SEALS_PER_HOUR = 10;
const MAX_SHOWN = 3500;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ABOUT = [
  '🔐 <b>What is LOCKRA?</b>',
  '',
  'LOCKRA is a timelock encryption protocol. You seal a message or file, pick a date, and nobody can open it before that moment: not you, not us, not anyone.',
  '',
  '⏳ <b>How it works:</b> your capsule is encrypted to a future round of drand, a public randomness beacon run by independent organisations. The key only exists once that round is published.',
  '',
  '🧰 <b>What we\'re building:</b> sealed predictions and calls, LOCKRA KOLs, provably fair raffles, collabs, an SDK for developers and this bot.',
  '',
  '🔥 <b>$LOCKRA:</b> launched on Fobo.fun. Burns power the raffles and every trade feeds the floor.',
  '',
  'No servers. No accounts. Just math.',
].join('\n');

export const COMMANDS = [
  { command: 'seal', description: 'Seal a message until a date (private chat)' },
  { command: 'open', description: 'Open a capsule or see how long is left' },
  { command: 'predict', description: 'Seal a prediction, revealed in the group later' },
  { command: 'leaderboard', description: 'Best prediction callers' },
  { command: 'kols', description: 'LOCKRA KOLs ranking: sealed calls, real track records' },
  { command: 'learn', description: 'What LOCKRA is and what we are building' },
  { command: 'rank', description: 'Your Daily Prediction rank and badges' },
  { command: 'ranks', description: 'Daily Prediction leaderboard' },
  { command: 'streaks', description: 'GM streaks ranking in the group' },
  { command: 'me', description: 'Your GM streak and badges' },
  { command: 'raffle', description: 'Current raffle: tickets, burns and countdown' },
  { command: 'lockra', description: '$LOCKRA price, market cap and burned' },
  { command: 'help', description: 'How LOCKRA works' },
];

const HELP = [
  '<b>LOCKRA</b> 🔒 The encrypted time capsule.',
  '',
  'Seal a message that <b>nobody can open before the date you choose</b>. Not you, not us, not anyone. The key comes from drand, a public beacon run by independent nodes worldwide.',
  '',
  '<b>Seal</b> (in a private chat with me):',
  '<code>/seal 30d BTC 150k by summer</code>',
  '<code>/seal 2027-01-01 Happy new year, future me</code>',
  'Times: <code>30m</code> <code>2h</code> <code>7d</code> <code>2w</code> <code>3mo</code> <code>1y</code> or a UTC date.',
  '',
  '<b>Open</b> (anywhere):',
  '<code>/open https://lockra.buzz/#c=…</code>',
  'or reply <code>/open</code> to a message that contains a capsule link.',
  'Still sealed? Tap 🔔 <b>Notify me when it opens</b> and I will message you the moment it unlocks.',
  '',
  '<b>Predict</b> (in a private chat with me):',
  '<code>/predict 7d $LOCKRA hits 300K market cap</code>',
  'I announce it in the group, sealed. When the time comes, I reveal it there. Nobody can read or change it before then.',
  'Then the group votes: called it or missed it. The best callers top /leaderboard 🏆',
  '',
  '<b>KOLs</b>: /kols for the ranking. KOLs apply with /kol in a private chat.',
  '',
  '<b>Daily Prediction</b>: every day at 10:00 CET: crypto up or down, or who wins a big football, tennis or basketball match. Votes are sealed. Correct calls climb the ranks: 🌱 Rookie (1) → 👁️ Seer (3) → 🔮 Oracle (7) → ⚡ Prophet (15) → 💎 Visionary (25) → ⏳ Timekeeper (40) → 👑 LOCKRA Legend (60), then /prestige. /rank · /ranks',
  '',
  '<b>GM streaks</b>: say gm in the group every day. 7 days 🥉, 14 days 🥈, 30 days 🥇 + GM Legend title. Every day counts, no resets. /streaks · /me',
  '',
  '<b>Arena</b>: /arena for rock, paper, scissors duels in $LOCKRA and the champions board.',
  '',
  '<b>Raffle</b>: /raffle for tickets and the countdown.',
  '',
  '<b>Community</b>: /lockra for price, market cap and burns.',
  '',
  '⚠️ Never seal seed phrases, private keys or passwords.',
].join('\n');

const SEAL_USAGE = [
  'Tell me <b>when</b> it opens and <b>what</b> to seal:',
  '',
  '<code>/seal 30d BTC 150k by summer</code>',
  '<code>/seal 2027-01-01 Happy new year, future me</code>',
  '',
  'Times: <code>30m</code> <code>2h</code> <code>7d</code> <code>2w</code> <code>3mo</code> <code>1y</code> or a UTC date like <code>2027-01-01</code>.',
].join('\n');

const PREDICT_USAGE = [
  '🔮 <b>Seal a prediction</b>. I announce it in the group, sealed, and reveal it there when the time comes.',
  '',
  '<code>/predict 7d $LOCKRA hits 300K market cap</code>',
  '<code>/predict 2026-12-31 BTC closes the year above 150k</code>',
  '',
  'Times: <code>1h</code> <code>1d</code> <code>7d</code> <code>2w</code> <code>3mo</code> or a UTC date. At least 1 hour, at most 1 year.',
].join('\n');

const ERRORS = {
  INVALID_CAPSULE: 'That does not look like a LOCKRA capsule link.',
  TAMPERED: '⚠️ This capsule was tampered with: its label, author or contents were changed. It cannot be trusted.',
  BAD_SIGNATURE: '⚠️ This capsule could not be verified.',
  BEACON_UNREACHABLE: 'The drand network could not be reached right now. Please try again in a minute.',
};

/**
 * @param {{
 *   call: (method: string, params?: object) => Promise<any>,
 *   username: string,
 *   sdkOptions?: object,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   info?: { raffle: () => Promise<string>, stats: () => Promise<string> },
 *   predictions?: { chats: string[], store: { add: Function } },
 *   scores?: { vote: Function, leaderboardText: Function },
 * }} options
 */
export function createBot({ call, username, sdkOptions = {}, now = Date.now, log = () => {}, info = null, predictions = null, scores = null, kols = null, gm = null, token = '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898', buyUrl = '', reminders = null, daily = null, arena = null }) {
  const seals = new Map(); // userId -> timestamps (ms), in memory only
  // Welcome: one message per burst of joins (raids stay quiet), the previous welcome is deleted.
  const welcomeState = new Map(); // chatId -> { at, messageId }
  async function onJoin(msg) {
    const people = msg.new_chat_members.filter((u) => !u.is_bot);
    if (!people.length) return;
    const st = welcomeState.get(msg.chat.id) || {};
    if (st.at != null && now() - st.at < 60_000) return;
    const names = people.slice(0, 3).map((u) => esc(u.first_name || u.username || 'fren')).join(', ');
    const text = [
      `👋 Welcome to LOCKRA${names ? `, ${names}` : ''}!`,
      '',
      '🔐 The first encryption protocol on Fobo.fun.',
      '',
      `CA: <code>${esc(token)}</code>`,
      '',
      'ℹ️ Use /learn to learn more about LOCKRA and what we\'re building.',
      '',
      'Have questions? Feel free to drop them here. Our community will be happy to help!',
    ].join('\n');
    const sent = await call('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, disable_notification: true });
    if (st.messageId) call('deleteMessage', { chat_id: msg.chat.id, message_id: st.messageId }).catch(() => {});
    welcomeState.set(msg.chat.id, { at: now(), messageId: sent?.message_id });
  }

  const reply = (msg, text, extra = {}) =>
    call('sendMessage', {
      chat_id: msg.chat.id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...extra,
    });

  const dmButton = (label, start = 'seal') => ({ inline_keyboard: [[{ text: label, url: `https://t.me/${username}?start=${start}` }]] });

  function allowSeal(userId) {
    const t = now();
    const recent = (seals.get(userId) || []).filter((x) => t - x < 3_600_000);
    if (recent.length >= SEALS_PER_HOUR) {
      seals.set(userId, recent);
      return false;
    }
    recent.push(t);
    seals.set(userId, recent);
    return true;
  }

  async function onSeal(msg, args) {
    if (msg.chat.type !== 'private') {
      // Remove the secret from the group if we can, then send the user to a private chat.
      if (args) await call('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
      return call('sendMessage', {
        chat_id: msg.chat.id,
        text: 'To keep it secret, capsules are sealed in a private chat with me 🔒',
        reply_markup: dmButton('Seal privately'),
      });
    }
    const [when, ...rest] = args.split(/\s+/);
    const message = rest.join(' ').trim();
    if (!when || !message) return reply(msg, SEAL_USAGE);
    const parsed = parseWhen(when, now());
    if ('error' in parsed) return reply(msg, `${esc(parsed.error)}\n\n${SEAL_USAGE}`);
    if (message.length > MAX_MESSAGE) return reply(msg, `That message is too long. The maximum is ${MAX_MESSAGE} characters.`);
    if (!allowSeal(msg.from?.id ?? msg.chat.id)) return reply(msg, `You have sealed ${SEALS_PER_HOUR} capsules in the last hour. Please try again later.`);

    const by = msg.from?.username ? `@${msg.from.username}` : '';
    const capsule = await seal(message, { unlockAt: parsed.date, by, ...sdkOptions });
    const left = humanDuration((capsule.unlockAt.getTime() - now()) / 1000);
    const share = `https://t.me/share/url?url=${encodeURIComponent(capsule.link)}&text=${encodeURIComponent('Sealed with LOCKRA 🔒 Nobody can open it before ' + formatDate(capsule.unlockAt))}`;
    return reply(
      msg,
      [
        `🔒 <b>Sealed until ${esc(formatDate(capsule.unlockAt))}</b> (in ${left}).`,
        'Nobody can open it before then. Not even you.',
        '',
        `<code>${esc(capsule.link)}</code>`,
        '',
        'Share the link anywhere. Anyone can open it on lockra.buzz once the date arrives.',
      ].join('\n'),
      { reply_markup: { inline_keyboard: [[{ text: 'Open on lockra.buzz', url: capsule.link }], [{ text: 'Share', url: share }]] } },
    );
  }

  async function onPredict(msg, args) {
    if (!predictions?.chats?.length) return reply(msg, 'Predictions are not set up for this bot yet.');
    if (msg.chat.type !== 'private') {
      if (args) await call('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
      return call('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Predictions are sealed in a private chat with me, so nobody sees them early 🔮',
        reply_markup: dmButton('Seal a prediction', 'predict'),
      });
    }
    const [when, ...rest] = args.split(/\s+/);
    const message = rest.join(' ').trim();
    if (!when || !message) return reply(msg, PREDICT_USAGE);
    const parsed = parseWhen(when, now());
    if ('error' in parsed) return reply(msg, `${esc(parsed.error)}\n\n${PREDICT_USAGE}`);
    const secs = (parsed.date.getTime() - now()) / 1000;
    if (secs < 3600) return reply(msg, 'A prediction must stay sealed for at least 1 hour.');
    if (secs > 366 * 86400) return reply(msg, 'A prediction can be sealed for at most 1 year.');
    if (message.length > 280) return reply(msg, 'Keep predictions short: 280 characters at most.');
    if (!allowSeal(msg.from?.id ?? msg.chat.id)) return reply(msg, `You have sealed ${SEALS_PER_HOUR} capsules in the last hour. Please try again later.`);

    const by = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || '').slice(0, 40);
    const capsule = await seal(message, { unlockAt: parsed.date, by, label: 'Prediction', ...sdkOptions });
    const when2 = formatDate(capsule.unlockAt);
    const left = humanDuration((capsule.unlockAt.getTime() - now()) / 1000);
    const announce = [
      `🔮 <b>New sealed prediction</b>${by ? ` by ${esc(by)}` : ''}`,
      '',
      `Opens ${esc(when2)} (in ${left}).`,
      'Nobody can read it before then. Not even its author.',
      '',
      scores ? 'I will reveal it right here, then you vote: called it or missed it 👀' : 'I will reveal it right here 👀',
    ].join('\n');
    let posted = 0;
    for (const chatId of predictions.chats) {
      const sent = await call('sendMessage', {
        chat_id: chatId,
        text: announce,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[{ text: 'See the capsule', url: capsule.link }]] },
      }).catch((e) => { log(`prediction announce to ${chatId} failed: ${e.message}`); return null; });
      if (!sent?.message_id) continue;
      posted++;
      await predictions.store.add({ link: capsule.link, chatId, messageId: sent.message_id, by, byId: msg.from?.id ?? null, unlockAt: capsule.unlockAt.getTime(), sealedAt: now() })
        .catch((e) => log(`prediction store failed: ${e.message}`));
    }
    return reply(
      msg,
      posted
        ? `🔮 <b>Sealed and announced in the group.</b>\nIt opens ${esc(when2)} (in ${left}), and I will reveal it there.\n\n<code>${esc(capsule.link)}</code>`
        : `🔒 Sealed, but I could not post it in the group right now.\n\n<code>${esc(capsule.link)}</code>`,
    );
  }

  async function onOpen(msg, args) {
    const link = findCapsule(args) || findCapsule(msg.reply_to_message?.text) || findCapsule(msg.reply_to_message?.caption);
    if (!link) return reply(msg, 'Send me a capsule link: <code>/open https://lockra.buzz/#c=…</code>\nor reply <code>/open</code> to a message that contains one.');
    let info;
    try {
      info = inspect(link, sdkOptions);
    } catch {
      return reply(msg, ERRORS.INVALID_CAPSULE);
    }
    const r = await open(link, sdkOptions);
    const head = [info.label && `<b>${esc(info.label)}</b>`, info.by && `by ${esc(info.by)}`].filter(Boolean).join(' · ');
    const wallet = info.wallet ? `\n${info.wallet.verified ? '✅ Wallet-signed by' : '⚠️ Invalid wallet signature for'} <code>${esc(info.wallet.address)}</code>` : '';
    if (r.status === 'sealed') {
      return reply(
        msg,
        `⏳ <b>Still sealed.</b>${head ? `\n${head}` : ''}\nOpens ${esc(formatDate(r.unlockAt))} (in ${humanDuration(r.secondsLeft)}).${wallet}`,
        { reply_markup: { inline_keyboard: [
          ...(reminders ? [[await reminders.button(link, r.unlockAt, info.label || '').catch(() => null)].filter(Boolean)] : []),
          [{ text: 'Watch it on lockra.buzz', url: link }],
        ].filter((row) => row.length) } },
      );
    }
    const body = r.message.length > MAX_SHOWN ? `${r.message.slice(0, MAX_SHOWN)}…` : r.message;
    const sealed = r.sealedAt ? `\nSealed ${esc(formatDate(r.sealedAt))}` : '';
    const file = r.file ? `\n📎 Contains a file (${esc(r.file.name)}). Open it on lockra.buzz.` : '';
    return reply(msg, `🔓 <b>Opened.</b>${head ? `\n${head}` : ''}${sealed}${wallet}\n\n${esc(body)}${file}`, {
      reply_markup: { inline_keyboard: [[{ text: 'View on lockra.buzz', url: link }]] },
    });
  }

  // Send the bot a GIF or video in a private chat to get the value for ALERT_MEDIA.
  function onMedia(msg) {
    const kind = msg.animation ? 'animation' : 'video';
    const id = (msg.animation || msg.video).file_id;
    return reply(msg, [
      '🎬 <b>Media for alerts</b>',
      '',
      'Use this value on your host as <code>ALERT_MEDIA</code> (buys), <code>BURN_MEDIA</code> (burns) or <code>ARENA_BURN_MEDIA</code> (Arena burns):',
      `<code>${kind}:${esc(id)}</code>`,
    ].join('\n'));
  }

  async function onStart(msg, args) {
    if (args === 'seal') return reply(msg, SEAL_USAGE);
    if (args === 'predict') return reply(msg, PREDICT_USAGE);
    return reply(msg, HELP);
  }

  // Taps on the ✅ / ❌ buttons under a revealed prediction.
  async function onVote(q) {
    const m = /^pv:([0-9a-f]+):([01x])$/.exec(q.data || '');
    if (!m || !scores) return call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (m[2] === 'x') return call('answerCallbackQuery', { callback_query_id: q.id, text: 'Voting on this prediction is closed. See /leaderboard' }).catch(() => {});
    const r = await scores.vote(m[1], q.from.id, m[2] === '1');
    await call('answerCallbackQuery', { callback_query_id: q.id, text: r.text }).catch(() => {});
    if (r.ok && q.message) {
      await call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: voteKeyboard(r.poll, r.poll.link) })
        .catch((e) => { if (!/not modified/i.test(e.message)) log(`vote buttons: ${e.message}`); });
    }
  }

  /** Handle one Telegram update. Never throws for user-facing errors. */
  async function handleUpdate(update) {
    if (update.callback_query) {
      if (daily && (await daily.handleCallback(update.callback_query).catch((e) => { log(`daily callback failed: ${e?.message ?? e}`); return true; }))) return;
      if (reminders && (await reminders.handleCallback(update.callback_query).catch((e) => { log(`reminder callback failed: ${e?.message ?? e}`); return true; }))) return;
      if (kols && (await kols.handleCallback(update.callback_query).catch((e) => { log(`kol callback failed: ${e?.message ?? e}`); return true; }))) return;
      return await onVote(update.callback_query).catch((e) => log(`vote failed: ${e?.message ?? e}`));
    }
    if (update.channel_post) return kols ? await kols.handleChannelPost(update.channel_post).catch((e) => log(`channel post failed: ${e?.message ?? e}`)) : undefined;
    const msg = update.message;
    if (msg && msg.chat.type === 'private' && (msg.animation || msg.video)) return await onMedia(msg).catch((e) => log(`media failed: ${e?.message ?? e}`));
    if (msg?.chat.type === 'private' && msg.sticker) {
      const id = msg.sticker.custom_emoji_id;
      return await reply(msg, id
        ? `😀 <b>Custom emoji for buy alerts</b>\n\nSet this as <code>ALERT_EMOJI_ID</code> on your host:\n<code>${esc(id)}</code>`
        : 'That is a sticker, not a custom emoji. Stickers cannot go inside the alert text.\n\nSend the animated emoji typed in a message (from the emoji tab of the keyboard, not the sticker tab), or send a GIF or video to use as the alert media.').catch((e) => log(`sticker failed: ${e?.message ?? e}`));
    }
    const custom = msg?.chat.type === 'private' && (msg.entities || []).filter((e) => e.type === 'custom_emoji');
    if (custom?.length) return await reply(msg, ['😀 <b>Custom emoji for buy alerts</b>', '', 'Set this as <code>ALERT_EMOJI_ID</code> on your host:', ...[...new Set(custom.map((e) => e.custom_emoji_id))].map((id) => `<code>${esc(id)}</code>`)].join('\n')).catch((e) => log(`emoji failed: ${e?.message ?? e}`));
    if (msg?.new_chat_members && ['group', 'supergroup'].includes(msg.chat.type)) return await onJoin(msg).catch((e) => log(`welcome failed: ${e?.message ?? e}`));
    const text = msg?.text;
    if (!msg || !text) return;
    const cmd = parseCommand(text, username);
    if (daily && cmd && (await daily.handleMessage(msg, cmd).catch((e) => { log(`daily failed: ${e?.message ?? e}`); return false; }))) return;
    if (gm && (await gm.handleMessage(msg, cmd).catch((e) => { log(`gm failed: ${e?.message ?? e}`); return false; }))) return;
    if (!cmd) return;
    try {
      if (kols && (await kols.handleCommand(msg, cmd))) return;
      switch (cmd.name) {
        case 'start':
          return await onStart(msg, cmd.args);
        case 'help':
          return await reply(msg, HELP);
        case 'seal':
          return await onSeal(msg, cmd.args);
        case 'open':
          return await onOpen(msg, cmd.args);
        case 'predict':
          return await onPredict(msg, cmd.args);
        case 'leaderboard':
        case 'top':
          if (!scores) return;
          return await reply(msg, await scores.leaderboardText());
        case 'arena':
          if (!arena) return await reply(msg, '⚔️ <b>LOCKRA Arena</b> is coming soon: rock, paper, scissors for $LOCKRA, settled on-chain.');
          return await reply(msg, await arena.board(), { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: '⚔️ Play in the Arena', url: arena.site }]] } });
        case 'learn':
          return await reply(msg, ABOUT, { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: '🔒 Seal a capsule', url: 'https://lockra.buzz/seal' }, { text: '🛒 Buy $LOCKRA', url: buyUrl || `https://fobo.fun/?token=${token}` }]] } });
        case 'raffle':
        case 'lockra':
        case 'stats': {
          if (!info) return;
          const raffleUrl = info.raffleUrl || 'https://lockra.buzz/raffle';
          const text = await info[cmd.name === 'raffle' ? 'raffle' : 'stats']().catch((e) => { log(`/${cmd.name}: ${e.message}`); return null; });
          if (!text) return await reply(msg, 'Could not load the numbers right now. Please try again in a minute.');
          return await reply(msg, text, cmd.name === 'raffle' ? { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[info.raffleCancelled?.() ? { text: '🤝 See our collabs', url: 'https://lockra.buzz/collabs' } : info.raffleEnded?.() ? { text: '🏆 See the winner', url: raffleUrl } : { text: '🔥 Burn to enter', url: raffleUrl }]] } } : {});
        }
        case 'chatid':
          // Lets an admin find the id to put in ALERT_CHAT_IDS. Not listed in the menu.
          return await reply(msg, `Chat id: <code>${esc(String(msg.chat.id))}</code>`);
        default:
          return;
      }
    } catch (err) {
      if (err instanceof LockraError && ERRORS[err.code]) return reply(msg, ERRORS[err.code]).catch(() => {});
      if (err instanceof LockraError && err.code === 'INVALID_ARGUMENT') return reply(msg, esc(err.message)).catch(() => {});
      log(`/${cmd.name} failed: ${err?.stack ?? err}`);
      return reply(msg, 'Something went wrong. Please try again.').catch(() => {});
    }
  }

  return { handleUpdate };
}
