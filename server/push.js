import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { agendaItems, WINDOW, wallMin } from '../shared/agenda.js';
import { calendarBetween } from './planner.js';
import { routineDay } from './routine.js';

/**
 * Push to the phone and tablet apps (13.0): reminders that the device doesn't already have, a quiet "check for
 * changes" when the calendar or routine changes, and a note when someone shares with you.
 *
 * Each app registers its push token here with what it has scheduled on the device (PUT /api/push/device). Reminders
 * are worked out exactly as the app does (shared/agenda.js); at each one's moment, a device that has it scheduled
 * already is skipped and any other gets a push. So a reminder changed on the computer while the phone was closed
 * still arrives, once.
 *
 * This Selah never holds Apple's or Google's keys. Messages wait in push_outbox; the admin console keeps a request
 * open to the control port (GET /control/push/outbox) and sends them (server/admin/push.js), telling this Selah which
 * tokens are no longer good (POST /control/push/drop) and whether push is set up at all (POST /control/push/state).
 * A home server (single mode) has no console, so its apps keep to reminders scheduled on the device.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const enabled = () => config.mode === 'tenant';
const LATE = 15; // minutes: a reminder missed by more than this isn't sent
const TICK = Number(process.env.NOTEAPP_PUSH_TICK_MS || 60_000);
const SYNC_DELAY = Number(process.env.NOTEAPP_PUSH_SYNC_MS || 20_000);
const PLATFORMS = ['ios', 'android'];
const ROLES = ['phone', 'tablet'];
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

if (config.mode !== 'admin') db.exec(`
CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                  -- ios | android
  role TEXT NOT NULL DEFAULT 'phone',      -- phone | tablet (what an event's start says)
  name TEXT NOT NULL DEFAULT '',
  reminders INTEGER NOT NULL DEFAULT 1,    -- this device has reminders on (Settings → General → Notifications)
  scheduled TEXT NOT NULL DEFAULT '{}',    -- { key: at } that the device has scheduled itself
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_sent (
  token TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,                     -- the reminder's wall-clock minute
  PRIMARY KEY (token, key, at)
);
CREATE TABLE IF NOT EXISTS push_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused: the console remembers the last one it had
  at INTEGER NOT NULL,
  msg TEXT NOT NULL
);`);

// ---------- the outbox the console reads ----------

const outboxEvents = new EventEmitter();
outboxEvents.setMaxListeners(20);

/** Queues one push for one device: { kind: 'alert' | 'sync', title, body, open, collapse }. */
function queue(device, msg) {
  if (!enabled()) return;
  db.prepare('INSERT INTO push_outbox (at, msg) VALUES (?, ?)').run(Date.now(), JSON.stringify({ token: device.token, platform: device.platform, ...msg }));
  outboxEvents.emit('queued');
}

async function readOutbox(after, wait) {
  const top = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'push_outbox'").get()?.seq ?? 0;
  if (after > top) after = 0;
  db.prepare('DELETE FROM push_outbox WHERE seq <= ?').run(after);
  // A push that waited more than an hour (the console was down) is no use now.
  db.prepare('DELETE FROM push_outbox WHERE at < ?').run(Date.now() - 3600_000);
  const rows = () => db.prepare('SELECT seq, msg FROM push_outbox WHERE seq > ? ORDER BY seq LIMIT 100').all(after);
  let list = rows();
  if (!list.length && wait > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(done, wait);
      function done() { clearTimeout(t); outboxEvents.off('queued', done); resolve(); }
      outboxEvents.on('queued', done);
    });
    list = rows();
  }
  return list.map((r) => ({ seq: r.seq, ...json(r.msg, {}) }));
}

// ---------- what's due ----------

const devices = () => db.prepare('SELECT * FROM push_devices').all();
const pushState = () => json(getSetting('push_state'), { ios: false, android: false });
const canSend = (d) => enabled() && !!pushState()[d.platform];

function nowWall() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const dayFmt = (opts) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
const fmt = (today) => ({
  formatTime: (s) => dayFmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(`${s.includes('T') ? s : `2000-01-01T${s}`}:00Z`)),
  relativeDay: (date) => {
    const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    const d = new Date(`${date}T12:00:00Z`);
    return diff > 1 && diff < 7 ? dayFmt({ weekday: 'long' }).format(d) : dayFmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  },
});
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A short id for a reminder, so a second push for the same one replaces the first on the device. */
const collapseOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 32);

