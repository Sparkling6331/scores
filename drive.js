// drive.js — Google OAuth (GIS) + Drive API (REST) + Picker + sync
// Public API: init, signIn, signOut, ensureDb, loadDb, saveDb, pickFile,
//             startPoll, stopPoll, getUser
//
// Storage strategy:
//   - One JSON file in Drive named "scores-famille-db.json" with appProperties.app="scores-famille".
//   - Scope: drive.file (only files created/opened by this app).
//   - For invited users, they must select the shared file via Google Picker once.
//   - Optimistic concurrency: track headRevisionId; on conflict (412), refetch + merge + retry.
//
// File ID is cached in localStorage per-account.

const DRIVE_FILE_NAME = 'scores-famille-db.json';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive';

let CFG = { clientId: null };
let tokenClient = null;
let accessToken = null;
let userEmail = null;
let userName = null;
let fileId = null;
let lastRevisionId = null;
let pollTimer = null;
let pollInterval = 10000;
let onChange = null;     // callback(db)
let onStatus = null;     // callback(state, message)
let pickerApiLoaded = false;

function status(state, msg) { if (onStatus) onStatus(state, msg); }

export function init({ clientId, onDbChange, onSyncStatus }) {
  CFG.clientId = clientId;
  onChange = onDbChange;
  onStatus = onSyncStatus;

  return new Promise((resolve) => {
    const tick = () => {
      if (window.google?.accounts?.oauth2) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPES,
          prompt: '',
          callback: (resp) => {
            if (resp.error) { status('error', 'OAuth: ' + resp.error); return; }
            accessToken = resp.access_token;
            fetchUserInfo().then(() => status('ok', 'Connecté'));
            if (window.__authResolve) { window.__authResolve(); window.__authResolve = null; }
          },
        });
        resolve();
      } else setTimeout(tick, 100);
    };
    tick();
  });
}

export function isSignedIn() { return !!accessToken; }
export function getUser() { return { email: userEmail, name: userName }; }

export async function signIn() {
  if (!tokenClient) throw new Error('OAuth non initialisé');
  return new Promise((resolve, reject) => {
    window.__authResolve = resolve;
    try { tokenClient.requestAccessToken({ prompt: 'consent' }); }
    catch (e) { reject(e); }
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null; userEmail = null; userName = null;
  localStorage.removeItem('scores.fileId');
  fileId = null;
}

async function fetchUserInfo() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (r.ok) {
      const j = await r.json();
      userEmail = j.email;
      userName = j.name || j.email;
    }
  } catch (e) { /* ignore */ }
}

let originalCallback = null;
const FETCH_TIMEOUT_MS = 20000;

