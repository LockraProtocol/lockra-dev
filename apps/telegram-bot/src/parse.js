// Parsing of user input: unlock times and capsule links.

const UNITS = {
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
  mo: 2629800, month: 2629800, months: 2629800,
  y: 31557600, yr: 31557600, year: 31557600, years: 31557600,
};

export const MIN_SECONDS = 60;
export const MAX_SECONDS = 100 * 31557600;

/**
 * Parse an unlock time token.
 * Accepts durations ("30m", "2h", "7d", "2w", "3mo", "1y") and UTC dates
 * ("2027-01-01", "2027-01-01T18:30"). Returns the unlock Date, or an error message.
 *
 * @param {string} token
 * @param {number} [now] epoch ms
 * @returns {{ date: Date } | { error: string }}
 */
export function parseWhen(token, now = Date.now()) {
  const t = String(token || '').trim().toLowerCase();
  const dur = /^(\d{1,6})\s*([a-z]+)$/.exec(t);
  let ms;
  if (dur && UNITS[dur[2]]) {
    ms = now + Number(dur[1]) * UNITS[dur[2]] * 1000;
  } else if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2}(:\d{2})?)?$/.test(t)) {
    ms = Date.parse(t.length === 10 ? `${t}T00:00:00Z` : `${t.toUpperCase()}Z`);
    if (!Number.isFinite(ms)) return { error: 'That date does not exist.' };
  } else {
    return { error: 'I did not understand when it should open. Use something like 30m, 2h, 7d, 3mo, 1y or a date like 2027-01-01.' };
  }
  const secs = (ms - now) / 1000;
  if (secs < MIN_SECONDS) return { error: 'The unlock time must be at least 1 minute in the future.' };
  if (secs > MAX_SECONDS) return { error: 'The unlock time can be at most 100 years away.' };
  return { date: new Date(ms) };
}

/** Find the first lockra.buzz capsule link (or bare token) in a piece of text. */
export function findCapsule(text) {
  if (!text) return null;
  const link = /https?:\/\/(?:www\.)?lockra\.buzz\/[^\s#]*#[^\s]*\bc=[A-Za-z0-9_-]+[^\s]*/i.exec(text);
  if (link) return link[0];
  const bare = /\b[A-Za-z0-9_-]{220,}\b/.exec(text);
  return bare ? bare[0] : null;
}

/** Split "/command@bot rest" into its parts. Returns null for non-commands. */
export function parseCommand(text, botUsername) {
  const m = /^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { name: m[1].toLowerCase(), args: (m[3] || '').trim() };
}

/** Human readable "in 2d 3h". */
export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const units = [['y', 31557600], ['d', 86400], ['h', 3600], ['m', 60]];
  const parts = [];
  let rest = s;
  for (const [u, n] of units) {
    if (rest >= n && parts.length < 2) {
      parts.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
  }
  return parts.length ? parts.join(' ') : `${s}s`;
}

/** "Mon, 01 Jun 2027 00:00 UTC" */
export const formatDate = (d) => d.toUTCString().replace(/:\d{2} GMT$/, ' UTC');
