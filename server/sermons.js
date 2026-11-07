import { db, tx } from './db.js';
import { htmlToText } from './html.js';
import { setNoteTags } from './tags.js';
import { snapshot } from './links.js';
import { blocksToHtml, rtfToBlocks } from './rtf.js';
import { findReferences, format, parse } from '../shared/scripture.js';
import { validMethod } from '../shared/methods.js';
import { recordMethod } from './methods.js';

/**
 * Sermons. A sermon is a note (laid out for the McDill builder: Introduction, the divisions, Conclusion) plus what
 * the builder keeps beside it: its passage, whether it's ready, the study worksheet and a target length. A sermon can
 * belong to a sermon series (a Studies "preaching" study, where it's one of the dated sessions). Each time it's
 * preached goes in the log (date, place, occasion, length). Sermons written in Logos come in from its RTF export.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['building', 'ready'];
const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

db.exec(`
CREATE TABLE IF NOT EXISTS sermons (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  study_id INTEGER REFERENCES studies(id) ON DELETE SET NULL,
  passage TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'building',
  source TEXT NOT NULL DEFAULT 'selah',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sermon_preachings (
  id INTEGER PRIMARY KEY,
  sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  occasion TEXT NOT NULL DEFAULT '',
  minutes INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sermon_preachings_sermon ON sermon_preachings(sermon_id, date);
CREATE TABLE IF NOT EXISTS sermon_bank (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'illustration',
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '',
  passage TEXT NOT NULL DEFAULT '',
  source_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sermon_bank_uses (
  bank_id INTEGER NOT NULL REFERENCES sermon_bank(id) ON DELETE CASCADE,
  sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (bank_id, sermon_id)
);`);
// Clipped from the web: the page it came from, and the sermon it was clipped for (shown first in that sermon's bank).
const bankCols = db.prepare('PRAGMA table_info(sermon_bank)').all().map((c) => c.name);
if (!bankCols.includes('source_url')) db.exec("ALTER TABLE sermon_bank ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
if (!bankCols.includes('source_page')) db.exec("ALTER TABLE sermon_bank ADD COLUMN source_page TEXT NOT NULL DEFAULT ''");
if (!bankCols.includes('for_sermon_id')) db.exec('ALTER TABLE sermon_bank ADD COLUMN for_sermon_id INTEGER REFERENCES sermons(id) ON DELETE SET NULL');

/** Kinds of reusable material in the sermon bank. */
const BANK_KINDS = ['illustration', 'quote', 'scripture', 'application', 'other'];
const BANK_SELECT = `SELECT b.*, n.title AS source_title,
    (SELECT json_group_array(json_object('sermon_id', u.sermon_id, 'note_id', s.note_id, 'title', sn.title, 'used_at', u.used_at))
       FROM sermon_bank_uses u JOIN sermons s ON s.id = u.sermon_id JOIN notes sn ON sn.id = s.note_id
       WHERE u.bank_id = b.id AND sn.deleted_at IS NULL) AS uses
  FROM sermon_bank b LEFT JOIN notes n ON n.id = b.source_note_id AND n.deleted_at IS NULL`;
const bankRow = (r) => ({ ...r, uses: (() => { try { return JSON.parse(r.uses) ?? []; } catch { return []; } })() });
function getBankItem(id) {
  const r = db.prepare(`${BANK_SELECT} WHERE b.id = ?`).get(id);
  if (!r) throw httpError(404, 'Bank item not found');
  return bankRow(r);
}
/** The fields of a bank item from a request body (only those present). */
function bankFields(b) {
  const out = {};
  if ('kind' in b) {
    if (!BANK_KINDS.includes(b.kind)) throw httpError(400, 'Unknown kind');
    out.kind = b.kind;
  }
  if ('title' in b) out.title = clip(b.title, 300);
  if ('html' in b) {
    const html = String(b.html ?? '');
    if (html.length > 200_000) throw httpError(413, 'That’s too long for the bank');
    out.html = html;
    out.text = htmlToText(html);
  }
  if ('topics' in b) out.topics = (Array.isArray(b.topics) ? b.topics : String(b.topics ?? '').split(',')).map((t) => clip(t, 60)).filter(Boolean).join(', ');
  if ('passage' in b) out.passage = cleanPassage(b.passage);
  if ('source_note_id' in b) out.source_note_id = b.source_note_id ? intParam(b.source_note_id) : null;
  if ('for_sermon_id' in b) out.for_sermon_id = b.for_sermon_id ? intParam(b.for_sermon_id) : null;
  // Where it came from: a web page (the clipper).
  if ('source_url' in b) out.source_url = /^https?:\/\//i.test(String(b.source_url ?? '')) ? clip(b.source_url, 2000) : '';
  if ('source_page' in b) out.source_page = clip(b.source_page, 300);
  return out;
}

