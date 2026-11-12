# lockra-mcp

[![npm](https://img.shields.io/npm/v/lockra-mcp.svg)](https://www.npmjs.com/package/lockra-mcp) [![CI](https://github.com/LockraProtocol/lockra-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/LockraProtocol/lockra-dev/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/LockraProtocol/lockra-dev/blob/main/LICENSE)

**LOCKRA for AI agents.** A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude, Cursor and any MCP-compatible agent seal messages that nobody can read before a chosen date, and open them afterwards.

> "Seal my prediction that ETH flips 10k before June, unlock it on June 1st, and give me the link."

Capsules are encrypted locally with timelock encryption on the [drand](https://drand.love) threshold network. No accounts, no API keys, nothing stored. Every link opens on [lockra.buzz](https://lockra.buzz).

## Tools

| Tool              | What it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `seal_capsule`    | Encrypts a message until `unlock_at` (ISO 8601) or `unlock_in_seconds`. Returns a link. |
| `open_capsule`    | Opens a capsule from its link. Reports time left if still sealed; can wait up to 5 min. |
| `inspect_capsule` | Shows the public details (unlock time, label, author, wallet) without opening it.     |

All tools return human-readable text plus `structuredContent` that matches each tool's `outputSchema`.

## Setup

Requires Node.js 20 or newer.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "lockra": {
      "command": "npx",
      "args": ["-y", "lockra-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add lockra -- npx -y lockra-mcp
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "lockra": { "command": "npx", "args": ["-y", "lockra-mcp"] }
  }
}
```

### Any other client

Run `npx -y lockra-mcp`. The server speaks MCP over stdio (protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`).

## Example prompts

- "Seal 'I'll ship v2 by March' until March 1st 2027 with the label 'Promise' and give me the link."
- "Is this capsule open yet? https://lockra.buzz/#c=…"
- "Seal a riddle answer that unlocks in 10 minutes, then wait for it and read it back."

## Security

- Encryption happens on your machine. The server makes outbound requests only to public drand relays, and only when opening a capsule.
- Beacon signatures are verified against the drand network's public key before use.
- Anyone holding a link can read the capsule after its unlock time.
- Never ask an agent to seal seed phrases, private keys or passwords.

## Programmatic use

```js
import { createServer } from 'lockra-mcp';

const server = createServer();
const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
```

## License

MIT © LOCKRA. Built on [lockra-sdk](https://www.npmjs.com/package/lockra-sdk).

Source: [github.com/LockraProtocol/lockra-dev](https://github.com/LockraProtocol/lockra-dev)