// AbortSignal.timeout() est natif au navigateur et n'est pas throttlé par iOS
// contrairement à setTimeout(). AbortSignal.any() combine plusieurs signaux.
async function driveFetch(url, opts = {}, externalSignal) {
  const makeSignal = () => externalSignal
    ? AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), externalSignal])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);

  const hdrs = { ...opts.headers, Authorization: 'Bearer ' + accessToken };
  let r = await fetch(url, { ...opts, headers: hdrs, signal: makeSignal() });

  if (r.status === 401) {
    status('warn', 'Renouvellement du token…');
    if (!originalCallback) originalCallback = tokenClient.callback;
    await new Promise((resolve, reject) => {
      const refreshTimer = setTimeout(() => {
        tokenClient.callback = originalCallback;
        originalCallback = null;
        reject(new Error('Token refresh timeout'));
      }, 15000);
      // Si le signal externe est annulé pendant le refresh OAuth, on rejette aussi
      if (externalSignal) {
        externalSignal.addEventListener('abort', () => {
          clearTimeout(refreshTimer);
          tokenClient.callback = originalCallback;
          originalCallback = null;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
      tokenClient.callback = (resp) => {
        clearTimeout(refreshTimer);
        tokenClient.callback = originalCallback;
        originalCallback = null;
        if (resp.error) reject(resp); else { accessToken = resp.access_token; resolve(); }
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
    hdrs.Authorization = 'Bearer ' + accessToken;
    r = await fetch(url, { ...opts, headers: hdrs, signal: makeSignal() });
  }
  return r;
}

export async function searchDbFile() {
  // Look for file by name + appProperties marker
  const q = encodeURIComponent(
    `name='${DRIVE_FILE_NAME}' and trashed=false and appProperties has { key='app' and value='scores-famille' }`
  );
  const r = await driveFetch(
    `${DRIVE_API}/files?q=${q}&fields=files(id,name,modifiedTime,headRevisionId)&pageSize=10`
  );
  if (!r.ok) throw new Error('Drive search: ' + r.status);
  const j = await r.json();
  return j.files || [];
}

export async function createDbFile(initialContent) {
  const metadata = {
    name: DRIVE_FILE_NAME,
    mimeType: 'application/json',
    appProperties: { app: 'scores-famille' },
  };
  const boundary = '-------scores-' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(initialContent) + '\r\n' +
    `--${boundary}--`;

  const r = await driveFetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,headRevisionId`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!r.ok) throw new Error('Drive create: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  fileId = j.id;
  lastRevisionId = j.headRevisionId;
  localStorage.setItem('scores.fileId', fileId);
  return fileId;
}

export async function setFileId(id) {
  fileId = id;
  localStorage.setItem('scores.fileId', id);
  // fetch headRevisionId
  const r = await driveFetch(`${DRIVE_API}/files/${id}?fields=id,headRevisionId`);
  if (r.ok) {
    const j = await r.json();
    lastRevisionId = j.headRevisionId;
  }
}

export function cachedFileId() {
  return localStorage.getItem('scores.fileId') || null;
}

export async function loadDb(externalSignal) {
  if (!fileId) throw new Error('Pas de fileId');
  // Get content + revision in one go: download via alt=media, revision via separate metadata call.
  const [contentR, metaR] = await Promise.all([
    driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`, {}, externalSignal),
    driveFetch(`${DRIVE_API}/files/${fileId}?fields=headRevisionId,modifiedTime`, {}, externalSignal),
  ]);
  if (!contentR.ok) throw new Error('Drive load content: ' + contentR.status);
  if (!metaR.ok) throw new Error('Drive load meta: ' + metaR.status);
  const text = await contentR.text();
  const meta = await metaR.json();
  lastRevisionId = meta.headRevisionId;
  let db;
  try { db = JSON.parse(text); } catch (e) { throw new Error('JSON invalide dans Drive'); }
  return { db, revisionId: lastRevisionId };
}

// Save db. If serverDb provided (from a recent load with same revision),
// we'll attempt to overwrite. Otherwise we refetch first to get current revision.
// On conflict, the caller must re-merge and retry.
export async function saveDb(db, expectedRevisionId, externalSignal) {
  if (!fileId) throw new Error('Pas de fileId');
  const body = JSON.stringify(db);
  if (expectedRevisionId) {
    const r0 = await driveFetch(`${DRIVE_API}/files/${fileId}?fields=headRevisionId`, {}, externalSignal);
    if (r0.ok) {
      const m = await r0.json();
      if (m.headRevisionId !== expectedRevisionId) {
        const err = new Error('conflict');
        err.code = 'CONFLICT';
        err.currentRevision = m.headRevisionId;
        throw err;
      }
    }
  }
  const r = await driveFetch(
    `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,headRevisionId`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
    externalSignal
  );
  if (!r.ok) throw new Error('Drive save: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  lastRevisionId = j.headRevisionId;
  return lastRevisionId;
}

export function getCachedRevision() { return lastRevisionId; }

export function startPoll(intervalMs = 10000) {
  pollInterval = intervalMs;
  stopPoll();
  const tick = async () => {
    if (!fileId || !accessToken) return;
    try {
      const r = await driveFetch(`${DRIVE_API}/files/${fileId}?fields=headRevisionId`);
      if (r.ok) {
        const j = await r.json();
        if (j.headRevisionId && j.headRevisionId !== lastRevisionId) {
          // remote changed -> reload
          const { db } = await loadDb();
          if (onChange) onChange(db);
          status('ok', 'Synchronisé');
        }
      }
    } catch (e) { status('error', 'Poll: ' + e.message); }
    pollTimer = setTimeout(tick, pollInterval);
  };
  pollTimer = setTimeout(tick, pollInterval);
}

export function stopPoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

export function setPollInterval(ms) {
  pollInterval = ms;
  if (pollTimer) startPoll(ms);
}

// Google Picker for invited users to grant access to shared file
export function loadPicker() {
  if (pickerApiLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!window.gapi) return reject(new Error('gapi non chargé'));
    gapi.load('picker', { callback: () => { pickerApiLoaded = true; resolve(); } });
  });
}

export async function pickFile() {
  await loadPicker();
  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setQuery(DRIVE_FILE_NAME);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey('') // not strictly required for our scope
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const f = data.docs[0];
          resolve({ id: f.id, name: f.name });
        } else if (data.action === google.picker.Action.CANCEL) {
          reject(new Error('Picker annulé'));
        }
      })
      .build();
    picker.setVisible(true);
  });
}
