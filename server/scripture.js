import { db, tx } from './db.js';
import { BOOKS, book, findReferences, parse } from '../shared/scripture.js';
import { studiedChapters } from './biblestudy.js';

/**
 * The Scripture index: which notes mention which passages. A note is (re)read whenever it has changed since it
 * was last indexed (checked before each query), so edits, imports, copies and restores need no hooks. Bump
 * VERSION when the scanner changes to re-read every note.
 */
const VERSION = 2;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

db.exec(`
CREATE TABLE IF NOT EXISTS note_refs (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  book INTEGER NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  ch_start INTEGER NOT NULL,
  ch_end INTEGER NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_refs_range ON note_refs(start, "end");
CREATE INDEX IF NOT EXISTS note_refs_note ON note_refs(note_id);
CREATE TABLE IF NOT EXISTS note_refs_state (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  indexed_at INTEGER NOT NULL,
  version INTEGER NOT NULL
);`);

/** Re-read notes that changed since they were indexed. */
export function catchUp() {
  const stale = db.prepare(`
    SELECT n.id, n.title, n.text FROM notes n LEFT JOIN note_refs_state s ON s.note_id = n.id
    WHERE s.note_id IS NULL OR s.indexed_at < n.updated_at OR s.version != ?`).all(VERSION);
  if (!stale.length) return;
  const del = db.prepare('DELETE FROM note_refs WHERE note_id = ?');
  const ins = db.prepare('INSERT INTO note_refs (note_id, book, start, "end", ch_start, ch_end, label) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const mark = db.prepare(`INSERT INTO note_refs_state (note_id, indexed_at, version) VALUES (?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET indexed_at = excluded.indexed_at, version = excluded.version`);
  const now = Date.now();
  tx(() => {
    for (const n of stale) {
      del.run(n.id);
      const seen = new Set();
      for (const found of findReferences(`${n.title}\n${n.text}`)) {
        for (const r of found.refs) {
          const key = `${r.start}-${r.end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ins.run(n.id, r.book, r.start, r.end, r.ch_start, r.ch_end, r.label);
        }
      }
      mark.run(n.id, now, VERSION);
    }
  });
}

/** SQL: note `n` has a tag whose notes stay out of the Scripture index (Tags page). Checked when asked, so
 * tagging or untagging a note takes effect at once without re-reading it. */
export const IGNORED = `EXISTS (SELECT 1 FROM note_tags it JOIN tags t ON t.id = it.tag_id
  WHERE it.note_id = n.id AND t.ignore_scripture = 1)`;

/** Notes (not in the trash, not templates, not left out by a tag) that mention any part of the given ranges, with what they mention. */
export function notesFor(ranges) {
  if (!ranges.length) return [];
  const where = ranges.map(() => '(r.start <= ? AND r."end" >= ?)').join(' OR ');
  const args = ranges.flatMap((x) => [x.end, x.start]);
  const rows = db.prepare(`
    SELECT n.id, n.title, n.updated_at, nb.name AS notebook, substr(n.text, 1, 160) AS snippet,
           group_concat(DISTINCT r.label) AS labels, MIN(r.start) AS first
    FROM note_refs r JOIN notes n ON n.id = r.note_id LEFT JOIN notebooks nb ON nb.id = n.notebook_id
    WHERE n.deleted_at IS NULL AND n.is_template = 0 AND NOT ${IGNORED} AND (${where})
    GROUP BY n.id ORDER BY first, n.updated_at DESC`).all(...args);
  return rows.map(({ first, labels, ...n }) => ({ ...n, refs: (labels ?? '').split(',') }));
}

export default async function scriptureRoutes(app) {
  // How many notes mention each book and chapter, and which chapters have a Bible study (the coverage map).
  app.get('/api/scripture/summary', async () => {
    catchUp();
    const rows = db.prepare(`
      SELECT r.book, r.ch_start, r.ch_end, r.note_id FROM note_refs r JOIN notes n ON n.id = r.note_id
      WHERE n.deleted_at IS NULL AND n.is_template = 0 AND NOT ${IGNORED}`).all();
    const books = new Map();
    for (const r of rows) {
      const b = books.get(r.book) ?? { notes: new Set(), chapters: new Map() };
      b.notes.add(r.note_id);
      for (let ch = r.ch_start; ch <= r.ch_end; ch += 1) {
        const set = b.chapters.get(ch) ?? new Set();
        set.add(r.note_id);
        b.chapters.set(ch, set);
      }
      books.set(r.book, b);
    }
    const studied = studiedChapters();
    return {
      books: BOOKS.map((bk) => {
        const b = books.get(bk.order);
        return {
          ...bk,
          notes: b?.notes.size ?? 0,
          chapterNotes: b ? Object.fromEntries([...b.chapters].map(([ch, s]) => [ch, s.size])) : {},
          studied: studied[bk.order] ?? [],
        };
      }),
      total: new Set(rows.map((r) => r.note_id)).size,
    };
  });

  // Notes that mention a passage, e.g. ?q=Romans 8:28-30  or  ?book=45&chapter=8
  app.get('/api/scripture/notes', async (req) => {
    catchUp();
    let refs;
    let errors = [];
    if (req.query.book) {
      const b = book(Number(req.query.book));
      if (!b) throw httpError(400, 'Unknown book');
      const ch = Number(req.query.chapter) || 0;
      ({ refs, errors } = parse(ch ? `${b.name} ${ch}` : b.name));
    } else {
      ({ refs, errors } = parse(String(req.query.q ?? '').slice(0, 200)));
    }
    return { query: refs.map((r) => r.label), errors, notes: notesFor(refs) };
  });

  // The passages a note mentions (for the note's own Scripture panel).
  app.get('/api/scripture/note/:id', async (req) => {
    catchUp();
    return db.prepare('SELECT label, start, "end" FROM note_refs WHERE note_id = ? ORDER BY start').all(Number(req.params.id));
  });
}
