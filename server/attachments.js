import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';
import { deckImages, slideFiles } from './slides.js';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { escapeHtml, htmlToText } from './html.js';
import { writeZip } from './zip.js';
import { dropHeic, heicJpeg, isHeic } from './heic.js';

/**
 * The attachment manager: every file in every note, with what it is, where it's used, how much room it takes,
 * previews, duplicates, and bulk download, move and delete. Deleting or moving here also takes the file out of
 * the note's text (an image or file block), which the note editor otherwise does itself.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const THUMBS = path.join(config.dataDir, 'cache', 'thumbs');
const THUMB_WIDTH = 360;
const MAX_ZIP = 3.5 * 1024 ** 3;
const MAX_IDS = 1000;
const LARGE = 10 * 1024 * 1024;

// Content hashes, filled in on demand ("Find duplicates"): files never change once stored.
db.exec(`CREATE TABLE IF NOT EXISTS attachment_hashes (
  id INTEGER PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
)`);

/** image | pdf | audio | video | document | other */
export function kindOf(mime, filename = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (/^(text\/|application\/(msword|vnd\.(openxmlformats|ms-|oasis)|rtf|json|xml|epub))/.test(mime)
    || /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|epub|pages|numbers|key)$/i.test(filename)) return 'document';
  return 'other';
}

/** The ways a note's HTML can point at an attachment. */
const refPatterns = (id) => [
  new RegExp(`<img\\b[^>]*\\bsrc="/api/files/${id}(?:[?"][^>]*)?>`, 'g'),
  new RegExp(`<div\\b[^>]*\\bdata-attachment="${id}"[^>]*>[\\s\\S]*?</div>`, 'g'),
];
const isReferenced = (html, id) => html.includes(`data-attachment="${id}"`) || new RegExp(`/api/files/${id}(?![0-9])`).test(html);

/** Takes an attachment out of a note's text; empty paragraphs left around an image are tidied. */
function stripRefs(html, id) {
  let out = html;
  for (const re of refPatterns(id)) out = out.replace(re, '');
  return out.replace(/<p>\s*<\/p>(?=\s*<p>\s*<\/p>)/g, '');
}
function saveHtml(noteId, html) {
  db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), Date.now(), noteId);
}
/** HTML for an attachment block, as the editor writes it. */
function blockHtml(a) {
  if (a.mime.startsWith('image/')) return `<img src="/api/files/${a.id}" alt="${escapeHtml(a.filename)}">`;
  return `<div data-attachment="${a.id}" data-filename="${escapeHtml(a.filename)}" data-mime="${escapeHtml(a.mime)}" data-size="${a.size}">${escapeHtml(a.filename)}</div>`;
}

// ---------- hashing and thumbnails ----------

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
let scanning = null;
/** Hashes every attachment not hashed yet. One scan at a time. */
function scanHashes() {
  scanning ??= (async () => {
    const todo = db.prepare('SELECT a.id, a.storage FROM attachments a LEFT JOIN attachment_hashes h ON h.id = a.id WHERE h.id IS NULL').all();
    const ins = db.prepare('INSERT OR REPLACE INTO attachment_hashes (id, sha256) VALUES (?, ?)');
    let done = 0;
    for (const a of todo) {
      try {
        ins.run(a.id, await sha256(path.join(config.filesDir, a.storage)));
        done++;
      } catch {
        // missing file: left unhashed
      }
    }
    return done;
  })().finally(() => { scanning = null; });
  return scanning;
}

