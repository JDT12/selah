// Streaming .enex (ENEX file format) importer. Resource data is base64-decoded to disk as it
// arrives, so large exports with many attachments don't need to fit in memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sax from 'sax';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { enmlToHtml } from './enml.js';
import { htmlToText, escapeHtml } from './html.js';
import { setNoteTags } from './tags.js';

function parseEnexDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec((s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const EXT_BY_MIME = {
  'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/amr': '.amr',
  'video/mp4': '.mp4', 'text/plain': '.txt',
};

class ResourceWriter {
  constructor() {
    this.storage = crypto.randomBytes(16).toString('hex');
    this.fd = fs.openSync(path.join(config.filesDir, this.storage), 'w');
    this.md5 = crypto.createHash('md5');
    this.carry = '';
    this.size = 0;
  }
  write(b64) {
    const s = this.carry + b64.replace(/[^A-Za-z0-9+/=]/g, '');
    const usable = s.length - (s.length % 4);
    this.carry = s.slice(usable);
    if (usable) this.#emit(Buffer.from(s.slice(0, usable), 'base64'));
  }
  #emit(buf) {
    fs.writeSync(this.fd, buf);
    this.md5.update(buf);
    this.size += buf.length;
  }
  end() {
    if (this.carry) this.#emit(Buffer.from(this.carry, 'base64'));
    fs.closeSync(this.fd);
    return { storage: this.storage, size: this.size, hash: this.md5.digest('hex') };
  }
}

/**
 * Import an ENEX stream into a notebook.
 * @returns {Promise<{notes:number, attachments:number, errors:string[]}>}
 */
export function importEnex(stream, notebookId) {
  return new Promise((resolve, reject) => {
    const result = { notes: 0, attachments: 0, errors: [] };
    const parser = sax.createStream(false, { lowercase: true, trim: false, normalize: false });
    const path_ = [];
    let note = null;
    let res = null;
    let text = '';

    parser.on('opentag', (n) => {
      path_.push(n.name);
      text = '';
      if (n.name === 'note') {
        note = { title: '', content: '', tags: [], resources: [], created: null, updated: null };
      } else if (n.name === 'resource' && note) {
        res = { mime: 'application/octet-stream', filename: null, writer: null, file: null };
      } else if (n.name === 'data' && res) {
        res.writer = new ResourceWriter();
      }
    });

    const onText = (t) => {
      if (res?.writer && path_.at(-1) === 'data') res.writer.write(t);
      else if (note) text += t;
    };
    parser.on('text', onText);
    parser.on('cdata', onText);

    parser.on('closetag', (name) => {
      path_.pop();
      const parent = path_.at(-1);
      if (note) {
        if (parent === 'note') {
          if (name === 'title') note.title = text.trim();
          else if (name === 'content') note.content = text;
          else if (name === 'created') note.created = parseEnexDate(text);
          else if (name === 'updated') note.updated = parseEnexDate(text);
          else if (name === 'tag') note.tags.push(text.trim());
        }
        if (res) {
          if (name === 'mime' && parent === 'resource') res.mime = text.trim().toLowerCase() || res.mime;
          else if (name === 'file-name') res.filename = text.trim();
          else if (name === 'data' && res.writer) { res.file = res.writer.end(); res.writer = null; }
          else if (name === 'resource') { if (res.file) note.resources.push(res); res = null; }
        }
        if (name === 'note') {
          try {
            saveNote(note, notebookId);
            result.notes++;
            result.attachments += note.resources.length;
          } catch (err) {
            result.errors.push(`"${note.title || 'Untitled'}": ${err.message}`);
            unlinkStorage(note.resources.map((r) => r.file.storage));
          }
          note = null;
        }
      }
      text = '';
    });

    parser.on('error', (err) => {
      // Tolerate malformed markup; keep going.
      result.errors.push(`XML: ${err.message.split('\n')[0]}`);
      parser._parser.error = null;
      parser._parser.resume();
    });
    parser.on('end', () => resolve(result));
    stream.on('error', (err) => {
      if (res?.writer) unlinkStorage([res.writer.end().storage]);
      reject(err);
    });
    stream.pipe(parser);
  });
}

function saveNote(note, notebookId) {
  const now = Date.now();
  const created = note.created ?? now;
  const updated = note.updated ?? created;
  tx(() => {
    const { lastInsertRowid: noteId } = db
      .prepare('INSERT INTO notes (notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(notebookId, note.title || 'Untitled', created, updated);

    const byHash = new Map();
    const insAtt = db.prepare(
      'INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    note.resources.forEach((r, i) => {
      const filename = r.filename || `attachment-${i + 1}${EXT_BY_MIME[r.mime] || ''}`;
      const { lastInsertRowid: id } = insAtt.run(noteId, filename, r.mime, r.file.size, r.file.storage, created);
      byHash.set(r.file.hash, { id: Number(id), filename, mime: r.mime, size: r.file.size });
    });

    let html = enmlToHtml(note.content || '', byHash);
    // Resources not referenced by en-media are still attached; surface them at the end.
    for (const r of byHash.values()) {
      if (!html.includes(`/api/files/${r.id}"`) && !html.includes(`data-attachment="${r.id}"`)) {
        html += r.mime.startsWith('image/')
          ? `<img src="/api/files/${r.id}" alt="">`
          : `<div data-attachment="${r.id}" data-filename="${escapeHtml(r.filename)}" data-mime="${escapeHtml(r.mime)}" data-size="${r.size}">${escapeHtml(r.filename)}</div>`;
      }
    }
    db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(html || '<p></p>', htmlToText(html), noteId);
    setNoteTags(noteId, note.tags);
  });
}
