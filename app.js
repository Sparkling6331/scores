// app.js — main controller for Scores Famille
import * as drive from './drive.js';
import * as stats from './stats.js';

// ---------- State ----------
const DEVICE_ID = (() => {
  let v = localStorage.getItem('scores.deviceId');
  if (!v) { v = 'd_' + Math.random().toString(36).slice(2, 12); localStorage.setItem('scores.deviceId', v); }
  return v;
})();

const state = {
  db: null,
  revisionId: null,
  currentScreen: 'home',
  currentMatchId: null,
  newMatch: { gameId: null, playerIds: [] },
  saveQueued: false,
  saving: false,
  configuredClientId: localStorage.getItem('scores.clientId') || '',
  myName: localStorage.getItem('scores.myName') || '',
};
const LOCK_TTL_MS = 30000;
const LOCK_REFRESH_MS = 10000;

// Empty DB skeleton
function emptyDb() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    players: [],
    games: [],
    matches: [],
    locks: {},
  };
}

// ---------- Helpers ----------
const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v === false || v == null) {}
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
};
const tpl = id => document.getElementById(id).content.firstElementChild.cloneNode(true);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => { const d = new Date(iso); return d.toLocaleDateString('fr-FR'); };
const fmtDateTime = iso => { const d = new Date(iso); return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); };

function syncbar(state_, msg) {
  const b = $('#syncbar');
  b.className = state_ || '';
  b.textContent = msg || '';
}

// ---------- DB merge (conflict resolution) ----------
function mergeDbs(local, remote) {
  // Union players by id (newer name wins by updatedAt tiebreak if present, else local)
  const byId = arr => Object.fromEntries(arr.map(x => [x.id, x]));
  const lp = byId(local.players), rp = byId(remote.players);
  const players = Object.values({ ...rp, ...lp });

  const lg = byId(local.games), rg = byId(remote.games);
  const games = Object.values({ ...rg, ...lg });

  // Matches: union by id; for each match, merge fields and rounds
  const lm = byId(local.matches), rm = byId(remote.matches);
  const allIds = new Set([...Object.keys(lm), ...Object.keys(rm)]);
  const matches = [];
  for (const id of allIds) {
    const a = lm[id], b = rm[id];
    if (!a) { matches.push(b); continue; }
    if (!b) { matches.push(a); continue; }
    // merge rounds by n, keeping the round with the latest "at"
    const byN = {};
    for (const r of a.rounds) byN[r.n] = r;
    for (const r of b.rounds) {
      const ex = byN[r.n];
      if (!ex || (r.at || '') > (ex.at || '')) byN[r.n] = r;
    }
    const rounds = Object.values(byN).sort((x, y) => x.n - y.n);
    // status: if either finished, finished
    const status = (a.status === 'finished' || b.status === 'finished') ? 'finished' : 'ongoing';
    const endedAt = a.endedAt && b.endedAt ? (a.endedAt > b.endedAt ? a.endedAt : b.endedAt) : (a.endedAt || b.endedAt);
    const winnerIds = a.winnerIds || b.winnerIds;
    // playerIds: take union (in case a device added a player)
    const playerIds = Array.from(new Set([...(a.playerIds || []), ...(b.playerIds || [])]));
    matches.push({ ...a, ...b, rounds, status, endedAt, winnerIds, playerIds });
  }

  // Locks: take remote (server is source of truth); also drop expired
  const now = Date.now();
  const locks = {};
  for (const [mid, perRound] of Object.entries(remote.locks || {})) {
    locks[mid] = {};
    for (const [n, lk] of Object.entries(perRound)) {
      if (lk && lk.expiresAt && new Date(lk.expiresAt).getTime() > now) {
        locks[mid][n] = lk;
      }
    }
    if (!Object.keys(locks[mid]).length) delete locks[mid];
  }

  return {
    version: Math.max(local.version || 0, remote.version || 0) + 1,
    updatedAt: new Date().toISOString(),
    players, games, matches, locks,
  };
}

// ---------- Save (debounced + conflict-resolving) ----------
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 800);
}
async function doSave() {
  if (state.saving) { state.saveQueued = true; return; }
  state.saving = true;
  syncbar('warn', 'Sync…');
  try {
    state.db.updatedAt = new Date().toISOString();
    state.db.version = (state.db.version || 0) + 1;
    try {
      state.revisionId = await drive.saveDb(state.db, state.revisionId);
      syncbar('ok', 'Synchronisé');
    } catch (e) {
      if (e.code === 'CONFLICT') {
        // refetch + merge + retry
        const { db: remote, revisionId } = await drive.loadDb();
        state.db = mergeDbs(state.db, remote);
        state.revisionId = revisionId;
        state.revisionId = await drive.saveDb(state.db, state.revisionId);
        syncbar('ok', 'Synchronisé (fusion)');
        render();
      } else throw e;
    }
  } catch (e) {
    syncbar('error', 'Erreur sync: ' + e.message);
    console.error(e);
  } finally {
    state.saving = false;
    if (state.saveQueued) { state.saveQueued = false; scheduleSave(); }
  }
}

// ---------- Bootstrap ----------
init();

async function init() {
  if (!state.configuredClientId) {
    return renderWelcome({ needsClientId: true });
  }
  await drive.init({
    clientId: state.configuredClientId,
    onDbChange: (db) => { state.db = db; state.revisionId = drive.getCachedRevision(); render(); },
    onSyncStatus: (s, m) => syncbar(s, m),
  });
  if (drive.cachedFileId()) {
    // try silent sign-in via existing token (GIS will trigger if needed)
    return renderWelcome({ needsClientId: false, needsAuth: true });
  }
  renderWelcome({ needsClientId: false });
}

