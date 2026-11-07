import { db, tx } from './db.js';
import { escapeHtml, htmlToText } from './html.js';
import { snapshot } from './links.js';
import { catchUp, IGNORED } from './scripture.js';
import { lessonHtml, lessonMethod, syncTask } from './studies.js';
import { recordMethod } from './methods.js';
import { validMethod } from '../shared/methods.js';
import { book, findReferences, format, logosUrl, parse } from '../shared/scripture.js';

/**
 * Bible studies and verse notes, the Scripture page's own notes.
 *
 * A Bible study is a note laid out for the study builder (Duvall and Hays's Interpretive Journey: their town, the
 * river, the principlizing bridge, the biblical map, our town, then a keeper) plus what the builder keeps beside it:
 * its passage, times read, translations, the principle checks. A verse note is an ordinary note titled with its verse
 * (what a margin note became in 5.10), so it shows beside that verse on the passage page. Both live in the "Bible
 * Study" notebook unless moved. Each save is logged, so the weekly review can count study weeks.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const MAX_NOTE = 5000;
/** A verse note is titled with a reference this short (or shorter). */
export const MARGIN_VERSES = 3;

db.exec(`
CREATE TABLE IF NOT EXISTS bible_studies (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  passage TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '[]',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bible_study_log (
  id INTEGER PRIMARY KEY,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bible_study_log_at ON bible_study_log(at);`);

/** The "Bible Study" notebook, made when first needed. */
export function studyNotebook() {
  const found = db.prepare("SELECT id FROM notebooks WHERE name = 'Bible Study' COLLATE NOCASE ORDER BY id LIMIT 1").get();
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run('Bible Study', Date.now()).lastInsertRowid);
}

const verseLabel = (b, ch, v) => format({ book: b, ch_start: ch, v_start: v, ch_end: ch, v_end: v });
const passageLink = (label, ref) => `<p><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(logosUrl(ref))}">${escapeHtml(label)}</a></p>`;
const textParas = (text) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
const log = (noteId, kind) => db.prepare('INSERT INTO bible_study_log (note_id, kind, at) VALUES (?, ?, ?)').run(noteId, kind, Date.now());

/** A passage as typed, tidied when it reads as a Bible reference, with its ranges. */
function readPassage(v) {
  const text = clip(v, 200);
  const { refs, errors } = parse(text);
  if (!refs.length || errors.length) return { passage: text, refs: [] };
  return { passage: refs.map((r) => format(r)).join('; '), refs: refs.map((r) => ({ book: r.book, ch_start: r.ch_start, ch_end: r.ch_end, start: r.start, end: r.end })) };
}

/** A note on a passage (a verse note when it's one verse): a real note titled with it, its Logos link first. */
export function addVerseNote({ label, text, html: given, createdAt }) {
  const ref = parse(label).refs[0];
  const html = passageLink(label, ref) + (given ?? textParas(text));
  const now = Date.now();
  const id = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(studyNotebook(), label, html, htmlToText(html), createdAt ?? now, now).lastInsertRowid);
  log(id, 'verse');
  return { id, title: label };
}

// Margin notes (5.1–5.9 kept them in their own table) become verse notes, once.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verse_notes'").get()) {
  tx(() => {
    for (const n of db.prepare('SELECT * FROM verse_notes ORDER BY key, created_at').all()) {
      addVerseNote({ label: verseLabel(n.book, n.chapter, n.verse), text: n.text, createdAt: n.created_at });
    }
    db.exec('DROP TABLE verse_notes');
  });
}

const STUDY_SELECT = `SELECT b.*, n.title, n.notebook_id, n.updated_at AS note_updated, n.deleted_at, COALESCE(m.method, 'ggw') AS method
  FROM bible_studies b JOIN notes n ON n.id = b.note_id LEFT JOIN note_methods m ON m.note_id = b.note_id`;
/**
 * Studies that aren't of a passage (8.5): a book's background, kept one per book, and a word study, one per word.
 * They show on the passage page and in the builders, but don't count toward the chapters you've studied.
 */
