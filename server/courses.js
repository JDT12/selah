import { db, tx } from './db.js';
import { htmlToText } from './html.js';
import { addDays, toDate, today } from './recurrence.js';
import {
  getItem, getStudy, insertItem, itemsOf, linkNote, newNote, parseData, studyFields, studyRow, syncStudyTasks, syncTask, update,
} from './studies.js';
import { parse } from '../shared/scripture.js';

/**
 * Courses (5.12): a teaching study planned as a curriculum, after Richards and Bredfeldt's Creative Bible Teaching. A
 * course teaches a book (or a topic) over a quarter or two (13 or 26 weeks), one session a week on the class day, with
 * aims for the whole course (know, feel, do). The study's data.course holds the plan:
 *
 *   { type: 'book' | 'topic', book, from, to, topic, classDay (0 = Sunday), classTime ('09:30'), calendar (bool),
 *     skips: ['YYYY-MM-DD' class dates with no class], aims: { know, feel, do }, from_course (the course it was
 *     taught again from) }
 *
 * Each week is a session item (data.week = its number, in order) that starts empty and is built week by week, study
 * first: the week's Bible study (data.study_note), then its lesson (the item's note, in the lesson builder), then
 * teaching it (done) and the after-class notes (data.reflection). Dates follow the class day from the start date,
 * passing over skipped dates, so skipping a holiday moves the later weeks back a week.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const MAX_WEEKS = 60;

const weekday = (d) => toDate(d).getUTCDay();

/** The first `n` class dates: on `day` from `start` (inclusive), passing over `skips`. */
export function classDates(start, day, n, skips = []) {
  const out = [];
  if (!DATE_RE.test(start ?? '')) return out;
  let d = start;
  for (let guard = 0; guard < 7 && weekday(d) !== day; guard += 1) d = addDays(d, 1);
  for (let guard = 0; out.length < n && guard < 400; guard += 1, d = addDays(d, 7)) if (!skips.includes(d)) out.push(d);
  return out;
}

/** The course plan, tidied (from a request merged over what's saved). */
function courseFields(b = {}, cur = {}) {
  const c = { ...cur };
  if ('type' in b) c.type = b.type === 'topic' ? 'topic' : 'book';
  if ('book' in b) c.book = Number.isInteger(Number(b.book)) && b.book >= 1 && b.book <= 66 ? Number(b.book) : null;
  if ('from' in b) c.from = Math.max(1, Number(b.from) || 1);
  if ('to' in b) c.to = Math.max(1, Number(b.to) || 1);
  if ('topic' in b) c.topic = clip(b.topic, 200);
  if ('classDay' in b) c.classDay = Math.max(0, Math.min(6, Math.round(Number(b.classDay)) || 0));
  if ('classTime' in b) c.classTime = /^\d{2}:\d{2}$/.test(b.classTime ?? '') ? b.classTime : null;
  if ('calendar' in b) c.calendar = b.calendar !== false;
  if ('skips' in b) c.skips = [...new Set((Array.isArray(b.skips) ? b.skips : []).filter((d) => DATE_RE.test(d)))].sort().slice(0, 200);
  if ('aims' in b) c.aims = { know: clip(b.aims?.know, 2000), feel: clip(b.aims?.feel, 2000), do: clip(b.aims?.do, 2000) };
  if ('from_course' in b) c.from_course = b.from_course ? intParam(b.from_course) : null;
  c.skips ??= [];
  c.aims ??= { know: '', feel: '', do: '' };
  return c;
}

const sessionsOf = (studyId) => itemsOf(studyId).filter((i) => i.kind === 'session')
  .sort((a, b) => (a.data.week ?? 1e9) - (b.data.week ?? 1e9) || a.position - b.position || a.id - b.id);

function getCourse(id) {
  const s = getStudy(id);
  const data = parseData(s.data);
  if (!data.course) throw httpError(400, 'That study isn’t a course');
  return { s, data, course: courseFields({}, data.course) };
}

