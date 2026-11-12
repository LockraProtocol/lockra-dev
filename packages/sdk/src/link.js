// Capsule links. Everything lives in the URL fragment (after #), which browsers never send
// to the server, so lockra.buzz never sees the capsule.
//   https://lockra.buzz/#l=<label>&by=<name>&a=<address>&s=<signature>&c=<token>

import { LockraError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://lockra.buzz/';

/**
 * @typedef {object} CapsuleRef
 * @property {string} token
 * @property {string} label
 * @property {string} by
 * @property {string} [address]
 * @property {string} [signature]
 */

/** Build a shareable link for a capsule. */
export function toLink({ token, label = '', by = '', address, signature }, baseUrl = DEFAULT_BASE_URL) {
  const p = new URLSearchParams();
  if (label) p.set('l', label);
  if (by) p.set('by', by);
  if (address && signature) {
    p.set('a', address);
    p.set('s', signature);
  }
  p.set('c', token);
  const base = baseUrl.split('#')[0];
  return `${base}#${p.toString()}`;
}

/**
 * Accepts a capsule link, a bare token, a `{ token, ... }` object or the JSON
 * form `{ "c": "...", "l": "...", "by": "..." }`. Returns a normalised reference.
 * @returns {CapsuleRef}
 */
export function parseCapsule(input) {
  if (input && typeof input === 'object') {
    if (typeof input.token !== 'string') throw new LockraError('INVALID_CAPSULE', 'Capsule object is missing `token`.');
    return clean({ token: input.token, label: input.label, by: input.by, address: input.address, signature: input.signature });
  }
  if (typeof input !== 'string' || !input.trim()) throw new LockraError('INVALID_CAPSULE', 'Pass a capsule link or token.');
  const s = input.trim();
  const hash = s.indexOf('#');
  const fragment = hash >= 0 ? s.slice(hash + 1) : s;
  if (/(^|&)c=/.test(fragment)) {
    const p = new URLSearchParams(fragment);
    return clean({ token: p.get('c'), label: p.get('l'), by: p.get('by'), address: p.get('a'), signature: p.get('s') });
  }
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (typeof j.c === 'string') return clean({ token: j.c, label: j.l, by: j.by, address: j.a, signature: j.s });
    } catch {
      /* fall through */
    }
    throw new LockraError('INVALID_CAPSULE', 'Unrecognised capsule JSON.');
  }
  if (hash >= 0 || /^https?:\/\//i.test(s)) throw new LockraError('INVALID_CAPSULE', 'This link does not contain a capsule.');
  return clean({ token: s });
}

function clean({ token, label, by, address, signature }) {
  if (!token) throw new LockraError('INVALID_CAPSULE', 'This link does not contain a capsule.');
  const ref = { token: String(token).trim(), label: label ? String(label) : '', by: by ? String(by) : '' };
  if (address && signature) {
    ref.address = String(address);
    ref.signature = String(signature);
  }
  return ref;
}