/** A new bank item from bankFields() plus, from the clipper, source_url and source_page. */
export function addBankItem(f) {
  if (!f.html?.trim() && !f.title) throw httpError(400, 'Write something to keep');
  if (f.source_note_id && !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(f.source_note_id)) f.source_note_id = null;
  if (f.for_sermon_id) getSermon(f.for_sermon_id);
  const now = Date.now();
  const keys = Object.keys(f);
  const id = Number(db.prepare(`INSERT INTO sermon_bank (${[...keys, 'created_at', 'updated_at'].join(', ')}) VALUES (${[...keys, 1, 2].map(() => '?').join(', ')})`)
    .run(...keys.map((k) => f[k]), now, now).lastInsertRowid);
  return getBankItem(id);
}
export { bankFields };

/** Sermons the clipper can clip for: the ones still being built first, then the latest. */
export const clipSermons = () => db.prepare(`SELECT s.id, n.title, s.passage, s.status FROM sermons s JOIN notes n ON n.id = s.note_id
  WHERE n.deleted_at IS NULL ORDER BY (s.status = 'building') DESC, s.updated_at DESC LIMIT 30`).all();
/** Topics already used in the bank, for the clipper's suggestions. */
export const bankTopics = () => [...new Set(db.prepare("SELECT topics FROM sermon_bank WHERE topics != ''").all()
  .flatMap((r) => r.topics.split(',').map((t) => t.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b));

const SERMON_SELECT = `
  SELECT s.*, n.title, n.notebook_id, n.updated_at AS note_updated, n.deleted_at, st.title AS series, st.color AS series_color,
    (SELECT COUNT(*) FROM sermon_preachings p WHERE p.sermon_id = s.id) AS preached,
    (SELECT MAX(date) FROM sermon_preachings p WHERE p.sermon_id = s.id) AS last_preached,
    (SELECT place FROM sermon_preachings p WHERE p.sermon_id = s.id ORDER BY date DESC, id DESC LIMIT 1) AS last_place,
    length(n.text) AS chars
  FROM sermons s JOIN notes n ON n.id = s.note_id
  LEFT JOIN studies st ON st.id = s.study_id`;

function sermonRow(r) {
  const { data, chars, deleted_at, ...s } = r;
  // About 6 characters a word, preached at about 130 words a minute.
  return { ...s, data: parseData(data), minutes_est: chars ? Math.max(1, Math.round(chars / 6 / 130)) : 0, trashed: !!deleted_at };
}
function getSermon(id) {
  const r = db.prepare(`${SERMON_SELECT} WHERE s.id = ?`).get(id);
  if (!r) throw httpError(404, 'Sermon not found');
  return sermonRow(r);
}
const preachingsOf = (sermonId) => db.prepare('SELECT * FROM sermon_preachings WHERE sermon_id = ? ORDER BY date DESC, id DESC').all(sermonId);

/** The "Sermons" notebook, made when first needed. */
function sermonsNotebook() {
  const found = db.prepare("SELECT id FROM notebooks WHERE name = 'Sermons' COLLATE NOCASE ORDER BY id LIMIT 1").get();
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run('Sermons', Date.now()).lastInsertRowid);
}
const notebookOr = (id, fallback) => (id && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id) ? id : fallback());

