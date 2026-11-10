// Selah for iPhone, iPad and Android (13.0, mobile-app/). The app opens this same page from your server inside a native
// web view, so it always matches the server. This file holds what only the app does: the copies of recent work saved
// on the device for its built-in offline page (mobile-app/www/shell.js) to read, and the way back to that page.
const native = () => (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null);

export const isMobileApp = () => !!native();
export const mobilePlatform = () => native()?.getPlatform?.() ?? null;

// On iOS the app's page runs under the status bar and home indicator; styles.css makes the room.
if (mobilePlatform() === 'ios') {
  document.documentElement.classList.add('is-ios-app');
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && !viewport.content.includes('viewport-fit')) viewport.content += ', viewport-fit=cover';
}

/** A buzz for the phone remote: 'tap' for a button, 'warn' at five minutes left, 'time' at the end. */
export function buzz(kind = 'tap') {
  const h = native()?.Plugins?.Haptics;
  if (h) {
    const done = kind === 'tap' ? h.impact({ style: 'LIGHT' }) : h.notification({ type: kind === 'time' ? 'ERROR' : 'WARNING' });
    Promise.resolve(done).catch(() => {});
    if (kind === 'time') setTimeout(() => Promise.resolve(h.notification({ type: 'ERROR' })).catch(() => {}), 700);
    return;
  }
  navigator.vibrate?.(kind === 'tap' ? 12 : kind === 'warn' ? [300, 150, 300] : [600, 200, 600, 200, 600]);
}

const CACHE_PATH = () => `selah-cache/${location.host}.json`;
const WORK_PATH = () => `selah-cache/${location.host}-work.json`;
const REFRESH_MS = 15 * 60 * 1000;
const NOTE_LIMIT = 80;
const fs = () => native()?.Plugins?.Filesystem ?? null;

/** The app's built-in page: the Android and iOS web views serve it from different addresses. */
const shellUrl = (query) => `${mobilePlatform() === 'ios' ? 'capacitor://localhost' : 'https://localhost'}/index.html?${query}`;
export const changeServer = () => { location.href = shellUrl('change=1'); };
export const openSavedCopies = () => { location.href = shellUrl('offline=1'); };

const getJson = async (url) => {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};

async function readCache() {
  try {
    const { data } = await fs().readFile({ path: CACHE_PATH(), directory: 'DATA', encoding: 'utf8' });
    return JSON.parse(data);
  } catch { return null; }
}

/** Saves recent notes (builders' sermons, studies and lessons are notes too) and reading plans, fetching only what changed. */
export async function refreshReadCache(today) {
  if (!fs()) return;
  const old = await readCache();
  const known = new Map((old?.notes ?? []).map((n) => [n.id, n]));
  const [recent, plans] = await Promise.all([
    getJson(`/api/notes?sort=updated&limit=${NOTE_LIMIT}`),
    getJson(`/api/plans?today=${encodeURIComponent(today)}`).catch(() => []),
  ]);
  const notes = [];
  for (const row of recent) {
    const have = known.get(row.id);
    if (have && have.updated_at === row.updated_at) { notes.push(have); continue; }
    try {
      const n = await getJson(`/api/notes/${row.id}`);
      notes.push({ id: n.id, title: n.title, html: n.html, updated_at: n.updated_at });
    } catch { /* one note that won't load shouldn't stop the rest */ }
  }
  const body = {
    saved_at: Date.now(),
    notes,
    plans: plans.map((p) => ({ title: p.title, today: (p.today?.items ?? []).map((i) => i.ref).join(', ') })),
  };
  await fs().writeFile({ path: CACHE_PATH(), data: JSON.stringify(body), directory: 'DATA', encoding: 'utf8', recursive: true });
  await refreshOfflineWork(today);
}

async function readWork() {
  try {
    const { data } = await fs().readFile({ path: WORK_PATH(), directory: 'DATA', encoding: 'utf8' });
    return JSON.parse(data);
  } catch { return null; }
}

/** Sermons and lessons for delivering with no connection (offlineWork.js); only what changed is built again. */
async function refreshOfflineWork(today) {
  const { buildOfflineWork } = await import('./offlineWork.js');
  const work = await buildOfflineWork(today, (await readWork())?.work ?? []);
  await fs().writeFile({ path: WORK_PATH(), data: JSON.stringify({ saved_at: Date.now(), work }), directory: 'DATA', encoding: 'utf8', recursive: true });
}

