// Sealed files (.lockra), byte-compatible with lockra.buzz.
//
// The file is encrypted with its own random AES-256-GCM key. That key, plus the file name,
// type, size and a SHA-256 of the ciphertext, goes inside a normal timelock capsule, so it
// only becomes readable when the round is published. The encrypted bytes travel next to the
// capsule in a single .lockra file:
//
//   "LOCKRA2\n" (8) | metaLength (uint32 BE) | meta JSON | iv(12) + ciphertext

import { sha256 } from './vendor/hashes/sha256.js';
import { LockraError } from './errors.js';
import { b64, unb64, hex, utf8, fromUtf8 } from './bytes.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAGIC = utf8('LOCKRA2\n');

/** Encrypt raw bytes. Returns the encrypted blob and the metadata that goes inside the capsule. */
export async function encryptBytes(data, { name, type }) {
  if (data.length > MAX_FILE_BYTES) throw new LockraError('INVALID_ARGUMENT', `File too large. The maximum is ${MAX_FILE_BYTES / 1048576} MB.`);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data));
    const blob = new Uint8Array(12 + ct.length);
    blob.set(iv);
    blob.set(ct, 12);
    const meta = { k: b64(key), n: String(name).slice(0, 120), t: type || 'application/octet-stream', s: data.length, h: hex(sha256(blob)) };
    return { blob, meta };
  } finally {
    key.fill(0);
  }
}

/** Decrypt the blob once the capsule (and so `meta`) is open. */
export async function decryptBytes(blob, meta) {
  if (hex(sha256(blob)) !== meta.h) throw new LockraError('TAMPERED', 'This file does not belong to this capsule, or it was altered.');
  const k = await crypto.subtle.importKey('raw', unb64(meta.k), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, k, blob.subarray(12)));
  } catch (cause) {
    throw new LockraError('TAMPERED', 'The sealed file was tampered with.', { cause });
  }
}

/** Pack a capsule reference and the encrypted blob into .lockra bytes. */
export function bundle(ref, blob) {
  const meta = utf8(
    JSON.stringify({ app: 'lockra', v: 2, c: ref.token, l: ref.label || '', by: ref.by || '', a: ref.address || undefined, s: ref.signature || undefined, size: blob.length }),
  );
  const out = new Uint8Array(8 + 4 + meta.length + blob.length);
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(8, meta.length);
  out.set(meta, 12);
  out.set(blob, 12 + meta.length);
  return out;
}

/** Read .lockra bytes. Returns the capsule reference and the encrypted blob. */
export function unbundle(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 12 || !MAGIC.every((v, i) => buf[i] === v)) throw new LockraError('INVALID_CAPSULE', 'This is not a .lockra file.');
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8);
  if (12 + n > buf.length) throw new LockraError('INVALID_CAPSULE', 'This .lockra file is truncated.');
  let m;
  try {
    m = JSON.parse(fromUtf8(buf.subarray(12, 12 + n)));
  } catch (cause) {
    throw new LockraError('INVALID_CAPSULE', 'This .lockra file has a corrupt header.', { cause });
  }
  if (m.app !== 'lockra' || typeof m.c !== 'string') throw new LockraError('INVALID_CAPSULE', 'This is not a .lockra file.');
  const ref = { token: m.c, label: m.l || '', by: m.by || '' };
  if (m.a && m.s) {
    ref.address = m.a;
    ref.signature = m.s;
  }
  return { ref, blob: buf.slice(12 + n) };
}
