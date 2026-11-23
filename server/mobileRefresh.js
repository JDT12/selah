import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { agendaItems, WINDOW, wallMin } from '../shared/agenda.js';
import { calendarBetween } from './planner.js';
import { routineDay } from './routine.js';

/**
 * 14.4: background refresh in the phone and tablet apps (mobile-app/runners/background.js). While the app is closed,
 * the phone wakes a small script now and then (Android about every 15 minutes, iOS when it allows); it asks here for
 * the reminders coming up and schedules the ones the device doesn't have yet. Nothing else can be read with its key.
 *
 * The key is made by the app while it's signed in (GET /api/mobile/refresh-key) and works only as long as that sign-in
 * does: signing out of the device, or removing it in Settings → Security, ends it.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const AHEAD_MIN = 36 * 60;
const MAX = 60;
const ROLES = ['phone', 'tablet'];

if (config.mode !== 'admin') db.exec(`
CREATE TABLE IF NOT EXISTS mobile_refresh (
  key_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'phone',
  created_at INTEGER NOT NULL,
  used_at INTEGER
);`);

function wallNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** The real moment (ms) of wall-clock minutes in Selah's time zone. */
export function wallToEpoch(min) {
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute) - Math.floor(t / 60_000) * 60_000;
  };
  let t = min * 60_000;
  for (let i = 0; i < 2; i++) t = min * 60_000 - offset(t);
  return t;
}

const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayFmt = (opts) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
const fmt = (today) => ({
  formatTime: (s) => dayFmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(`${s.includes('T') ? s : `2000-01-01T${s}`}:00Z`)),
  relativeDay: (date) => {
    const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    const d = new Date(`${date}T12:00:00Z`);
    return diff > 1 && diff < 7 ? dayFmt({ weekday: 'long' }).format(d) : dayFmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  },
});

/** The reminders in the next day and a half for a phone or a tablet, soonest first. */
export function upcomingReminders(role = 'phone') {
  const { date, time } = wallNow();
  const nowMin = wallMin(`${date}T${time}`);
  const cal = calendarBetween(date, addDays(date, WINDOW + 1));
  let routine = null;
  try { routine = routineDay(date, date); } catch { /* no routine */ }
  return agendaItems({ cal, routine, date, app: true, role: ROLES.includes(role) ? role : 'phone', fmt: fmt(date) })
    .filter((r) => r.at > nowMin && r.at <= nowMin + AHEAD_MIN)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX)
    .map((r) => ({ key: r.key, title: String(r.title ?? '').slice(0, 120), body: String(r.body ?? '').slice(0, 240), at: wallToEpoch(r.at), open: typeof r.open === 'string' ? { section: r.open } : r.open ?? null }));
}

function keyRow(key) {
  if (!key || key.length > 200) return null;
  const row = db.prepare('SELECT * FROM mobile_refresh WHERE key_hash = ?').get(sha256(key));
  if (!row) return null;
  const session = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(row.session_hash);
  if (!session || session.expires_at <= Date.now()) {
    db.prepare('DELETE FROM mobile_refresh WHERE session_hash = ?').run(row.session_hash);
    return null;
  }
  return row;
}

export default async function mobileRefreshRoutes(app) {
  // Made by the app itself (a mobile sign-in); one per device, replaced each time.
  app.get('/api/mobile/refresh-key', async (req) => {
    if (req.session?.app !== 'mobile' || !req.sessionToken) throw httpError(403, 'Only the Selah app can do this.');
    const sessionHash = sha256(req.sessionToken);
    const key = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM mobile_refresh WHERE session_hash = ?').run(sessionHash);
    db.prepare('INSERT INTO mobile_refresh (key_hash, session_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(key), sessionHash, ROLES.includes(req.query.role) ? req.query.role : 'phone', Date.now());
    return { key };
  });

  // Asked by the background script with no cookie: the key is in a header.
  app.get('/api/mobile/upcoming', async (req) => {
    const row = keyRow(String(req.headers['x-selah-refresh'] ?? ''));
    if (!row) throw httpError(401, 'Sign in again in the Selah app.');
    db.prepare('UPDATE mobile_refresh SET used_at = ? WHERE key_hash = ?').run(Date.now(), row.key_hash);
    return { items: upcomingReminders(row.role), at: Date.now() };
  });
}
