// Timelock encryption against a drand beacon running the `bls-unchained-g1-rfc9380` scheme
// (the public "quicknet" network by default).
//
// Construction (identical to lockra.buzz and compatible with drand/tlock-js IBE):
//   1. The payload is encrypted with a fresh random AES-256-GCM key.
//   2. That key is encrypted with Boneh-Franklin IBE to the identity sha256(round),
//      using the beacon's group public key (on G2). Identities live on G1.
//   3. The decryption key for that identity is the beacon signature for the round,
//      which the drand threshold network only publishes once the round is reached.

import { bls12_381 } from './vendor/curves/bls12-381.js';
import { sha256 } from './vendor/hashes/sha256.js';
import { LockraError } from './errors.js';
import { cat, xor, hex, unhex, utf8 } from './bytes.js';

/** The public drand "quicknet" beacon (3 second rounds). */
export const QUICKNET = Object.freeze({
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis: 1692803367,
  relays: Object.freeze(['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com']),
});

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const G1 = bls12_381.G1.ProjectivePoint;
const G2 = bls12_381.G2.ProjectivePoint;
const Fr = bls12_381.fields.Fr;
const Fp12 = bls12_381.fields.Fp12;

// ---------- rounds ----------

/** First round whose signature is published at or after `unixSeconds`. */
export function roundAt(unixSeconds, chain = QUICKNET) {
  return Math.max(1, Math.ceil((unixSeconds - chain.genesis) / chain.period) + 1);
}

/** Unix time (seconds) at which `round` is published. */
export function timeOfRound(round, chain = QUICKNET) {
  return chain.genesis + (round - 1) * chain.period;
}

/** IBE identity for a round: sha256 of the round number as a big-endian uint64. */
export function roundIdentity(round) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(round));
  return sha256(b);
}

// ---------- IBE (Boneh-Franklin, master key on G2, identities on G1) ----------

const sha = (...parts) => {
  const h = sha256.create();
  for (const p of parts) h.update(typeof p === 'string' ? utf8(p) : p);
  return h.digest();
};
const beNum = (b) => BigInt('0x' + (hex(b) || '0'));
const fpBytes = (fp) => unhex(fp.toString(16).padStart(96, '0'));
const fp2Bytes = (x) => cat(fpBytes(x.c1), fpBytes(x.c0));
const fp6Bytes = (x) => cat(fp2Bytes(x.c2), fp2Bytes(x.c1), fp2Bytes(x.c0));
const fp12Bytes = (x) => cat(fp6Bytes(x.c1), fp6Bytes(x.c0));

function h3(sigma, msg) {
  const base = sha('IBE-H3', sigma, msg);
  for (let i = 1; i < 65535; i++) {
    const ctr = new Uint8Array([i & 0xff, i >> 8]); // uint16 little-endian, as in tlock-js
    const d = sha(ctr, base);
    d[0] = d[0] >> 1;
    const n = beNum(d);
    if (n < Fr.ORDER) return n;
  }
  throw new LockraError('INTERNAL', 'h3: no valid scalar found');
}
const h4 = (sigma, len) => sha('IBE-H4', sigma).slice(0, len);
const gtHash = (gt, len) => sha('IBE-H2', fp12Bytes(gt)).slice(0, len);

/** Encrypt up to 32 bytes to an identity. Returns the ciphertext parts. */
export function ibeEncrypt(masterPublicKeyHex, identity, msg) {
  if (msg.length > 32) throw new LockraError('INTERNAL', 'IBE message must be at most 32 bytes');
  const qid = bls12_381.G1.hashToCurve(identity, { DST });
  const gid = bls12_381.pairing(qid, G2.fromHex(masterPublicKeyHex));
  const sigma = crypto.getRandomValues(new Uint8Array(msg.length));
  const r = h3(sigma, msg);
  const U = G2.BASE.multiply(r);
  const V = xor(sigma, gtHash(Fp12.pow(gid, r), msg.length));
  const W = xor(msg, h4(sigma, msg.length));
  return { U: U.toRawBytes(), V, W };
}

/** Decrypt with the beacon signature for the identity's round. Throws if the signature is wrong. */
export function ibeDecrypt(signatureHex, { U, V, W }) {
  let sigPoint;
  try {
    sigPoint = G1.fromHex(signatureHex);
  } catch {
    throw new LockraError('BAD_SIGNATURE', 'The beacon signature is not a valid G1 point.');
  }
  const Ut = G2.fromHex(U);
  const sigma = xor(gtHash(bls12_381.pairing(sigPoint, Ut), W.length), V);
  const msg = xor(h4(sigma, W.length), W);
  if (!G2.BASE.multiply(h3(sigma, msg)).equals(Ut)) {
    throw new LockraError('BAD_SIGNATURE', 'The beacon signature does not match this capsule round.');
  }
  return msg;
}