/** Numbers the weeks in order and dates them on the class day, then updates their calendar events. */
export function relayout(studyId) {
  const { s, course } = getCourse(studyId);
  const weeks = sessionsOf(studyId);
  const day = Number.isInteger(course.classDay) ? course.classDay : (s.start_date ? weekday(s.start_date) : 0);
  const dates = classDates(s.start_date, day, weeks.length, course.skips);
  weeks.forEach((w, i) => {
    const data = { ...w.data, week: i + 1 };
    db.prepare('UPDATE study_items SET data = ?, date = ?, position = ? WHERE id = ?').run(JSON.stringify(data), dates[i] ?? null, i + 1, w.id);
    syncTask(w.id);
  });
  const last = dates[weeks.length - 1] ?? null;
  db.prepare('UPDATE studies SET target_date = ?, updated_at = ? WHERE id = ?').run(last, Date.now(), studyId);
}

const alive = (noteId) => noteId && db.prepare('SELECT id, title, html, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);

/** H1 sections of a lesson note, by the Hook, Book, Look, Took they are. */
function lessonParts(html) {
  const out = {};
  const pieces = html.split(/<h1\b[^>]*>/i).slice(1);
  for (const p of pieces) {
    const end = p.search(/<\/h1>/i);
    const title = htmlToText(p.slice(0, end));
    const body = p.slice(end + 5);
    const key = /hook|^\s*introduction/i.test(title) ? 'hook' : /\bbook\b|exposition/i.test(title) ? 'book'
      : /\blook\b|inquisition|discussion/i.test(title) ? 'look' : /\btook\b|application/i.test(title) ? 'took' : null;
    if (key && !(key in out)) out[key] = body;
  }
  return out;
}
/** A paragraph that is only a link (the passage that closes the hook) isn't writing. */
const ownText = (html) => htmlToText(String(html ?? '').replace(/<p>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '')).trim();
const listText = (html) => [...String(html ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].some((m) => htmlToText(m[1]).trim());

/** What a week's lesson has: its took (for the aims), big idea, which steps are written, its learning levels. */
export function lessonSummary(note, lessonData = {}) {
  const parts = lessonParts(note.html);
  const text = htmlToText(note.html);
  const big = /big idea\s*:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? '';
  const took = ownText(parts.took);
  const written = { hook: !!ownText(parts.hook), book: listText(parts.book), look: listText(parts.look), took: !!took };
  return {
    note_id: note.id, title: note.title, updated_at: note.updated_at, big, took: took.slice(0, 600), written,
    complete: Object.values(written).every(Boolean), levels: lessonData.levels ?? null, minutes: lessonData.minutes ?? null,
  };
}

/** Studies of a passage you've already done (to use for a week), newest first. */
function studiesOn(ref, exclude = []) {
  const p = parse(ref ?? '');
  if (!p.refs.length || p.errors.length) return [];
  return db.prepare(`SELECT b.note_id, b.passage, b.refs, n.title FROM bible_studies b JOIN notes n ON n.id = b.note_id
    WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC`).all()
    .filter((b) => !exclude.includes(b.note_id) && parseData(b.refs).some((x) => p.refs.some((y) => x.start <= y.end && x.end >= y.start)))
    .slice(0, 3).map(({ refs, ...b }) => b);
}

/** One week as the course page shows it. */
function weekRow(w) {
  const study = alive(w.data.study_note);
  const bs = study ? db.prepare('SELECT passage, data FROM bible_studies WHERE note_id = ?').get(study.id) : null;
  const lesson = w.note_id && w.note_title !== null ? alive(w.note_id) : null;
  return {
    id: w.id, week: w.data.week, title: w.title, ref: w.ref, date: w.date, done: w.done, done_at: w.done_at,
    recap: !!w.data.recap,
    study: study ? { note_id: study.id, title: study.title, keeper: parseData(bs?.data).keeper ?? '', is_study: !!bs } : null,
    suggested: !study && !w.data.recap ? studiesOn(w.ref) : [],
    lesson: lesson ? lessonSummary(lesson, w.data.lesson) : null,
    reflection: w.data.reflection ?? null,
    previous: w.data.previous ?? null,
  };
}

function coursePayload(id) {
  const { s, data, course } = getCourse(id);
  const weeks = sessionsOf(id).map(weekRow);
  const t = today();
  const nextWeek = weeks.find((w) => !w.done && (!w.date || w.date >= t)) ?? weeks.find((w) => !w.done) ?? null;
  // The course's notes (lessons, studies and anything added), for the notes panel.
  const notes = db.prepare(`SELECT n.id, n.title, n.updated_at, substr(n.text, 1, 160) AS snippet, sn.role
    FROM study_notes sn JOIN notes n ON n.id = sn.note_id WHERE sn.study_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at`).all(s.id);
  return {
    ...studyRow(s), notes, course, classMinutes: data.classMinutes ?? 45, calendarCategory: data.calendarCategory ?? null,
    weeks, next: nextWeek?.id ?? null,
    notebook: s.notebook_id ? db.prepare('SELECT id, name FROM notebooks WHERE id = ?').get(s.notebook_id) ?? null : null,
    from_course: course.from_course ? db.prepare('SELECT id, title FROM studies WHERE id = ?').get(course.from_course) ?? null : null,
    taught_again: db.prepare("SELECT id, title FROM studies WHERE json_extract(data, '$.course.from_course') = ?").all(s.id),
  };
}

const weekFields = (w) => ({ title: clip(w?.title, 300) || clip(w?.ref, 200) || 'Untitled week', ref: clip(w?.ref, 200), recap: !!w?.recap });

/** The course's study, its weeks made, laid out and on the calendar. Returns its id. */
function createCourse(b) {
  const course = courseFields({ calendar: true, ...b.course });
  const f = studyFields({ kind: 'teaching', title: b.title, description: b.description ?? '', color: b.color ?? 'green', start_date: b.start_date });
  if (!f.start_date) throw httpError(400, 'Pick the first class date');
  if (!Number.isInteger(course.classDay)) course.classDay = weekday(f.start_date);
  const weeks = (Array.isArray(b.weeks) ? b.weeks : []).slice(0, MAX_WEEKS).map(weekFields);
  if (!weeks.length) throw httpError(400, 'A course needs at least one week');
  const minutes = Math.max(5, Math.min(600, Math.round(Number(b.classMinutes)) || 45));
  const now = Date.now();
  let notebookId = b.notebook_id ? intParam(b.notebook_id) : null;
  if (b.notebook === 'new') notebookId = Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run(f.title.slice(0, 200), now).lastInsertRowid);
  const category = b.calendarCategory ? intParam(b.calendarCategory) : null;
  const data = { inTasks: false, classMinutes: minutes, calendarCategory: category, course };
  const id = Number(db.prepare(`INSERT INTO studies (title, kind, status, description, color, notebook_id, start_date, data, created_at, updated_at)
    VALUES (?, 'teaching', 'active', ?, ?, ?, ?, ?, ?, ?)`).run(f.title, f.description, f.color ?? 'green', notebookId, f.start_date, JSON.stringify(data), now, now).lastInsertRowid);
  weeks.forEach((w, i) => insertItem(id, { kind: 'session', title: w.title, ref: w.ref, position: i + 1, data: { week: i + 1, ...(w.recap ? { recap: true } : {}) } }));
  return id;
}

export default async function courseRoutes(app) {
  /**
   * Body: { title, description?, color?, notebook: 'new' | notebook_id?, start_date, classMinutes?, calendarCategory?,
   * course: { type, book, from, to, topic, classDay, classTime, calendar, skips, aims }, weeks: [{ title, ref, recap? }] }.
   */
  app.post('/api/courses', async (req) => tx(() => {
    const id = createCourse(req.body ?? {});
    relayout(id);
    return { id };
  }));

  app.get('/api/courses/:id', async (req) => coursePayload(intParam(req.params.id)));

  /** Body: any of { title, description, color, notebook_id, start_date, classMinutes, calendarCategory, course: {…} }. */
  app.patch('/api/courses/:id', async (req) => {
    const { s, data, course } = getCourse(intParam(req.params.id));
    const b = req.body ?? {};
    return tx(() => {
      const f = studyFields(b, s);
      delete f.data;
      const next = { ...data, course: courseFields(b.course ?? {}, course) };
      if ('classMinutes' in b) next.classMinutes = Math.max(5, Math.min(600, Math.round(Number(b.classMinutes)) || 45));
      if ('calendarCategory' in b) next.calendarCategory = b.calendarCategory ? intParam(b.calendarCategory) : null;
      update('studies', s.id, { ...f, data: JSON.stringify(next), updated_at: Date.now() });
      if (f.title && s.list_id) db.prepare('UPDATE task_lists SET name = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM task_lists WHERE name = ? COLLATE NOCASE AND id != ?)').run(f.title.slice(0, 90), s.list_id, f.title.slice(0, 90), s.list_id);
      relayout(s.id);
      syncStudyTasks(s.id);
      return coursePayload(s.id);
    });
  });

  // Body: { date, skip }: no class on that date (a holiday), so that week and the ones after it move back a week.
  app.post('/api/courses/:id/skip', async (req) => {
    const { s, data, course } = getCourse(intParam(req.params.id));
    const date = String(req.body?.date ?? '');
    if (!DATE_RE.test(date)) throw httpError(400, 'Dates are YYYY-MM-DD');
    const skips = req.body?.skip === false ? course.skips.filter((d) => d !== date) : [...course.skips, date];
    return tx(() => {
      db.prepare('UPDATE studies SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, course: courseFields({ skips }, course) }), s.id);
      relayout(s.id);
      return coursePayload(s.id);
    });
  });

  // Body: { title?, ref?, recap?, before?: week id }: a new week, at the end or before another.
  app.post('/api/courses/:id/weeks', async (req) => {
    const { s } = getCourse(intParam(req.params.id));
    const b = req.body ?? {};
    const weeks = sessionsOf(s.id);
    if (weeks.length >= MAX_WEEKS) throw httpError(400, `A course has at most ${MAX_WEEKS} weeks`);
    return tx(() => {
      const at = b.before ? weeks.findIndex((w) => w.id === Number(b.before)) : -1;
      const w = weekFields({ title: b.title || 'New week', ref: b.ref, recap: b.recap });
      const id = insertItem(s.id, { kind: 'session', title: w.title, ref: w.ref, data: { week: 0, ...(w.recap ? { recap: true } : {}) } });
      const order = weeks.map((x) => x.id);
      order.splice(at < 0 ? order.length : at, 0, id);
      order.forEach((x, i) => {
        const row = db.prepare('SELECT data FROM study_items WHERE id = ?').get(x);
        db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(row.data), week: i + 1 }), x);
      });
      relayout(s.id);
      return { id, course: coursePayload(s.id) };
    });
  });

  // Body: { ids }: the weeks in this order (their passages and lessons move with them; the dates stay in place).
  app.post('/api/courses/:id/weeks/order', async (req) => {
    const { s } = getCourse(intParam(req.params.id));
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(intParam) : [];
    const have = new Set(sessionsOf(s.id).map((w) => w.id));
    if (ids.length !== have.size || !ids.every((x) => have.has(x))) throw httpError(400, 'Give every week once');
    return tx(() => {
      ids.forEach((x, i) => {
        const row = db.prepare('SELECT data FROM study_items WHERE id = ?').get(x);
        db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(row.data), week: i + 1 }), x);
      });
      relayout(s.id);
      return coursePayload(s.id);
    });
  });

  // A week goes (its notes stay); the weeks after it move up.
  app.delete('/api/course-weeks/:id', async (req) => {
    const w = getItem(intParam(req.params.id));
    return tx(() => {
      if (w.task_id) db.prepare('DELETE FROM tasks WHERE id = ?').run(w.task_id);
      db.prepare('DELETE FROM study_items WHERE id = ?').run(w.id);
      relayout(w.study_id);
      return coursePayload(w.study_id);
    });
  });

  // Body: { note_id } (a Bible study) or { note_id: null }: the study this week's lesson comes from.
  app.put('/api/course-weeks/:id/study', async (req) => {
    const w = getItem(intParam(req.params.id));
    const noteId = req.body?.note_id ? intParam(req.body.note_id) : null;
    if (noteId && !db.prepare('SELECT 1 FROM bible_studies b JOIN notes n ON n.id = b.note_id WHERE b.note_id = ? AND n.deleted_at IS NULL').get(noteId)) {
      throw httpError(400, 'Pick one of your Bible studies');
    }
    return tx(() => {
      const data = { ...w.data };
      if (noteId) {
        data.study_note = noteId;
        linkNote(w.study_id, noteId, 'bible-study');
        const bs = db.prepare('SELECT id, data FROM bible_studies WHERE note_id = ?').get(noteId);
        db.prepare('UPDATE bible_studies SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(bs.data), course_item: w.id }), bs.id);
      } else {
        delete data.study_note;
      }
      db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify(data), w.id);
      syncTask(w.id);
      return weekRow(getItem(w.id));
    });
  });

  // Body: { worked, change, reached: 'yes' | 'partly' | 'no' | '', notes }: after-class notes (all empty: none).
  app.put('/api/course-weeks/:id/reflection', async (req) => {
    const w = getItem(intParam(req.params.id));
    const b = req.body ?? {};
    const r = { worked: clip(b.worked, 5000), change: clip(b.change, 5000), reached: ['yes', 'partly', 'no'].includes(b.reached) ? b.reached : '', notes: clip(b.notes, 5000) };
    const empty = !r.worked && !r.change && !r.reached && !r.notes;
    const data = { ...w.data };
    if (empty) delete data.reflection;
    else data.reflection = { ...r, at: Date.now() };
    db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify(data), w.id);
    return weekRow(getItem(w.id));
  });

  /**
   * Teach it again: a new course on a new start date with the same plan, aims and weeks. Each lesson is copied as
   * a draft for the new course (the old one stays as you taught it), each week keeps its study, and last time's
   * date and after-class notes travel with it. Body: { title, start_date, classDay?, finishOld? }.
   */
  app.post('/api/courses/:id/teach-again', async (req) => {
    const { s, data, course } = getCourse(intParam(req.params.id));
    const b = req.body ?? {};
    const f = studyFields({ title: b.title || s.title, start_date: b.start_date });
    if (!f.start_date) throw httpError(400, 'Pick the first class date');
    return tx(() => {
      const now = Date.now();
      const classDay = 'classDay' in b ? Math.max(0, Math.min(6, Number(b.classDay) || 0)) : course.classDay;
      const next = { ...data, course: { ...course, skips: [], from_course: s.id, classDay } };
      const id = Number(db.prepare(`INSERT INTO studies (title, kind, status, description, color, notebook_id, start_date, data, created_at, updated_at)
        VALUES (?, 'teaching', 'active', ?, ?, ?, ?, ?, ?, ?)`).run(f.title, s.description, s.color, s.notebook_id, f.start_date, JSON.stringify(next), now, now).lastInsertRowid);
      sessionsOf(s.id).forEach((w, i) => {
        const lesson = w.note_id && w.note_title !== null ? alive(w.note_id) : null;
        const { step, ...lessonData } = w.data.lesson ?? {};
        const wd = {
          week: i + 1,
          ...(w.data.recap ? { recap: true } : {}),
          ...(alive(w.data.study_note) ? { study_note: w.data.study_note } : {}),
          ...(Object.keys(lessonData).length ? { lesson: lessonData } : {}),
          previous: { item_id: w.id, study_id: s.id, course: s.title, date: w.date, taught: w.done, note_id: lesson?.id ?? null, reflection: w.data.reflection ?? null },
        };
        let noteId = null;
        if (lesson) {
          noteId = newNote(s.notebook_id, lesson.title, lesson.html);
          linkNote(id, noteId, 'lesson');
        }
        if (wd.study_note) linkNote(id, wd.study_note, 'bible-study');
        insertItem(id, { kind: 'session', title: w.title, ref: w.ref, note_id: noteId, position: i + 1, data: wd });
      });
      if (b.finishOld) {
        db.prepare("UPDATE studies SET status = 'done', updated_at = ? WHERE id = ?").run(now, s.id);
        syncStudyTasks(s.id);
      }
      relayout(id);
      return { id };
    });
  });

  // Everything for the teacher's guide: the plan, the aims and each week's lesson.
  app.get('/api/courses/:id/guide', async (req) => {
    const p = coursePayload(intParam(req.params.id));
    const lessons = new Map(p.weeks.filter((w) => w.lesson).map((w) => [w.id, alive(w.lesson.note_id)?.html ?? '']));
    return { ...p, weeks: p.weeks.map((w) => ({ ...w, html: lessons.get(w.id) ?? null })) };
  });
}
