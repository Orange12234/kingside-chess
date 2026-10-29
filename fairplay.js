'use strict';
// Fair-play checks. After a rated game ends, the server has Stockfish look at every move and works out
// each player's accuracy. A player whose recent rated games show BOTH a very high win rate AND very high
// accuracy is flagged: a report from "Fair-play system" lands in the moderators' and owner's report list.
// A flag is only a reason for a human to take a look. Nothing happens to the player automatically.
//
// Settings (environment variables, all optional):
//   FAIRPLAY=off            turn the whole thing off
//   FAIRPLAY_DEPTH=10       how deep Stockfish looks (higher = slower and more exact)
//   FAIRPLAY_MIN_GAMES=10   how many analysed rated games are needed before anyone can be flagged
//   FAIRPLAY_WIN_RATE=0.8   share of those games that were wins
//   FAIRPLAY_ACCURACY=92    average accuracy (0-100)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Chess } = require('chess.js');
const store = require('./db');

const ENABLED = process.env.FAIRPLAY !== 'off';
const DEPTH = Math.max(4, Math.min(20, Number(process.env.FAIRPLAY_DEPTH) || 10));
const MIN_GAMES = Math.max(3, Number(process.env.FAIRPLAY_MIN_GAMES) || 10);
const WIN_RATE = Number(process.env.FAIRPLAY_WIN_RATE) || 0.8;
const ACCURACY = Number(process.env.FAIRPLAY_ACCURACY) || 92;
const WINDOW = 30;               // looks at the most recent 30 analysed rated games
const MIN_PLIES = 20;            // very short games say nothing
const MIN_NEW_GAMES = 5;         // after a flag, wait for this many new games before flagging the same player again
const SYSTEM_NAME = 'Fair-play system';
const MATE_V = 10000;
const ABORT_LIMIT = Math.max(2, Number(process.env.FAIRPLAY_ABORT_LIMIT) || 5);   // aborts in 24 hours that raise a flag
const ABORT_WARN = ABORT_LIMIT - 2;                                                // the player is warned from here on
const DAY = 24 * 3600 * 1000;

const ENGINE_DIR = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
function enginePath() {
  try {
    const f = fs.readdirSync(ENGINE_DIR).find((n) => /^stockfish-[\d.]+-lite-single\.js$/.test(n));
    return f && fs.existsSync(path.join(ENGINE_DIR, f.replace(/\.js$/, '.wasm'))) ? path.join(ENGINE_DIR, f) : null;
  } catch (e) { return null; }
}

// Same formulas as the Game review page, so the numbers match what a moderator sees there.
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);
const moveAccuracy = (loss) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

// Ask Stockfish about every position; returns white's-point-of-view evaluations in centipawns.
function evaluatePositions(fens, depth, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'ignore'] });
    const evals = new Array(fens.length).fill(0);
    let buf = '';
    let i = -1;
    let score = null;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.write('quit\n'); } catch (e) { /* already gone */ }
      setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 300).unref();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Stockfish took too long')), 90 * 1000);
    const next = () => {
      i++;
      while (i < fens.length) {
        const c = new Chess(fens[i]);
        if (c.isCheckmate()) { evals[i] = c.turn() === 'w' ? -MATE_V : MATE_V; i++; continue; }   // the side to move has been mated
        if (c.isGameOver()) { evals[i] = 0; i++; continue; }
        break;
      }
      if (i >= fens.length) return finish(null, evals);
      score = 0;
      child.stdin.write('position fen ' + fens[i] + '\ngo depth ' + depth + '\n');
    };
    child.on('error', finish);
    child.on('exit', () => finish(new Error('Stockfish stopped')));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'uciok') { child.stdin.write('isready\n'); continue; }
        if (line === 'readyok') { next(); continue; }
        if (line.startsWith('info') && / score /.test(line) && !/ (lowerbound|upperbound) /.test(line)) {
          const m = /score (cp|mate) (-?\d+)/.exec(line);
          if (m) score = m[1] === 'cp' ? Number(m[2]) : (Number(m[2]) > 0 ? MATE_V : -MATE_V);
        } else if (line.startsWith('bestmove')) {
          const stm = new Chess(fens[i]).turn();
          evals[i] = stm === 'w' ? score : -score;
          next();
        }
      }
    });
    child.stdin.write('uci\n');
  });
}

// Each side's average accuracy for a game given as a list of SAN moves, or null if the game is too short.
async function analyzeMoves(sanMoves, depth = DEPTH) {
  if (!sanMoves || sanMoves.length < MIN_PLIES) return null;
  const file = enginePath();
  if (!file) throw new Error('Stockfish is not installed');
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const san of sanMoves) { chess.move(san); fens.push(chess.fen()); }
  const evals = await evaluatePositions(fens, depth, file);
  const acc = { w: [], b: [] };
  for (let ply = 1; ply < fens.length; ply++) {
    const mover = fens[ply - 1].split(' ')[1];
    const before = winPct(evals[ply - 1]);
    const after = winPct(evals[ply]);
    const loss = Math.max(0, mover === 'w' ? before - after : after - before);
    acc[mover].push(moveAccuracy(loss));
  }
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return { w: mean(acc.w), b: mean(acc.b) };
}

