/* The daily puzzle: a forced mate that is the same for everybody on a given day.
   Everything runs in the browser. Which puzzle is "today's" depends only on the date, and your streak is
   remembered in this browser. */
(function () {
  'use strict';

  const K = window.KINGSIDE;
  const FILES = 'abcdefgh';
  const KEY = 'kingside.puzzle';

  const $ = (sel, el) => (el || document).querySelector(sel);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const sound = (kind) => { try { if (window.KingsideSound) window.KingsideSound.play(kind); } catch (e) { /* no sound */ } };

  let Chess = null;
  let bank = null;
  async function load() {
    if (!Chess) Chess = (await import(K.localEngine ? K.localEngine.chessModule : K.url('/vendor/chess.js'))).Chess;
    if (!bank) {
      const r = await fetch(K.asset('puzzles.json'), { cache: 'no-cache' });
      if (!r.ok) throw new Error('The puzzle list could not be loaded.');
      bank = await r.json();
    }
  }

  /* ---------- which day is it, and how is the streak doing ---------- */
  const dayNumber = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const dayLabel = (n) => new Date(n * 86400000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  function history() {
    try { const h = JSON.parse(localStorage.getItem(KEY) || '{}'); return h && typeof h === 'object' ? h : {}; } catch (e) { return {}; }
  }
  function remember(day, mistakes) {
    const h = history();
    if (h[day] === undefined) h[day] = mistakes;
    try { localStorage.setItem(KEY, JSON.stringify(h)); } catch (e) { /* storage unavailable */ }
  }
  function streak(today) {
    const h = history();
    let n = h[today] !== undefined ? today : today - 1;      // a streak is still alive if you only missed "today so far"
    let count = 0;
    while (h[n] !== undefined) { count++; n--; }
    return count;
  }

  /* ---------- state ---------- */
  let S = null;        // current puzzle session
  let active = false;
  let suppressClick = false;
  let timer = null;

  function kingSquare(chess, color) {
    for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
    return null;
  }

  async function show() {
    active = true;
    const box = $('#puzzle');
    box.textContent = '';
    box.appendChild(el('p', 'bot-load', 'Loading today\'s puzzle...'));
    try { await load(); } catch (e) {
      if (!active) return;
      box.textContent = '';
      box.appendChild(el('p', 'bot-load error', e.message || 'The puzzle could not be loaded.'));
      return;
    }
    if (!active) return;
    start(dayNumber(new Date()));
  }

  function hide() {
    active = false;
    S = null;
    clearTimeout(timer);
    const box = $('#puzzle');
    if (box) box.textContent = '';
  }

  function start(day) {
    const p = bank[((day % bank.length) + bank.length) % bank.length];
    const chess = new Chess(p.fen);
    S = { day, p, chess, step: 0, mistakes: 0, hinted: false, last: null, selected: null, done: false, gaveUp: false, me: chess.turn(), busy: false, note: '' };
    document.title = 'Daily puzzle - Kingside';
    build();
    render();
  }

  /* ---------- page ---------- */
  function build() {
    const box = $('#puzzle');
    box.textContent = '';
    const game = el('div', 'game bot-game');
    const left = el('div', 'game-board');
    const wrap = el('div', 'board-wrap');
    const board = el('div', 'board'); board.id = 'pz-board';
    wrap.appendChild(board);
    left.appendChild(wrap);

    const side = el('aside', 'side');
    const info = el('div', 'gameinfo');
    info.append(el('span', null, 'Daily puzzle'), el('span', 'tag', 'Mate in ' + S.p.mate));
    const date = el('div', 'status-sub', dayLabel(S.day));
    const status = el('div', 'status'); status.id = 'pz-status'; status.setAttribute('aria-live', 'polite');
    const sub = el('div', 'status-sub'); sub.id = 'pz-sub';
    const streakEl = el('div', 'status-sub'); streakEl.id = 'pz-streak';
    const controls = el('div', 'controls');
    const mk = (id, text) => { const b = el('button', 'btn small', text); b.type = 'button'; b.id = id; return b; };
    const hint = mk('pz-hint', 'Hint');
    const solution = mk('pz-solution', 'Show solution');
    const retry = mk('pz-retry', 'Try again'); retry.hidden = true;
    controls.append(hint, solution, retry);
    side.append(info, date, status, sub, streakEl, controls);
    game.append(left, side);
    box.appendChild(game);

    board.addEventListener('click', onBoardClick);
    board.addEventListener('pointerdown', onPointerDown);
    hint.addEventListener('click', () => { if (S && !S.done && !S.busy) { S.hinted = true; render(); } });
    solution.addEventListener('click', showSolution);
    retry.addEventListener('click', () => start(S.day));
  }

  function render() {
    if (!S) return;
    renderBoard();
    const { p } = S;
    const side = S.me === 'w' ? 'White' : 'Black';
    const n = Math.ceil((p.solution.length - S.step) / 2);
    let text;
    if (S.done && S.gaveUp) text = 'Solution shown';
    else if (S.done) text = 'Solved!';
    else text = side + ' to move: mate in ' + n;
    $('#pz-status').textContent = text;
    $('#pz-sub').textContent = S.note || (S.done
      ? (S.gaveUp ? 'This one does not count towards your streak. Try again, or come back tomorrow for a new puzzle.'
        : S.mistakes ? 'You found it with ' + S.mistakes + (S.mistakes === 1 ? ' wrong try.' : ' wrong tries.') : 'First try, well done!')
      : 'Find the only move that forces checkmate.');
    const today = dayNumber(new Date());
    const s = streak(today);
    $('#pz-streak').textContent = s ? 'Streak: ' + s + (s === 1 ? ' day' : ' days') : 'Solve today\'s puzzle to start a streak.';
    $('#pz-hint').hidden = S.done;
    $('#pz-solution').hidden = S.done;
    $('#pz-retry').hidden = !(S.done && S.gaveUp);
  }

  function renderBoard() {
    const { chess } = S;
    const board = $('#pz-board');
    const ori = S.me;
    const targets = new Set();
    if (S.selected && !S.done) for (const m of chess.moves({ square: S.selected, verbose: true })) targets.add(m.to);
    const hintSq = S.hinted && !S.done && chess.turn() === S.me ? S.p.solution[S.step].slice(0, 2) : null;
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
      const pc = chess.get(sq);
      if (S.last && (S.last.from === sq || S.last.to === sq)) d.classList.add('last');
      if (S.selected === sq) d.classList.add('sel');
      if (hintSq === sq) d.classList.add('sel');
      if (targets.has(sq)) d.classList.add(pc ? 'capture' : 'target');
      if (checkSq === sq) d.classList.add('check');
      if (pc) {
        const img = el('img', 'pc');
        img.src = 'pieces/' + pc.color + pc.type.toUpperCase() + '.svg';
        img.alt = ''; img.draggable = false;
        d.appendChild(img);
      }
      frag.appendChild(d);
    }
    board.textContent = '';
    board.appendChild(frag);
    if (S.done && !S.gaveUp) {
      const sq = kingSquare(chess, S.me);
      const d = sq && $('#pz-board .sq[data-sq="' + sq + '"]');
      if (d) {
        const b = el('span', 'badge win');
        b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 17 3 8l5 4 4-7 4 7 5-4-1 9z" fill="#fff"/><rect x="4" y="18.5" width="16" height="2.2" rx="1" fill="#fff"/></svg>';
        d.appendChild(b);
      }
    }
  }

  /* ---------- playing ---------- */
  function play(uci) {
    const m = S.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    S.last = { from: m.from, to: m.to };
    S.selected = null;
    sound(S.chess.isCheckmate() ? 'end' : m.captured ? 'capture' : 'move');
    return m;
  }

  function tryMove(from, to) {
    if (!S || S.done || S.busy || S.chess.turn() !== S.me) return false;
    const c = S.chess;
    const legal = c.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!legal.length) return false;
    const want = S.p.solution[S.step];
    const promo = legal.some((m) => m.promotion) ? (want.slice(0, 4) === from + to ? want[4] || 'q' : 'q') : undefined;
    const uci = from + to + (promo || '');
    S.note = '';
    if (uci !== want) {
      // wrong: show it briefly, then put the piece back
      S.mistakes++;
      play(uci);
      S.busy = true;
      S.note = 'That is not the move. Try again.';
      render();
      timer = setTimeout(() => {
        if (!S) return;
        S.chess.undo();
        S.last = null;
        S.busy = false;
        render();
      }, 700);
      return true;
    }
    play(uci);
    S.step++;
    if (S.step >= S.p.solution.length) return finish();
    S.busy = true;
    render();
    timer = setTimeout(() => {          // the opponent answers
      if (!S) return;
      play(S.p.solution[S.step]);
      S.step++;
      S.busy = false;
      render();
    }, 550);
    return true;
  }

  function finish() {
    S.done = true;
    S.busy = false;
    remember(S.day, S.mistakes);
    render();
    return true;
  }

  function showSolution() {
    if (!S || S.done || S.busy) return;
    S.gaveUp = true;
    S.busy = true;
    S.note = 'Watch the solution.';
    const run = () => {
      if (!S) return;
      if (S.step >= S.p.solution.length) { S.done = true; S.busy = false; S.note = ''; render(); return; }
      play(S.p.solution[S.step]);
      S.step++;
      render();
      timer = setTimeout(run, 900);
    };
    S.selected = null;
    run();
  }

  /* ---------- clicking and dragging ---------- */
  const mine = (pc) => pc && pc.color === S.me;
  const canMove = () => S && !S.done && !S.busy && S.chess.turn() === S.me;

  function onBoardClick(e) {
    if (suppressClick) { suppressClick = false; return; }
    if (!canMove()) return;
    const sqEl = e.target.closest('.sq');
    if (!sqEl) return;
    const sq = sqEl.dataset.sq;
    if (S.selected && S.selected !== sq && tryMove(S.selected, sq)) return;
    S.selected = mine(S.chess.get(sq)) && S.selected !== sq ? sq : null;
    render();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !e.isPrimary) return;
    suppressClick = false;
    if (!canMove()) return;
    const sqEl = e.target.closest('.sq');
    if (!sqEl) return;
    const from = sqEl.dataset.sq;
    const pc = S.chess.get(from);
    if (!mine(pc)) return;
    e.preventDefault();
    const size = sqEl.getBoundingClientRect().width;
    const startX = e.clientX, startY = e.clientY;
    if (S.selected !== from) { S.selected = from; render(); suppressClick = true; }
    let ghost = null, dragging = false;
    const lift = (ev) => (ev.pointerType === 'touch' ? size * 0.9 : 0);   // on a phone the piece floats above the finger so you can see it
    const place = (ev) => { ghost.style.left = ev.clientX - size * 0.6 + 'px'; ghost.style.top = ev.clientY - lift(ev) - size * 0.6 + 'px'; };
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        ghost = el('img', 'pc drag-ghost');
        ghost.src = 'pieces/' + pc.color + pc.type.toUpperCase() + '.svg'; ghost.alt = ''; ghost.draggable = false;
        ghost.style.width = ghost.style.height = size * 1.2 + 'px';
        document.body.appendChild(ghost);
        const orig = $('#pz-board .sq[data-sq="' + from + '"] img.pc');
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
      if (cancelled || !S) return S && render();
      const under = document.elementFromPoint(ev.clientX, ev.clientY - lift(ev));
      const sq = under && under.closest('.sq') && $('#pz-board').contains(under) ? under.closest('.sq').dataset.sq : null;
      if (sq && sq !== from && tryMove(from, sq)) return;
      if (sq !== from) S.selected = null;
      render();
    };
    const onUp = (ev) => end(ev, false);
    const onCancel = (ev) => end(ev, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  window.KingsidePuzzle = { show, hide, _dayNumber: dayNumber, _start: (d) => { if (S) start(d); } };   // the last two are for tests
})();
