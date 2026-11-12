#!/usr/bin/env node
// LOCKRA MCP server over stdio. stdout carries protocol messages only; logs go to stderr.

import { createInterface } from 'node:readline';
import { createServer, SERVER_VERSION } from '../src/server.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}

const log = (msg) => process.stderr.write(`[lockra-mcp] ${msg}\n`);
const server = createServer({ log });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let pending = 0;
let closing = false;
const maybeExit = () => {
  if (closing && pending === 0) process.exit(0);
};

rl.on('line', (line) => {
  pending++;
  server
    .handleLine(line)
    .then((out) => {
      if (out) process.stdout.write(out + '\n');
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
});

rl.on('close', () => {
  closing = true;
  maybeExit();
});

log(`v${SERVER_VERSION} ready on stdio`);
