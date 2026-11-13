#!/usr/bin/env node
// Starts the LOCKRA Telegram bot with long polling. Configure with TELEGRAM_BOT_TOKEN.

import { createTelegram } from '../src/telegram.js';
import { createBot, COMMANDS } from '../src/bot.js';
import { createAlerts, createRpc, createEthPrice } from '../src/alerts.js';

const log = (msg) => console.log(`[lockra-bot] ${new Date().toISOString()} ${msg}`);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Create a bot with @BotFather and set the token as an environment variable.');
  process.exit(1);
}

const telegram = createTelegram({ token, baseUrl: process.env.TELEGRAM_API_URL || undefined });
const me = await telegram.call('getMe');
await telegram.call('setMyCommands', { commands: COMMANDS });
await telegram.call('deleteWebhook', { drop_pending_updates: false });

const bot = createBot({ call: telegram.call, username: me.username, log });
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    log(`${sig} received, finishing in-flight updates…`);
    controller.abort();
  });
}

const chats = (process.env.ALERT_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (chats.length) {
  const explorer = process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com';
  const token = process.env.TOKEN_ADDRESS || '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898';
  const buttons = [
    process.env.BUY_URL && { text: '🛒 Buy', url: process.env.BUY_URL },
    process.env.CHART_URL && { text: '📈 Chart', url: process.env.CHART_URL },
    { text: '🎟 Raffle', url: process.env.RAFFLE_URL || 'https://lockra.buzz/raffle' },
  ].filter(Boolean);
  // Optional GIF or video: "video:<file_id>" or "animation:<file_id>" (send it to the bot in a DM to get this),
  // or a plain URL / file_id, sent as an animation.
  const [, mediaKind = 'animation', media] = /^(?:(video|animation):)?(.+)$/.exec(process.env.ALERT_MEDIA || '') || [];
  const send = (chat_id, html, btns) => {
    const reply_markup = btns.length ? { inline_keyboard: [btns] } : undefined;
    return media
      ? telegram.call(mediaKind === 'video' ? 'sendVideo' : 'sendAnimation', { chat_id, [mediaKind]: media, caption: html, parse_mode: 'HTML', reply_markup })
      : telegram.call('sendMessage', { chat_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup });
  };
  const alerts = createAlerts({
    rpc: createRpc(process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'),
    send,
    chats,
    token,
    pools: (process.env.POOL_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean),
    explorer,
    ethUsd: createEthPrice(explorer),
    minUsd: Number(process.env.ALERT_MIN_USD || 0),
    step: Number(process.env.ALERT_STEP_USD || 10),
    emoji: process.env.ALERT_EMOJI || '🟢',
    burns: process.env.ALERT_BURNS !== 'false',
    ticketSize: BigInt(process.env.RAFFLE_TICKET || '50000') * 10n ** 18n,
    buttons,
    log,
  });
  alerts.run({ signal: controller.signal }).catch((e) => log(`alerts stopped: ${e.message}`));
  log(`buy alerts on for ${chats.length} chat(s)`);
}

log(`@${me.username} is running`);
await telegram.poll(bot.handleUpdate, { signal: controller.signal, log });
log('stopped');
