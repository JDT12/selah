import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { escapeHtml, htmlToText } from './html.js';
import { addMinutes, fmtDateTime, toDate, today } from './recurrence.js';
import { defaultCategory } from './categories.js';
import { fillPlaceholders } from './routes.js';
import { snapshot } from './links.js';
import { logosUrl, parse } from '../shared/scripture.js';
import { safeFetch } from './netguard.js';
import { classGrade } from '../shared/grades.js';
import { cornellHtml } from '../shared/cornell.js';
import { skeletonHtml, validMethod } from '../shared/methods.js';
import { recordMethod } from './methods.js';

/**
 * Studies: something you work through over weeks (a self-study, a series you teach, a writing project, a class).
 *
 * A study has items: readings, teaching sessions, assignments and milestones, each with an optional date and a
 * linked note. A dated item gets a task (in a task list named after the study) so it shows in Tasks, on the
 * Calendar and on the Dashboard; ticking either one ticks the other, because a dated item's "done" is its task's.
 * Notes belong to a study through study_notes (a note can be in a study and any notebook).
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v) => {
  if (v == null || v === '') return null;
  if (!DATE_RE.test(String(v))) throw httpError(400, 'Dates are YYYY-MM-DD');
  return String(v);
};
export const KINDS = ['self', 'teaching', 'writing', 'class', 'preaching'];
const ITEM_KINDS = ['reading', 'session', 'assignment', 'milestone'];
const STATUSES = ['active', 'done', 'archived'];
const COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'gray'];

db.exec(`
CREATE TABLE IF NOT EXISTS studies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
  list_id INTEGER REFERENCES task_lists(id) ON DELETE SET NULL,
  start_date TEXT,
  target_date TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS study_items (
  id INTEGER PRIMARY KEY,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  date TEXT,
  done_at INTEGER,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  task_id INTEGER,
  position REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS study_items_study ON study_items(study_id, position);
CREATE TABLE IF NOT EXISTS study_notes (
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'note',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (study_id, note_id)
);`);

// 5.2: a Writing project's chapters are its notes with role 'chapter', in order, each with a draft status and an
// optional word goal; writing_log keeps each day's word total, for "words today".
// 6.6: a piece can be front or back matter (a book's preface, its bibliography), and keeps its stage checklist.
for (const [col, def] of [['position', 'REAL'], ['status', 'TEXT'], ['goal', 'INTEGER'], ['matter', 'TEXT'], ['checks', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(study_notes)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE study_notes ADD COLUMN ${col} ${def}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS writing_log (
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  words INTEGER NOT NULL,
  PRIMARY KEY (study_id, date)
)`);
// The stages a piece moves through (6.6 added idea, research and edited; 'revised' reads as Revise).
export const CHAPTER_STATUSES = ['idea', 'research', 'outline', 'draft', 'revised', 'edited', 'final'];
const MATTERS = ['front', 'back'];

// 5.12: a course's class days are calendar events, one per week, tied to the week's schedule item.
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'study_item_id')) {
  db.exec('ALTER TABLE events ADD COLUMN study_item_id INTEGER REFERENCES study_items(id) ON DELETE CASCADE');
}

export const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

/** Words in a note, leaving out citation marks. */
export const wordCount = (html) => htmlToText(html.replace(/<sup\b[^>]*class="citation"[^>]*>[\s\S]*?<\/sup>/gi, ' ')).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** A project's chapters in order, with words and WordPress status. */
export function chaptersOf(studyId) {
  return db.prepare(`SELECT n.id, n.title, n.html, n.updated_at, sn.position, sn.status, sn.goal, sn.matter, sn.checks, p.status AS wp_status, p.link AS wp_link
    FROM study_notes sn JOIN notes n ON n.id = sn.note_id
    LEFT JOIN wp_posts p ON p.note_id = n.id AND p.status NOT IN ('trash', 'deleted')
    WHERE sn.study_id = ? AND sn.role = 'chapter' AND n.deleted_at IS NULL
    ORDER BY sn.position, sn.added_at`).all(studyId)
    .map(({ html, checks, ...c }) => ({ ...c, status: c.status ?? 'outline', checks: parseData(checks), words: wordCount(html) }));
}

/** Today's word total for a project (kept per day), and how many of them were written today. */
function writingProgress(studyId, chapters) {
  const total = chapters.reduce((n, c) => n + c.words, 0);
  const t = today();
  const before = db.prepare('SELECT words FROM writing_log WHERE study_id = ? AND date < ? ORDER BY date DESC LIMIT 1').get(studyId, t);
  db.prepare(`INSERT INTO writing_log (study_id, date, words) VALUES (?, ?, ?)
    ON CONFLICT(study_id, date) DO UPDATE SET words = excluded.words`).run(studyId, t, total);
  const days = db.prepare('SELECT date, words FROM writing_log WHERE study_id = ? ORDER BY date DESC LIMIT 15').all(studyId).reverse();
  // Words written each day: the change from the day before (a day of cutting counts as 0).
  const perDay = days.slice(1).map((d, i) => ({ date: d.date, words: Math.max(0, d.words - days[i].words) }));
  return { total, today: before ? Math.max(0, total - before.words) : total, perDay };
}

// ---------- items and their tasks ----------

const ITEM_SELECT = `
  SELECT i.*, t.completed_at AS task_done, t.id AS live_task, n.title AS note_title,
    EXISTS (SELECT 1 FROM bible_studies b WHERE b.note_id = i.note_id) AS bible_study,
    (SELECT COALESCE(m.method, 'ggw') FROM bible_studies b LEFT JOIN note_methods m ON m.note_id = b.note_id WHERE b.note_id = i.note_id) AS study_method,
    (n.html LIKE '%hook%' AND n.html LIKE '%took%') AS lesson_builder
  FROM study_items i
  LEFT JOIN tasks t ON t.id = i.task_id
  LEFT JOIN notes n ON n.id = i.note_id AND n.deleted_at IS NULL`;

function itemRow(r) {
  const { task_done, live_task, data, ...i } = r;
  const done = live_task ? task_done : i.done_at;
  return { ...i, task_id: live_task ?? null, done_at: done ?? null, done: !!done, data: parseData(data), note_title: r.note_title ?? null, bible_study: !!i.bible_study, lesson_builder: !!i.lesson_builder };
}
export const itemsOf = (studyId) => db.prepare(`${ITEM_SELECT} WHERE i.study_id = ? ORDER BY (i.date IS NULL), i.date, i.position, i.id`).all(studyId).map(itemRow);
export function getItem(id) {
  const r = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id);
  if (!r) throw httpError(404, 'Item not found');
  return itemRow(r);
}

