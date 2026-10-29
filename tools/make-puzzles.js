'use strict';
// Makes public/puzzles.json: forced-mate puzzles found by letting Stockfish play itself.
//   node tools/make-puzzles.js [how-many]      (default 400, takes a while)
// Every puzzle is "White/Black to move and mate in 2 or 3" where the winning move is the ONLY winning
// move at every step, so there is nothing ambiguous to argue about when a player tries something else.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Chess } = require('chess.js');

const WANT = Number(process.argv[2]) || 400;
const dir = path.join(__dirname, '..', 'node_modules', 'stockfish', 'bin');
const file = path.join(dir, fs.readdirSync(dir).find((n) => /^stockfish-[\d.]+-lite-single\.js$/.test(n)));
const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '';
let waiter = null;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (waiter) waiter(line);
  }
});
const send = (s) => child.stdin.write(s + '\n');
function until(test, cmd) {
  return new Promise((resolve) => {
    const lines = [];
    waiter = (l) => { lines.push(l); if (test(l)) { waiter = null; resolve(lines); } };
    send(cmd);
  });
}
// Returns the engine's lines (best first): { score: {cp|mate}, pv: [uci...] }
async function analyse(fen, depth, multipv) {
  await until((l) => l === 'readyok', 'isready');
  send('position fen ' + fen);
  const lines = await until((l) => l.startsWith('bestmove'), `go depth ${depth}`);
  const best = {};
  for (const l of lines) {
    if (!l.startsWith('info') || !/ pv /.test(l) || / (lowerbound|upperbound) /.test(l)) continue;
    const mp = Number((/multipv (\d+)/.exec(l) || [0, 1])[1]);
    const m = /score (cp|mate) (-?\d+)/.exec(l);
    if (!m) continue;
    best[mp] = { type: m[1], v: Number(m[2]), pv: l.split(' pv ')[1].trim().split(/\s+/) };
  }
  return Object.keys(best).sort((a, b) => a - b).map((k) => best[k]);
}
const isMateFor = (line, n) => line && line.type === 'mate' && line.v > 0 && line.v <= n;

async function verify(fen) {
  // The side to move mates in k (2 or 3); each of their moves must be the only mating move.
  let chess = new Chess(fen);
  let top = await analyse(fen, 6, 1);                   // quick look first: almost no position has a forced mate
  if (!top.length || top[0].type !== 'mate' || top[0].v < 2 || top[0].v > 3) return null;
  top = await analyse(fen, 14, 2);
  if (!top.length || top[0].type !== 'mate' || top[0].v < 2 || top[0].v > 3) return null;
  const k = top[0].v;
  const solution = [];
  let left = k;
  while (left >= 1) {
    top = await analyse(chess.fen(), 14, 2);
    if (!isMateFor(top[0], left) || top[0].v !== left) return null;
    if (isMateFor(top[1], left)) return null;          // a second way to mate: ambiguous
    const mv = top[0].pv[0];
    solution.push(mv);
    chess.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
    if (chess.isCheckmate()) break;
    const reply = top[0].pv[1];
    if (!reply) return null;
    solution.push(reply);
    chess.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
    left--;
  }
  if (!chess.isCheckmate()) return null;
  return { fen, mate: k, solution };
}

(async () => {
  await until((l) => l === 'uciok', 'uci');
  send('setoption name MultiPV value 2');
  const out = [];
  const seen = new Set();
  let games = 0;
  while (out.length < WANT) {
    games++;
    const chess = new Chess();
    send('setoption name Skill Level value ' + (3 + Math.floor(Math.random() * 10)));
    for (let ply = 0; ply < 140 && !chess.isGameOver(); ply++) {
      if (ply >= 16 && ply % 2 === 0 && out.length < WANT) {
        const key = chess.fen().split(' ').slice(0, 4).join(' ');
        if (!seen.has(key) && !chess.isCheck()) {
          seen.add(key);
          const p = await verify(chess.fen());
          if (p) { out.push(p); if (out.length % 20 === 0) console.log(out.length + ' puzzles after ' + games + ' games'); }
        }
      }
      // play a not-too-good move: pick randomly among the engine's top two lines
      const top = await analyse(chess.fen(), 4, 2);
      if (!top.length) break;
      const pick = top[Math.random() < 0.3 && top[1] ? 1 : 0].pv[0];
      chess.move({ from: pick.slice(0, 2), to: pick.slice(2, 4), promotion: pick[4] });
    }
  }
  // shuffle, then keep a good mix of mate in 2 and in 3
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'puzzles.json'), JSON.stringify(out));
  console.log('wrote ' + out.length + ' puzzles (' + out.filter((p) => p.mate === 2).length + ' mate in 2, ' + out.filter((p) => p.mate === 3).length + ' mate in 3)');
  child.kill();
  process.exit(0);
})();
