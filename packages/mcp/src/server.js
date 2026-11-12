// A dependency-free Model Context Protocol server (JSON-RPC 2.0) exposing the LOCKRA tools.
// Transport-agnostic: `handle()` takes one parsed message and returns the response (or null
// for notifications). See bin/lockra-mcp.js for the stdio transport.

import { LockraError } from 'lockra-sdk';
import { TOOLS, createHandlers, ToolInputError } from './tools.js';

export const SERVER_NAME = 'lockra-mcp';
export const SERVER_VERSION = '1.0.1';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'LOCKRA seals messages with timelock encryption backed by the drand threshold network. ' +
  'Use seal_capsule to lock a message until a future time and share the returned link; ' +
  'use open_capsule to read it after that time, and inspect_capsule to see its public details. ' +
  'Nobody can open a capsule early. Never seal seed phrases, private keys or passwords.';

const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * @param {{ sdkOptions?: object, log?: (msg: string) => void }} [options]
 */
export function createServer({ sdkOptions = {}, log = () => {} } = {}) {
  const handlers = createHandlers(sdkOptions);

  async function callTool(params) {
    const { name, arguments: args = {} } = params ?? {};
    const handler = typeof name === 'string' && Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return { unknown: true };
    if (!args || typeof args !== 'object' || Array.isArray(args)) return toolError('Tool arguments must be an object.');
    try {
      const { data, text } = await handler(args);
      return { result: { content: [{ type: 'text', text }], structuredContent: data, isError: false } };
    } catch (err) {
      if (err instanceof ToolInputError || err instanceof LockraError) return toolError(err.message, err.code);
      log(`tool ${name} failed: ${err?.stack ?? err}`);
      return toolError('Unexpected error while running the tool.');
    }
  }

  function toolError(message, code) {
    return { result: { content: [{ type: 'text', text: code ? `${message} (${code})` : message }], isError: true } };
  }

  /** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
  async function handle(msg) {
    if (Array.isArray(msg)) {
      if (msg.length === 0) return fail(null, ERR.INVALID_REQUEST, 'Empty batch');
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      return out.length ? out : null;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Responses from the client (we never send requests) and malformed input.
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
      return fail(msg?.id ?? null, ERR.INVALID_REQUEST, 'Invalid request');
    }
    const isNotification = !('id' in msg);
    const { id, method, params } = msg;

    if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'LOCKRA', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const r = await callTool(params);
        if (r.unknown) return fail(id, ERR.INVALID_PARAMS, `Unknown tool: ${params?.name}`);
        return ok(id, r.result);
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return fail(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** Handle one raw line of input. Returns the serialised response, or null. */
  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(fail(null, ERR.PARSE, 'Parse error'));
    }
    try {
      const res = await handle(msg);
      return res ? JSON.stringify(res) : null;
    } catch (err) {
      log(`internal error: ${err?.stack ?? err}`);
      return JSON.stringify(fail(msg?.id ?? null, ERR.INTERNAL, 'Internal error'));
    }
  }

  return { handle, handleLine };
}