// The numbers behind a flag for one player, or null when there is not enough data yet.
function summarize(userId) {
  const rows = store.analyzedGamesFor(userId, WINDOW);
  if (rows.length < MIN_GAMES) return null;
  let wins = 0;
  let accSum = 0;
  for (const g of rows) {
    const white = g.white_id === userId;
    if (white ? g.result === '1-0' : g.result === '0-1') wins++;
    accSum += white ? g.white_acc : g.black_acc;
  }
  return { games: rows.length, wins, winRate: wins / rows.length, accuracy: accSum / rows.length, recent: rows.slice(0, 5).map((g) => g.id) };
}

// Flags the player when both numbers are high. Returns true if a new flag was raised.
function evaluate(userId) {
  const user = store.getUserById(userId);
  if (!user || user.ban_until > Date.now()) return false;
  const s = summarize(userId);
  if (!s || s.winRate < WIN_RATE || s.accuracy < ACCURACY) return false;
  if (store.hasOpenReport(0, userId)) return false;
  const last = store.lastSystemReportAt(userId);
  if (last && store.analyzedSince(userId, last) < MIN_NEW_GAMES) return false;   // already looked at; wait for fresh games
  const pct = (x) => Math.round(x * 100);
  const reason = `Automatic flag: ${s.wins} wins in their last ${s.games} rated games (${pct(s.winRate)}%) with ${Math.round(s.accuracy)}% average accuracy ` +
    `(Stockfish depth ${DEPTH}). A high score alone proves nothing, so please look at the games. Most recent game ids: ${s.recent.join(', ')} (open #/review/<id> to review one).`;
  store.addReport({ id: 0, username: SYSTEM_NAME }, user, reason);
  store.logAction({ actor_name: SYSTEM_NAME, action: 'flagged', target_name: user.username, detail: `${pct(s.winRate)}% wins, ${Math.round(s.accuracy)}% accuracy` });
  return true;
}

// A player chose to abort a game before their first move. Too many in a day goes to the owner and moderators.
// Returns 'warn' when the player should be told to ease off, 'flagged' when a flag was raised, or null.
function recordAbort(userId, gameId) {
  store.addAbort(userId, gameId);
  const user = store.getUserById(userId);
  if (!user) return null;
  const recent = store.abortsSince(userId, Date.now() - DAY);
  if (recent.length >= ABORT_LIMIT && user.ban_until <= Date.now() && !store.hasOpenReport(-1, userId)) {
    const last = store.lastSystemReportAt(userId, -1);
    if (!last || recent.filter((a) => a.at > last).length >= ABORT_LIMIT) {
      store.addReport({ id: -1, username: SYSTEM_NAME }, user,
        `Automatic flag: aborted ${recent.length} games in the last 24 hours (the limit is ${ABORT_LIMIT}). Aborting right after being matched is often used to dodge opponents or avoid a loss, ` +
        `but it can also be an honest mistake or a bad connection. Game ids: ${recent.slice(0, 8).map((a) => a.game_id).join(', ')}.`);
      store.logAction({ actor_name: SYSTEM_NAME, action: 'flagged', target_name: user.username, detail: `aborted ${recent.length} games in 24 hours` });
      return 'flagged';
    }
  }
  return recent.length >= ABORT_WARN ? 'warn' : null;
}

/* ---------- a one-at-a-time queue, so a small server is never overloaded ---------- */
const queue = [];
let running = false;
let idleWaiters = [];

async function work() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      const g = store.getGame(id);
      if (!g || !g.rated || g.analyzed) continue;
      const acc = await analyzeMoves(g.moves ? g.moves.split(' ') : []);
      store.setAnalysis(id, acc ? acc.w : null, acc ? acc.b : null);
      if (acc) for (const uid of [g.white_id, g.black_id]) if (uid) evaluate(uid);
    } catch (e) {
      console.error('fair-play analysis failed for game', id, e.message);
      try { store.setAnalysis(id, null, null); } catch (e2) { /* ignore */ }
    }
  }
  running = false;
  const w = idleWaiters; idleWaiters = [];
  for (const f of w) f();
}

function enqueue(gameId) {
  if (!ENABLED || queue.length >= 100 || queue.includes(gameId) || !enginePath()) return;
  queue.push(gameId);
  setImmediate(work);
}

const whenIdle = () => (running || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

// After a restart, pick up rated games that were not analysed yet.
function sweep() {
  if (!ENABLED) return;
  for (const id of store.unanalyzedRatedGames(30)) enqueue(id);
}

module.exports = { recordAbort, enqueue, sweep, evaluate, summarize, analyzeMoves, whenIdle, SYSTEM_NAME, settings: { DEPTH, MIN_GAMES, WIN_RATE, ACCURACY } };