// ---------- Welcome / setup ----------
async function renderWelcome({ needsClientId, needsAuth }) {
  const screen = $('#screen');
  screen.innerHTML = '';
  $('#tabs').innerHTML = '';
  $('#userbox').innerHTML = '';
  const v = tpl('tpl-welcome');
  screen.appendChild(v);
  v.querySelector('#cfg-client-id').value = state.configuredClientId;
  v.querySelector('#btn-save-cfg').onclick = () => {
    let id = v.querySelector('#cfg-client-id').value.trim();
    // Strip accidental protocol prefix and trailing slashes
    id = id.replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
    if (!id) return alert('Renseigne le Client ID.');
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      if (!confirm("Le Client ID devrait finir par '.apps.googleusercontent.com'. Continuer quand même ?")) return;
    }
    state.configuredClientId = id;
    localStorage.setItem('scores.clientId', id);
    init();
  };
  if (!needsClientId) {
    v.querySelector('#btn-save-cfg').hidden = true;
    v.querySelector('#cfg-client-id').disabled = true;
    const btn = v.querySelector('#btn-signin');
    btn.hidden = false;
    btn.onclick = async () => {
      try {
        await drive.signIn();
        await afterSignIn(v);
      } catch (e) { alert('Connexion échouée: ' + e.message); }
    };
  }
}

async function afterSignIn(welcomeEl) {
  // Render user box
  renderTopbar();
  // Try cached fileId first
  let fid = drive.cachedFileId();
  if (fid) {
    try {
      await drive.setFileId(fid);
      const { db, revisionId } = await drive.loadDb();
      state.db = db; state.revisionId = revisionId;
      drive.startPoll(10000);
      return goto('home');
    } catch (e) {
      console.warn('Impossible de charger le fichier en cache:', e);
      localStorage.removeItem('scores.fileId');
    }
  }
  // Search Drive
  let found = [];
  try { found = await drive.searchDbFile(); } catch (e) { /* ignore */ }
  if (found.length === 1) {
    await drive.setFileId(found[0].id);
    const { db, revisionId } = await drive.loadDb();
    state.db = db; state.revisionId = revisionId;
    drive.startPoll(10000);
    return goto('home');
  }
  // Otherwise show setup actions
  if (welcomeEl) {
    welcomeEl.querySelector('#btn-signin').hidden = true;
    welcomeEl.querySelector('#setup-actions').hidden = false;
    welcomeEl.querySelector('#btn-create-db').onclick = async () => {
      const db = emptyDb();
      await drive.createDbFile(db);
      state.db = db; state.revisionId = drive.getCachedRevision();
      drive.startPoll(10000);
      goto('home');
    };
    welcomeEl.querySelector('#btn-create-db-seed').onclick = async () => {
      try {
        const seed = await fetch('./seed.json').then(r => r.json());
        await drive.createDbFile(seed);
        state.db = seed; state.revisionId = drive.getCachedRevision();
        drive.startPoll(10000);
        goto('home');
      } catch (e) { alert('Import seed échoué: ' + e.message); }
    };
    welcomeEl.querySelector('#btn-pick-db').onclick = async () => {
      try {
        const f = await drive.pickFile();
        await drive.setFileId(f.id);
        const { db, revisionId } = await drive.loadDb();
        state.db = db; state.revisionId = revisionId;
        drive.startPoll(10000);
        goto('home');
      } catch (e) { alert('Sélection annulée ou échouée: ' + e.message); }
    };
  }
}

// ---------- Top bar ----------
function renderTopbar() {
  const u = drive.getUser();
  const ub = $('#userbox');
  ub.innerHTML = '';
  if (u.email) {
    ub.appendChild(el('span', {}, u.name || u.email));
    ub.appendChild(el('button', {
      onclick: () => { drive.signOut(); location.reload(); }
    }, 'Déconnexion'));
  }
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const [id, label] of [
    ['home', 'Parties'],
    ['players', 'Joueurs'],
    ['games', 'Jeux'],
    ['stats', 'Stats'],
    ['history', 'Historique'],
  ]) {
    const b = el('button', { onclick: () => goto(id) }, label);
    if (id === state.currentScreen) b.classList.add('active');
    tabs.appendChild(b);
  }
}

function goto(screen, opts = {}) {
  // Cleanup when leaving match screen
  if (state.currentScreen === 'match' && screen !== 'match') {
    clearLockRefresh();
    try { drive.setPollInterval(10000); } catch (e) {}
  }
  state.currentScreen = screen;
  if (opts.matchId !== undefined) state.currentMatchId = opts.matchId;
  renderTopbar();
  render();
}

// ---------- Render dispatcher ----------
function render() {
  if (!state.db) return;
  const s = $('#screen');
  s.innerHTML = '';
  switch (state.currentScreen) {
    case 'home': return renderHome(s);
    case 'newMatch': return renderNewMatch(s);
    case 'match': return renderMatch(s);
    case 'players': return renderPlayers(s);
    case 'games': return renderGames(s);
    case 'stats': return renderStats(s);
    case 'history': return renderHistory(s);
  }
}

