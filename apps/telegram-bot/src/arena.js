// LOCKRA Arena alerts: posts new games, matches and results from the Arena contract to the group,
// and keeps a small all-time board for /arena. Off until ARENA_ADDRESS is set.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const TOPICS = {
  created: '0x6200407c0ea392b8107b21a9be480acd41fda186d04bed28cc7da2d4b53d56e2',
  joined: '0x48bba6a72d4a9fae48e2469ce99518c38afec785fa4f3df38a1a76b03a979537',
  revealed: '0xdd17665bf97c2a169e97f4f62f36023bf40807eb797a922864394a910d5c37c8',
  won: '0x73b46393f8abd41012f165e2945572f23f4c636a7d2f7c1f0856718acaa46c6d',
  drawn: '0x4a08cf13c7203fa768acdfaf086e73d97f5f70bc438fd2f9a6c35cb03f3b25c4',
};
const MOVES = ['', '✊ Rock', '✋ Paper', '✌️ Scissors'];

const word = (data, i) => '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const big = (h) => BigInt(h);
const addr = (topic) => '0x' + topic.slice(-40).toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** 123456000000000000000000n → "123,456" */
export function fmt(units, decimals = 18) {
  const base = 10n ** BigInt(decimals);
  const whole = (units / base).toLocaleString('en-US');
  const frac = ((units % base) * 100n / base).toString().padStart(2, '0').replace(/0+$/, '');
  return frac && units < 1000n * base ? `${whole}.${frac}` : whole;
}

/** Turn raw logs into arena events, in chain order. Moves revealed in the same batch are attached to results. */
export function parseLogs(logs) {
  const moves = new Map();
  for (const l of logs) if (l.topics[0] === TOPICS.revealed) {
    const id = String(big(l.topics[1]));
    (moves.get(id) || moves.set(id, {}).get(id))[addr(l.topics[2])] = Number(big(word(l.data, 0)));
  }
  const out = [];
  for (const l of logs) {
    const t = l.topics[0];
    const id = String(big(l.topics[1] || '0x0'));
    const base = { id, tx: l.transactionHash };
    if (t === TOPICS.created) out.push({ ...base, type: 'created', host: addr(l.topics[2]), invited: addr(l.topics[3]), stake: big(word(l.data, 0)) });
    else if (t === TOPICS.joined) out.push({ ...base, type: 'joined', challenger: addr(l.topics[2]), deadline: Number(big(word(l.data, 0))) });
    else if (t === TOPICS.won) out.push({ ...base, type: 'won', winner: addr(l.topics[2]), loser: addr(l.topics[3]), payout: big(word(l.data, 0)), burned: big(word(l.data, 1)), moves: moves.get(id) || {} });
    else if (t === TOPICS.drawn) out.push({ ...base, type: 'drawn', moves: moves.get(id) || {} });
  }
  return out;
}

export function message(ev, { site, explorer, symbol = '$LOCKRA', stakes = new Map() }) {
  const link = (a) => explorer ? `<a href="${explorer}/address/${a}">${short(a)}</a>` : short(a);
  const tx = explorer ? ` · <a href="${explorer}/tx/${ev.tx}">tx</a>` : '';
  const play = { text: '⚔️ Open the Arena', url: `${site}?game=${ev.id}` };
  if (ev.type === 'created') {
    const open = ev.invited === ZERO;
    return {
      html: [`⚔️ <b>New Arena challenge #${ev.id}</b>`, '', `${link(ev.host)} put <b>${fmt(ev.stake)} ${symbol}</b> on the line.`, open ? 'Rock, paper or scissors. Who takes it? 👀' : `Private duel: only ${link(ev.invited)} can accept.`, '', `<i>Moves are sealed until both reveal. Winner takes the pot.</i>${tx}`].join('\n'),
      buttons: [[{ text: open ? '🎮 Accept the challenge' : '👀 Watch the duel', url: `${site}?game=${ev.id}` }]],
    };
  }
  if (ev.type === 'joined') {
    const stake = stakes.get(ev.id);
    return {
      html: [`🤝 <b>Challenge #${ev.id} accepted</b>`, '', `${link(ev.challenger)} stepped into the Arena${stake ? ` with <b>${fmt(stake)} ${symbol}</b>` : ''}.`, 'Both moves are sealed. Reveal time ⏳' + tx].join('\n'),
      buttons: [[play]],
    };
  }
  if (ev.type === 'won') {
    const mw = MOVES[ev.moves[ev.winner]] || '', ml = MOVES[ev.moves[ev.loser]] || '';
    return {
      html: [`🏆 <b>Arena #${ev.id}: we have a winner</b>`, '', mw && ml ? `${mw} beats ${ml}` : null, `${link(ev.winner)} takes <b>${fmt(ev.payout)} ${symbol}</b>`, ev.burned > 0n ? `🔥 <b>${fmt(ev.burned)} ${symbol}</b> burned forever` : null, tx ? tx.slice(3) : null].filter((l) => l != null).join('\n'),
      buttons: [[{ text: '⚔️ Play in the Arena', url: site }]],
    };
  }
  if (ev.type === 'drawn') {
    const m = Object.values(ev.moves)[0];
    return {
      html: [`🤝 <b>Arena #${ev.id}: draw</b>`, '', m ? `Both picked ${MOVES[m]}.` : 'Same move on both sides.', 'Each player gets the full stake back. No fee.' + tx].join('\n'),
      buttons: [[{ text: '⚔️ Rematch in the Arena', url: site }]],
    };
  }
  return null;
}

