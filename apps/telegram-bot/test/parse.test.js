import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, findCapsule, parseCommand, humanDuration, formatDate } from '../src/parse.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

test('parses durations', () => {
  const cases = { '30m': 1800, '2h': 7200, '7d': 604800, '2w': 1209600, '1y': 31557600, '90min': 5400, '3mo': 7889400 };
  for (const [input, secs] of Object.entries(cases)) {
    assert.equal(parseWhen(input, NOW).date.getTime(), NOW + secs * 1000, input);
  }
  assert.equal(parseWhen('2H', NOW).date.getTime(), NOW + 7_200_000);
});

test('parses UTC dates', () => {
  assert.equal(parseWhen('2027-01-01', NOW).date.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(parseWhen('2027-01-01T18:30', NOW).date.toISOString(), '2027-01-01T18:30:00.000Z');
});

test('rejects bad or out-of-range times', () => {
  for (const bad of ['', 'soon', '5x', '2027-13-45', '2027/01/01', '1s']) assert.ok('error' in parseWhen(bad, NOW), bad);
  assert.match(parseWhen('2020-01-01', NOW).error, /at least 1 minute/);
  assert.match(parseWhen('0m', NOW).error, /at least 1 minute/);
  assert.match(parseWhen('101y', NOW).error, /100 years/);
});

test('finds capsule links in text', () => {
  const link = 'https://lockra.buzz/#l=My+call&by=%40me&c=' + 'A'.repeat(260);
  assert.equal(findCapsule(`look at this ${link} 👀`), link);
  assert.equal(findCapsule(`https://www.lockra.buzz/open.html#c=${'b'.repeat(250)}`), `https://www.lockra.buzz/open.html#c=${'b'.repeat(250)}`);
  assert.equal(findCapsule('B'.repeat(300)), 'B'.repeat(300));
  assert.equal(findCapsule('https://lockra.buzz/ and nothing else'), null);
  assert.equal(findCapsule('https://evil.example/#c=' + 'A'.repeat(260)).length, 260);
  assert.equal(findCapsule(undefined), null);
});

test('parses commands, ignoring ones for other bots', () => {
  assert.deepEqual(parseCommand('/seal 30d hello world', 'LockraBot'), { name: 'seal', args: '30d hello world' });
  assert.deepEqual(parseCommand('/Open@lockrabot link', 'LockraBot'), { name: 'open', args: 'link' });
  assert.deepEqual(parseCommand('/help', 'LockraBot'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/seal 1d line one\nline two', 'x'), { name: 'seal', args: '1d line one\nline two' });
  assert.equal(parseCommand('/seal@OtherBot 1d hi', 'LockraBot'), null);
  assert.equal(parseCommand('hello /seal', 'LockraBot'), null);
});

test('formats durations and dates', () => {
  assert.equal(humanDuration(45), '45s');
  assert.equal(humanDuration(3600 * 26 + 60 * 5), '1d 2h');
  assert.equal(humanDuration(31557600 * 2 + 86400 * 3), '2y 3d');
  assert.equal(formatDate(new Date('2027-06-01T00:00:00Z')), 'Tue, 01 Jun 2027 00:00 UTC');
});