// ---------- Home ----------
function renderHome(screen) {
  const v = tpl('tpl-home');
  screen.appendChild(v);
  v.querySelector('#btn-new-match').onclick = () => {
    state.newMatch = { gameId: state.db.games[0]?.id || null, playerIds: [] };
    goto('newMatch');
  };

  const games = Object.fromEntries(state.db.games.map(g => [g.id, g]));
  const players = Object.fromEntries(state.db.players.map(p => [p.id, p]));

  const ongoing = state.db.matches.filter(m => m.status === 'ongoing')
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const recent = state.db.matches.filter(m => m.status === 'finished')
    .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))
    .slice(0, 6);

  const oList = v.querySelector('#ongoing-list');
  if (!ongoing.length) oList.appendChild(el('div', { class: 'muted' }, 'Aucune.'));
  for (const m of ongoing) oList.appendChild(matchCard(m, games, players));

  const rList = v.querySelector('#recent-list');
  if (!recent.length) rList.appendChild(el('div', { class: 'muted' }, 'Aucune.'));
  for (const m of recent) rList.appendChild(matchCard(m, games, players));
}

function matchCard(m, games, players, opts = {}) {
  const g = games[m.gameId];
  const totals = stats.totalsOfMatch(m);
  const winners = m.status === 'finished' ? stats.winnersOfMatch(m, g) : [];
  const c = el('div', { class: 'match-card', onclick: () => goto('match', { matchId: m.id }) });
  const right = el('div', { style: 'display:flex; align-items:center; gap:8px;' },
    el('span', { class: 'meta' }, m.status === 'finished' ? fmtDate(m.endedAt || m.startedAt) : 'En cours')
  );
  if (opts.deletable !== false) {
    right.appendChild(el('button', {
      class: 'danger',
      style: 'padding:4px 8px; min-height:32px;',
      title: 'Supprimer',
      onclick: (e) => { e.stopPropagation(); deleteMatch(m.id); },
    }, '🗑'));
  }
  const top = el('div', { class: 'top' },
    el('h3', {}, g?.name || '(jeu inconnu)'),
    right,
  );
  c.appendChild(top);
  const sc = el('div', { class: 'scores' });
  for (const pid of m.playerIds) {
    const name = players[pid]?.name || '?';
    const t = totals[pid] != null ? totals[pid] : '-';
    const sp = el('span', {}, `${name}: ${t}`);
    if (winners.includes(pid)) sp.classList.add('win');
    sc.appendChild(sp);
  }
  c.appendChild(sc);
  return c;
}

// ---------- New match ----------
function renderNewMatch(screen) {
  const v = tpl('tpl-new-match');
  screen.appendChild(v);
  const gameSel = v.querySelector('#nm-game');
  for (const g of state.db.games) {
    const o = el('option', { value: g.id }, g.name);
    if (g.id === state.newMatch.gameId) o.selected = true;
    gameSel.appendChild(o);
  }
  gameSel.onchange = () => { state.newMatch.gameId = gameSel.value; renderGameConfig(); };
  function renderGameConfig() {
    const g = state.db.games.find(x => x.id === state.newMatch.gameId);
    const c = v.querySelector('#nm-game-config');
    c.innerHTML = '';
    if (!g) return;
    let endTxt = '';
    if (g.end.type === 'threshold') endTxt = `Fin: seuil ${g.end.value} (${g.scoreDir === 'low' ? 'bas gagne' : 'haut gagne'})`;
    else if (g.end.type === 'rounds') endTxt = `Fin: ${g.end.value} manches (${g.scoreDir === 'low' ? 'bas gagne' : 'haut gagne'})`;
    else endTxt = `Fin: manuelle (${g.scoreDir === 'low' ? 'bas gagne' : 'haut gagne'})`;
    c.appendChild(el('small', {}, endTxt));
    // For Sushi-style "rounds" allow override per match
    if (g.end.type === 'rounds') {
      const wrap = el('div', { class: 'form-row' });
      const lab = el('label', {}, 'Nombre de manches (par défaut ' + g.end.value + ')');
      const inp = el('input', { type: 'number', min: '1', value: g.end.value, id: 'nm-rounds' });
      lab.appendChild(inp);
      wrap.appendChild(lab);
      c.appendChild(wrap);
    }
  }
  renderGameConfig();

  const pls = v.querySelector('#nm-players');
  for (const p of state.db.players) {
    const c = el('span', { class: 'chip', onclick: () => {
      const i = state.newMatch.playerIds.indexOf(p.id);
      if (i >= 0) state.newMatch.playerIds.splice(i, 1);
      else state.newMatch.playerIds.push(p.id);
      c.classList.toggle('on');
    }}, p.name);
    if (state.newMatch.playerIds.includes(p.id)) c.classList.add('on');
    pls.appendChild(c);
  }
  v.querySelector('#nm-cancel').onclick = () => goto('home');
  v.querySelector('#nm-start').onclick = () => {
    if (state.newMatch.playerIds.length < 2) return alert('Sélectionne au moins 2 joueurs.');
    if (!state.newMatch.gameId) return alert('Choisis un jeu.');
    const game = state.db.games.find(g => g.id === state.newMatch.gameId);
    const m = {
      id: 'm_' + Math.random().toString(36).slice(2, 12),
      gameId: state.newMatch.gameId,
      playerIds: [...state.newMatch.playerIds],
      startedAt: new Date().toISOString(),
      status: 'ongoing',
      rounds: [],
    };
    // For "rounds" games, allow custom value
    const customRounds = v.querySelector('#nm-rounds');
    if (game.end.type === 'rounds' && customRounds) {
      m.endOverride = { type: 'rounds', value: parseInt(customRounds.value) || game.end.value };
    }
    state.db.matches.push(m);
    state.currentMatchId = m.id;
    scheduleSave();
    goto('match');
  };
}

