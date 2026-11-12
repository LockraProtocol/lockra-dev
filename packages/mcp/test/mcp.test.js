import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, SUPPORTED_PROTOCOL_VERSIONS } from '../src/server.js';
import { createBeacon } from '../../sdk/test/helpers.js';

let nextId = 1;
const req = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, params });
const call = (server, name, args) => server.handle(req('tools/call', { name, arguments: args }));

function setup() {
  const beacon = createBeacon();
  const server = createServer({ sdkOptions: { chain: beacon.chain, fetch: beacon.fetch } });
  return { beacon, server };
}

describe('protocol', () => {
  test('initialize negotiates the protocol version', async () => {
    const { server } = setup();
    const r = await server.handle(req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    assert.equal(r.result.protocolVersion, '2025-03-26');
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.result.serverInfo.name, 'lockra-mcp');
    assert.ok(r.result.instructions.includes('seal_capsule'));

    const future = await server.handle(req('initialize', { protocolVersion: '2099-01-01' }));
    assert.equal(future.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  test('lists three tools with schemas and annotations', async () => {
    const { server } = setup();
    const { result } = await server.handle(req('tools/list'));
    assert.deepEqual(result.tools.map((t) => t.name), ['seal_capsule', 'open_capsule', 'inspect_capsule']);
    for (const t of result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.outputSchema.type, 'object');
      assert.ok(t.description.length > 40);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
    }
  });

  test('ping, notifications and unknown methods', async () => {
    const { server } = setup();
    assert.deepEqual((await server.handle(req('ping'))).result, {});
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await server.handle(req('does/not/exist'))).error.code, -32601);
    assert.equal((await server.handle(req('tools/call', { name: 'nope', arguments: {} }))).error.code, -32602);
    assert.equal((await server.handle({ id: 1, method: 'ping' })).error.code, -32600);
  });

  test('malformed JSON yields a parse error', async () => {
    const { server } = setup();
    assert.equal(JSON.parse(await server.handleLine('{oops')).error.code, -32700);
    assert.equal(await server.handleLine('   '), null);
  });
});

describe('tools', () => {
  test('seal, inspect and open a capsule', async () => {
    const { beacon, server } = setup();
    const sealed = (await call(server, 'seal_capsule', { message: 'agent prediction', unlock_in_seconds: 120, label: 'Call', by: 'agent' })).result;
    assert.equal(sealed.isError, false);
    const { link, round, unlock_at } = sealed.structuredContent;
    assert.match(link, /^https:\/\/lockra\.buzz\/#l=Call&by=agent&c=/);
    assert.ok(sealed.content[0].text.includes(link));

    const info = (await call(server, 'inspect_capsule', { capsule: link })).result.structuredContent;
    assert.deepEqual({ round: info.round, unlock_at: info.unlock_at, unlocked: info.unlocked, label: info.label }, { round, unlock_at, unlocked: false, label: 'Call' });

    const early = (await call(server, 'open_capsule', { capsule: link })).result;
    assert.equal(early.structuredContent.status, 'sealed');
    assert.ok(early.structuredContent.seconds_left > 100);
    assert.match(early.content[0].text, /^Still sealed\. It unlocks at \S+, in (1m 5\ds|2m|2m [1-3]s) \(drand round \d+\)/);
    assert.equal(JSON.stringify(early).includes('agent prediction'), false);

    beacon.state.published = Infinity;
    const opened = (await call(server, 'open_capsule', { capsule: link })).result;
    assert.equal(opened.structuredContent.status, 'opened');
    assert.equal(opened.structuredContent.message, 'agent prediction');
    assert.ok(opened.content[0].text.endsWith('agent prediction'));
  });

  test('open_capsule waits when asked', async () => {
    const { beacon, server } = setup();
    const { link } = (await call(server, 'seal_capsule', { message: 'soon', unlock_in_seconds: 5 })).result.structuredContent;
    setTimeout(() => (beacon.state.published = Infinity), 300);
    const r = (await call(server, 'open_capsule', { capsule: link, wait_seconds: 10 })).result;
    assert.equal(r.structuredContent.message, 'soon');
  });

  test('open_capsule reports sealed when the wait runs out', async () => {
    const { server } = setup();
    const { link } = (await call(server, 'seal_capsule', { message: 'later', unlock_in_seconds: 3600 })).result.structuredContent;
    const r = (await call(server, 'open_capsule', { capsule: link, wait_seconds: 0.05 })).result;
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.status, 'sealed');
  });

  test('bad input becomes a tool error the model can read', async () => {
    const { server } = setup();
    const cases = [
      ['seal_capsule', { message: 'x' }, /exactly one of/],
      ['seal_capsule', { message: 'x', unlock_at: '2020-01-01T00:00:00Z' }, /future.*INVALID_ARGUMENT/],
      ['seal_capsule', { message: 42, unlock_in_seconds: 60 }, /"message" must be a string/],
      ['seal_capsule', { unlock_in_seconds: 60 }, /"message" is required/],
      ['open_capsule', { capsule: 'not a capsule' }, /INVALID_CAPSULE/],
      ['open_capsule', { capsule: 'x', wait_seconds: 9999 }, /between 0 and 300/],
      ['inspect_capsule', {}, /"capsule" is required/],
    ];
    for (const [name, args, pattern] of cases) {
      const r = (await call(server, name, args)).result;
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(r.content[0].text, pattern);
    }
  });

  test('a tampered label is reported, not hidden', async () => {
    const { beacon, server } = setup();
    beacon.state.published = Infinity;
    const { link } = (await call(server, 'seal_capsule', { message: 'x', unlock_in_seconds: 60, label: 'Real' })).result.structuredContent;
    const r = (await call(server, 'open_capsule', { capsule: link.replace('l=Real', 'l=Fake') })).result;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /TAMPERED/);
  });
});

test('stdio binary speaks MCP end to end', async () => {
  const bin = fileURLToPath(new URL('../bin/lockra-mcp.js', import.meta.url));
  const child = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'seal_capsule', arguments: { message: 'over stdio', unlock_at: '2030-01-01T00:00:00Z' } } });
  child.stdin.end();
  const code = await new Promise((r) => child.on('close', r));

  assert.equal(code, 0);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(lines.length, 3);
  assert.equal(byId[1].result.serverInfo.name, 'lockra-mcp');
  assert.equal(byId[2].result.tools.length, 3);
  assert.equal(byId[3].result.isError, false);
  assert.match(byId[3].result.structuredContent.unlock_at, /^2030-01-01T00:00:0\d\.000Z$/);
});
