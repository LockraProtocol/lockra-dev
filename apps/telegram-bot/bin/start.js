#!/usr/bin/env node
// Starts the LOCKRA Telegram bot with long polling. Configure with TELEGRAM_BOT_TOKEN.

import { createTelegram } from '../src/telegram.js';
import { createBot, COMMANDS } from '../src/bot.js';
import { createAlerts, createRpc, createEthPrice, createMarket, createPoolPrice, STABLE } from '../src/alerts.js';
import { createInfo } from '../src/info.js';
import { fileStore, createRevealer } from '../src/predictions.js';
import { jsonFile, createScores } from '../src/scores.js';
import { dirname, join } from 'node:path';
import { formatDate } from '../src/parse.js';
import { createKols, kolsFile, dexLookup } from '../src/kols.js';
import { createServer } from 'node:http';

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
const raffleStart = Date.parse(process.env.RAFFLE_START || '2026-11-13T13:30:00Z') / 1000;
const raffleEnd = Date.parse(process.env.RAFFLE_END || '2026-11-16T16:00:00Z') / 1000;
// Burn alerts only mention the raffle (tickets, button) while it is open.
const raffleLive = () => { const t = Date.now() / 1000; return t >= raffleStart && t < raffleEnd; };
let alerts = null;

const chats = (process.env.ALERT_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (chats.length) {
  const buyUrl = process.env.BUY_URL || `https://fobo.fun/?token=${tokenAddress}`;
  const buttons = (ev) => [
    ev.type === 'buy' ? { text: '🛒 Buy $LOCKRA', url: buyUrl } : raffleLive() && { text: '🎟 Raffle', url: raffleUrl },
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
  const ethUsd = createEthPrice(explorer, fetch, tokenAddress);
  const symbolOf = async (a) => { try { const h = (await rpc('eth_call', [{ to: a, data: '0x95d89b41' }, 'latest'])).slice(2); const len = parseInt(h.slice(64, 128), 16); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString(); } catch { return ''; } };
  const poolPrice = createPoolPrice({
    rpc,
    token: tokenAddress,
    findPair: market.pair,
    quoteUsd: async (q) => { const sym = await symbolOf(q); return STABLE.test(sym) ? 1 : /^W?ETH$/i.test(sym) ? ethUsd() : null; },
  });
  alerts = createAlerts({
    rpc,
    send,
    chats,
    token: tokenAddress,
    pools: (process.env.POOL_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean),
    explorer,
    ethUsd,
    poolPrice,
    marketCap: market.marketCap,
    tokenPrice: market.price,
    marketCapDelayMs: Number(process.env.MARKET_CAP_DELAY_MS ?? 8000),
    minUsd: Number(process.env.ALERT_MIN_USD || 0),
    step: Number(process.env.ALERT_STEP_USD || 10),
    // A Telegram custom (animated) emoji, if ALERT_EMOJI_ID is set; ALERT_EMOJI is shown where it is not supported.
    emoji: process.env.ALERT_EMOJI_ID
      ? `<tg-emoji emoji-id="${process.env.ALERT_EMOJI_ID.replace(/\D/g, '')}">${process.env.ALERT_EMOJI || '🔒'}</tg-emoji>`
      : process.env.ALERT_EMOJI || '🟢',
    burns: process.env.ALERT_BURNS !== 'false',
    ticketSize: () => (raffleLive() ? BigInt(process.env.RAFFLE_TICKET || '50000') * 10n ** 18n : null),
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
    start: raffleStart,
    end: raffleEnd,
    ticketSize: BigInt(process.env.RAFFLE_TICKET || '50000') * 10n ** 18n,
    maxPerWallet: Number(process.env.RAFFLE_MAX_TICKETS || 5),
    prize: process.env.RAFFLE_PRIZE || '$500 jackpot by FOBO',
    // Drawn on 16 Nov 2026 with drand round 34,013,812 (see lockra.buzz/raffle).
    winner: process.env.RAFFLE_WINNER === 'none' ? null : {
      ticket: process.env.RAFFLE_WINNER_TICKET || '21EB-A3E3',
      wallet: process.env.RAFFLE_WINNER || '0x0d566e9b89853e2941eee5e54a6e7b67526db61c',
    },
  },
  lastPrice: () => alerts?.lastPrice() ?? null,
  log,
});
info.raffleUrl = raffleUrl;
// Sealed predictions: announced and revealed in PREDICT_CHAT_IDS (defaults to the alert chats).
const predictChats = (process.env.PREDICT_CHAT_IDS || process.env.ALERT_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const predictionsFile = process.env.PREDICTIONS_FILE || 'data/predictions.json';
const predictionStore = fileStore(predictionsFile);
// Leaderboard votes live next to the predictions file (same volume on Railway).
const scores = createScores({ file: jsonFile(process.env.SCORES_FILE || join(dirname(predictionsFile), 'scores.json')) });
if (predictChats.length) {
  createRevealer({ call: telegram.call, store: predictionStore, scores, log, formatDate })
    .run({ signal: controller.signal })
    .catch((e) => log(`predictions stopped: ${e.message}`));
  log(`predictions on for ${predictChats.length} chat(s)`);
}
// LOCKRA KOLs: sealed calls with a public track record. Admins (KOL_ADMIN_IDS) approve applications.
const balanceOf = async (wallet) => {
  const h = await rpc('eth_call', [{ to: tokenAddress, data: '0x70a08231' + wallet.slice(2).padStart(64, '0') }, 'latest']);
  return Number(BigInt(h) / 10n ** 15n) / 1000;
};
const kols = createKols({
  file: kolsFile(process.env.KOLS_FILE || join(dirname(predictionsFile), 'kols.json')),
  call: telegram.call,
  username: me.username,
  lookup: dexLookup(),
  balanceOf,
  admins: (process.env.KOL_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  groups: predictChats,
  site: process.env.KOLS_URL || 'https://lockra.buzz/kols',
  log,
});
kols.run({ signal: controller.signal }).catch((e) => log(`kols stopped: ${e.message}`));
// Public read-only data for lockra.buzz/kols (Railway: Settings > Networking > Generate Domain).
const port = Number(process.env.PORT || 0);
if (port) {
  createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'cache-control': 'public, max-age=20' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url.split('?')[0] === '/kols.json') {
      const body = JSON.stringify(await kols.publicView().catch(() => ({ error: 'unavailable' })));
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(body);
    }
    if (req.url === '/' || req.url === '/health') { res.writeHead(200, { ...cors, 'content-type': 'text/plain' }); return res.end('ok'); }
    res.writeHead(404, cors); res.end();
  }).listen(port, () => log(`kols api on :${port}/kols.json`));
}
const bot = createBot({ call: telegram.call, username: me.username, log, info, predictions: { chats: predictChats, store: predictionStore }, scores, kols });

log(`@${me.username} is running`);
await telegram.poll(bot.handleUpdate, { signal: controller.signal, log });
log('stopped');
// Background loops (alerts, predictions) may still be waiting on the network: exit now so the host
// sees a clean stop instead of killing the process.
process.exit(0);
