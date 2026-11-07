import { db, tx } from './db.js';
import { BUILT_IN, EVERY_DAY, dayOn, scheduleProblem } from '../shared/readingPlans.js';

/**
 * Reading plans (10.2), on Walk's Plans tab and Home. A plan keeps its own copy of its schedule (built-in or yours),
 * reads on chosen weekdays from its start date, and remembers each passage you tick. Missed days (from `since_day`,
 * so a plan joined mid-year by the calendar starts clean) can be caught up one by one, or the plan shifted so today
 * picks up at the first one you missed (`offset`).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS reading_plans (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'custom',
  schedule TEXT NOT NULL,
  start_date TEXT NOT NULL,
  weekdays INTEGER NOT NULL DEFAULT 127,
  shift_days INTEGER NOT NULL DEFAULT 0,
  since_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reading_plan_reads (
  plan_id INTEGER NOT NULL REFERENCES reading_plans(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  item INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, day, item)
);
`);

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
const mask = (v) => {
  const n = Number(v ?? EVERY_DAY);
  if (!Number.isInteger(n) || n < 1 || n > 127) throw httpError(400, 'Pick at least one day of the week');
  return n;
};
const BEHIND_SHOWN = 30;

/** A row as the shared day math wants it (`offset` is the days shifted back). */
const withSchedule = (p) => ({ ...p, offset: p.shift_days, schedule: JSON.parse(p.schedule) });

function load(id) {
  const p = db.prepare('SELECT * FROM reading_plans WHERE id = ?').get(id);
  if (!p) throw httpError(404, 'Reading plan not found');
  return withSchedule(p);
}

const readSet = (planId) => new Set(db.prepare('SELECT day, item FROM reading_plan_reads WHERE plan_id = ?').all(planId).map((r) => `${r.day}:${r.item}`));

/** A plan as the Plans tab and Home show it, on `today`. */
function summary(p, today) {
  const done = readSet(p.id);
  const days = p.schedule.length;
  const { day: at, reading } = dayOn(p, today);
  const items = (d) => (p.schedule[d] ?? []).map((ref, i) => ({ i, ref, read: done.has(`${d}:${i}`) }));
  const unread = (d) => (p.schedule[d] ?? []).some((_, i) => !done.has(`${d}:${i}`));
  const total = p.schedule.reduce((n, d) => n + d.length, 0);
  // Missed: unread days from since_day up to today (not today itself).
  const missed = [];
  for (let d = Math.max(0, p.since_day); d < Math.min(at, days); d++) if (unread(d)) missed.push(d);
  const remaining = [];
  for (let d = Math.max(0, p.since_day); d < days; d++) if (unread(d)) remaining.push(d);
  return {
    id: p.id, title: p.title, source: p.source, days, start_date: p.start_date, weekdays: p.weekdays, offset: p.offset,
    since_day: p.since_day, status: p.status, created_at: p.created_at,
    day: at, reading, notStarted: at < 0, finished: !remaining.length,
    today: reading && at >= 0 && at < days ? { day: at, items: items(at) } : null,
    behindCount: missed.length,
    behind: missed.slice(0, BEHIND_SHOWN).map((d) => ({ day: d, items: items(d) })),
    progress: { read: done.size, total },
    next: remaining.find((d) => d >= at) ?? null,
  };
}

const today = (req) => isoDate(req.query?.today ?? req.body?.today, 'today');

/** Each active plan's passages on a day, for the day's journal note: [{ title, refs }]. */
export function plansOn(day) {
  return db.prepare("SELECT * FROM reading_plans WHERE status = 'active' ORDER BY created_at").all().map((row) => {
    const p = withSchedule(row);
    const { day: at, reading } = dayOn(p, day);
    return reading && at >= 0 && at < p.schedule.length ? { title: p.title, refs: p.schedule[at] } : null;
  }).filter((x) => x?.refs.length);
}

