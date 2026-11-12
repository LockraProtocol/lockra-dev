# LOCKRA developer tools

Timelock encryption for apps and AI agents. Seal a message or a file so that nobody can open it before a chosen date. Secured by the [drand](https://drand.love) threshold network and fully compatible with [lockra.buzz](https://lockra.buzz).

| Package                         | Description                                          |
| ------------------------------- | ---------------------------------------------------- |
| [`lockra-sdk`](packages/sdk)    | JavaScript / TypeScript library. Zero dependencies.  |
| [`lockra-mcp`](packages/mcp)    | MCP server so AI agents can seal and open capsules.  |

```js
import { seal, open } from 'lockra-sdk';

const capsule = await seal('BTC 150k by summer', { unlockAt: '2027-06-01T00:00:00Z' });
const result = await open(capsule.link); // { status: 'sealed' } until June 1st 2027
```

```sh
claude mcp add lockra -- npx -y lockra-mcp
```

## Development

```sh
npm install
npm test             # offline tests for both packages
npm run typecheck    # checks the public TypeScript definitions
npm run test:live -w lockra-sdk   # end-to-end against the real drand network
```

Examples live in [`examples/`](examples).

## Security

See [SECURITY.md](SECURITY.md). Never seal seed phrases, private keys or passwords.

## License

MIT © LOCKRA
