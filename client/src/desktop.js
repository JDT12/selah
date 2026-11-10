// Notifications, and the Windows app. Since 12.0 that's Selah Desktop (Electron, desktop-app/), whose preload gives
// pages window.selahDesktop; the older Tauri app (desktop/) still works through window.__TAURI_INTERNALS__ until it's
// replaced. In the Windows app notifications are Windows notifications; in a browser or the installed web app, the
// browser's own. Reminders are on per device (Settings → General → Notifications); each event and task chooses its
// own (reminders.js).
import { api } from './api.js';
import { addDays, fmtDT, formatTime, fromWallClock, nowParts, relativeDay } from './time.js';
import { WINDOW, agendaItems as sharedAgenda, wallMin } from '../../shared/agenda.js';
import { focusOn } from './focus.js';
import { device } from './device.js';

// 13.0: the phone and tablet apps have no web notifications, so reminders are scheduled on the device ahead of time
// (@capacitor/local-notifications). They come even when the app is closed. At an event's start the phone says to
// take attendance (when a group meets then), and the tablet opens the lesson or sermon linked to it (else attendance).
const local = () => (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.LocalNotifications ?? null : null);
export const isAppNotifications = () => !!local();

// Tauri always gives its pages window.isTauri and __TAURI_INTERNALS__ (with invoke). The friendlier __TAURI__ global
// isn't there for a page from the server, so this goes by what always is.
const tauri = () => {
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  return invoke ? { invoke: (cmd, args) => invoke(cmd, args) } : null;
};
/** Selah Desktop's bridge (desktop-app/preload.cjs), or null. */
export const electron = () => (typeof window !== 'undefined' && window.selahDesktop?.kind === 'electron' ? window.selahDesktop : null);
export const isDesktopApp = () => !!(electron() || window.isTauri || window.__TAURI_INTERNALS__);
export const canNotify = () => isAppNotifications() || isDesktopApp() || typeof Notification !== 'undefined';

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
  if (local()) return (await local().checkPermissions().catch(() => ({}))).display === 'granted';
  if (electron()) return true;
  if (isDesktopApp()) return !!(await tauri()?.invoke('plugin:notification|is_permission_granted').catch(() => false));
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function askPermission() {
  if (await permitted()) return true;
  if (local()) return (await local().requestPermissions().catch(() => ({}))).display === 'granted';
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
  if (local()) {
    if (!(await permitted())) throw new Error('Notifications are off for Selah in this device’s settings.');
    await local().schedule({ notifications: [{ id: 1, title, body, schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true }, extra: { open: { section } } }] });
    return 'app';
  }
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
  if (local()) await scheduleAppReminders().catch(() => {});
  else if (on) checkReminders();
  return on;
}

// ---- reminders ----
const LATE = 15; // minutes: a reminder missed by more than this (the app was closed) isn't shown
let agenda = null; // { date, at, items: [{ key, at (wall-clock minutes), title, body, open }] }

/** Reminders due from `date` for the next week: { key, at (wall-clock minutes), title, body, open } (shared/agenda.js). */
export async function agendaItems(date) {
  const [cal, routine] = await Promise.all([api.calendar(date, addDays(date, WINDOW)), api.routine(date, date).catch(() => null)]);
  return sharedAgenda({ cal, routine, date, app: !!local(), role: device.role, fmt: { formatTime, relativeDay } });
}

async function loadAgenda(date) {
  agenda = { date, at: Date.now(), items: await agendaItems(date) };
}

// ---- the apps: scheduled on the device ----
const MAX_SCHEDULED = 60; // iOS keeps 64 at most
const idOf = (key) => { let h = 7; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0; return (Math.abs(h) % 2_000_000_000) + 10; };

/** Replaces what's scheduled on this device with the next week's reminders (none when reminders are off). */
export async function scheduleAppReminders() {
  const n = local();
  if (!n) return 0;
  const pending = (await n.getPending().catch(() => ({ notifications: [] }))).notifications ?? [];
  if (pending.length) await n.cancel({ notifications: pending.map((p) => ({ id: p.id })) }).catch(() => {});
  if (!remindersOn() || !(await permitted())) { reportPush([]); return 0; }
  const now = nowParts();
  const nowMin = wallMin(`${now.date}T${now.time}`);
  // `at` is wall-clock minutes in Selah's time zone (as UTC-mapped Dates, time.js); the device needs the real moment.
  const moment = (r) => fromWallClock(fmtDT(new Date(r.at * 60_000)));
  const items = (await agendaItems(now.date)).filter((r) => r.at > nowMin && moment(r) > Date.now() + 5000).sort((a, b) => a.at - b.at).slice(0, MAX_SCHEDULED);
  if (!items.length) { reportPush([]); return 0; }
  await n.schedule({ notifications: items.map((r) => ({
    id: idOf(r.key), title: r.title, body: r.body,
    schedule: { at: new Date(moment(r)), allowWhileIdle: true },
    extra: { open: typeof r.open === 'string' ? { section: r.open } : r.open },
  })) });
  reportPush(items);
  return items.length;
}

