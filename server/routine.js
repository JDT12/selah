import { db, getSetting, setSetting, tx } from './db.js';
import { escapeHtml, htmlToText } from './html.js';
import { dayOn } from '../shared/readingPlans.js';
import { prayerDay } from './prayer.js';
import { bookReading, createJournal, setBookRead } from './dailywalk.js';

/**
 * 13.0: the Daily Walk routine. You set it up once (items in order) and check it off each day; the streak counts the
 * days you finished it. Every item is optional:
 *   plan     today's passages from one of your reading plans (done when they're all read: reading_plan_reads)
 *   prayer   the requests due that day (done when they're all prayed: prayer_log; a day with none due counts as done)
 *   journal  a line or two for the day, kept in the day's journal note (done once it has one: dw_journal)
 *   custom   anything you name, with an optional link, note or timer (done when you tick it: routine_marks)
 *   devotional  a DRM-free EPUB devotional from the library: that day's reading in full (done when read: dw_reads)
 * A daily reminder at a time you pick (setting routine_reminder, "HH:MM"; the apps and browsers schedule it).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS routine_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  plan_id INTEGER REFERENCES reading_plans(id) ON DELETE CASCADE,
  link TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  minutes INTEGER,
  position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS routine_marks (
  day TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES routine_items(id) ON DELETE CASCADE,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (day, item_id)
);`);

// The connected devotionals (dw_books) were retired for the routine: disconnected once, so the journal note no longer
// lists them. Their stored text stays in the database, unused.
if (!getSetting('routine_devotionals_retired')) {
  db.exec('UPDATE dw_books SET connected = 0');
  setSetting('routine_devotionals_retired', '1');
}

// 13.0: a devotional book (a DRM-free EPUB in the library, dw_books) as a routine item.
if (!db.prepare('PRAGMA table_info(routine_items)').all().some((c) => c.name === 'book_id')) db.exec('ALTER TABLE routine_items ADD COLUMN book_id INTEGER');
// 13.0 (after beta.28): a reading plan card shows the passages' text only when asked (show_text); otherwise just the references.
if (!db.prepare('PRAGMA table_info(routine_items)').all().some((c) => c.name === 'show_text')) db.exec('ALTER TABLE routine_items ADD COLUMN show_text INTEGER NOT NULL DEFAULT 0');

const KINDS = ['plan', 'prayer', 'journal', 'custom', 'devotional'];
const DAY = 86_400_000;
const HISTORY = 120; // days of history for the streak and the week strip
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const isoDate = (v, what = 'date') => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, `Give the ${what} as YYYY-MM-DD`);
  return s;
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const items = () => db.prepare('SELECT * FROM routine_items ORDER BY position, id').all();

/** A plan's passages on a day: { title, day, refs, read: [bool] }, or null when it has none that day. */
function planDay(planId, day) {
  const row = db.prepare('SELECT * FROM reading_plans WHERE id = ?').get(planId);
  if (!row) return null;
  const p = { ...row, offset: row.shift_days, schedule: JSON.parse(row.schedule) };
  const { day: at, reading } = dayOn(p, day);
  const refs = reading && at >= 0 && at < p.schedule.length ? p.schedule[at] : [];
  const done = new Set(db.prepare('SELECT item FROM reading_plan_reads WHERE plan_id = ? AND day = ?').all(planId, at).map((r) => r.item));
  return { id: planId, title: row.title, status: row.status, day: at, refs, read: refs.map((_, i) => done.has(i)) };
}

const journalOn = (day) => db.prepare(`SELECT j.note_id FROM dw_journal j JOIN notes n ON n.id = j.note_id
  WHERE j.day = ? AND n.deleted_at IS NULL`).get(day)?.note_id ?? null;