/** Sends the reminders now due that a device doesn't have scheduled itself. Exported for the tests. */
export function sendDueReminders() {
  const list = devices().filter((d) => d.reminders && canSend(d));
  if (!list.length) return 0;
  const { date, time } = nowWall();
  const nowMin = wallMin(`${date}T${time}`);
  // Yesterday too, so a reminder just before midnight is still found a minute after it.
  const from = addDays(date, -1);
  const cal = calendarBetween(from, addDays(from, WINDOW + 1));
  let routine = null;
  try { routine = routineDay(date, date); } catch { /* no routine */ }
  const byRole = new Map();
  let sent = 0;
  for (const d of list) {
    const role = ROLES.includes(d.role) ? d.role : 'phone';
    if (!byRole.has(role)) {
      byRole.set(role, agendaItems({ cal, routine, date, app: true, role, fmt: fmt(date) })
        .filter((r) => r.at <= nowMin && r.at > nowMin - LATE));
    }
    const has = json(d.scheduled, {});
    for (const r of byRole.get(role)) {
      if (has[r.key] === r.at) continue;
      const fresh = db.prepare('INSERT OR IGNORE INTO push_sent (token, key, at) VALUES (?, ?, ?)').run(d.token, r.key, r.at).changes;
      if (!fresh) continue;
      queue(d, { kind: 'alert', title: clip(r.title, 120), body: clip(r.body, 240), open: typeof r.open === 'string' ? { section: r.open } : r.open, collapse: collapseOf(r.key) });
      sent++;
    }
  }
  db.prepare('DELETE FROM push_sent WHERE at < ?').run(nowMin - 2 * 1440);
  return sent;
}

/** A note to every device (someone shared with you). */
export function pushToAll(title, body, open = null) {
  for (const d of devices()) if (canSend(d)) queue(d, { kind: 'alert', title: clip(title, 120), body: clip(body, 240), open });
}

// The calendar, tasks or routine changed: an open or suspended app reschedules (a quiet push; the server's own
// reminder covers a closed one).
let syncTimer = null;
function syncSoon(exceptToken = null) {
  if (!enabled() || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    for (const d of devices()) if (d.reminders && canSend(d) && d.token !== exceptToken) queue(d, { kind: 'sync', collapse: 'sync' });
  }, SYNC_DELAY);
  syncTimer.unref?.();
}

// ---------- routes ----------

export default async function pushRoutes(app) {
  // What the app needs to know: whether this Selah can push to its platform.
  app.get('/api/push/status', async (req) => {
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : null;
    const state = pushState();
    return { available: enabled() && (platform ? !!state[platform] : state.ios || state.android) };
  });

  // An app's token and what it has scheduled itself: { token, platform, role, name, reminders, scheduled: [{ key, at }] }.
  app.put('/api/push/device', async (req) => {
    const b = req.body ?? {};
    const token = clip(b.token, 4096);
    if (!token || !/^[\w:.\-]+$/.test(token)) throw httpError(400, 'Invalid token');
    if (!PLATFORMS.includes(b.platform)) throw httpError(400, 'Unknown platform');
    const scheduled = {};
    for (const s of Array.isArray(b.scheduled) ? b.scheduled.slice(0, 200) : []) {
      if (typeof s?.key === 'string' && Number.isFinite(s.at)) scheduled[s.key.slice(0, 200)] = s.at;
    }
    const now = Date.now();
    db.prepare(`INSERT INTO push_devices (token, platform, role, name, reminders, scheduled, synced_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, role = excluded.role, name = excluded.name, reminders = excluded.reminders,
        scheduled = excluded.scheduled, synced_at = excluded.synced_at, last_seen = excluded.last_seen`)
      .run(token, b.platform, ROLES.includes(b.role) ? b.role : 'phone', clip(b.name, 80), b.reminders ? 1 : 0, JSON.stringify(scheduled), now, now, now);
    return { ok: true, available: canSend({ platform: b.platform }) };
  });

  // Signing out of the device, or turning push off there.
  app.delete('/api/push/device', async (req) => {
    const token = clip(req.body?.token ?? req.query.token, 4096);
    db.prepare('DELETE FROM push_devices WHERE token = ?').run(token);
    db.prepare('DELETE FROM push_sent WHERE token = ?').run(token);
    return { ok: true };
  });

  if (enabled()) {
    const timer = setInterval(() => { try { sendDueReminders(); } catch (e) { app.log.warn(`Push reminders: ${e.message}`); } }, TICK);
    timer.unref();
  }
}

/** Changes to the calendar, tasks or routine from any route (a hook on the root app: server/index.js). */
export function watchPushChanges(app) {
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400 || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (/^\/api\/(tasks|events|routine|attendance|plans|calendar-categories)/.test(req.url)) syncSoon();
  });
}

/** The console's side, on the control port (server/tenant.js). */
export function pushControl(app) {
  app.get('/control/push/outbox', async (req) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const wait = Math.min(30_000, Math.max(0, Number(req.query.wait) || 0));
    return { messages: await readOutbox(after, wait) };
  });
  // Whether the host has Apple's and Google's keys: { ios, android }.
  app.post('/control/push/state', async (req) => {
    const b = req.body ?? {};
    setSetting('push_state', JSON.stringify({ ios: !!b.ios, android: !!b.android }));
    return { ok: true };
  });
  // Tokens Apple or Google say are gone (the app was removed): { tokens: [] }.
  app.post('/control/push/drop', async (req) => {
    const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map(String) : [];
    for (const t of tokens) {
      db.prepare('DELETE FROM push_devices WHERE token = ?').run(t);
      db.prepare('DELETE FROM push_sent WHERE token = ?').run(t);
    }
    return { dropped: tokens.length };
  });
  app.get('/control/push/health', async () => ({ devices: db.prepare('SELECT platform, COUNT(*) AS n FROM push_devices GROUP BY platform').all() }));
}