// Thumbnails are made by ffmpeg (already used for recordings), two at a time, and kept in the data directory.
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= 2) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}
const making = new Map();
const unreadable = new Set(); // files ffmpeg couldn't read, so they aren't tried on every request
function thumbnail(a) {
  const dest = path.join(THUMBS, `${a.storage}.jpg`);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (!ffmpegPath || unreadable.has(a.storage)) return Promise.resolve(null);
  if (making.has(dest)) return making.get(dest);
  const p = slot(async () => {
    // A HEIC photo is read from its JPEG copy (ffmpeg would only see one tile of it).
    const src = isHeic(a.mime, a.filename) ? await heicJpeg(a) : path.join(config.filesDir, a.storage);
    return new Promise((resolve) => {
    if (!src) { unreadable.add(a.storage); resolve(null); return; }
    fs.mkdirSync(THUMBS, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp.jpg`;
    // For a video, ffmpeg's thumbnail filter picks a representative frame from the opening seconds.
    const video = a.mime.startsWith('video/');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-frames:v', '1', '-vf', `${video ? 'thumbnail,' : ''}scale='min(${THUMB_WIDTH},iw)':-2`, '-q:v', '4', tmp];
    execFile(ffmpegPath, args, { timeout: Math.min(60_000, config.jobTimeout) }, (err) => {
      if (err || !fs.existsSync(tmp)) {
        fs.rm(tmp, { force: true }, () => {});
        unreadable.add(a.storage);
        resolve(null);
        return;
      }
      fs.renameSync(tmp, dest);
      resolve(dest);
    });
    });
  }).finally(() => making.delete(dest));
  making.set(dest, p);
  return p;
}
export const dropThumbs = (storages) => {
  for (const s of storages) fs.rm(path.join(THUMBS, `${s}.jpg`), { force: true }, () => {});
  dropHeic(storages);
};

// ---------- listing ----------

function allRows() {
  return db.prepare(`SELECT a.id, a.note_id, a.filename, a.mime, a.size, a.storage, a.created_at,
      n.title AS note_title, n.deleted_at AS note_deleted, n.is_template, n.notebook_id, nb.name AS notebook, h.sha256
    FROM attachments a LEFT JOIN notes n ON n.id = a.note_id LEFT JOIN notebooks nb ON nb.id = n.notebook_id
    LEFT JOIN attachment_hashes h ON h.id = a.id`).all();
}

function annotate(rows) {
  const htmlFor = new Map();
  const html = (noteId) => {
    // A picture on one of the note's slides counts as used, like one in its text.
    if (!htmlFor.has(noteId)) htmlFor.set(noteId, (db.prepare('SELECT html FROM notes WHERE id = ?').get(noteId)?.html ?? '') + deckImages(noteId).map((id) => `/api/files/${id}"`).join(''));
    return htmlFor.get(noteId);
  };
  const bySha = new Map();
  for (const r of rows) if (r.sha256) bySha.set(r.sha256, (bySha.get(r.sha256) ?? 0) + 1);
  // A class's syllabus PDF (11.0) has no note: it's used by its class.
  const syllabi = new Map();
  for (const c of db.prepare("SELECT title, data FROM studies WHERE kind = 'class'").all()) {
    try { const id = JSON.parse(c.data || '{}').syllabusPdf?.id; if (id) syllabi.set(id, c.title); } catch { /* bad data */ }
  }
  // 11.0: the church logo and the slide media library (no note either).
  for (const [id, label] of slideFiles()) syllabi.set(id, label);
  return rows.map((r) => ({
    id: r.id,
    noteId: r.note_id,
    noteTitle: r.note_title ?? (syllabi.has(r.id) ? (/^(Slide media|Church logo)$/.test(syllabi.get(r.id)) ? syllabi.get(r.id) : `Syllabus: ${syllabi.get(r.id)}`) : null),
    notebookId: r.notebook_id ?? null,
    notebook: r.notebook ?? null,
    filename: r.filename,
    mime: r.mime,
    kind: kindOf(r.mime, r.filename),
    size: r.size,
    createdAt: r.created_at,
    inTrash: !!r.note_deleted,
    template: !!r.is_template,
    referenced: r.note_id ? isReferenced(html(r.note_id), r.id) : syllabi.has(r.id),
    copies: r.sha256 ? bySha.get(r.sha256) : null,
    sha: r.sha256 ?? null,
    thumb: r.mime.startsWith('image/') && r.mime !== 'image/svg+xml' ? 'image' : r.mime.startsWith('video/') ? 'video' : null,
  }));
}

const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt || b.id - a.id,
  oldest: (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  largest: (a, b) => b.size - a.size || b.id - a.id,
  smallest: (a, b) => a.size - b.size || a.id - b.id,
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }) || a.id - b.id,
  note: (a, b) => (a.noteTitle ?? '').localeCompare(b.noteTitle ?? '') || a.id - b.id,
};

function summary(items, hashedAll) {
  const byKind = {};
  let bytes = 0;
  for (const a of items) {
    byKind[a.kind] = byKind[a.kind] ?? { count: 0, bytes: 0 };
    byKind[a.kind].count++;
    byKind[a.kind].bytes += a.size;
    bytes += a.size;
  }
  const sum = (list) => ({ count: list.length, bytes: list.reduce((n, a) => n + a.size, 0) });
  // Duplicates: every copy after the first of the same content.
  const seen = new Set();
  const extra = items.filter((a) => a.sha && (seen.has(a.sha) ? true : (seen.add(a.sha), false)));
  return {
    count: items.length, bytes, byKind,
    trash: sum(items.filter((a) => a.inTrash)),
    unused: sum(items.filter((a) => !a.referenced && !a.inTrash)),
    large: sum(items.filter((a) => a.size >= LARGE)),
    duplicates: hashedAll ? sum(extra) : null,
  };
}

// ---------- routes ----------

export default async function attachmentRoutes(app) {
  // ?q&kind&notebook&filter=trash|unused|large|duplicates&sort&offset&limit
  app.get('/api/attachments', async (req) => {
    const q = req.query;
    const all = annotate(allRows());
    const hashedAll = all.every((a) => a.sha);
    const words = String(q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    let list = all;
    if (words.length) list = list.filter((a) => words.every((w) => `${a.filename} ${a.noteTitle ?? ''} ${a.notebook ?? ''}`.toLowerCase().includes(w)));
    if (q.kind) list = list.filter((a) => a.kind === q.kind);
    if (q.notebook) list = list.filter((a) => a.notebookId === Number(q.notebook));
    if (q.filter === 'trash') list = list.filter((a) => a.inTrash);
    else if (q.filter === 'unused') list = list.filter((a) => !a.referenced && !a.inTrash);
    else if (q.filter === 'large') list = list.filter((a) => a.size >= LARGE);
    else if (q.filter === 'duplicates') list = list.filter((a) => a.copies > 1);
    const sort = SORTS[q.sort] ?? SORTS.newest;
    // Duplicates sit together: by content, then the oldest copy first.
    list = q.filter === 'duplicates' ? [...list].sort((a, b) => a.sha.localeCompare(b.sha) || a.createdAt - b.createdAt) : [...list].sort(sort);
    const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit, 10) || 120));
    return {
      items: list.slice(offset, offset + limit),
      total: list.length,
      totalBytes: list.reduce((n, a) => n + a.size, 0),
      summary: summary(all, hashedAll),
      hashedAll,
      ffmpeg: !!ffmpegPath,
    };
  });

  // One attachment with the other notes that hold the same file.
  app.get('/api/attachments/:id', async (req) => {
    const id = intParam(req.params.id);
    const all = annotate(allRows());
    const a = all.find((x) => x.id === id);
    if (!a) throw httpError(404, 'Attachment not found');
    return { ...a, sameAs: a.sha ? all.filter((x) => x.sha === a.sha && x.id !== id) : [] };
  });

  app.post('/api/attachments/scan', async () => ({ hashed: await scanHashes() }));

  app.get('/api/attachments/:id/thumb', async (req, reply) => {
    const a = db.prepare('SELECT id, mime, storage FROM attachments WHERE id = ?').get(intParam(req.params.id));
    if (!a || !(a.mime.startsWith('image/') || a.mime.startsWith('video/')) || a.mime === 'image/svg+xml') throw httpError(404, 'No preview');
    const file = await thumbnail(a);
    if (!file) throw httpError(404, 'No preview');
    // Asked for each time (attachment numbers can be reused), answered 304 while it's the same file.
    const etag = `"${a.storage}"`;
    reply.header('Cache-Control', 'private, no-cache').header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.type('image/jpeg');
    return fs.createReadStream(file);
  });

  // Body: { filename }: renames the file everywhere the note shows it.
  app.patch('/api/attachments/:id', async (req) => {
    const id = intParam(req.params.id);
    const a = db.prepare('SELECT note_id, filename FROM attachments WHERE id = ?').get(id);
    if (!a) throw httpError(404, 'Attachment not found');
    let name = path.basename(String(req.body?.filename ?? '').replace(/[\\/]/g, '-')).trim().slice(0, 255);
    if (!name) throw httpError(400, 'Give the file a name.');
    // Keep the extension unless a new one is typed.
    const ext = path.extname(a.filename);
    if (ext && !path.extname(name)) name = `${name}${ext}`;
    tx(() => {
      db.prepare('UPDATE attachments SET filename = ? WHERE id = ?').run(name, id);
      const note = a.note_id && db.prepare('SELECT html FROM notes WHERE id = ?').get(a.note_id);
      if (note) {
        const html = note.html
          .replace(new RegExp(`(<div\\b[^>]*\\bdata-attachment="${id}"[^>]*\\bdata-filename=")[^"]*(")`, 'g'), `$1${escapeHtml(name)}$2`)
          .replace(new RegExp(`(<div\\b[^>]*\\bdata-attachment="${id}"[^>]*>)[^<]*(</div>)`, 'g'), `$1${escapeHtml(name)}$2`);
        if (html !== note.html) db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(html, htmlToText(html), a.note_id);
      }
    });
    return { id, filename: name };
  });

  // Body: { ids, note_id }: moves files to another note, out of their old notes' text and onto the end of the new one.
  app.post('/api/attachments/move', async (req) => {
    const ids = idList(req.body?.ids);
    const target = intParam(req.body?.note_id);
    const note = db.prepare('SELECT html FROM notes WHERE id = ? AND deleted_at IS NULL').get(target);
    if (!note) throw httpError(404, 'Note not found');
    let moved = 0;
    tx(() => {
      let targetHtml = note.html;
      const rows = ids.map((id) => db.prepare('SELECT id, note_id, filename, mime, size FROM attachments WHERE id = ?').get(id)).filter(Boolean);
      for (const a of rows) {
        if (a.note_id === target) continue;
        const from = a.note_id && db.prepare('SELECT html FROM notes WHERE id = ?').get(a.note_id);
        if (from) saveHtml(a.note_id, stripRefs(from.html, a.id));
        db.prepare('UPDATE attachments SET note_id = ? WHERE id = ?').run(target, a.id);
        targetHtml += blockHtml(a);
        moved++;
      }
      if (moved) saveHtml(target, targetHtml);
    });
    return { moved };
  });

  // Body: { ids }: deletes files for good, taking them out of their notes' text.
  app.post('/api/attachments/delete', async (req) => {
    const ids = idList(req.body?.ids);
    const storages = [];
    tx(() => {
      const byNote = new Map();
      for (const id of ids) {
        const a = db.prepare('SELECT id, note_id, storage FROM attachments WHERE id = ?').get(id);
        if (!a) continue;
        storages.push(a.storage);
        if (a.note_id) byNote.set(a.note_id, [...(byNote.get(a.note_id) ?? []), a.id]);
        db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
      }
      for (const [noteId, gone] of byNote) {
        const note = db.prepare('SELECT html FROM notes WHERE id = ?').get(noteId);
        if (!note) continue;
        const html = gone.reduce((h, id) => stripRefs(h, id), note.html);
        if (html !== note.html) saveHtml(noteId, html);
      }
    });
    // A file shared by a copied note (same storage) stays while anything still uses it.
    const still = new Set(db.prepare(`SELECT storage FROM attachments WHERE storage IN (${storages.map(() => '?').join(',') || "''"})`).all(...storages).map((r) => r.storage));
    const free = storages.filter((s) => !still.has(s));
    unlinkStorage(free);
    dropThumbs(free);
    return { deleted: storages.length };
  });

  // ?ids=1,2,3: the files as one zip, named by note so files from different notes don't collide.
  app.get('/api/attachments/zip', async (req, reply) => {
    const ids = idList(String(req.query.ids ?? '').split(','));
    const rows = ids.map((id) => db.prepare(`SELECT a.id, a.filename, a.storage, a.size, a.created_at, n.title FROM attachments a
      LEFT JOIN notes n ON n.id = a.note_id WHERE a.id = ?`).get(id)).filter(Boolean);
    if (!rows.length) throw httpError(404, 'Nothing to download.');
    if (rows.reduce((n, r) => n + r.size, 0) > MAX_ZIP) throw httpError(413, 'That’s more than 3.5 GB; download fewer files at a time.');
    const used = new Set();
    const clean = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
    const entries = rows.map((r) => {
      const folder = clean(r.title || 'Untitled') || 'Untitled';
      let name = `${folder}/${clean(r.filename) || `file-${r.id}`}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) {
        const ext = path.extname(r.filename);
        name = `${folder}/${clean(path.basename(r.filename, ext))} (${n})${ext}`;
      }
      used.add(name.toLowerCase());
      return { name, file: path.join(config.filesDir, r.storage), mtime: r.created_at };
    });
    const out = new PassThrough();
    writeZip(out, entries).catch((err) => { req.log.error(err); out.destroy(err); });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="attachments-${stamp}.zip"`);
    return reply.send(out);
  });
}

function idList(v) {
  const ids = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw httpError(400, 'Choose some files.');
  if (ids.length > MAX_IDS) throw httpError(400, `Choose at most ${MAX_IDS} files at a time.`);
  return ids;
}
