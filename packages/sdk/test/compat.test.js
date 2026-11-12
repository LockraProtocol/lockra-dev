// Capsules produced by the lockra.buzz website must always open with the SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { open, openFile, inspect } from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/website-vectors.json', import.meta.url), 'utf8'));
const chain = vectors.chain;

test('opens a message capsule sealed by the website', async () => {
  const { link, round, signature, expected } = vectors.message;
  assert.equal(inspect(link, { chain }).round, round);
  const r = await open(link, { chain, signature });
  assert.equal(r.status, 'opened');
  assert.equal(r.message, expected);
  assert.equal(r.label, 'Site label');
});

test('opens a .lockra file sealed by the website', async () => {
  const { lockraBase64, signature, expected, name } = vectors.file;
  const r = await openFile(Buffer.from(lockraBase64, 'base64'), { chain, signature });
  assert.equal(new TextDecoder().decode(r.file.data), expected);
  assert.equal(r.file.name, name);
});
