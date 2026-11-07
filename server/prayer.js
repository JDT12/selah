import { db, tx, getSetting, setSetting } from './db.js';
import { today as appToday } from './recurrence.js';

/**
 * The prayer list: requests with a person, category, Bible references and a timeline of updates, prayed on a
 * rhythm (every day, on chosen weekdays, or a few a day in rotation), marked answered with how they were answered.
 *
 * "Prayed" checks are kept per request per day. A day's prayers count toward the Daily Walk streak (see
 * dailywalk.js): when every request due that day is checked, a "prayer" row is written to dw_reads for it, so later
 * changes to the list don't rewrite past days.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const DAY = 86_400_000;
const PER_DAY = 'prayer.perDay';
export const CATEGORIES = ['Family', 'Church', 'Missions', 'Friends', 'Self', 'World'];
const SCHEDULES = new Set(['daily', 'weekly', 'rotation']);
const STATUSES = new Set(['active', 'answered', 'archived']);

db.exec(`
CREATE TABLE IF NOT EXISTS prayers (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  person TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT 'daily',
  weekdays INTEGER NOT NULL DEFAULT 0, -- bit 0 = Sunday … bit 6 = Saturday
  status TEXT NOT NULL DEFAULT 'active',
  answer TEXT NOT NULL DEFAULT '',
  note_id INTEGER,
  created_day TEXT NOT NULL,
  closed_day TEXT, -- answered or archived on
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prayer_updates (
  id INTEGER PRIMARY KEY,
  prayer_id INTEGER NOT NULL REFERENCES prayers(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prayer_updates_prayer ON prayer_updates(prayer_id);
CREATE TABLE IF NOT EXISTS prayer_log (
  prayer_id INTEGER NOT NULL REFERENCES prayers(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (prayer_id, day)
);
CREATE INDEX IF NOT EXISTS prayer_log_day ON prayer_log(day);`);

const dayParam = (v) => {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) throw httpError(400, 'Bad date.');
  return s;
};
const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const perDay = () => Math.max(1, Math.min(20, Number(getSetting(PER_DAY)) || 3));
const all = () => db.prepare('SELECT * FROM prayers ORDER BY id').all();
const activeOn = (p, day) => p.created_day <= day && (!p.closed_day || p.closed_day > day);

/**
 * The requests due on a day, as of the list now: daily ones, weekly ones on their weekdays, and the day's turn
 * of the rotation (`perDay` of them, moving on each day so the whole rotation comes round in turn).
 */
function dueOn(day, list = all()) {
  const live = list.filter((p) => activeOn(p, day));
  const due = live.filter((p) => p.schedule === 'daily' || (p.schedule === 'weekly' && (p.weekdays >> weekday(day)) & 1));
  const rot = live.filter((p) => p.schedule === 'rotation');
  if (rot.length) {
    const n = Math.min(perDay(), rot.length);
    const start = (dayNumber(day) * n) % rot.length;
    for (let i = 0; i < n; i++) due.push(rot[(start + i) % rot.length]);
  }
  return due;
}

const loggedOn = (day) => new Set(db.prepare('SELECT prayer_id FROM prayer_log WHERE day = ?').all(day).map((r) => r.prayer_id));

/** Whether a day had prayers to pray (so Daily Walk counts them toward the day being complete). */
export function prayerNeeded(day, list) {
  return dueOn(day, list).length > 0 || db.prepare('SELECT 1 FROM prayer_log WHERE day = ? LIMIT 1').get(day) != null;
}
/** Days with at least one prayer checked. */
export const prayedDays = () => db.prepare('SELECT DISTINCT day FROM prayer_log').all().map((r) => r.day);
export const hasPrayers = () => db.prepare('SELECT 1 FROM prayers LIMIT 1').get() != null;
export const allPrayers = all;

/** Writes or clears the day's "prayer" row in dw_reads: there when everything due that day is checked. */
function syncDay(day) {
  const due = dueOn(day);
  const prayed = loggedOn(day);
  const done = due.length > 0 ? due.every((p) => prayed.has(p.id)) : prayed.size > 0;
  if (done) db.prepare("INSERT INTO dw_reads (source, day, read_at) VALUES ('prayer', ?, ?) ON CONFLICT DO NOTHING").run(day, Date.now());
  else db.prepare("DELETE FROM dw_reads WHERE source = 'prayer' AND day = ?").run(day);
}

const brief = (p) => ({ id: p.id, title: p.title, person: p.person, category: p.category, refs: p.refs, schedule: p.schedule, weekdays: p.weekdays });

