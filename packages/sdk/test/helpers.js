// A local, in-memory drand-style beacon for deterministic offline tests.
// It uses a throwaway BLS key, so tests exercise the exact same IBE and signature
// verification code paths as the real quicknet network.

import { bls12_381 } from '../src/vendor/curves/bls12-381.js';
import { roundIdentity } from '../src/tlock.js';
import { hex } from '../src/bytes.js';

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

export function createBeacon({ period = 3 } = {}) {
  const sk = bls12_381.utils.randomPrivateKey();
  const skNum = BigInt('0x' + hex(sk)) % bls12_381.fields.Fr.ORDER;
  const publicKey = hex(bls12_381.G2.ProjectivePoint.BASE.multiply(skNum).toRawBytes());
  const genesis = Math.floor(Date.now() / 1000) - 3600;
  const chain = Object.freeze({ hash: 'test', publicKey, period, genesis, relays: Object.freeze(['https://relay-a.test', 'https://relay-b.test']) });

  const sign = (round) => hex(bls12_381.G1.hashToCurve(roundIdentity(round), { DST }).multiply(skNum).toRawBytes());

  /** Rounds at or below `published` are available. Set to Infinity to simulate the future. */
  const state = { published: 0, calls: 0, overrides: new Map() };

  const fetch = async (url) => {
    state.calls++;
    const u = new URL(url);
    const round = Number(u.pathname.split('/').pop());
    const override = state.overrides.get(u.origin);
    if (override) return override(round);
    if (round > state.published) return new Response('not yet', { status: 425 });
    return Response.json({ round, signature: sign(round) });
  };

  return { chain, sign, fetch, state };
}

export const inAMinute = () => new Date(Date.now() + 60_000);