export const REFERENCE_METHODS = ['background', 'word'];
const NOT_REFERENCE = `COALESCE((SELECT method FROM note_methods WHERE note_id = b.note_id), 'ggw') NOT IN ('background', 'word')`;
function studyRow(r) {
  const { data, refs, deleted_at, ...s } = r;
  return { ...s, data: parseData(data), refs: parseData(refs), trashed: !!deleted_at };
}
/** The course week a study was made for (5.12), while it's still that week's study: { item_id, week, course, lesson_note }. */
function courseWeek(s) {
  const id = s.data.course_item;
  if (!id) return null;
  const r = db.prepare(`SELECT i.id, i.data, i.title, s.title AS course, s.id AS study_id, n.id AS lesson_note FROM study_items i
    JOIN studies s ON s.id = i.study_id LEFT JOIN notes n ON n.id = i.note_id AND n.deleted_at IS NULL WHERE i.id = ?`).get(id);
  if (!r || parseData(r.data).study_note !== s.note_id) return null;
  return { item_id: r.id, week: parseData(r.data).week ?? null, title: r.title, course: r.course, study_id: r.study_id, lesson_note: r.lesson_note ?? null };
}
/** 9.2: the study plan (a self-study on Desk) a Bible study is filed under, as one of its readings or notes: { id, title }. */
function planOf(noteId) {
  return db.prepare(`SELECT s.id, s.title FROM studies s WHERE s.kind = 'self'
    AND (s.id IN (SELECT study_id FROM study_items WHERE note_id = ?) OR s.id IN (SELECT study_id FROM study_notes WHERE note_id = ?))
    ORDER BY s.id LIMIT 1`).get(noteId, noteId) ?? null;
}
function getStudy(id) {
  const r = db.prepare(`${STUDY_SELECT} WHERE b.id = ?`).get(id);
  if (!r) throw httpError(404, 'Study not found');
  const s = studyRow(r);
  return { ...s, course_week: courseWeek(s), plan: planOf(s.note_id) };
}

/**
 * The workflow a note belongs to ('sermon', 'lesson' or 'writing'), or null. Those notes keep their own builders: a
 * study comes first and feeds them (Take It Further), but they never turn into studies.
 */
const WORKFLOW_SQL = `SELECT CASE
    WHEN EXISTS (SELECT 1 FROM sermons WHERE note_id = :id) THEN 'sermon'
    WHEN EXISTS (SELECT 1 FROM study_notes WHERE note_id = :id AND role IN ('chapter', 'paper')) THEN 'writing'
    WHEN EXISTS (SELECT 1 FROM study_notes WHERE note_id = :id AND role IN ('lesson', 'sermon')) THEN 'lesson'
    WHEN EXISTS (SELECT 1 FROM study_items i JOIN studies s ON s.id = i.study_id WHERE i.note_id = :id AND (i.kind = 'session' OR s.kind IN ('teaching', 'preaching', 'writing'))) THEN 'lesson'
  END AS w`;
export const workflowOf = (noteId) => db.prepare(WORKFLOW_SQL).get({ id: noteId })?.w ?? null;
const WORKFLOW_NAMES = { sermon: 'a sermon', lesson: 'a lesson', writing: 'part of a writing project' };

