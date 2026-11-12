// The LOCKRA tools exposed to AI agents.

import { seal, open, inspect, LockraError, MAX_MESSAGE_LENGTH, MAX_LABEL_LENGTH, MAX_BY_LENGTH } from 'lockra-sdk';

export const MAX_WAIT_SECONDS = 300;

const capsuleProps = {
  link: { type: 'string', description: 'Shareable link. Anyone can open it on lockra.buzz once unlocked.' },
  round: { type: 'integer', description: 'drand round whose signature unlocks the capsule.' },
  unlock_at: { type: 'string', format: 'date-time', description: 'When the capsule unlocks (ISO 8601, UTC).' },
  label: { type: 'string' },
  by: { type: 'string' },
};

export const TOOLS = [
  {
    name: 'seal_capsule',
    title: 'Seal a time capsule',
    description:
      'Encrypt a message so that nobody (not the author, not LOCKRA, not this agent) can read it before a chosen time. ' +
      'Security comes from the drand threshold network: the key only exists once drand publishes the round for that time. ' +
      'Use it for predictions, commitments, sealed bids, time-released announcements or notes to the future. ' +
      'Returns a lockra.buzz link to share. Never seal seed phrases or private keys.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH, description: 'The secret text to seal.' },
        unlock_at: { type: 'string', format: 'date-time', description: 'When it may be opened, ISO 8601 (e.g. "2027-01-01T00:00:00Z"). Use this or unlock_in_seconds.' },
        unlock_in_seconds: { type: 'number', exclusiveMinimum: 0, description: 'Seconds from now until it may be opened. Use this or unlock_at.' },
        label: { type: 'string', maxLength: MAX_LABEL_LENGTH, description: 'Optional public title, visible before opening. Tamper-proof.' },
        by: { type: 'string', maxLength: MAX_BY_LENGTH, description: 'Optional public author name. Tamper-proof.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { ...capsuleProps, sealed_at: { type: 'string', format: 'date-time' } },
      required: ['link', 'round', 'unlock_at', 'label', 'by', 'sealed_at'],
    },
    annotations: { title: 'Seal a time capsule', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'open_capsule',
    title: 'Open a time capsule',
    description:
      'Try to open a LOCKRA capsule from its link or token. Before its unlock time it reports "sealed" and how long is left; ' +
      `after it, it returns the decrypted message. Set wait_seconds (max ${MAX_WAIT_SECONDS}) to wait for a capsule that unlocks soon.`,
    inputSchema: {
      type: 'object',
      properties: {
        capsule: { type: 'string', minLength: 1, description: 'A lockra.buzz capsule link or a bare capsule token.' },
        wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'Optionally wait up to this many seconds for the capsule to unlock.' },
      },
      required: ['capsule'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['sealed', 'opened'] },
        message: { type: 'string' },
        seconds_left: { type: 'integer' },
        sealed_at: { type: ['string', 'null'], format: 'date-time' },
        file: { type: ['object', 'null'], properties: { name: { type: 'string' }, type: { type: 'string' }, size: { type: 'integer' } } },
        wallet: { type: ['object', 'null'], properties: { address: { type: 'string' }, verified: { type: 'boolean' } } },
        round: capsuleProps.round,
        unlock_at: capsuleProps.unlock_at,
        label: capsuleProps.label,
        by: capsuleProps.by,
      },
      required: ['status', 'round', 'unlock_at', 'label', 'by'],
    },
    annotations: { title: 'Open a time capsule', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'inspect_capsule',
    title: 'Inspect a time capsule',
    description: 'Read the public details of a LOCKRA capsule (unlock time, label, author, wallet signature) without opening it. Works offline.',
    inputSchema: {
      type: 'object',
      properties: { capsule: { type: 'string', minLength: 1, description: 'A lockra.buzz capsule link or a bare capsule token.' } },
      required: ['capsule'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        round: capsuleProps.round,
        unlock_at: capsuleProps.unlock_at,
        unlocked: { type: 'boolean', description: 'Whether the unlock time has passed.' },
        label: capsuleProps.label,
        by: capsuleProps.by,
        wallet: { type: ['object', 'null'], properties: { address: { type: 'string' }, verified: { type: 'boolean' } } },
      },
      required: ['round', 'unlock_at', 'unlocked', 'label', 'by'],
    },
    annotations: { title: 'Inspect a time capsule', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const iso = (d) => d.toISOString();

function human(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (s || !m)) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Raised for bad tool input; reported to the model as a tool error it can fix. */
export class ToolInputError extends Error {}

function str(args, key, { required = false } = {}) {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string.`);
  return v;
}

function num(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolInputError(`"${key}" must be a number.`);
  return v;
}

/**
 * Create the tool handlers. `sdkOptions` is forwarded to every SDK call (used by tests to
 * point at a local beacon).
 */
export function createHandlers(sdkOptions = {}) {
  return {
    async seal_capsule(args) {
      const message = str(args, 'message', { required: true });
      const unlockAt = str(args, 'unlock_at');
      const unlockIn = num(args, 'unlock_in_seconds');
      if ((unlockAt === undefined) === (unlockIn === undefined)) throw new ToolInputError('Provide exactly one of "unlock_at" or "unlock_in_seconds".');
      const when = unlockAt !== undefined ? { unlockAt } : { unlockIn };
      const c = await seal(message, { ...when, label: str(args, 'label') ?? '', by: str(args, 'by') ?? '', ...sdkOptions });
      const data = { link: c.link, round: c.round, unlock_at: iso(c.unlockAt), label: c.label, by: c.by, sealed_at: new Date().toISOString() };
      const text =
        `Capsule sealed. It unlocks at ${data.unlock_at} (drand round ${c.round}).\n` +
        `Link: ${c.link}\n` +
        'Until then nobody can read it, including its author. Share the link; anyone can open it on lockra.buzz after the unlock time.';
      return { data, text };
    },

    async open_capsule(args) {
      const capsule = str(args, 'capsule', { required: true });
      const waitSeconds = num(args, 'wait_seconds') ?? 0;
      if (waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) throw new ToolInputError(`"wait_seconds" must be between 0 and ${MAX_WAIT_SECONDS}.`);
      let r;
      try {
        r = await open(capsule, { ...sdkOptions, wait: waitSeconds > 0, timeoutMs: waitSeconds * 1000 });
      } catch (err) {
        if (!(err instanceof LockraError && err.code === 'TIMEOUT')) throw err;
        r = await open(capsule, sdkOptions);
      }
      const base = { status: r.status, round: r.round, unlock_at: iso(r.unlockAt), label: r.label, by: r.by, wallet: r.wallet };
      if (r.status === 'sealed') {
        return {
          data: { ...base, seconds_left: r.secondsLeft },
          text: `Still sealed. It unlocks at ${base.unlock_at}, in ${human(r.secondsLeft)} (drand round ${r.round}). Nobody can read it before then.`,
        };
      }
      const data = { ...base, message: r.message, sealed_at: r.sealedAt ? iso(r.sealedAt) : null, file: r.file };
      const header = [r.label && `Label: ${r.label}`, r.by && `By: ${r.by}`, data.sealed_at && `Sealed at: ${data.sealed_at}`, r.wallet && `Wallet: ${r.wallet.address} (${r.wallet.verified ? 'signature verified' : 'signature INVALID'})`]
        .filter(Boolean)
        .join('\n');
      const fileNote = r.file ? `\nThis capsule also contains a sealed file (${r.file.name}, ${r.file.size} bytes); open the .lockra file on lockra.buzz to download it.` : '';
      return { data, text: `Capsule opened.${header ? '\n' + header : ''}\nMessage:\n${r.message}${fileNote}` };
    },

    async inspect_capsule(args) {
      const capsule = str(args, 'capsule', { required: true });
      const info = inspect(capsule, sdkOptions);
      const data = { round: info.round, unlock_at: iso(info.unlockAt), unlocked: info.unlocked, label: info.label, by: info.by, wallet: info.wallet };
      const lines = [
        `Unlocks at ${data.unlock_at} (drand round ${info.round}): ${info.unlocked ? 'unlock time has passed, it can be opened' : 'still sealed'}.`,
        info.label && `Label: ${info.label}`,
        info.by && `By: ${info.by}`,
        info.wallet && `Wallet: ${info.wallet.address} (${info.wallet.verified ? 'signature verified' : 'signature INVALID'})`,
      ];
      return { data, text: lines.filter(Boolean).join('\n') };
    },
  };
}
