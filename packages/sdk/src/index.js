// lockra-sdk: timelock-encrypted capsules that nobody can open before their date.
// Fully compatible with https://lockra.buzz: links and .lockra files work both ways.

import { QUICKNET, roundAt, timeOfRound } from './tlock.js';
import { sealToken, openToken, decodeToken } from './token.js';
import { fetchSignature, verifyBeaconSignature } from './drand.js';
import { toLink, parseCapsule, DEFAULT_BASE_URL } from './link.js';
import { walletMessage, verifyWallet, recoverAddress } from './wallet.js';
import { encryptBytes, decryptBytes, bundle, unbundle, MAX_FILE_BYTES } from './file.js';
import { LockraError } from './errors.js';

export { QUICKNET, LockraError, MAX_FILE_BYTES, DEFAULT_BASE_URL };
export { roundAt, timeOfRound, fetchSignature, verifyBeaconSignature, toLink, parseCapsule, walletMessage, recoverAddress };

export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_LABEL_LENGTH = 80;
export const MAX_BY_LENGTH = 40;
const POLL_FLOOR_MS = 1000;

// ---------- argument handling ----------

function arg(cond, message) {
  if (!cond) throw new LockraError('INVALID_ARGUMENT', message);
}

/** Resolve `unlockAt` (Date, ISO string or epoch milliseconds) or `unlockIn` (seconds) to unix seconds. */
function resolveUnlock({ unlockAt, unlockIn }, chain) {
  arg((unlockAt === undefined) !== (unlockIn === undefined), 'Pass exactly one of `unlockAt` or `unlockIn`.');
  let ms;
  if (unlockIn !== undefined) {
    arg(typeof unlockIn === 'number' && Number.isFinite(unlockIn) && unlockIn > 0, '`unlockIn` must be a positive number of seconds.');
    ms = Date.now() + unlockIn * 1000;
  } else {
    ms = unlockAt instanceof Date ? unlockAt.getTime() : typeof unlockAt === 'string' ? Date.parse(unlockAt) : unlockAt;
    arg(typeof ms === 'number' && Number.isFinite(ms), '`unlockAt` must be a Date, an ISO 8601 string or epoch milliseconds.');
  }
  const sec = ms / 1000;
  arg(sec > Date.now() / 1000 + chain.period, '`unlockAt` must be in the future.');
  return sec;
}

function meta({ label = '', by = '' }) {
  arg(typeof label === 'string' && label.length <= MAX_LABEL_LENGTH, `\`label\` must be a string of at most ${MAX_LABEL_LENGTH} characters.`);
  arg(typeof by === 'string' && by.length <= MAX_BY_LENGTH, `\`by\` must be a string of at most ${MAX_BY_LENGTH} characters.`);
  return { label: label.trim(), by: by.trim() };
}

function capsuleOf(ref, chain, baseUrl) {
  const { round, unlockAt } = decodeToken(ref.token, chain);
  const capsule = { token: ref.token, link: toLink(ref, baseUrl), round, unlockAt: new Date(unlockAt * 1000), label: ref.label, by: ref.by };
  if (ref.address && ref.signature) Object.assign(capsule, { address: ref.address, signature: ref.signature });
  return capsule;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new LockraError('INVALID_ARGUMENT', '`data` must be a Uint8Array, ArrayBuffer, typed array or Blob.');
}

// ---------- sealing ----------

/**
 * Seal a text message until a moment in the future.
 *
 * @example
 *   const capsule = await seal('BTC 150k by summer', { unlockAt: '2027-06-01T00:00:00Z', label: 'My call' });
 *   console.log(capsule.link);
 */
export async function seal(message, options = {}) {
  const { chain = QUICKNET, baseUrl = DEFAULT_BASE_URL } = options;
  arg(typeof message === 'string' && message.trim().length > 0, '`message` must be a non-empty string.');
  arg(message.length <= MAX_MESSAGE_LENGTH, `\`message\` must be at most ${MAX_MESSAGE_LENGTH} characters.`);
  const { label, by } = meta(options);
  const unlockSec = resolveUnlock(options, chain);
  const payload = { m: message, by, at: Math.floor(Date.now() / 1000) };
  const token = await sealToken(payload, unlockSec, { label, by, chain });
  return capsuleOf({ token, label, by }, chain, baseUrl);
}

/**
 * Seal a file (up to 25 MB). Returns the capsule and the `.lockra` file bytes to store or share.
 * Anyone with the .lockra file can open it on lockra.buzz once the date arrives.
 */
export async function sealFile(data, options = {}) {
  const { chain = QUICKNET, baseUrl = DEFAULT_BASE_URL, name, type, message = '' } = options;
  arg(typeof name === 'string' && name.trim().length > 0, '`name` (the file name) is required.');
  arg(typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH, `\`message\` must be at most ${MAX_MESSAGE_LENGTH} characters.`);
  const { label, by } = meta(options);
  const unlockSec = resolveUnlock(options, chain);
  const bytes = await toBytes(data);
  const { blob, meta: fileMeta } = await encryptBytes(bytes, { name: name.trim(), type });
  const payload = { m: message, by, at: Math.floor(Date.now() / 1000), f: fileMeta };
  const token = await sealToken(payload, unlockSec, { label, by, chain });
  const ref = { token, label, by };
  return { capsule: capsuleOf(ref, chain, baseUrl), file: bundle(ref, blob) };
}