// ---- the apps: push (13.0, server/push.js) ----
// The server sends a reminder only to a device that doesn't have it scheduled (changed elsewhere while the app was
// closed), a quiet push to reschedule when the calendar changes, and a note when someone shares with you.
const pushPlugin = () => (local() ? window.Capacitor.Plugins?.PushNotifications ?? null : null);
const PUSH_TOKEN = 'selah.push.token';
let pushToken = (() => { try { return localStorage.getItem(PUSH_TOKEN); } catch { return null; } })();
let lastScheduled = [];
let reportTimer = null;

/** Tells the server this device's token, whether reminders are on here, and what's scheduled on the device. */
function reportPush(items) {
  lastScheduled = items.map((r) => ({ key: r.key, at: r.at }));
  if (!pushToken) return;
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    api.pushDevice({
      token: pushToken, platform: window.Capacitor.getPlatform(), role: device.role,
      name: device.tablet ? 'Tablet' : 'Phone', reminders: remindersOn(), scheduled: lastScheduled,
    }).catch(() => { /* next scheduling tries again */ });
  }, 500);
}

/** Signing out: this device stops getting pushes for this Selah. */
export async function forgetPush() {
  if (!pushToken) return;
  await api.forgetPushDevice(pushToken).catch(() => {});
  try { localStorage.removeItem(PUSH_TOKEN); } catch { /* fine */ }
  pushToken = null;
}

async function startAppPush() {
  const pn = pushPlugin();
  if (!pn) return;
  const platform = window.Capacitor.getPlatform();
  try {
    if (!(await api.pushStatus(platform)).available) return;
    // Android builds without Firebase would crash on register(); the app says whether this one has it.
    if (platform === 'android' && !(await window.Capacitor.Plugins?.SelahApp?.info?.().catch(() => null))?.push) return;
    let perm = await pn.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await pn.requestPermissions();
    if (perm.receive !== 'granted') return;
  } catch { return; }
  await pn.addListener('registration', (t) => {
    pushToken = t.value;
    try { localStorage.setItem(PUSH_TOKEN, t.value); } catch { /* registers again next launch */ }
    reportPush(lastScheduled);
  });
  await pn.addListener('pushNotificationReceived', (p) => {
    const data = p.data ?? {};
    if (data.kind === 'sync') { scheduleAppReminders().catch(() => {}); return; }
    // Android doesn't show a push while the app is open; iOS does (presentationOptions in capacitor.config.json).
    if (platform === 'android' && p.title) notify(p.title, p.body ?? '', parseOpen(data.open)?.section ?? null).catch(() => {});
  });
  await pn.addListener('pushNotificationActionPerformed', (a) => openFromNotification(parseOpen(a?.notification?.data?.open)));
  await pn.register().catch(() => {});
}
const parseOpen = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/**
 * For Settings: what's scheduled on this device ({ count, next: Date|null }) and, on Android, whether reminders can
 * come on time (Android 14+ makes "Alarms & reminders" something you allow; without it they can come minutes late).
 */
export async function appReminderStatus() {
  const n = local();
  if (!n) return null;
  const pending = (await n.getPending().catch(() => ({ notifications: [] }))).notifications ?? [];
  const times = pending.map((p) => new Date(p.schedule?.at ?? 0).getTime()).filter((t) => t > Date.now()).sort((a, b) => a - b);
  let exact = 'granted';
  if (window.Capacitor.getPlatform?.() === 'android') exact = (await n.checkExactNotificationSetting?.().catch(() => null))?.exact_alarm ?? 'granted';
  return { count: times.length, next: times.length ? new Date(times[0]) : null, exact };
}
/** Opens Android's "Alarms & reminders" setting for Selah (the app restarts and everything is scheduled again). */
export const allowExactReminders = () => local()?.changeExactNotificationSetting?.().catch(() => null);

/** A tapped notification opens what it's about. */
function openFromNotification(open) {
  if (!open) return;
  if (open.note) window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: open.note }));
  else if (open.attendance) {
    try { localStorage.setItem('noteapp.attendance.open', JSON.stringify(open.attendance)); } catch { /* opens the list */ }
    window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'attendance' }));
  } else if (open.section) window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: ['tasks', 'dailywalk', 'shared', 'inbox'].includes(open.section) ? open.section : 'calendar' }));
}

function startAppReminders() {
  const n = local();
  let soon = null;
  const again = () => { clearTimeout(soon); soon = setTimeout(() => scheduleAppReminders().catch(() => {}), 1500); };
  again();
  setInterval(again, 15 * 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') again(); });
  window.addEventListener('noteapp:live', (e) => { if (/^\/api\/(tasks|events|attendance|routine|plans|daily-walk)/.test(e.detail?.url ?? '')) again(); });
  Promise.resolve(n.addListener('localNotificationActionPerformed', (a) => openFromNotification(a?.notification?.extra?.open))).catch(() => {});
  startAppPush().catch(() => {});
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
  if (local()) { timer = true; startAppReminders(); return; }
  if (remindersOn()) serviceWorker();
  checkReminders();
  timer = setInterval(checkReminders, 30_000);
  // A task or event changed anywhere: the next check reloads the list.
  window.addEventListener('noteapp:live', (e) => { if (/^\/api\/(tasks|events|routine|plans|daily-walk)/.test(e.detail?.url ?? '')) agenda = null; });
}
