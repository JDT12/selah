import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, getSetting, setSetting, unlinkStorage } from './db.js';
import { config } from './config.js';
import { escapeHtml, htmlToText } from './html.js';
import { enmlToHtml } from './enml.js';
import { setNoteTags } from './tags.js';
import { myNotesId } from './mynotes.js';
import { fetchImages } from './wpsite.js';
import { snapshot } from './links.js';
import { writeZip } from './zip.js';
import { safeFetch } from './netguard.js';
import { logEvent, requireConfirmed } from './auth.js';
import { addBankItem, bankFields, bankTopics, clipSermons } from './sermons.js';
import { findReferences, format } from '../shared/scripture.js';

/**
 * Capture: the Inbox, quick capture, things shared to the app from a phone's share menu, and the Edge clipper.
 *
 * The Inbox is an ordinary notebook (settings.inboxNotebook), made the first time it's needed.
 * The clipper signs in with its own key (Settings → Browser extension → Connect gives a one-time code). A key can
 * only add notes and list notebook names, tags and note titles; it can't read or change notes.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

db.exec(`
CREATE TABLE IF NOT EXISTS clip_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);`);

const { version } = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'));
const EXTENSION_DIR = path.join(config.root, 'extension');
const SHARE_DIR = path.join(config.dataDir, 'shares');
const MAX_IMAGE = 20 * 1024 * 1024;

// ---------- the Inbox ----------

/** The Inbox notebook's id, making the notebook if it doesn't exist (or was deleted). */
export function inboxId({ create = true } = {}) {
  const id = Number(getSetting('inboxNotebook'));
  if (id && db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id)) return id;
  if (!create) return null;
  const found = db.prepare("SELECT id FROM notebooks WHERE name = 'Inbox' COLLATE NOCASE").get();
  const nb = found?.id ?? Number(db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run('Inbox', Date.now()).lastInsertRowid);
  setSetting('inboxNotebook', String(nb));
  return nb;
}

function notebookOrInbox(v) {
  if (v == null || v === '') return inboxId();
  const id = intParam(v);
  if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id)) throw httpError(404, 'Notebook not found');
  return id;
}

function createNote(notebookId, title, html, tags = []) {
  const now = Date.now();
  const { lastInsertRowid } = db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(notebookId, String(title ?? '').slice(0, 500), html, htmlToText(html), now, now);
  const id = Number(lastInsertRowid);
  const names = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (names.length) setNoteTags(id, names);
  return id;
}

function appendToNote(noteId, html) {
  const note = db.prepare('SELECT html FROM notes WHERE id = ? AND deleted_at IS NULL AND is_template = 0').get(noteId);
  if (!note) throw httpError(404, 'That note is gone (or in the Trash).');
  snapshot(noteId, { reason: 'Before adding a clip', force: true });
  const next = `${note.html}<hr>${html}`;
  db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(next, htmlToText(next), Date.now(), noteId);
}

function addAttachment(noteId, { storage, filename, mime, size }) {
  const { lastInsertRowid } = db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(noteId, filename, mime, size, storage, Date.now());
  return { id: Number(lastInsertRowid), filename, mime, size };
}
function attachmentBlock(a) {
  return a.mime.startsWith('image/') && a.mime !== 'image/svg+xml'
    ? `<img src="/api/files/${a.id}" alt="${escapeHtml(a.filename)}">`
    : `<div data-attachment="${a.id}" data-filename="${escapeHtml(a.filename)}" data-mime="${escapeHtml(a.mime)}" data-size="${a.size}">${escapeHtml(a.filename)}</div>`;
}