/** The task list for a study's dated items: one named after the study (made when first needed). */
function studyList(study) {
  if (study.list_id && db.prepare('SELECT 1 FROM task_lists WHERE id = ?').get(study.list_id)) return study.list_id;
  let name = study.title.slice(0, 90);
  const clash = db.prepare('SELECT id FROM task_lists WHERE name = ? COLLATE NOCASE').get(name);
  if (clash) {
    // A list with that name already exists: use it if no other study does, else make "Name (study)".
    const usedBy = db.prepare('SELECT 1 FROM studies WHERE list_id = ? AND id != ?').get(clash.id, study.id);
    if (!usedBy) {
      db.prepare('UPDATE studies SET list_id = ? WHERE id = ?').run(clash.id, study.id);
      return clash.id;
    }
    name = `${name} (study)`;
  }
  const position = (db.prepare('SELECT MAX(position) AS p FROM task_lists').get().p ?? 0) + 1;
  const id = Number(db.prepare('INSERT INTO task_lists (name, color, position, created_at) VALUES (?, ?, ?, ?)')
    .run(name, study.color ?? 'blue', position, Date.now()).lastInsertRowid);
  db.prepare('UPDATE studies SET list_id = ? WHERE id = ?').run(id, study.id);
  return id;
}

/**
 * A course week's class on the calendar: an event on its date at the class time (all day without one), lasting the
 * class length, linked to the lesson (or the week's study until there is one). Gone when the week has no date, the
 * course isn't under way, or the course is kept off the calendar.
 */
function syncCourseEvent(item, study) {
  const sd = parseData(study.data);
  // 5.15: an in-person class's lectures go on the calendar the same way, at its meeting time.
  const lecture = study.kind === 'class' && item.kind === 'session' ? (sd.syllabus ?? {}) : null;
  const course = lecture ? { calendar: lecture.format === 'in-person' && lecture.calendar !== false, classTime: lecture.meetTime } : sd.course;
  const existing = db.prepare('SELECT id FROM events WHERE study_item_id = ?').get(item.id);
  const data = parseData(item.data);
  if (!course || course.calendar === false || study.status !== 'active' || !item.date) {
    if (existing) db.prepare('DELETE FROM events WHERE id = ?').run(existing.id);
    return;
  }
  const time = /^\d{2}:\d{2}$/.test(course.classTime ?? '') ? course.classTime : null;
  const start = time ? `${item.date}T${time}` : item.date;
  let end = item.date;
  if (time) {
    const e = fmtDateTime(addMinutes(toDate(start), Math.max(5, Number(lecture ? lecture.meetMinutes : sd.classMinutes) || (lecture ? 90 : 45))));
    end = e.slice(0, 10) === item.date ? e : `${item.date}T23:59`;
  }
  const noteId = [item.note_id, data.study_note].find((id) => id && db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(id)) ?? null;
  const category = sd.calendarCategory && db.prepare('SELECT 1 FROM event_categories WHERE id = ?').get(sd.calendarCategory) ? sd.calendarCategory : defaultCategory();
  const color = (category && db.prepare('SELECT color FROM event_categories WHERE id = ?').get(category)?.color) || 'gray';
  const title = lecture ? `${lecture.code || study.title}: ${item.title}`.slice(0, 500)
    : `${study.title}: ${data.week ? `Week ${data.week}, ` : ''}${item.title}`.slice(0, 500);
  const description = lecture ? `A class meeting of “${study.title}”${lecture.location ? ` (${lecture.location})` : ''}.`
    : `Week ${data.week ?? '?'} of the course “${study.title}”${item.ref && !item.title.includes(item.ref) ? ` (${item.ref})` : ''}.`;
  const now = Date.now();
  if (existing) {
    db.prepare(`UPDATE events SET title = ?, description = ?, all_day = ?, start_at = ?, end_at = ?, note_id = ?, category_id = ?, color = ?, updated_at = ?
      WHERE id = ?`).run(title, description, time ? 0 : 1, start, end, noteId, category, color, now, existing.id);
  } else {
    db.prepare(`INSERT INTO events (title, description, location, color, all_day, start_at, end_at, exdates, note_id, category_id, study_item_id, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`).run(title, description, color, time ? 0 : 1, start, end, noteId, category, item.id, now, now);
  }
}