// ---------- Match screen ----------
let lockRefreshTimer = null;
function clearLockRefresh() { if (lockRefreshTimer) clearInterval(lockRefreshTimer); lockRefreshTimer = null; }

function deleteMatch(matchId) {
  const m = state.db.matches.find(x => x.id === matchId);
  if (!m) return;
  const game = state.db.games.find(g => g.id === m.gameId);
  const lbl = (game?.name || 'partie') + ' du ' + fmtDate(m.endedAt || m.startedAt);
  if (!confirm(`Supprimer ${lbl} ? Cette action est irréversible.`)) return;
  state.db.matches = state.db.matches.filter(x => x.id !== matchId);
  if (state.db.locks?.[matchId]) delete state.db.locks[matchId];
  scheduleSave();
  if (state.currentMatchId === matchId) state.currentMatchId = null;
  goto(state.currentScreen === 'match' ? 'home' : state.currentScreen);
}

// Render match metadata block with players list + editable date
function renderMatchMeta(host, m, players) {
  host.innerHTML = '';
  const namesTxt = m.playerIds.map(p => players[p]?.name).join(', ');
  host.appendChild(document.createTextNode(namesTxt + ' — '));
  const dateField = m.status === 'finished' ? 'endedAt' : 'startedAt';
  const label = m.status === 'finished' ? 'terminée le' : 'démarrée le';
  host.appendChild(document.createTextNode(label + ' '));
  const isoToLocal = (iso) => {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const dateSpan = el('span', {
    class: 'editable-date',
    title: 'Cliquer pour modifier',
    style: 'text-decoration: underline dotted; cursor: pointer;',
    onclick: () => {
      const input = el('input', {
        type: 'datetime-local',
        value: isoToLocal(m[dateField] || m.startedAt),
        style: 'min-height: 32px; padding: 4px 6px;',
      });
      const saveBtn = el('button', {
        style: 'padding: 4px 8px; min-height: 32px; margin-left: 6px;',
        onclick: () => {
          if (!input.value) return;
          const iso = new Date(input.value).toISOString();
          m[dateField] = iso;
          if (dateField === 'endedAt' && new Date(iso) < new Date(m.startedAt)) {
            m.startedAt = iso;
          }
          scheduleSave();
          render();
        }
      }, 'OK');
      const cancelBtn = el('button', {
        style: 'padding: 4px 8px; min-height: 32px; margin-left: 4px;',
        onclick: () => renderMatchMeta(host, m, players),
      }, 'Annuler');
      host.innerHTML = '';
      host.appendChild(document.createTextNode(namesTxt + ' — ' + label + ' '));
      host.appendChild(input);
      host.appendChild(saveBtn);
      host.appendChild(cancelBtn);
      input.focus();
    },
  }, fmtDateTime(m[dateField] || m.startedAt));
  host.appendChild(dateSpan);
}

function endRuleOfMatch(m, game) {
  return m.endOverride || game.end;
}

function isFinished(m, game) {
  if (m.status === 'finished') return true;
  const rule = endRuleOfMatch(m, game);
  if (rule.type === 'rounds') {
    return m.rounds.length >= rule.value;
  } else if (rule.type === 'threshold') {
    const totals = stats.totalsOfMatch(m);
    return Object.values(totals).some(t => game.scoreDir === 'low' ? t >= rule.value : t >= rule.value);
  }
  return false;
}

function renderMatch(screen) {
  drive.setPollInterval(2500); // faster sync during play
  const m = state.db.matches.find(x => x.id === state.currentMatchId);
  if (!m) { goto('home'); return; }
  const game = state.db.games.find(g => g.id === m.gameId);
  const players = Object.fromEntries(state.db.players.map(p => [p.id, p]));

  const v = tpl('tpl-match');
  screen.appendChild(v);
  v.querySelector('#m-title').textContent = game.name;
  // Meta with editable date
  const metaEl = v.querySelector('#m-meta');
  renderMatchMeta(metaEl, m, players);

  v.querySelector('#m-back').onclick = () => { clearLockRefresh(); drive.setPollInterval(10000); goto('home'); };
  if (m.status === 'ongoing') {
    const btn = v.querySelector('#m-end-manual');
    btn.hidden = false;
    btn.onclick = () => endMatch(m, game);
  }
  // Delete button — added dynamically
  const actions = v.querySelector('.match-actions');
  const delBtn = el('button', {
    class: 'danger', title: 'Supprimer la partie',
    onclick: () => deleteMatch(m.id),
  }, '🗑');
  actions.insertBefore(delBtn, actions.firstChild);

  // Totals
  const totals = stats.totalsOfMatch(m);
  const rule = endRuleOfMatch(m, game);
  const leader = (() => {
    const vals = m.playerIds.map(p => totals[p]).filter(v => v != null);
    if (!vals.length) return null;
    return game.scoreDir === 'low' ? Math.min(...vals) : Math.max(...vals);
  })();
  const totalsEl = v.querySelector('#m-totals');
  for (const pid of m.playerIds) {
    const t = totals[pid] ?? 0;
    const d = el('div', { class: 'pl' },
      el('div', { class: 'nm' }, players[pid]?.name || '?'),
      el('div', { class: 'tot' }, String(t))
    );
    if (totals[pid] != null && totals[pid] === leader) d.classList.add('lead');
    if (rule.type === 'threshold' && t >= rule.value) d.classList.add('threshold-reached');
    totalsEl.appendChild(d);
  }

  // Rounds table
  const re = v.querySelector('#m-rounds');
  const table = el('table');
  const head = el('thead');
  const trh = el('tr');
  trh.appendChild(el('th', {}, 'Tour'));
  for (const pid of m.playerIds) trh.appendChild(el('th', {}, players[pid]?.name || '?'));
  head.appendChild(trh); table.appendChild(head);
  const tbody = el('tbody');
  const running = {};
  for (const pid of m.playerIds) running[pid] = 0;
  for (const r of m.rounds) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, '#' + r.n));
    for (const pid of m.playerIds) {
      const sc = r.scores[pid];
      if (sc != null) running[pid] += Number(sc);
      tr.appendChild(el('td', {}, sc == null ? '–' : `${sc} (${running[pid]})`));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  re.appendChild(table);

  // Winner banner if finished
  if (isFinished(m, game)) {
    if (m.status !== 'finished') endMatch(m, game, /*auto*/ true);
    const wb = v.querySelector('#m-winner');
    wb.hidden = false;
    wb.innerHTML = '';
    const wins = stats.winnersOfMatch(m, game);
    const names = wins.map(p => players[p]?.name).join(' & ');
    wb.appendChild(el('h2', {}, '🏆 ' + (names || '?')));
    wb.appendChild(el('div', {}, wins.length > 1 ? 'Égalité' : 'gagne la partie'));
    v.querySelector('#m-end-manual').hidden = true;
    v.querySelector('#m-entry').innerHTML = '';
    return;
  }

  // Entry area: handle lock for next round
  const nextN = (m.rounds[m.rounds.length - 1]?.n || 0) + 1;
  renderEntry(v.querySelector('#m-entry'), m, game, nextN, players);
}

