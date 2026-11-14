#!/usr/bin/env node
// Starts the LOCKRA Telegram bot with long polling. Configure with TELEGRAM_BOT_TOKEN.

import { createTelegram } from '../src/telegram.js';
import { createBot, COMMANDS } from '../src/bot.js';
import { createAlerts, createRpc, createEthPrice, createMarket } from '../src/alerts.js';
import { createInfo } from '../src/info.js';

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


const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    log(`${sig} received, finishing in-flight updates…`);
    controller.abort();
  });
}

const explorer = process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com';
const tokenAddress = process.env.TOKEN_ADDRESS || '0x2fc6de9c65a620f918ca7d1191d3afa495ca2898';
const rpc = createRpc(process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
const raffleUrl = process.env.RAFFLE_URL || 'https://lockra.buzz/raffle';
let alerts = null;

const chats = (process.env.ALERT_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (chats.length) {
  const buyUrl = process.env.BUY_URL || `https://fobo.fun/?token=${tokenAddress}`;
  const buttons = (ev) => [
    ev.type === 'buy' ? { text: '🛒 Buy $LOCKRA', url: buyUrl } : { text: '🎟 Raffle', url: raffleUrl },
    { text: 'Tx', url: `${explorer}/tx/${ev.tx}` },
    process.env.CHART_URL && ev.type === 'buy' && { text: '📈 Chart', url: process.env.CHART_URL },
  ].filter(Boolean);
  // Optional GIF or video per alert type: "video:<file_id>" or "animation:<file_id>" (send it to the
  // bot in a DM to get this), or a plain URL / file_id, sent as an animation.
  const parseMedia = (v) => { const m = /^(?:(video|animation):)?(.+)$/.exec(v || ''); return m ? { kind: m[1] || 'animation', id: m[2] } : null; };
  const mediaFor = { buy: parseMedia(process.env.ALERT_MEDIA), burn: parseMedia(process.env.BURN_MEDIA || process.env.ALERT_MEDIA) };
  const send = (chat_id, html, btns, type) => {
    const reply_markup = btns.length ? { inline_keyboard: [btns] } : undefined;
    const media = mediaFor[type];
    return media
      ? telegram.call(media.kind === 'video' ? 'sendVideo' : 'sendAnimation', { chat_id, [media.kind]: media.id, caption: html, parse_mode: 'HTML', reply_markup })
      : telegram.call('sendMessage', { chat_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup });
  };
  const market = createMarket(tokenAddress);
  alerts = createAlerts({
    rpc,
    send,
    chats,
    token: tokenAddress,
    pools: (process.env.POOL_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean),
    explorer,
    ethUsd: createEthPrice(explorer, fetch, tokenAddress),
    marketCap: market.marketCap,
    tokenPrice: market.price,
    minUsd: Number(process.env.ALERT_MIN_USD || 0),
    step: Number(process.env.ALERT_STEP_USD || 10),
    // A Telegram custom (animated) emoji, if ALERT_EMOJI_ID is set; ALERT_EMOJI is shown where it is not supported.
    emoji: process.env.ALERT_EMOJI_ID
      ? `<tg-emoji emoji-id="${process.env.ALERT_EMOJI_ID.replace(/\D/g, '')}">${process.env.ALERT_EMOJI || '🔒'}</tg-emoji>`
      : process.env.ALERT_EMOJI || '🟢',
    burns: process.env.ALERT_BURNS !== 'false',
    ticketSize: BigInt(process.env.RAFFLE_TICKET || '50000') * 10n ** 18n,
    buttons,
    log,
  });
  alerts.run({ signal: controller.signal }).catch((e) => log(`alerts stopped: ${e.message}`));
  log(`buy alerts on for ${chats.length} chat(s)`);
}

const info = createInfo({
  explorer,
  rpc,
  token: tokenAddress,
  raffle: {
    start: Date.parse(process.env.RAFFLE_START || '2026-11-13T13:30:00Z') / 1000,
    end: Date.parse(process.env.RAFFLE_END || '2026-11-16T16:00:00Z') / 1000,
    ticketSize: BigInt(process.env.RAFFLE_TICKET || '50000') * 10n ** 18n,
    maxPerWallet: Number(process.env.RAFFLE_MAX_TICKETS || 5),
    prize: process.env.RAFFLE_PRIZE || '$500 jackpot by FOBO',
  },
  lastPrice: () => alerts?.lastPrice() ?? null,
  log,
});
info.raffleUrl = raffleUrl;
const bot = createBot({ call: telegram.call, username: me.username, log, info });

log(`@${me.username} is running`);
await telegram.poll(bot.handleUpdate, { signal: controller.signal, log });
log('stopped');
