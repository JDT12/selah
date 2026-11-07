import { db, getSetting, tx } from './db.js';
import { escapeHtml, htmlToText } from './html.js';
import { catchUp as catchUpScripture, IGNORED, notesFor } from './scripture.js';

/**
 * Linked notes and version history.
 *
 * A note link is `<a class="note-link" data-note-id="12" href="#note/12">Title</a>` (the editor's noteLink mark).
 * note_links is read from each note's HTML whenever the note has changed since it was last read (checked before
 * each query), like the Scripture index, so imports, copies and restores need no hooks.
 *
 * note_versions holds earlier copies of a note: the content from before each editing session (a save after
 * 10 quiet minutes), and before restores and other big changes. Older copies thin out (see thin()).
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};

db.exec(`
CREATE TABLE IF NOT EXISTS note_links (
  from_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS note_links_to ON note_links(to_id);
CREATE TABLE IF NOT EXISTS note_links_state (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_versions_note ON note_versions(note_id, created_at);`);

const LINK_RE = /<a\b[^>]*\bdata-note-id="(\d+)"[^>]*>/gi;
const linkTargets = (html) => new Set([...html.matchAll(LINK_RE)].map((m) => Number(m[1])));

/** Re-read the links of notes that changed since they were last read. */
export function catchUpLinks() {
  const stale = db.prepare(`
    SELECT n.id, n.html FROM notes n LEFT JOIN note_links_state s ON s.note_id = n.id
    WHERE s.note_id IS NULL OR s.indexed_at < n.updated_at`).all();
  if (!stale.length) return;
  const del = db.prepare('DELETE FROM note_links WHERE from_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO note_links (from_id, to_id) VALUES (?, ?)');
  const mark = db.prepare(`INSERT INTO note_links_state (note_id, indexed_at) VALUES (?, ?)
    ON CONFLICT(note_id) DO UPDATE SET indexed_at = excluded.indexed_at`);
  const now = Date.now();
  // Also called from inside other transactions (a rename), which can't be nested.
  (db.isTransaction ? (fn) => fn() : tx)(() => {
    for (const n of stale) {
      del.run(n.id);
      for (const to of linkTargets(n.html)) if (to !== n.id) ins.run(n.id, to);
      mark.run(n.id, now);
    }
  });
}

/**
 * After a note is renamed, links to it that still show the old title show the new one. Links with their own
 * text are left alone. The linking notes keep their "updated" time: nothing in them was edited by you.
 */