export default async function readingPlanRoutes(app) {
  // The plans Selah comes with.
  app.get('/api/plans/catalog', async () => Object.entries(BUILT_IN).map(([key, b]) => {
    const s = b.schedule();
    return { key, title: b.title, about: b.about, calendar: b.calendar, days: s.length, perDay: Math.round((s.reduce((n, d) => n + d.length, 0) / s.length) * 10) / 10 };
  }));

  // Your plans (all but archived), on `today`.
  app.get('/api/plans', async (req) => {
    const t = today(req);
    return db.prepare("SELECT * FROM reading_plans WHERE status != 'archived' ORDER BY created_at").all()
      .map((p) => summary(withSchedule(p), t));
  });

  // One plan with its whole schedule and what's read.
  app.get('/api/plans/:id', async (req) => {
    const p = load(intParam(req.params.id));
    const done = readSet(p.id);
    return { ...summary(p, today(req)), schedule: p.schedule.map((d, day) => d.map((ref, i) => ({ ref, read: done.has(`${day}:${i}`) }))) };
  });

  /**
   * A new plan. Body: { source: 'bibleyear' | 'mcheyne' | 'chronological' } or { title, schedule, source: 'custom' | 'csv' },
   * with start_date, weekdays and today. A built-in plan with calendar: true follows the calendar (day 1 on January 1,
   * so today is that day's reading, and nothing before today counts as missed).
   */
  app.post('/api/plans', async (req) => {
    const b = req.body ?? {};
    const t = today(req);
    const built = BUILT_IN[b.source];
    let schedule;
    let title;
    if (built) {
      schedule = built.schedule();
      title = String(b.title ?? '').trim() || built.title;
    } else {
      schedule = b.schedule;
      const problem = scheduleProblem(schedule);
      if (problem) throw httpError(400, problem);
      title = String(b.title ?? '').trim();
      if (!title) throw httpError(400, 'Give the plan a name');
    }
    const calendar = !!(built?.calendar && b.calendar);
    const weekdays = calendar ? EVERY_DAY : mask(b.weekdays);
    const start = calendar ? `${t.slice(0, 4)}-01-01` : isoDate(b.start_date ?? t, 'start date');
    const since = calendar ? Math.max(0, dayOn({ start_date: start, weekdays, offset: 0 }, t).day) : 0;
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO reading_plans (title, source, schedule, start_date, weekdays, since_day, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(title.slice(0, 200), built ? b.source : (b.source === 'csv' ? 'csv' : 'custom'),
      JSON.stringify(schedule), start, weekdays, since, now, now).lastInsertRowid);
    return summary(load(id), t);
  });

  // Rename, pause or archive, or change the start date or days. Body: any of { title, status, start_date, weekdays }.
  app.patch('/api/plans/:id', async (req) => {
    const p = load(intParam(req.params.id));
    const b = req.body ?? {};
    const sets = [];
    const args = [];
    if ('title' in b) {
      const title = String(b.title ?? '').trim();
      if (!title) throw httpError(400, 'Give the plan a name');
      sets.push('title = ?'); args.push(title.slice(0, 200));
    }
    if ('status' in b) {
      if (!['active', 'paused', 'archived'].includes(b.status)) throw httpError(400, 'Unknown status');
      sets.push('status = ?'); args.push(b.status);
    }
    if ('start_date' in b) { sets.push('start_date = ?', 'shift_days = 0'); args.push(isoDate(b.start_date, 'start date')); }
    if ('weekdays' in b) { sets.push('weekdays = ?'); args.push(mask(b.weekdays)); }
    if (sets.length) db.prepare(`UPDATE reading_plans SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), p.id);
    return summary(load(p.id), today(req));
  });

  app.delete('/api/plans/:id', async (req) => {
    db.prepare('DELETE FROM reading_plans WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // Tick or untick a passage, or a whole day (item left out). Body: { day, item?, read, today }.
  app.put('/api/plans/:id/read', async (req) => {
    const p = load(intParam(req.params.id));
    const b = req.body ?? {};
    const day = Number(b.day);
    if (!Number.isInteger(day) || day < 0 || day >= p.schedule.length) throw httpError(400, 'That day isn’t in the plan');
    const items = b.item == null ? p.schedule[day].map((_, i) => i) : [Number(b.item)];
    if (items.some((i) => !Number.isInteger(i) || i < 0 || i >= p.schedule[day].length)) throw httpError(400, 'That passage isn’t in the plan');
    tx(() => {
      const put = db.prepare('INSERT OR IGNORE INTO reading_plan_reads (plan_id, day, item, read_at) VALUES (?, ?, ?, ?)');
      const drop = db.prepare('DELETE FROM reading_plan_reads WHERE plan_id = ? AND day = ? AND item = ?');
      for (const i of items) (b.read ? put.run(p.id, day, i, Date.now()) : drop.run(p.id, day, i));
    });
    return summary(p, today(req));
  });

  // Shift the plan so today is the first day you haven't finished (the missed days move forward; nothing is lost).
  app.post('/api/plans/:id/shift', async (req) => {
    const p = load(intParam(req.params.id));
    const t = today(req);
    const s = summary(p, t);
    const first = s.behind[0]?.day;
    if (first == null || first >= s.day) return s;
    db.prepare('UPDATE reading_plans SET shift_days = shift_days + ?, updated_at = ? WHERE id = ?').run(s.day - first, Date.now(), p.id);
    return summary(load(p.id), t);
  });

  // Start again from day 1 today (what's read is cleared).
  app.post('/api/plans/:id/restart', async (req) => {
    const p = load(intParam(req.params.id));
    const t = today(req);
    tx(() => {
      db.prepare('DELETE FROM reading_plan_reads WHERE plan_id = ?').run(p.id);
      db.prepare("UPDATE reading_plans SET start_date = ?, shift_days = 0, since_day = 0, status = 'active', updated_at = ? WHERE id = ?").run(t, Date.now(), p.id);
    });
    return summary(load(p.id), t);
  });
}
