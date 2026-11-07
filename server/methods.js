import { db } from './db.js';
import { METHODS, methodById } from '../shared/methods.js';

/**
 * Which method each Bible study, lesson, sermon and piece of writing follows (shared/methods.js). Kept when a note is
 * made in one, or switched to another; notes from before 6.5 read theirs from what they are: a study is the
 * Interpretive Journey, a sermon the McDill skills, a lesson Hook, Book, Look, Took or the big idea and three points by
 * its headings, and a piece of writing its project's type.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};

db.exec(`
CREATE TABLE IF NOT EXISTS note_methods (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 7.3: a study, lesson or sermon marked complete on its builder's last page (Keeper, Ready to Teach, Oral Presentation).
CREATE TABLE IF NOT EXISTS note_complete (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL
);`);

/** When a builder's note was marked complete, or null. A sermon marked ready to preach counts (Logos imports are). */
export const completedAt = (noteId) => db.prepare('SELECT completed_at FROM note_complete WHERE note_id = ?').get(noteId)?.completed_at
  ?? db.prepare("SELECT updated_at FROM sermons WHERE note_id = ? AND status = 'ready'").get(noteId)?.updated_at ?? null;

/** Keeps the method a note follows (ignored when it isn't one we know). */
export function recordMethod(noteId, method) {
  if (!noteId || !methodById(method)) return;
  db.prepare(`INSERT INTO note_methods (note_id, method, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET method = excluded.method, updated_at = excluded.updated_at`).run(noteId, method, Date.now());
}

const LESSON_SQL = `SELECT
    EXISTS (SELECT 1 FROM study_notes WHERE note_id = :id AND role = 'lesson')
    OR EXISTS (SELECT 1 FROM study_items i JOIN studies s ON s.id = i.study_id WHERE i.note_id = :id AND i.kind = 'session' AND s.kind = 'teaching') AS lesson`;

/** The workflow and method a note follows, or null when it's an ordinary note (or a lesson made from your template). */
export function methodOfNote(noteId) {
  const note = db.prepare('SELECT html FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
  if (!note) return null;
  const stored = methodById(db.prepare('SELECT method FROM note_methods WHERE note_id = ?').get(noteId)?.method);
  if (stored) return { workflow: stored.workflow, method: stored.id, stored: true };
  if (db.prepare('SELECT 1 FROM bible_studies WHERE note_id = ?').get(noteId)) return { workflow: 'study', method: 'ggw', stored: false };
  if (db.prepare('SELECT 1 FROM sermons WHERE note_id = ?').get(noteId)) return { workflow: 'sermon', method: 'mcdill', stored: false };
  // A writing project's piece follows its project's type (null for a project without one, from before 6.6).
  const project = db.prepare(`SELECT s.data FROM study_notes sn JOIN studies s ON s.id = sn.study_id
    WHERE sn.note_id = ? AND sn.role = 'chapter' AND s.kind = 'writing' ORDER BY sn.added_at LIMIT 1`).get(noteId);
  if (project) {
    let type = null;
    try { type = JSON.parse(project.data)?.methods?.writing ?? null; } catch { /* no type */ }
    return { workflow: 'writing', method: methodById(type)?.workflow === 'writing' ? type : null, stored: false };
  }
  if (!db.prepare(LESSON_SQL).get({ id: noteId })?.lesson) return null;
  const heads = (tag) => [...note.html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const h1 = heads('h1');
  if (h1.some((t) => /hook/i.test(t)) && h1.some((t) => /took/i.test(t))) return { workflow: 'lesson', method: 'hblt', stored: false };
  const h2 = heads('h2');
  if (h2.some((t) => /big\s+idea/i.test(t)) && h2.some((t) => /^1\./.test(t))) return { workflow: 'lesson', method: 'points', stored: false };
  return { workflow: 'lesson', method: null, stored: false };
}

export default async function methodRoutes(app) {
  app.get('/api/notes/:id/method', async (req) => methodOfNote(intParam(req.params.id)));

  app.get('/api/notes/:id/complete', async (req) => ({ completed_at: completedAt(intParam(req.params.id)) }));
  // Body: { complete }. A sermon's status follows it: ready to preach when complete, still building when not.
  app.put('/api/notes/:id/complete', async (req) => {
    const noteId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId)) throw httpError(404, 'Note not found');
    const now = Date.now();
    if (req.body?.complete) db.prepare('INSERT INTO note_complete (note_id, completed_at) VALUES (?, ?) ON CONFLICT(note_id) DO NOTHING').run(noteId, now);
    else db.prepare('DELETE FROM note_complete WHERE note_id = ?').run(noteId);
    db.prepare('UPDATE sermons SET status = ?, updated_at = ? WHERE note_id = ?').run(req.body?.complete ? 'ready' : 'building', now, noteId);
    return { completed_at: completedAt(noteId) };
  });

  // After switching a note to another method (the client rewrites the note; this keeps which one it follows now).
  app.put('/api/notes/:id/method', async (req) => {
    const noteId = intParam(req.params.id);
    const m = methodById(req.body?.method);
    if (!m) throw httpError(400, `Unknown method (one of ${METHODS.map((x) => x.id).join(', ')})`);
    const cur = methodOfNote(noteId);
    if (!cur) throw httpError(404, 'That note isn’t a study, lesson, sermon or piece of writing');
    if (cur.workflow !== m.workflow) throw httpError(400, `A ${cur.workflow} can only switch to another ${cur.workflow} method`);
    recordMethod(noteId, m.id);
    return methodOfNote(noteId);
  });
}