export function renameLinks(id, oldTitle, newTitle) {
  if (!oldTitle || oldTitle === newTitle) return;
  catchUpLinks();
  const from = db.prepare('SELECT n.id, n.html FROM note_links l JOIN notes n ON n.id = l.from_id WHERE l.to_id = ?').all(id);
  const re = new RegExp(`(<a\\b[^>]*\\bdata-note-id="${id}"[^>]*>)${escapeRe(escapeHtml(oldTitle))}(</a>)`, 'g');
  const update = db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?');
  for (const n of from) {
    const html = n.html.replace(re, (_, open, close) => `${open}${escapeHtml(newTitle || 'Untitled')}${close}`);
    if (html !== n.html) update.run(html, htmlToText(html), n.id);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';

/** A short piece of text either side of position [start, end) of `text`, cut at line breaks and word edges. */
function around(text, start, end) {
  let before = text.slice(Math.max(0, start - 120), start).split('\n').pop();
  let after = text.slice(end, end + 160).split('\n')[0];
  if (start - 120 > 0 && before.length >= 120) before = `…${before.replace(/^\S*\s/, '')}`;
  if (after.length >= 160) after = `${after.replace(/\s\S*$/, '')}…`;
  return { before, match: text.slice(start, end), after };
}

/** Context for a link inside HTML: the text before the anchor, its text, and the text after. */
function linkContext(html, id) {
  const m = new RegExp(`<a\\b[^>]*\\bdata-note-id="${id}"[^>]*>([\\s\\S]*?)</a>`, 'i').exec(html);
  if (!m) return null;
  const before = htmlToText(html.slice(Math.max(0, m.index - 800), m.index).replace(/^[^<]*>/, '') + '\u0000');
  const match = htmlToText(m[1]);
  const after = htmlToText('\u0000' + html.slice(m.index + m[0].length, m.index + m[0].length + 800).replace(/<[^>]*$/, ''));
  // htmlToText trims; the NUL markers keep the spaces next to the link.
  const text = `${before.slice(0, -1)}${match}${after.slice(1)}`;
  const start = before.length - 1;
  return around(text, start, start + match.length);
}

function mentionRegex(title) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRe(title)})(?!${WORD})`, 'iu');
}

/** Wraps the first plain-text mention of `title` in `html` (outside links and code) in a link to note `id`. */
export function linkFirstMention(html, title, id) {
  const re = mentionRegex(escapeHtml(title));
  const parts = html.split(/(<[^>]+>)/);
  let inLink = 0;
  let inCode = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.startsWith('<')) {
      if (/^<a[\s>]/i.test(p)) inLink += 1;
      else if (/^<\/a>/i.test(p)) inLink = Math.max(0, inLink - 1);
      else if (/^<(code|pre)[\s>]/i.test(p)) inCode += 1;
      else if (/^<\/(code|pre)>/i.test(p)) inCode = Math.max(0, inCode - 1);
      continue;
    }
    if (inLink || inCode) continue;
    const m = re.exec(p);
    if (!m) continue;
    const s = m.index + m[1].length;
    parts[i] = `${p.slice(0, s)}<a class="note-link" data-note-id="${id}" href="#note/${id}">${m[2]}</a>${p.slice(s + m[2].length)}`;
    return parts.join('');
  }
  return null;
}

// ---------- version history ----------

const SESSION_GAP = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Saves the note's current content as a version. Unless `force`, only when the last one is over 10 minutes old. */
export function snapshot(noteId, { reason = null, force = false } = {}) {
  const note = db.prepare('SELECT title, html FROM notes WHERE id = ?').get(noteId);
  if (!note || (!note.title && htmlToText(note.html) === '')) return;
  const last = db.prepare('SELECT title, html, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(noteId);
  if (last && last.title === note.title && last.html === note.html) return;
  if (!force && last && Date.now() - last.created_at < SESSION_GAP) return;
  db.prepare('INSERT INTO note_versions (note_id, title, html, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(noteId, note.title, note.html, reason, Date.now());
  thin(noteId);
}

/** Keeps every version from the last day, then the latest of each day for a month, then the latest of each week (marked drafts always). */
function thin(noteId) {
  const now = Date.now();
  // Drafts you marked (the Revise panel's "Mark this draft", reason "Draft: …") are kept however old.
  const rows = db.prepare("SELECT id, created_at FROM note_versions WHERE note_id = ? AND (reason IS NULL OR reason NOT LIKE 'Draft:%') ORDER BY created_at DESC, id DESC").all(noteId);
  const seen = new Set();
  const drop = [];
  for (const r of rows) {
    const age = now - r.created_at;
    if (age < DAY) continue;
    const bucket = age < 30 * DAY ? `d${Math.floor(r.created_at / DAY)}` : `w${Math.floor(r.created_at / (7 * DAY))}`;
    if (seen.has(bucket)) drop.push(r.id);
    else seen.add(bucket);
  }
  // A hard cap, oldest first, for notes edited all day every day.
  const keep = rows.filter((r) => !drop.includes(r.id));
  for (const r of keep.slice(300)) drop.push(r.id);
  const del = db.prepare('DELETE FROM note_versions WHERE id = ?');
  for (const id of drop) del.run(id);
}

export default async function linkRoutes(app) {
  // A small preview for link hover cards.
  app.get('/api/notes/:id/preview', async (req) => {
    const id = intParam(req.params.id);
    const n = db.prepare(`SELECT n.id, n.title, substr(n.text, 1, 500) AS text, n.updated_at, n.deleted_at, nb.name AS notebook
      FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id WHERE n.id = ?`).get(id);
    if (!n) throw httpError(404, 'This note no longer exists');
    return n;
  });

  // Notes connected to this one: links to it, plain mentions of its title, and notes on the same Scripture.
  app.get('/api/notes/:id/connections', async (req) => {
    const id = intParam(req.params.id);
    const note = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(id);
    if (!note) throw httpError(404, 'Note not found');
    catchUpLinks();
    const linkedRows = db.prepare(`
      SELECT n.id, n.title, n.html, n.updated_at, nb.name AS notebook FROM note_links l
      JOIN notes n ON n.id = l.from_id LEFT JOIN notebooks nb ON nb.id = n.notebook_id
      WHERE l.to_id = ? AND n.id != ? AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 100`).all(id, id);
    const linked = linkedRows.map(({ html, ...n }) => ({ ...n, context: linkContext(html, id) }));

    // "Only notes I link" (Settings): no title mentions or same-Scripture suggestions.
    const intentional = getSetting('pref.connectionsIntentional') === 'true';
    const unlinked = [];
    const title = note.title.trim();
    const terms = title.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!intentional && title.length >= 3 && terms.length) {
      const exclude = new Set([id, ...linked.map((n) => n.id)]);
      const re = mentionRegex(title);
      const rows = db.prepare(`
        SELECT n.id, n.title, n.text, n.updated_at, nb.name AS notebook FROM notes n
        JOIN notes_fts f ON f.rowid = n.id LEFT JOIN notebooks nb ON nb.id = n.notebook_id
        WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.is_template = 0
        ORDER BY n.updated_at DESC LIMIT 200`).all(`"${terms.join(' ')}"`);
      for (const n of rows) {
        if (exclude.has(n.id)) continue;
        const m = re.exec(n.text);
        if (!m) continue;
        const start = m.index + m[1].length;
        unlinked.push({ id: n.id, title: n.title, notebook: n.notebook, updated_at: n.updated_at, context: around(n.text, start, start + m[2].length) });
        if (unlinked.length >= 25) break;
      }
    }

    // A note whose tag leaves it out of the Scripture index has no Scripture connections either.
    const ignored = db.prepare(`SELECT ${IGNORED} AS x FROM notes n WHERE n.id = ?`).get(id).x;
    if (intentional || ignored) return { linked, unlinked, scripture: [], refs: [], intentional };
    catchUpScripture();
    const ranges = db.prepare('SELECT DISTINCT start, "end" FROM note_refs WHERE note_id = ?').all(id);
    const scripture = notesFor(ranges).filter((n) => n.id !== id).slice(0, 25)
      .map(({ snippet, ...n }) => n);
    const own = db.prepare('SELECT DISTINCT label FROM note_refs WHERE note_id = ? ORDER BY start').all(id).map((r) => r.label);
    return { linked, unlinked, scripture, refs: own, intentional };
  });

  // Turn the first plain mention of this note's title in another note into a link.
  app.post('/api/notes/:id/mentions/:from/link', async (req) => {
    const id = intParam(req.params.id);
    const fromId = intParam(req.params.from);
    const note = db.prepare('SELECT title FROM notes WHERE id = ?').get(id);
    const from = db.prepare('SELECT html FROM notes WHERE id = ? AND deleted_at IS NULL').get(fromId);
    if (!note || !from) throw httpError(404, 'Note not found');
    const html = linkFirstMention(from.html, note.title.trim(), id);
    if (!html) throw httpError(409, 'That mention is no longer in the note');
    return tx(() => {
      snapshot(fromId);
      db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), Date.now(), fromId);
      return { ok: true };
    });
  });

  // ---- version history ----
  app.get('/api/notes/:id/versions', async (req) => {
    const id = intParam(req.params.id);
    return db.prepare(`SELECT id, title, reason, created_at, length(html) AS size FROM note_versions
      WHERE note_id = ? ORDER BY created_at DESC, id DESC`).all(id);
  });
  app.get('/api/notes/:id/versions/:vid', async (req) => {
    const v = db.prepare('SELECT id, title, html, reason, created_at FROM note_versions WHERE id = ? AND note_id = ?')
      .get(intParam(req.params.vid), intParam(req.params.id));
    if (!v) throw httpError(404, 'Version not found');
    return v;
  });
  // Save the current content now (before a big change made in the editor, e.g. inserting a template).
  app.post('/api/notes/:id/versions', async (req) => {
    const id = intParam(req.params.id);
    snapshot(id, { reason: String(req.body?.reason ?? '').slice(0, 80) || null, force: true });
    return { ok: true };
  });
  app.post('/api/notes/:id/versions/:vid/restore', async (req) => {
    const id = intParam(req.params.id);
    const v = db.prepare('SELECT title, html FROM note_versions WHERE id = ? AND note_id = ?').get(intParam(req.params.vid), id);
    if (!v) throw httpError(404, 'Version not found');
    return tx(() => {
      const old = db.prepare('SELECT title FROM notes WHERE id = ?').get(id);
      snapshot(id, { reason: 'Before restoring an earlier version', force: true });
      db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, updated_at = ? WHERE id = ?')
        .run(v.title, v.html, htmlToText(v.html), Date.now(), id);
      renameLinks(id, old.title, v.title);
      return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(id);
    });
  });
}
