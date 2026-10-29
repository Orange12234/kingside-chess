/* The Tournaments pages: the list (with the owner's "start a tournament" form) and one tournament's live standings. */
(function () {
  'use strict';
  const A = () => window.KINGSIDE_APP;
  const $ = (sel, el) => (el || document).querySelector(sel);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const TCS = ['1+0', '3+0', '3+2', '5+0', '5+3', '10+0', '15+10'];
  const label = (tc) => tc.replace('+', ' + ');
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  };

  let active = false;
  let timer = null;
  let route = null;
  let skew = 0;          // server time minus this device's time, so the countdown is right even if the clock is off

  function box() { return $('#tournament'); }
  function stop() { clearInterval(timer); timer = null; }

  async function show(r) {
    active = true;
    route = r;
    stop();
    document.title = 'Tournaments - Kingside';
    await refresh();
    if (!active) return;
    timer = setInterval(refresh, 3000);
  }
  function hide() {
    active = false;
    stop();
    const b = box();
    if (b) b.textContent = '';
  }

  async function refresh() {
    if (!active) return;
    try {
      if (route.id) {
        const t = await A().api('/api/tournaments/' + route.id);
        if (!active) return;
        skew = t.now - Date.now();
        renderOne(t);
      } else {
        const d = await A().api('/api/tournaments');
        if (!active) return;
        skew = d.now - Date.now();
        renderList(d);
      }
    } catch (e) {
      if (!active) return;
      const b = box();
      b.textContent = '';
      b.appendChild(el('p', 'bot-load error', e.message || 'Could not load tournaments.'));
      b.appendChild(Object.assign(el('a', 'btn small', 'All tournaments'), { href: '#/tournaments' }));
      stop();
    }
  }

  function statusText(t) {
    const now = Date.now() + skew;
    if (t.status === 'upcoming') return 'Starts in ' + clock(t.startAt - now);
    if (t.status === 'running') return 'Running · ' + clock(t.endAt - now) + ' left';
    return 'Finished';
  }

  async function act(id, action, body, done) {
    try {
      await A().api('/api/tournaments/' + id + '/' + action, { method: 'POST', body: body || {} });
      if (done) done();
      refresh();
    } catch (e) { A().toast(e.message); }
  }

  /* ---------- the list ---------- */
  function renderList(d) {
    const b = box();
    const old = b.querySelector('.t-lists');
    const lists = el('div', 't-lists');
    lists.appendChild(el('h2', null, 'Open tournaments'));
    if (!d.open.length) lists.appendChild(el('p', 'hint', 'No tournament is running or planned right now.'));
    for (const t of d.open) lists.appendChild(row(t));
    if (d.finished.length) {
      lists.appendChild(el('h2', null, 'Recent results'));
      for (const t of d.finished) lists.appendChild(row(t));
    }
    if (!old) {
      b.textContent = '';
      b.appendChild(el('h1', null, 'Tournaments'));
      b.appendChild(el('p', 'hint', 'Arena tournaments: join, and you are paired with other players automatically for as long as it runs. Win = 2 points, draw = 1, loss = 0, and two or more wins in a row score double. Games are rated.'));
      if (d.canCreate) b.appendChild(createForm());
      b.appendChild(lists);
    } else {
      old.replaceWith(lists);
    }
  }

  function row(t) {
    const card = el('section', 'card t-row');
    const top = el('div', 't-top');
    const a = el('a', 'plink', t.name); a.href = '#/t/' + t.id;
    top.append(a, el('span', 'tag', label(t.tc)));
    card.appendChild(top);
    card.appendChild(el('p', 'hint', statusText(t) + ' · ' + t.minutes + ' min · ' + t.players + (t.players === 1 ? ' player' : ' players') + (t.winner ? ' · winner: ' + t.winner : '')));
    const open = el('a', 'btn small' + (t.status !== 'finished' ? ' primary' : ''), t.status === 'finished' ? 'Results' : t.joined ? 'Open' : 'View and join');
    open.href = '#/t/' + t.id;
    card.appendChild(open);
    return card;
  }

  function createForm() {
    const card = el('section', 'card');
    card.appendChild(el('h2', null, 'Start a tournament'));
    const f = el('form', 't-form'); f.id = 't-form';
    const field = (text, input) => { const l = el('label', null, text); l.appendChild(input); return l; };
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 40; name.required = true; name.value = 'Kingside Arena'; name.minLength = 3;
    const tc = document.createElement('select');
    for (const t of TCS) { const o = document.createElement('option'); o.value = t; o.textContent = label(t); if (t === '3+0') o.selected = true; tc.appendChild(o); }
    const minutes = document.createElement('input'); minutes.type = 'number'; minutes.min = 10; minutes.max = 180; minutes.value = 45;
    const delay = document.createElement('input'); delay.type = 'number'; delay.min = 0; delay.max = 120; delay.value = 0;
    f.append(field('Name', name), field('Time per player', tc), field('Lasts (minutes)', minutes), field('Starts in (minutes, 0 = right now)', delay));
    const go = el('button', 'btn primary', 'Create tournament'); go.type = 'submit';
    f.appendChild(go);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await A().api('/api/tournaments', { method: 'POST', body: { name: name.value, tc: tc.value, minutes: Number(minutes.value), delay: Number(delay.value) } });
        location.hash = '#/t/' + r.id;
      } catch (err) { A().toast(err.message); }
    });
    card.appendChild(f);
    return card;
  }

  /* ---------- one tournament ---------- */
  function renderOne(t) {
    const b = box();
    const typing = document.activeElement && b.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (typing) return;
    const user = A().user();
    b.textContent = '';
    const back = el('a', 'plink', '← All tournaments'); back.href = '#/tournaments';
    b.appendChild(back);
    b.appendChild(el('h1', null, t.name));
    const info = el('div', 't-info');
    info.append(el('span', 'tag', label(t.tc)), el('span', null, statusText(t)), el('span', 'hint', t.minutes + ' minutes · ' + t.players + (t.players === 1 ? ' player' : ' players')));
    b.appendChild(info);

    const actions = el('div', 't-actions');
    const btn = (text, cls, fn) => { const x = el('button', 'btn small' + (cls ? ' ' + cls : ''), text); x.type = 'button'; x.addEventListener('click', fn); actions.appendChild(x); return x; };
    if (t.status !== 'finished') {
      if (!user) btn('Log in to join', 'primary', () => A().needAccount('Log in to join the tournament.'));
      else if (!t.joined) btn('Join tournament', 'primary', () => act(t.id, 'join'));
      else {
        if (t.me && t.me.paused) btn('Resume playing', 'primary', () => act(t.id, 'pause', { paused: false }));
        else btn('Pause (stop being paired)', '', () => act(t.id, 'pause', { paused: true }));
        btn('Leave', '', () => act(t.id, 'leave'));
      }
      if (t.canManage) {
        if (t.status === 'upcoming') btn('Start now', 'primary', () => act(t.id, 'start'));
        btn(t.status === 'upcoming' ? 'Cancel tournament' : 'End now', 'danger', () => { if (confirm('End this tournament now? Games in progress still count.')) act(t.id, 'end'); });
      }
    }
    b.appendChild(actions);
    if (t.joined && t.status === 'running' && t.me && !t.me.paused) b.appendChild(el('p', 'hint', 'You are in the pool: when you are free you will be paired automatically. Keep this site open.'));
    if (t.joined && t.status === 'upcoming') b.appendChild(el('p', 'hint', 'You are in. The first games start when the tournament does.'));

    const card = el('section', 'card');
    card.appendChild(el('h2', null, t.status === 'finished' ? 'Final standings' : 'Standings'));
    if (!t.standings.length) card.appendChild(el('p', 'hint', 'Nobody has joined yet.'));
    else {
      const table = el('table', 't-table');
      const head = el('tr');
      for (const h of ['#', 'Player', 'Points', 'Games', 'W / D / L']) head.appendChild(el('th', null, h));
      table.appendChild(head);
      for (const s of t.standings) {
        const tr = el('tr');
        if (user && s.username === user.username) tr.className = 'me';
        tr.appendChild(el('td', null, String(s.rank)));
        const td = el('td');
        const dot = el('span', 'online-dot' + (s.online ? ' on' : '')); dot.title = s.online ? 'Online' : 'Offline';
        const nm = el('span', 't-name');
        A().fillName(nm, { name: s.username, title: s.title, role: s.role, reg: true });
        td.append(dot, nm);
        if (s.playing) td.appendChild(el('span', 'tag', 'playing'));
        else if (s.paused) td.appendChild(el('span', 'tag', 'paused'));
        if (s.streak >= 2) td.appendChild(el('span', 'tag hot', s.streak + ' in a row'));
        tr.appendChild(td);
        tr.appendChild(el('td', 'num', String(s.score)));
        tr.appendChild(el('td', 'num', String(s.games)));
        tr.appendChild(el('td', 'num', s.wins + ' / ' + s.draws + ' / ' + s.losses));
        table.appendChild(tr);
      }
      card.appendChild(table);
    }
    b.appendChild(card);
  }

  window.KingsideTournament = { show, hide };
})();
