// Minimal Telegram Bot API client with long polling. No dependencies.

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`${method} failed (${code}): ${description}`);
    this.name = 'TelegramError';
    this.code = code;
    this.description = description;
  }
}

/**
 * @param {{ token: string, fetch?: typeof fetch, baseUrl?: string }} options
 */
export function createTelegram({ token, fetch: doFetch = globalThis.fetch, baseUrl = 'https://api.telegram.org' }) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set.');

  async function call(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const res = await doFetch(`${baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TelegramError(method, res.status, 'invalid response');
    }
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'unknown error');
    return body.result;
  }

  /**
   * Long-poll for updates and hand each one to `onUpdate`. Resolves when `signal` aborts.
   * @param {(update: object) => Promise<void>} onUpdate
   * @param {{ signal?: AbortSignal, log?: (msg: string) => void }} [options]
   */
  async function poll(onUpdate, { signal, log = () => {} } = {}) {
    let offset = 0;
    let backoff = 1000;
    const running = new Set();
    while (!signal?.aborted) {
      let updates;
      try {
        updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, { timeoutMs: 65_000 });
        backoff = 1000;
      } catch (err) {
        if (signal?.aborted) break;
        if (err instanceof TelegramError && err.code === 409) log('Another instance of this bot is running (409). Retrying.');
        else log(`getUpdates failed: ${err.message}`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        const job = onUpdate(update)
          .catch((err) => log(`update ${update.update_id} failed: ${err?.stack ?? err}`))
          .finally(() => running.delete(job));
        running.add(job);
      }
    }
    await Promise.allSettled(running);
  }

  return { call, poll };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
