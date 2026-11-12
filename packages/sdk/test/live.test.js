// Live checks against the real drand quicknet network.
// Skipped by default; run with: LOCKRA_LIVE=1 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, fetchSignature, currentRound, verifyBeaconSignature } from '../src/index.js';

const live = process.env.LOCKRA_LIVE === '1';

test('fetches and verifies a real quicknet signature', { skip: !live && 'set LOCKRA_LIVE=1' }, async () => {
  const round = currentRound() - 5;
  const sig = await fetchSignature(round);
  assert.ok(sig);
  assert.equal(verifyBeaconSignature(round, sig), true);
});

test('seals on quicknet and opens after the round', { skip: !live && 'set LOCKRA_LIVE=1', timeout: 60_000 }, async () => {
  const capsule = await seal('live test', { unlockIn: 6 });
  assert.equal((await open(capsule)).status, 'sealed');
  const r = await open(capsule, { wait: true, timeoutMs: 45_000 });
  assert.equal(r.status, 'opened');
  assert.equal(r.message, 'live test');
});
