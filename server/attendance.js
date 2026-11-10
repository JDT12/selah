import { db, tx } from './db.js';
import { addDays, expand, today } from './recurrence.js';
import { compareNames } from '../shared/names.js';

/**
 * Attendance (11.0), a tab on Plan: the classes you teach, the services you preach and your small groups. A group
 * keeps a roster to check off (or just a headcount); its meetings come from a recurring calendar event (or any date
 * you add). Someone on a roster who has missed the last three meetings they could have come to is a nudge on the
 * tab, which turns into a follow-up task. Visitors are added on the spot. Each group exports as CSV.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS att_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'group',
  mode TEXT NOT NULL DEFAULT 'roster',
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS att_people (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES att_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  visitor INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  since TEXT NOT NULL,
  followup_at TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS att_people_group ON att_people(group_id);
CREATE TABLE IF NOT EXISTS att_meetings (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES att_groups(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  headcount INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, date)
);
CREATE TABLE IF NOT EXISTS att_marks (
  meeting_id INTEGER NOT NULL REFERENCES att_meetings(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES att_people(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id)
);
`);

export const KINDS = { class: 'Class', service: 'Service', group: 'Small group' };
const MODES = ['roster', 'headcount'];
/** Misses in a row before a nudge. */
export const NUDGE_AFTER = 3;
const WEEKS_SHOWN = 12;

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const isoDate = (v) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'Give the date as YYYY-MM-DD');
  return s;
};
const cleanName = (v, what = 'name') => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!s) throw httpError(400, `Type a ${what}`);
  return s;
};

function getGroup(id) {
  const g = db.prepare('SELECT * FROM att_groups WHERE id = ?').get(id);
  if (!g) throw httpError(404, 'Group not found');
  return g;
}
function getPerson(id) {
  const p = db.prepare('SELECT * FROM att_people WHERE id = ?').get(id);
  if (!p) throw httpError(404, 'Person not found');
  return p;
}
const checkEvent = (id) => {
  if (id == null || id === '') return null;
  const n = intParam(id);
  if (!db.prepare('SELECT 1 FROM events WHERE id = ? AND parent_id IS NULL').get(n)) throw httpError(400, 'That calendar event is gone');
  return n;
};

/** The dates a group's calendar event falls on in [from, to) (moved occurrences included). */
export function eventDates(eventId, from, to) {
  if (!eventId) return [];
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return [];
  const out = expand(ev, from, to).map((o) => o.start.slice(0, 10));
  for (const c of db.prepare('SELECT * FROM events WHERE parent_id = ?').all(eventId)) out.push(...expand(c, from, to).map((o) => o.start.slice(0, 10)));
  return [...new Set(out)].sort();
}

/** Meetings taken (saved) for a group, oldest first, with who was there. */
function takenMeetings(groupId) {
  const meetings = db.prepare('SELECT * FROM att_meetings WHERE group_id = ? ORDER BY date').all(groupId);
  const marks = db.prepare('SELECT m.meeting_id, m.person_id FROM att_marks m JOIN att_meetings t ON t.id = m.meeting_id WHERE t.group_id = ?').all(groupId);
  const by = new Map(meetings.map((m) => [m.id, []]));
  for (const k of marks) by.get(k.meeting_id)?.push(k.person_id);
  return meetings.map((m) => ({ ...m, present: by.get(m.id) ?? [] }));
}

/** How many of the latest meetings in a row a person missed (only meetings since they joined count). */
function missedInRow(person, meetings) {
  let n = 0;
  let since = null;
  for (let i = meetings.length - 1; i >= 0; i -= 1) {
    const m = meetings[i];
    if (m.date < person.since) break;
    if (m.present.includes(person.id)) break;
    n += 1;
    since = m.date;
  }
  return { missed: n, since };
}

/** Who to follow up with in a group: on the roster, missed NUDGE_AFTER+ in a row, not followed up since. */
function groupNudges(g, people, meetings) {
  if (g.mode !== 'roster' || g.archived) return [];
  const out = [];
  for (const p of people) {
    if (!p.active) continue;
    const { missed, since } = missedInRow(p, meetings);
    if (missed < NUDGE_AFTER) continue;
    if (p.followup_at && p.followup_at >= since) continue;
    const last = [...meetings].reverse().find((m) => m.present.includes(p.id));
    out.push({ person_id: p.id, name: p.name, group_id: g.id, group: g.name, missed, last_seen: last?.date ?? null });
  }
  return out;
}

