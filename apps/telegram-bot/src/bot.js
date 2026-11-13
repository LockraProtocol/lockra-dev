// LOCKRA Telegram bot logic. Transport-agnostic: give it a Telegram `call` function.
//
// Privacy rule: capsules are only sealed in private chats. In a group, the secret would be
// visible to everyone the moment it is typed, so the bot removes the command (when it is
// allowed to) and points the user to a private chat instead.

import { seal, open, inspect, LockraError } from 'lockra-sdk';
import { parseWhen, findCapsule, parseCommand, humanDuration, formatDate } from './parse.js';

export const MAX_MESSAGE = 1000;
export const SEALS_PER_HOUR = 10;
const MAX_SHOWN = 3500;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const COMMANDS = [
  { command: 'seal', description: 'Seal a message until a date (private chat)' },
  { command: 'open', description: 'Open a capsule or see how long is left' },
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
 * }} options
 */
export function createBot({ call, username, sdkOptions = {}, now = Date.now, log = () => {} }) {
  const seals = new Map(); // userId -> timestamps (ms), in memory only

  const reply = (msg, text, extra = {}) =>
    call('sendMessage', {
      chat_id: msg.chat.id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...extra,
    });

  const dmButton = (label) => ({ inline_keyboard: [[{ text: label, url: `https://t.me/${username}?start=seal` }]] });

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
        { reply_markup: { inline_keyboard: [[{ text: 'Watch it on lockra.buzz', url: link }]] } },
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
      'Use this value on your host as <code>ALERT_MEDIA</code> (buys) or <code>BURN_MEDIA</code> (burns):',
      `<code>${kind}:${esc(id)}</code>`,
    ].join('\n'));
  }

  async function onStart(msg, args) {
    if (args === 'seal') return reply(msg, SEAL_USAGE);
    return reply(msg, HELP);
  }

  /** Handle one Telegram update. Never throws for user-facing errors. */
  async function handleUpdate(update) {
    const msg = update.message;
    if (msg && msg.chat.type === 'private' && (msg.animation || msg.video)) return await onMedia(msg).catch((e) => log(`media failed: ${e?.message ?? e}`));
    const text = msg?.text;
    if (!msg || !text) return;
    const cmd = parseCommand(text, username);
    if (!cmd) return;
    try {
      switch (cmd.name) {
        case 'start':
          return await onStart(msg, cmd.args);
        case 'help':
        case 'info':
          return await reply(msg, HELP);
        case 'seal':
          return await onSeal(msg, cmd.args);
        case 'open':
          return await onOpen(msg, cmd.args);
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
