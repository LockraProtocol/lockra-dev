// Sealed predictions: a prediction is sealed in a private chat, announced in the community group,
// and revealed automatically in the group when its time comes. Nobody can read it before then,
// not even its author, so nobody can claim "I called it" after the fact.
//
// State is a small JSON file (PREDICTIONS_FILE). If it is lost (e.g. a redeploy without a volume),
// nothing breaks: every announcement carries the capsule link, so anyone can reply /open to it.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open } from 'lockra-sdk';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A tiny JSON-file store. `load` never throws: a missing or broken file starts empty. */
export function fileStore(path) {
  let items = null;
  const load = async () => {
    if (items) return items;
    try { items = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(items)) items = []; } catch { items = []; }
    return items;
  };
  const save = async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(items));
    await rename(tmp, path);
  };
  return {
    all: load,
    add: async (item) => { (await load()).push(item); await save(); },
    remove: async (link) => { items = (await load()).filter((x) => x.link !== link); await save(); },
  };
}

/** In-memory store, for tests. */
export function memoryStore() {
  let items = [];
  return { all: async () => items, add: async (x) => { items.push(x); }, remove: async (link) => { items = items.filter((x) => x.link !== link); } };
}

/**
 * Reveal predictions that have reached their time.
 * @param {{ call: Function, store: ReturnType<typeof fileStore>, now?: () => number, sdkOptions?: object, log?: Function, formatDate: Function }} o
 */
export function createRevealer({ call, store, now = Date.now, sdkOptions = {}, log = () => {}, formatDate }) {
  async function tick() {
    const due = (await store.all()).filter((p) => p.unlockAt <= now());
    for (const p of due) {
      let r;
      try {
        r = await open(p.link, sdkOptions);
      } catch (e) {
        log(`prediction ${p.link.slice(0, 40)}… not opened yet: ${e.message}`);
        continue; // drand unreachable or a moment early: try again next tick
      }
      if (r.status !== 'opened') continue;
      const text = [
        `🔓 <b>Prediction revealed</b>${p.by ? ` · by ${esc(p.by)}` : ''}`,
        `Sealed ${esc(formatDate(new Date(p.sealedAt)))}`,
        '',
        `<blockquote>${esc(r.message)}</blockquote>`,
        '',
        'Called it or missed it? 👇',
      ].join('\n');
      await call('sendMessage', {
        chat_id: p.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: p.messageId, allow_sending_without_reply: true },
        reply_markup: { inline_keyboard: [[{ text: 'Verify on lockra.buzz', url: p.link }]] },
      }).catch((e) => log(`reveal to ${p.chatId} failed: ${e.message}`));
      await store.remove(p.link);
    }
  }
  async function run({ signal, intervalMs = 30_000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`predictions: ${e.message}`));
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
        const t = setTimeout(done, intervalMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  return { tick, run };
}