/** What's ready for offline on this device: { count, savedAt }, or null before anything is saved. */
export async function offlineWorkStatus() {
  if (!fs()) return null;
  const saved = await readWork();
  return saved ? { count: saved.work.length, savedAt: saved.saved_at } : null;
}

/** Signing out takes this device's saved copies with it. */
export async function clearReadCache() {
  if (!fs()) return;
  await fs().deleteFile({ path: CACHE_PATH(), directory: 'DATA' }).catch(() => {});
  await fs().deleteFile({ path: WORK_PATH(), directory: 'DATA' }).catch(() => {});
}

const biometric = () => native()?.Plugins?.NativeBiometric ?? null;
const KEY_NAME = () => `selah-session-${location.host}`;
const LOCK_FILE = 'selah-lock.json';
let lockState = false;

/** Copies this device's sign-in to the Keychain or Keystore, where the app's built-in page finds it at launch. */
export async function saveSessionKey() {
  if (!biometric()) return;
  try {
    const { key } = await getJson('/api/mobile/session-key');
    await biometric().setCredentials({ server: KEY_NAME(), username: 'selah', password: key });
  } catch { /* the web view's cookie still works; the next launch tries again */ }
}

/** Whether this device can ask for Face ID, a fingerprint or its passcode. */
export async function canLock() {
  if (!biometric() || !fs()) return false;
  try { return (await biometric().isAvailable({ useFallback: true })).isAvailable; } catch { return false; }
}

export async function readLock() {
  try {
    const { data } = await fs().readFile({ path: LOCK_FILE, directory: 'DATA', encoding: 'utf8' });
    lockState = JSON.parse(data).on === true;
  } catch { lockState = false; }
  return lockState;
}
export const lockIsOn = () => lockState;

/** Rejects if the person cancels or can't prove it's them. */
export const verifyUnlock = () => biometric().verifyIdentity({ title: 'Unlock Selah', reason: 'Unlock Selah', useFallback: true, maxAttempts: 5, allowedBiometryTypes: [3, 4, 5, 7] });

async function writeLock(on) {
  await fs().writeFile({ path: LOCK_FILE, data: JSON.stringify({ on }), directory: 'DATA', encoding: 'utf8' });
  lockState = on;
}

/** Turning the lock on or off asks first, so someone holding an unlocked phone can't quietly change it. */
export async function setLock(on) {
  await verifyUnlock();
  await writeLock(on);
}

/** Signing out takes the saved sign-in and the lock with it. */
export async function forgetDevice() {
  await clearReadCache();
  if (!biometric()) return;
  await biometric().deleteCredentials({ server: KEY_NAME() }).catch(() => {});
  await writeLock(false).catch(() => {});
}

/** Keeps the saved copies fresh while the app is open. Returns a stop function. */
let saving = false;
/** Saves now, unless a save is already running. Rejects if it couldn't; false if it didn't start. */
export async function saveForOffline(today) {
  if (saving || !navigator.onLine) return false;
  saving = true;
  try { await refreshReadCache(today); return true; } finally { saving = false; }
}