function renderEntry(host, m, game, n, players) {
  host.innerHTML = '';
  const lock = state.db.locks?.[m.id]?.[n];
  const me = drive.getUser().email || DEVICE_ID;
  const myActive = lock && lock.deviceId === DEVICE_ID && new Date(lock.expiresAt).getTime() > Date.now();
  const otherActive = lock && lock.deviceId !== DEVICE_ID && new Date(lock.expiresAt).getTime() > Date.now();

  if (otherActive) {
    const secs = Math.max(0, Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000));
    host.appendChild(el('div', { class: 'lock-info' },
      `🔒 ${lock.name || 'Un autre joueur'} saisit le tour #${n} (libère dans ${secs}s)`));
    host.appendChild(el('button', { onclick: () => render() }, 'Rafraîchir'));
    if (secs <= 0) {
      const force = el('button', { class: 'danger', onclick: () => { releaseLock(m.id, n); claimLock(m.id, n); } }, 'Forcer la libération');
      host.appendChild(force);
    }
    return;
  }

  if (!myActive) {
    host.appendChild(el('button', { class: 'primary', onclick: () => { claimLock(m.id, n); } }, `Saisir tour #${n}`));
    return;
  }

  // I have the lock — show entry form
  host.appendChild(el('div', { class: 'card' },
    el('h3', {}, `Tour #${n}`),
    ...m.playerIds.map(pid => {
      const row = el('div', { class: 'entry-row' });
      row.appendChild(el('label', {}, players[pid]?.name || '?'));
      const inp = el('input', { type: 'number', inputmode: 'numeric', step: '1', placeholder: '0', 'data-pid': pid });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') host.querySelector('#submit-round').click(); });
      row.appendChild(inp);
      return row;
    }),
    el('div', { class: 'form-actions' },
      el('button', { onclick: () => { releaseLock(m.id, n); render(); } }, 'Annuler'),
      el('button', {
        id: 'submit-round', class: 'primary',
        onclick: () => submitRound(m.id, n, host),
      }, 'Valider tour')
    )
  ));
  // Auto-focus first input
  setTimeout(() => { host.querySelector('input')?.focus(); }, 50);
}

function submitRound(matchId, n, host) {
  const inputs = host.querySelectorAll('input[data-pid]');
  const scores = {};
  for (const inp of inputs) {
    const pid = inp.dataset.pid;
    const raw = inp.value.trim();
    if (raw === '') continue; // skip empties
    const num = Number(raw);
    if (!isFinite(num)) return alert('Score invalide pour un joueur.');
    scores[pid] = num;
  }
  const m = state.db.matches.find(x => x.id === matchId);
  if (!m) return;
  // Upsert round by n
  const existing = m.rounds.find(r => r.n === n);
  const newRound = { n, scores, at: new Date().toISOString(), by: DEVICE_ID };
  if (existing) Object.assign(existing, newRound);
  else m.rounds.push(newRound);
  m.rounds.sort((a, b) => a.n - b.n);
  releaseLock(matchId, n);
  scheduleSave();
  render();
}

function claimLock(matchId, n) {
  state.db.locks = state.db.locks || {};
  state.db.locks[matchId] = state.db.locks[matchId] || {};
  state.db.locks[matchId][n] = {
    deviceId: DEVICE_ID,
    name: drive.getUser().name || drive.getUser().email || 'moi',
    expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
  };
  scheduleSave();
  // refresh periodically
  clearLockRefresh();
  lockRefreshTimer = setInterval(() => {
    const lk = state.db.locks?.[matchId]?.[n];
    if (!lk || lk.deviceId !== DEVICE_ID) { clearLockRefresh(); return; }
    lk.expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();
    scheduleSave();
  }, LOCK_REFRESH_MS);
  render();
}

function releaseLock(matchId, n) {
  clearLockRefresh();
  if (state.db.locks?.[matchId]?.[n]) {
    delete state.db.locks[matchId][n];
    if (!Object.keys(state.db.locks[matchId]).length) delete state.db.locks[matchId];
    scheduleSave();
  }
}