const paragraphs = (text) => String(text ?? '').split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`).join('');
const linkify = (escaped) => escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim());
const siteName = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const today = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: config.timeZone });
const sourceLine = (url, label = 'From') => (url ? `<p><em>${label} <a href="${escapeHtml(url)}">${escapeHtml(siteName(url))}</a> · ${today()}</em></p>` : '');

/** A web page's title, description and preview image (its <head>, read with a time and size limit). */
async function pageMeta(url) {
  const meta = { title: '', description: '', image: '' };
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow', headers: { 'User-Agent': `Selah/${version} (link preview)`, Accept: 'text/html' } });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return meta;
    let html = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      html += decoder.decode(chunk, { stream: true });
      if (html.length > 400_000 || /<\/head>/i.test(html)) break;
    }
    const tag = (re) => re.exec(html)?.[1]?.trim() ?? '';
    const prop = (name) => tag(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || tag(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'));
    const decode = (s) => htmlToText(s);
    meta.title = decode(prop('og:title') || tag(/<title[^>]*>([\s\S]*?)<\/title>/i));
    meta.description = decode(prop('og:description') || prop('description'));
    const img = prop('og:image');
    if (img) meta.image = new URL(img, res.url).href;
  } catch { /* the link alone will do */ }
  return meta;
}

/** Saves a downloaded or posted file into storage: { storage, filename, mime, size }. */
function storeBuffer(buf, filename, mime) {
  const storage = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(config.filesDir, storage), buf);
  return { storage, filename: filename.replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'file', mime, size: buf.length };
}

async function downloadImage(url) {
  const found = await fetchImages(`<img src="${escapeHtml(url)}">`);
  return found.get(url) ?? null;
}

/** HTML from a web page made safe and plain, with its images saved as attachments of `noteId`. */
function cleanHtml(raw, images, noteId, used) {
  const resolve = (src) => {
    const img = images.get(src);
    if (!img) return null;
    if (used.has(img.storage)) return used.get(img.storage);
    const a = addAttachment(noteId, img);
    used.set(img.storage, a);
    return a;
  };
  return enmlToHtml(`<en-note>${raw}</en-note>`, new Map(), resolve);
}

// ---------- the clipper's key ----------

const pairing = new Map(); // code -> expires at
let pairFailures = [];

/** The clipper key sent with a request ("Authorization: Bearer …"), if it's a valid one. */
export function clipToken(req) {
  const m = /^Bearer ([\w-]{20,200})$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const row = db.prepare('SELECT id, name FROM clip_tokens WHERE token_hash = ?').get(sha256(m[1]));
  if (row) db.prepare('UPDATE clip_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row ?? null;
}
/** API paths the clipper's key may use (see the auth hook in index.js). */
export const CLIP_PATHS = new Set(['/api/clip', '/api/clip/info', '/api/clip/notes', '/api/clip/bank']);

/** The extension, set up for this server's address, as a zip. */
async function extensionZip(origin) {
  const files = fs.readdirSync(EXTENSION_DIR, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => path.relative(EXTENSION_DIR, path.join(f.parentPath, f.name)).split(path.sep).join('/'));
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  manifest.version = version;
  manifest.host_permissions = [`${origin}/*`];
  const entries = files.filter((f) => f !== 'manifest.json' && f !== 'config.js')
    .map((f) => ({ name: `${f}`, file: path.join(EXTENSION_DIR, f) }));
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  entries.push({ name: 'config.js', data: Buffer.from(`// Made for your server when you downloaded the extension.\nexport const SERVER = ${JSON.stringify(origin)};\nexport const VERSION = ${JSON.stringify(version)};\n`) });
  entries.push({ name: 'Readability.js', file: path.join(config.root, 'node_modules', '@mozilla', 'readability', 'Readability.js') });
  entries.push({ name: 'wordmark.woff2', file: path.join(config.root, 'node_modules', '@fontsource', 'cormorant-garamond', 'files', 'cormorant-garamond-latin-600-italic.woff2') });
  return entries;
}

// ---------- shares from a phone (the installed app's share target) ----------

function cleanShares() {
  if (!fs.existsSync(SHARE_DIR)) return;
  for (const d of fs.readdirSync(SHARE_DIR)) {
    const dir = path.join(SHARE_DIR, d);
    try { if (Date.now() - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

export default async function captureRoutes(app) {
  // ---- Inbox ----
  app.get('/api/inbox', async () => {
    const id = inboxId();
    const name = db.prepare('SELECT name FROM notebooks WHERE id = ?').get(id).name;
    return { notebookId: id, name };
  });

  // Quick capture. Body: { title, text, notebook_id?, tags? }. A lone link becomes a bookmark with the page's title.
  app.post('/api/capture', async (req) => {
    const b = req.body ?? {};
    const notebookId = notebookOrInbox(b.notebook_id);
    let title = String(b.title ?? '').trim();
    const text = String(b.text ?? '').trim();
    let html;
    const url = isUrl(title) && !text ? title : isUrl(text) && !title ? text : null;
    if (url) {
      const meta = await pageMeta(url);
      title = meta.title || siteName(url);
      html = `<p><a href="${escapeHtml(url)}">${escapeHtml(meta.title || url)}</a></p>${meta.description ? `<p>${escapeHtml(meta.description)}</p>` : ''}`;
    } else {
      html = paragraphs(text) || '<p></p>';
    }
    const id = createNote(notebookId, title, html, b.tags);
    return { id, title, notebook_id: notebookId };
  });

  // The share menu posts here (manifest share_target). The share waits on disk until the app, signed in, claims it,
  // so nothing is lost if the browser leaves out the sign-in cookie.
  app.post('/share', async (req, reply) => {
    const token = await receiveShare(req);
    return reply.redirect(`/?share=${token}#inbox`, 303);
  });

  // 13.0: the phone and tablet app's share menu (signed in), saved to the Inbox at once: -> { id, title }.
  app.post('/api/share', async (req) => claimShare(await receiveShare(req)));

  app.post('/api/share/:token/claim', async (req) => {
    const token = String(req.params.token);
    if (!/^[a-f0-9]{32}$/.test(token)) throw httpError(400, 'Invalid share');
    return claimShare(token);
  });

  /** A share's fields (title, text, url) and files, kept on disk under a new token until claimShare. */
  async function receiveShare(req) {
    cleanShares();
    const token = crypto.randomBytes(16).toString('hex');
    const dir = path.join(SHARE_DIR, token);
    fs.mkdirSync(dir, { recursive: true });
    const fields = {};
    const files = [];
    let total = 0;
    try {
      for await (const part of req.parts({ limits: { fileSize: config.maxUpload, files: 20 } })) {
        if (part.type === 'file') {
          if (!part.filename) { part.file.resume(); continue; }
          const name = `f${files.length}`;
          await pipeline(part.file, fs.createWriteStream(path.join(dir, name)));
          const size = fs.statSync(path.join(dir, name)).size;
          total += size;
          if (part.file.truncated || total > config.maxUpload) throw httpError(413, 'Too large');
          files.push({ name, filename: path.basename(part.filename).slice(0, 200), mime: (part.mimetype || 'application/octet-stream').toLowerCase(), size });
        } else if (['title', 'text', 'url'].includes(part.fieldname)) {
          fields[part.fieldname] = String(part.value ?? '').slice(0, 100_000);
        }
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    fs.writeFileSync(path.join(dir, 'share.json'), JSON.stringify({ ...fields, files }));
    return token;
  }

  /** A waiting share saved to the Inbox as a note, with its files attached: { id, title }. */
  async function claimShare(token) {
    const dir = path.join(SHARE_DIR, token);
    let share;
    try { share = JSON.parse(fs.readFileSync(path.join(dir, 'share.json'), 'utf8')); } catch { throw httpError(404, 'That share was already saved.'); }
    // Android often puts the link in "text", sometimes with words around it.
    const text = String(share.text ?? '').trim();
    const url = share.url || (isUrl(text) ? text : /\bhttps?:\/\/\S+/.exec(text)?.[0]) || '';
    const rest = url ? text.replace(url, '').trim() : text;
    const meta = url && !share.title ? await pageMeta(url) : null;
    const title = (share.title || meta?.title || rest.split('\n')[0] || (share.files[0]?.filename ?? '') || 'Shared').slice(0, 300);
    let html = '';
    if (url) html += `<p><a href="${escapeHtml(url)}">${escapeHtml(share.title || meta?.title || url)}</a></p>${meta?.description ? `<p>${escapeHtml(meta.description)}</p>` : ''}`;
    if (rest && rest !== title) html += paragraphs(rest);
    const notebookId = inboxId();
    const id = tx(() => {
      const noteId = createNote(notebookId, title, html || '<p></p>');
      let body = html;
      for (const f of share.files) {
        const stored = storeBuffer(fs.readFileSync(path.join(dir, f.name)), f.filename, f.mime);
        body += attachmentBlock(addAttachment(noteId, stored));
      }
      if (body !== html) db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(body, htmlToText(body), noteId);
      return noteId;
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return { id, title };
  }

  // ---- clipper: pairing and keys (signed in) ----
  // Pairing makes a key that lasts until it's removed, so it needs the password (and code) entered recently.
  app.post('/api/clip/pairing', async (req) => {
    requireConfirmed(req);
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    pairing.set(code, expiresAt);
    return { code, expiresAt };
  });
  app.get('/api/clip/devices', async () => db.prepare('SELECT id, name, created_at, last_used_at FROM clip_tokens ORDER BY created_at DESC').all());
  app.delete('/api/clip/devices/:id', async (req) => {
    const row = db.prepare('SELECT name FROM clip_tokens WHERE id = ?').get(intParam(req.params.id));
    db.prepare('DELETE FROM clip_tokens WHERE id = ?').run(intParam(req.params.id));
    if (row) logEvent('clipper-removed', req, { name: row.name });
    return { ok: true };
  });
  app.get('/api/clip/extension.zip', async (req, reply) => {
    const origin = `https://${req.headers.host}`;
    const out = new PassThrough();
    writeZip(out, await extensionZip(origin)).catch((err) => { req.log.error(err); out.destroy(err); });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="selah-clipper.zip"');
    return reply.send(out);
  });

  // The extension trades a one-time code for its key (no sign-in needed; the code is the proof).
  app.post('/api/clip/pair', async (req) => {
    const now = Date.now();
    pairFailures = pairFailures.filter((t) => now - t < 10 * 60 * 1000);
    if (pairFailures.length >= 10) throw httpError(429, 'Too many wrong codes. Wait a few minutes and get a new one.');
    const code = String(req.body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const expires = pairing.get(code);
    if (!expires || expires < now) {
      pairFailures.push(now);
      throw httpError(400, 'That code isn’t right, or it has expired. Get a new one in Selah: Settings → Browser extension.');
    }
    pairing.delete(code);
    const token = crypto.randomBytes(32).toString('base64url');
    const name = String(req.body?.name ?? 'Edge').slice(0, 80) || 'Edge';
    db.prepare('INSERT INTO clip_tokens (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, sha256(token), now);
    logEvent('clipper-paired', req, { name });
    return { token, name };
  });

  // ---- clipper: what it may see ----
  app.get('/api/clip/info', async () => {
    const inbox = inboxId();
    return {
      app: 'Selah', version, inboxId: inbox,
      // 10.1: only the Inbox and My notes (tagging a clip files it in My notes anyway).
      notebooks: db.prepare('SELECT id, name FROM notebooks WHERE id IN (?, ?) ORDER BY (id = ?) DESC').all(inbox, myNotesId(), inbox),
      tags: db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map((t) => t.name),
      sermons: clipSermons(),
      bankTopics: bankTopics(),
    };
  });

  /**
   * Selected text into the sermon bank. Body: { html, url, page_title, kind, title, topics, passage, sermon_id }.
   * Pictures are left out (a bank item is text); the page is kept as its source. With no passage, the first
   * Scripture reference in the text fills it.
   */
  app.post('/api/clip/bank', async (req) => {
    const b = req.body ?? {};
    const html = cleanHtml(String(b.html ?? '').replace(/<(img|picture|svg|video|audio)\b[\s\S]*?(?:<\/\1>|\/?>)/gi, ''), new Map(), null, new Map());
    if (!htmlToText(html).trim()) throw httpError(400, 'Select some text on the page first.');
    const url = /^https?:\/\//i.test(b.url ?? '') ? String(b.url).slice(0, 2000) : '';
    const f = bankFields({ kind: b.kind || 'illustration', title: b.title ?? '', html, topics: b.topics ?? '', passage: b.passage ?? '', for_sermon_id: b.sermon_id || null });
    if (!f.title) f.title = htmlToText(html).trim().split(/\n/)[0].slice(0, 80);
    if (!f.passage) {
      const found = findReferences(htmlToText(html))[0];
      if (found) f.passage = found.refs.map((r) => format(r)).join('; ');
    }
    const item = addBankItem({ ...f, source_url: url, source_page: String(b.page_title ?? '').trim().slice(0, 300) || (url ? siteName(url) : '') });
    return { id: item.id, title: item.title, kind: item.kind, sermon: item.for_sermon_id ? clipSermons().find((s) => s.id === item.for_sermon_id)?.title ?? '' : '' };
  });
  app.get('/api/clip/notes', async (req) => {
    const terms = String(req.query.q ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) {
      return db.prepare('SELECT id, title FROM notes WHERE deleted_at IS NULL AND is_template = 0 ORDER BY updated_at DESC LIMIT 8').all();
    }
    return db.prepare(`SELECT n.id, n.title FROM notes n JOIN notes_fts f ON f.rowid = n.id
      WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.is_template = 0 ORDER BY f.rank LIMIT 10`)
      .all(terms.map((t) => `"${t}"*`).join(' '));
  });

  /**
   * A clip. Body: { kind: article | selection | bookmark | screenshot | image | link, url, title, html, description,
   * image, dataUrl, notebook_id, tags, comment, append_to }.
   */
  app.post('/api/clip', async (req) => {
    const b = req.body ?? {};
    const kind = String(b.kind ?? '');
    const url = /^https?:\/\//i.test(b.url ?? '') ? String(b.url) : '';
    let title = String(b.title ?? '').trim().slice(0, 300);
    const comment = String(b.comment ?? '').trim();
    const appendTo = b.append_to ? intParam(b.append_to) : null;
    const notebookId = appendTo ? null : notebookOrInbox(b.notebook_id);

    // Gather what needs fetching before the database work.
    let images = new Map();
    let file = null; // a single image: { storage, filename, mime, size }
    let meta = null;
    if (kind === 'article' || kind === 'selection') {
      images = await fetchImages(String(b.html ?? ''));
    } else if (kind === 'screenshot') {
      const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl ?? ''));
      if (!m) throw httpError(400, 'No screenshot');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_IMAGE) throw httpError(413, 'That screenshot is too large.');
      file = storeBuffer(buf, `Screenshot ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.${m[1] === 'image/png' ? 'png' : 'jpg'}`, m[1]);
    } else if (kind === 'image') {
      if (!/^https?:\/\//i.test(b.image ?? '')) throw httpError(400, 'No image');
      file = await downloadImage(String(b.image));
      if (!file) throw httpError(422, 'Couldn’t download that image (it may need you to be signed in to the site).');
    } else if (kind === 'link' || (kind === 'bookmark' && !title)) {
      if (!url) throw httpError(400, 'No link');
      meta = await pageMeta(url);
    } else if (kind !== 'bookmark') {
      throw httpError(400, 'Unknown kind of clip');
    }
    if (kind === 'bookmark' && /^https?:\/\//i.test(b.image ?? '')) file = await downloadImage(String(b.image));

    try {
      const result = tx(() => {
        let noteId = appendTo;
        if (!noteId) noteId = createNote(notebookId, '', '<p></p>', b.tags);
        const used = new Map();
        let body = comment ? paragraphs(comment) : '';
        if (kind === 'article') {
          title ||= siteName(url);
          body += sourceLine(url, 'Clipped from') + cleanHtml(String(b.html ?? ''), images, noteId, used);
        } else if (kind === 'selection') {
          title ||= siteName(url);
          body += `<blockquote>${cleanHtml(String(b.html ?? ''), images, noteId, used) || '<p></p>'}</blockquote>${sourceLine(url, '—')}`;
        } else if (kind === 'screenshot') {
          title = title ? `Screenshot: ${title}` : 'Screenshot';
          body += attachmentBlock(addAttachment(noteId, file)) + sourceLine(url);
        } else if (kind === 'image') {
          title ||= file.filename;
          body += attachmentBlock(addAttachment(noteId, file)) + sourceLine(url);
        } else {
          // bookmark or link
          const pageTitle = title || meta?.title || siteName(url);
          const description = String(b.description ?? '').trim() || meta?.description || '';
          title = pageTitle;
          body += `<p><a href="${escapeHtml(url)}">${escapeHtml(pageTitle)}</a></p>`;
          if (description) body += `<p>${escapeHtml(description)}</p>`;
          if (file) body += attachmentBlock(addAttachment(noteId, file));
          body += `<p><em>Saved ${today()}</em></p>`;
        }
        if (appendTo) {
          appendToNote(noteId, `<h3>${escapeHtml(title)}</h3>${body}`);
        } else {
          db.prepare('UPDATE notes SET title = ?, html = ?, text = ? WHERE id = ?').run(title.slice(0, 500), body, htmlToText(body), noteId);
        }
        return { id: noteId, title, appended: !!appendTo };
      });
      // Images that weren't used (e.g. inside something the cleaner dropped).
      unlinkStorage([...images.values()].filter((img) => img && !db.prepare('SELECT 1 FROM attachments WHERE storage = ?').get(img.storage)).map((img) => img.storage));
      return result;
    } catch (e) {
      unlinkStorage([...images.values(), file].filter(Boolean).map((img) => img.storage));
      throw e;
    }
  });
}
