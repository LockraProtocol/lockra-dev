# Changelog

## 1.0.1

- Docs: npm and CI badges, link to the source repository.
- Releases are now published with npm Trusted Publishing.

## 1.0.0

First public release.

- `seal`, `open` (with optional `wait`), `inspect`.
- Sealed files: `sealFile`, `openFile` (byte-compatible `.lockra` format).
- Optional EIP-191 wallet signatures: `walletMessage`, `attachSignature`.
- Beacon signatures verified against the drand public key; untrusted relays are skipped.
- Full TypeScript definitions.
- Interoperable with links and files created on lockra.buzz.