function endMatch(m, game, auto = false) {
  m.status = 'finished';
  m.endedAt = new Date().toISOString();
  m.winnerIds = stats.winnersOfMatch(m, game);
  // Drop any locks for this match
  if (state.db.locks?.[m.id]) delete state.db.locks[m.id];
  scheduleSave();
  if (!auto) render();
}

// ---------- Players screen ----------
function renderPlayers(screen) {
  const v = tpl('tpl-players');
  screen.appendChild(v);
  const list = v.querySelector('#players-list');
  for (const p of state.db.players) {
    const row = el('div', { class: 'row' });
    row.appendChild(el('span', { class: 'nm' }, p.name));
    row.appendChild(el('button', {
      onclick: () => {
        const newName = prompt('Nouveau nom', p.name);
        if (newName && newName.trim()) { p.name = newName.trim(); scheduleSave(); render(); }
      }
    }, 'Renommer'));
    // Allow delete only if never played
    const used = state.db.matches.some(m => m.playerIds.includes(p.id));
    if (!used) {
      row.appendChild(el('button', {
        class: 'danger',
        onclick: () => {
          if (!confirm('Supprimer ' + p.name + ' ?')) return;
          state.db.players = state.db.players.filter(x => x.id !== p.id);
          scheduleSave(); render();
        }
      }, 'Supprimer'));
    }
    list.appendChild(row);
  }
  v.querySelector('#add-player').onclick = () => {
    const input = v.querySelector('#new-player-name');
    const name = input.value.trim();
    if (!name) return;
    state.db.players.push({ id: 'p_' + Math.random().toString(36).slice(2, 10), name });
    scheduleSave();
    render();
  };
}

// ---------- Games screen ----------

// Build a reusable form for a game (used in add and edit). Returns DOM element.
// `initial` is a game object (or empty defaults). `onSave({name, scoreDir, end})` and `onCancel()`.
function gameFormElement(initial, onSave, onCancel) {
  const defaults = {
    name: '', scoreDir: 'low', end: { type: 'threshold', value: 100 },
    ...initial,
  };
  const wrap = el('div', { class: 'game-form' });

  // Name
  const nameInp = el('input', { type: 'text', value: defaults.name, placeholder: 'Ex. Skyjo' });
  wrap.appendChild(el('div', { class: 'form-row' },
    el('label', {}, 'Nom du jeu', nameInp)
  ));

  // Score direction — radio chips
  const dirGroup = el('div', { class: 'chip-grid' });
  const mkDirChip = (val, txt) => {
    const c = el('span', { class: 'chip', onclick: () => {
      [...dirGroup.children].forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      dirGroup.dataset.value = val;
    }}, txt);
    if (defaults.scoreDir === val) c.classList.add('on');
    return c;
  };
  dirGroup.appendChild(mkDirChip('low', '⬇ Bas gagne'));
  dirGroup.appendChild(mkDirChip('high', '⬆ Haut gagne'));
  dirGroup.dataset.value = defaults.scoreDir;
  wrap.appendChild(el('div', { class: 'form-row' },
    el('label', {}, 'Sens du score', dirGroup)
  ));

  // End-type — chips
  const endTypeGroup = el('div', { class: 'chip-grid' });
  const endLabels = { threshold: '🎯 Seuil', rounds: '🔁 Nb de manches', manual: '✋ Manuel' };
  const mkEndChip = (val, txt) => {
    const c = el('span', { class: 'chip', onclick: () => {
      [...endTypeGroup.children].forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      endTypeGroup.dataset.value = val;
      updateValueField();
    }}, txt);
    if (defaults.end.type === val) c.classList.add('on');
    return c;
  };
  for (const [k, v] of Object.entries(endLabels)) endTypeGroup.appendChild(mkEndChip(k, v));
  endTypeGroup.dataset.value = defaults.end.type;
  wrap.appendChild(el('div', { class: 'form-row' },
    el('label', {}, 'Fin de partie', endTypeGroup)
  ));

  // Value field (depends on end type)
  const valWrap = el('div', { class: 'form-row' });
  const valInp = el('input', { type: 'number', min: '1', value: defaults.end.value || '' });
  const valLab = el('label', {});
  valWrap.appendChild(valLab);
  wrap.appendChild(valWrap);

  function updateValueField() {
    const t = endTypeGroup.dataset.value;
    valLab.innerHTML = '';
    if (t === 'manual') {
      valWrap.style.display = 'none';
    } else {
      valWrap.style.display = '';
      valLab.appendChild(document.createTextNode(t === 'threshold' ? 'Seuil (un joueur l\'atteint = fin)' : 'Nombre de manches'));
      valLab.appendChild(valInp);
    }
  }
  updateValueField();

  // Action buttons
  const errMsg = el('div', { class: 'lock-info', style: 'display:none; background:transparent; color:var(--bad);' });
  wrap.appendChild(errMsg);
  function showErr(msg) { errMsg.textContent = msg; errMsg.style.display = ''; }

  const actions = el('div', { class: 'form-actions' });
  actions.appendChild(el('button', { onclick: () => onCancel && onCancel() }, 'Annuler'));
  actions.appendChild(el('button', { class: 'primary', onclick: () => {
    errMsg.style.display = 'none';
    const name = nameInp.value.trim();
    if (!name) return showErr('Nom requis.');
    const scoreDir = dirGroup.dataset.value;
    const tp = endTypeGroup.dataset.value;
    const end = { type: tp };
    if (tp !== 'manual') {
      const n = parseInt(valInp.value);
      if (!isFinite(n) || n <= 0) return showErr('Valeur de fin de partie invalide.');
      end.value = n;
    }
    onSave({ name, scoreDir, end });
  }}, 'Enregistrer'));
  wrap.appendChild(actions);

  return wrap;
}

