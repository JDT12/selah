// Dashboard, calendar events (with recurrence) and tasks.
import { db, tx, getSetting } from './db.js';
import { config } from './config.js';
import { offsiteWarning } from './offsite.js';
import { TAG_COLORS } from './tags.js';
import { categoryMap, categoryRef, defaultCategory, withTaskCategories } from './categories.js';
import {
  DATE_RE, DATETIME_RE, TIME_RE, toDate, fmt, addDays, today, normaliseRule, expand,
  truncateRule, remainderRule, nextTaskDate, shiftRuleWeekdays,
} from './recurrence.js';

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const COLORS = ['green', 'blue', 'purple', 'red', 'orange', 'yellow', 'teal', 'pink', 'gray'];
const SCOPES = ['this', 'future', 'all'];

function rule(v) {
  if (v === null || v === undefined || v === '') return null;
  try {
    return normaliseRule(v);
  } catch (e) {
    throw httpError(400, `Invalid repeat rule: ${e.message}`);
  }
}

function noteRef(v) {
  if (v === null || v === undefined || v === '') return null;
  const id = intParam(v);
  if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw httpError(404, 'Linked note not found');
  return id;
}

// Reminder lead times, in minutes before: at the time, 15 minutes, 1 hour, 12 hours, 1 day, 1 week.
const REMINDER_LEADS = [0, 15, 60, 720, 1440, 10080];
/** A JSON list of lead times, or null for the usual reminders (worked out by the app, see client desktop.js). */
function reminderList(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw httpError(400, 'Reminders must be a list');
  const leads = [...new Set(v.map(Number))].filter((n) => REMINDER_LEADS.includes(n)).sort((a, b) => a - b);
  return JSON.stringify(leads);
}
function parseReminders(s) {
  if (s === null || s === undefined) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function checkTimes(allDay, start, end) {
  const re = allDay ? DATE_RE : DATETIME_RE;
  if (!re.test(start ?? '') || !re.test(end ?? '')) {
    throw httpError(400, allDay ? 'Dates must be YYYY-MM-DD' : 'Times must be YYYY-MM-DDTHH:mm');
  }
  if (end < start) throw httpError(400, 'End must not be before start');
}

/** Validated non-time event fields present in `b`. */
function eventFields(b) {
  const f = {};
  if ('title' in b) f.title = String(b.title ?? '').slice(0, 500);
  if ('description' in b) f.description = String(b.description ?? '').slice(0, 20000);
  if ('location' in b) f.location = String(b.location ?? '').slice(0, 500);
  if ('color' in b) f.color = COLORS.includes(b.color) ? b.color : 'green';
  if ('category_id' in b) {
    f.category_id = categoryRef(b.category_id);
    // The event's own color follows its category (for anything that reads it directly).
    const c = f.category_id && categoryMap().get(f.category_id);
    f.color = c ? c.color : 'gray'; // no category: gray
  }
  if ('note_id' in b) f.note_id = noteRef(b.note_id);
  if ('reminders' in b) f.reminders = reminderList(b.reminders);
  return f;
}

function updateRow(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), Date.now(), id);
}