export function arenaFile(path) {
  let data = null; let chain = Promise.resolve();
  return {
    async load() {
      if (data) return data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || !data.players) data = { next: null, games: 0, burned: '0', stakes: {}, players: {} };
      return data;
    },
    save() {
      chain = chain.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); });
      return chain;
    },
  };
}
export function memoryArenaFile() { const d = { next: null, games: 0, burned: '0', stakes: {}, players: {} }; return { load: async () => d, save: async () => {} }; }

/**
 * @param {{ address: string, rpc: Function, file: object, chats: string[], send: Function, site?: string, explorer?: string, log?: Function, maxRange?: number }} o
 */
export function createArena(o) {
  const site = o.site || 'https://lockra.buzz/arena';
  const log = o.log || (() => {});
  const address = o.address.toLowerCase();

  async function tick() {
    const d = await o.file.load();
    const head = Number(BigInt(await o.rpc('eth_blockNumber', [])));
    if (d.next == null) { d.next = head + 1; await o.file.save(); return 0; } // start from now, no backfill
    if (head < d.next) return 0;
    const to = Math.min(head, d.next + (o.maxRange || 2000) - 1);
    const logs = await o.rpc('eth_getLogs', [{ address, topics: [[TOPICS.created, TOPICS.joined, TOPICS.revealed, TOPICS.won, TOPICS.drawn]], fromBlock: '0x' + d.next.toString(16), toBlock: '0x' + to.toString(16) }]);
    const events = parseLogs(logs);
    const stakes = new Map(Object.entries(d.stakes).map(([k, v]) => [k, BigInt(v)]));
    let sent = 0;
    for (const ev of events) {
      if (ev.type === 'created') { stakes.set(ev.id, ev.stake); d.stakes[ev.id] = String(ev.stake); }
      if (ev.type === 'won') {
        d.games += 1; d.burned = String(BigInt(d.burned) + ev.burned);
        const w = d.players[ev.winner] || (d.players[ev.winner] = { wins: 0, losses: 0, won: '0' });
        const l = d.players[ev.loser] || (d.players[ev.loser] = { wins: 0, losses: 0, won: '0' });
        w.wins += 1; w.won = String(BigInt(w.won) + ev.payout); l.losses += 1;
        delete d.stakes[ev.id];
      }
      if (ev.type === 'drawn') { d.games += 1; delete d.stakes[ev.id]; }
      const m = message(ev, { site, explorer: o.explorer, stakes });
      if (!m) continue;
      for (const chat of o.chats) await o.send(chat, m.html, m.buttons).then(() => { sent += 1; }).catch((e) => log(`arena send to ${chat} failed: ${e.message}`));
    }
    d.next = to + 1;
    await o.file.save();
    return sent;
  }

  async function board() {
    const d = await o.file.load();
    const rows = Object.entries(d.players).sort((a, b) => b[1].wins - a[1].wins || (BigInt(b[1].won) > BigInt(a[1].won) ? 1 : -1)).slice(0, 10);
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return [
      '⚔️ <b>LOCKRA Arena</b>', '',
      `🎮 ${d.games} game${d.games === 1 ? '' : 's'} played · 🔥 ${fmt(BigInt(d.burned))} $LOCKRA burned`, '',
      rows.length ? rows.map(([a, p], i) => `${medal(i)} <code>${short(a)}</code> · ${p.wins}W ${p.losses}L · ${fmt(BigInt(p.won))} won`).join('\n') : 'No games yet. Be the first champion!',
    ].join('\n');
  }

  async function run({ signal, intervalMs = 5000 } = {}) {
    while (!signal?.aborted) {
      await tick().catch((e) => log(`arena: ${e.message}`));
      await new Promise((res) => { const t = setTimeout(res, intervalMs); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    }
  }

  return { tick, board, run, site };
}