/** One day's prayers: what's due, plus anything else checked that day. */
export function prayerDay(day) {
  const list = all();
  const due = dueOn(day, list);
  const prayed = loggedOn(day);
  const ids = new Set(due.map((p) => p.id));
  const extra = list.filter((p) => prayed.has(p.id) && !ids.has(p.id));
  const items = [...due.map((p) => ({ ...brief(p), prayed: prayed.has(p.id) })), ...extra.map((p) => ({ ...brief(p), prayed: true, extra: true }))];
  return { date: day, items, complete: due.length > 0 && due.every((p) => prayed.has(p.id)), any: list.length > 0 };
}

/** Checks or unchecks one request for a day. */
export function setPrayed(id, day, prayed) {
  if (!db.prepare('SELECT 1 FROM prayers WHERE id = ?').get(id)) throw httpError(404, 'Prayer request not found.');
  tx(() => {
    if (prayed) db.prepare('INSERT INTO prayer_log (prayer_id, day, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(id, day, Date.now());
    else db.prepare('DELETE FROM prayer_log WHERE prayer_id = ? AND day = ?').run(id, day);
    syncDay(day);
  });
}

/** The prayer list page's numbers. Streaks count days on which every request due was prayed. */
function stats(today) {
  const done = new Set(db.prepare("SELECT day FROM dw_reads WHERE source = 'prayer'").all().map((r) => r.day));
  let streak = 0;
  for (let d = done.has(today) ? today : addDays(today, -1); done.has(d); d = addDays(d, -1)) streak++;
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of [...done].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  const year = today.slice(0, 4);
  const yearDays = db.prepare('SELECT COUNT(DISTINCT day) AS n FROM prayer_log WHERE day LIKE ? AND day <= ?').get(`${year}-%`, today).n;
  const times = db.prepare('SELECT COUNT(*) AS n FROM prayer_log').get().n;
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM prayers GROUP BY status').all();
  const n = (s) => counts.find((c) => c.status === s)?.n ?? 0;
  const answeredThisYear = db.prepare("SELECT COUNT(*) AS n FROM prayers WHERE status = 'answered' AND closed_day LIKE ?").get(`${year}-%`).n;
  return { streak, longest: Math.max(longest, streak), yearDays, times, active: n('active'), answered: n('answered'), archived: n('archived'), answeredThisYear };
}

function requests() {
  const updates = new Map();
  for (const u of db.prepare('SELECT id, prayer_id, day, text FROM prayer_updates ORDER BY day, id').all()) {
    if (!updates.has(u.prayer_id)) updates.set(u.prayer_id, []);
    updates.get(u.prayer_id).push({ id: u.id, day: u.day, text: u.text });
  }
  const logs = new Map(db.prepare('SELECT prayer_id, COUNT(*) AS times, MAX(day) AS last FROM prayer_log GROUP BY prayer_id').all()
    .map((r) => [r.prayer_id, r]));
  const notes = new Map(db.prepare('SELECT id, title FROM notes WHERE deleted_at IS NULL AND id IN (SELECT note_id FROM prayers WHERE note_id IS NOT NULL)').all()
    .map((r) => [r.id, r.title]));
  return all().map((p) => ({
    ...p,
    note: p.note_id != null && notes.has(p.note_id) ? { id: p.note_id, title: notes.get(p.note_id) } : null,
    times: logs.get(p.id)?.times ?? 0,
    lastPrayed: logs.get(p.id)?.last ?? null,
    updates: updates.get(p.id) ?? [],
  }));
}

/** Validates the editable fields of a request body (only those present). */
function fields(b, { creating }) {
  const out = {};
  if (creating || 'title' in b) {
    out.title = text(b.title, 300);
    if (!out.title) throw httpError(400, 'Give the request a title.');
  }
  if ('person' in b) out.person = text(b.person, 120);
  if ('category' in b) out.category = text(b.category, 60);
  if ('details' in b) out.details = String(b.details ?? '').trim().slice(0, 10_000);
  if ('refs' in b) out.refs = text(b.refs, 500);
  if ('schedule' in b) {
    if (!SCHEDULES.has(b.schedule)) throw httpError(400, 'Unknown schedule.');
    out.schedule = b.schedule;
  }
  if ('weekdays' in b) out.weekdays = Number(b.weekdays) & 0x7f;
  if ((out.schedule ?? (creating ? 'daily' : null)) === 'weekly' && 'weekdays' in out && !out.weekdays) throw httpError(400, 'Choose at least one weekday.');
  if ('answer' in b) out.answer = String(b.answer ?? '').trim().slice(0, 10_000);
  if ('note_id' in b) {
    out.note_id = b.note_id == null ? null : Number(b.note_id);
    if (out.note_id != null && !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(out.note_id)) throw httpError(404, 'Note not found.');
  }
  return out;
}

export default async function prayerRoutes(app) {
  // ?today=YYYY-MM-DD (the user's today, for the stats).
  app.get('/api/prayer', async (req) => {
    const today = dayParam(req.query.today ?? appToday());
    const used = db.prepare("SELECT DISTINCT category FROM prayers WHERE category <> '' ORDER BY category").all().map((r) => r.category);
    return { requests: requests(), categories: [...new Set([...CATEGORIES, ...used])], perDay: perDay(), stats: stats(today), today: prayerDay(today) };
  });

  app.get('/api/prayer/day', async (req) => prayerDay(dayParam(req.query.date)));

  app.post('/api/prayer', async (req) => {
    const b = req.body ?? {};
    const f = fields(b, { creating: true });
    if (f.schedule === 'weekly' && !f.weekdays) throw httpError(400, 'Choose at least one weekday.');
    const day = dayParam(b.today ?? appToday());
    const now = Date.now();
    const id = tx(() => {
      const row = { person: '', category: '', details: '', refs: '', schedule: 'daily', weekdays: 0, note_id: null, ...f };
      const { lastInsertRowid } = db.prepare(`INSERT INTO prayers (title, person, category, details, refs, schedule, weekdays, note_id, created_day, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.title, row.person, row.category, row.details, row.refs, row.schedule, row.weekdays, row.note_id, day, now, now);
      syncDay(day);
      return Number(lastInsertRowid);
    });
    return requests().find((p) => p.id === id);
  });

  // Body: any editable field, plus status ('answered' | 'archived' | 'active') with answer and closed_day.
  app.patch('/api/prayer/:id', async (req) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT * FROM prayers WHERE id = ?').get(id);
    if (!p) throw httpError(404, 'Prayer request not found.');
    const b = req.body ?? {};
    const f = fields(b, { creating: false });
    if ((f.schedule ?? p.schedule) === 'weekly' && !(f.weekdays ?? p.weekdays)) throw httpError(400, 'Choose at least one weekday.');
    const day = dayParam(b.today ?? appToday());
    if ('status' in b) {
      if (!STATUSES.has(b.status)) throw httpError(400, 'Unknown status.');
      f.status = b.status;
      if (b.status === 'active') f.closed_day = null;
      else if (b.status !== p.status || b.closed_day) f.closed_day = b.closed_day ? dayParam(b.closed_day) : day;
      if (f.closed_day && f.closed_day < p.created_day) f.closed_day = p.created_day;
    }
    const keys = Object.keys(f);
    if (keys.length) {
      tx(() => {
        db.prepare(`UPDATE prayers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => f[k]), Date.now(), id);
        syncDay(day);
      });
    }
    return requests().find((r) => r.id === id);
  });

  app.delete('/api/prayer/:id', async (req) => {
    const day = dayParam(req.query.today ?? appToday());
    tx(() => {
      const id = Number(req.params.id);
      db.prepare('DELETE FROM prayer_log WHERE prayer_id = ?').run(id);
      db.prepare('DELETE FROM prayer_updates WHERE prayer_id = ?').run(id);
      db.prepare('DELETE FROM prayers WHERE id = ?').run(id);
      syncDay(day);
    });
    return { ok: true };
  });

  // Body: { text, day? }: a dated update on the request ("Surgery went well").
  app.post('/api/prayer/:id/updates', async (req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM prayers WHERE id = ?').get(id)) throw httpError(404, 'Prayer request not found.');
    const t = String(req.body?.text ?? '').trim().slice(0, 5000);
    if (!t) throw httpError(400, 'Write the update first.');
    const day = dayParam(req.body?.day ?? appToday());
    db.prepare('INSERT INTO prayer_updates (prayer_id, day, text, created_at) VALUES (?, ?, ?, ?)').run(id, day, t, Date.now());
    db.prepare('UPDATE prayers SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return requests().find((r) => r.id === id);
  });

  app.delete('/api/prayer/updates/:id', async (req) => {
    db.prepare('DELETE FROM prayer_updates WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // Body: { perDay, today? }: how many rotation requests come up each day.
  app.put('/api/prayer/settings', async (req) => {
    const n = Number(req.body?.perDay);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw httpError(400, 'Choose 1 to 20 a day.');
    setSetting(PER_DAY, String(n));
    syncDay(dayParam(req.body?.today ?? appToday()));
    return { perDay: n };
  });
}