// ---------- reading ----------

/**
 * Read the public details of a capsule without opening it.
 * Accepts a link, a token, a capsule object or `.lockra` file bytes.
 */
export function inspect(input, { chain = QUICKNET } = {}) {
  const ref = input instanceof Uint8Array || input instanceof ArrayBuffer ? unbundle(input).ref : parseCapsule(input);
  const { round, unlockAt } = decodeToken(ref.token, chain);
  return {
    round,
    unlockAt: new Date(unlockAt * 1000),
    unlocked: Date.now() / 1000 >= unlockAt,
    label: ref.label,
    by: ref.by,
    wallet: verifyWallet(ref),
  };
}

async function resolveSignature(round, unlockAt, { signature, wait = false, timeoutMs, chain, fetch, onWait }) {
  if (signature !== undefined) return signature;
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    const sig = await fetchSignature(round, { chain, fetch });
    if (sig || !wait) return sig;
    const now = Date.now();
    if (now >= deadline) throw new LockraError('TIMEOUT', 'Timed out waiting for the capsule to unlock.');
    const until = Math.max(POLL_FLOOR_MS, unlockAt * 1000 - now + 500);
    const delay = Math.min(until, deadline - now, 60_000);
    onWait?.({ round, unlockAt: new Date(unlockAt * 1000), retryInMs: delay });
    await new Promise((r) => setTimeout(r, Math.max(delay, POLL_FLOOR_MS)));
  }
}

function sealedResult(ref, round, unlockAt) {
  return {
    status: 'sealed',
    round,
    unlockAt: new Date(unlockAt * 1000),
    secondsLeft: Math.max(0, Math.ceil(unlockAt - Date.now() / 1000)),
    label: ref.label,
    by: ref.by,
    wallet: verifyWallet(ref),
  };
}

function openedResult(ref, round, unlockAt, payload) {
  return {
    status: 'opened',
    message: typeof payload.m === 'string' ? payload.m : '',
    round,
    unlockAt: new Date(unlockAt * 1000),
    sealedAt: Number.isFinite(payload.at) ? new Date(payload.at * 1000) : null,
    label: ref.label,
    by: ref.by,
    wallet: verifyWallet(ref),
    file: payload.f ? { name: payload.f.n, type: payload.f.t, size: payload.f.s } : null,
  };
}

/**
 * Try to open a capsule. Resolves to `{ status: 'sealed', ... }` before the date and to
 * `{ status: 'opened', message, ... }` after it. Pass `{ wait: true }` to wait for the unlock.
 */
export async function open(input, options = {}) {
  const { chain = QUICKNET } = options;
  const ref = parseCapsule(input);
  const { round, unlockAt } = decodeToken(ref.token, chain);
  const sig = await resolveSignature(round, unlockAt, { ...options, chain });
  if (!sig) return sealedResult(ref, round, unlockAt);
  const payload = await openToken(ref.token, sig, { label: ref.label, by: ref.by, chain });
  return openedResult(ref, round, unlockAt, payload);
}

/**
 * Open a `.lockra` file. Once unlocked, `file.data` holds the original bytes.
 */
export async function openFile(bytes, options = {}) {
  const { chain = QUICKNET } = options;
  const { ref, blob } = unbundle(await toBytes(bytes));
  const { round, unlockAt } = decodeToken(ref.token, chain);
  const sig = await resolveSignature(round, unlockAt, { ...options, chain });
  if (!sig) return sealedResult(ref, round, unlockAt);
  const payload = await openToken(ref.token, sig, { label: ref.label, by: ref.by, chain });
  const result = openedResult(ref, round, unlockAt, payload);
  if (!payload.f) throw new LockraError('INVALID_CAPSULE', 'This .lockra file does not contain a sealed file.');
  result.file = { name: payload.f.n, type: payload.f.t, size: payload.f.s, data: await decryptBytes(blob, payload.f) };
  return result;
}

// ---------- wallet signatures ----------

/**
 * Attach an EIP-191 wallet signature (over `walletMessage(capsule)`) to a capsule.
 * The signature is verified before it is attached. Returns a new capsule with an updated link.
 */
export function attachSignature(capsule, { address, signature }, { chain = QUICKNET, baseUrl = DEFAULT_BASE_URL } = {}) {
  const ref = { ...parseCapsule(capsule), address, signature };
  const check = verifyWallet(ref);
  if (!check?.verified) throw new LockraError('BAD_SIGNATURE', 'The wallet signature does not match this capsule and address.');
  return capsuleOf({ ...ref, address: check.address }, chain, baseUrl);
}

/** The drand round being published right now. */
export function currentRound(chain = QUICKNET) {
  return Math.max(1, Math.floor((Date.now() / 1000 - chain.genesis) / chain.period) + 1);
}
