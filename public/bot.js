/* Play against Stockfish. The engine runs in your browser, so nothing is sent to the server. */
(function () {
  'use strict';

  const K = window.KINGSIDE;
  const FILES = 'abcdefgh';

  // How hard the bot plays. Levels 4 to 8 use Stockfish's own strength limit (UCI_Elo); the easier ones
  // also search very shallowly and sometimes just play a random legal move, like a beginner would.
  const LEVELS = [
    { name: 'Beginner',    elo: 400,  skill: 0,  depth: 1, blunder: 0.40 },
    { name: 'Novice',      elo: 700,  skill: 0,  depth: 2, blunder: 0.20 },
    { name: 'Casual',      elo: 1000, skill: 3,  depth: 3, blunder: 0.07 },
    { name: 'Club',        elo: 1400, limit: 1400, ms: 150 },
    { name: 'Strong club', elo: 1800, limit: 1800, ms: 250 },
    { name: 'Expert',      elo: 2200, limit: 2200, ms: 350 },
    { name: 'Master',      elo: 2600, limit: 2600, ms: 500 },
    { name: 'Maximum',     elo: 3190, skill: 20, ms: 1000 },
  ];

  const ICONS = {
    crown: '<svg viewBox="0 0 24 24"><path d="M4 17 3 8l5 4 4-7 4 7 5-4-1 9z" fill="#fff"/><rect x="4" y="18.5" width="16" height="2.2" rx="1" fill="#fff"/></svg>',
    mate: '<svg viewBox="0 0 24 24"><path d="M9 4 7.5 20M16.5 4 15 20M5 9h14M4.5 15h14" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M7 20V4M7 5h11l-3 4 3 4H7" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    draw: '<svg viewBox="0 0 24 24"><path d="M6 9h12M6 15h12" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  };

  const $ = (sel, el) => (el || document).querySelector(sel);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  const sound = (kind) => { try { if (window.KingsideSound) window.KingsideSound.play(kind); } catch (e) { /* no sound */ } };

  let Chess = null;
  async function loadChess() {
    if (!Chess) Chess = (await import(K.localEngine ? K.localEngine.chessModule : K.url('/vendor/chess.js'))).Chess;
    return Chess;
  }

  /* ---------------- the engine ---------------- */
  function createEngine(info) {
    const worker = new Worker(info.script);
    const listeners = new Set();
    let dead = null;
    worker.onmessage = (e) => {
      for (const raw of String(e.data).split('\n')) {
        const line = raw.trim();
        if (line) for (const f of [...listeners]) f(line);
      }
    };
    worker.onerror = (e) => {
      dead = new Error('The engine stopped working' + (e && e.message ? ' (' + e.message + ')' : '') + '.');
      for (const f of [...listeners]) f(null);
    };
    const send = (c) => worker.postMessage(c);
    const waitFor = (test, ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => { listeners.delete(f); reject(new Error('The engine did not respond.')); }, ms || 30000);
      const f = (line) => {
        if (line === null) { clearTimeout(t); listeners.delete(f); reject(dead); return; }
        if (test(line)) { clearTimeout(t); listeners.delete(f); resolve(line); }
      };
      listeners.add(f);
    });
    return {
      async init() {
        send('uci');
        await waitFor((l) => l === 'uciok');
        send('setoption name Hash value 16');
        send('isready');
        await waitFor((l) => l === 'readyok');
      },
      // Picks a move for the position at the given level. Resolves with a move like "e2e4".
      async bestMove(fen, level) {
        if (dead) throw dead;
        if (level.limit) {
          send('setoption name UCI_LimitStrength value true');
          send('setoption name UCI_Elo value ' + level.limit);
          send('setoption name Skill Level value 20');
        } else {
          send('setoption name UCI_LimitStrength value false');
          send('setoption name Skill Level value ' + level.skill);
        }
        send('isready');
        await waitFor((l) => l === 'readyok');
        send('position fen ' + fen);
        const done = waitFor((l) => l.startsWith('bestmove'), 60000);
        send(level.depth ? 'go depth ' + level.depth : 'go movetime ' + level.ms);
        const line = await done;
        const mv = (line.split(/\s+/)[1] || '').replace('(none)', '');
        return mv || null;
      },
      stop() { try { send('stop'); } catch (e) { /* ignore */ } },
      terminate() { try { worker.terminate(); } catch (e) { /* already gone */ } listeners.clear(); },
    };
  }

  async function engineInfo() {
    if (K.localEngine) return K.localEngine;
    const r = await fetch(K.url('/api/engine'));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Stockfish could not be loaded.');
    return d;
  }

  /* ---------------- state ---------------- */
  let active = false;
  let session = 0;
  let engine = null;
  let enginePromise = null;
  let S = null;                 // the game being played, or null on the setup screen

  const settings = {
    level: Math.min(8, Math.max(1, Number(store('bot-level')) || 4)),
    color: ['w', 'b', 'random'].includes(store('bot-color')) ? store('bot-color') : 'w',
  };

  function ensureEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      const info = await engineInfo();
      const e = createEngine(info);
      await e.init();
      engine = e;
      return e;
    })().catch((err) => { enginePromise = null; throw err; });
    return enginePromise;
  }

  function stopEngine() {
    session++;
    if (engine) engine.terminate();
    engine = null;
    enginePromise = null;
  }

  /* ---------------- setup screen ---------------- */
  function renderSetup() {
    S = null;
    document.title = 'Play Stockfish - Kingside';
    const box = $('#bot');
    box.textContent = '';
    const card = el('section', 'card bot-setup');
    card.appendChild(el('h1', null, 'Play Stockfish'));
    card.appendChild(el('p', 'lede', 'Choose how strong he is and which side you want. The game is casual: it does not change your rating.'));

    const lvlBox = el('div', 'bot-level');
    const head = el('div', 'bot-level-head');
    const nameEl = el('b', 'bot-level-name');
    const eloEl = el('span', 'bot-level-elo');
    head.append(el('span', null, 'Difficulty: '), nameEl, eloEl);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '1'; range.max = '8'; range.step = '1'; range.id = 'bot-level';
    range.value = String(settings.level);
    range.setAttribute('aria-label', 'Difficulty');
    const ticks = el('div', 'bot-ticks');
    for (let i = 1; i <= 8; i++) ticks.appendChild(el('span', null, String(i)));
    const paint = () => {
      const lv = LEVELS[Number(range.value) - 1];
      nameEl.textContent = 'Level ' + range.value + ' - ' + lv.name;
      eloEl.textContent = lv.elo >= 3000 ? ' (full strength)' : ' (about ' + lv.elo + ' rating)';
    };
    range.addEventListener('input', () => { settings.level = Number(range.value); store('bot-level', range.value); paint(); });
    paint();
    lvlBox.append(head, range, ticks);
    card.appendChild(lvlBox);

    const side = el('div', 'bot-side');
    side.appendChild(el('span', null, 'I play'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    for (const [val, label] of [['w', 'White'], ['random', 'Random'], ['b', 'Black']]) {
      const b = el('button', 'btn small', label);
      b.type = 'button';
      b.dataset.color = val;
      b.setAttribute('aria-pressed', String(settings.color === val));
      b.addEventListener('click', () => {
        settings.color = val; store('bot-color', val);
        for (const x of seg.children) x.setAttribute('aria-pressed', String(x.dataset.color === val));
      });
      seg.appendChild(b);
    }
    side.appendChild(seg);
    card.appendChild(side);

    const start = el('button', 'btn primary big', 'Start game');
    start.type = 'button'; start.id = 'bot-start';
    const status = el('p', 'hint bot-load');
    status.id = 'bot-load';
    start.addEventListener('click', async () => {
      start.disabled = true;
      status.textContent = 'Loading Stockfish…';
      status.classList.remove('error');
      try {
        await ensureEngine();
        if (!active) return;
        await startGame();
      } catch (err) {
        status.textContent = err.message || 'Stockfish could not be loaded.';
        status.classList.add('error');
        start.disabled = false;
      }
    });
    card.append(start, status);
    box.appendChild(card);
  }

  /* ---------------- the game ---------------- */
  async function startGame() {
    const C = await loadChess();
    const color = settings.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : settings.color;
    S = {
      chess: new C(), me: color, level: LEVELS[settings.level - 1],
      selected: null, last: null, thinking: false, over: null, promo: null, flipped: color === 'b', dismissed: false,
    };
    buildGame();
    renderAll();
    if (S.chess.turn() !== S.me) botMove();
  }

  function buildGame() {
    document.title = 'Play Stockfish - Kingside';
    const box = $('#bot');
    box.textContent = '';
    const game = el('div', 'game bot-game');

    const left = el('div', 'game-board');
    const strip = (id) => {
      const p = el('div', 'player');
      p.id = id;
      p.append(el('span', 'swatch'), el('span', 'pname'), el('span', 'prating'));
      return p;
    };
    left.appendChild(strip('bp-top'));
    const wrap = el('div', 'board-wrap');
    const board = el('div', 'board'); board.id = 'bot-board';
    const promo = el('div', 'promo'); promo.id = 'bot-promo'; promo.hidden = true;
    const end = el('div', 'endcard'); end.id = 'bot-end'; end.hidden = true;
    wrap.append(board, promo, end);
    left.appendChild(wrap);
    left.appendChild(strip('bp-bottom'));

    const side = el('aside', 'side');
    const info = el('div', 'gameinfo');
    info.append(el('span', null, 'Vs Stockfish'), el('span', 'tag', 'Casual'));
    const status = el('div', 'status'); status.id = 'bot-status'; status.setAttribute('aria-live', 'polite');
    const sub = el('div', 'status-sub'); sub.id = 'bot-sub';
    const moves = el('div', 'moves'); moves.id = 'bot-moves';
    const controls = el('div', 'controls');
    const mk = (id, text, cls) => { const b = el('button', 'btn small' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.id = id; return b; };
    const undo = mk('bot-undo', 'Take back');
    const resign = mk('bot-resign', 'Resign', 'danger');
    const flip = mk('bot-flip', 'Flip board');
    const again = mk('bot-new', 'New game', 'primary');
    controls.append(undo, resign, flip, again);
    side.append(info, status, sub, moves, controls);
    game.append(left, side);
    box.appendChild(game);

    board.addEventListener('click', onBoardClick);
    board.addEventListener('pointerdown', onPointerDown);
    undo.addEventListener('click', takeBack);
    resign.addEventListener('click', () => { if (S && !S.over && confirm('Resign this game?')) finish('resign'); });
    flip.addEventListener('click', () => { if (S) { S.flipped = !S.flipped; renderAll(); } });
    again.addEventListener('click', () => { stopThinking(); renderSetup(); });
  }

  function stopThinking() {
    // If the engine is mid-search, throw it away: a late answer must never be mistaken for the next move.
    const was = S && S.thinking;
    session++;
    if (S) S.thinking = false;
    if (was) { if (engine) engine.terminate(); engine = null; enginePromise = null; }
  }

  function kingSquare(chess, color) {
    for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
    return null;
  }

  function renderBoard() {
    const { chess } = S;
    const board = $('#bot-board');
    const ori = S.flipped ? 'b' : 'w';
    const legalTargets = new Set();
    if (S.selected && !S.over) for (const m of chess.moves({ square: S.selected, verbose: true })) legalTargets.add(m.to);
    const checkSq = chess.inCheck() ? kingSquare(chess, chess.turn()) : null;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 64; i++) {
      const row = Math.floor(i / 8), col = i % 8;
      const f = ori === 'w' ? col : 7 - col;
      const r = ori === 'w' ? 7 - row : row;
      const sq = FILES[f] + (r + 1);
      const d = el('div', 'sq ' + ((f + r) % 2 === 0 ? 'dark' : 'light'));
      d.dataset.sq = sq;
      if (row === 7) d.dataset.file = FILES[f];
      if (col === 0) d.dataset.rank = String(r + 1);
      const p = chess.get(sq);
      if (S.last && (S.last.from === sq || S.last.to === sq)) d.classList.add('last');
      if (S.selected === sq) d.classList.add('sel');
      if (legalTargets.has(sq)) d.classList.add(p ? 'capture' : 'target');
      if (checkSq === sq) d.classList.add('check');
      if (p) {
        const img = el('img', 'pc');
        img.src = 'pieces/' + p.color + p.type.toUpperCase() + '.svg';
        img.alt = ''; img.draggable = false;
        d.appendChild(img);
      }
      frag.appendChild(d);
    }
    board.textContent = '';
    board.appendChild(frag);
    if (S.over) addBadges();
  }

  function addBadges() {
    const { over, chess } = S;
    const put = (color, kind, tone) => {
      const sq = kingSquare(chess, color);
      const d = sq && $('#bot-board .sq[data-sq="' + sq + '"]');
      if (!d) return;
      const b = el('span', 'badge ' + tone);
      b.innerHTML = ICONS[kind];
      d.appendChild(b);
    };
    if (over.winner) {
      const loser = over.winner === 'w' ? 'b' : 'w';
      put(over.winner, 'crown', 'win');
      put(loser, over.reason === 'resign' ? 'flag' : 'mate', 'lose');
    } else { put('w', 'draw', 'draw'); put('b', 'draw', 'draw'); }
  }

  function renderStrips() {
    const meSide = S.me, botSide = S.me === 'w' ? 'b' : 'w';
    const bottom = S.flipped ? 'b' : 'w';
    const fill = (id, color) => {
      const p = $('#' + id);
      const isMe = color === meSide;
      $('.swatch', p).className = 'swatch ' + color;
      $('.pname', p).textContent = isMe ? 'You' : 'Stockfish';
      $('.prating', p).textContent = isMe ? '' : '(' + (S.level.elo >= 3000 ? 'full strength' : 'about ' + S.level.elo) + ')';
      p.classList.toggle('turn', !S.over && S.chess.turn() === color);
    };
    fill('bp-bottom', bottom);
    fill('bp-top', bottom === 'w' ? 'b' : 'w');
    return botSide;
  }

  function renderMoves() {
    const box = $('#bot-moves');
    const moves = S.chess.history();
    box.textContent = '';
    for (let i = 0; i < moves.length; i += 2) {
      box.appendChild(el('span', 'n', (i / 2 + 1) + '.'));
      box.appendChild(el('span', 'm' + (i === moves.length - 1 ? ' latest' : ''), moves[i]));
      box.appendChild(el('span', 'm' + (i + 1 === moves.length - 1 ? ' latest' : ''), moves[i + 1] || ''));
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderStatus() {
    const st = $('#bot-status'), sub = $('#bot-sub');
    const c = S.chess;
    if (S.over) {
      st.textContent = S.over.text;
      sub.textContent = '';
    } else if (S.thinking) {
      st.textContent = 'Stockfish is thinking…';
      sub.textContent = '';
    } else {
      st.textContent = c.inCheck() ? 'Check! Your move' : 'Your move';
      sub.textContent = c.history().length === 0 ? 'You are ' + (S.me === 'w' ? 'White' : 'Black') + '. Click a piece, or drag it.' : '';
    }
    $('#bot-undo').disabled = S.thinking || c.history().length < (S.me === 'w' ? 2 : 3);
    $('#bot-resign').hidden = !!S.over;
  }

  function renderEnd() {
    const card = $('#bot-end');
    if (!S.over || S.dismissed) { card.hidden = true; return; }
    const { over } = S;
    const tone = !over.winner ? 'draw' : over.winner === S.me ? 'win' : 'lose';
    const title = !over.winner ? 'Draw' : over.winner === S.me ? 'You won!' : 'You lost';
    card.textContent = '';
    const inner = el('div', 'endcard-inner');
    inner.setAttribute('role', 'dialog');
    const close = el('button', 'end-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => { S.dismissed = true; card.hidden = true; });
    const icon = el('div', 'end-icon ' + tone);
    icon.innerHTML = ICONS[tone === 'draw' ? 'draw' : tone === 'win' ? 'crown' : (over.reason === 'resign' ? 'flag' : 'mate')];
    const reason = el('p', 'end-reason', over.reasonText);
    const review = el('button', 'btn primary big', 'Game review');
    review.type = 'button'; review.id = 'bot-review';
    review.hidden = S.chess.history().length < 1;
    review.addEventListener('click', () => {
      try { sessionStorage.setItem('kingside-pgn', pgn()); } catch (e) { /* ignore */ }
      location.hash = '#/analysis';
    });
    const row = el('div', 'end-row');
    const again = el('button', 'btn', 'Play again'); again.type = 'button'; again.id = 'bot-again';
    again.addEventListener('click', async () => {
      stopThinking();
      try { await ensureEngine(); await startGame(); } catch (err) { renderSetup(); }
    });
    const change = el('button', 'btn', 'Change level'); change.type = 'button';
    change.addEventListener('click', () => { stopThinking(); renderSetup(); });
    row.append(again, change);
    inner.append(close, icon, el('h2', null, title), reason, review, row);
    card.appendChild(inner);
    card.hidden = false;
  }

  function renderAll() {
    renderBoard();
    renderStrips();
    renderMoves();
    renderStatus();
    renderEnd();
    $('#bot-promo').hidden = !S.promo;
  }

  function pgn() {
    const c = S.chess;
    const me = 'You', bot = 'Stockfish (level ' + settings.level + ')';
    c.setHeader('Event', 'Kingside: practice game');
    c.setHeader('White', S.me === 'w' ? me : bot);
    c.setHeader('Black', S.me === 'b' ? me : bot);
    c.setHeader('Result', S.over ? S.over.result : '*');
    return c.pgn();
  }

  /* ---------------- moves ---------------- */
  function checkEnd() {
    const c = S.chess;
    if (c.isCheckmate()) {
      const winner = c.turn() === 'w' ? 'b' : 'w';
      S.over = { winner, reason: 'checkmate', reasonText: 'by checkmate', result: winner === 'w' ? '1-0' : '0-1', text: (winner === 'w' ? 'White' : 'Black') + ' wins by checkmate' };
    } else if (c.isDraw()) {
      const why = c.isStalemate() ? 'stalemate' : c.isThreefoldRepetition() ? 'repetition' : c.isInsufficientMaterial() ? 'insufficient material' : 'the 50-move rule';
      S.over = { winner: null, reason: 'draw', reasonText: 'by ' + why, result: '1/2-1/2', text: 'Draw by ' + why };
    }
    if (S.over) { sound('end'); }
  }

  function finish(reason) {
    // only resignation comes through here
    stopThinking();
    const winner = S.me === 'w' ? 'b' : 'w';
    S.over = { winner, reason: 'resign', reasonText: 'by resignation', result: winner === 'w' ? '1-0' : '0-1', text: 'You resigned' };
    sound('end');
    renderAll();
  }

  function play(move) {
    const m = S.chess.move(move);
    S.last = { from: m.from, to: m.to };
    S.selected = null;
    S.promo = null;
    sound(m.captured ? 'capture' : 'move');
    checkEnd();
    return m;
  }

  function tryMove(from, to) {
    const c = S.chess;
    const piece = c.get(from);
    const moves = c.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!piece || !moves.length) return false;
    if (moves.some((m) => m.promotion)) {
      S.promo = { from, to };
      showPromo();
      return true;
    }
    play({ from, to });
    renderAll();
    if (!S.over) botMove();
    return true;
  }

  function showPromo() {
    const box = $('#bot-promo');
    box.textContent = '';
    box.onclick = () => { S.promo = null; box.hidden = true; };   // click outside the choices to cancel
    const inner = el('div', 'promo-inner');
    for (const piece of ['q', 'r', 'b', 'n']) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece]);
      const img = el('img', 'pc');
      img.src = 'pieces/' + S.me + piece.toUpperCase() + '.svg'; img.alt = ''; img.draggable = false;
      b.appendChild(img);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = S.promo;
        if (!p) return;
        play({ from: p.from, to: p.to, promotion: piece });
        renderAll();
        if (!S.over) botMove();
      });
      inner.appendChild(b);
    }
    box.appendChild(inner);
    box.hidden = false;
  }

  async function botMove() {
    const my = ++session;
    S.thinking = true;
    renderStatus();
    renderStripsOnly();
    const started = Date.now();
    try {
      const fen = S.chess.fen();
      let uci = await engine.bestMove(fen, S.level);
      if (my !== session || !S || S.over) return;
      const legal = S.chess.moves({ verbose: true });
      if (S.level.blunder && Math.random() < S.level.blunder && legal.length) {
        const r = legal[Math.floor(Math.random() * legal.length)];
        uci = r.from + r.to + (r.promotion || '');
      }
      const wait = Math.max(0, 450 - (Date.now() - started));   // never answer faster than a person would
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (my !== session || !S || S.over) return;
      if (!uci) { S.thinking = false; checkEnd(); renderAll(); return; }
      S.thinking = false;
      play({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      renderAll();
    } catch (err) {
      if (my !== session || !S) return;
      S.thinking = false;
      $('#bot-status').textContent = 'Stockfish stopped working';
      $('#bot-sub').textContent = err.message || 'Start a new game to try again.';
    }
  }

  function renderStripsOnly() { if (S) renderStrips(); }

  function takeBack() {
    if (!S || S.thinking) return;
    const c = S.chess;
    // Go back to the last position where it was your turn before your most recent move.
    if (c.history().length === 0) return;
    if (c.turn() === S.me) { c.undo(); if (c.history().length && c.turn() !== S.me) c.undo(); }
    else c.undo();
    S.over = null; S.dismissed = false; S.selected = null; S.promo = null;
    const h = c.history({ verbose: true });
    S.last = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
    renderAll();
    if (c.turn() !== S.me && !c.isGameOver()) botMove();
  }

  /* ---------------- clicking and dragging ---------------- */
  const mine = (p) => p && p.color === S.me;
  let suppressClick = false;

  function canMove() { return S && !S.over && !S.thinking && !S.promo && S.chess.turn() === S.me; }

  function onBoardClick(e) {
    if (suppressClick) { suppressClick = false; return; }
    if (!canMove()) return;
    const sqEl = e.target.closest('.sq');
    if (!sqEl) return;
    const sq = sqEl.dataset.sq;
    if (S.selected && S.selected !== sq && tryMove(S.selected, sq)) return;
    const p = S.chess.get(sq);
    S.selected = mine(p) && S.selected !== sq ? sq : null;
    renderBoard();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !e.isPrimary) return;
    suppressClick = false;
    if (!canMove()) return;
    const sqEl = e.target.closest('.sq');
    if (!sqEl) return;
    const from = sqEl.dataset.sq;
    if (!mine(S.chess.get(from))) return;
    e.preventDefault();
    const size = sqEl.getBoundingClientRect().width;
    const startX = e.clientX, startY = e.clientY;
    const wasSelected = S.selected === from;
    if (!wasSelected) { S.selected = from; renderBoard(); suppressClick = true; }
    const p = S.chess.get(from);
    let ghost = null, dragging = false;
    const lift = (ev) => (ev.pointerType === 'touch' ? size * 0.9 : 0);   // on a phone the piece floats above the finger so you can see it
    const place = (ev) => { ghost.style.left = ev.clientX - size * 0.6 + 'px'; ghost.style.top = ev.clientY - lift(ev) - size * 0.6 + 'px'; };
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        ghost = el('img', 'pc drag-ghost');
        ghost.src = 'pieces/' + p.color + p.type.toUpperCase() + '.svg'; ghost.alt = ''; ghost.draggable = false;
        ghost.style.width = ghost.style.height = size * 1.2 + 'px';
        document.body.appendChild(ghost);
        const orig = $('#bot-board .sq[data-sq="' + from + '"] img.pc');
        if (orig) orig.classList.add('lifted');
      }
      place(ev);
    };
    const end = (ev, cancelled) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!dragging) { setTimeout(() => { suppressClick = false; }, 60); return; }
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      ghost.remove();
      if (cancelled || !S) return renderBoard();
      const under = document.elementFromPoint(ev.clientX, ev.clientY - lift(ev));
      const sq = under && under.closest('.sq') && $('#bot-board').contains(under) ? under.closest('.sq').dataset.sq : null;
      if (sq && sq !== from && tryMove(from, sq)) return;
      if (sq !== from) S.selected = null;
      renderBoard();
    };
    const onUp = (ev) => end(ev, false);
    const onCancel = (ev) => end(ev, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /* ---------------- show / hide ---------------- */
  function show() {
    active = true;
    renderSetup();
  }

  function hide() {
    active = false;
    stopEngine();
    S = null;
    const box = $('#bot');
    if (box) box.textContent = '';
  }

  window.KingsideBot = { show, hide };
})();
