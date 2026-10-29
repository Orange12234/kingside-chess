'use strict';
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const { CATEGORIES, categoryOfTc } = require('./timecontrol');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'chess.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  white_name TEXT NOT NULL,
  black_name TEXT NOT NULL,
  white_id INTEGER,
  black_id INTEGER,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  moves TEXT NOT NULL,
  tc TEXT NOT NULL,
  rated INTEGER NOT NULL,
  white_delta INTEGER,
  black_delta INTEGER,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_white ON games(white_id);
CREATE INDEX IF NOT EXISTS games_black ON games(black_id);
`);

// Upgrade databases created before titles and bios existed.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!cols.includes('email_norm')) db.exec('ALTER TABLE users ADD COLUMN email_norm TEXT');
  // Several accounts may share an email (they are banned together). Older databases had this index as UNIQUE.
  db.exec('DROP INDEX IF EXISTS users_email_norm');
  db.exec('CREATE INDEX IF NOT EXISTS users_email_idx ON users(email_norm)');
  if (!cols.includes('title')) db.exec("ALTER TABLE users ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('ban_until')) db.exec('ALTER TABLE users ADD COLUMN ban_until INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('ban_reason')) db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('banned_by')) db.exec("ALTER TABLE users ADD COLUMN banned_by TEXT NOT NULL DEFAULT ''");
}

// Each saved game also remembers both players' ratings from before it started (for the PGN).
{
  const gcols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
  if (!gcols.includes('white_elo')) db.exec('ALTER TABLE games ADD COLUMN white_elo INTEGER');
  if (!gcols.includes('black_elo')) db.exec('ALTER TABLE games ADD COLUMN black_elo INTEGER');
  if (!gcols.includes('white_acc')) db.exec('ALTER TABLE games ADD COLUMN white_acc REAL');
  if (!gcols.includes('black_acc')) db.exec('ALTER TABLE games ADD COLUMN black_acc REAL');
  if (!gcols.includes('analyzed')) db.exec('ALTER TABLE games ADD COLUMN analyzed INTEGER NOT NULL DEFAULT 0');
  if (!gcols.includes('refunded')) db.exec('ALTER TABLE games ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0');
}

// One rating per player per category (bullet, blitz, rapid), each with its own win/loss/draw count.
db.exec(`
CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  cat TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cat)
);
`);

// Sites that started with a single rating: split it by replaying every rated game in the history.
// A player's rating in a category becomes 1200 plus the points they won or lost in that category,
// so nobody's total changes and nobody is handed a rating they did not earn there. Runs once.
{
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    const rated = db.prepare('SELECT white_id, black_id, result, tc, white_delta, black_delta FROM games WHERE rated = 1').all();
    const totals = new Map();
    const add = (userId, cat, delta, outcome) => {
      if (!userId) return;
      const key = userId + ':' + cat;
      const t = totals.get(key) || { userId, cat, rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
      t.rating += delta || 0;
      t.games += 1;
      if (outcome === 'win') t.wins += 1; else if (outcome === 'loss') t.losses += 1; else t.draws += 1;
      totals.set(key, t);
    };
    for (const g of rated) {
      const cat = categoryOfTc(g.tc);
      const white = g.result === '1-0' ? 'win' : g.result === '0-1' ? 'loss' : 'draw';
      const black = white === 'win' ? 'loss' : white === 'loss' ? 'win' : 'draw';
      add(g.white_id, cat, g.white_delta, white);
      add(g.black_id, cat, g.black_delta, black);
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
    const insert = db.prepare('INSERT OR REPLACE INTO ratings (user_id, cat, rating, games, wins, losses, draws) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const t of totals.values()) {
        if (exists.get(t.userId)) insert.run(t.userId, t.cat, t.rating, t.games, t.wins, t.losses, t.draws);
      }
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`);

// Games a player aborted by choice (see fairplay.js, which flags players who do it a lot).
db.exec(`
CREATE TABLE IF NOT EXISTS aborts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS aborts_user ON aborts(user_id, at);
`);

