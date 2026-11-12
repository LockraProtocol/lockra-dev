// Small, dependency-free byte helpers that work the same in Node and browsers.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s) => encoder.encode(s);
export const fromUtf8 = (b) => decoder.decode(b);

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new TypeError('invalid hex string');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function xor(a, b) {
  if (a.length !== b.length) throw new RangeError('xor: length mismatch');
  return a.map((v, i) => v ^ b[i]);
}

function toBinaryString(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export const b64 = (b) => btoa(toBinaryString(b));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const b64url = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function unb64url(s) {
  const t = String(s).trim();
  if (!/^[A-Za-z0-9_-]*$/.test(t)) throw new TypeError('invalid base64url string');
  return unb64(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
}