/** Makes the item's task (and, in a course, its class on the calendar) match it. */
export function syncTask(itemId) {
  const item = db.prepare('SELECT * FROM study_items WHERE id = ?').get(itemId);
  if (!item) return;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(item.study_id);
  syncCourseEvent(item, study);
  // A class's lectures aren't tasks (in person they're on the calendar; online, the week's readings and work are).
  const want = !!item.date && study.status === 'active' && parseData(study.data).inTasks !== false && !(study.kind === 'class' && item.kind === 'session');
  const task = item.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.task_id) : null;
  const now = Date.now();
  if (!want) {
    if (task) {
      // Keep whether it was done before the task goes away.
      db.prepare('UPDATE study_items SET done_at = ?, task_id = NULL WHERE id = ?').run(task.completed_at, item.id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    } else if (item.task_id) {
      db.prepare('UPDATE study_items SET task_id = NULL WHERE id = ?').run(item.id);
    }
    return;
  }
  const title = item.ref && !item.title.includes(item.ref) ? `${item.title} (${item.ref})` : item.title;
  if (task) {
    db.prepare('UPDATE tasks SET title = ?, due_date = ?, note_id = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 500), item.date, item.note_id, now, task.id);
    return;
  }
  const listId = studyList(study);
  const position = (db.prepare('SELECT MAX(position) AS p FROM tasks').get().p ?? 0) + 1;
  const taskId = Number(db.prepare(`INSERT INTO tasks (title, description, due_date, priority, note_id, list_id, position, steps, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, '[]', ?, ?, ?)`).run(title.slice(0, 500), `From the study “${study.title}”`, item.date, item.note_id, listId, position, item.done_at, now, now).lastInsertRowid);
  db.prepare('UPDATE study_items SET task_id = ? WHERE id = ?').run(taskId, item.id);
}
export const syncStudyTasks = (studyId) => {
  for (const { id } of db.prepare('SELECT id FROM study_items WHERE study_id = ?').all(studyId)) syncTask(id);
};

export function insertItem(studyId, f) {
  const position = f.position ?? (db.prepare('SELECT MAX(position) AS p FROM study_items WHERE study_id = ?').get(studyId).p ?? 0) + 1;
  const id = Number(db.prepare(`INSERT INTO study_items (study_id, kind, title, ref, date, note_id, position, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(studyId, f.kind, f.title, f.ref ?? '', f.date ?? null, f.note_id ?? null, position,
    typeof f.data === 'string' ? f.data : JSON.stringify(f.data ?? {}), Date.now()).lastInsertRowid); // itemFields gives it as JSON
  syncTask(id);
  return id;
}

export function itemFields(b, cur = {}) {
  const f = {};
  if ('kind' in b) {
    if (!ITEM_KINDS.includes(b.kind)) throw httpError(400, 'Unknown kind of item');
    f.kind = b.kind;
  }
  if ('title' in b) {
    f.title = String(b.title ?? '').trim().slice(0, 300);
    if (!f.title) throw httpError(400, 'Give it a title');
  }
  if ('ref' in b) f.ref = String(b.ref ?? '').trim().slice(0, 200);
  if ('date' in b) f.date = dateOrNull(b.date);
  if ('note_id' in b) f.note_id = b.note_id ? intParam(b.note_id) : null;
  if ('data' in b) f.data = JSON.stringify({ ...cur.data, ...(b.data ?? {}) });
  return f;
}

// ---------- studies ----------

export function studyRow(s) {
  const items = itemsOf(s.id);
  const t = today();
  const open = items.filter((i) => !i.done);
  const behind = open.filter((i) => i.date && i.date < t).length;
  const next = open.find((i) => i.date && i.date >= t) ?? open.find((i) => !i.date) ?? null;
  // Pace toward the target date: what's left, per week.
  let perWeek = null;
  if (s.target_date && open.length) {
    const days = (Date.parse(`${s.target_date}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000 + 1;
    perWeek = days > 0 ? Math.round((open.length / days) * 7 * 10) / 10 : null;
  }
  const notes = db.prepare('SELECT COUNT(*) AS n FROM study_notes sn JOIN notes n ON n.id = sn.note_id WHERE sn.study_id = ? AND n.deleted_at IS NULL').get(s.id).n;
  const data = parseData(s.data);
  // A class's card shows its grade so far and the next thing due (lectures aside).
  let grade;
  let due;
  if (s.kind === 'class') {
    const g = classGrade(data.grades ?? [], items, data.scale);
    grade = { percent: g.percent, letter: g.letter };
    due = open.find((i) => i.kind !== 'session' && i.date && i.date >= t) ?? null;
  }
  return {
    ...s, data,
    progress: { total: items.length, done: items.length - open.length, behind, perWeek, next },
    notes, ...(grade ? { grade, due } : {}),
  };
}
export function getStudy(id) {
  const s = db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!s) throw httpError(404, 'Study not found');
  return s;
}

export function studyFields(b, cur = {}) {
  const f = {};
  if ('title' in b) {
    f.title = String(b.title ?? '').trim().slice(0, 200);
    if (!f.title) throw httpError(400, 'Give the study a title');
  }
  if ('kind' in b) {
    if (!KINDS.includes(b.kind)) throw httpError(400, 'Unknown kind of study');
    f.kind = b.kind;
  }
  if ('status' in b) {
    if (!STATUSES.includes(b.status)) throw httpError(400, 'Unknown status');
    f.status = b.status;
  }
  if ('description' in b) f.description = String(b.description ?? '').slice(0, 5000);
  if ('color' in b) f.color = COLORS.includes(b.color) ? b.color : null;
  if ('start_date' in b) f.start_date = dateOrNull(b.start_date);
  if ('target_date' in b) f.target_date = dateOrNull(b.target_date);
  if ('notebook_id' in b) f.notebook_id = b.notebook_id ? intParam(b.notebook_id) : null;
  if ('data' in b) {
    const l = b.data?.lessonLayout;
    if (l !== undefined && l !== null && !LESSON_LAYOUTS.includes(l) && !Number.isInteger(l)) throw httpError(400, 'Unknown lesson layout');
    // A series' method for its sermons or studies (6.5); null leaves it to you.
    for (const [w, m] of Object.entries(b.data?.methods ?? {})) {
      if (m !== null && !validMethod(w, m)) throw httpError(400, 'Unknown method');
    }
    f.data = JSON.stringify({ ...parseData(cur.data), ...(b.data ?? {}) });
  }
  return f;
}
/** A project's chapters at whole-number positions again, in their order (after a piece was slotted between two). */
function renumber(studyId) {
  db.prepare("SELECT note_id FROM study_notes WHERE study_id = ? AND role = 'chapter' ORDER BY position, added_at").all(studyId)
    .forEach((r, i) => db.prepare('UPDATE study_notes SET position = ? WHERE study_id = ? AND note_id = ?').run(i + 1, studyId, r.note_id));
}

export const update = (table, id, f) => {
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
};

/**
 * The study's notebook, with its shelf and whether it's the study's own: every note in it belongs to the study (a
 * class whose notes sit in your main notebook doesn't own that notebook, so it isn't moved to the Seminary shelf).
 */
export function studyNotebook(s) {
  const nb = db.prepare('SELECT nb.id, nb.name, st.name AS shelf FROM notebooks nb LEFT JOIN stacks st ON st.id = nb.stack_id WHERE nb.id = ?').get(s.notebook_id);
  if (!nb) return null;
  const others = db.prepare(`SELECT 1 FROM notes n WHERE n.notebook_id = ? AND n.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM study_notes sn WHERE sn.note_id = n.id AND sn.study_id = ?) LIMIT 1`).get(nb.id, s.id);
  return { ...nb, own: !others };
}

/** Puts a notebook on the Seminary shelf (made the first time). */
export function shelve(notebookId) {
  const shelf = db.prepare("SELECT id FROM stacks WHERE name = 'Seminary' COLLATE NOCASE").get()?.id
    ?? Number(db.prepare("INSERT INTO stacks (name, created_at) VALUES ('Seminary', ?)").run(Date.now()).lastInsertRowid);
  db.prepare('UPDATE notebooks SET stack_id = ? WHERE id = ?').run(shelf, notebookId);
  return shelf;
}

export function linkNote(studyId, noteId, role = 'note') {
  db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(study_id, note_id) DO UPDATE SET role = excluded.role`).run(studyId, noteId, role, Date.now());
}

export function newNote(notebookId, title, html, createdAt = Date.now()) {
  const nb = notebookId && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId) ? notebookId
    : db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get().id;
  return Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nb, title.slice(0, 500), html, htmlToText(html), createdAt, Date.now()).lastInsertRowid);
}

// ---------- lesson notes ----------

export const LESSON_LAYOUTS = ['hblt', 'points'];
/** A lesson method from a request: a built-in one, or one of your templates (a note id); null when none was picked. */
export const lessonMethod = (v) => (validMethod('lesson', v) ? v : Number.isInteger(v) && v > 0 ? v : null);

/** The session's passage as a Logos link (ESV), or its plain text when it isn't a Bible reference. */
function passageHtml(ref) {
  const r = parse(ref).refs[0];
  return r ? `<a target="_blank" rel="noreferrer" href="${escapeHtml(logosUrl(r, 'esv'))}">${escapeHtml(ref)}</a>` : escapeHtml(ref);
}

/**
 * A lesson note for a teaching session, laid out for the lesson builder, present mode and handouts. The study's
 * lessonLayout picks it: 'hblt' (Hook, Book, Look, Took: the default), 'points' (big idea and three points), or the
 * id of one of your templates, where {{passage}}, {{lesson}} and {{study}} fill in too. A method picked when the lesson
 * was started (6.5) comes before the study's.
 */
export function lessonHtml(item, study, method = null) {
  const layout = method ?? parseData(study.data).lessonLayout ?? 'hblt';
  const ref = item.ref ? escapeHtml(item.ref) : '';
  if (Number.isInteger(layout)) {
    const t = db.prepare('SELECT html FROM notes WHERE id = ? AND is_template = 1 AND deleted_at IS NULL').get(layout);
    if (t) {
      const values = { passage: item.ref ? passageHtml(item.ref) : '', lesson: escapeHtml(item.title), study: escapeHtml(study.title) };
      return fillPlaceholders(t.html).replace(/\{\{\s*(passage|lesson|study)\s*\}\}/gi, (_, k) => values[k.toLowerCase()]);
    }
  }
  if (layout !== 'points') {
    return [
      `<p><strong>Title: ${escapeHtml(item.title)}</strong></p>`,
      ref ? `<p><strong>Verses: </strong>${passageHtml(item.ref)}</p>` : '<p><strong>Verses: </strong></p>',
      // The passage closes the hook, so present mode shows its text before the exposition.
      `<h1>Introduction (Hook)</h1><p></p>${ref ? `<p>${passageHtml(item.ref)}</p>` : ''}`,
      '<h1>Exposition (Book)</h1><ol><li><p></p></li></ol>',
      '<h1>Inquisition (Look)</h1><ol><li><p></p></li></ol>',
      '<h1>Application (Took)</h1><p></p>',
    ].join('');
  }
  return [
    `<p><em>${escapeHtml(study.title)}${item.date ? ` · ${item.date}` : ''}${ref ? ` · ${ref}` : ''}</em></p>`,
    '<h2>Big idea</h2><p></p>',
    `<h2>Text</h2><p>${ref}</p>`,
    '<h2>Introduction</h2><p></p>',
    '<h2>1. First point</h2><ul><li><p></p></li></ul>',
    '<h2>2. Second point</h2><ul><li><p></p></li></ul>',
    '<h2>3. Third point</h2><ul><li><p></p></li></ul>',
    '<h2>Application</h2><ul><li><p></p></li></ul>',
    '<h2>Discussion questions</h2><ol><li><p></p></li></ol>',
  ].join('');
}

/** A class's lecture notes: Cornell notes (the default) with the topic, date, class and professor filled in, or plain. */
export function lectureHtml(item, study) {
  const d = parseData(study.data);
  const syl = d.syllabus ?? {};
  const date = item.date ? new Date(`${item.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const course = [syl.code, study.title].filter(Boolean).join(': ');
  if (d.lectureLayout === 'plain') {
    return `<p><em>${escapeHtml([course, date, syl.professor].filter(Boolean).join(' · '))}</em></p><h2>Notes</h2><p></p><h2>Questions</h2><p></p>`;
  }
  return cornellHtml(date, { topic: item.title, course, speaker: syl.professor ?? '' });
}

// ---------- Canvas (or any) calendar feed for a class ----------

function unfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}
function icsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v ?? '');
  if (!m) return null;
  if (m[4] && m[7]) {
    // A UTC moment: the date in your time zone (an 11:59 PM deadline stays on its day).
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const icsText = (s) => String(s ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** Fetches a class's calendar feed and adds or updates its assignments. */
async function syncFeed(study) {
  const data = parseData(study.data);
  const url = String(data.feedUrl ?? '').replace(/^webcal:/i, 'https:');
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Add the calendar feed link first.');
  let res;
  try {
    res = await safeFetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  } catch {
    throw httpError(502, 'Couldn’t reach the calendar feed.');
  }
  if (!res.ok) throw httpError(502, `The calendar feed answered ${res.status}.`);
  const lines = unfold(await res.text());
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur?.uid && cur.summary) events.push(cur); cur = null; } else if (cur) {
      const i = line.indexOf(':');
      const key = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1);
      if (key === 'UID') cur.uid = val;
      if (key === 'SUMMARY') cur.summary = icsText(val);
      if (key === 'DTSTART') cur.date = icsDate(val);
      if (key === 'URL') cur.url = val;
    }
  }
  const prefix = data.feedFilter ? String(data.feedFilter).toLowerCase() : '';
  let added = 0;
  let updated = 0;
  tx(() => {
    const existing = new Map(db.prepare("SELECT id, data FROM study_items WHERE study_id = ? AND kind = 'assignment'").all(study.id)
      .map((r) => [parseData(r.data).uid, r.id]));
    for (const e of events) {
      // Canvas puts the course in brackets after the title: "Paper 1 [OBST 520]". A filter keeps just one course.
      if (prefix && !e.summary.toLowerCase().includes(prefix)) continue;
      const title = e.summary.replace(/\s*\[[^\]]+\]\s*$/, '').slice(0, 300);
      const id = existing.get(e.uid);
      if (id) {
        db.prepare('UPDATE study_items SET title = ?, date = ? WHERE id = ?').run(title, e.date, id);
        syncTask(id);
        updated += 1;
      } else {
        insertItem(study.id, { kind: 'assignment', title, date: e.date, data: { uid: e.uid, url: e.url ?? null } });
        added += 1;
      }
    }
    db.prepare('UPDATE studies SET data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...data, feedSyncedAt: Date.now() }), Date.now(), study.id);
  });
  return { added, updated, total: events.length };
}

