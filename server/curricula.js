import { db, tx } from './db.js';
import { config } from './config.js';
import { htmlToText } from './html.js';

/**
 * 14.5: lesson books. A lesson or sermon series (a teaching or preaching study) made into a printed resource: a cover,
 * contents, an introduction and a section per lesson, in two editions from the same lessons (a teacher guide and a
 * student book). The builder and the page layout are the client's (client/src/components/CurriculumBuilder.jsx);
 * here are its settings and the book's note.
 *
 * The book is a note too (its html is the teacher guide as last saved), so it can be found, opened, printed and shared
 * like any note. A package (.selahbook) carries the book and its lessons to another Selah, which imports them as a
 * new series.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const json = (s, d) => { try { return JSON.parse(s ?? 'null') ?? d; } catch { return d; } };
const KINDS = ['teaching', 'preaching'];
const MAX_DATA = 400_000;
const MAX_LESSONS = 60;

if (config.mode !== 'admin') db.exec(`
CREATE TABLE IF NOT EXISTS curricula (
  id INTEGER PRIMARY KEY,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  study_id INTEGER REFERENCES studies(id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS curricula_study ON curricula(study_id);`);

/** A series' lessons (or sermons), in order: its schedule's linked notes first, then its other notes. */
export function seriesLessons(studyId) {
  const items = db.prepare(`SELECT si.title AS item_title, si.date, si.ref, n.id, n.title, n.html, n.updated_at
    FROM study_items si JOIN notes n ON n.id = si.note_id
    WHERE si.study_id = ? AND n.deleted_at IS NULL ORDER BY si.position, si.id`).all(studyId);
  const seen = new Set(items.map((r) => r.id));
  const rest = db.prepare(`SELECT n.id, n.title, n.html, n.updated_at FROM study_notes sn JOIN notes n ON n.id = sn.note_id
    WHERE sn.study_id = ? AND n.deleted_at IS NULL AND sn.role IN ('lesson', 'sermon', 'note', 'session') ORDER BY sn.added_at`).all(studyId)
    .filter((r) => !seen.has(r.id) && !db.prepare('SELECT 1 FROM curricula WHERE note_id = ?').get(r.id));
  return [...items, ...rest].slice(0, MAX_LESSONS).map((r) => ({ id: r.id, title: r.title || r.item_title || 'Untitled', date: r.date ?? null, ref: r.ref ?? '', html: r.html, updated_at: r.updated_at }));
}

function row(id) {
  const c = db.prepare('SELECT * FROM curricula WHERE id = ?').get(id);
  if (!c) throw httpError(404, 'Lesson book not found');
  return c;
}
function detail(c) {
  const study = c.study_id ? db.prepare('SELECT id, title, kind, notebook_id FROM studies WHERE id = ?').get(c.study_id) : null;
  const note = c.note_id ? db.prepare('SELECT id, title, updated_at, deleted_at FROM notes WHERE id = ?').get(c.note_id) : null;
  return { id: c.id, note_id: c.note_id, study, note, data: json(c.data, {}), lessons: study ? seriesLessons(study.id) : [], updated_at: c.updated_at };
}

function notebookFor(study) {
  if (study?.notebook_id && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(study.notebook_id)) return study.notebook_id;
  return db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get()?.id
    ?? Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run('Notes', Date.now()).lastInsertRowid);
}