function renderGames(screen) {
  const card = el('section', { class: 'games card' });
  screen.appendChild(card);
  card.appendChild(el('h2', {}, 'Jeux'));

  // Editing state per render (resets between full renders)
  let editingId = renderGames._editingId || null;

  for (const g of state.db.games) {
    if (editingId === g.id) {
      // Inline edit form
      const editCard = el('div', { class: 'card', style: 'background:var(--bg);' });
      editCard.appendChild(el('h3', {}, 'Modifier ' + g.name));
      editCard.appendChild(gameFormElement(g,
        ({ name, scoreDir, end }) => {
          g.name = name; g.scoreDir = scoreDir; g.end = end;
          renderGames._editingId = null;
          scheduleSave(); render();
        },
        () => { renderGames._editingId = null; render(); }
      ));
      card.appendChild(editCard);
      continue;
    }
    const desc = g.end.type === 'threshold' ? `seuil ${g.end.value}` :
                 g.end.type === 'rounds'    ? `${g.end.value} manches` : 'manuel';
    const usedCount = state.db.matches.filter(m => m.gameId === g.id).length;
    const row = el('div', { class: 'row' });
    row.appendChild(el('div', { class: 'nm' },
      el('div', {}, g.name),
      el('small', {}, `${g.scoreDir === 'low' ? 'bas gagne' : 'haut gagne'} · ${desc} · ${usedCount} partie(s)`)
    ));
    row.appendChild(el('button', {
      onclick: () => { renderGames._editingId = g.id; render(); }
    }, '✏️ Modifier'));
    if (usedCount === 0) {
      row.appendChild(el('button', {
        class: 'danger',
        onclick: () => {
          if (!confirm(`Supprimer le jeu "${g.name}" ?`)) return;
          state.db.games = state.db.games.filter(x => x.id !== g.id);
          scheduleSave(); render();
        }
      }, '🗑'));
    }
    card.appendChild(row);
  }

  // Add new game (collapsible)
  card.appendChild(el('hr'));
  if (renderGames._adding) {
    const addCard = el('div', { class: 'card', style: 'background:var(--bg);' });
    addCard.appendChild(el('h3', {}, 'Nouveau jeu'));
    addCard.appendChild(gameFormElement(null,
      ({ name, scoreDir, end }) => {
        state.db.games.push({
          id: 'g_' + Math.random().toString(36).slice(2, 10),
          name, scoreDir, end,
        });
        renderGames._adding = false;
        scheduleSave(); render();
      },
      () => { renderGames._adding = false; render(); }
    ));
    card.appendChild(addCard);
  } else {
    card.appendChild(el('button', {
      class: 'primary big',
      onclick: () => { renderGames._adding = true; render(); }
    }, '+ Ajouter un jeu'));
  }
}

// ---------- Stats ----------
function renderStats(screen) {
  const v = tpl('tpl-stats');
  screen.appendChild(v);
  const gameSel = v.querySelector('#f-game');
  for (const g of state.db.games) gameSel.appendChild(el('option', { value: g.id }, g.name));
  const periodSel = v.querySelector('#f-period');
  const recompute = () => {
    const gameId = gameSel.value || null;
    const periodDays = periodSel.value === 'all' ? null : parseInt(periodSel.value);
    drawStats(v.querySelector('#stats-content'), { gameId, periodDays });
  };
  gameSel.onchange = recompute; periodSel.onchange = recompute;
  recompute();
}

