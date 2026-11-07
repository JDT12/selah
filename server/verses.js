import { db, tx } from './db.js';
import { favorite, passage, translations } from './bible.js';
import { passageLessons, passageNotes } from './biblestudy.js';
import { BOOKS, END, book, format, parse, sortKey } from '../shared/scripture.js';

/**
 * The passage page's pieces: a passage's text verse by verse (in a chosen translation, server/bible.js), everything written on it (studies, sermons, lessons,
 * verse notes and other notes; see biblestudy.js), and the memory verse list.
 *
 * Memory verses keep only their reference: their text comes from the ESV cache like any other lookup, which stays
 * within Crossway's 500-verse limit on stored text.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const MAX_CHAPTERS = 6; // per passage page

db.exec(`
CREATE TABLE IF NOT EXISTS memory_verses (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  position REAL NOT NULL,
  practiced INTEGER NOT NULL DEFAULT 0,
  practiced_at INTEGER,
  created_at INTEGER NOT NULL
);`);

/** "Romans 8:28" for a verse. */
const verseLabel = (b, ch, v) => format({ book: b, ch_start: ch, v_start: v, ch_end: ch, v_end: v });

/** One reference, or a 400. */
function oneRef(q) {
  const { refs, errors } = parse(String(q ?? '').slice(0, 200));
  if (!refs.length) throw httpError(400, errors[0] ?? 'Not a Bible reference');
  return refs;
}

/**
 * Verses of an ESV text: [{ v, text }] (poetry lines kept as \n), plus anything before the first verse number
 * (a psalm's title) as verse 0.
 */
export function splitVerses(text) {
  const parts = text.split(/\[(\d+)\]\s*/);
  const out = [];
  if (parts[0].trim()) out.push({ v: 0, text: parts[0].trim() });
  for (let i = 1; i < parts.length; i += 2) out.push({ v: Number(parts[i]), text: parts[i + 1].replace(/\s+$/, '') });
  return out;
}

/** A whole chapter's verses in translation `tr` (in two lookups for the one chapter over 100 verses, Psalm 119). */
async function chapterVerses(b, ch, tr) {
  const whole = format({ book: b, ch_start: ch, v_start: 0, ch_end: ch, v_end: END });
  try {
    return splitVerses((await passage(whole, tr)).text);
  } catch (e) {
    if (e.statusCode !== 400 || !/verses/.test(e.message)) throw e;
    const name = b === 19 ? 'Psalm' : book(b).name;
    const first = splitVerses((await passage(`${name} ${ch}:1-100`, tr)).text);
    // Psalm 119, the one chapter over 100 verses, has 176 (asked for exactly: API.Bible refuses verses that don't exist).
    const rest = splitVerses((await passage(`${name} ${ch}:101-176`, tr)).text).filter((x) => x.v > 0);
    return [...first, ...rest];
  }
}

export default async function verseRoutes(app) {
  /**
   * ?q=Romans 8:28-39: the passage chapter by chapter, only the verses asked for, with what's written on it and which
   * verses are memory verses. Without the ESV the text is missing (esv: false) but the notes still come.
   */
  app.get('/api/verses/passage', async (req) => {
    const refs = oneRef(req.query.q);
    const chapters = [];
    for (const r of refs) {
      for (let ch = r.ch_start; ch <= r.ch_end && chapters.length < MAX_CHAPTERS; ch += 1) {
        const from = ch === r.ch_start ? r.v_start : 0;
        const to = ch === r.ch_end ? r.v_end : END;
        chapters.push({ book: r.book, chapter: ch, from, to, whole: from <= 1 && to === END, verses: [] });
      }
    }
    let error = null;
    const tr = String(req.query.t ?? '').slice(0, 100) || favorite();
    for (const c of chapters) {
      try {
        c.verses = (await chapterVerses(c.book, c.chapter, tr ?? ''))
          .filter((x) => (x.v === 0 ? c.from <= 1 : x.v >= c.from && x.v <= c.to))
          .map((x) => ({ ...x, key: sortKey(c.book, c.chapter, x.v), ref: x.v ? verseLabel(c.book, c.chapter, x.v) : null }));
      } catch (e) {
        error = e.message;
        break;
      }
    }
    const notes = passageNotes(refs);
    const b = book(refs[0].book);
    const last = chapters[chapters.length - 1];
    return {
      reference: refs.map((r) => r.label).join('; '),
      refs: refs.map((r) => r.label),
      chapters: chapters.map((c) => ({ ...c, label: format({ book: c.book, ch_start: c.chapter, v_start: 0, ch_end: c.chapter, v_end: END }) })),
      notes,
      lessons: passageLessons(refs, notes),
      memory: db.prepare('SELECT id, ref, start, "end" FROM memory_verses').all()
        .filter((m) => refs.some((r) => m.start <= r.end && m.end >= r.start)),
      // Neighbours to move on to: the chapters before and after.
      prev: chapters[0].chapter > 1 ? format({ book: b.order, ch_start: chapters[0].chapter - 1, v_start: 0, ch_end: chapters[0].chapter - 1, v_end: END })
        : b.order > 1 ? format({ book: b.order - 1, ch_start: BOOKS[b.order - 2].chapters, v_start: 0, ch_end: BOOKS[b.order - 2].chapters, v_end: END }) : null,
      next: last.chapter < book(last.book).chapters ? format({ book: last.book, ch_start: last.chapter + 1, v_start: 0, ch_end: last.chapter + 1, v_end: END })
        : last.book < 66 ? format({ book: last.book + 1, ch_start: 1, v_start: 0, ch_end: 1, v_end: END }) : null,
      esv: !error,
      error,
      // The translation the text is in, and its credit.
      translation: translations().find((t) => t.id === tr) ?? null,
    };
  });

  // ---- memory verses ----
  app.get('/api/memory-verses', async () => db.prepare('SELECT * FROM memory_verses ORDER BY position, id').all());

  // Body: { ref: 'Romans 8:28' } (one passage, up to a chapter).
  app.post('/api/memory-verses', async (req) => {
    const refs = oneRef(req.body?.ref);
    if (refs.length > 1) throw httpError(400, 'Add one passage at a time');
    const r = refs[0];
    if (r.ch_start !== r.ch_end && r.v_start === 0) throw httpError(400, 'That’s more than a chapter; pick the verses to learn');
    const dupe = db.prepare('SELECT id FROM memory_verses WHERE start = ? AND "end" = ?').get(r.start, r.end);
    if (dupe) return { id: dupe.id, existing: true };
    const position = (db.prepare('SELECT MAX(position) AS p FROM memory_verses').get().p ?? 0) + 1;
    const id = Number(db.prepare('INSERT INTO memory_verses (ref, start, "end", position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(r.label, r.start, r.end, position, Date.now()).lastInsertRowid);
    return { id };
  });

  // Body: { ids: [...] }: the list in this order.
  app.post('/api/memory-verses/order', async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(intParam) : [];
    tx(() => ids.forEach((id, i) => db.prepare('UPDATE memory_verses SET position = ? WHERE id = ?').run(i + 1, id)));
    return { ok: true };
  });

  app.post('/api/memory-verses/:id/practiced', async (req) => {
    const id = intParam(req.params.id);
    if (!db.prepare('UPDATE memory_verses SET practiced = practiced + 1, practiced_at = ? WHERE id = ?').run(Date.now(), id).changes) throw httpError(404, 'Not on the list');
    return db.prepare('SELECT * FROM memory_verses WHERE id = ?').get(id);
  });

  app.delete('/api/memory-verses/:id', async (req) => {
    db.prepare('DELETE FROM memory_verses WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });
}
