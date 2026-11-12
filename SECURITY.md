# Security

## Model

- Encryption and decryption happen entirely on the user's device. LOCKRA runs no server that sees capsules, keys or messages.
- A capsule can only be decrypted with the drand threshold BLS signature for its round. That signature is produced jointly by the League of Entropy nodes and published at the scheduled time. Opening early would require a threshold of those independent operators to collude.
- Beacon signatures fetched from relays are verified against the network's group public key before use. Relays are treated as untrusted transport.
- The public label and author name are authenticated (AES-GCM additional data). Changing them breaks decryption, and the SDK reports `TAMPERED`.
- Sealed files are encrypted with their own AES-256-GCM key, which lives inside the timelocked capsule together with a SHA-256 of the encrypted bytes.

## Out of scope

- After the unlock time, anyone holding the link or `.lockra` file can read the capsule. Links are the secret.
- A compromised device or browser can read a message before it is sealed.
- Like all pairing-based cryptography in use today, BLS12-381 is not designed to resist large-scale quantum computers.

## Cryptography

- AES-256-GCM via the platform Web Crypto API.
- BLS12-381 pairings, hash-to-curve (RFC 9380), SHA-256, Keccak-256 and secp256k1 from [noble-curves](https://github.com/paulmillr/noble-curves) and [noble-hashes](https://github.com/paulmillr/noble-hashes) (audited, MIT), vendored unmodified.
- IBE construction compatible with [drand/tlock](https://github.com/drand/tlock).

## Reporting a vulnerability

Please report security issues privately via a direct message to [@LockraRH](https://x.com/LockraRH) on X before disclosing them publicly. We aim to reply within 72 hours.