const countOf = (g, m) => (g.mode === 'headcount' ? m.headcount ?? 0 : m.present.length + (m.headcount ?? 0));

/** A group's people: regulars before visitors, each by last name so couples sit together. */
const peopleOf = (groupId) => db.prepare('SELECT * FROM att_people WHERE group_id = ?').all(groupId)
  .sort((a, b) => (a.visitor - b.visitor) || compareNames(a.name, b.name) || (a.id - b.id));

function summary(g) {
  const people = peopleOf(g.id);
  const meetings = takenMeetings(g.id);
  const recent = meetings.slice(-8);
  const ev = g.event_id ? db.prepare('SELECT id, title, start_at, rrule FROM events WHERE id = ?').get(g.event_id) : null;
  const t = today();
  const next = eventDates(g.event_id, t, addDays(t, 15))[0] ?? null;
  return {
    ...g, archived: !!g.archived, kind_label: KINDS[g.kind] ?? g.kind, event: ev ?? null,
    people: people.filter((p) => p.active && !p.visitor).length, visitors: people.filter((p) => p.active && p.visitor).length,
    meetings: meetings.length, last: meetings.at(-1)?.date ?? null, last_count: meetings.length ? countOf(g, meetings.at(-1)) : null,
    average: recent.length ? Math.round(recent.reduce((s, m) => s + countOf(g, m), 0) / recent.length) : null,
    next, nudges: groupNudges(g, people, meetings),
  };
}

function detail(g) {
  const t = today();
  const people = peopleOf(g.id);
  const meetings = takenMeetings(g.id);
  // The dates to show: its event's from twelve weeks back to two weeks ahead, and every meeting taken.
  const from = addDays(t, -7 * WEEKS_SHOWN);
  const dates = new Set([...eventDates(g.event_id, from, addDays(t, 15)), ...meetings.map((m) => m.date)]);
  const byDate = new Map(meetings.map((m) => [m.date, m]));
  const list = [...dates].sort().reverse().map((date) => {
    const m = byDate.get(date);
    return m ? { date, taken: true, id: m.id, headcount: m.headcount, notes: m.notes, present: m.present, count: countOf(g, m) }
      : { date, taken: false, present: [], count: null, future: date > t };
  });
  const enriched = people.map((p) => {
    const { missed } = missedInRow(p, meetings);
    const attended = meetings.filter((m) => m.date >= p.since && m.present.includes(p.id)).length;
    const possible = meetings.filter((m) => m.date >= p.since).length;
    return { ...p, visitor: !!p.visitor, active: !!p.active, missed, attended, possible };
  });
  return { ...summary(g), today: t, roster: enriched, dates: list };
}

/** Saves (or makes) a meeting. */
function upsertMeeting(groupId, date) {
  const now = Date.now();
  db.prepare(`INSERT INTO att_meetings (group_id, date, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, date) DO UPDATE SET updated_at = excluded.updated_at`).run(groupId, date, now, now);
  return db.prepare('SELECT * FROM att_meetings WHERE group_id = ? AND date = ?').get(groupId, date);
}

