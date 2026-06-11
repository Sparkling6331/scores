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

let lastSyncTime = null;
let syncbarFadeTimer = null;
function syncbar(state_, msg) {
  const b = $('#syncbar');
  b.className = state_ || '';
  if (state_ === 'ok') {
    lastSyncTime = new Date();
    const hhmm = lastSyncTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    b.textContent = (msg || 'Synchronisé') + ' à ' + hhmm;
    if (syncbarFadeTimer) clearTimeout(syncbarFadeTimer);
    syncbarFadeTimer = setTimeout(() => {
      if (b.className === 'ok') { b.className = ''; b.textContent = 'Dernière sync : ' + hhmm; }
    }, 5000);
  } else if (state_ === 'error') {
    b.textContent = '⚠️ Problème de synchronisation — vérifie ta connexion internet.';
  } else {
    b.textContent = msg || '';
  }
}

// ---------- Haptic feedback ----------
function haptic(type = 'light') {
  if (!navigator.vibrate) return;
  if (type === 'light') navigator.vibrate(10);
  else if (type === 'medium') navigator.vibrate(25);
  else if (type === 'success') navigator.vibrate([10, 50, 10]);
  else if (type === 'error') navigator.vibrate([50, 30, 50]);
}

// ---------- Accent color theme ----------
function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function applyAccentColor(color) {
  const root = document.documentElement;
  root.style.setProperty('--accent', color);
  try {
    const [r, g, b] = _hexToRgb(color);
    root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.10)`);
    root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
  } catch (e) { /* ignore — fallback values from CSS are fine */ }
  localStorage.setItem('scores.accentColor', color);
}
function initAccentColor() {
  const saved = localStorage.getItem('scores.accentColor');
  if (saved) applyAccentColor(saved);
}

// ---------- Toast notification ----------
function showToast(msg, duration = 1800) {
  const toast = el('div', { class: 'toast' }, msg);
  document.body.appendChild(toast);
  requestAnimationFrame(() => { void toast.offsetWidth; toast.classList.add('show'); });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ---------- Confetti burst ----------
const _celebratedMatches = new Set();
function burstConfetti(container) {
  const colors = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    p.style.left = (Math.random() * 100) + '%';
    p.style.top = (Math.random() * 30) + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.4) + 's';
    p.style.animationDuration = (0.6 + Math.random() * 0.5) + 's';
    container.appendChild(p);
  }
  setTimeout(() => container.querySelectorAll('.confetti-particle').forEach(p => p.remove()), 1800);
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
  initAccentColor();
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
  const bar = $('#tabbar');
  if (bar) bar.hidden = true;
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
  ub.appendChild(el('input', {
    type: 'color',
    value: localStorage.getItem('scores.accentColor') || '#4f46e5',
    title: 'Thème',
    style: 'flex-shrink:0;',
    oninput: (e) => { applyAccentColor(e.target.value); haptic('light'); },
  }));
  const NAV = [
    ['home', 'Parties', '🎲'],
    ['players', 'Joueurs', '👥'],
    ['games', 'Jeux', '🃏'],
    ['stats', 'Stats', '📊'],
    ['history', 'Historique', '📜'],
  ];
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const [id, label] of NAV) {
    const b = el('button', { onclick: () => goto(id) }, label);
    if (id === state.currentScreen) b.classList.add('active');
    tabs.appendChild(b);
  }
  // Bottom tab bar (mobile, app-native)
  const bar = $('#tabbar');
  if (bar) {
    bar.innerHTML = '';
    bar.hidden = false;
    for (const [id, label, ico] of NAV) {
      const b = el('button', { onclick: () => { haptic('light'); goto(id); } },
        el('span', { class: 'ico' }, ico),
        el('span', { class: 'lbl' }, label)
      );
      if (id === state.currentScreen) b.classList.add('active');
      bar.appendChild(b);
    }
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
  s.classList.remove('screen-enter');
  void s.offsetWidth;
  s.classList.add('screen-enter');
  try {
    switch (state.currentScreen) {
      case 'home': return renderHome(s);
      case 'newMatch': return renderNewMatch(s);
      case 'match': return renderMatch(s);
      case 'players': return renderPlayers(s);
      case 'games': return renderGames(s);
      case 'stats': return renderStats(s);
      case 'history': return renderHistory(s);
    }
  } catch (e) {
    console.error('[render]', e);
    s.innerHTML = '';
    s.appendChild(el('div', { class: 'card', style: 'margin:20px;' },
      el('p', { style: 'color:var(--bad); font-weight:700;' }, '⚠️ Erreur d\'affichage'),
      el('p', { style: 'color:var(--muted); font-size:14px;' }, e.message || String(e)),
      el('button', { class: 'primary', onclick: () => goto('home') }, 'Retour à l\'accueil')
    ));
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
  if (!ongoing.length) {
    if (!state.db.matches.length) {
      oList.appendChild(el('div', { class: 'card', style: 'text-align:center; padding:24px;' },
        el('div', { style: 'font-size:40px; margin-bottom:8px;' }, '🎲'),
        el('p', { style: 'margin:0 0 4px; font-weight:600;' }, 'Aucune partie en cours'),
        el('p', { style: 'margin:0; font-size:14px; color:var(--muted);' }, 'Clique sur "+ Nouvelle partie" pour commencer !')
      ));
    } else {
      oList.appendChild(el('div', { class: 'muted', style: 'padding:8px;' }, 'Aucune partie en cours.'));
    }
  }
  for (const m of ongoing) oList.appendChild(matchCard(m, games, players));

  const rList = v.querySelector('#recent-list');
  if (!recent.length) rList.appendChild(el('div', { class: 'muted', style: 'padding:8px;' }, 'Aucune partie terminée récemment.'));
  for (const m of recent) rList.appendChild(matchCard(m, games, players));
}

function matchCard(m, games, players, opts = {}) {
  const g = games[m.gameId];
  const totals = stats.totalsOfMatch(m);
  const winners = m.status === 'finished' ? stats.winnersOfMatch(m, g) : [];
  const c = el('div', { class: 'match-card', onclick: () => goto('match', { matchId: m.id }) });
  const metaSpan = m.status === 'finished'
    ? el('span', { class: 'meta' }, fmtDate(m.endedAt || m.startedAt))
    : el('span', { class: 'meta live' }, el('span', { class: 'live-dot' }), 'En cours');
  const right = el('div', { style: 'display:flex; align-items:center; gap:8px;' }, metaSpan);
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
  if (m.status === 'finished' && winners.length) {
    const winNames = winners.map(pid => players[pid]?.name || '?').join(' & ');
    c.appendChild(el('div', { class: 'match-winner-line' }, '🏆 ', el('strong', {}, winNames)));
  }
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
  const playerCountHint = el('div', {
    style: 'font-size:13px; margin-bottom:4px; color:var(--warn);',
  }, '0 joueur sélectionné — minimum 2');
  pls.parentElement.insertBefore(playerCountHint, pls);
  const updatePlayerCountHint = () => {
    const count = state.newMatch.playerIds.length;
    if (count === 0) {
      playerCountHint.textContent = '0 joueur sélectionné — minimum 2';
      playerCountHint.style.color = 'var(--warn)';
    } else if (count === 1) {
      playerCountHint.textContent = '1 joueur sélectionné — il en faut au moins 2';
      playerCountHint.style.color = 'var(--warn)';
    } else {
      playerCountHint.textContent = `${count} joueurs sélectionnés ✓`;
      playerCountHint.style.color = 'var(--good)';
    }
  };
  for (const p of state.db.players) {
    const c = el('span', { class: 'chip', onclick: () => {
      haptic('light');
      const i = state.newMatch.playerIds.indexOf(p.id);
      if (i >= 0) state.newMatch.playerIds.splice(i, 1);
      else state.newMatch.playerIds.push(p.id);
      c.classList.toggle('on');
      updatePlayerCountHint();
    }}, p.name);
    if (state.newMatch.playerIds.includes(p.id)) c.classList.add('on');
    pls.appendChild(c);
  }
  updatePlayerCountHint();
  v.querySelector('#nm-cancel').onclick = () => goto('home');
  v.querySelector('#nm-start').onclick = () => {
    if (state.newMatch.playerIds.length < 2) { haptic('error'); return alert('Sélectionne au moins 2 joueurs.'); }
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
let lockCountdownTimer = null;
function clearLockRefresh() {
  if (lockRefreshTimer) clearInterval(lockRefreshTimer);
  lockRefreshTimer = null;
  if (lockCountdownTimer) clearInterval(lockCountdownTimer);
  lockCountdownTimer = null;
}

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
  if (!game) { goto('home'); return; }
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

  // Compute entry state early — needed for totals tap-to-enter
  const nextN = (m.rounds[m.rounds.length - 1]?.n || 0) + 1;
  const editingRound = m.rounds.find(r => {
    const lk = state.db.locks?.[m.id]?.[r.n];
    return lk && lk.deviceId === DEVICE_ID && new Date(lk.expiresAt).getTime() > Date.now();
  });
  const entryN = editingRound ? editingRound.n : nextN;
  const prefill = editingRound ? editingRound.scores : null;

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
    const isLead = totals[pid] != null && totals[pid] === leader && m.rounds.length > 0;
    const d = el('div', { class: 'pl' },
      el('div', { class: 'nm' }, (isLead ? '👑 ' : '') + (players[pid]?.name || '?')),
      el('div', { class: 'tot' }, String(t))
    );
    if (isLead) d.classList.add('lead');
    if (rule.type === 'threshold' && t >= rule.value) d.classList.add('threshold-reached');
    if (rule.type === 'threshold' && rule.value > 0) {
      const pct = Math.max(0, Math.min(100, (t / rule.value) * 100));
      d.appendChild(el('div', { class: 'prog' }, el('i', { style: `width:${pct}%` })));
    }
    if (m.status === 'ongoing' && !editingRound) {
      d.classList.add('tappable-total');
      d.title = `Saisir tour #${nextN}`;
      d.addEventListener('click', () => {
        const existing = state.db.locks?.[m.id]?.[nextN];
        if (existing && existing.deviceId !== DEVICE_ID && new Date(existing.expiresAt).getTime() > Date.now()) {
          render(); return;
        }
        haptic('light');
        claimLock(m.id, nextN);
      });
    }
    totalsEl.appendChild(d);
  }

  // Rounds table
  const re = v.querySelector('#m-rounds');
  const table = el('table');
  const head = el('thead');
  const trh = el('tr');
  trh.appendChild(el('th', {}, 'Tour'));
  for (const pid of m.playerIds) trh.appendChild(el('th', {}, players[pid]?.name || '?'));
  if (m.status === 'ongoing') trh.appendChild(el('th', {}));
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
    if (m.status === 'ongoing') {
      tr.appendChild(el('td', {},
        el('button', { class: 'edit-round-btn', title: 'Modifier ce tour',
          onclick: () => claimLock(m.id, r.n)
        }, '✏️')
      ));
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
    wb.appendChild(el('button', {
      style: 'margin-top:12px;',
      onclick: () => {
        if (!confirm('Rouvrir cette partie pour continuer à jouer ?')) return;
        m.status = 'ongoing';
        delete m.endedAt;
        delete m.winnerIds;
        // Passe en fin manuelle pour éviter que la condition de fin se retrigger immédiatement
        m.endOverride = { type: 'manual' };
        scheduleSave();
        render();
      }
    }, 'Rouvrir la partie'));
    v.querySelector('#m-end-manual').hidden = true;
    v.querySelector('#m-entry').innerHTML = '';
    if (!_celebratedMatches.has(m.id)) {
      _celebratedMatches.add(m.id);
      haptic('success');
      setTimeout(() => burstConfetti(wb), 150);
    }
    return;
  }

  // Entry area: editing a past round takes priority over next-round entry
  renderEntry(v.querySelector('#m-entry'), m, game, entryN, players, prefill);
}

