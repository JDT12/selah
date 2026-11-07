import { db } from './db.js';
import { parseData } from './studies.js';
import { completedAt } from './methods.js';
import { parse } from '../shared/scripture.js';

/**
 * 11.0: your work, one list: every Bible study (Interpretive Journey, background, word study), lesson and sermon, with
 * its passage, the builder step it was left on and whether it's done (marked complete on its builder's last page, or
 * from Home). Desk lists all of it; Home only what's still active; the passage page what covers its verses.
 */

/**
 * How many steps each builder has, numbered as the builder numbers them (StudyBuilder, ReferenceStudies,
 * LessonBuilder, SermonBuilder): its Start page isn't a step of its own, its last page (Keeper, Ready to Teach) is.
 * `start`: whether page 0 is that Start page (a word study begins at its first step).
 */
export const BUILDER_STEPS = { study: 6, background: 8, word: 7, lesson: 5, sermon: 12 };
const HAS_START = { study: true, background: true, word: false, lesson: true, sermon: true };

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
/** The step a builder was left on (its saved page index), as "Step N" of its steps. */
const step = (builder, page) => Math.min(BUILDER_STEPS[builder], Math.max(1, (Number(page) || 0) + (HAS_START[builder] ? 0 : 1)));

/** Every piece of work (trashed notes and templates left out), newest first. */
export function allWork() {
  const out = [];
  const studies = db.prepare(`SELECT b.note_id, b.passage, b.data, b.created_at, n.title, n.updated_at, COALESCE(m.method, 'ggw') AS method
    FROM bible_studies b JOIN notes n ON n.id = b.note_id AND n.deleted_at IS NULL AND n.is_template = 0
    LEFT JOIN note_methods m ON m.note_id = b.note_id`).all();
  for (const s of studies) {
    const d = parseData(s.data);
    const builder = s.method === 'background' || s.method === 'word' ? s.method : 'study';
    const passage = s.passage ?? '';
    out.push({ key: `n${s.note_id}`, kind: builder, tab: 'study', note_id: s.note_id, builder, title: s.title, passage,
      word: builder === 'word' ? (d.word?.english || null) : null,
      step: step(builder, d.step), steps: BUILDER_STEPS[builder], created_at: s.created_at, updated_at: s.updated_at });
  }
  const sermons = db.prepare(`SELECT s.note_id, s.passage, s.data, s.status, s.created_at, n.title, n.updated_at, st.title AS series
    FROM sermons s JOIN notes n ON n.id = s.note_id AND n.deleted_at IS NULL AND n.is_template = 0 LEFT JOIN studies st ON st.id = s.study_id`).all();
  for (const s of sermons) {
    const d = parseData(s.data);
    out.push({ key: `n${s.note_id}`, kind: 'sermon', tab: 'teach', note_id: s.note_id, builder: 'sermon', title: s.title, passage: s.passage ?? '',
      series: s.series ?? null, step: step('sermon', d.step), steps: BUILDER_STEPS.sermon, created_at: s.created_at, updated_at: s.updated_at });
  }
  // Lessons: a teaching session's note, a note filed as a study's lesson, or a note that follows a lesson method.
  const lessons = db.prepare(`SELECT n.id, n.title, n.created_at, n.updated_at,
      (SELECT i.ref FROM study_items i WHERE i.note_id = n.id AND i.kind = 'session' ORDER BY i.id LIMIT 1) AS ref,
      (SELECT i.data FROM study_items i WHERE i.note_id = n.id AND i.kind = 'session' ORDER BY i.id LIMIT 1) AS item_data,
      (SELECT i.date FROM study_items i WHERE i.note_id = n.id AND i.kind = 'session' ORDER BY i.id LIMIT 1) AS date,
      (SELECT s.title FROM study_items i JOIN studies s ON s.id = i.study_id WHERE i.note_id = n.id AND i.kind = 'session' ORDER BY i.id LIMIT 1) AS series
    FROM notes n WHERE n.deleted_at IS NULL AND n.is_template = 0
      AND NOT EXISTS (SELECT 1 FROM sermons WHERE note_id = n.id) AND NOT EXISTS (SELECT 1 FROM bible_studies WHERE note_id = n.id)
      AND (EXISTS (SELECT 1 FROM note_methods m WHERE m.note_id = n.id AND m.method IN ('hblt', 'points'))
        OR EXISTS (SELECT 1 FROM study_notes sn WHERE sn.note_id = n.id AND sn.role = 'lesson')
        OR EXISTS (SELECT 1 FROM study_items i JOIN studies t ON t.id = i.study_id WHERE i.note_id = n.id AND i.kind = 'session' AND t.kind = 'teaching'))`).all();
  for (const l of lessons) {
    const lesson = parseData(l.item_data).lesson ?? {};
    let passage = l.ref ?? '';
    if (!passage) passage = (parse(l.title ?? '').refs ?? []).map((r) => r.label).join('; ');
    out.push({ key: `n${l.id}`, kind: 'lesson', tab: 'teach', note_id: l.id, builder: 'lesson', title: l.title, passage, series: l.series ?? null,
      date: l.date ?? null, step: step('lesson', lesson.step), steps: BUILDER_STEPS.lesson, created_at: l.created_at, updated_at: l.updated_at });
  }
  for (const w of out) {
    w.completed_at = completedAt(w.note_id);
    w.done = !!w.completed_at;
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

/** The ranges a piece of work covers (its passage, or for a word study the verse its word is from). */
function rangesOf(w) {
  const { refs = [], errors = [] } = parse(w.passage ?? '');
  return errors.length && !refs.length ? [] : refs;
}

/** Work on any verse of `q` ("Ephesians 2:1-10"): studies, lessons and sermons whose passage overlaps it. */
export function workOn(q) {
  const { refs = [] } = parse(String(q ?? ''));
  if (!refs.length) throw httpError(400, 'Not a passage');
  // A book's background covers the whole book; it has its own card on the passage page.
  return allWork().filter((w) => w.kind !== 'background' && rangesOf(w).some((x) => refs.some((r) => x.start <= r.end && x.end >= r.start)));
}

export default async function workRoutes(app) {
  // ?passage=Ephesians 2:1-10 lists only the work on those verses.
  app.get('/api/work', async (req) => (req.query.passage ? workOn(req.query.passage) : allWork()));
}