const csvCell = (v) => {
  const s = String(v ?? '');
  // Leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** A group as CSV: one row per person, one column per meeting (headcount groups: one row per meeting). */
export function groupCsv(g) {
  const meetings = takenMeetings(g.id);
  const lines = [];
  if (g.mode === 'headcount') {
    lines.push(['Date', 'Headcount', 'Notes']);
    for (const m of meetings) lines.push([m.date, m.headcount ?? '', m.notes]);
  } else {
    const people = peopleOf(g.id);
    lines.push(['Name', 'Visitor', ...meetings.map((m) => m.date), 'Attended']);
    for (const p of people) {
      const marks = meetings.map((m) => (m.date < p.since ? '' : m.present.includes(p.id) ? 'P' : 'A'));
      lines.push([p.name, p.visitor ? 'yes' : '', ...marks, marks.filter((x) => x === 'P').length]);
    }
    lines.push(['Others (headcount)', '', ...meetings.map((m) => m.headcount ?? ''), '']);
    lines.push(['Total', '', ...meetings.map((m) => countOf(g, m)), '']);
  }
  return `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export default async function attendance(app) {
  // 13.0: Preach and Teach take attendance for a sermon or lesson linked to an event whose group meets then.
  app.get('/api/notes/:id/attendance', async (req) => {
    const noteId = intParam(req.params.id);
    const g = db.prepare(`SELECT g.* FROM att_groups g JOIN events e ON e.id = g.event_id
      WHERE g.archived = 0 AND (e.note_id = ? OR EXISTS (SELECT 1 FROM events x WHERE x.parent_id = e.id AND x.note_id = ?))
      ORDER BY g.id LIMIT 1`).get(noteId, noteId);
    if (!g) return { group: null };
    const t = today();
    const recent = eventDates(g.event_id, addDays(t, -7), addDays(t, 1));
    const next = eventDates(g.event_id, t, addDays(t, 60))[0];
    const date = recent.includes(t) ? t : recent.at(-1) ?? next ?? t;
    return { group: { id: g.id, name: g.name, mode: g.mode }, date };
  });

  app.get('/api/attendance', async () => {
    const groups = db.prepare('SELECT * FROM att_groups ORDER BY archived, name COLLATE NOCASE').all().map(summary);
    return { groups, nudges: groups.flatMap((g) => g.nudges), kinds: KINDS };
  });

  // Recurring events a group can follow.
  app.get('/api/attendance/events', async () => db.prepare(`SELECT id, title, start_at, rrule, location FROM events
    WHERE parent_id IS NULL AND rrule IS NOT NULL ORDER BY title COLLATE NOCASE`).all());

  app.post('/api/attendance/groups', async (req) => {
    const b = req.body ?? {};
    const kind = KINDS[b.kind] ? b.kind : 'group';
    const mode = MODES.includes(b.mode) ? b.mode : 'roster';
    const now = Date.now();
    const id = Number(db.prepare('INSERT INTO att_groups (name, kind, mode, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cleanName(b.name, 'name for the group'), kind, mode, checkEvent(b.event_id), now, now).lastInsertRowid);
    const names = Array.isArray(b.people) ? b.people : [];
    const add = db.prepare('INSERT INTO att_people (group_id, name, since, created_at) VALUES (?, ?, ?, ?)');
    tx(() => { for (const n of names.slice(0, 500)) { const s = String(n ?? '').trim(); if (s) add.run(id, s.slice(0, 120), b.since ? isoDate(b.since) : '0000-01-01', now); } });
    return { id };
  });

  app.get('/api/attendance/groups/:id', async (req) => detail(getGroup(intParam(req.params.id))));

  app.patch('/api/attendance/groups/:id', async (req) => {
    const g = getGroup(intParam(req.params.id));
    const b = req.body ?? {};
    const f = {};
    if ('name' in b) f.name = cleanName(b.name, 'name for the group');
    if ('kind' in b) { if (!KINDS[b.kind]) throw httpError(400, 'Unknown kind'); f.kind = b.kind; }
    if ('mode' in b) { if (!MODES.includes(b.mode)) throw httpError(400, 'Unknown mode'); f.mode = b.mode; }
    if ('event_id' in b) f.event_id = checkEvent(b.event_id);
    if ('archived' in b) f.archived = b.archived ? 1 : 0;
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE att_groups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), Date.now(), g.id);
    return { ok: true };
  });

  app.delete('/api/attendance/groups/:id', async (req) => {
    const g = getGroup(intParam(req.params.id));
    db.prepare('DELETE FROM att_groups WHERE id = ?').run(g.id);
    return { ok: true };
  });

  // ---- people ----
  app.post('/api/attendance/groups/:id/people', async (req) => {
    const g = getGroup(intParam(req.params.id));
    const b = req.body ?? {};
    const name = cleanName(b.name);
    const visitor = b.visitor ? 1 : 0;
    // A visitor joins from the meeting they came to (so the weeks before don't count against them).
    const since = b.date ? isoDate(b.date) : visitor ? today() : '0000-01-01';
    const id = Number(db.prepare('INSERT INTO att_people (group_id, name, visitor, since, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(g.id, name, visitor, since, Date.now()).lastInsertRowid);
    // Added at a meeting: they were there.
    if (b.date) {
      const m = upsertMeeting(g.id, since);
      db.prepare('INSERT OR IGNORE INTO att_marks (meeting_id, person_id) VALUES (?, ?)').run(m.id, id);
    }
    return { id };
  });

  app.patch('/api/attendance/people/:id', async (req) => {
    const p = getPerson(intParam(req.params.id));
    const b = req.body ?? {};
    const f = {};
    if ('name' in b) f.name = cleanName(b.name);
    if ('visitor' in b) f.visitor = b.visitor ? 1 : 0;
    if ('active' in b) f.active = b.active ? 1 : 0;
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE att_people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), p.id);
    return { ok: true };
  });

  app.delete('/api/attendance/people/:id', async (req) => {
    db.prepare('DELETE FROM att_people WHERE id = ?').run(getPerson(intParam(req.params.id)).id);
    return { ok: true };
  });

  // ---- meetings ----
  // Who was there, a headcount (others, on a roster group) and notes. `present` replaces the list when given.
  app.put('/api/attendance/groups/:id/meetings/:date', async (req) => {
    const g = getGroup(intParam(req.params.id));
    const date = isoDate(req.params.date);
    const b = req.body ?? {};
    tx(() => {
      const m = upsertMeeting(g.id, date);
      if ('headcount' in b) {
        const n = b.headcount === '' || b.headcount == null ? null : Number(b.headcount);
        if (n != null && (!Number.isInteger(n) || n < 0 || n > 100000)) throw httpError(400, 'Headcount must be a whole number');
        db.prepare('UPDATE att_meetings SET headcount = ? WHERE id = ?').run(n, m.id);
      }
      if ('notes' in b) db.prepare('UPDATE att_meetings SET notes = ? WHERE id = ?').run(String(b.notes ?? '').slice(0, 4000), m.id);
      if (Array.isArray(b.present)) {
        const ids = new Set(db.prepare('SELECT id FROM att_people WHERE group_id = ?').all(g.id).map((p) => p.id));
        db.prepare('DELETE FROM att_marks WHERE meeting_id = ?').run(m.id);
        const add = db.prepare('INSERT OR IGNORE INTO att_marks (meeting_id, person_id) VALUES (?, ?)');
        for (const pid of b.present) if (ids.has(Number(pid))) add.run(m.id, Number(pid));
      }
    });
    return { ok: true };
  });

  // One check-off: { person_id, present }.
  app.post('/api/attendance/groups/:id/meetings/:date/mark', async (req) => {
    const g = getGroup(intParam(req.params.id));
    const date = isoDate(req.params.date);
    const p = getPerson(intParam(req.body?.person_id));
    if (p.group_id !== g.id) throw httpError(400, 'Not in this group');
    const m = upsertMeeting(g.id, date);
    if (req.body?.present) db.prepare('INSERT OR IGNORE INTO att_marks (meeting_id, person_id) VALUES (?, ?)').run(m.id, p.id);
    else db.prepare('DELETE FROM att_marks WHERE meeting_id = ? AND person_id = ?').run(m.id, p.id);
    return { ok: true };
  });

  app.delete('/api/attendance/groups/:id/meetings/:date', async (req) => {
    const g = getGroup(intParam(req.params.id));
    db.prepare('DELETE FROM att_meetings WHERE group_id = ? AND date = ?').run(g.id, isoDate(req.params.date));
    return { ok: true };
  });

  app.get('/api/attendance/groups/:id/export.csv', async (req, reply) => {
    const g = getGroup(intParam(req.params.id));
    const file = `${g.name.replace(/[^\w\- ]+/g, '').trim() || 'attendance'} attendance.csv`;
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${file}"`);
    return `﻿${groupCsv(g)}`;
  });

  // ---- nudges ----
  // Follow up: a task to reach out (due today). The nudge goes away until they come back and then miss three in a row again.
  app.post('/api/attendance/people/:id/follow-up', async (req) => {
    const p = getPerson(intParam(req.params.id));
    const g = getGroup(p.group_id);
    const t = today();
    let task = null;
    if (req.body?.task !== false) {
      const { missed } = missedInRow(p, takenMeetings(g.id));
      const now = Date.now();
      const pos = (db.prepare('SELECT MAX(position) AS p FROM tasks').get().p ?? 0) + 1;
      task = Number(db.prepare(`INSERT INTO tasks (title, description, due_date, priority, position, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)`).run(`Follow up with ${p.name}`, `Missed ${missed} in a row at ${g.name}.`, t, pos, now, now).lastInsertRowid);
    }
    db.prepare('UPDATE att_people SET followup_at = ? WHERE id = ?').run(t, p.id);
    return { ok: true, task_id: task };
  });
}