/** The study for a note, made when a note that isn't one yet is opened in the builder. */
function ensureStudy(noteId) {
  const found = db.prepare('SELECT id FROM bible_studies WHERE note_id = ?').get(noteId);
  if (found) return found.id;
  const w = workflowOf(noteId);
  if (w) throw httpError(409, `This note is ${WORKFLOW_NAMES[w]}, so it keeps its own workflow. Study the passage in a new study, then take it to the ${w === 'writing' ? 'writing project' : w} with Take It Further.`);
  const note = db.prepare('SELECT title, text FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
  if (!note) throw httpError(404, 'Note not found');
  // The passage: the first reference in the title or the note.
  const inTitle = parse(note.title ?? '').refs;
  const first = inTitle.length ? inTitle : findReferences(note.text.slice(0, 2000))[0]?.refs ?? [];
  const { passage, refs } = readPassage(first.map((r) => format(r)).join('; '));
  const now = Date.now();
  return Number(db.prepare('INSERT INTO bible_studies (note_id, passage, refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(noteId, passage, JSON.stringify(refs), now, now).lastInsertRowid);
}

/** A lesson or session note in something you teach (a teaching study, a course, a preaching series). */
const TEACH_NOTE = `(EXISTS (SELECT 1 FROM study_notes sn WHERE sn.note_id = n.id AND sn.role = 'lesson')
  OR EXISTS (SELECT 1 FROM study_items i JOIN studies t ON t.id = i.study_id WHERE i.note_id = n.id AND t.kind IN ('teaching', 'preaching')))`;

/**
 * What you teach on a passage, for its page: sessions in teaching studies, courses and preaching series whose passage
 * (or a reference in their title) overlaps it, planned or written, plus lesson notes that only mention it. `notes`
 * are the passage's notes from passageNotes(); sermons stay with the sermons.
 */
export function passageLessons(ranges, notes = []) {
  if (!ranges.length) return [];
  const overlaps = (refs) => refs.some((x) => ranges.some((r) => x.start <= r.end && x.end >= r.start));
  const refsOf = (i) => {
    const p = parse(i.ref ?? '');
    if (p.refs.length && !p.errors.length) return p.refs;
    return findReferences(i.title ?? '').flatMap((f) => f.refs);
  };
  const items = db.prepare(`
    SELECT i.id, i.title, i.ref, i.date, i.done_at, i.kind, i.note_id, n.title AS note_title, n.updated_at,
           s.id AS study_id, s.title AS study, s.kind AS study_kind, s.status, json_extract(s.data, '$.course') IS NOT NULL AS course,
           EXISTS (SELECT 1 FROM sermons WHERE note_id = i.note_id) AS sermon
    FROM study_items i JOIN studies s ON s.id = i.study_id LEFT JOIN notes n ON n.id = i.note_id AND n.deleted_at IS NULL
    WHERE s.kind IN ('teaching', 'preaching') AND i.kind = 'session'
    ORDER BY i.date IS NULL, i.date, i.position, i.id`).all();
  const out = [];
  const seen = new Set();
  for (const i of items) {
    const refs = refsOf(i);
    const noted = notes.some((n) => n.id === i.note_id);
    if (i.sermon || !(overlaps(refs) || noted)) continue;
    const note_id = i.note_title != null ? i.note_id : null;
    if (note_id) seen.add(note_id);
    out.push({
      item_id: i.id, title: i.note_title || i.title, ref: refs.map((r) => r.label).join('; '), date: i.date || null, done: !!i.done_at,
      note_id, updated_at: note_id ? i.updated_at : null, study_id: i.study_id, study: i.study, study_kind: i.study_kind, course: !!i.course, status: i.status,
    });
  }
  // Lesson notes on the passage that aren't a session's (or whose session names another passage).
  const studyOf = db.prepare(`SELECT s.id, s.title, s.kind, s.status, json_extract(s.data, '$.course') IS NOT NULL AS course
    FROM study_notes sn JOIN studies s ON s.id = sn.study_id WHERE sn.note_id = ? ORDER BY (s.kind = 'teaching') DESC LIMIT 1`);
  for (const n of notes) {
    if (n.kind !== 'lesson' || seen.has(n.id)) continue;
    const s = studyOf.get(n.id);
    out.push({
      item_id: null, title: n.title, ref: n.refs.join('; '), date: null, done: false, note_id: n.id, updated_at: n.updated_at,
      study_id: s?.id ?? null, study: s?.title ?? null, study_kind: s?.kind ?? null, course: !!s?.course, status: s?.status ?? null,
    });
  }
  return out;
}

/**
 * What's written on a passage, for its page: every note that mentions it (studies, sermons with their preached log,
 * verse notes, other notes). A verse note (titled with up to three verses) carries the verse it belongs beside.
 */
export function passageNotes(ranges) {
  if (!ranges.length) return [];
  catchUp();
  const where = ranges.map(() => '(r.start <= ? AND r."end" >= ?)').join(' OR ');
  const rows = db.prepare(`
    SELECT n.id, n.title, n.created_at, n.updated_at, nb.name AS notebook, substr(n.text, 1, 400) AS snippet,
           group_concat(DISTINCT r.label) AS labels, MIN(r.start) AS first,
           s.id AS sermon_id, s.passage AS sermon_passage, bs.id AS study_id, bs.data AS study_data, ${TEACH_NOTE} AS teach,
           (SELECT method FROM note_methods WHERE note_id = n.id) AS method
    FROM note_refs r JOIN notes n ON n.id = r.note_id LEFT JOIN notebooks nb ON nb.id = n.notebook_id
    LEFT JOIN sermons s ON s.note_id = n.id LEFT JOIN bible_studies bs ON bs.note_id = n.id
    WHERE n.deleted_at IS NULL AND n.is_template = 0 AND NOT ${IGNORED} AND (${where})
    GROUP BY n.id ORDER BY first, n.updated_at DESC`).all(...ranges.flatMap((x) => [x.end, x.start]));
  const preached = db.prepare('SELECT date, place, occasion FROM sermon_preachings WHERE sermon_id = ? ORDER BY date DESC, id DESC');
  return rows.map(({ labels, first, sermon_id, sermon_passage, study_id, study_data, teach, method, ...n }) => {
    const out = { ...n, refs: (labels ?? '').split(','), kind: study_id ? 'study' : sermon_id ? 'sermon' : teach ? 'lesson' : 'note' };
    if (study_id) {
      const d = parseData(study_data);
      out.keeper = d.keeper ?? '';
      out.method = method ?? 'ggw';
      if (out.method === 'word') out.word = wordSummary(d);
    }
    if (sermon_id) out.preachings = preached.all(sermon_id);
    if (out.kind === 'note') {
      // A verse note: its title is only a short reference inside the passage.
      const { refs, errors } = parse(n.title ?? '', { prefixes: false });
      const r = refs.length === 1 && !errors.length ? refs[0] : null;
      if (r && r.v_start > 0 && r.ch_start === r.ch_end && r.end - r.start < MARGIN_VERSES && ranges.some((x) => r.start >= x.start && r.start <= x.end)) {
        out.kind = 'verse';
        out.verse = r.start;
        out.text = n.snippet.replace(/^\s*\S.*?\n/, '').trim() || n.snippet;
      }
    }
    return out;
  });
}

/** Chapters with a study, by book: { [book]: [chapters] } (the Scripture index's coverage map). */
export function studiedChapters() {
  const out = {};
  const rows = db.prepare(`SELECT b.refs FROM bible_studies b JOIN notes n ON n.id = b.note_id WHERE n.deleted_at IS NULL AND ${NOT_REFERENCE}`).all();
  for (const row of rows) {
    for (const r of parseData(row.refs)) {
      const set = new Set(out[r.book] ?? []);
      for (let ch = r.ch_start; ch <= r.ch_end; ch += 1) set.add(ch);
      out[r.book] = [...set].sort((a, b) => a - b);
    }
  }
  return out;
}

/** Inserts material into the first empty block after the heading matching `re` (or right after the heading). */
function seed(html, re, material) {
  if (!material) return { html, done: false };
  const heads = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const at = heads.findIndex((m) => re.test(m[2].replace(/<[^>]+>/g, '')));
  if (at < 0) return { html, done: false };
  const start = heads[at].index + heads[at][0].length;
  const end = heads[at + 1]?.index ?? html.length;
  const part = html.slice(start, end);
  const empty = /<(ol|ul)>\s*<li>\s*<p>\s*<\/p>\s*<\/li>\s*<\/\1>|<p>\s*<\/p>/i.exec(part);
  const next = empty ? part.slice(0, empty.index) + material + part.slice(empty.index + empty[0].length) : material + part;
  return { html: html.slice(0, start) + next + html.slice(end), done: true };
}
const listHtml = (lines, tag = 'ol') => (lines.length ? `<${tag}>${lines.map((l) => `<li><p>${escapeHtml(l)}</p></li>`).join('')}</${tag}>` : '');
/** The study's material as the browser read it from the note: { summary, principle, questions[], application, keeper }. */
function material(b) {
  const m = b.material ?? {};
  const str = (v) => String(v ?? '').trim().slice(0, 20_000);
  return {
    summary: str(m.summary), principle: str(m.principle), application: str(m.application), keeper: str(m.keeper),
    questions: (Array.isArray(m.questions) ? m.questions : []).map((q) => String(q).trim().slice(0, 1000)).filter(Boolean).slice(0, 40),
  };
}
/** Remembers what a study was taken further into. */
function addForward(study, entry) {
  const forward = [...(study.data.forward ?? []).filter((f) => f.note_id !== entry.note_id), entry];
  db.prepare('UPDATE bible_studies SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...study.data, forward }), Date.now(), study.id);
}

// ---- background and word studies (8.5) ----

/** The background study of a book (its order), or null. */
export function backgroundOf(bookOrder) {
  return db.prepare(`${STUDY_SELECT} WHERE n.deleted_at IS NULL AND m.method = 'background' AND json_extract(b.data, '$.book') = ?
    ORDER BY b.id LIMIT 1`).get(bookOrder) ?? null;
}
/** What a new study keeps from the start: a background's book, a word study's word. */
function startData(method, data, bookOrder) {
  if (method === 'background') return { book: bookOrder };
  if (method === 'word' && data && typeof data.word === 'object') return { word: cleanWord(data.word) };
  return {};
}
/** A word study's word: the English word, its verse, and (when chosen) its Hebrew or Greek. */
function cleanWord(w) {
  const str = (v, n) => clip(v, n);
  return {
    english: str(w.english, 80), code: str(w.code, 8), strongs: str(w.strongs, 8), lemma: str(w.lemma, 80), translit: str(w.translit, 80),
    lang: ['greek', 'hebrew'].includes(w.lang) ? w.lang : '', gloss: str(w.gloss, 200), pos: str(w.pos, 40), mark: !!w.mark,
  };
}
/** A word study as the word library lists it. */
function wordSummary(d) {
  const w = d.word ?? {};
  return { english: w.english ?? '', lemma: w.lemma ?? '', translit: w.translit ?? '', strongs: w.strongs ?? '', code: w.code ?? '', gloss: w.gloss ?? '', lang: w.lang ?? '', mark: !!w.mark };
}

export default async function bibleStudyRoutes(app) {
  // 5.10.0–5.10.1 let a lesson, sermon or chapter be opened in the study builder. Those notes go back to their own
  // workflow (the note itself is untouched).
  db.prepare(`DELETE FROM bible_studies WHERE id IN (SELECT id FROM bible_studies b WHERE (${WORKFLOW_SQL.replace(/:id/g, 'b.note_id')}) IS NOT NULL)`).run();
  db.prepare(`UPDATE study_notes SET role = CASE WHEN EXISTS (SELECT 1 FROM study_items i WHERE i.note_id = study_notes.note_id AND i.kind = 'session')
    THEN 'lesson' ELSE 'note' END WHERE role = 'bible-study' AND note_id NOT IN (SELECT note_id FROM bible_studies)`).run();

  app.get('/api/bible-studies', async () => db.prepare(`${STUDY_SELECT} WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC`).all().map(studyRow));

  // The word library: every word study with its word, verse and keeper (hover cards, the passage page, the builders).
  app.get('/api/word-studies', async () => db.prepare(`${STUDY_SELECT} WHERE n.deleted_at IS NULL AND m.method = 'word' ORDER BY n.title COLLATE NOCASE`).all()
    .map(studyRow).map((s) => ({ id: s.id, note_id: s.note_id, title: s.title, passage: s.passage, keeper: s.data.keeper ?? '', ...wordSummary(s.data) })));
  // ?ref=Ephesians 2:8 (or a book's name): the background study of the passage's book, or null.
  app.get('/api/background-studies', async (req) => {
    const r = parse(clip(req.query.ref, 200)).refs[0];
    const found = r ? backgroundOf(r.book) : null;
    if (!found) return { book: r ? book(r.book).name : null, study: null };
    const s = studyRow(found);
    return { book: book(r.book).name, study: { id: s.id, note_id: s.note_id, title: s.title, keeper: s.data.keeper ?? '', facts: s.data.facts ?? {}, updated_at: s.note_updated } };
  });

  /**
   * Body: { title?, passage, html } (html is the builder's skeleton) or { note_id } to make a note a study. With
   * study_item_id it's that Studies schedule item's note (a reading in a self-study, say): titled like the item, in
   * the study's notebook, and one of the study's notes.
   */
  app.post('/api/bible-studies', async (req) => {
    const b = req.body ?? {};
    return tx(() => {
      if (b.note_id) {
        const id = ensureStudy(intParam(b.note_id));
        return getStudy(id);
      }
      // A course week's study (5.12): the week's first step. It's one of the course's notes; the week's own note is
      // its lesson, made later from the study.
      const week = b.course_item_id ? db.prepare(`SELECT i.*, s.notebook_id AS study_notebook FROM study_items i JOIN studies s ON s.id = i.study_id
        WHERE i.id = ? AND i.kind = 'session' AND json_extract(s.data, '$.course') IS NOT NULL`).get(intParam(b.course_item_id)) : null;
      if (b.course_item_id && !week) throw httpError(404, 'Course week not found');
      const item = b.study_item_id ? db.prepare(`SELECT i.*, s.notebook_id AS study_notebook FROM study_items i JOIN studies s ON s.id = i.study_id
        WHERE i.id = ?`).get(intParam(b.study_item_id)) : null;
      if (b.study_item_id && !item) throw httpError(404, 'Schedule item not found');
      if (item && db.prepare('SELECT kind FROM studies WHERE id = ?').get(item.study_id)?.kind !== 'self') throw httpError(400, 'Only a self-study’s readings are studied in the study builder');
      const method = validMethod('study', b.method) ?? 'ggw';
      const asked = readPassage(b.passage ?? item?.ref ?? week?.ref);
      // A book has one background study, of the whole book: asking for another opens the one you have.
      const bookOrder = method === 'background' ? asked.refs[0]?.book : null;
      const { passage, refs } = bookOrder ? readPassage(book(bookOrder).name) : asked;
      if (method === 'background') {
        if (!bookOrder) throw httpError(400, 'Choose a book of the Bible for its background');
        const found = backgroundOf(bookOrder);
        if (found) return { ...getStudy(found.id), existing: true };
      }
      const title = clip(b.title ?? item?.title, 300)
        || (method === 'background' && bookOrder ? `${book(bookOrder).name} Background` : passage ? `${passage} Study` : 'Bible Study');
      const html = typeof b.html === 'string' ? b.html : '<p></p>';
      const now = Date.now();
      const home = (item ?? week)?.study_notebook;
      const notebook = home && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(home) ? home : studyNotebook();
      const noteId = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(notebook, title.slice(0, 500), html, htmlToText(html), now, now).lastInsertRowid);
      if (item) {
        db.prepare('UPDATE study_items SET note_id = ? WHERE id = ?').run(noteId, item.id);
        if (item.task_id) db.prepare('UPDATE tasks SET note_id = ? WHERE id = ?').run(noteId, item.task_id);
        db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'bible-study', ?)
          ON CONFLICT(study_id, note_id) DO UPDATE SET role = 'bible-study'`).run(item.study_id, noteId, now);
        db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(now, item.study_id);
      }
      const id = Number(db.prepare('INSERT INTO bible_studies (note_id, passage, refs, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(noteId, passage, JSON.stringify(refs), JSON.stringify({ ...startData(method, b.data, bookOrder), ...(week ? { course_item: week.id } : {}) }), now, now).lastInsertRowid);
      if (week) {
        db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(week.data), study_note: noteId }), week.id);
        db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'bible-study', ?)
          ON CONFLICT(study_id, note_id) DO UPDATE SET role = 'bible-study'`).run(week.study_id, noteId, now);
        syncTask(week.id);
      }
      recordMethod(noteId, method);
      log(noteId, 'study');
      return getStudy(id);
    });
  });

  // The study a note is (or null), for the note's header and the builder.
  app.get('/api/notes/:id/bible-study', async (req) => {
    const r = db.prepare(`${STUDY_SELECT} WHERE b.note_id = ?`).get(intParam(req.params.id));
    return r ? { ...studyRow(r), plan: planOf(r.note_id) } : null;
  });
  app.post('/api/notes/:id/bible-study', async (req) => getStudy(tx(() => {
    const id = ensureStudy(intParam(req.params.id));
    // A Studies item's note turned into a Bible study shows as one in that study's notes.
    db.prepare("UPDATE study_notes SET role = 'bible-study' WHERE note_id = ? AND role = 'note'").run(intParam(req.params.id));
    return id;
  })));

  // Body: { passage?, data? (merged) }.
  app.patch('/api/bible-studies/:id', async (req) => {
    const s = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    const sets = ['updated_at = ?'];
    const args = [Date.now()];
    if ('passage' in b) {
      const { passage, refs } = readPassage(b.passage);
      sets.push('passage = ?', 'refs = ?');
      args.push(passage, JSON.stringify(refs));
    }
    if (b.data && typeof b.data === 'object') {
      const json = JSON.stringify({ ...s.data, ...b.data, ...(b.data.word && typeof b.data.word === 'object' ? { word: cleanWord(b.data.word) } : {}) });
      if (json.length > 100_000) throw httpError(413, 'That’s too much to keep with the study');
      sets.push('data = ?');
      args.push(json);
    }
    db.prepare(`UPDATE bible_studies SET ${sets.join(', ')} WHERE id = ?`).run(...args, s.id);
    return getStudy(s.id);
  });

  /**
   * The builder writes the study note: { html, title?, base_updated_at?, overwrite? }. The note as it was goes into
   * its version history first; refused (409) when the note changed after the builder opened it.
   */
  app.put('/api/notes/:id/bible-study', async (req, reply) => {
    const s = getStudy(tx(() => ensureStudy(intParam(req.params.id))));
    const b = req.body ?? {};
    if (typeof b.html !== 'string') throw httpError(400, 'Nothing to write');
    const now = db.prepare('SELECT title, html, updated_at FROM notes WHERE id = ?').get(s.note_id);
    if (typeof b.base_updated_at === 'number' && now.updated_at > b.base_updated_at && !b.overwrite) {
      reply.code(409);
      return { error: 'The study note changed while the builder was open', conflict: true, note: now };
    }
    return tx(() => {
      snapshot(s.note_id, { reason: 'Before the study builder saved', force: true });
      const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 500) : now.title;
      db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, updated_at = ? WHERE id = ?').run(title, b.html, htmlToText(b.html), Date.now(), s.note_id);
      db.prepare('UPDATE bible_studies SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      log(s.note_id, 'study');
      return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(s.note_id);
    });
  });

  /**
   * Take It Further: a lesson in a teaching study, or a chapter in a writing project, started from this study.
   * Body: { study_id, title?, material }. The lesson uses the teaching study's lesson layout, with the study's
   * principle and summary under the exposition, its questions for discussion, and its application.
   */
  app.post('/api/bible-studies/:id/lesson', async (req) => {
    const bs = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    // With item_id: the lesson for that session (a course week, say) instead of a new one at the end of the schedule.
    const week = b.item_id ? db.prepare("SELECT i.*, n.id AS live_note FROM study_items i LEFT JOIN notes n ON n.id = i.note_id AND n.deleted_at IS NULL WHERE i.id = ? AND i.kind = 'session'").get(intParam(b.item_id)) : null;
    if (b.item_id && !week) throw httpError(404, 'Session not found');
    if (week?.live_note) throw httpError(409, 'That week already has its lesson');
    const s = db.prepare("SELECT * FROM studies WHERE id = ? AND kind = 'teaching'").get(week ? week.study_id : intParam(b.study_id));
    if (!s) throw httpError(400, 'Choose a teaching study');
    const m = material(b);
    const title = clip(b.title, 300) || (week && week.title !== week.ref ? week.title : '') || bs.passage || 'Lesson';
    return tx(() => {
      const now = Date.now();
      let itemId = week?.id;
      if (week) {
        db.prepare('UPDATE study_items SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(week.data), from_study: bs.note_id, study_note: parseData(week.data).study_note ?? bs.note_id }), week.id);
      } else {
        const position = (db.prepare('SELECT MAX(position) AS p FROM study_items WHERE study_id = ?').get(s.id).p ?? 0) + 1;
        itemId = Number(db.prepare(`INSERT INTO study_items (study_id, kind, title, ref, position, data, created_at) VALUES (?, 'session', ?, ?, ?, ?, ?)`)
          .run(s.id, title, bs.passage, position, JSON.stringify({ from_study: bs.note_id }), now).lastInsertRowid);
      }
      const method = lessonMethod(b.method);
      let html = lessonHtml({ title, ref: week?.ref || bs.passage, date: null }, s, method);
      const lead = `${m.principle ? `<p><strong>Big idea:</strong> ${escapeHtml(m.principle)}</p>` : ''}${m.summary ? textParas(m.summary) : ''}`;
      const leftover = [];
      let r = seed(html, /exposition|big idea|^\s*1\./i, lead); html = r.html; if (!r.done && lead) leftover.push(`<h2>From the Study</h2>${lead}`);
      r = seed(html, /inquisition|discussion|question/i, listHtml(m.questions)); html = r.html; if (!r.done && m.questions.length) leftover.push(`<h2>Questions</h2>${listHtml(m.questions)}`);
      r = seed(html, /application|took/i, m.application ? textParas(m.application) : ''); html = r.html; if (!r.done && m.application) leftover.push(`<h2>Application</h2>${textParas(m.application)}`);
      html += leftover.join('');
      const notebook = s.notebook_id && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(s.notebook_id) ? s.notebook_id : studyNotebook();
      const noteId = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(notebook, title, html, htmlToText(html), now, now).lastInsertRowid);
      db.prepare('UPDATE study_items SET note_id = ? WHERE id = ?').run(noteId, itemId);
      recordMethod(noteId, method ?? parseData(s.data).lessonLayout ?? 'hblt');
      db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'lesson', ?)
        ON CONFLICT(study_id, note_id) DO UPDATE SET role = 'lesson'`).run(s.id, noteId, now);
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(now, s.id);
      syncTask(itemId);
      addForward(bs, { kind: 'lesson', note_id: noteId, title, study: s.title });
      return { note_id: noteId, item_id: itemId };
    });
  });
  app.post('/api/bible-studies/:id/writing', async (req) => {
    const bs = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    const s = db.prepare("SELECT * FROM studies WHERE id = ? AND kind = 'writing'").get(intParam(b.study_id));
    if (!s) throw httpError(400, 'Choose a writing project');
    const m = material(b);
    const title = clip(b.title, 300) || bs.passage || 'Untitled Chapter';
    return tx(() => {
      const now = Date.now();
      const ref = bs.refs.length ? parse(bs.passage).refs[0] : null;
      const html = [
        ref ? passageLink(bs.passage, ref) : '',
        m.principle ? `<p><strong>${escapeHtml(m.principle)}</strong></p>` : '',
        m.summary ? textParas(m.summary) : '',
        m.application ? textParas(m.application) : '',
        m.keeper ? `<blockquote><p>${escapeHtml(m.keeper)}</p></blockquote>` : '',
      ].join('') || '<p></p>';
      const notebook = s.notebook_id && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(s.notebook_id) ? s.notebook_id : studyNotebook();
      const noteId = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(notebook, title, html, htmlToText(html), now, now).lastInsertRowid);
      const position = (db.prepare("SELECT MAX(position) AS p FROM study_notes WHERE study_id = ? AND role = 'chapter'").get(s.id).p ?? 0) + 1;
      db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at, position, status) VALUES (?, ?, 'chapter', ?, ?, 'outline')`).run(s.id, noteId, now, position);
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(now, s.id);
      addForward(bs, { kind: 'writing', note_id: noteId, title, study: s.title });
      return { note_id: noteId };
    });
  });
  // A sermon started from a study (the sermon builder makes it; this records the link).
  app.post('/api/bible-studies/:id/forward', async (req) => {
    const bs = getStudy(intParam(req.params.id));
    const b = req.body ?? {};
    const noteId = intParam(b.note_id);
    if (!['sermon', 'lesson', 'writing'].includes(b.kind)) throw httpError(400, 'Unknown kind');
    addForward(bs, { kind: b.kind, note_id: noteId, title: clip(b.title, 300) });
    return getStudy(bs.id);
  });

  /**
   * The studies behind a sermon, lesson or chapter: the ones it was started from, then others of its passage.
   * { workflow, studies: [{ note_id, title, passage, keeper }] } (workflow null: an ordinary note, nothing to show).
   */
  app.get('/api/notes/:id/from-studies', async (req) => {
    const noteId = intParam(req.params.id);
    const workflow = workflowOf(noteId);
    if (!workflow) return { workflow: null, studies: [] };
    const all = db.prepare(`${STUDY_SELECT} WHERE n.deleted_at IS NULL AND b.note_id != ?`).all(noteId).map(studyRow);
    const linked = all.filter((s) => (s.data.forward ?? []).some((f) => f.note_id === noteId) || s.data.sermon_note_id === noteId);
    // The note's passage: its sermon's, its schedule item's, else the first reference near its top.
    const note = db.prepare('SELECT title, text FROM notes WHERE id = ?').get(noteId);
    const item = db.prepare('SELECT ref, title FROM study_items WHERE note_id = ? ORDER BY id LIMIT 1').get(noteId);
    const candidates = [db.prepare('SELECT passage FROM sermons WHERE note_id = ?').get(noteId)?.passage, item?.ref, item?.title, note.title];
    let refs = [];
    for (const c of candidates) {
      const p = parse(String(c ?? ''));
      if (p.refs.length && !p.errors.length) { refs = p.refs; break; }
    }
    if (!refs.length) refs = findReferences(`${note.title}\n${note.text.slice(0, 400)}`)[0]?.refs ?? [];
    const overlap = all.filter((s) => !linked.includes(s) && s.refs.some((x) => refs.some((y) => x.start <= y.end && x.end >= y.start)));
    return {
      workflow,
      studies: [...linked, ...overlap].slice(0, 4).map((s) => ({ note_id: s.note_id, title: s.title, passage: s.passage, keeper: s.data.keeper ?? '', linked: linked.includes(s) })),
    };
  });

  // Taking a note off the studies list keeps the note.
  app.delete('/api/bible-studies/:id', async (req) => {
    db.prepare('DELETE FROM bible_studies WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // ---- verse notes ----
  // Body: { book, chapter, verse, text }: a new note titled with the verse. Or { ref, text | html } for a note on a
  // passage (a photo of your Bible's margins read into text).
  app.post('/api/verse-notes', async (req) => {
    const b = req.body ?? {};
    if (b.ref) {
      const { refs, errors } = parse(clip(b.ref, 200));
      if (!refs.length || errors.length) throw httpError(400, 'Not a Bible reference');
      const html = typeof b.html === 'string' && b.html.length < 200_000 ? b.html : null;
      const text = String(b.text ?? '').trim().slice(0, MAX_NOTE * 4);
      if (!html && !text) throw httpError(400, 'Write something first');
      return tx(() => addVerseNote({ label: refs.map((r) => format(r)).join('; '), text, html }));
    }
    const bk = book(Number(b.book));
    const ch = Number(b.chapter);
    const v = Number(b.verse);
    if (!bk || !Number.isInteger(ch) || ch < 1 || ch > bk.chapters || !Number.isInteger(v) || v < 1 || v > 200) throw httpError(400, 'Unknown verse');
    const text = String(b.text ?? '').trim().slice(0, MAX_NOTE);
    if (!text) throw httpError(400, 'Write something first');
    return tx(() => addVerseNote({ label: verseLabel(bk.order, ch, v), text }));
  });
  // ?ref=Romans 8:28-30: the verse notes on a passage (for hover cards).
  app.get('/api/verse-notes', async (req) => {
    const { refs } = parse(String(req.query.ref ?? '').slice(0, 200));
    return passageNotes(refs).filter((n) => n.kind === 'verse')
      .map((n) => ({ id: n.id, ref: n.title, text: n.text, key: n.verse }))
      .sort((a, b) => a.key - b.key);
  });

  /**
   * The weekly review: studies and verse notes from the last `days` days (default 7) with their keepers, plus when
   * you studied over the last half year (save times; the browser groups them into its own weeks).
   */
  app.get('/api/bible-studies/review', async (req) => {
    const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
    const since = Date.now() - days * 86_400_000;
    const studies = db.prepare(`${STUDY_SELECT} WHERE n.deleted_at IS NULL AND n.updated_at >= ? ORDER BY n.updated_at DESC`).all(since).map(studyRow);
    const verseIds = db.prepare(`SELECT DISTINCT l.note_id FROM bible_study_log l JOIN notes n ON n.id = l.note_id
      WHERE l.kind = 'verse' AND n.deleted_at IS NULL AND n.updated_at >= ?`).all(since).map((r) => r.note_id);
    const verses = verseIds.length ? db.prepare(`SELECT id, title, text, updated_at FROM notes WHERE id IN (${verseIds.map(() => '?').join(',')}) ORDER BY title`)
      .all(...verseIds).map((n) => ({ ...n, text: n.text.replace(/^\s*\S.*?\n/, '').trim().slice(0, 400) })) : [];
    const activity = db.prepare('SELECT at FROM bible_study_log WHERE at >= ? ORDER BY at').all(Date.now() - 183 * 86_400_000).map((r) => r.at);
    return { since, studies, verses, activity };
  });
}
