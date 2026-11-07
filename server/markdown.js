// Markdown importer. Accepts .md files, optionally with the images/files they reference
// (e.g. a notes vault or a folder exported from another app). Each .md file becomes a note;
// referenced files become attachments of that note.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { marked } from 'marked';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { enmlToHtml } from './enml.js';
import { htmlToText } from './html.js';
import { setNoteTags } from './tags.js';

export const isMarkdown = (name) => /\.(md|markdown|mdown|mkd)$/i.test(name);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.txt': 'text/plain', '.csv': 'text/csv',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const mimeOf = (name) => MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Normalise an uploaded relative path ("Vault/img/a.png") to a safe posix key. */
const cleanPath = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^(\.\.\/|\/)+/, '');

/**
 * Collects uploaded parts. Call add() for each multipart file part, then finish().
 */
export class MarkdownImport {
  constructor({ notebookId, mtimes = {} }) {
    this.notebookId = notebookId;
    this.mtimes = mtimes;
    this.docs = []; // { path, text }
    this.assets = new Map(); // path -> { path, storage, size, mime, used }
    this.result = { notes: 0, attachments: 0, errors: [] };
  }

  async add(part) {
    const rel = cleanPath(part.filename || 'file');
    if (isMarkdown(rel)) {
      const chunks = [];
      for await (const c of part.file) chunks.push(c);
      if (part.file.truncated) this.result.errors.push(`${rel}: too large, skipped`);
      else this.docs.push({ path: rel, text: Buffer.concat(chunks).toString('utf8') });
      return;
    }
    const storage = crypto.randomBytes(16).toString('hex');
    const dest = path.join(config.filesDir, storage);
    try {
      await pipeline(part.file, fs.createWriteStream(dest));
    } catch (err) {
      unlinkStorage([storage]);
      throw err;
    }
    if (part.file.truncated) {
      unlinkStorage([storage]);
      this.result.errors.push(`${rel}: too large, skipped`);
      return;
    }
    this.assets.set(rel, { path: rel, storage, size: fs.statSync(dest).size, mime: mimeOf(rel), used: false });
  }

  /** Drop everything uploaded so far (the request failed part-way). */
  abort() {
    unlinkStorage([...this.assets.values()].map((a) => a.storage));
  }

  finish() {
    for (const doc of this.docs.sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        this.#saveNote(doc);
        this.result.notes++;
      } catch (err) {
        this.result.errors.push(`${doc.path}: ${err.message}`);
      }
    }
    // Files nobody referenced aren't kept.
    unlinkStorage([...this.assets.values()].filter((a) => !a.used).map((a) => a.storage));
    return this.result;
  }

  /** Find an uploaded file from a link in the note at `docPath`: relative path first, then by name. */
  #findAsset(docPath, ref) {
    let target = ref.trim().replace(/^<|>$/g, '').replace(/[?#].*$/, '');
    if (!target || /^[a-z][\w+.-]*:/i.test(target)) return null;
    try { target = decodeURIComponent(target); } catch { /* keep as written */ }
    const rel = cleanPath(target.startsWith('/') ? target : path.posix.join(path.posix.dirname(docPath), target));
    if (this.assets.has(rel)) return this.assets.get(rel);
    const base = path.posix.basename(target).toLowerCase();
    for (const a of this.assets.values()) if (path.posix.basename(a.path).toLowerCase() === base) return a;
    return null;
  }

  #saveNote(doc) {
    const { meta, body } = splitFrontMatter(doc.text.replace(/^﻿/, ''));
    let markdown = body;
    let title = typeof meta.title === 'string' ? meta.title.trim() : '';
    if (!title) {
      // A leading "# Title" becomes the note title.
      const h1 = /^\s*#[ \t]+(.+?)[ \t#]*(\r?\n|$)/.exec(markdown);
      if (h1) { title = h1[1].trim(); markdown = markdown.slice(h1[0].length); }
    }
    if (!title) title = path.posix.basename(doc.path).replace(/\.[^.]+$/, '');

    const mtime = Number(this.mtimes[doc.path]) || Date.now();
    const created = parseDate(meta.created ?? meta.date) ?? mtime;
    const updated = parseDate(meta.updated ?? meta.modified ?? meta.lastmod) ?? Math.max(created, mtime);

    const html = marked.parse(wikiToMarkdown(markdown), { gfm: true, async: false });

    tx(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO notes (notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(this.notebookId, title.slice(0, 500), created, updated);
      const noteId = Number(lastInsertRowid);
      const attached = new Map(); // asset path -> attachment, so a file linked twice is stored once per note
      const resolveLocal = (ref) => {
        const asset = this.#findAsset(doc.path, ref);
        if (!asset) return null;
        if (attached.has(asset.path)) return attached.get(asset.path);
        let { storage } = asset;
        if (asset.used) {
          // Already attached to another note: give this note its own copy (deleting one mustn't break the other).
          storage = crypto.randomBytes(16).toString('hex');
          fs.copyFileSync(path.join(config.filesDir, asset.storage), path.join(config.filesDir, storage));
        }
        asset.used = true;
        const filename = path.posix.basename(asset.path).slice(0, 255);
        const { lastInsertRowid: id } = db
          .prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(noteId, filename, asset.mime, asset.size, storage, created);
        const att = { id: Number(id), filename, mime: asset.mime, size: asset.size };
        attached.set(asset.path, att);
        this.result.attachments++;
        return att;
      };
      // One root element, or the parser stops at the end of the first top-level block.
      const out = enmlToHtml(`<en-note>${html}</en-note>`, new Map(), resolveLocal) || '<p></p>';
      db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(out, htmlToText(out), noteId);
      setNoteTags(noteId, tagList(meta.tags ?? meta.tag ?? meta.keywords));
    });
  }
}

/** Wiki-style syntax marked doesn't know: ![[embed.png|300]], [[Note|alias]] wiki links, spaces in paths. Code is left alone. */
function wikiToMarkdown(md) {
  return md.split(/(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~|`[^`\n]+`)/m).map((seg, i) => (i % 2 ? seg : seg
    .replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (_, file) => `![](<${file.trim()}>)`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target, alias) => alias?.trim() || target.trim())
    // Some apps allow spaces in link paths ("![](img/beach day.png)"); CommonMark needs <…> for that.
    .replace(/(!?\[[^\]\n]*\])\(([^)<>\n"']*\s[^)<>\n"']*)\)/g, (_, label, dest) => `${label}(<${dest.trim()}>)`)
  )).join('');
}

/** YAML front matter, enough of it for title/tags/dates: scalars, [a, b] lists and "- item" lists. */
function splitFrontMatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? (listKey && /^-\s+(.*)$/.exec(line));
    if (item && listKey) { meta[listKey].push(unquote(item[1])); continue; }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    listKey = null;
    if (!value) { meta[key] = []; listKey = key; }
    else if (/^\[.*\]$/.test(value)) meta[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    else meta[key] = unquote(value);
  }
  return { meta, body: text.slice(m[0].length) };
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

function tagList(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
}

function parseDate(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}