export function startReadCache(todayFn) {
  if (!fs()) return () => {};
  const run = () => saveForOffline(todayFn()).catch(() => { /* tries again on the next round */ });
  const first = setTimeout(run, 4000);
  const timer = setInterval(run, REFRESH_MS);
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---- 13.0 quick capture: dictation, the camera and the app icon's quick actions ----

const speech = () => native()?.Plugins?.SpeechRecognition ?? null;
export const canDictate = () => !!speech();

/**
 * Speech to text with the phone's own recognizer, shown as it's heard: onText(words) for the session so far.
 * Resolves to a stop() function; onEnd runs when it stops (by itself after a pause, or by stop()).
 */
export async function startDictation({ onText, onEnd }) {
  const sr = speech();
  const perm = await sr.requestPermissions().catch(() => null);
  if (perm && perm.speechRecognition !== 'granted') throw new Error('Selah needs the microphone and speech recognition to type what you say. Allow them in the phone’s Settings.');
  const { available } = await sr.available().catch(() => ({ available: false }));
  if (!available) throw new Error('Speech recognition isn’t available on this device.');
  const language = navigator.language || 'en-US';
  const onDevice = await sr.isOnDeviceRecognitionAvailable?.({ language }).then((r) => r.available).catch(() => false);
  let ended = false;
  const handles = [];
  const end = () => {
    if (ended) return;
    ended = true;
    handles.forEach((h) => h?.remove?.());
    onEnd?.();
  };
  handles.push(await sr.addListener('partialResults', (e) => { const t = e.accumulatedText || e.matches?.[0]; if (t) onText(t); }));
  handles.push(await sr.addListener('listeningState', (e) => { if ((e.state ?? e.status) === 'stopped') end(); }));
  // On the device where it can be (nothing leaves the phone); the phone's usual recognizer if that won't start.
  const start = (local) => sr.start({ language, partialResults: true, popup: false, addPunctuation: true, useOnDeviceRecognition: local })
    .then((r) => { if (r?.matches?.[0]) onText(r.matches[0]); });
  start(!!onDevice).catch(() => (onDevice ? start(false) : Promise.reject())).catch(() => end());
  return () => { Promise.resolve(sr.stop()).catch(() => {}).finally(() => setTimeout(end, 400)); };
}

const camera = () => native()?.Plugins?.Camera ?? null;
export const hasCamera = () => !!camera();

/** A photo from the camera ('camera') or the library ('library') as a Blob, or null if the person backs out. */
export async function nativePhoto(source = 'camera') {
  const cam = camera();
  let media;
  try {
    media = source === 'library'
      ? (await cam.chooseFromGallery({ limit: 1, quality: 85 })).results?.[0]
      : await cam.takePhoto({ quality: 85, correctOrientation: true });
  } catch (e) {
    if (/cancel/i.test(String(e?.message ?? e))) return null;
    throw e;
  }
  if (!media?.uri && !media?.webPath) return null;
  // The page comes from your server, so the file is read through the app rather than fetched from its local address.
  const { data } = await fs().readFile({ path: media.uri ?? media.webPath });
  const type = `image/${/png/i.test(media.format ?? '') ? 'png' : 'jpeg'}`;
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `photo.${type === 'image/png' ? 'png' : 'jpg'}`, { type });
}

/**
 * The app icon's quick actions (set in capacitor.config.json): onAction('capture' | 'voice' | 'photo' | 'task').
 * One tapped while the app was closed waits in the plugin until this listens. Returns a stop function.
 */
export function listenForQuickActions(onAction) {
  const p = native()?.Plugins?.AppShortcuts;
  if (!p) return () => {};
  let handle;
  Promise.resolve(p.addListener('click', (e) => onAction(e.shortcutId))).then((h) => { handle = h; }).catch(() => {});
  return () => handle?.remove?.();
}

const fileFromDevice = async (uri, name, type) => {
  const { data } = await fs().readFile({ path: uri.startsWith('/') ? `file://${uri}` : uri });
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'shared', { type: type || 'application/octet-stream' });
};

/**
 * 13.0 Share to Selah: onShare({ title, text, files: [{ blob, name, type }] }) for each share from another app's share
 * menu. One shared while the app was closed waits in the plugin until this listens. Returns a stop function.
 */
export function listenForShares(onShare) {
  const p = native()?.Plugins?.CapacitorShareTarget;
  if (!p) return () => {};
  let handle;
  Promise.resolve(p.addListener('shareReceived', async (e) => {
    const files = [];
    for (const f of e.files ?? []) {
      try { files.push({ blob: await fileFromDevice(f.uri, f.name, f.mimeType), name: f.name || 'shared', type: f.mimeType || '' }); } catch { /* a file the app can't read is left out */ }
      // The copy made for the share isn't needed once it's read (it's sent, or kept in the capture queue).
      fs().deleteFile({ path: f.uri.startsWith('/') ? `file://${f.uri}` : f.uri }).catch(() => {});
    }
    onShare({ title: e.title ?? '', text: (e.texts ?? []).filter(Boolean).join('\n'), files });
  })).then((h) => { handle = h; }).catch(() => {});
  return () => handle?.remove?.();
}
