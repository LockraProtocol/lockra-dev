#!/usr/bin/env node
// Starts the LOCKRA Telegram bot with long polling. Configure with TELEGRAM_BOT_TOKEN.

import { createTelegram } from '../src/telegram.js';
import { createBot, COMMANDS } from '../src/bot.js';

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

log(`@${me.username} is running`);
await telegram.poll(bot.handleUpdate, { signal: controller.signal, log });
log('stopped');