// Puzzles: one row of totals per player, plus every puzzle they have tried (only the first try counts).
db.exec(`
CREATE TABLE IF NOT EXISTS puzzle_stats (
  user_id INTEGER PRIMARY KEY,
  rating INTEGER NOT NULL DEFAULT 1000,
  solved INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_daily TEXT
);
CREATE TABLE IF NOT EXISTS puzzle_done (
  user_id INTEGER NOT NULL,
  puzzle_id INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, puzzle_id)
);
`);
const puzzleStats = (userId) => db.prepare('SELECT rating, solved, failed, streak, best_streak, last_daily FROM puzzle_stats WHERE user_id = ?').get(userId)
  || { rating: 1000, solved: 0, failed: 0, streak: 0, best_streak: 0, last_daily: null };
const puzzleDone = (userId) => db.prepare('SELECT puzzle_id, ok FROM puzzle_done WHERE user_id = ?').all(userId);
const puzzleTried = (userId, puzzleId) => !!db.prepare('SELECT 1 FROM puzzle_done WHERE user_id = ? AND puzzle_id = ?').get(userId, puzzleId);
function savePuzzleResult(userId, puzzleId, ok, s) {
  db.prepare('INSERT OR REPLACE INTO puzzle_done (user_id, puzzle_id, ok, at) VALUES (?, ?, ?, ?)').run(userId, puzzleId, ok ? 1 : 0, Date.now());
  db.prepare('INSERT OR REPLACE INTO puzzle_stats (user_id, rating, solved, failed, streak, best_streak, last_daily) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, s.rating, s.solved, s.failed, s.streak, s.best_streak, s.last_daily);
}
const saveDaily = (userId, s) => db.prepare('INSERT OR REPLACE INTO puzzle_stats (user_id, rating, solved, failed, streak, best_streak, last_daily) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(userId, s.rating, s.solved, s.failed, s.streak, s.best_streak, s.last_daily);

// Friends: one row per pair. `a` sent the request; it is a friendship once status is 'accepted'.
db.exec(`
CREATE TABLE IF NOT EXISTS friends (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friends_b ON friends(b);
CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by TEXT
);
`);

// Tournaments are kept in memory while they run; this keeps them across restarts and for the history.
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
`);
const saveTournament = (id, status, createdAt, data) => db.prepare('INSERT OR REPLACE INTO tournaments (id, status, created_at, data) VALUES (?, ?, ?, ?)').run(id, status, createdAt, data);
const loadTournaments = () => db.prepare('SELECT data FROM tournaments ORDER BY created_at DESC LIMIT 60').all().map((r) => r.data);

// Player reports: who reported whom, and why. Moderators review them and mark them handled.
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reporter_name TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by TEXT NOT NULL DEFAULT '',
  handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, at);
CREATE INDEX IF NOT EXISTS reports_target ON reports(target_id);
`);

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const q = {
  insertUser: db.prepare('INSERT INTO users (username, username_lc, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
  byName: db.prepare('SELECT * FROM users WHERE username_lc = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  ratingsFor: db.prepare('SELECT cat, rating, games, wins, losses, draws FROM ratings WHERE user_id = ?'),
  upsertResult: db.prepare(`INSERT INTO ratings (user_id, cat, rating, games, wins, losses, draws) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, cat) DO UPDATE SET rating = excluded.rating, games = games + 1,
    wins = wins + excluded.wins, losses = losses + excluded.losses, draws = draws + excluded.draws`),
  insertGame: db.prepare(`INSERT OR REPLACE INTO games
    (id, white_name, black_name, white_id, black_id, result, reason, moves, tc, rated, white_delta, black_delta, ended_at, white_elo, black_elo)
    VALUES (@id, @white_name, @black_name, @white_id, @black_id, @result, @reason, @moves, @tc, @rated, @white_delta, @black_delta, @ended_at, @white_elo, @black_elo)`),
  setTitle: db.prepare('UPDATE users SET title = ? WHERE id = ?'),
  setBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  ban: db.prepare('UPDATE users SET ban_until = ?, ban_reason = ?, banned_by = ? WHERE id = ?'),
  unban: db.prepare("UPDATE users SET ban_until = 0, ban_reason = '', banned_by = '' WHERE id = ?"),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  log: db.prepare('INSERT INTO mod_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)'),
  modLog: db.prepare('SELECT at, actor, action, target, detail FROM mod_log ORDER BY id DESC LIMIT ?'),
  bans: db.prepare('SELECT username, title, ban_until, ban_reason, banned_by FROM users WHERE ban_until > ? ORDER BY ban_until DESC'),
  staff: db.prepare("SELECT username, role FROM users WHERE role != '' ORDER BY role DESC, username"),
  leaderboard: db.prepare(`SELECT u.username, u.title, r.rating, r.games, r.wins, r.losses, r.draws
    FROM ratings r JOIN users u ON u.id = r.user_id
    WHERE r.cat = ? AND (r.games > 0 OR r.rating != 1200) AND u.ban_until <= ? ORDER BY r.rating DESC, r.games DESC LIMIT 20`),
  getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
  searchUsers: db.prepare(`SELECT id, username, title FROM users WHERE username_lc LIKE ? ESCAPE '\\'
    ORDER BY (username_lc LIKE ? ESCAPE '\\') DESC, username_lc LIMIT 8`),
  userGames: db.prepare(`SELECT id, white_name, black_name, white_id, black_id, result, reason, tc, rated,
    white_delta, black_delta, ended_at FROM games WHERE white_id = ? OR black_id = ? ORDER BY ended_at DESC LIMIT 20`),
};

function getUserByName(name) { return q.byName.get(String(name).toLowerCase()) || null; }
function getUserById(id) { return q.byId.get(id) || null; }

// The same mailbox written in different ways counts as one address, so a banned player cannot come back
// with "me+2@gmail.com" or "m.e@gmail.com". Returns null if it is not a usable address.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"'.]{2,}$/.test(e)) return null;
  let [local, domain] = e.split('@');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return { email: e, norm: local + '@' + domain };
}
const usersByEmail = (norm) => (norm ? db.prepare('SELECT * FROM users WHERE email_norm = ? ORDER BY id').all(norm) : []);
function setEmail(userId, mail) { db.prepare('UPDATE users SET email = ?, email_norm = ? WHERE id = ?').run(mail.email, mail.norm, userId); }

function createUser(username, passHash, mail) {
  const info = q.insertUser.run(username, username.toLowerCase(), passHash, Date.now());
  const id = Number(info.lastInsertRowid);
  if (mail) setEmail(id, mail);
  return getUserById(id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId, Date.now());
  return token;
}

function userForToken(token) {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const s = q.session.get(token);
  if (!s) return null;
  if (Date.now() - s.created_at > SESSION_TTL_MS) { q.delSession.run(token); return null; }
  return getUserById(s.user_id);
}

function deleteSession(token) { q.delSession.run(token); }

// All three categories for a player, 1200 and no games where they have not played yet.
function getRatings(userId) {
  const out = {};
  for (const c of CATEGORIES) out[c] = { rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
  for (const r of q.ratingsFor.all(userId)) {
    if (out[r.cat]) out[r.cat] = { rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws };
  }
  return out;
}
function getRating(userId, cat) {
  const r = getRatings(userId)[cat];
  return r ? r.rating : 1200;
}
// The category a player has played most (blitz when they have played none), for places that show one number.
function mainCategory(ratings) {
  let best = 'blitz';
  for (const c of CATEGORIES) if (ratings[c].games > ratings[best].games) best = c;
  if (ratings[best].games === 0) {   // nobody has played: show a rating the owner set, if there is one
    for (const c of CATEGORIES) if (ratings[c].rating !== 1200 && (ratings[best].rating === 1200 || ratings[c].rating > ratings[best].rating)) best = c;
  }
  return best;
}

// The owner can set a rating by hand. The player's game record is left alone.
function setRating(userId, cat, rating) {
  db.prepare(`INSERT INTO ratings (user_id, cat, rating, games, wins, losses, draws) VALUES (?, ?, ?, 0, 0, 0, 0)
    ON CONFLICT(user_id, cat) DO UPDATE SET rating = excluded.rating`).run(userId, cat, rating);
}

// cat: 'bullet' | 'blitz' | 'rapid'; outcome: 'win' | 'loss' | 'draw'
function recordResult(userId, cat, newRating, outcome) {
  q.upsertResult.run(userId, cat, newRating, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, outcome === 'draw' ? 1 : 0);
}

function saveGame(g) { q.insertGame.run(g); }
function leaderboard(cat) { return q.leaderboard.all(CATEGORIES.includes(cat) ? cat : 'blitz', Date.now()); }
function setTitle(userId, title) { q.setTitle.run(title, userId); }
function setBio(userId, bio) { q.setBio.run(bio, userId); }
function setRole(userId, role) { q.setRole.run(role, userId); }
function banUser(userId, until, reason, by) { q.ban.run(until, reason, by, userId); }
function unbanUser(userId) { q.unban.run(userId); }
function deleteSessionsForUser(userId) { q.delUserSessions.run(userId); }

// When an account is banned for good, every rated game it won is undone for the opponent:
// the rating points they lost come back and the loss is taken off their record.
// Returns one entry per refunded game. A game is only ever refunded once.
function refundGamesAgainst(userId) {
  const rows = db.prepare(`SELECT id, white_id, black_id, tc, result, white_delta, black_delta FROM games
    WHERE rated = 1 AND refunded = 0 AND (white_id = ? OR black_id = ?)`).all(userId, userId);
  const refunds = [];
  const upd = db.prepare('UPDATE ratings SET rating = rating + ?, games = MAX(games - 1, 0), losses = MAX(losses - 1, 0) WHERE user_id = ? AND cat = ?');
  const mark = db.prepare('UPDATE games SET refunded = 1 WHERE id = ?');
  const name = db.prepare('SELECT username FROM users WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const g of rows) {
      const bannedIsWhite = g.white_id === userId;
      const oppId = bannedIsWhite ? g.black_id : g.white_id;
      const oppDelta = bannedIsWhite ? g.black_delta : g.white_delta;
      const bannedWon = bannedIsWhite ? g.result === '1-0' : g.result === '0-1';
      if (!bannedWon || !oppId || oppDelta === null || oppDelta >= 0) continue;   // only games the banned player won; draws and their losses are left alone
      const cat = categoryOfTc(g.tc);
      upd.run(-oppDelta, oppId, cat);
      mark.run(g.id);
      const n = name.get(oppId);
      refunds.push({ gameId: g.id, userId: oppId, username: n ? n.username : '', cat, points: -oppDelta });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return refunds;
}

// Fair-play analysis results (see fairplay.js).
function setAnalysis(gameId, whiteAcc, blackAcc) {
  db.prepare('UPDATE games SET white_acc = ?, black_acc = ?, analyzed = 1 WHERE id = ?').run(whiteAcc, blackAcc, gameId);
}
const analyzedGamesFor = (userId, limit) => db.prepare(`SELECT id, white_id, black_id, result, white_acc, black_acc, ended_at FROM games
  WHERE rated = 1 AND analyzed = 1 AND white_acc IS NOT NULL AND black_acc IS NOT NULL AND (white_id = ? OR black_id = ?)
  ORDER BY ended_at DESC LIMIT ?`).all(userId, userId, limit);
const analyzedSince = (userId, since) => db.prepare(`SELECT COUNT(*) AS n FROM games
  WHERE rated = 1 AND analyzed = 1 AND white_acc IS NOT NULL AND ended_at > ? AND (white_id = ? OR black_id = ?)`).get(since, userId, userId).n;
const unanalyzedRatedGames = (limit) => db.prepare('SELECT id FROM games WHERE rated = 1 AND analyzed = 0 ORDER BY ended_at DESC LIMIT ?').all(limit).map((r) => r.id);
const lastSystemReportAt = (targetId, reporterId = 0) => (db.prepare('SELECT MAX(at) AS t FROM reports WHERE reporter_id = ? AND target_id = ?').get(reporterId, targetId) || {}).t || 0;
const addAbort = (userId, gameId) => db.prepare('INSERT INTO aborts (user_id, game_id, at) VALUES (?, ?, ?)').run(userId, gameId, Date.now());
const abortsSince = (userId, since) => db.prepare('SELECT game_id, at FROM aborts WHERE user_id = ? AND at > ? ORDER BY at DESC').all(userId, since);

const friendRow = (x, y) => db.prepare('SELECT a, b, status FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').get(x, y, y, x);
// 'friends' | 'sent' (I asked them) | 'received' (they asked me) | 'none'
function friendState(me, other) {
  const r = friendRow(me, other);
  if (!r) return 'none';
  if (r.status === 'accepted') return 'friends';
  return r.a === me ? 'sent' : 'received';
}
function friendRequest(from, to) {
  const r = friendRow(from, to);
  if (r) {
    if (r.status === 'pending' && r.a === to) db.prepare("UPDATE friends SET status = 'accepted', at = ? WHERE a = ? AND b = ?").run(Date.now(), to, from);
    return friendState(from, to);
  }
  db.prepare('INSERT INTO friends (a, b, status, at) VALUES (?, ?, ?, ?)').run(from, to, 'pending', Date.now());
  return 'sent';
}
const friendAccept = (me, other) => db.prepare("UPDATE friends SET status = 'accepted', at = ? WHERE a = ? AND b = ? AND status = 'pending'").run(Date.now(), other, me).changes > 0;
const friendRemove = (x, y) => db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(x, y, y, x).changes > 0;
const friendCount = (id) => db.prepare("SELECT COUNT(*) AS n FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'").get(id, id).n;
// Everyone connected to this player: [{ id, status, mine }]
const friendsOf = (id) => db.prepare('SELECT a, b, status FROM friends WHERE a = ? OR b = ?').all(id, id)
  .map((r) => ({ id: r.a === id ? r.b : r.a, status: r.status, mine: r.a === id }));
const addAppeal = (user, message) => db.prepare('INSERT INTO appeals (at, user_id, username, message) VALUES (?, ?, ?, ?)').run(Date.now(), user.id, user.username, message);
const hasOpenAppeal = (userId) => !!db.prepare("SELECT 1 FROM appeals WHERE user_id = ? AND status = 'open'").get(userId);
const openAppeals = (limit = 100) => db.prepare("SELECT id, at, user_id, username, message FROM appeals WHERE status = 'open' ORDER BY id DESC LIMIT ?").all(limit);
const closeAppeal = (id, by) => db.prepare("UPDATE appeals SET status = 'closed', handled_by = ? WHERE id = ? AND status = 'open'").run(by, id).changes > 0;

function addReport(reporter, target, reason) {
  db.prepare('INSERT INTO reports (at, reporter_id, reporter_name, target_id, target_name, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), reporter.id, reporter.username, target.id, target.username, reason);
}
const hasOpenReport = (reporterId, targetId) => !!db.prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND target_id = ? AND status = 'open'").get(reporterId, targetId);
const reportsSince = (reporterId, since) => db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND at > ?').get(reporterId, since).n;
const openReports = (limit = 100) => db.prepare("SELECT id, at, reporter_name, target_name, reason FROM reports WHERE status = 'open' ORDER BY id DESC LIMIT ?").all(limit);
const openReportsAgainst = (targetId) => db.prepare("SELECT id, at, reporter_name, reason FROM reports WHERE status = 'open' AND target_id = ? ORDER BY id DESC LIMIT 20").all(targetId);
function closeReport(id, by) {
  return db.prepare("UPDATE reports SET status = 'closed', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'open'").run(by, Date.now(), id).changes > 0;
}

function logAction(a) { q.log.run(Date.now(), a.actor_name, a.action, a.target_name, a.detail || ''); }
function modLog(limit = 30) { return q.modLog.all(limit); }
function listBans() { return q.bans.all(Date.now()); }
function listStaff() { return q.staff.all(); }
function userGames(id) { return q.userGames.all(id, id); }
function getGame(id) { return q.getGame.get(String(id)) || null; }
// Players whose name contains `term`, names that start with it first. `term` must be letters, digits or underscores.
function searchUsers(term) {
  const e = String(term).toLowerCase().replace(/_/g, '\\_');
  return q.searchUsers.all('%' + e + '%', e + '%');
}

module.exports = {
  getUserByName, getUserById, normalizeEmail, usersByEmail, setRating, setEmail, createUser, createSession, userForToken,
  deleteSession, recordResult, saveGame, leaderboard, userGames, setTitle, setBio, searchUsers, getGame,
  getRatings, getRating, mainCategory,
  saveTournament, loadTournaments,
  friendState, friendRequest, friendAccept, friendRemove, friendCount, friendsOf, addAppeal, hasOpenAppeal, openAppeals, closeAppeal,
  setRole, puzzleStats, puzzleDone, puzzleTried, savePuzzleResult, saveDaily, addAbort, abortsSince, setAnalysis, analyzedGamesFor, analyzedSince, unanalyzedRatedGames, lastSystemReportAt, addReport, hasOpenReport, reportsSince, openReports, openReportsAgainst, closeReport, refundGamesAgainst, banUser, unbanUser, deleteSessionsForUser, logAction, modLog, listBans, listStaff,
};
