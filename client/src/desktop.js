// Notifications, and the Windows app. Since 12.0 that's Selah Desktop (Electron, desktop-app/), whose preload gives
// pages window.selahDesktop; the older Tauri app (desktop/) still works through window.__TAURI_INTERNALS__ until it's
// replaced. In the Windows app notifications are Windows notifications; in a browser or the installed web app, the
// browser's own. Reminders are on per device (Settings → General → Notifications); each event and task chooses its
// own (reminders.js).
import { api } from './api.js';
import { addDays, formatTime, nowParts, relativeDay, toUTC } from './time.js';
import { remindersFor } from './reminders.js';
import { focusOn } from './focus.js';

// Tauri always gives its pages window.isTauri and __TAURI_INTERNALS__ (with invoke). The friendlier __TAURI__ global
// isn't there for a page from the server, so this goes by what always is.
const tauri = () => {
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  return invoke ? { invoke: (cmd, args) => invoke(cmd, args) } : null;
};
/** Selah Desktop's bridge (desktop-app/preload.cjs), or null. */
export const electron = () => (typeof window !== 'undefined' && window.selahDesktop?.kind === 'electron' ? window.selahDesktop : null);
export const isDesktopApp = () => !!(electron() || window.isTauri || window.__TAURI_INTERNALS__);
export const canNotify = () => isDesktopApp() || typeof Notification !== 'undefined';

// The type a browser would give a chosen file, by its extension (the server goes by it).
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', avi: 'video/x-msvideo',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', rtf: 'application/rtf',
  json: 'application/json', zip: 'application/zip', epub: 'application/epub+zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** What Selah Desktop's computer calls its things (12.1: Mac and Linux as well as Windows). */
export function desktopWords(platform = electron()?.platform ?? 'win32') {
  if (platform === 'darwin') return { system: 'your Mac', tray: 'menu bar', capture: 'Cmd+Option+N', hello: 'Touch ID', helloLong: 'Touch ID (your fingerprint)' };
  if (platform === 'linux') return { system: 'your computer', tray: 'system tray', capture: 'Ctrl+Alt+N', hello: null, helloLong: null };
  return { system: 'Windows', tray: 'tray', capture: 'Ctrl+Alt+N', hello: 'Windows Hello', helloLong: 'Windows Hello (face, fingerprint or Windows PIN)' };
}

/**
 * In the Windows app (7.3 and later), the Windows file picker in front of Selah's window: the page's own file input
 * could open behind it. Resolves to the chosen Files ([] when cancelled), or null where there's no such picker (a
 * browser, or an older Windows app), so the caller uses its file input.
 */
export async function pickFilesNative({ multiple = true } = {}) {
  // Electron's file input opens in front of its window, so Selah Desktop uses the page's own.
  if (electron()) return null;
  const t = isDesktopApp() && tauri();
  if (!t) return null;
  let chosen;
  try {
    chosen = await t.invoke('pick_files', { multiple });
  } catch {
    return null; // an app from before 7.3
  }
  const files = [];
  for (const c of chosen) {
    const bytes = await t.invoke('read_picked', { path: c.path });
    const ext = c.name.split('.').pop().toLowerCase();
    files.push(new File([bytes], c.name, { type: TYPES[ext] ?? '' }));
  }
  return files;
}

const PREF = 'noteapp.reminders';
const FIRED = 'noteapp.remindersFired';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
export const remindersOn = () => store.get(PREF) === 'on';

async function permitted() {
  if (electron()) return true;
  if (isDesktopApp()) return !!(await tauri()?.invoke('plugin:notification|is_permission_granted').catch(() => false));
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function askPermission() {
  if (await permitted()) return true;
  if (isDesktopApp()) return (await tauri()?.invoke('plugin:notification|request_permission').catch(() => 'denied')) === 'granted';
  if (typeof Notification === 'undefined') return false;
  return (await Notification.requestPermission()) === 'granted';
}

// The service worker (public/sw.js) shows notifications where `new Notification()` isn't allowed (Android).
let swReady = null;
function serviceWorker() {
  if (!('serviceWorker' in navigator) || isDesktopApp()) return Promise.resolve(null);
  swReady ??= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
  return swReady;
}
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'show-section') window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: e.data.section }));
  });
}

/**
 * Shows a notification. `section` is the page a click opens (browser only). Returns how it was sent ('windows',
 * 'service-worker' or 'browser'); throws with the reason if it couldn't be.
 */
export async function notify(title, body, section) {
  const e = electron();
  if (e) {
    try {
      await e.notify(title, body, section ?? null);
    } catch (err) {
      throw new Error(`Windows refused it: ${err?.message ?? String(err)}`);
    }
    return 'windows';
  }
  if (isDesktopApp()) {
    const t = tauri();
    if (!t) throw new Error('The Windows app’s notification link is missing (no invoke).');
    try {
      await t.invoke('plugin:notification|notify', { options: { title, body } });
    } catch (e) {
      throw new Error(`Windows refused it: ${typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)}`);
    }
    return 'windows';
  }
  if (typeof Notification === 'undefined') throw new Error('This browser has no notifications.');
  if (Notification.permission !== 'granted') throw new Error(`Notifications are ${Notification.permission === 'denied' ? 'blocked' : 'not allowed yet'} for Selah in this browser.`);
  const reg = await serviceWorker();
  if (reg?.showNotification) {
    await reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { section } });
    return 'service-worker';
  }
  const n = new Notification(title, { body, icon: '/icons/icon-192.png' });
  n.onclick = () => {
    window.focus();
    if (section) window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: section }));
    n.close();
  };
  return 'browser';
}

