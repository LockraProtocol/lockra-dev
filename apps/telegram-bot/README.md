# LOCKRA Telegram bot

Seal and open LOCKRA time capsules without leaving Telegram. Built on [lockra-sdk](../../packages/sdk).

| Command | Where | What it does |
| --- | --- | --- |
| `/seal 30d your message` | Private chat | Seals the message and replies with a lockra.buzz link. |
| `/seal 2027-01-01 your message` | Private chat | Same, with a UTC date (`2027-01-01T18:30` also works). |
| `/open <link>` | Anywhere | Shows how long is left, or the message once unlocked. |
| `/open` as a reply | Anywhere | Opens the capsule link in the replied-to message. |
| `/raffle` | Anywhere | Raffle tickets, wallets, burned amount and countdown, live from the explorer. |
| `/lockra` | Anywhere | $LOCKRA price, market cap, liquidity, volume and total burned (`/stats` also works). |
| `/help` | Anywhere | How LOCKRA works. |
| `/chatid` | Anywhere | Shows the chat id, for setting up alerts. Not listed in the menu. |

Times: `30m`, `2h`, `7d`, `2w`, `3mo`, `1y` or a UTC date. Minimum 1 minute, maximum 100 years. Messages up to 1,000 characters.

## Privacy by design

- **Sealing only happens in private chats.** In a group, `/seal` would expose the secret to everyone, so the bot deletes the command (when it has permission) and points the user to a private chat.
- **Nothing is stored.** No database, no logs of messages. Buy alerts only read public blockchain data. Rate limits (10 seals per user per hour) live in memory only.
- The author name in the capsule is the user's public `@username`, and it is tamper-proof.
- The bot never asks for wallets, seed phrases or private keys.

## Run it

Requires Node.js 20+ and a bot token from [@BotFather](https://t.me/BotFather).

```sh
cd apps/telegram-bot
npm install
TELEGRAM_BOT_TOKEN=123456:ABC... npm start
```

The bot uses long polling, so it needs no public URL, domain or open port. Run exactly one instance per token.

### Deploy on Railway

1. railway.com → **New Project** → **Deploy from GitHub repo** → `LockraProtocol/lockra-dev`.
2. Service **Settings** → **Root Directory**: `apps/telegram-bot`.
3. **Variables** → add `TELEGRAM_BOT_TOKEN` with the token from @BotFather.
4. Deploy. The logs show `@YourBot is running`.

Any platform that can run `npm start` with an environment variable works the same way (Render background worker, Fly.io, a VPS with pm2 or systemd).

### Add it to your group

1. Add the bot to the group.
2. Make it an admin with only **Delete messages** enabled, so it can remove `/seal` commands posted in the group.

## Buy and burn alerts

The bot can post every $LOCKRA buy and burn to your groups, read straight from Robinhood Chain over RPC. No third-party buy bot, no ads, no API keys.

A buy is recognised by its shape, so it works with any DEX: in one transaction a pool contract sends $LOCKRA to a wallet and receives another token (usually WETH) in return. Router hops are followed to the final buyer, sells are ignored. To trust only specific pools, set `POOL_ADDRESSES`.

Each alert shows what was paid (with the USD value from the explorer's ETH price), how much $LOCKRA was bought, the buyer, a link to the transaction and the market cap. Burns show the amount and the raffle tickets it earns.

Turn it on:

1. Add the bot to the group and send `/chatid`. It replies with the id (for groups it starts with `-100`).
2. Set `ALERT_CHAT_IDS` to that id (several ids separated by commas) and redeploy.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather. Keep it secret. |
| `TELEGRAM_API_URL` | No | Alternative Bot API server, used in tests. |
| `ALERT_CHAT_IDS` | No | Chats that receive buy and burn alerts, comma separated. Alerts are off when empty. |
| `ALERT_MIN_USD` | No | Skip buys smaller than this many dollars. Default `0`. |
| `ALERT_STEP_USD` | No | One emoji per this many dollars, up to 30. Default `10`. |
| `ALERT_EMOJI` | No | Emoji used for the buy strength line. Default `🟢`. |
| `ALERT_EMOJI_ID` | No | A custom (animated) Telegram emoji for the strength line. Send the emoji to the bot in a private chat to get its id. Telegram may require the bot to own a Fragment username to show custom emoji; otherwise `ALERT_EMOJI` is shown. |
| `ALERT_MEDIA` | No | GIF or video sent with each alert. Send it to the bot in a private chat and it replies with the exact value to use (`video:…` or `animation:…`). A direct URL also works. |
| `BURN_MEDIA` | No | GIF or video for burn alerts, same format as `ALERT_MEDIA`. Defaults to `ALERT_MEDIA`. |
| `ALERT_BURNS` | No | Set to `false` to skip burn alerts. |
| `BUY_URL`, `CHART_URL` | No | Buy button link (default: the token on fobo.fun) and an optional Chart button. Each alert also has a Tx button. |
| `RAFFLE_URL`, `RAFFLE_TICKET` | No | Raffle link and tokens per ticket. Defaults: lockra.buzz/raffle, `50000`. |
| `RAFFLE_START`, `RAFFLE_END` | No | Campaign window (ISO dates, UTC) for `/raffle`. Defaults to the FOBO × LOCKRA raffle. |
| `RAFFLE_PRIZE`, `RAFFLE_MAX_TICKETS` | No | Prize text and tickets per wallet for `/raffle`. |
| `POOL_ADDRESSES` | No | Only count buys from these pool addresses, comma separated. |
| `TOKEN_ADDRESS`, `RPC_URL`, `EXPLORER_URL` | No | Default to $LOCKRA on Robinhood Chain. |

## Tests

```sh
npm test
```

The suite covers command parsing, sealing and opening against a local test beacon, group privacy, rate limits, error handling and the long-polling loop.
