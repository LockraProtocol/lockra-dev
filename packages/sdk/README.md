# lockra-sdk

**Timelock encryption for JavaScript.** Seal a message or a file so that nobody can open it before a date you choose: not the recipient, not LOCKRA, not even you.

```js
import { seal, open } from 'lockra-sdk';

const capsule = await seal('BTC 150k by summer', { unlockAt: '2027-06-01T00:00:00Z', label: 'My call' });
console.log(capsule.link); // https://lockra.buzz/#l=My+call&c=...

const result = await open(capsule.link);
// before the date → { status: 'sealed', secondsLeft: 17280000, ... }
// after the date  → { status: 'opened', message: 'BTC 150k by summer', ... }
```

Every capsule works on [lockra.buzz](https://lockra.buzz), and the other way round: links and `.lockra` files made on the website open with the SDK.

- **No servers, no accounts, no API keys.** Encryption runs locally. Nothing is stored anywhere.
- **Nobody can open it early.** The key is bound to a future round of the [drand](https://drand.love) threshold network (League of Entropy). It only exists once that round is published.
- **Tamper-proof.** The public label and author name are authenticated; changing either breaks decryption.
- **Zero dependencies.** Ships with the audited [noble](https://paulmillr.com/noble/) cryptography (MIT) vendored, the same code that runs on lockra.buzz.
- **Typed.** Full TypeScript definitions included.

## Install

```sh
npm install lockra-sdk
```

Requires Node.js 20 or newer, or any modern browser. ESM only.

## Use cases

- **Predictions and calls** that can be proven later and cannot be edited after the fact.
- **Commit-reveal** for games, sealed bids, raffles and votes, with no trusted party holding the secret.
- **Time-released content**: announcements, keys, answers, puzzles.
- **Messages to the future** in apps, bots and dApps.

## API

### `seal(message, options)` → `Promise<Capsule>`

| Option      | Type                         | Description                                                  |
| ----------- | ---------------------------- | ------------------------------------------------------------ |
| `unlockAt`  | `Date \| string \| number`   | Unlock time: a Date, an ISO 8601 string or epoch ms.         |
| `unlockIn`  | `number`                     | Or: seconds from now. Pass exactly one of the two.           |
| `label`     | `string`                     | Public title shown before opening (max 80). Tamper-proof.    |
| `by`        | `string`                     | Public author name (max 40). Tamper-proof.                   |
| `baseUrl`   | `string`                     | Base URL for `link`. Default `https://lockra.buzz/`.         |

Messages can be up to 10,000 characters.

```ts
interface Capsule {
  token: string;   // the encrypted capsule
  link: string;    // shareable lockra.buzz link
  round: number;   // drand round that unlocks it
  unlockAt: Date;
  label: string;
  by: string;
}
```

### `open(capsule, options?)` → `Promise<OpenResult>`

Accepts a link, a bare token or a `Capsule`. Before the unlock time it resolves to `{ status: 'sealed', unlockAt, secondsLeft, ... }`; after it, to `{ status: 'opened', message, sealedAt, ... }`.

| Option      | Type       | Description                                                       |
| ----------- | ---------- | ----------------------------------------------------------------- |
| `wait`      | `boolean`  | Wait until the capsule unlocks instead of returning `sealed`.     |
| `timeoutMs` | `number`   | Stop waiting after this long (throws `TIMEOUT`).                  |
| `onWait`    | `function` | Called before each wait with `{ round, unlockAt, retryInMs }`.    |
| `signature` | `string`   | Use a known beacon signature instead of fetching it.             |
| `fetch`     | `function` | Custom `fetch` implementation.                                    |

```js
const r = await open(link, { wait: true });
console.log(r.message);
```

### `inspect(capsule)` → `CapsuleInfo`

Public details without decrypting and without network access: `round`, `unlockAt`, `unlocked`, `label`, `by`, `wallet`.

### Files: `sealFile(data, options)` and `openFile(bytes, options?)`

Seal any file up to 25 MB. You get back the capsule and the bytes of a `.lockra` file, which can be opened with the SDK or on lockra.buzz.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { sealFile, openFile } from 'lockra-sdk';

const { capsule, file } = await sealFile(await readFile('report.pdf'), {
  name: 'report.pdf',
  type: 'application/pdf',
  unlockAt: '2027-01-01T00:00:00Z',
});
await writeFile('report.pdf.lockra', file);

// later
const r = await openFile(await readFile('report.pdf.lockra'));
if (r.status === 'opened') await writeFile(r.file.name, r.file.data);
```

### Wallet signatures

A capsule can carry an EIP-191 signature that proves which wallet sealed it. The SDK never touches private keys: sign `walletMessage(capsule)` with your wallet library and attach the result.

```js
import { walletMessage, attachSignature } from 'lockra-sdk';

const signature = await signer.signMessage(walletMessage(capsule)); // ethers, viem, wagmi...
const signed = attachSignature(capsule, { address: await signer.getAddress(), signature });
signed.link; // shows "Wallet-signed by 0x…" on lockra.buzz
```

`open()` and `inspect()` return `wallet: { address, verified }` for signed capsules.

### Helpers

- `parseCapsule(input)`, `toLink(capsule, baseUrl?)`
- `roundAt(unixSeconds)`, `timeOfRound(round)`, `currentRound()`
- `fetchSignature(round)`, `verifyBeaconSignature(round, signature)`
- `QUICKNET`, `MAX_MESSAGE_LENGTH`, `MAX_LABEL_LENGTH`, `MAX_BY_LENGTH`, `MAX_FILE_BYTES`

### Errors

Every error is a `LockraError` with a stable `code`:

| Code                 | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `INVALID_CAPSULE`    | Not a LOCKRA capsule, link or `.lockra` file.                  |
| `INVALID_ARGUMENT`   | A parameter is missing or out of range.                        |
| `TAMPERED`           | The capsule, its label, its author name or the file was changed. |
| `BAD_SIGNATURE`      | A signature does not match the capsule.                        |
| `BEACON_UNREACHABLE` | No drand relay could be reached.                               |
| `TIMEOUT`            | `open({ wait: true })` gave up before the unlock.              |

```js
import { open, LockraError } from 'lockra-sdk';

try {
  await open(link);
} catch (err) {
  if (err instanceof LockraError && err.code === 'TAMPERED') console.warn('Someone edited this capsule.');
}
```

## How it works

1. The message is encrypted with a fresh random **AES-256-GCM** key. The public label and author name are bound in as authenticated data.
2. That key is encrypted with **identity-based encryption** (Boneh-Franklin on **BLS12-381**) to the identity `sha256(round)`, where `round` is the drand round for the unlock time.
3. The private key for that identity is the drand **threshold BLS signature** of the round. It does not exist until the League of Entropy nodes jointly publish it, at the scheduled time.
4. When opening, the SDK fetches the round signature from public drand relays and **verifies it against the network's public key** before using it, so relays do not need to be trusted.

The construction is compatible with [drand/tlock](https://github.com/drand/tlock) and uses the public `quicknet` network (3 second rounds).

## Security notes

- Security relies on the drand network: no threshold of its operators colluding to sign a future round early. This is the same assumption made by every tlock deployment.
- The decryption key is bound to the round, not to a person. **Anyone with the link can read the capsule after the unlock time.** Share links accordingly.
- `sealedAt` is the author's local clock and is informational.
- Never seal seed phrases, private keys or passwords.

## Testing

```sh
npm test            # offline suite with a local test beacon
npm run test:live   # end-to-end checks against the real drand quicknet network
npm run typecheck
```

## License

MIT © LOCKRA. Bundles [noble-curves](https://github.com/paulmillr/noble-curves) and [noble-hashes](https://github.com/paulmillr/noble-hashes) (MIT © Paul Miller), see `src/vendor`.