/** Whether an item was done on a day (and what it shows that day). */
function state(it, day, cache = {}) {
  if (it.kind === 'plan') {
    const pd = planDay(it.plan_id, day);
    return { done: !pd || !pd.refs.length || pd.read.every(Boolean), plan: pd };
  }
  if (it.kind === 'prayer') {
    cache.prayer ??= {};
    const pr = (cache.prayer[day] ??= prayerDay(day));
    const due = pr.items.filter((p) => !p.extra);
    return { done: !due.length || due.every((p) => p.prayed), prayer: pr };
  }
  if (it.kind === 'devotional') {
    const r = bookReading(it.book_id, day);
    return { done: !r || !r.entry || r.read, devotional: r };
  }
  if (it.kind === 'journal') {
    const id = journalOn(day);
    return { done: !!id, journal: id };
  }
  return { done: !!db.prepare('SELECT 1 FROM routine_marks WHERE day = ? AND item_id = ?').get(day, it.id) };
}

/** The items that were in the routine on a day (made by its end). */
const itemsOn = (list, day) => list.filter((it) => it.created_at < Date.parse(`${addDays(day, 1)}T00:00:00Z`) + 14 * 3_600_000);

/** Per day for the history: 0 nothing, 1 some, 2 all done; and the streak (today counts once it's finished). */
function stats(today) {
  const list = items();
  const cache = {};
  const days = {};
  for (let i = 0; i < HISTORY; i++) {
    const day = addDays(today, -i);
    const on = itemsOn(list, day);
    if (!on.length) continue;
    const done = on.filter((it) => state(it, day, cache).done).length;
    days[day] = done === on.length ? 2 : done ? 1 : 0;
  }
  let streak = 0;
  for (let i = days[today] === 2 ? 0 : 1; i < HISTORY; i++) {
    if (days[addDays(today, -i)] === 2) streak++;
    else break;
  }
  let longest = 0;
  let run = 0;
  for (let i = HISTORY - 1; i >= 0; i--) {
    if (days[addDays(today, -i)] === 2) { run++; longest = Math.max(longest, run); } else run = 0;
  }
  return { streak, longest, days };
}

export function routineDay(day, today) {
  const list = items();
  const cache = {};
  const out = list.map((it) => ({ ...it, ...state(it, day, cache) }));
  const reminder = getSetting('routine_reminder') || null;
  // journal: the day's journal note, for the Walk page's Journal button (with or without a journal item).
  return { date: day, items: out, done: out.length > 0 && out.every((x) => x.done), reminder, journal: journalOn(day), stats: stats(today) };
}

/** For the reminders: the time, and whether today's routine is already finished. */
export function routineReminder(today) {
  const time = getSetting('routine_reminder') || null;
  if (!time) return null;
  const list = items();
  const left = list.filter((it) => !state(it, today).done).length;
  return { time, left, total: list.length };
}