// ---------- bringing in an old class note ----------

const headingsOf = (html) => [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
  .map((m) => ({ at: m.index, end: m.index + m[0].length, level: +m[1], text: htmlToText(m[2]).trim() }));
const hasContent = (html) => !!htmlToText(html).trim() || /<img\b|data-attachment=/i.test(html);

/** Stand-ins an exporting app leaves for blocks it can't export ("Content not supported", "This block is a placeholder…"). */
const EXPORT_STUB = /<p>\s*(?:Content not supported|This block is a placeholder for [^<]*)\s*<\/p>/gi;
export const stripExportStubs = (html) => html.replace(EXPORT_STUB, '');

/**
 * Weekly checklists in a class note: a "Week N" heading over sub-headings (Watch, Read, Apply…) and task lists.
 * Returns [{ start, end, week, items: [{ part, title, done }] }]; a "Week" heading without checkboxes isn't one.
 */
export function weekBlocks(html) {
  const hs = headingsOf(html);
  const blocks = [];
  hs.forEach((h, i) => {
    const m = /\bweek\s+(\d{1,2})\b/i.exec(h.text);
    if (!m || blocks.some((b) => h.at < b.end)) return;
    const end = hs.slice(i + 1).find((x) => x.level <= h.level)?.at ?? html.length;
    const subs = hs.filter((x) => x.at > h.at && x.at < end);
    const items = [];
    for (const t of html.slice(h.end, end).matchAll(/<li\b([^>]*data-type="taskItem"[^>]*)>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const at = h.end + t.index;
      const title = htmlToText(t[2]).trim();
      if (!title) continue;
      const part = subs.filter((x) => x.at < at).pop()?.text ?? '';
      items.push({ part, title, done: /data-checked="true"/i.test(t[1]) });
    }
    if (items.length) blocks.push({ start: h.at, end, week: Number(m[1]), items });
  });
  return blocks;
}
export const withoutWeeks = (html, blocks = weekBlocks(html)) =>
  [...blocks].reverse().reduce((out, b) => out.slice(0, b.start) + out.slice(b.end), html);

/** Watching and reading are readings; anything else (papers, quizzes, discussion threads) is an assignment. */
const partKind = (part) => (/watch|read|listen|explore|view/i.test(part) ? 'reading' : 'assignment');

/** Trims the empty paragraphs and dividers an export leaves at the edges of a section. */
const trimEdges = (html) => {
  const edge = '(?:\\s|<p>(?:\\s|<br\\s*/?>|<(u|em|strong)>(?:\\s|<br\\s*/?>)*</\\1>)*</p>|<hr\\s*/?>)*';
  return html.replace(new RegExp(`^${edge}`), '').replace(new RegExp(`${edge}$`), '');
};

/**
 * Sections of a note's HTML, cut before each heading of `level` or higher (h1..hN). Sections with nothing under
 * their heading are left out.
 */
export function splitSections(html, level) {
  const cuts = headingsOf(html).filter((h) => h.level <= level).map((h) => ({ at: h.at, end: h.end, title: h.text || 'Untitled' }));
  const sections = [];
  const intro = trimEdges(html.slice(0, cuts[0]?.at ?? html.length));
  if (hasContent(intro)) sections.push({ title: null, html: intro });
  cuts.forEach((c, i) => {
    const end = cuts[i + 1]?.at ?? html.length;
    if (!hasContent(html.slice(c.end, end))) return;
    sections.push({ title: c.title, html: trimEdges(html.slice(c.at, end)) });
  });
  return sections;
}

/** "OBST 680" from "OBST 680: NT Development of OT Themes", to name the notes a class splits into. */
const courseCode = (title) => /^\s*([A-Z]{2,5}\s?\d{3}[A-Z]?)\b/.exec(title ?? '')?.[1] ?? null;
const sectionTitle = (code, title) => (code && !title.toUpperCase().startsWith(code.toUpperCase()) ? `${code}: ${title}` : title);

/** What bringing in a note would do, with or without its weekly checklists and the export's stand-ins. */
function archivePlan(html, { weeks = true, clean = true } = {}) {
  const blocks = weeks ? weekBlocks(html) : [];
  let body = withoutWeeks(html, blocks);
  if (clean) body = stripExportStubs(body);
  return { blocks, body };
}

export default async function studyRoutes(app) {
  app.get('/api/studies', async () => db.prepare('SELECT * FROM studies ORDER BY (status = \'active\') DESC, updated_at DESC').all().map(studyRow));

  app.post('/api/studies', async (req) => {
    const b = req.body ?? {};
    const f = studyFields({ kind: 'self', ...b, title: b.title });
    const now = Date.now();
    return tx(() => {
      // Its own notebook unless you pick one (or none).
      let notebookId = f.notebook_id ?? null;
      if (b.notebook === 'new') {
        notebookId = Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run(f.title.slice(0, 200), now).lastInsertRowid);
        // A class's notebook goes on the Seminary shelf.
        if (f.kind === 'class') shelve(notebookId);
      }
      const id = Number(db.prepare(`INSERT INTO studies (title, kind, status, description, color, notebook_id, start_date, target_date, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.title, f.kind, f.status ?? 'active', f.description ?? '', f.color ?? 'blue', notebookId,
        f.start_date ?? null, f.target_date ?? null, f.data ?? '{}', now, now).lastInsertRowid);
      return { id };
    });
  });

  app.get('/api/studies/:id', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const notes = db.prepare(`SELECT n.id, n.title, n.updated_at, substr(n.text, 1, 160) AS snippet, sn.role, n.html
      FROM study_notes sn JOIN notes n ON n.id = sn.note_id WHERE sn.study_id = ? AND n.deleted_at IS NULL
      ORDER BY sn.role = 'archive' DESC, n.created_at`).all(s.id)
      // Archived class notes show their outline: the headings.
      .map(({ html, ...n }) => ({
        ...n,
        // (Without the weekly checklists when they became the schedule.)
        outline: n.role === 'archive' ? headingsOf(parseData(s.data).weeks ? withoutWeeks(html) : html)
          .filter((h) => h.level <= 3 && h.text).slice(0, 200).map(({ level, text }) => ({ level, text })) : undefined,
      }));
    const writing = s.kind === 'writing' ? (() => { const chapters = chaptersOf(s.id); return { chapters, writing: writingProgress(s.id, chapters) }; })() : null;
    return {
      ...studyRow(s), items: itemsOf(s.id), notes: notes.filter((n) => n.role !== 'chapter'), ...(writing ?? {}),
      notebook: s.notebook_id ? studyNotebook(s) : null,
    };
  });

  app.patch('/api/studies/:id', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const f = studyFields(req.body ?? {}, s);
    return tx(() => {
      update('studies', s.id, { ...f, updated_at: Date.now() });
      if (f.title && s.list_id) db.prepare('UPDATE task_lists SET name = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM task_lists WHERE name = ? COLLATE NOCASE AND id != ?)').run(f.title.slice(0, 90), s.list_id, f.title.slice(0, 90), s.list_id);
      // Finishing, archiving or hiding from Tasks takes its tasks away (and the reverse brings them back).
      if ('status' in f || 'data' in f || 'title' in f) syncStudyTasks(s.id);
      return { ok: true };
    });
  });

  // Deleting a study keeps its notes; its tasks go.
  app.delete('/api/studies/:id', async (req) => {
    const s = getStudy(intParam(req.params.id));
    tx(() => {
      db.prepare('DELETE FROM tasks WHERE id IN (SELECT task_id FROM study_items WHERE study_id = ?)').run(s.id);
      db.prepare('DELETE FROM studies WHERE id = ?').run(s.id);
      if (s.list_id && !db.prepare('SELECT 1 FROM tasks WHERE list_id = ?').get(s.list_id)) db.prepare('DELETE FROM task_lists WHERE id = ?').run(s.list_id);
    });
    // A class's syllabus PDF (11.0) belongs to the class alone (an attachment with no note), so it goes too.
    const pdf = parseData(s.data).syllabusPdf;
    const a = pdf?.id && db.prepare('SELECT storage FROM attachments WHERE id = ? AND note_id IS NULL').get(pdf.id);
    if (a) {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(pdf.id);
      unlinkStorage([a.storage]);
    }
    return { ok: true };
  });

  // ---- items ----
  app.post('/api/studies/:id/items', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const list = Array.isArray(req.body?.items) ? req.body.items : [req.body ?? {}];
    if (list.length > 500) throw httpError(400, 'Too many at once');
    return tx(() => {
      const ids = list.map((b) => insertItem(s.id, itemFields({ kind: 'reading', ...b })));
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      return { ids };
    });
  });

  app.patch('/api/study-items/:id', async (req) => {
    const item = getItem(intParam(req.params.id));
    const b = req.body ?? {};
    return tx(() => {
      update('study_items', item.id, itemFields(b, item));
      if ('done' in b) {
        const at = b.done ? Date.now() : null;
        if (item.task_id) db.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?').run(at, Date.now(), item.task_id);
        db.prepare('UPDATE study_items SET done_at = ? WHERE id = ?').run(at, item.id);
      }
      syncTask(item.id);
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), item.study_id);
      return getItem(item.id);
    });
  });

  app.delete('/api/study-items/:id', async (req) => {
    const item = getItem(intParam(req.params.id));
    tx(() => {
      if (item.task_id) db.prepare('DELETE FROM tasks WHERE id = ?').run(item.task_id);
      db.prepare('DELETE FROM study_items WHERE id = ?').run(item.id);
    });
    return { ok: true };
  });

  // A lesson note for a session (made from the lesson layout), or a plain note for any other item.
  app.post('/api/study-items/:id/note', async (req) => {
    const item = getItem(intParam(req.params.id));
    if (item.note_id && item.note_title !== null) return { id: item.note_id };
    const s = getStudy(item.study_id);
    return tx(() => {
      const lecture = s.kind === 'class' && item.kind === 'session';
      // A lesson's method: the one picked when it was started, else the study's.
      const method = item.kind === 'session' && !lecture ? lessonMethod(req.body?.method) : null;
      const html = lecture ? lectureHtml(item, s)
        : item.kind === 'session' ? lessonHtml(item, s, method) : `<p><em>${escapeHtml(s.title)}${item.ref ? ` · ${escapeHtml(item.ref)}` : ''}</em></p><p></p>`;
      const syl = parseData(s.data).syllabus ?? {};
      const id = newNote(s.notebook_id, lecture ? `${syl.code ? `${syl.code} ` : ''}${item.title}` : item.title, html);
      linkNote(s.id, id, lecture ? 'lecture' : item.kind === 'session' ? 'lesson' : 'note');
      if (item.kind === 'session' && !lecture) recordMethod(id, method ?? parseData(s.data).lessonLayout ?? 'hblt');
      db.prepare('UPDATE study_items SET note_id = ? WHERE id = ?').run(id, item.id);
      syncTask(item.id);
      return { id };
    });
  });

  // ---- the lesson builder ----
  /**
   * A lesson note with what the lesson builder shows around it: its session (date, passage, the builder's own
   * data), its teaching study (class length), and the sessions before and after it.
   */
  app.get('/api/notes/:id/lesson', async (req) => {
    const noteId = intParam(req.params.id);
    const note = db.prepare('SELECT id, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
    if (!note) throw httpError(404, 'Note not found');
    const found = db.prepare(`SELECT i.id FROM study_items i JOIN studies s ON s.id = i.study_id WHERE i.note_id = ? AND i.kind = 'session'
      ORDER BY (s.kind = 'teaching') DESC, i.id LIMIT 1`).get(noteId);
    const item = found ? getItem(found.id) : null;
    const s = item ? getStudy(item.study_id)
      : db.prepare(`SELECT s.* FROM study_notes sn JOIN studies s ON s.id = sn.study_id WHERE sn.note_id = ? AND sn.role = 'lesson' ORDER BY (s.kind = 'teaching') DESC LIMIT 1`).get(noteId);
    let prev = null;
    let next = null;
    if (item) {
      const sessions = itemsOf(item.study_id).filter((i) => i.kind === 'session');
      // A course's weeks are in week order (their dates follow it).
      if (sessions.some((i) => i.data.week)) sessions.sort((a, b) => (a.data.week ?? 1e9) - (b.data.week ?? 1e9) || a.position - b.position);
      const at = sessions.findIndex((i) => i.id === item.id);
      const before = sessions.slice(0, at).reverse().find((i) => i.note_id && i.note_title !== null);
      if (before) prev = { title: before.title, ref: before.ref, date: before.date, note_id: before.note_id, week: before.data.week ?? null, reflection: before.data.reflection ?? null };
      const after = sessions[at + 1];
      if (after) next = { title: after.title, ref: after.ref, date: after.date, note_id: after.note_id && after.note_title !== null ? after.note_id : null, week: after.data.week ?? null };
    }
    const sd = s ? parseData(s.data) : {};
    return {
      note_id: noteId,
      item: item && { id: item.id, title: item.title, ref: item.ref, date: item.date, data: item.data.lesson ?? {}, week: item.data.week ?? null, previous: item.data.previous ?? null, study_note: item.data.study_note ?? null, done: !!item.done, reflection: item.data.reflection ?? null },
      study: s && {
        id: s.id, title: s.title, kind: s.kind, classMinutes: sd.classMinutes ?? 45,
        course: sd.course ? { aims: sd.course.aims ?? {}, weeks: itemsOf(s.id).filter((i) => i.kind === 'session').length } : null,
      },
      prev, next,
    };
  });

  /**
   * The lesson builder writes the lesson: { html?, title?, base_updated_at?, overwrite?, ref?, date?, lesson?,
   * classMinutes? }. The note as it was goes into its version history first; refused (409) when the note changed
   * after the builder opened it.
   */
  app.put('/api/notes/:id/lesson', async (req, reply) => {
    const noteId = intParam(req.params.id);
    const b = req.body ?? {};
    const now = db.prepare('SELECT title, html, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
    if (!now) throw httpError(404, 'Note not found');
    // Without html only the session's builder data is saved (where the builder was left, say).
    const writing = typeof b.html === 'string';
    if (writing && typeof b.base_updated_at === 'number' && now.updated_at > b.base_updated_at && !b.overwrite) {
      reply.code(409);
      return { error: 'The lesson changed while the builder was open', conflict: true, note: now };
    }
    return tx(() => {
      if (writing) {
        if (b.html !== now.html) snapshot(noteId, { reason: 'Before the lesson builder saved', force: true });
        const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 500) : now.title;
        db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, updated_at = ? WHERE id = ?').run(title, b.html, htmlToText(b.html), Date.now(), noteId);
      }
      const found = db.prepare("SELECT id FROM study_items WHERE note_id = ? AND kind = 'session' ORDER BY id LIMIT 1").get(noteId);
      if (found) {
        const item = getItem(found.id);
        const f = itemFields({
          ...('ref' in b ? { ref: b.ref } : {}),
          ...('date' in b ? { date: b.date } : {}),
          ...(b.lesson && typeof b.lesson === 'object' ? { data: { lesson: { ...item.data.lesson, ...b.lesson } } } : {}),
        }, item);
        update('study_items', item.id, f);
        syncTask(item.id);
        const study = getStudy(item.study_id);
        const minutes = Number(b.classMinutes);
        if (Number.isFinite(minutes) && minutes > 0 && minutes <= 600) {
          db.prepare('UPDATE studies SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(study.data), classMinutes: Math.round(minutes) }), study.id);
        }
        db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), study.id);
      }
      return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(noteId);
    });
  });

  // ---- notes ----
  app.post('/api/studies/:id/notes', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    return tx(() => {
      let id = b.note_id ? intParam(b.note_id) : null;
      if (id && !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw httpError(404, 'Note not found');
      if (!id) id = newNote(s.notebook_id, String(b.title ?? '').trim() || 'Untitled', `<p><em>${escapeHtml(s.title)}</em></p><p></p>`);
      linkNote(s.id, id, ['paper', 'lesson'].includes(b.role) ? b.role : 'note');
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      return { id };
    });
  });
  // ---- a writing project's chapters ----
  /**
   * Body: { title, method?, matter? } for a new chapter note (laid out in the project's type, or `method`; front matter
   * goes before the chapters and back matter after them), or { note_id } to make an existing note a chapter (at the end).
   */
  app.post('/api/studies/:id/chapters', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    const matter = MATTERS.includes(b.matter) ? b.matter : null;
    return tx(() => {
      let id = b.note_id ? intParam(b.note_id) : null;
      if (id && !db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(id)) throw httpError(404, 'Note not found');
      if (!id) {
        const method = validMethod('writing', b.method) ?? validMethod('writing', parseData(s.data).methods?.writing);
        // Front and back matter start blank; a chapter, post or part starts in its method.
        id = newNote(s.notebook_id, String(b.title ?? '').trim().slice(0, 300) || 'Untitled chapter', matter ? '<p></p>' : skeletonHtml(method));
        if (method) recordMethod(id, method);
      }
      const ends = db.prepare("SELECT MIN(position) AS lo, MAX(position) AS hi FROM study_notes WHERE study_id = ? AND role = 'chapter'").get(s.id);
      const lastFront = db.prepare("SELECT MAX(position) AS p FROM study_notes WHERE study_id = ? AND role = 'chapter' AND matter = 'front'").get(s.id).p;
      const firstBack = db.prepare("SELECT MIN(position) AS p FROM study_notes WHERE study_id = ? AND role = 'chapter' AND matter = 'back'").get(s.id).p;
      // Front matter after the other front matter; a chapter before the back matter; back matter at the end.
      const position = matter === 'front' ? (lastFront ?? (ends.lo ?? 1) - 1) + 0.5
        : matter === 'back' || firstBack == null ? (ends.hi ?? 0) + 1 : firstBack - 0.5;
      db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at, position, status, matter) VALUES (?, ?, 'chapter', ?, ?, 'outline', ?)
        ON CONFLICT(study_id, note_id) DO UPDATE SET role = 'chapter', position = excluded.position, status = COALESCE(study_notes.status, 'outline'), matter = excluded.matter`)
        .run(s.id, id, Date.now(), position, matter);
      renumber(s.id);
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      return { id };
    });
  });
  // Body: { status?, goal?, matter?, checks? } (goal: words, or null; matter: 'front', 'back' or null; checks: { key: true }).
  app.patch('/api/studies/:id/chapters/:noteId', async (req) => {
    const b = req.body ?? {};
    const f = {};
    if ('status' in b) {
      if (!CHAPTER_STATUSES.includes(b.status)) throw httpError(400, 'Unknown status');
      f.status = b.status;
    }
    if ('matter' in b) f.matter = MATTERS.includes(b.matter) ? b.matter : null;
    if ('checks' in b) {
      const c = b.checks && typeof b.checks === 'object' ? Object.fromEntries(Object.entries(b.checks).filter(([k, v]) => /^[\w.-]{1,40}$/.test(k) && v === true).slice(0, 100)) : {};
      f.checks = JSON.stringify(c);
    }
    if ('goal' in b) f.goal = b.goal == null || b.goal === '' ? null : Math.max(0, Math.min(1_000_000, Math.round(Number(b.goal)) || 0)) || null;
    const keys = Object.keys(f);
    if (!keys.length) return { ok: true };
    const r = db.prepare(`UPDATE study_notes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE study_id = ? AND note_id = ? AND role = 'chapter'`)
      .run(...keys.map((k) => f[k]), intParam(req.params.id), intParam(req.params.noteId));
    if (!r.changes) throw httpError(404, 'Not a chapter of this project');
    return { ok: true };
  });
  // Body: { ids: [...] }: the chapters in this order.
  app.post('/api/studies/:id/chapters/order', async (req) => {
    const id = intParam(req.params.id);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(intParam) : [];
    tx(() => ids.forEach((n, i) => db.prepare("UPDATE study_notes SET position = ? WHERE study_id = ? AND note_id = ? AND role = 'chapter'").run(i + 1, id, n)));
    return { ok: true };
  });
  // Every piece of every writing project under way, for Desk → Write's board (by stage).
  app.get('/api/writing/board', async () => {
    const projects = db.prepare("SELECT id, title, color, data FROM studies WHERE kind = 'writing' AND status = 'active' ORDER BY updated_at DESC").all();
    return {
      stages: CHAPTER_STATUSES,
      projects: projects.map((s) => ({ id: s.id, title: s.title, color: s.color, method: parseData(s.data).methods?.writing ?? null })),
      pieces: projects.flatMap((s) => chaptersOf(s.id).map((c) => ({ ...c, study_id: s.id }))),
    };
  });
  // The whole project's text, chapter by chapter, for exporting.
  app.get('/api/studies/:id/manuscript', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const parts = db.prepare(`SELECT n.id, n.title, n.html FROM study_notes sn JOIN notes n ON n.id = sn.note_id
      WHERE sn.study_id = ? AND sn.role = 'chapter' AND n.deleted_at IS NULL ORDER BY sn.position, sn.added_at`).all(s.id);
    return { title: s.title, parts };
  });
  /**
   * The sources panel: the project's reading notes (its notes that aren't chapters) and the Zotero sources its
   * chapters cite, most cited first.
   */
  app.get('/api/studies/:id/sources', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const notes = db.prepare(`SELECT n.id, n.title, substr(n.text, 1, 200) AS snippet, n.updated_at FROM study_notes sn JOIN notes n ON n.id = sn.note_id
      WHERE sn.study_id = ? AND sn.role != 'chapter' AND n.deleted_at IS NULL ORDER BY n.updated_at DESC`).all(s.id);
    const counts = new Map();
    for (const { html } of db.prepare(`SELECT n.html FROM study_notes sn JOIN notes n ON n.id = sn.note_id
      WHERE sn.study_id = ? AND n.deleted_at IS NULL`).all(s.id)) {
      for (const m of html.matchAll(/data-cite=(?:"([^"]*)"|'([^']*)')/g)) {
        try {
          for (const it of JSON.parse((m[1] ?? m[2]).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))) counts.set(it.id, (counts.get(it.id) ?? 0) + 1);
        } catch { /* not a citation list */ }
      }
    }
    const sources = [...counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => {
      const row = db.prepare('SELECT csl FROM sources WHERE id = ?').get(id);
      return row ? { ...JSON.parse(row.csl), id, cited: n } : null;
    }).filter(Boolean);
    return { notes, sources };
  });

  app.delete('/api/studies/:id/notes/:noteId', async (req) => {
    db.prepare('DELETE FROM study_notes WHERE study_id = ? AND note_id = ?').run(intParam(req.params.id), intParam(req.params.noteId));
    return { ok: true };
  });

  // The studies a note belongs to (for the note's own header).
  app.get('/api/notes/:id/studies', async (req) => db.prepare(`SELECT s.id, s.title, s.kind, s.color FROM study_notes sn
    JOIN studies s ON s.id = sn.study_id WHERE sn.note_id = ? ORDER BY s.title`).all(intParam(req.params.id)));

  // ---- a class's calendar feed ----
  app.post('/api/studies/:id/sync', async (req) => syncFeed(getStudy(intParam(req.params.id))));

  // ---- old classes ----
  // Preview: a note's headings and weekly checklists, to choose how to bring it in. ?weeks=0 and ?clean=0 turn
  // those steps off.
  app.get('/api/studies/archive/preview/:noteId', async (req) => {
    const n = db.prepare('SELECT id, title, html, notebook_id FROM notes WHERE id = ? AND deleted_at IS NULL').get(intParam(req.params.noteId));
    if (!n) throw httpError(404, 'Note not found');
    const blocks = weekBlocks(n.html);
    const { body } = archivePlan(n.html, { weeks: req.query.weeks !== '0', clean: req.query.clean !== '0' });
    const inWeek = (at) => req.query.weeks !== '0' && blocks.some((b) => at >= b.start && at < b.end);
    const headings = headingsOf(n.html).filter((h) => h.level <= 3 && h.text).map((h) => ({ level: h.level, text: h.text, week: inWeek(h.at) }));
    const items = blocks.flatMap((b) => b.items);
    return {
      id: n.id, title: n.title, code: courseCode(n.title),
      words: htmlToText(n.html).split(/\s+/).filter(Boolean).length,
      headings,
      weeks: { count: blocks.length, items: items.length, done: items.filter((i) => i.done).length },
      stubs: (n.html.match(EXPORT_STUB) ?? []).length,
      splitCounts: Object.fromEntries([1, 2, 3].map((l) => [l, splitSections(body, l).length])),
    };
  });

  /**
   * Body: { classes: [{ note_id, title?, mode: 'keep' | 'split', level?, weeks?, clean? }] }. Each becomes an
   * archived Class study.
   * - weeks (default on): the weekly checklists become the class's schedule, ticked as they were.
   * - clean (default on): the "Content not supported" stand-ins go.
   * - split: a note per section (in the same notebook, named with the course code, with the files each section
   *   uses), leaving out the checklists that became the schedule; the original goes to the Trash.
   */
  app.post('/api/studies/archive', async (req) => {
    const classes = Array.isArray(req.body?.classes) ? req.body.classes.slice(0, 200) : [];
    if (!classes.length) throw httpError(400, 'Pick at least one class note');
    return tx(() => {
      const made = [];
      for (const c of classes) {
        const n = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(intParam(c.note_id));
        if (!n) continue;
        const now = Date.now();
        const title = String(c.title ?? '').trim().slice(0, 200) || n.title || 'Class';
        const { blocks, body } = archivePlan(n.html, { weeks: c.weeks !== false, clean: c.clean !== false });
        const studyId = Number(db.prepare(`INSERT INTO studies (title, kind, status, color, notebook_id, data, created_at, updated_at)
          VALUES (?, 'class', 'archived', 'gray', ?, ?, ?, ?)`).run(title, n.notebook_id, JSON.stringify({ archivedFrom: n.id, weeks: blocks.length > 0 }), n.created_at, now).lastInsertRowid);
        // The schedule, week by week, in the order the note lists each week's parts.
        let position = 0;
        for (const b of [...blocks].sort((x, y) => x.week - y.week)) {
          for (const it of b.items) {
            const id = insertItem(studyId, { kind: partKind(it.part), title: it.title.slice(0, 300), position: position += 1, data: { week: b.week, part: it.part } });
            if (it.done) db.prepare('UPDATE study_items SET done_at = ? WHERE id = ?').run(n.updated_at, id);
          }
        }
        if (c.mode !== 'split') {
          if (c.clean !== false && body !== withoutWeeks(n.html, blocks)) {
            // Only the stand-ins go; the note keeps its checklists.
            const html = stripExportStubs(n.html);
            snapshot(n.id, { reason: 'Before bringing it into Studies', force: true });
            db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), now, n.id);
          }
          linkNote(studyId, n.id, 'archive');
          made.push({ id: studyId, notes: 1, items: position });
          continue;
        }
        const level = [1, 2, 3].includes(Number(c.level)) ? Number(c.level) : 1;
        const code = courseCode(title) ?? courseCode(n.title);
        const sections = splitSections(body, level);
        const files = db.prepare('SELECT id FROM attachments WHERE note_id = ?').all(n.id).map((a) => a.id);
        const placed = new Set();
        let firstId = null;
        sections.forEach((sec, i) => {
          const id = newNote(n.notebook_id, sec.title ? sectionTitle(code, sec.title) : `${n.title} (overview)`, sec.html, n.created_at + i);
          firstId ??= id;
          for (const fid of files) {
            if (sec.html.includes(`/api/files/${fid}`) || sec.html.includes(`data-attachment="${fid}"`)) {
              db.prepare('UPDATE attachments SET note_id = ? WHERE id = ?').run(id, fid);
              placed.add(fid);
            }
          }
          linkNote(studyId, id, 'note');
        });
        // Files the text doesn't show stay with the class, on its first note.
        for (const fid of files) if (!placed.has(fid) && firstId) db.prepare('UPDATE attachments SET note_id = ? WHERE id = ?').run(firstId, fid);
        db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(now, n.id);
        made.push({ id: studyId, notes: sections.length, items: position });
      }
      return { made };
    });
  });
}