function insertEvent(e) {
  const now = Date.now();
  return Number(db.prepare(`INSERT INTO events
    (title, description, location, color, all_day, start_at, end_at, rrule, exdates, parent_id, original_start, note_id, reminders,
     category_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.title ?? '', e.description ?? '', e.location ?? '', e.color ?? 'green', e.all_day ? 1 : 0,
    e.start_at, e.end_at, e.rrule ?? null, e.exdates ?? '[]', e.parent_id ?? null, e.original_start ?? null,
    e.note_id ?? null, e.reminders ?? null, e.category_id ?? null, now, now,
  ).lastInsertRowid);
}

function getEvent(id) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) throw httpError(404, 'Event not found');
  return ev;
}

const durationMs = (ev) => toDate(ev.end_at) - toDate(ev.start_at);
const occEnd = (ev, occ) => fmt(new Date(toDate(occ).getTime() + durationMs(ev)), !!ev.all_day);

/** Resolve which series row + occurrence an edit targets. */
function resolveTarget(ev, scope, occurrence) {
  if (ev.parent_id && scope !== 'this') return { master: getEvent(ev.parent_id), occ: ev.original_start };
  if (ev.rrule) {
    const occ = occurrence || ev.start_at;
    if (!(ev.all_day ? DATE_RE : DATETIME_RE).test(occ)) throw httpError(400, 'Invalid occurrence');
    return { master: ev, occ };
  }
  return { master: null, occ: null };
}

/** Apply `changes` to an entire series, where the user edited occurrence `occ`. */
function editSeries(master, occ, changes) {
  const fields = eventFields(changes);
  const overrides = db.prepare('SELECT id, original_start, start_at, end_at FROM events WHERE parent_id = ?').all(master.id);

  if ('rrule' in changes) {
    const r = rule(changes.rrule);
    if (r !== master.rrule) fields.rrule = r; // the dialog always sends it; only act on real changes
  }

  const allDay = 'all_day' in changes ? !!changes.all_day : !!master.all_day;
  const newStart = changes.start ?? (allDay === !!master.all_day ? occ : null);
  const newEnd = changes.end ?? (allDay === !!master.all_day ? occEnd(master, occ) : null);
  if (newStart === null || newEnd === null) throw httpError(400, 'Start and end are required when changing all-day');
  checkTimes(allDay, newStart, newEnd);
  const timeChanged = allDay !== !!master.all_day || newStart !== occ || newEnd !== occEnd(master, occ);

  // Text/color/note changes also apply to individually edited occurrences.
  const shared = { ...fields };
  delete shared.rrule;
  const ruleChanged = fields.rrule !== undefined;
  const structural = ruleChanged || allDay !== !!master.all_day;

  if (timeChanged || ruleChanged) {
    // Shift the series by the same amount the edited occurrence moved.
    const delta = toDate(newStart) - toDate(occ);
    const shift = (d) => fmt(new Date(toDate(d).getTime() + delta), allDay);
    const start = new Date(toDate(master.start_at).getTime() + delta);
    const dur = toDate(newEnd) - toDate(newStart);
    fields.all_day = allDay ? 1 : 0;
    fields.start_at = fmt(start, allDay);
    fields.end_at = fmt(new Date(start.getTime() + dur), allDay);

    if (structural) {
      // New pattern: edited single occurrences no longer line up, so drop them (and their exclusions).
      const overridden = new Set(overrides.map((o) => o.original_start));
      const keep = JSON.parse(master.exdates).filter((d) => !overridden.has(d));
      fields.exdates = JSON.stringify(fields.rrule === null ? [] : keep.map(shift));
      db.prepare('DELETE FROM events WHERE parent_id = ?').run(master.id);
    } else {
      // Same pattern moved in time: weekdays move with it ("Fri+Sun" one day later -> "Sat+Mon"),
      // and edited occurrences move too, keeping their own changes.
      const dayShift = Math.round((toDate(newStart.slice(0, 10)) - toDate(occ.slice(0, 10))) / 86_400_000);
      if (dayShift) fields.rrule = shiftRuleWeekdays(master.rrule, dayShift);
      fields.exdates = JSON.stringify(JSON.parse(master.exdates).map(shift));
      for (const o of overrides) {
        const upd = { ...shared, original_start: shift(o.original_start) };
        if (o.start_at === o.original_start) {
          // Not moved on its own, so it follows the series' new time.
          const s = toDate(shift(o.start_at));
          upd.start_at = fmt(s, allDay);
          upd.end_at = fmt(new Date(s.getTime() + (toDate(o.end_at) - toDate(o.start_at))), allDay);
        }
        updateRow('events', o.id, upd);
      }
    }
  } else {
    for (const o of overrides) updateRow('events', o.id, shared);
  }
  updateRow('events', master.id, fields);
  return master.id;
}

/** Split a series at `occ`: the original ends before it, a new series starts at it. */
function splitSeries(master, occ) {
  const dtstart = toDate(master.start_at);
  const at = toDate(occ);
  const ex = JSON.parse(master.exdates);
  const newId = insertEvent({
    ...master,
    start_at: occ,
    end_at: occEnd(master, occ),
    rrule: remainderRule(master.rrule, dtstart, at),
    exdates: JSON.stringify(ex.filter((d) => d >= occ)),
  });
  db.prepare('UPDATE events SET parent_id = ? WHERE parent_id = ? AND original_start >= ?').run(newId, master.id, occ);
  updateRow('events', master.id, {
    rrule: truncateRule(master.rrule, dtstart, at),
    exdates: JSON.stringify(ex.filter((d) => d < occ)),
  });
  return getEvent(newId);
}

function serializeOccurrence(row, o) {
  return {
    key: `${row.id}:${o.start}`,
    id: row.id,
    occurrence: row.rrule ? o.start : row.original_start,
    series: !!(row.rrule || row.parent_id),
    rrule: row.rrule ?? row.parent_rrule ?? null,
    title: row.title,
    description: row.description,
    location: row.location,
    color: row.cat_color ?? row.color,
    category_id: row.category_id ?? null,
    category: row.cat_name ?? null,
    icon: row.cat_icon || null,
    // Reminders the category gives its events (used when the event has none of its own).
    category_reminders: parseReminders(row.cat_reminders),
    all_day: !!row.all_day,
    start: o.start,
    end: o.end,
    note_id: row.note_id,
    // 13.0: the linked note's title, and the attendance group that meets at this event (for the apps' notifications).
    note_title: row.note_title ?? null,
    attendance: row.att_group_id ? { id: row.att_group_id, name: row.att_group_name } : null,
    reminders: parseReminders(row.reminders),
    // A course's class (5.12): the study it belongs to, to open the course week.
    course_study_id: row.course_study_id ?? null,
  };
}

function occurrencesBetween(from, to) {
  const rows = db.prepare(`
    SELECT e.*, p.rrule AS parent_rrule, c.name AS cat_name, c.color AS cat_color, c.icon AS cat_icon, c.reminders AS cat_reminders,
      si.study_id AS course_study_id, n.title AS note_title,
      (SELECT g.id FROM att_groups g WHERE g.archived = 0 AND g.event_id IN (e.id, e.parent_id) ORDER BY g.id LIMIT 1) AS att_group_id,
      (SELECT g.name FROM att_groups g WHERE g.archived = 0 AND g.event_id IN (e.id, e.parent_id) ORDER BY g.id LIMIT 1) AS att_group_name
    FROM events e LEFT JOIN events p ON p.id = e.parent_id LEFT JOIN event_categories c ON c.id = e.category_id
    LEFT JOIN study_items si ON si.id = e.study_item_id LEFT JOIN notes n ON n.id = e.note_id AND n.deleted_at IS NULL
    WHERE (e.rrule IS NULL AND e.start_at < ? AND e.end_at >= ?) OR (e.rrule IS NOT NULL AND e.start_at < ?)`)
    .all(to, from, to);
  const out = [];
  for (const row of rows) for (const o of expand(row, from, to)) out.push(serializeOccurrence(row, o));
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ---------------- tasks ----------------
const LIST_COLORS = TAG_COLORS;

function listRef(v) {
  if (v === null || v === undefined || v === '') return null;
  const id = intParam(v);
  if (!db.prepare('SELECT 1 FROM task_lists WHERE id = ?').get(id)) throw httpError(404, 'Task list not found');
  return id;
}

/** Checklist steps: [{ id, title, done }], tidied. Steps without a title are dropped. */
function cleanSteps(v) {
  if (!Array.isArray(v)) throw httpError(400, 'Steps must be a list');
  if (v.length > 200) throw httpError(400, 'Too many steps');
  const seen = new Set();
  return v.map((x) => {
    let id = String(x?.id ?? '').slice(0, 40);
    if (!id || seen.has(id)) id = Math.random().toString(36).slice(2, 10);
    seen.add(id);
    return { id, title: String(x?.title ?? '').trim().slice(0, 500), done: !!x?.done };
  }).filter((x) => x.title);
}

function taskFields(b, existing) {
  const f = {};
  if ('title' in b) {
    f.title = String(b.title ?? '').trim().slice(0, 500);
    if (!f.title) throw httpError(400, 'Task title is required');
  }
  if ('description' in b) f.description = String(b.description ?? '').slice(0, 20000);
  if ('due_date' in b) {
    f.due_date = b.due_date || null;
    if (f.due_date && !DATE_RE.test(f.due_date)) throw httpError(400, 'Due date must be YYYY-MM-DD');
  }
  if ('start_date' in b) {
    f.start_date = b.start_date || null;
    if (f.start_date && !DATE_RE.test(f.start_date)) throw httpError(400, 'Start date must be YYYY-MM-DD');
  }
  if ('due_time' in b) {
    f.due_time = b.due_time || null;
    if (f.due_time && !TIME_RE.test(f.due_time)) throw httpError(400, 'Due time must be HH:mm');
  }
  if ('priority' in b) f.priority = Math.max(0, Math.min(3, Number(b.priority) || 0));
  if ('note_id' in b) f.note_id = noteRef(b.note_id);
  if ('list_id' in b) f.list_id = listRef(b.list_id);
  if ('steps' in b) f.steps = JSON.stringify(cleanSteps(b.steps));
  if ('position' in b) {
    f.position = Number(b.position);
    if (!Number.isFinite(f.position)) throw httpError(400, 'Invalid position');
  }
  if ('rrule' in b) f.rrule = rule(b.rrule);
  if ('reminders' in b) f.reminders = reminderList(b.reminders);

  const due = 'due_date' in f ? f.due_date : existing?.due_date;
  // A task can't start after it's due. Moving the due date earlier pulls the start date with it;
  // asking for a start date after the due date is an error.
  const start = 'start_date' in f ? f.start_date : existing?.start_date;
  if (start && due && start > due) {
    if ('start_date' in f) throw httpError(400, 'The start date must be on or before the due date');
    f.start_date = due;
  }
  // A task without a date can't repeat: clearing the date (e.g. "No date" on several tasks) stops it repeating.
  if (!due && !('rrule' in b) && existing?.rrule) f.rrule = null;
  if ('due_date' in f && !f.due_date) f.due_time = null;
  const rr = 'rrule' in f ? f.rrule : existing?.rrule;
  if (rr && !due) throw httpError(400, 'A repeating task needs a due date');
  // The series is anchored at its first due date (keeps COUNT and "every 2 weeks" aligned).
  if (('rrule' in f && f.rrule !== (existing?.rrule ?? null)) || (rr && !existing?.series_start)) {
    f.series_start = rr ? due : null;
  }
  return f;
}

const TASK_SELECT = `SELECT t.*, l.name AS list_name, l.color AS list_color
  FROM tasks t LEFT JOIN task_lists l ON l.id = t.list_id`;
// Within a day, timed tasks come first in time order, then the rest in your own order.
const TASK_ORDER = `ORDER BY t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, t.position, t.id`;

function parseSteps(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const taskRow = (r) => r && { ...r, steps: parseSteps(r.steps), reminders: parseReminders(r.reminders) };
const taskRows = (rows) => rows.map(taskRow);

function getTask(id) {
  const t = taskRow(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
  if (!t) throw httpError(404, 'Task not found');
  return t;
}

const nextPosition = () => (db.prepare('SELECT MAX(position) AS p FROM tasks').get().p ?? 0) + 1;

function insertTask(f, extra = {}) {
  const now = Date.now();
  return Number(db.prepare(`INSERT INTO tasks
    (id, title, description, due_date, due_time, start_date, priority, rrule, series_start, note_id, list_id, position, steps,
     reminders, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    extra.id ?? null, f.title, f.description ?? '', f.due_date ?? null, f.due_time ?? null, f.start_date ?? null, f.priority ?? 0,
    f.rrule ?? null, f.series_start ?? null, f.note_id ?? null, f.list_id ?? null, f.position ?? nextPosition(),
    f.steps ?? '[]', f.reminders ?? null, extra.completed_at ?? null, extra.created_at ?? now, now,
  ).lastInsertRowid);
}

/**
 * Complete a task. A repeating one creates the next (the next date after the later of its due date
 * and today, so an overdue daily task doesn't come back already late), with its steps unticked.
 */
function completeTask(id) {
  const task = getTask(id);
  if (task.completed_at) return null;
  db.prepare('UPDATE tasks SET completed_at = ?, rrule = NULL, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), task.id);
  if (!task.rrule) return null;
  const t = today();
  const after = task.due_date > t ? task.due_date : t;
  const due = nextTaskDate(task.rrule, task.series_start || task.due_date, after);
  if (!due) return null;
  // The next one starts the same number of days before it's due as this one did.
  const lead = task.start_date ? (toDate(task.due_date) - toDate(task.start_date)) / 86_400_000 : null;
  const nextId = insertTask({
    ...task, due_date: due, series_start: task.series_start || task.due_date,
    start_date: lead === null ? null : addDays(due, -Math.round(lead)),
    steps: JSON.stringify(task.steps.map((s) => ({ ...s, done: false }))),
    reminders: task.reminders ? JSON.stringify(task.reminders) : null,
  });
  return { id: nextId, due_date: due };
}

/** Un-complete a task. nextId (from completing it) is the repeat it created: that's removed and the task repeats again. */
function uncompleteTask(id, nextId) {
  const task = getTask(id);
  const next = nextId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(nextId) : null;
  if (next && !next.completed_at && next.rrule && next.title === task.title) {
    db.prepare('UPDATE tasks SET rrule = ?, series_start = ? WHERE id = ?').run(next.rrule, next.series_start, task.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(next.id);
  }
  db.prepare('UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), task.id);
}

function listName(v) {
  const name = String(v ?? '').trim().slice(0, 100);
  if (!name) throw httpError(400, 'List name is required');
  return name;
}
function checkListClash(name, id = null) {
  const other = db.prepare('SELECT id FROM task_lists WHERE name = ? COLLATE NOCASE').get(name);
  if (other && other.id !== id) throw httpError(409, `There is already a list called "${name}"`);
}

/** The dashboard banner image, if one is set: { v: cache-busting id, y: vertical focus % }. */
function dashboardBanner() {
  try {
    const b = JSON.parse(getSetting('banner'));
    return b ? { v: b.storage, y: b.y ?? 50 } : null;
  } catch {
    return null;
  }
}

/** Events (each occurrence) and tasks due from `from` up to `to`, as GET /api/calendar gives them (also server/push.js). */
export function calendarBetween(from, to) {
  return {
    events: occurrencesBetween(from, to),
    tasks: withTaskCategories(taskRows(db.prepare(`${TASK_SELECT} WHERE t.due_date >= ? AND t.due_date < ? ${TASK_ORDER}`).all(from, to))),
  };
}

export default async function planner(app) {
  // ---------- dashboard ----------
  app.get('/api/dashboard', async () => {
    const t = today();
    const weekEnd = addDays(t, 8);
    const notes = (where, limit) => db.prepare(`
      SELECT n.id, n.title, n.updated_at, substr(n.text, 1, 140) AS snippet, n.notebook_id, n.pinned, n.dash_pinned,
             nb.name AS notebook
      FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id
      WHERE n.deleted_at IS NULL AND n.is_template = 0 ${where} ORDER BY n.updated_at DESC LIMIT ${limit}`).all();
    return {
      today: t,
      timeZone: config.timeZone,
      events: occurrencesBetween(t, weekEnd),
      tasks: withTaskCategories(taskRows(db.prepare(`${TASK_SELECT} WHERE t.completed_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ? ${TASK_ORDER}`).all(weekEnd))),
      undated: taskRows(db.prepare(`${TASK_SELECT} WHERE t.completed_at IS NULL AND t.due_date IS NULL ORDER BY t.priority DESC, t.position, t.id LIMIT 8`).all()),
      recentNotes: notes('', 6),
      pinnedNotes: notes('AND n.dash_pinned = 1', 50),
      banner: dashboardBanner(),
      backupWarning: offsiteWarning(),
    };
  });

  // ---------- calendar feed ----------
  app.get('/api/calendar', async (req) => {
    const { from, to } = req.query;
    if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) throw httpError(400, 'from/to must be YYYY-MM-DD');
    if ((toDate(to) - toDate(from)) / 86_400_000 > 750) throw httpError(400, 'Range too large');
    return calendarBetween(from, to);
  });

  // ---------- events ----------
  app.get('/api/events/:id', async (req) => getEvent(intParam(req.params.id)));

  app.post('/api/events', async (req) => {
    const b = req.body ?? {};
    const allDay = !!b.all_day;
    checkTimes(allDay, b.start, b.end);
    // Without a category chosen, a new event gets the default one.
    const f = eventFields('category_id' in b ? b : { ...b, category_id: defaultCategory() });
    const id = insertEvent({ ...f, all_day: allDay, start_at: b.start, end_at: b.end, rrule: rule(b.rrule) });
    return { id };
  });

  app.patch('/api/events/:id', async (req) => {
    const ev = getEvent(intParam(req.params.id));
    const { scope = 'all', occurrence, changes = {} } = req.body ?? {};
    if (!SCOPES.includes(scope)) throw httpError(400, 'Invalid scope');
    return tx(() => {
      const { master, occ } = resolveTarget(ev, scope, occurrence);

      if (!master) {
        // Plain single event (or an already-detached occurrence edited on its own).
        const fields = eventFields(changes);
        const allDay = 'all_day' in changes ? !!changes.all_day : !!ev.all_day;
        const start = changes.start ?? ev.start_at;
        const end = changes.end ?? ev.end_at;
        checkTimes(allDay, start, end);
        Object.assign(fields, { all_day: allDay ? 1 : 0, start_at: start, end_at: end });
        if ('rrule' in changes && !ev.parent_id) fields.rrule = rule(changes.rrule);
        updateRow('events', ev.id, fields);
        return { id: ev.id };
      }

      if (scope === 'this') {
        const end = occEnd(master, occ);
        const allDay = 'all_day' in changes ? !!changes.all_day : !!master.all_day;
        const start = changes.start ?? occ;
        const finish = changes.end ?? end;
        checkTimes(allDay, start, finish);
        const ex = JSON.parse(master.exdates);
        if (!ex.includes(occ)) ex.push(occ);
        updateRow('events', master.id, { exdates: JSON.stringify(ex) });
        const id = insertEvent({
          ...master, ...eventFields(changes), all_day: allDay, start_at: start, end_at: finish,
          rrule: null, exdates: '[]', parent_id: master.id, original_start: occ,
        });
        return { id };
      }

      if (scope === 'future' && occ !== master.start_at) {
        return { id: editSeries(splitSeries(master, occ), occ, changes) };
      }
      return { id: editSeries(master, occ, changes) };
    });
  });

  app.delete('/api/events/:id', async (req) => {
    const ev = getEvent(intParam(req.params.id));
    const scope = SCOPES.includes(req.query.scope) ? req.query.scope : 'all';
    tx(() => {
      if (ev.parent_id && scope === 'this') {
        db.prepare('DELETE FROM events WHERE id = ?').run(ev.id); // its exdate on the parent stays
        return;
      }
      const { master, occ } = resolveTarget(ev, scope, req.query.occurrence);
      if (!master || scope === 'all' || (scope === 'future' && occ === master.start_at)) {
        db.prepare('DELETE FROM events WHERE id = ?').run((master ?? ev).id);
        return;
      }
      if (scope === 'this') {
        const ex = JSON.parse(master.exdates);
        if (!ex.includes(occ)) ex.push(occ);
        updateRow('events', master.id, { exdates: JSON.stringify(ex) });
        return;
      }
      // future
      db.prepare('DELETE FROM events WHERE parent_id = ? AND original_start >= ?').run(master.id, occ);
      updateRow('events', master.id, {
        rrule: truncateRule(master.rrule, toDate(master.start_at), toDate(occ)),
        exdates: JSON.stringify(JSON.parse(master.exdates).filter((d) => d < occ)),
      });
    });
    return { ok: true };
  });

  // ---------- tasks ----------
  app.get('/api/tasks', async (req) => {
    if (req.query.status === 'done') {
      return taskRows(db.prepare(`${TASK_SELECT} WHERE t.completed_at IS NOT NULL ORDER BY t.completed_at DESC LIMIT 300`).all());
    }
    return taskRows(db.prepare(`${TASK_SELECT} WHERE t.completed_at IS NULL ${TASK_ORDER}`).all());
  });

  app.post('/api/tasks', async (req) => {
    const f = taskFields({ title: '', ...req.body });
    return { id: insertTask(f) };
  });

  app.patch('/api/tasks/:id', async (req) => {
    const task = getTask(intParam(req.params.id));
    updateRow('tasks', task.id, taskFields(req.body ?? {}, task));
    return getTask(task.id);
  });

  // "Delete all completed" (all of them, not just the 300 the Completed view shows).
  app.delete('/api/tasks/completed', async () => ({
    deleted: db.prepare('DELETE FROM tasks WHERE completed_at IS NOT NULL').run().changes,
  }));

  // Returns the deleted task, so it can be put back (Undo).
  app.delete('/api/tasks/:id', async (req) => {
    const task = getTask(intParam(req.params.id));
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    return { deleted: [task] };
  });

  app.post('/api/tasks/:id/complete', async (req) => tx(() => ({ next: completeTask(intParam(req.params.id)) })));

  app.post('/api/tasks/:id/uncomplete', async (req) => tx(() => {
    uncompleteTask(intParam(req.params.id), req.body?.next_id ? intParam(req.body.next_id) : null);
    return { ok: true };
  }));

  // The same action on several tasks at once: complete, uncomplete (items: [{ id, next_id }]),
  // delete (returns the deleted tasks for Undo) or update (changes: due date, list, priority).
  app.post('/api/tasks/bulk', async (req) => {
    const { action, ids = [], items = [], changes = {} } = req.body ?? {};
    const list = (action === 'uncomplete' ? items.map((x) => x?.id) : ids).map(intParam);
    if (list.length > 1000) throw httpError(400, 'Too many tasks');
    return tx(() => {
      switch (action) {
        case 'complete':
          return { done: list.map((id) => ({ id, next: completeTask(id) })) };
        case 'uncomplete':
          items.forEach((x, i) => uncompleteTask(list[i], x.next_id ? intParam(x.next_id) : null));
          return { ok: true };
        case 'delete': {
          const deleted = list.map(getTask);
          for (const t of deleted) db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
          return { deleted };
        }
        case 'update': {
          const allowed = Object.fromEntries(Object.entries(changes)
            .filter(([k]) => ['due_date', 'due_time', 'start_date', 'list_id', 'priority'].includes(k)));
          for (const id of list) {
            const task = getTask(id);
            updateRow('tasks', id, taskFields(allowed, task));
          }
          return { ok: true };
        }
        default:
          throw httpError(400, 'Unknown action');
      }
    });
  });

  // Put deleted tasks back (Undo), with their old ids where those are still free.
  app.post('/api/tasks/restore', async (req) => {
    const tasks = req.body?.tasks;
    if (!Array.isArray(tasks) || tasks.length > 1000) throw httpError(400, 'tasks must be a list');
    return tx(() => {
      for (const t of tasks) {
        const { title, description, due_date, due_time, start_date, priority, note_id, steps, position, rrule, reminders } = t ?? {};
        const f = taskFields({
          title, description, due_date, due_time, start_date, priority, steps: steps ?? [], position: position ?? nextPosition(), rrule,
          reminders: Array.isArray(reminders) ? reminders : null,
        });
        // A list or note deleted since then is left off rather than failing the whole undo.
        try { f.list_id = listRef(t.list_id); } catch { f.list_id = null; }
        try { f.note_id = noteRef(note_id); } catch { f.note_id = null; }
        if (f.rrule && DATE_RE.test(t.series_start ?? '')) f.series_start = t.series_start;
        const id = Number.isInteger(t.id) && t.id > 0 && !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(t.id) ? t.id : null;
        insertTask(f, {
          id,
          completed_at: Number.isFinite(t.completed_at) ? t.completed_at : null,
          created_at: Number.isFinite(t.created_at) ? t.created_at : undefined,
        });
      }
      return { ok: true };
    });
  });

  // ---------- task lists ----------
  app.get('/api/task-lists', async () => db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed_at IS NULL) AS open
    FROM task_lists l ORDER BY l.position, l.id`).all());

  app.post('/api/task-lists', async (req) => {
    const name = listName(req.body?.name);
    checkListClash(name);
    // Without a color (e.g. a list made by typing #Name), it gets the first color no list has yet.
    const used = new Set(db.prepare('SELECT color FROM task_lists').all().map((r) => r.color));
    const color = LIST_COLORS.includes(req.body?.color) ? req.body.color
      : ['blue', 'green', 'orange', 'purple', 'teal', 'pink', 'indigo', 'sky', 'red', 'lime', 'yellow'].find((c) => !used.has(c)) ?? 'gray';
    const pos = (db.prepare('SELECT MAX(position) AS p FROM task_lists').get().p ?? 0) + 1;
    const { lastInsertRowid } = db.prepare('INSERT INTO task_lists (name, color, position, created_at) VALUES (?, ?, ?, ?)')
      .run(name, color, pos, Date.now());
    return { id: Number(lastInsertRowid), name, color };
  });

  app.patch('/api/task-lists/:id', async (req) => {
    const id = listRef(intParam(req.params.id));
    const b = req.body ?? {};
    if ('name' in b) {
      const name = listName(b.name);
      checkListClash(name, id);
      db.prepare('UPDATE task_lists SET name = ? WHERE id = ?').run(name, id);
    }
    if ('color' in b) db.prepare('UPDATE task_lists SET color = ? WHERE id = ?').run(LIST_COLORS.includes(b.color) ? b.color : null, id);
    if ('position' in b) {
      if (!Number.isFinite(Number(b.position))) throw httpError(400, 'Invalid position');
      db.prepare('UPDATE task_lists SET position = ? WHERE id = ?').run(Number(b.position), id);
    }
    return db.prepare('SELECT * FROM task_lists WHERE id = ?').get(id);
  });

  // Deleting a list moves its tasks to the Inbox, or deletes them with ?tasks=delete.
  app.delete('/api/task-lists/:id', async (req) => tx(() => {
    const id = listRef(intParam(req.params.id));
    if (req.query.tasks === 'delete') db.prepare('DELETE FROM tasks WHERE list_id = ?').run(id);
    db.prepare('DELETE FROM task_lists WHERE id = ?').run(id);
    return { ok: true };
  }));
}