function fields(b, existing = {}) {
  const f = {};
  if ('kind' in b || !existing.kind) {
    if (!KINDS.includes(b.kind)) throw httpError(400, 'Pick what the item is');
    f.kind = b.kind;
  }
  const kind = f.kind ?? existing.kind;
  if ('title' in b) f.title = clip(b.title, 200);
  if (kind === 'plan' && ('plan_id' in b || !existing.plan_id)) {
    const id = intParam(b.plan_id);
    if (!db.prepare('SELECT 1 FROM reading_plans WHERE id = ?').get(id)) throw httpError(404, 'Reading plan not found');
    f.plan_id = id;
  }
  if (kind === 'devotional' && ('book_id' in b || !existing.book_id)) {
    const id = intParam(b.book_id);
    if (!db.prepare('SELECT 1 FROM dw_books WHERE id = ?').get(id)) throw httpError(404, 'Devotional not found');
    f.book_id = id;
  }
  if ('link' in b) {
    const link = clip(b.link, 2000);
    if (link && !/^https?:\/\//i.test(link)) throw httpError(400, 'A link starts with http:// or https://');
    f.link = link;
  }
  if ('note' in b) f.note = clip(b.note, 4000);
  if ('show_text' in b) f.show_text = b.show_text ? 1 : 0;
  if ('minutes' in b) {
    const m = b.minutes === '' || b.minutes == null ? null : Number(b.minutes);
    if (m != null && (!Number.isInteger(m) || m < 1 || m > 240)) throw httpError(400, 'A timer is 1 to 240 minutes');
    f.minutes = m;
  }
  if (kind === 'custom' && !(f.title ?? existing.title)) throw httpError(400, 'Name the item');
  return f;
}

export default async function routineRoutes(app) {
  app.get('/api/routine', async (req) => routineDay(isoDate(req.query.date), isoDate(req.query.today ?? req.query.date, 'today')));

  app.post('/api/routine/items', async (req) => {
    const f = fields(req.body ?? {});
    const max = db.prepare('SELECT MAX(position) AS m FROM routine_items').get().m ?? 0;
    const id = Number(db.prepare('INSERT INTO routine_items (kind, title, plan_id, book_id, link, note, minutes, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.kind, f.title ?? '', f.plan_id ?? null, f.book_id ?? null, f.link ?? '', f.note ?? '', f.minutes ?? null, max + 1, Date.now()).lastInsertRowid);
    return { id };
  });

  app.patch('/api/routine/items/:id', async (req) => {
    const id = intParam(req.params.id);
    const it = db.prepare('SELECT * FROM routine_items WHERE id = ?').get(id);
    if (!it) throw httpError(404, 'Not in your routine');
    const f = fields({ ...req.body, kind: it.kind }, it);
    delete f.kind;
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE routine_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    return { ok: true };
  });

  app.delete('/api/routine/items/:id', async (req) => {
    db.prepare('DELETE FROM routine_items WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // Body: { ids: [...] } in their new order.
  app.put('/api/routine/order', async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    tx(() => ids.forEach((id, i) => db.prepare('UPDATE routine_items SET position = ? WHERE id = ?').run(i + 1, id)));
    return { ok: true };
  });

  // A custom item ticked (or not) for a day: { date, item, done, today } -> the day.
  app.put('/api/routine/mark', async (req) => {
    const b = req.body ?? {};
    const day = isoDate(b.date);
    const id = intParam(b.item);
    if (!db.prepare('SELECT 1 FROM routine_items WHERE id = ?').get(id)) throw httpError(404, 'Not in your routine');
    if (b.done) db.prepare('INSERT OR IGNORE INTO routine_marks (day, item_id, done_at) VALUES (?, ?, ?)').run(day, id, Date.now());
    else db.prepare('DELETE FROM routine_marks WHERE day = ? AND item_id = ?').run(day, id);
    return routineDay(day, isoDate(b.today ?? day, 'today'));
  });

  // A devotional's reading checked (or not) for a day: { date, item, read, today } -> the day.
  app.put('/api/routine/devotional', async (req) => {
    const b = req.body ?? {};
    const day = isoDate(b.date);
    const it = db.prepare("SELECT * FROM routine_items WHERE id = ? AND kind = 'devotional'").get(intParam(b.item));
    if (!it) throw httpError(404, 'Not in your routine');
    setBookRead(it.book_id, day, !!b.read);
    return routineDay(day, isoDate(b.today ?? day, 'today'));
  });

  // The journal item: a line or two added to the day's journal note (made the first time). { date, text, today }.
  app.post('/api/routine/journal', async (req) => {
    const b = req.body ?? {};
    const day = isoDate(b.date);
    const text = clip(b.text, 8000);
    const { id } = createJournal(day, null);
    if (text) {
      const n = db.prepare('SELECT html FROM notes WHERE id = ?').get(id);
      const add = text.split(/\n+/).filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join('');
      const html = `${n.html}${add}`;
      db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), Date.now(), id);
    }
    return { note_id: id, day: routineDay(day, isoDate(b.today ?? day, 'today')) };
  });

  // { time: "HH:MM" | null }: the daily reminder.
  app.put('/api/routine/reminder', async (req) => {
    const t = req.body?.time;
    if (t != null && t !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))) throw httpError(400, 'Give the time as HH:MM');
    setSetting('routine_reminder', t ? String(t) : '');
    return { reminder: t || null };
  });
}
