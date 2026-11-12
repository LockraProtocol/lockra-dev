// Fetching and verifying drand beacon signatures.

import { bls12_381 } from './vendor/curves/bls12-381.js';
import { QUICKNET, roundIdentity } from './tlock.js';
import { LockraError } from './errors.js';

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const G1 = bls12_381.G1.ProjectivePoint;
const G2 = bls12_381.G2.ProjectivePoint;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Check a beacon signature against the network's group public key:
 * e(signature, G2) == e(H(sha256(round)), publicKey).
 * Relays are untrusted transport; only a valid threshold signature is accepted.
 */
export function verifyBeaconSignature(round, signatureHex, chain = QUICKNET) {
  try {
    const sig = G1.fromHex(signatureHex);
    const msg = bls12_381.G1.hashToCurve(roundIdentity(round), { DST });
    const left = bls12_381.pairing(sig, G2.BASE);
    const right = bls12_381.pairing(msg, G2.fromHex(chain.publicKey));
    return bls12_381.fields.Fp12.eql(left, right);
  } catch {
    return false;
  }
}

/**
 * Get the verified signature for `round` from the chain's public relays.
 * Resolves to `null` while the round has not been published yet.
 *
 * @param {number} round
 * @param {{ chain?: typeof QUICKNET, fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchSignature(round, { chain = QUICKNET, fetch: doFetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof doFetch !== 'function') throw new LockraError('BEACON_UNREACHABLE', 'No fetch implementation available. Use Node.js 20+ or pass `fetch`.');
  const errors = [];
  for (const relay of chain.relays) {
    try {
      const res = await doFetch(`${relay}/${chain.hash}/public/${round}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404 || res.status === 425) return null; // not published yet
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.round !== round || typeof body.signature !== 'string') throw new Error('unexpected response');
      if (!verifyBeaconSignature(round, body.signature, chain)) throw new Error('invalid beacon signature');
      return body.signature;
    } catch (err) {
      errors.push(`${relay}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new LockraError('BEACON_UNREACHABLE', `Could not reach any drand relay (${errors.join('; ')})`);
}