function drawStats(host, filt) {
  host.innerHTML = '';
  const kpis = stats.playerKpis(state.db, filt);
  const players = Object.fromEntries(state.db.players.map(p => [p.id, p]));
  const games = Object.fromEntries(state.db.games.map(g => [g.id, g]));
  const matches = stats.filteredMatches(state.db, filt);

  if (!matches.length) {
    host.appendChild(el('div', { class: 'card' }, 'Aucune partie sur cette période.'));
    return;
  }

  // Global KPIs
  const totalMatches = matches.length;
  const totalRounds = matches.reduce((s, m) => s + m.rounds.length, 0);
  const kpiCard = el('div', { class: 'kpis' },
    el('div', { class: 'kpi' }, el('div', { class: 'v' }, String(totalMatches)), el('div', { class: 'l' }, 'Parties')),
    el('div', { class: 'kpi' }, el('div', { class: 'v' }, String(totalRounds)), el('div', { class: 'l' }, 'Tours joués')),
    el('div', { class: 'kpi' }, el('div', { class: 'v' }, String(Object.keys(kpis).length)), el('div', { class: 'l' }, 'Joueurs actifs')),
  );
  host.appendChild(kpiCard);

  // Per-player table
  const rows = Object.entries(kpis).map(([pid, s]) => ({ pid, ...s }));
  rows.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);
  const t = el('table', { class: 'stat' });
  const head = el('tr',
    {}, el('th', {}, 'Joueur'), el('th', {}, 'Parties'), el('th', {}, 'Victoires'),
    el('th', {}, 'Taux'), el('th', {}, 'Moy.'), el('th', {}, 'Meilleur'), el('th', {}, 'Pire')
  );
  t.appendChild(el('thead', {}, head));
  const tb = el('tbody');
  for (const r of rows) {
    tb.appendChild(el('tr', {},
      el('td', {}, players[r.pid]?.name || '?'),
      el('td', {}, String(r.played)),
      el('td', {}, String(r.wins)),
      el('td', {}, (r.winRate * 100).toFixed(0) + '%'),
      el('td', {}, r.avg.toFixed(1)),
      el('td', {}, r.best == null ? '–' : String(r.best)),
      el('td', {}, r.worst == null ? '–' : String(r.worst)),
    ));
  }
  t.appendChild(tb);
  host.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Classement'), t));

  // Podium per game (only if no game filter)
  if (!filt.gameId) {
    for (const g of state.db.games) {
      const pod = stats.podium(state.db, g.id, filt.periodDays);
      if (!pod.length) continue;
      const txt = pod.map((x, i) => `${i + 1}. ${players[x.pid]?.name || '?'} (${x.wins}V/${x.played}P)`).join(' · ');
      host.appendChild(el('div', { class: 'card' }, el('h3', {}, '🏆 ' + g.name), el('div', {}, txt)));
    }
  }

  // Head-to-head matrix
  const h2h = stats.headToHead(state.db, filt);
  const pids = Object.keys(kpis);
  if (pids.length >= 2) {
    const hh = el('table', { class: 'stat' });
    const hr = el('tr', {}, el('th', {}, ''));
    for (const p of pids) hr.appendChild(el('th', {}, players[p]?.name || '?'));
    hh.appendChild(el('thead', {}, hr));
    const hb = el('tbody');
    for (const a of pids) {
      const tr = el('tr', {}, el('td', {}, players[a]?.name || '?'));
      for (const b of pids) {
        if (a === b) tr.appendChild(el('td', {}, '—'));
        else {
          const e = h2h[a]?.[b];
          tr.appendChild(el('td', {}, e ? `${e.wins}-${e.ties}-${e.losses}` : '–'));
        }
      }
      hb.appendChild(tr);
    }
    hh.appendChild(hb);
    host.appendChild(el('div', { class: 'card h2h-grid' },
      el('h3', {}, 'Face-à-face (V-N-D)'),
      el('small', {}, 'Lecture: ligne vs colonne. V=victoires, N=nuls, D=défaites.'),
      hh
    ));
  }

  // Evolution chart for top 3 players
  const top = rows.slice(0, 3);
  if (top.length && filt.gameId) {
    const svg = drawEvoSvg(top.map(r => ({
      pid: r.pid, name: players[r.pid]?.name || '?',
      points: stats.evolution(state.db, r.pid, filt),
    })));
    host.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Évolution des totaux'), svg));
  }
}

function drawEvoSvg(series) {
  const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2'];
  const W = 700, H = 220, P = 30;
  const allPts = series.flatMap(s => s.points);
  if (!allPts.length) return el('div', {}, 'Pas de données.');
  const tMin = Math.min(...allPts.map(p => new Date(p.date).getTime()));
  const tMax = Math.max(...allPts.map(p => new Date(p.date).getTime()));
  const vMin = Math.min(...allPts.map(p => p.total));
  const vMax = Math.max(...allPts.map(p => p.total));
  const dx = tMax === tMin ? 1 : (tMax - tMin);
  const dy = vMax === vMin ? 1 : (vMax - vMin);
  const x = t => P + (new Date(t).getTime() - tMin) / dx * (W - 2 * P);
  const y = v => H - P - (v - vMin) / dy * (H - 2 * P);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'evo');
  // axes
  for (const [x1, y1, x2, y2] of [[P, H - P, W - P, H - P], [P, P, P, H - P]]) {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('class', 'axis');
    svg.appendChild(l);
  }
  // axis labels
  const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t1.setAttribute('x', P); t1.setAttribute('y', H - P + 14); t1.textContent = new Date(tMin).toLocaleDateString('fr-FR');
  svg.appendChild(t1);
  const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t2.setAttribute('x', W - P - 80); t2.setAttribute('y', H - P + 14); t2.textContent = new Date(tMax).toLocaleDateString('fr-FR');
  svg.appendChild(t2);
  series.forEach((s, i) => {
    const color = COLORS[i % COLORS.length];
    if (!s.points.length) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = '';
    s.points.forEach((p, j) => { d += (j ? ' L ' : 'M ') + x(p.date).toFixed(1) + ' ' + y(p.total).toFixed(1); });
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    svg.appendChild(path);
    for (const p of s.points) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', x(p.date)); c.setAttribute('cy', y(p.total)); c.setAttribute('r', 3);
      c.setAttribute('fill', color); c.setAttribute('class', 'pt');
      svg.appendChild(c);
    }
    const lab = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lab.setAttribute('x', W - P - 100);
    lab.setAttribute('y', P + 12 + i * 14);
    lab.setAttribute('fill', color);
    lab.textContent = s.name;
    svg.appendChild(lab);
  });
  return svg;
}

// ---------- History ----------
function renderHistory(screen) {
  const v = tpl('tpl-history');
  screen.appendChild(v);
  const gameSel = v.querySelector('#h-game');
  for (const g of state.db.games) gameSel.appendChild(el('option', { value: g.id }, g.name));
  const players = Object.fromEntries(state.db.players.map(p => [p.id, p]));
  const games = Object.fromEntries(state.db.games.map(g => [g.id, g]));
  const list = v.querySelector('#history-list');
  function refresh() {
    list.innerHTML = '';
    let arr = state.db.matches.filter(m => m.status === 'finished');
    if (gameSel.value) arr = arr.filter(m => m.gameId === gameSel.value);
    arr.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
    if (!arr.length) list.appendChild(el('div', {}, 'Aucune partie.'));
    for (const m of arr) list.appendChild(matchCard(m, games, players));
  }
  gameSel.onchange = refresh; refresh();
}
