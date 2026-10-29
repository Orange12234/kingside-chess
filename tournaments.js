'use strict';
// Arena tournaments, started by the owner. While a tournament runs, every player who has joined (and is
// online and not paused) is paired with another free player, and when a game ends the next one starts a few
// seconds later. A win scores 2, a draw 1, a loss 0, and a player on a winning streak (2 or more wins in a
// row) scores double. When the time is up, no new games start; games in progress still count when they end.
// The tournament with the most points wins.
const crypto = require('crypto');
const store = require('./db');

const WIN = 2;
const DRAW = 1;
const COOLDOWN_MS = 8000;       // time to look at the result before the next pairing
const STOP_PAIRING_MS = 20000;  // no new games in the last 20 seconds
const MAX_OPEN = 3;             // upcoming + running tournaments at the same time

module.exports = function init(ctx) {
  const { app, bearer, newGame, makeSeat, startGame, socketsOf, liveGameOf, send, TIME_CONTROLS, isBanned, publicUser, wss } = ctx;
  const tournaments = new Map();

  for (const raw of store.loadTournaments()) {
    try {
      const t = JSON.parse(raw);
      t.active = new Set();
      for (const p of Object.values(t.players)) p.freeAt = 0;
      tournaments.set(t.id, t);
    } catch (e) { /* ignore a damaged row */ }
  }

  const save = (t) => {
    const copy = { ...t, active: undefined };
    try { store.saveTournament(t.id, t.status, t.createdAt, JSON.stringify(copy)); } catch (e) { console.error('saving tournament failed', e.message); }
  };
  const isOwner = (u) => !!u && u.role === 'owner';
  const loggedIn = (req, res) => {
    const u = store.userForToken(bearer(req));
    if (!u) { res.status(401).json({ error: 'Log in first.' }); return null; }
    return u;
  };
  const standings = (t) => Object.entries(t.players)
    .map(([id, p]) => ({ id: Number(id), ...p }))
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.joinedAt - b.joinedAt);

  function begin(t) {
    t.status = 'running';
    t.startAt = Math.min(t.startAt, Date.now());
    t.endAt = Date.now() + t.minutes * 60 * 1000;
    save(t);
    for (const id of Object.keys(t.players)) for (const s of socketsOf(Number(id))) send(s, { t: 'tournamentStarted', id: t.id, name: t.name });
  }
  function finish(t) {
    t.status = 'finished';
    t.endAt = Math.min(t.endAt || Date.now(), Date.now());
    save(t);
  }

  /* ---------- pairing ---------- */
  function available(t, id, now) {
    const p = t.players[id];
    if (!p || p.paused || (p.freeAt || 0) > now) return null;
    const u = store.getUserById(Number(id));
    if (!u || isBanned(u)) return null;
    if (liveGameOf(Number(id))) return null;
    const socks = socketsOf(Number(id)).filter((s) => !s.seeking);
    return socks.length ? socks[0] : null;
  }

  function pair(t, now) {
    const pool = standings(t).map((p) => ({ id: p.id, p, ws: available(t, p.id, now) })).filter((x) => x.ws);
    const used = new Set();
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      let j = -1;
      for (let k = i + 1; k < pool.length; k++) {
        if (used.has(k)) continue;
        if (j < 0) j = k;                                                       // closest score that is free
        if (pool[i].p.lastOpp !== pool[k].id && pool[k].p.lastOpp !== pool[i].id) { j = k; break; }   // but not the last opponent again
      }
      if (j < 0) continue;
      used.add(i); used.add(j);
      const a = pool[i], b = pool[j];
      const g = newGame(t.tc, true);
      g.tournamentId = t.id;
      g.tournamentName = t.name;
      const aWhite = Math.random() < 0.5;
      g.seats[aWhite ? 'w' : 'b'] = makeSeat(a.ws, g.cat);
      g.seats[aWhite ? 'b' : 'w'] = makeSeat(b.ws, g.cat);
      startGame(g);
      t.active.add(g.id);
      send(a.ws, { t: 'goto', id: g.id });
      send(b.ws, { t: 'goto', id: g.id });
    }
  }

  function tick() {
    const now = Date.now();
    for (const t of tournaments.values()) {
      if (t.status === 'upcoming' && now >= t.startAt) begin(t);
      if (t.status === 'running' && now >= t.endAt) { finish(t); continue; }
      if (t.status === 'running' && now < t.endAt - STOP_PAIRING_MS) pair(t, now);
    }
  }
  const timer = setInterval(tick, 2000);
  timer.unref();

  /* ---------- results ---------- */
  function onGameEnd(g) {
    const t = g.tournamentId && tournaments.get(g.tournamentId);
    if (!t) return;
    t.active.delete(g.id);
    const now = Date.now();
    const n = g.chess.history().length;
    const moves = { w: Math.ceil(n / 2), b: Math.floor(n / 2) };
    for (const c of ['w', 'b']) {
      const seat = g.seats[c];
      const p = seat && seat.userId && t.players[seat.userId];
      if (!p) continue;
      const opp = g.seats[c === 'w' ? 'b' : 'w'];
      p.lastOpp = opp ? opp.userId : null;
      p.freeAt = now + COOLDOWN_MS;
      if (g.result === '*') {                                  // aborted: no points; whoever did not move sits out until they come back
        if (moves[c] === 0) p.paused = true;
        continue;
      }
      const score = g.result === '1/2-1/2' ? 0.5 : (g.result === '1-0') === (c === 'w') ? 1 : 0;
      const onStreak = p.streak >= 2;
      p.games++;
      if (score === 1) { p.wins++; p.score += onStreak ? WIN * 2 : WIN; p.streak++; }
      else if (score === 0.5) { p.draws++; p.score += onStreak ? DRAW * 2 : DRAW; p.streak = 0; }
      else { p.losses++; p.streak = 0; }
    }
    save(t);
  }

  /* ---------- the web API ---------- */
  const brief = (t, userId) => ({
    id: t.id, name: t.name, tc: t.tc, minutes: t.minutes, status: t.status, startAt: t.startAt, endAt: t.endAt || null,
    players: Object.keys(t.players).length, joined: userId ? !!t.players[userId] : false,
  });

  app.get('/api/tournaments', (req, res) => {
    const u = store.userForToken(bearer(req));
    const all = [...tournaments.values()].sort((a, b) => b.createdAt - a.createdAt);
    const open = all.filter((t) => t.status !== 'finished').sort((a, b) => a.startAt - b.startAt);
    const done = all.filter((t) => t.status === 'finished').slice(0, 8);
    res.json({ now: Date.now(), canCreate: isOwner(u), open: open.map((t) => brief(t, u && u.id)), finished: done.map((t) => ({ ...brief(t, u && u.id), winner: (() => { const w = standings(t)[0]; const wu = w && store.getUserById(w.id); return wu ? wu.username : null; })() })) });
  });

  app.get('/api/tournaments/:id', (req, res) => {
    const t = tournaments.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'That tournament does not exist.' });
    const u = store.userForToken(bearer(req));
    const online = new Set();
    for (const w of wss.clients) if (w.user && w.readyState === 1) online.add(w.user.id);
    const rows = standings(t).map((p, i) => {
      const pu = store.getUserById(p.id);
      return {
        rank: i + 1, username: pu ? pu.username : '?', title: pu ? pu.title || '' : '', role: pu ? pu.role || '' : '',
        rating: pu ? publicUser(pu).rating : null, score: p.score, games: p.games, wins: p.wins, draws: p.draws, losses: p.losses,
        streak: p.streak, paused: !!p.paused, online: online.has(p.id), playing: !!liveGameOf(p.id),
      };
    });
    const mine = u && t.players[u.id];
    res.json({
      now: Date.now(), ...brief(t, u && u.id), standings: rows, canManage: isOwner(u),
      me: mine ? { paused: !!mine.paused, rank: rows.findIndex((r) => r.username === u.username) + 1, score: mine.score } : null,
    });
  });

  app.post('/api/tournaments', (req, res) => {
    const u = loggedIn(req, res);
    if (!u) return;
    if (!isOwner(u)) return res.status(403).json({ error: 'Only the owner can start a tournament.' });
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    if (name.length < 3 || name.length > 40) return res.status(400).json({ error: 'Give the tournament a name of 3 to 40 characters.' });
    if (!TIME_CONTROLS[b.tc]) return res.status(400).json({ error: 'Pick one of the time limits.' });
    const minutes = Math.round(Number(b.minutes));
    if (!(minutes >= 10 && minutes <= 180)) return res.status(400).json({ error: 'A tournament lasts 10 to 180 minutes.' });
    const delay = Math.round(Number(b.delay) || 0);
    if (!(delay >= 0 && delay <= 120)) return res.status(400).json({ error: 'It can start right away or up to 120 minutes from now.' });
    if ([...tournaments.values()].filter((t) => t.status !== 'finished').length >= MAX_OPEN) return res.status(400).json({ error: 'There are already ' + MAX_OPEN + ' tournaments open. End one first.' });
    const t = { id: crypto.randomBytes(4).toString('hex'), name, tc: b.tc, minutes, status: 'upcoming', createdAt: Date.now(), createdBy: u.username, startAt: Date.now() + delay * 60000, endAt: null, players: {}, active: new Set() };
    tournaments.set(t.id, t);
    if (delay === 0) begin(t); else save(t);
    res.json({ ok: true, id: t.id });
  });

  app.post('/api/tournaments/:id/:action', (req, res) => {
    const u = loggedIn(req, res);
    if (!u) return;
    const t = tournaments.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'That tournament does not exist.' });
    const act = req.params.action;
    if (act === 'start' || act === 'end') {
      if (!isOwner(u)) return res.status(403).json({ error: 'Only the owner can do that.' });
      if (act === 'start') {
        if (t.status !== 'upcoming') return res.status(400).json({ error: 'It has already started.' });
        begin(t);
      } else {
        if (t.status === 'finished') return res.status(400).json({ error: 'It is already over.' });
        finish(t);
      }
      return res.json({ ok: true });
    }
    if (act === 'join') {
      if (t.status === 'finished') return res.status(400).json({ error: 'This tournament is over.' });
      if (isBanned(u)) return res.status(403).json({ error: 'Your account is banned.' });
      if (!t.players[u.id]) t.players[u.id] = { score: 0, games: 0, wins: 0, draws: 0, losses: 0, streak: 0, paused: false, joinedAt: Date.now(), lastOpp: null, freeAt: 0 };
      else t.players[u.id].paused = false;
      save(t);
      return res.json({ ok: true });
    }
    if (act === 'leave') {
      const p = t.players[u.id];
      if (!p) return res.json({ ok: true });
      if (t.status === 'running' && p.games > 0) p.paused = true;      // keep the points you earned
      else delete t.players[u.id];
      save(t);
      return res.json({ ok: true });
    }
    if (act === 'pause') {
      const p = t.players[u.id];
      if (!p) return res.status(400).json({ error: 'You have not joined this tournament.' });
      p.paused = !!(req.body && req.body.paused);
      if (!p.paused) p.freeAt = 0;
      save(t);
      return res.json({ ok: true, paused: p.paused });
    }
    res.status(404).json({ error: 'Unknown action.' });
  });

  return { onGameEnd, tick, tournaments, get: (id) => tournaments.get(id) };
};