/** A passage as typed, tidied when it reads as a Bible reference ("mt 7:1-6" → "Matthew 7:1–6"). */
function cleanPassage(v) {
  const text = clip(v, 200);
  if (!text) return '';
  const { refs, errors } = parse(text);
  return refs.length && !errors.length ? refs.map((r) => format(r)).join('; ') : text;
}

function linkToStudy(studyId, noteId) {
  db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'sermon', ?)
    ON CONFLICT(study_id, note_id) DO UPDATE SET role = 'sermon'`).run(studyId, noteId, Date.now());
}

/** Puts a sermon in a series: it joins the series' notes and, unless one already has it, its schedule (undated). */
function placeInSeries(sermon, studyId, { done = false } = {}) {
  const study = db.prepare("SELECT id FROM studies WHERE id = ? AND kind = 'preaching'").get(studyId);
  if (!study) throw httpError(400, 'That isn’t a sermon series');
  linkToStudy(study.id, sermon.note_id);
  if (!db.prepare('SELECT 1 FROM study_items WHERE study_id = ? AND note_id = ?').get(study.id, sermon.note_id)) {
    const title = db.prepare('SELECT title FROM notes WHERE id = ?').get(sermon.note_id)?.title || 'Sermon';
    const position = (db.prepare('SELECT MAX(position) AS p FROM study_items WHERE study_id = ?').get(study.id).p ?? 0) + 1;
    db.prepare(`INSERT INTO study_items (study_id, kind, title, ref, note_id, position, done_at, data, created_at)
      VALUES (?, 'session', ?, ?, ?, ?, ?, '{}', ?)`).run(study.id, title.slice(0, 300), sermon.passage ?? '', sermon.note_id, position, done ? Date.now() : null, Date.now());
  }
  db.prepare('UPDATE sermons SET study_id = ? WHERE id = ?').run(study.id, sermon.id);
}
/** Takes a sermon out of its series (undated schedule rows for it go; dated ones lose the note). */
function leaveSeries(sermon) {
  if (!sermon.study_id) return;
  db.prepare('DELETE FROM study_notes WHERE study_id = ? AND note_id = ?').run(sermon.study_id, sermon.note_id);
  db.prepare('DELETE FROM study_items WHERE study_id = ? AND note_id = ? AND date IS NULL AND task_id IS NULL').run(sermon.study_id, sermon.note_id);
  db.prepare('UPDATE study_items SET note_id = NULL WHERE study_id = ? AND note_id = ?').run(sermon.study_id, sermon.note_id);
  db.prepare('UPDATE sermons SET study_id = NULL WHERE id = ?').run(sermon.id);
}

function newNote(notebookId, title, html, createdAt = Date.now()) {
  return Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(notebookId, title.slice(0, 500), html, htmlToText(html), createdAt, Date.now()).lastInsertRowid);
}

function insertSermon(noteId, f) {
  const now = Date.now();
  return Number(db.prepare(`INSERT INTO sermons (note_id, passage, status, source, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET updated_at = excluded.updated_at RETURNING id`)
    .get(noteId, f.passage ?? '', f.status ?? 'building', f.source ?? 'selah', JSON.stringify(f.data ?? {}), now, now).id);
}

/** The sermon for a note, made when a note that isn't one yet is preached or opened in the builder. */
function ensureSermon(noteId) {
  const found = db.prepare('SELECT id FROM sermons WHERE note_id = ?').get(noteId);
  if (found) return found.id;
  const note = db.prepare('SELECT text FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
  if (!note) throw httpError(404, 'Note not found');
  const ref = findReferences(note.text.slice(0, 2000))[0];
  return insertSermon(noteId, { passage: ref ? ref.refs.map((r) => format(r)).join('; ') : '' });
}

function preachingFields(b) {
  const f = {};
  if ('date' in b) {
    if (!DATE_RE.test(String(b.date ?? ''))) throw httpError(400, 'Dates are YYYY-MM-DD');
    f.date = String(b.date);
  }
  if ('place' in b) f.place = clip(b.place, 200);
  if ('occasion' in b) f.occasion = clip(b.occasion, 200);
  if ('notes' in b) f.notes = String(b.notes ?? '').slice(0, 5000);
  if ('minutes' in b) f.minutes = b.minutes == null || b.minutes === '' ? null : Math.max(0, Math.min(600, Math.round(Number(b.minutes)) || 0)) || null;
  return f;
}

// ---------- Logos RTF import ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "October 18, 2026", "10/18/2026" or "2026-10-18" as YYYY-MM-DD, else null. */
function readDate(text) {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(?:[a-z]+,\s*)?([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(t);
  const month = m && MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (m && month >= 0) return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
const isPassage = (text) => {
  const { refs, errors } = parse(text, { prefixes: false });
  return refs.length > 0 && !errors.length;
};

/**
 * Reads a Logos Sermon Builder export. Its top: the title (a bordered Heading 1), the author, then a line like
 * "Series / Topic; Topic / Matthew 7:1–6" (with a date when the sermon has one), then a divider. The rest is the
 * sermon, which Logos lays out the way the builder does (Introduction, divisions, Conclusion).
 */
export function readLogosSermon(rtf, name = '') {
  const { blocks, images } = rtfToBlocks(rtf);
  let body = blocks;
  const meta = { title: name.replace(/\.rtf$/i, '').trim() || 'Sermon', author: '', series: '', topics: [], passage: '', date: null };
  if (blocks[0]?.type === 'h' && blocks[0].level === 1) {
    meta.title = blocks[0].text || meta.title;
    // The header runs to the divider (an empty bordered paragraph) within the first few lines.
    const end = blocks.slice(1, 8).findIndex((b) => b.type === 'p' && b.border && !b.text.replace(/ /g, '').trim());
    const header = end >= 0 ? blocks.slice(1, end + 1) : [];
    body = end >= 0 ? blocks.slice(end + 2) : blocks.slice(1);
    for (const line of header.map((b) => b.text.trim()).filter(Boolean)) {
      if (!line.includes(' / ')) {
        if (isPassage(line)) meta.passage = meta.passage || line;
        else if (readDate(line)) meta.date = readDate(line);
        else if (!meta.author) meta.author = line;
        continue;
      }
      const rest = [];
      for (const part of line.split(' / ').map((p) => p.trim()).filter(Boolean)) {
        if (isPassage(part)) meta.passage = part;
        else if (readDate(part)) meta.date = readDate(part);
        else rest.push(part);
      }
      // What's left: the series first, then the topics (separated by semicolons).
      if (rest.length === 1 && rest[0].includes(';')) meta.topics = rest[0].split(';');
      else {
        meta.series = rest[0] ?? '';
        meta.topics = rest.slice(1).join(';').split(';');
      }
      meta.topics = meta.topics.map((t) => t.trim()).filter(Boolean);
    }
  }
  if (/^(ad hoc|none|no series)$/i.test(meta.series)) meta.series = '';
  if (meta.passage) meta.passage = cleanPassage(meta.passage);
  const html = blocksToHtml(body);
  return { ...meta, html, words: htmlToText(html).split(/\s+/).filter(Boolean).length, images };
}

/** A preaching study named `title`, made (with its own notebook link) when there isn't one. */
function seriesNamed(title, notebookId) {
  const found = db.prepare("SELECT id FROM studies WHERE kind = 'preaching' AND title = ? COLLATE NOCASE").get(title);
  if (found) return found.id;
  const now = Date.now();
  return Number(db.prepare(`INSERT INTO studies (title, kind, status, color, notebook_id, data, created_at, updated_at)
    VALUES (?, 'preaching', 'active', 'purple', ?, '{}', ?, ?)`).run(title.slice(0, 200), notebookId, now, now).lastInsertRowid);
}

export default async function sermonRoutes(app) {
  // ---------- the bank: reusable illustrations, quotes and the like, for any sermon ----------
  app.get('/api/sermon-bank', async () => db.prepare(`${BANK_SELECT} ORDER BY b.updated_at DESC`).all().map(bankRow));
  app.post('/api/sermon-bank', async (req) => addBankItem(bankFields(req.body ?? {})));
  app.patch('/api/sermon-bank/:id', async (req) => {
    const item = getBankItem(intParam(req.params.id));
    const f = bankFields(req.body ?? {});
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE sermon_bank SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), Date.now(), item.id);
    return getBankItem(item.id);
  });
  app.delete('/api/sermon-bank/:id', async (req) => {
    db.prepare('DELETE FROM sermon_bank WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });
  // Used in a sermon (dragged into it on the Arrange board).
  app.post('/api/sermon-bank/:id/uses', async (req) => {
    const item = getBankItem(intParam(req.params.id));
    const sermonId = intParam(req.body?.sermon_id);
    getSermon(sermonId);
    db.prepare('INSERT INTO sermon_bank_uses (bank_id, sermon_id, used_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET used_at = excluded.used_at').run(item.id, sermonId, Date.now());
    return getBankItem(item.id);
  });

  app.get('/api/sermons', async () => db.prepare(`${SERMON_SELECT} WHERE n.deleted_at IS NULL ORDER BY s.updated_at DESC`).all().map(sermonRow));

  /**
   * Body: { title, passage?, html?, notebook_id?, study_id?, study_item_id?, note_id? }. A new sermon note (html is
   * the builder's skeleton), or `note_id` to make an existing note a sermon. With study_item_id it's that series
   * session's sermon.
   */
  app.post('/api/sermons', async (req) => {
    const b = req.body ?? {};
    return tx(() => {
      const item = b.study_item_id ? db.prepare(`SELECT i.*, s.kind AS study_kind, s.notebook_id AS study_notebook FROM study_items i
        JOIN studies s ON s.id = i.study_id WHERE i.id = ?`).get(intParam(b.study_item_id)) : null;
      if (b.study_item_id && !item) throw httpError(404, 'Session not found');
      const studyId = item ? item.study_id : b.study_id ? intParam(b.study_id) : null;
      const study = studyId ? db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId) : null;
      let noteId = b.note_id ? intParam(b.note_id) : null;
      if (noteId && !db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId)) throw httpError(404, 'Note not found');
      const passage = cleanPassage(b.passage ?? item?.ref ?? '');
      if (!noteId) {
        const title = clip(b.title ?? item?.title, 300) || 'Untitled sermon';
        const nb = notebookOr(b.notebook_id ? intParam(b.notebook_id) : study?.notebook_id, sermonsNotebook);
        noteId = newNote(nb, title, typeof b.html === 'string' ? b.html : '<p></p>');
        recordMethod(noteId, validMethod('sermon', b.method) ?? 'mcdill');
      }
      const id = insertSermon(noteId, { passage });
      if (passage) db.prepare("UPDATE sermons SET passage = ? WHERE id = ? AND passage = ''").run(passage, id);
      if (item) {
        db.prepare('UPDATE study_items SET note_id = ? WHERE id = ?').run(noteId, item.id);
        if (item.task_id) db.prepare('UPDATE tasks SET note_id = ? WHERE id = ?').run(noteId, item.task_id);
      }
      if (study?.kind === 'preaching') {
        linkToStudy(study.id, noteId);
        if (item) db.prepare('UPDATE sermons SET study_id = ? WHERE id = ?').run(study.id, id);
        else placeInSeries(getSermon(id), study.id);
      }
      return { id, note_id: noteId };
    });
  });

  app.get('/api/sermons/:id', async (req) => {
    const s = getSermon(intParam(req.params.id));
    return { ...s, preachings: preachingsOf(s.id) };
  });

  // The sermon a note is (or null), for the note's header, the builder and preaching mode.
  app.get('/api/notes/:id/sermon', async (req) => {
    const r = db.prepare(`${SERMON_SELECT} WHERE s.note_id = ?`).get(intParam(req.params.id));
    return r ? { ...sermonRow(r), preachings: preachingsOf(r.id) } : null;
  });
  // Makes a note a sermon (if it isn't) and returns it.
  app.post('/api/notes/:id/sermon', async (req) => {
    const id = tx(() => ensureSermon(intParam(req.params.id)));
    return { ...getSermon(id), preachings: preachingsOf(id) };
  });

  // Body: { passage?, status?, study_id? (null leaves the series), data? (merged) }.
  app.patch('/api/sermons/:id', async (req) => {
    const s = getSermon(intParam(req.params.id));
    const b = req.body ?? {};
    return tx(() => {
      const sets = ['updated_at = ?'];
      const args = [Date.now()];
      if ('passage' in b) {
        sets.push('passage = ?'); args.push(cleanPassage(b.passage));
        db.prepare("UPDATE study_items SET ref = ? WHERE note_id = ? AND study_id = ? AND kind = 'session'").run(cleanPassage(b.passage), s.note_id, s.study_id ?? 0);
      }
      if ('status' in b) {
        if (!STATUSES.includes(b.status)) throw httpError(400, 'Unknown status');
        sets.push('status = ?'); args.push(b.status);
        // Ready to preach is the builder's "complete" (methods.js), and the other way round.
        if (b.status === 'ready') db.prepare('INSERT INTO note_complete (note_id, completed_at) VALUES (?, ?) ON CONFLICT(note_id) DO NOTHING').run(s.note_id, Date.now());
        else db.prepare('DELETE FROM note_complete WHERE note_id = ?').run(s.note_id);
      }
      if ('data' in b && b.data && typeof b.data === 'object') {
        const json = JSON.stringify({ ...s.data, ...b.data });
        if (json.length > 200_000) throw httpError(413, 'The worksheet is too long');
        sets.push('data = ?'); args.push(json);
      }
      db.prepare(`UPDATE sermons SET ${sets.join(', ')} WHERE id = ?`).run(...args, s.id);
      if ('study_id' in b && (b.study_id ?? null) !== (s.study_id ?? null)) {
        leaveSeries(s);
        if (b.study_id) placeInSeries(getSermon(s.id), intParam(b.study_id));
      }
      return getSermon(s.id);
    });
  });

  /**
   * The builder writes the sermon note: { html, title?, base_updated_at? }. The note as it was goes into its version
   * history first. Refused (409, with the newer note) when the note changed after the builder opened it.
   */
  // (On the note's own address, so open editors hear that it changed.)
  app.put('/api/notes/:id/sermon', async (req, reply) => {
    const s = getSermon(tx(() => ensureSermon(intParam(req.params.id))));
    const b = req.body ?? {};
    if (typeof b.html !== 'string') throw httpError(400, 'Nothing to write');
    const now = db.prepare('SELECT title, html, updated_at FROM notes WHERE id = ?').get(s.note_id);
    if (typeof b.base_updated_at === 'number' && now.updated_at > b.base_updated_at && !b.overwrite) {
      reply.code(409);
      return { error: 'The sermon note changed while the builder was open', conflict: true, note: now };
    }
    return tx(() => {
      snapshot(s.note_id, { reason: 'Before the sermon builder saved', force: true });
      const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 500) : now.title;
      db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, updated_at = ? WHERE id = ?').run(title, b.html, htmlToText(b.html), Date.now(), s.note_id);
      if (title !== now.title) db.prepare("UPDATE study_items SET title = ? WHERE note_id = ? AND kind = 'session'").run(title.slice(0, 300), s.note_id);
      db.prepare('UPDATE sermons SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(s.note_id);
    });
  });

  // Taking a note off the Sermons page keeps the note (and forgets its log).
  app.delete('/api/sermons/:id', async (req) => {
    const s = getSermon(intParam(req.params.id));
    tx(() => {
      if (s.study_id) db.prepare("UPDATE study_notes SET role = 'note' WHERE study_id = ? AND note_id = ?").run(s.study_id, s.note_id);
      db.prepare('DELETE FROM sermons WHERE id = ?').run(s.id);
    });
    return { ok: true };
  });

  // ---- the preached log ----
  app.get('/api/preachings', async () => db.prepare(`SELECT p.*, s.note_id, s.passage, n.title, st.title AS series
    FROM sermon_preachings p JOIN sermons s ON s.id = p.sermon_id JOIN notes n ON n.id = s.note_id
    LEFT JOIN studies st ON st.id = s.study_id
    WHERE n.deleted_at IS NULL ORDER BY p.date DESC, p.id DESC`).all());

  // Logs a preaching of a note (it becomes a sermon if it isn't one). Body: { date, place, occasion, minutes, notes }.
  app.post('/api/notes/:id/preached', async (req) => {
    const noteId = intParam(req.params.id);
    const f = preachingFields({ date: null, ...(req.body ?? {}) });
    return tx(() => {
      const sermonId = ensureSermon(noteId);
      const id = Number(db.prepare(`INSERT INTO sermon_preachings (sermon_id, date, place, occasion, minutes, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sermonId, f.date, f.place ?? '', f.occasion ?? '', f.minutes ?? null, f.notes ?? '', Date.now()).lastInsertRowid);
      // A dated session in its series on that day counts as done.
      const s = getSermon(sermonId);
      if (s.study_id) {
        for (const it of db.prepare('SELECT id, task_id FROM study_items WHERE study_id = ? AND note_id = ? AND (date = ? OR date IS NULL)').all(s.study_id, noteId, f.date)) {
          db.prepare('UPDATE study_items SET done_at = COALESCE(done_at, ?) WHERE id = ?').run(Date.now(), it.id);
          if (it.task_id) db.prepare('UPDATE tasks SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), it.task_id);
        }
      }
      db.prepare('UPDATE sermons SET updated_at = ? WHERE id = ?').run(Date.now(), sermonId);
      return { id, sermon_id: sermonId };
    });
  });

  app.patch('/api/preachings/:id', async (req) => {
    const id = intParam(req.params.id);
    const f = preachingFields(req.body ?? {});
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE sermon_preachings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    return db.prepare('SELECT * FROM sermon_preachings WHERE id = ?').get(id) ?? (() => { throw httpError(404, 'Not found'); })();
  });

  app.delete('/api/preachings/:id', async (req) => {
    db.prepare('DELETE FROM sermon_preachings WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  /**
   * Logos sermons. Body: { files: [{ name, rtf }], commit?, notebook_id?, tags?, series?, skip?: [names] }.
   * Without commit it's a preview: what each file holds, and whether it's already here (same title and passage).
   * With commit each becomes a sermon note (topics as tags, the series as a sermon series, a date as a preaching).
   */
  app.post('/api/sermons/import', async (req) => {
    const b = req.body ?? {};
    const files = Array.isArray(b.files) ? b.files.slice(0, 200) : [];
    if (!files.length) throw httpError(400, 'Choose the RTF files Logos exported');
    const read = files.map((f) => {
      const name = clip(f.name, 300);
      try {
        const r = readLogosSermon(String(f.rtf ?? ''), name);
        const duplicate = db.prepare(`SELECT s.note_id FROM sermons s JOIN notes n ON n.id = s.note_id
          WHERE n.deleted_at IS NULL AND n.title = ? COLLATE NOCASE AND s.passage = ?`).get(r.title, r.passage)?.note_id ?? null;
        return { name, ...r, duplicate };
      } catch (e) {
        return { name, error: e.statusCode === 400 ? e.message : 'Couldn’t read this file' };
      }
    });
    if (!b.commit) return read.map(({ html, ...r }) => r);
    const skip = new Set(Array.isArray(b.skip) ? b.skip : []);
    return tx(() => {
      const nb = notebookOr(b.notebook_id ? intParam(b.notebook_id) : null, sermonsNotebook);
      const made = [];
      for (const r of read) {
        if (r.error || skip.has(r.name)) continue;
        const noteId = newNote(nb, r.title, r.html);
        const id = insertSermon(noteId, { passage: r.passage, status: 'ready', source: 'logos', data: { author: r.author || undefined } });
        if (b.tags !== false && r.topics.length) setNoteTags(noteId, r.topics);
        if (b.series !== false && r.series) placeInSeries(getSermon(id), seriesNamed(r.series, nb), { done: !!r.date });
        if (r.date) {
          db.prepare('INSERT INTO sermon_preachings (sermon_id, date, created_at) VALUES (?, ?, ?)').run(id, r.date, Date.now());
        }
        made.push({ id, note_id: noteId, title: r.title });
      }
      return { made };
    });
  });
}
