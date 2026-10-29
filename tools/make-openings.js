'use strict';
// Builds public/openings.json from the Lichess openings list (CC0, https://github.com/lichess-org/chess-openings).
//   node tools/make-openings.js a.tsv b.tsv c.tsv d.tsv e.tsv
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const out = {};
let n = 0;
for (const file of process.argv.slice(2)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !pgn) continue;
    const c = new Chess();
    try { for (const t of pgn.replace(/\d+\./g, ' ').split(/\s+/).filter(Boolean)) c.move(t); } catch (e) { continue; }
    out[c.fen().split(' ').slice(0, 4).join(' ')] = eco + '|' + name;
    n++;
  }
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'openings.json'), JSON.stringify(out));
console.log('wrote', Object.keys(out).length, 'positions from', n, 'openings');
