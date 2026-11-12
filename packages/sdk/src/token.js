// The capsule token: a compact base64url string carried in the link fragment (#c=...).
//
// Layout (version 1):
//   ver(1) | z(1) | round(8, big-endian) | U(96) | V(32) | W(32) | iv(12) | AES-GCM ciphertext
//
// `z` = 1 when the JSON payload was deflate-raw compressed before encryption.
// The AES-GCM additional data is `label + "\0" + by`, so the public label and signer name
// cannot be changed without breaking decryption.

import { QUICKNET, roundAt, timeOfRound, roundIdentity, ibeEncrypt, ibeDecrypt } from './tlock.js';
import { LockraError } from './errors.js';
import { b64url, unb64url, cat, utf8, fromUtf8 } from './bytes.js';

const VERSION = 1;
const HEADER = 10;
const MIN_LENGTH = HEADER + 96 + 32 + 32 + 12 + 16;

/** Additional authenticated data binding the public label and signer name. */
export const aad = (label, by) => utf8(`${label}\u0000${by}`);

async function pipe(data, stream) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

async function pack(text) {
  const raw = utf8(text);
  if (typeof CompressionStream === 'undefined') return { z: 0, data: raw };
  const packed = await pipe(raw, new CompressionStream('deflate-raw'));
  return packed.length < raw.length ? { z: 1, data: packed } : { z: 0, data: raw };
}

async function unpack(z, data) {
  if (!z) return fromUtf8(data);
  if (typeof DecompressionStream === 'undefined') throw new LockraError('INTERNAL', 'DecompressionStream is not available in this runtime.');
  return fromUtf8(await pipe(data, new DecompressionStream('deflate-raw')));
}

/**
 * Encrypt a JSON payload so it can only be decrypted once the round for `unlockSec` is published.
 * @returns {Promise<string>} capsule token
 */
export async function sealToken(payload, unlockSec, { label = '', by = '', chain = QUICKNET } = {}) {
  const round = roundAt(unlockSec, chain);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const { z, data } = await pack(JSON.stringify(payload));
    const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(label, by) }, aes, data));
    const { U, V, W } = ibeEncrypt(chain.publicKey, roundIdentity(round), key);
    const head = new Uint8Array(HEADER);
    head[0] = VERSION;
    head[1] = z;
    new DataView(head.buffer).setBigUint64(2, BigInt(round));
    return b64url(cat(head, U, V, W, iv, ct));
  } finally {
    key.fill(0);
  }
}

/** Decode a token without decrypting it. */
export function decodeToken(token, chain = QUICKNET) {
  let b;
  try {
    b = unb64url(token);
  } catch {
    throw new LockraError('INVALID_CAPSULE', 'This is not a valid LOCKRA capsule.');
  }
  if (b.length < MIN_LENGTH || b[0] !== VERSION || b[1] > 1) throw new LockraError('INVALID_CAPSULE', 'This is not a valid LOCKRA capsule.');
  const round = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(2));
  if (!Number.isSafeInteger(round) || round < 1) throw new LockraError('INVALID_CAPSULE', 'This capsule has an invalid round.');
  let o = HEADER;
  const take = (n) => b.slice(o, (o += n));
  return { round, unlockAt: timeOfRound(round, chain), z: b[1], U: take(96), V: take(32), W: take(32), iv: take(12), ct: b.slice(o) };
}

/** Decrypt a token with the beacon signature of its round. Returns the JSON payload. */
export async function openToken(token, signatureHex, { label = '', by = '', chain = QUICKNET } = {}) {
  const c = decodeToken(token, chain);
  const key = ibeDecrypt(signatureHex, c);
  try {
    const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    let pt;
    try {
      pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.iv, additionalData: aad(label, by) }, aes, c.ct));
    } catch (cause) {
      throw new LockraError('TAMPERED', 'This capsule was tampered with: its label, signer name or data has been changed.', { cause });
    }
    try {
      return JSON.parse(await unpack(c.z, pt));
    } catch (cause) {
      throw new LockraError('INVALID_CAPSULE', 'The capsule decrypted but its contents are not a LOCKRA payload.', { cause });
    }
  } finally {
    key.fill(0);
  }
}
