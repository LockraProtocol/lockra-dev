// Sports fixtures and results for the Daily Prediction, from TheSportsDB (free public API).
// Only well-known competitions are used so the question is one the group cares about.

const BASE = 'https://www.thesportsdb.com/api/v1/json';

/** Competitions we pick from, by sport. The first match found in the list order wins. */
export const SPORTS = {
  football: {
    s: 'Soccer', emoji: '⚽', draw: true,
    leagues: ['4480', '4328', '4335', '4332', '4331', '4334', '4481'], // UCL, Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, Europa League
  },
  basketball: { s: 'Basketball', emoji: '🏀', draw: false, leagues: ['4387', '4966'] }, // NBA, EuroLeague
  tennis: { s: 'Tennis', emoji: '🎾', draw: false, leagues: null }, // any ATP/WTA match listed for the day
};

const finished = (e) => /^(FT|AET|PEN|Match Finished|Finished|AOT|After Over Time)$/i.test(String(e.strStatus || '').trim())
  || (e.intHomeScore != null && e.intAwayScore != null && e.intHomeScore !== '' && e.intAwayScore !== '' && /final|ended|ft/i.test(String(e.strProgress || e.strStatus || '')));

/**
 * @param {{ fetchFn?: Function, key?: string }} o
 */
export function createSports({ fetchFn = globalThis.fetch, key = process.env.SPORTSDB_KEY || '123' } = {}) {
  const get = async (path) => {
    const r = await fetchFn(`${BASE}/${key}/${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`sportsdb ${r.status}`);
    return r.json();
  };

  /** The best upcoming match of a sport for a UTC day (YYYY-MM-DD) that starts after `after` (ms). */
  async function pick(sport, day, after) {
    const cfg = SPORTS[sport];
    const j = await get(`eventsday.php?d=${day}&s=${encodeURIComponent(cfg.s)}`);
    const events = (j?.events || []).filter((e) => e.strHomeTeam && e.strAwayTeam && Date.parse(e.strTimestamp || `${e.dateEvent}T${e.strTime || '00:00:00'}Z`) > after);
    const rank = (e) => (cfg.leagues ? cfg.leagues.indexOf(String(e.idLeague)) : 0);
    const ok = events.filter((e) => rank(e) >= 0).sort((a, b) => rank(a) - rank(b));
    const e = ok[0];
    if (!e) return null;
    return {
      id: String(e.idEvent), sport, league: e.strLeague || '', home: e.strHomeTeam, away: e.strAwayTeam,
      startsAt: Date.parse(e.strTimestamp || `${e.dateEvent}T${e.strTime || '00:00:00'}Z`), draw: cfg.draw, emoji: cfg.emoji,
    };
  }

  /** 'h' home win, 'a' away win, 'e' draw (even), or null when not finished yet. */
  async function result(eventId) {
    const j = await get(`lookupevent.php?id=${encodeURIComponent(eventId)}`);
    const e = (j?.events || [])[0];
    if (!e || !finished(e)) return null;
    const h = Number(e.intHomeScore), a = Number(e.intAwayScore);
    if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
    return { outcome: h > a ? 'h' : a > h ? 'a' : 'e', score: `${h}–${a}` };
  }

  return { pick, result };
}