export default async function curricula(app) {
  // Lesson books made from a series (or all of them).
  app.get('/api/curricula', async (req) => {
    const where = req.query.study_id ? 'WHERE c.study_id = ?' : '';
    const args = req.query.study_id ? [intParam(req.query.study_id)] : [];
    return db.prepare(`SELECT c.id, c.note_id, c.study_id, c.updated_at, n.title FROM curricula c LEFT JOIN notes n ON n.id = c.note_id ${where} ORDER BY c.updated_at DESC`).all(...args);
  });

  app.post('/api/curricula', async (req) => {
    const studyId = intParam(req.body?.study_id);
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
    if (!study || !KINDS.includes(study.kind)) throw httpError(404, 'Series not found');
    return tx(() => {
      const now = Date.now();
      const title = String(req.body?.title ?? study.title).slice(0, 300) || study.title;
      // Read-only: the builder writes it (the teacher guide) each time the book is saved.
      const noteId = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, read_only, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(notebookFor(study), title, '', '', now, now).lastInsertRowid);
      db.prepare(`INSERT OR IGNORE INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'book', ?)`).run(studyId, noteId, now);
      const data = { title, subtitle: study.kind === 'preaching' ? 'A small-group guide' : 'A teaching series', ...(req.body?.data ?? {}) };
      const id = Number(db.prepare('INSERT INTO curricula (note_id, study_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(noteId, studyId, JSON.stringify(data), now, now).lastInsertRowid);
      return detail(row(id));
    });
  });

  app.get('/api/curricula/:id', async (req) => detail(row(intParam(req.params.id))));

  // The book's settings, and (html) the teacher guide as it now reads, kept as the book's note.
  app.put('/api/curricula/:id', async (req) => {
    const c = row(intParam(req.params.id));
    const data = req.body?.data;
    const text = JSON.stringify(data ?? {});
    if (text.length > MAX_DATA) throw httpError(413, 'This lesson book is too large');
    return tx(() => {
      const now = Date.now();
      db.prepare('UPDATE curricula SET data = ?, updated_at = ? WHERE id = ?').run(text, now, c.id);
      if (c.note_id && typeof req.body?.html === 'string') {
        db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, updated_at = ? WHERE id = ?')
          .run(String(data?.title ?? '').slice(0, 300) || 'Lesson book', req.body.html, htmlToText(req.body.html), now, c.note_id);
      }
      return detail(row(c.id));
    });
  });

  app.delete('/api/curricula/:id', async (req) => {
    const c = row(intParam(req.params.id));
    db.prepare('DELETE FROM curricula WHERE id = ?').run(c.id);
    if (c.note_id) db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), c.note_id);
    return { ok: true };
  });

  // A package for another Selah: the book's settings and its lessons as they are now.
  app.get('/api/curricula/:id/package', async (req, reply) => {
    const d = detail(row(intParam(req.params.id)));
    const pkg = {
      format: 'selah-lesson-book', version: 1, exported_at: new Date().toISOString(),
      kind: d.study?.kind ?? 'teaching', series: d.study?.title ?? '', book: d.data,
      lessons: d.lessons.map((l) => ({ key: String(l.id), title: l.title, ref: l.ref, html: l.html })),
    };
    const name = `${(d.data.title || 'Lesson book').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 100) || 'Lesson book'}.selahbook`;
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return pkg;
  });

  // Importing a package: a new series (in its own notebook) with the lessons as notes, and the book.
  app.post('/api/curricula/import', async (req) => {
    const p = req.body ?? {};
    if (p.format !== 'selah-lesson-book' || !Array.isArray(p.lessons)) throw httpError(400, 'That isn’t a Selah lesson book.');
    if (p.lessons.length > MAX_LESSONS) throw httpError(400, 'Too many lessons');
    const kind = KINDS.includes(p.kind) ? p.kind : 'teaching';
    const book = p.book && typeof p.book === 'object' ? p.book : {};
    const title = String(book.title || p.series || 'Lesson book').slice(0, 200);
    return tx(() => {
      const now = Date.now();
      const notebookId = Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run(title, now).lastInsertRowid);
      const studyId = Number(db.prepare(`INSERT INTO studies (title, kind, status, description, color, notebook_id, data, created_at, updated_at)
        VALUES (?, ?, 'active', ?, 'blue', ?, '{}', ?, ?)`).run(String(p.series || title).slice(0, 200), kind, 'Imported from a lesson book', notebookId, now, now).lastInsertRowid);
      const keys = {};
      p.lessons.forEach((l, i) => {
        const html = typeof l.html === 'string' ? l.html.slice(0, 2_000_000) : '';
        const noteId = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(notebookId, String(l.title ?? '').slice(0, 300), html, htmlToText(html), now, now).lastInsertRowid);
        db.prepare(`INSERT INTO study_items (study_id, kind, title, ref, note_id, position, data, created_at) VALUES (?, 'session', ?, ?, ?, ?, '{}', ?)`)
          .run(studyId, String(l.title ?? 'Lesson').slice(0, 300), String(l.ref ?? '').slice(0, 200), noteId, i + 1, now);
        db.prepare(`INSERT OR IGNORE INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'note', ?)`).run(studyId, noteId, now);
        keys[String(l.key ?? i)] = noteId;
      });
      // Per-lesson settings were keyed by the other Selah's note ids: moved to the new ones.
      const per = {};
      for (const [k, v] of Object.entries(book.lessons ?? {})) if (keys[k]) per[keys[k]] = v;
      const order = Array.isArray(book.order) ? book.order.map((k) => (String(k).startsWith('L:') ? (keys[String(k).slice(2)] ? `L:${keys[String(k).slice(2)]}` : null) : k)).filter(Boolean) : undefined;
      const data = { ...book, lessons: per, ...(order ? { order } : {}) };
      const bookNote = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, read_only, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(notebookId, title, '', '', now, now).lastInsertRowid);
      db.prepare(`INSERT OR IGNORE INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'book', ?)`).run(studyId, bookNote, now);
      const id = Number(db.prepare('INSERT INTO curricula (note_id, study_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(bookNote, studyId, JSON.stringify(data), now, now).lastInsertRowid);
      return { ...detail(row(id)), study_id: studyId };
    });
  });
}
