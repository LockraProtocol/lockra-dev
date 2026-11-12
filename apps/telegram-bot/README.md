# LOCKRA Telegram bot

Seal and open LOCKRA time capsules without leaving Telegram. Built on [lockra-sdk](../../packages/sdk).

| Command | Where | What it does |
| --- | --- | --- |
| `/seal 30d your message` | Private chat | Seals the message and replies with a lockra.buzz link. |
| `/seal 2027-01-01 your message` | Private chat | Same, with a UTC date (`2027-01-01T18:30` also works). |
| `/open <link>` | Anywhere | Shows how long is left, or the message once unlocked. |
| `/open` as a reply | Anywhere | Opens the capsule link in the replied-to message. |
| `/help` | Anywhere | How LOCKRA works. |

Times: `30m`, `2h`, `7d`, `2w`, `3mo`, `1y` or a UTC date. Minimum 1 minute, maximum 100 years. Messages up to 1,000 characters.

## Privacy by design

- **Sealing only happens in private chats.** In a group, `/seal` would expose the secret to everyone, so the bot deletes the command (when it has permission) and points the user to a private chat.
- **Nothing is stored.** No database, no logs of messages. Rate limits (10 seals per user per hour) live in memory only.
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

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather. Keep it secret. |
| `TELEGRAM_API_URL` | No | Alternative Bot API server, used in tests. |

## Tests

```sh
npm test
```

The suite covers command parsing, sealing and opening against a local test beacon, group privacy, rate limits, error handling and the long-polling loop.
