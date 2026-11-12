import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  seal,
  open,
  inspect,
  sealFile,
  openFile,
  toLink,
  parseCapsule,
  roundAt,
  timeOfRound,
  currentRound,
  walletMessage,
  attachSignature,
  fetchSignature,
  verifyBeaconSignature,
  LockraError,
  QUICKNET,
  MAX_MESSAGE_LENGTH,
} from '../src/index.js';
import { secp256k1 } from '../src/vendor/curves/secp256k1.js';
import { keccak_256 } from '../src/vendor/hashes/sha3.js';
import { hex, utf8, cat } from '../src/bytes.js';
import { createBeacon, inAMinute } from './helpers.js';

const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof LockraError && e.code === code);
const throwsWith = (fn, code) => assert.throws(fn, (e) => e instanceof LockraError && e.code === code);

describe('seal and open', () => {
  test('stays sealed before the round, opens after it', async () => {
    const b = createBeacon();
    const capsule = await seal('BTC 150k by summer', { unlockAt: inAMinute(), label: 'My call', by: 'anon', chain: b.chain });

    assert.match(capsule.link, /^https:\/\/lockra\.buzz\/#l=My\+call&by=anon&c=[A-Za-z0-9_-]+$/);
    assert.equal(capsule.round, roundAt(capsule.unlockAt.getTime() / 1000, b.chain));

    const before = await open(capsule.link, { chain: b.chain, fetch: b.fetch });
    assert.equal(before.status, 'sealed');
    assert.ok(before.secondsLeft > 0 && before.secondsLeft <= 63);
    assert.equal(before.label, 'My call');

    b.state.published = Infinity;
    const after = await open(capsule.link, { chain: b.chain, fetch: b.fetch });
    assert.equal(after.status, 'opened');
    assert.equal(after.message, 'BTC 150k by summer');
    assert.equal(after.by, 'anon');
    assert.equal(after.file, null);
    assert.ok(after.sealedAt instanceof Date);
  });

  test('accepts unlockIn, ISO strings and epoch milliseconds', async () => {
    const b = createBeacon();
    const t = Date.now() + 120_000;
    for (const opts of [{ unlockIn: 120 }, { unlockAt: new Date(t).toISOString() }, { unlockAt: t }]) {
      const c = await seal('x', { ...opts, chain: b.chain });
      assert.ok(Math.abs(c.unlockAt.getTime() - t) < 5000);
    }
  });

  test('unicode and long messages survive the round trip', async () => {
    const b = createBeacon();
    b.state.published = Infinity;
    const message = '🔒 Ñandú — 時間 ' + 'a'.repeat(MAX_MESSAGE_LENGTH - 20);
    const c = await seal(message, { unlockIn: 30, chain: b.chain });
    assert.equal((await open(c, { chain: b.chain, fetch: b.fetch })).message, message);
  });

  test('every capsule is unique even for identical input', async () => {
    const b = createBeacon();
    const at = inAMinute();
    const [x, y] = await Promise.all([seal('same', { unlockAt: at, chain: b.chain }), seal('same', { unlockAt: at, chain: b.chain })]);
    assert.notEqual(x.token, y.token);
  });

  test('rejects invalid arguments', async () => {
    const b = createBeacon();
    await rejectsWith(seal('', { unlockIn: 60, chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { unlockIn: 60, unlockAt: inAMinute(), chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { unlockAt: new Date(Date.now() - 1000), chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { unlockAt: 'not a date', chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x'.repeat(MAX_MESSAGE_LENGTH + 1), { unlockIn: 60, chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { unlockIn: 60, label: 'l'.repeat(81), chain: b.chain }), 'INVALID_ARGUMENT');
    await rejectsWith(seal('x', { unlockIn: 60, by: 'b'.repeat(41), chain: b.chain }), 'INVALID_ARGUMENT');
  });
});

describe('integrity', () => {
  test('changing the public label or signer name breaks decryption', async () => {
    const b = createBeacon();
    b.state.published = Infinity;
    const c = await seal('secret', { unlockIn: 60, label: 'Original', by: 'alice', chain: b.chain });
    await rejectsWith(open({ ...c, label: 'Forged' }, { chain: b.chain, fetch: b.fetch }), 'TAMPERED');
    await rejectsWith(open(c.link.replace('by=alice', 'by=mallory'), { chain: b.chain, fetch: b.fetch }), 'TAMPERED');
  });

  test('flipping a ciphertext byte is detected', async () => {
    const b = createBeacon();
    b.state.published = Infinity;
    const c = await seal('secret', { unlockIn: 60, chain: b.chain });
    const last = c.token.at(-2) === 'A' ? 'B' : 'A';
    const forged = c.token.slice(0, -2) + last + c.token.at(-1);
    await rejectsWith(open(forged, { chain: b.chain, fetch: b.fetch }), 'TAMPERED');
  });

  test('a signature for another round cannot open the capsule', async () => {
    const b = createBeacon();
    const c = await seal('secret', { unlockIn: 60, chain: b.chain });
    await rejectsWith(open(c, { chain: b.chain, signature: b.sign(c.round - 1) }), 'BAD_SIGNATURE');
    await rejectsWith(open(c, { chain: b.chain, signature: 'zz' }), 'BAD_SIGNATURE');
  });

  test('a capsule sealed to another beacon cannot be opened', async () => {
    const a = createBeacon();
    const other = createBeacon();
    const c = await seal('secret', { unlockIn: 60, chain: a.chain });
    await rejectsWith(open(c, { chain: a.chain, signature: other.sign(c.round) }), 'BAD_SIGNATURE');
  });
});

describe('beacon relays', () => {
  test('signatures are verified against the beacon public key', () => {
    const b = createBeacon();
    const other = createBeacon();
    assert.equal(verifyBeaconSignature(42, b.sign(42), b.chain), true);
    assert.equal(verifyBeaconSignature(43, b.sign(42), b.chain), false);
    assert.equal(verifyBeaconSignature(42, other.sign(42), b.chain), false);
    assert.equal(verifyBeaconSignature(42, 'not hex', b.chain), false);
  });

  test('a lying relay is skipped and the next one is used', async () => {
    const b = createBeacon();
    const other = createBeacon();
    b.state.published = Infinity;
    b.state.overrides.set('https://relay-a.test', (round) => Response.json({ round, signature: other.sign(round) }));
    assert.equal(await fetchSignature(7, { chain: b.chain, fetch: b.fetch }), b.sign(7));
  });

  test('reports BEACON_UNREACHABLE when every relay fails', async () => {
    const b = createBeacon();
    const fail = () => new Response('down', { status: 503 });
    b.state.overrides.set('https://relay-a.test', fail);
    b.state.overrides.set('https://relay-b.test', fail);
    await rejectsWith(fetchSignature(7, { chain: b.chain, fetch: b.fetch }), 'BEACON_UNREACHABLE');
  });

  test('wait: true resolves once the round is published', async () => {
    const b = createBeacon({ period: 1 });
    const c = await seal('wait for me', { unlockIn: 2, chain: b.chain });
    setTimeout(() => (b.state.published = Infinity), 1200);
    const waits = [];
    const r = await open(c, { chain: b.chain, fetch: b.fetch, wait: true, onWait: (w) => waits.push(w) });
    assert.equal(r.status, 'opened');
    assert.equal(r.message, 'wait for me');
    assert.ok(waits.length >= 1);
  });

  test('wait: true honours timeoutMs', async () => {
    const b = createBeacon();
    const c = await seal('never', { unlockIn: 3600, chain: b.chain });
    await rejectsWith(open(c, { chain: b.chain, fetch: b.fetch, wait: true, timeoutMs: 50 }), 'TIMEOUT');
  });
});

describe('links and inspection', () => {
  test('parses links, bare tokens, objects and the JSON form', async () => {
    const b = createBeacon();
    const c = await seal('x', { unlockIn: 60, label: 'L & = #', by: 'me', chain: b.chain });
    const forms = [c.link, c.token, c, JSON.stringify({ c: c.token, l: c.label, by: c.by }), `  ${c.link}\n`];
    for (const f of forms) assert.equal(parseCapsule(f).token, c.token);
    assert.deepEqual(parseCapsule(c.link), { token: c.token, label: 'L & = #', by: 'me' });
    assert.equal(toLink(parseCapsule(c.link)), c.link);
    assert.equal(toLink(c, 'https://example.com/app?x=1#old'), `https://example.com/app?x=1#${c.link.split('#')[1]}`);
  });

  test('rejects things that are not capsules', () => {
    for (const bad of ['', '   ', 'https://lockra.buzz/', 'https://lockra.buzz/#foo=bar', 'hello world', 'AAAA', '{"x":1}', 42, null, {}]) {
      throwsWith(() => inspect(bad), 'INVALID_CAPSULE');
    }
  });

  test('inspect shows public details without decrypting', async () => {
    const b = createBeacon();
    const c = await seal('hidden', { unlockIn: 600, label: 'Public', chain: b.chain });
    const info = inspect(c.link, { chain: b.chain });
    assert.equal(info.round, c.round);
    assert.equal(info.unlocked, false);
    assert.equal(info.label, 'Public');
    assert.equal(info.wallet, null);
    assert.equal(JSON.stringify(info).includes('hidden'), false);
  });

  test('round maths matches the beacon schedule', () => {
    const t = QUICKNET.genesis + 3 * 1000;
    assert.equal(roundAt(t), 1001);
    assert.equal(timeOfRound(1001), t);
    assert.equal(roundAt(t + 1), 1002);
    assert.ok(timeOfRound(currentRound()) <= Date.now() / 1000);
    assert.ok(timeOfRound(currentRound() + 1) > Date.now() / 1000);
  });
});

describe('sealed files', () => {
  test('round trip of a .lockra file', async () => {
    const b = createBeacon();
    const data = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 2654435761) >>> 24);
    const { capsule, file } = await sealFile(data, { name: 'report.pdf', type: 'application/pdf', message: 'read this', unlockIn: 60, label: 'Q4', chain: b.chain });

    assert.equal(new TextDecoder().decode(file.subarray(0, 8)), 'LOCKRA2\n');
    assert.equal(inspect(file, { chain: b.chain }).round, capsule.round);
    assert.equal((await openFile(file, { chain: b.chain, fetch: b.fetch })).status, 'sealed');

    b.state.published = Infinity;
    const r = await openFile(file, { chain: b.chain, fetch: b.fetch });
    assert.equal(r.status, 'opened');
    assert.equal(r.message, 'read this');
    assert.equal(r.file.name, 'report.pdf');
    assert.equal(r.file.type, 'application/pdf');
    assert.deepEqual(r.file.data, data);

    const viaLink = await open(capsule.link, { chain: b.chain, fetch: b.fetch });
    assert.deepEqual(viaLink.file, { name: 'report.pdf', type: 'application/pdf', size: data.length });
  });

  test('detects altered file bytes', async () => {
    const b = createBeacon();
    b.state.published = Infinity;
    const { file } = await sealFile(new Uint8Array([1, 2, 3]), { name: 'a.bin', unlockIn: 60, chain: b.chain });
    file[file.length - 1] ^= 1;
    await rejectsWith(openFile(file, { chain: b.chain, fetch: b.fetch }), 'TAMPERED');
  });

  test('rejects non-.lockra input and missing names', async () => {
    const b = createBeacon();
    await rejectsWith(openFile(new Uint8Array(40), { chain: b.chain, fetch: b.fetch }), 'INVALID_CAPSULE');
    await rejectsWith(sealFile(new Uint8Array(1), { unlockIn: 60, chain: b.chain }), 'INVALID_ARGUMENT');
  });
});

describe('wallet signatures', () => {
  const sk = secp256k1.utils.randomPrivateKey();
  const address = '0x' + hex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20));
  const personalSign = (message) => {
    const m = utf8(message);
    const digest = keccak_256(cat(utf8(`\x19Ethereum Signed Message:\n${m.length}`), m));
    const s = secp256k1.sign(digest, sk);
    return '0x' + hex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
  };

  test('a valid signature is attached and verified', async () => {
    const b = createBeacon();
    const c = await seal('signed call', { unlockIn: 60, label: 'Call', by: 'me', chain: b.chain });
    const signed = attachSignature(c, { address, signature: personalSign(walletMessage(c)) }, { chain: b.chain });
    assert.match(signed.link, /&a=0x[0-9a-f]{40}&s=0x[0-9a-f]{130}&c=/);
    assert.deepEqual(inspect(signed.link, { chain: b.chain }).wallet, { address, verified: true });
  });

  test('a signature cannot be moved to another capsule', async () => {
    const b = createBeacon();
    const c1 = await seal('one', { unlockIn: 60, chain: b.chain });
    const c2 = await seal('two', { unlockIn: 60, chain: b.chain });
    const sig = personalSign(walletMessage(c1));
    throwsWith(() => attachSignature(c2, { address, signature: sig }), 'BAD_SIGNATURE');
    const forged = toLink({ ...c2, address, signature: sig });
    assert.deepEqual(inspect(forged, { chain: b.chain }).wallet, { address, verified: false });
  });
});