function renderEntry(host, m, game, n, players, prefill = null) {
  host.innerHTML = '';
  const lock = state.db.locks?.[m.id]?.[n];
  const me = drive.getUser().email || DEVICE_ID;
  const myActive = lock && lock.deviceId === DEVICE_ID && new Date(lock.expiresAt).getTime() > Date.now();
  const otherActive = lock && lock.deviceId !== DEVICE_ID && new Date(lock.expiresAt).getTime() > Date.now();

  if (otherActive) {
    const lockDiv = el('div', { class: 'lock-info' });
    const forceBtn = el('button', { class: 'danger', style: 'display:none;', onclick: () => { releaseLock(m.id, n); claimLock(m.id, n); } }, 'Forcer la libération');
    host.appendChild(lockDiv);
    host.appendChild(el('button', { onclick: () => render() }, 'Rafraîchir'));
    host.appendChild(forceBtn);
    const expiresAt = new Date(lock.expiresAt).getTime();
    const updateCountdown = () => {
      const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      lockDiv.textContent = `🔒 ${lock.name || 'Un autre joueur'} saisit le tour #${n} (libère dans ${secs}s)`;
      if (secs <= 0) {
        lockDiv.textContent = `🔒 ${lock.name || 'Un autre joueur'} — verrouillage expiré`;
        forceBtn.style.display = '';
        clearInterval(lockCountdownTimer);
        lockCountdownTimer = null;
      }
    };
    updateCountdown();
    if (lockCountdownTimer) clearInterval(lockCountdownTimer);
    lockCountdownTimer = setInterval(updateCountdown, 1000);
    return;
  }

  if (!myActive) {
    host.appendChild(el('button', { class: 'primary', onclick: () => { claimLock(m.id, n); } }, `Saisir tour #${n}`));
    return;
  }

  // I have the lock — show entry form
  const isEdit = prefill != null;
  const warnEl = el('div', { class: 'entry-warn', style: 'display:none;' });
  host.appendChild(el('div', { class: 'card' },
    el('h3', {}, isEdit ? `✏️ Modifier tour #${n}` : `Tour #${n}`),
    ...m.playerIds.map(pid => {
      const row = el('div', { class: 'entry-row' });
      row.appendChild(el('label', {}, players[pid]?.name || '?'));
      const preVal = prefill?.[pid] != null ? String(prefill[pid]) : '';
      const inp = el('input', { type: 'number', inputmode: 'decimal', step: '1', placeholder: '0', 'data-pid': pid, value: preVal });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') host.querySelector('#submit-round').click(); });
      inp.addEventListener('input', () => { inp.classList.remove('warn-empty'); warnEl.style.display = 'none'; });
      const toggle = el('button', { class: 'sign-toggle', type: 'button', title: 'Inverser le signe', onclick: () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { inp.value = String(-v); inp.dispatchEvent(new Event('input')); }
        else inp.value = '-';
        inp.focus();
      }}, '+/−');
      const wrap = el('div', { class: 'entry-input-wrap' });
      wrap.appendChild(inp);
      wrap.appendChild(toggle);
      row.appendChild(wrap);
      return row;
    }),
    warnEl,
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
  const blanks = [];
  for (const inp of inputs) {
    const pid = inp.dataset.pid;
    const raw = inp.value.trim();
    if (raw === '') { blanks.push(inp); continue; }
    const num = Number(raw);
    if (!isFinite(num)) return alert('Score invalide pour un joueur.');
    scores[pid] = num;
  }
  if (blanks.length) {
    const warnEl = host.querySelector('.entry-warn');
    blanks.forEach(inp => inp.classList.add('warn-empty'));
    if (warnEl) {
      warnEl.textContent = `⚠️ ${blanks.length} score(s) non renseigné(s). Remplis les champs manquants ou clique à nouveau pour valider quand même.`;
      warnEl.style.display = '';
    }
    // On second click allow submit anyway (blanks already highlighted)
    const btn = host.querySelector('#submit-round');
    if (btn && !btn.dataset.forceSubmit) { btn.dataset.forceSubmit = '1'; return; }
    if (btn) delete btn.dataset.forceSubmit;
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
  haptic('success');
  showToast(`✅ Tour #${n} enregistré !`);
  render();
}

function claimLock(matchId, n) {
  haptic('light');
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
  if (!state.db.players.length) {
    list.appendChild(el('div', { class: 'card', style: 'text-align:center; padding:16px; color:var(--muted);' },
      el('p', { style: 'margin:0;' }, '👥 Aucun joueur encore. Saisis les prénoms de la famille ci-dessous !')
    ));
  }
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
  if (top.length) {
    const title = filt.gameId ? 'Évolution des totaux' : 'Évolution des totaux (top 3 joueurs)';
    const subtitle = filt.gameId ? null : el('small', { style: 'display:block; margin-bottom:8px; color:var(--muted);' },
      'Filtrer par jeu pour voir l\'évolution sur un seul jeu.');
    const svg = drawEvoSvg(top.map(r => ({
      pid: r.pid, name: players[r.pid]?.name || '?',
      points: stats.evolution(state.db, r.pid, filt),
    })));
    host.appendChild(el('div', { class: 'card' }, el('h3', {}, title), subtitle, svg));
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

  const playerSel = v.querySelector('#h-player');
  for (const p of state.db.players) playerSel.appendChild(el('option', { value: p.id }, p.name));

  const players = Object.fromEntries(state.db.players.map(p => [p.id, p]));
  const games = Object.fromEntries(state.db.games.map(g => [g.id, g]));
  const content = v.querySelector('#history-content');

  const MODES = [
    { id: 'list', label: 'Parties' },
    { id: 'tour-records', label: 'Records par tour' },
    { id: 'match-records', label: 'Records de partie' },
    { id: 'extremes', label: 'Serrées / Longues' },
  ];
  let currentMode = 'list';
  const modeChips = {};
  const modeGrid = v.querySelector('#h-mode');
  for (const m of MODES) {
    const chip = el('span', { class: 'chip' + (m.id === 'list' ? ' on' : ''), onclick: () => {
      currentMode = m.id;
      Object.values(modeChips).forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      refresh();
    }}, m.label);
    modeChips[m.id] = chip;
    modeGrid.appendChild(chip);
  }

  function getFiltered() {
    let arr = state.db.matches.filter(m => m.status === 'finished');
    if (gameSel.value) arr = arr.filter(m => m.gameId === gameSel.value);
    if (playerSel.value) arr = arr.filter(m => m.playerIds.includes(playerSel.value));
    return arr;
  }

  function refresh() {
    content.innerHTML = '';
    const arr = getFiltered();
    const filteredPlayerId = playerSel.value || null;
    if (currentMode === 'list') renderHistoryList(content, arr, games, players);
    else if (currentMode === 'tour-records') renderTourRecords(content, arr, games, players, filteredPlayerId);
    else if (currentMode === 'match-records') renderMatchRecords(content, arr, games, players, filteredPlayerId);
    else if (currentMode === 'extremes') renderExtremes(content, arr, games, players);
  }

  gameSel.onchange = refresh;
  playerSel.onchange = refresh;
  refresh();
}

function renderHistoryList(host, arr, games, players) {
  const list = el('div', { class: 'cards' });
  arr.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
  if (!arr.length) list.appendChild(el('div', { style: 'color:var(--muted); padding:8px;' }, 'Aucune partie.'));
  for (const m of arr) list.appendChild(matchCard(m, games, players));
  host.appendChild(list);
}

function renderTourRecords(host, matches, games, players, filterPlayerId = null) {
  const entries = [];
  for (const m of matches) {
    const game = games[m.gameId]; if (!game) continue;
    for (const r of m.rounds) {
      for (const [pid, score] of Object.entries(r.scores)) {
        if (score == null) continue;
        if (filterPlayerId && pid !== filterPlayerId) continue;
        entries.push({ matchId: m.id, gameName: game.name, pid, score: Number(score), roundN: r.n, date: m.endedAt || m.startedAt });
      }
    }
  }
  if (!entries.length) {
    host.appendChild(el('div', { class: 'card' }, 'Aucun score de tour disponible.'));
    return;
  }

  const byScore = [...entries].sort((a, b) => b.score - a.score);
  const highest = byScore.slice(0, 10);
  const lowest = byScore.slice(-10).reverse();

  const multiGame = new Set(matches.map(m => m.gameId)).size > 1;
  if (multiGame) {
    host.appendChild(el('div', { class: 'card', style: 'font-size:13px; color:var(--muted);' },
      'ℹ️ Filtrer par jeu rend la comparaison plus pertinente (scores hétérogènes entre jeux).'
    ));
  }

  const mkTable = (rows, title) => {
    const t = el('table', { class: 'stat' });
    t.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, '#'), el('th', {}, 'Joueur'), el('th', {}, 'Score'),
      el('th', {}, 'Tour'), el('th', {}, 'Jeu'), el('th', {}, 'Date')
    )));
    const tb = el('tbody');
    rows.forEach((e, i) => {
      const tr = el('tr', { class: 'record-row', onclick: () => goto('match', { matchId: e.matchId }) },
        el('td', {}, String(i + 1)),
        el('td', {}, players[e.pid]?.name || '?'),
        el('td', { style: 'font-weight:700;' }, String(e.score)),
        el('td', {}, `#${e.roundN}`),
        el('td', {}, e.gameName),
        el('td', {}, fmtDate(e.date))
      );
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return el('div', { class: 'card' }, el('h3', {}, title), t);
  };

  host.appendChild(mkTable(highest, '🔝 10 scores les plus élevés au tour'));
  host.appendChild(mkTable(lowest, '🔻 10 scores les plus faibles au tour'));
}

function renderMatchRecords(host, matches, games, players, filterPlayerId = null) {
  if (!matches.length) {
    host.appendChild(el('div', { class: 'card' }, 'Aucune partie terminée.'));
    return;
  }

  const byGame = {};
  for (const m of matches) {
    const game = games[m.gameId]; if (!game) continue;
    if (!byGame[m.gameId]) byGame[m.gameId] = { game, entries: [] };
    const totals = stats.totalsOfMatch(m);
    for (const [pid, total] of Object.entries(totals)) {
      if (filterPlayerId && pid !== filterPlayerId) continue;
      byGame[m.gameId].entries.push({ matchId: m.id, pid, total, date: m.endedAt || m.startedAt });
    }
  }

  for (const { game, entries } of Object.values(byGame)) {
    const sorted = [...entries].sort((a, b) =>
      game.scoreDir === 'low' ? a.total - b.total : b.total - a.total
    );
    const best5 = sorted.slice(0, 5);
    const worst5 = sorted.slice(-5).reverse();
    const dir = game.scoreDir === 'low' ? '(bas gagne)' : '(haut gagne)';

    const mkRows = rows => rows.map((e, i) =>
      el('tr', { class: 'record-row', onclick: () => goto('match', { matchId: e.matchId }) },
        el('td', {}, String(i + 1)),
        el('td', {}, players[e.pid]?.name || '?'),
        el('td', { style: 'font-weight:700;' }, String(e.total)),
        el('td', {}, fmtDate(e.date))
      )
    );

    const mkTable = (rows, title) => {
      const t = el('table', { class: 'stat' });
      t.appendChild(el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Joueur'), el('th', {}, 'Total'), el('th', {}, 'Date'))));
      const tb = el('tbody');
      mkRows(rows).forEach(r => tb.appendChild(r));
      t.appendChild(tb);
      return el('div', { style: 'margin-top:12px;' }, el('h4', { style: 'margin:0 0 6px;' }, title), t);
    };

    host.appendChild(el('div', { class: 'card' },
      el('h3', { style: 'margin-top:0;' }, `🎯 ${game.name} ${dir}`),
      mkTable(best5, '🏆 Meilleurs totaux'),
      mkTable(worst5, '📉 Pires totaux')
    ));
  }
}

function renderExtremes(host, matches, games, players) {
  if (!matches.length) {
    host.appendChild(el('div', { class: 'card' }, 'Aucune partie terminée.'));
    return;
  }

  // Longest by round count
  const withRounds = matches
    .filter(m => m.rounds.length > 0)
    .map(m => ({ m, rounds: m.rounds.length }))
    .sort((a, b) => b.rounds - a.rounds)
    .slice(0, 8);

  // Tightest: smallest gap between best and worst total
  const withGap = matches.map(m => {
    const totals = Object.values(stats.totalsOfMatch(m));
    if (totals.length < 2) return null;
    const gap = Math.max(...totals) - Math.min(...totals);
    return { m, gap };
  }).filter(Boolean).sort((a, b) => a.gap - b.gap).slice(0, 8);

  const mkCard = (title, rows) => {
    const list = el('div', { class: 'cards' });
    for (const row of rows) list.appendChild(row);
    return el('div', { class: 'card' }, el('h3', { style: 'margin-top:0;' }, title), list);
  };

  const longRows = withRounds.map(({ m, rounds }) => {
    const c = matchCard(m, games, players, { deletable: false });
    c.querySelector('.meta')?.insertAdjacentText('beforebegin', `${rounds} tours · `);
    return c;
  });

  const tightRows = withGap.map(({ m, gap }) => {
    const c = matchCard(m, games, players, { deletable: false });
    c.querySelector('.meta')?.insertAdjacentText('beforebegin', `Écart: ${gap} pts · `);
    return c;
  });

  host.appendChild(mkCard('📏 Parties les plus longues (nb de tours)', longRows.length ? longRows : [el('div', {}, 'Aucune donnée.')]));
  host.appendChild(mkCard('🤏 Parties les plus serrées (écart final)', tightRows.length ? tightRows : [el('div', {}, 'Aucune donnée.')]));
}

// ---------- Service Worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