/** For Settings: sends a test notification and describes what happened. */
export async function testNotification() {
  try {
    const how = await notify('Selah test notification', 'If you can see this, reminders will show here too.', 'tasks');
    return { ok: true, how };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Turns reminders on (asking for permission) or off. Returns whether they're on. */
export async function setReminders(on) {
  if (on && !(await askPermission())) return false;
  store.set(PREF, on ? 'on' : 'off');
  if (on) checkReminders();
  return on;
}

// ---- reminders ----
const LATE = 15; // minutes: a reminder missed by more than this (the app was closed) isn't shown
const WINDOW = 8; // days ahead to look: the longest lead time is a week
let agenda = null; // { date, at, items: [{ key, at (wall-clock minutes), title, body, open }] }

// Wall-clock minutes in Selah's time zone, so '2026-10-23T09:00' and nowParts() compare directly.
const wallMin = (s) => toUTC(s).getTime() / 60_000;
/** 'today at 2:00 PM', 'tomorrow', 'Friday at 9:00 AM' */
function when(date, time) {
  const day = relativeDay(date);
  const d = day === 'Today' || day === 'Tomorrow' || day === 'Yesterday' ? day.toLowerCase() : day;
  return time ? `${d} at ${formatTime(time)}` : d;
}

async function loadAgenda(date) {
  const cal = await api.calendar(date, addDays(date, WINDOW));
  const items = [];
  for (const t of cal.tasks ?? []) {
    if (t.completed_at || !t.due_date) continue;
    // A task without a time counts back from midnight at the start of its day.
    const due = `${t.due_date}T${t.due_time ?? '00:00'}`;
    for (const lead of remindersFor('task', t)) {
      const body = lead === 0 && t.due_time ? `Due now (${formatTime(t.due_time)})` : `Due ${when(t.due_date, t.due_time)}`;
      items.push({ key: `t${t.id}@${due}-${lead}`, at: wallMin(due) - lead, title: t.title || 'Task', body, open: 'tasks' });
    }
  }
  for (const e of cal.events ?? []) {
    const day = e.start.slice(0, 10);
    const time = e.all_day ? null : e.start.slice(11, 16);
    const start = `${day}T${time ?? '00:00'}`;
    for (const lead of remindersFor('event', e)) {
      const body = lead === 0 && time ? `Starts now (${formatTime(time)})` : `Starts ${when(day, time)}`;
      items.push({ key: `e${e.id}@${e.start}-${lead}`, at: wallMin(start) - lead, title: e.title || 'Event', body, open: 'calendar' });
    }
  }
  agenda = { date, at: Date.now(), items };
}

/** Reminders already shown: { key: when it was due }, kept for two days. */
function firedKeys() {
  let v;
  try { v = JSON.parse(store.get(FIRED) ?? '{}'); } catch { v = {}; }
  if (Array.isArray(v.keys)) {
    // Before 5.4.5: { date, keys } for one day; tasks were reminded at their time.
    return Object.fromEntries(v.keys.filter((k) => k.startsWith('t')).map((k) => [`${k}-0`, wallMin(k.split('@')[1])]));
  }
  return v.keys ?? {};
}

let checking = false;
export async function checkReminders() {
  if (!remindersOn() || checking) return;
  checking = true;
  try {
    const now = nowParts();
    if (!agenda || agenda.date !== now.date || Date.now() - agenda.at > 5 * 60_000) await loadAgenda(now.date);
    const nowMin = wallMin(`${now.date}T${now.time}`);
    const fired = firedKeys();
    for (const [k, at] of Object.entries(fired)) if (nowMin - at > 2 * 1440) delete fired[k];
    // In focus mode reminders are skipped: marked as seen, so they don't all arrive when it's turned off.
    const quiet = focusOn();
    for (const r of agenda.items) {
      if (nowMin < r.at || nowMin - r.at > LATE || fired[r.key] !== undefined) continue;
      fired[r.key] = r.at;
      if (!quiet) notify(r.title, r.body, r.open).catch(() => {});
    }
    store.set(FIRED, JSON.stringify({ keys: fired }));
  } catch { /* offline: try again next time */ } finally {
    checking = false;
  }
}

let timer = null;
export function startReminders() {
  if (timer) return;
  if (remindersOn()) serviceWorker();
  checkReminders();
  timer = setInterval(checkReminders, 30_000);
  // A task or event changed anywhere: the next check reloads the list.
  window.addEventListener('noteapp:live', (e) => { if (/^\/api\/(tasks|events)/.test(e.detail?.url ?? '')) agenda = null; });
}
