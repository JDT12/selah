import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { escapeHtml, htmlToText } from './html.js';
import { parseHtml } from './enml.js';
import { noteTags, setNoteTags } from './tags.js';
import { myNotesId } from './mynotes.js';

/**
 * Note merger and splitter, and the attachment copying they share with Duplicate (routes.js). Attachments are
 * always copied, never moved, so the originals still work if they're restored from the Trash.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};

/** Copies a note's attachment files (all of them, or those with the given ids); returns the rows with new storage names. */
export function copyFiles(noteId, onlyIds = null) {
  const copied = [];
  try {
    for (const f of db.prepare('SELECT * FROM attachments WHERE note_id = ? ORDER BY id').all(noteId)) {
      if (onlyIds && !onlyIds.has(f.id)) continue;
      const storage = crypto.randomBytes(16).toString('hex');
      fs.copyFileSync(path.join(config.filesDir, f.storage), path.join(config.filesDir, storage), fs.constants.COPYFILE_FICLONE);
      copied.push({ ...f, storage });
    }
  } catch (err) {
    unlinkStorage(copied.map((f) => f.storage));
    throw err;
  }
  return copied;
}

/** Adds copied attachments to a note (inside tx); returns old id -> new id. */
export function attachCopies(copied, noteId, now) {
  const ids = new Map();
  const ins = db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const f of copied) ids.set(f.id, Number(ins.run(noteId, f.filename, f.mime, f.size, f.storage, now).lastInsertRowid));
  return ids;
}

/** Points the html's attachment links at the copies. */
export const pointAt = (html, ids) => html
  .replace(/\/api\/files\/(\d+)(?!\d)/g, (m, n) => (ids.has(Number(n)) ? `/api/files/${ids.get(Number(n))}` : m))
  .replace(/data-attachment="(\d+)"/g, (m, n) => (ids.has(Number(n)) ? `data-attachment="${ids.get(Number(n))}"` : m));

/** Attachment ids the html points at. */
const usedFiles = (html) => new Set([
  ...[...html.matchAll(/\/api\/files\/(\d+)(?!\d)/g)].map((m) => Number(m[1])),
  ...[...html.matchAll(/data-attachment="(\d+)"/g)].map((m) => Number(m[1])),
]);

/** Links to note `from` in every other note now point at note `to` (the old one went to the Trash). */
function repointLinks(from, to) {
  const rows = db.prepare(`SELECT id, html FROM notes WHERE deleted_at IS NULL AND id != ? AND (html LIKE ? OR html LIKE ?)`)
    .all(to, `%data-note-id="${from}"%`, `%#note/${from}"%`);
  const fixLink = db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?');
  const reindex = db.prepare('DELETE FROM note_links_state WHERE note_id = ?');
  for (const r of rows) {
    const html = r.html
      .replace(new RegExp(`data-note-id="${from}"`, 'g'), `data-note-id="${to}"`)
      .replace(new RegExp(`#note/${from}"`, 'g'), `#note/${to}"`);
    if (html === r.html) continue;
    fixLink.run(html, htmlToText(html), r.id);
    reindex.run(r.id);
  }
}

// ---------------------------------------------------------------- serializing parsed HTML

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Back to HTML, as written (every attribute kept). */
export function serialize(n) {
  if (typeof n === 'string') return escText(n);
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
  return `<${n.tag}${attrs}>${n.children.map(serialize).join('')}</${n.tag}>`;
}
const textOf = (n) => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const hasContent = (nodes) => nodes.some((n) => (typeof n === 'string' ? n.trim() : textOf(n).trim()
  || /^(img|hr|table)$/.test(n.tag) || 'data-attachment' in n.attrs || 'data-drawing' in n.attrs));

// ---------------------------------------------------------------- split

const SPLIT_AT = { h1: ['h1'], h2: ['h1', 'h2'], h3: ['h1', 'h2', 'h3'], hr: ['hr'] };

/** The parts a note splits into: [{ title, nodes }]. Text before the first split point keeps the note's title. */
export function splitParts(note, at) {
  const tags = SPLIT_AT[at];
  if (!tags) throw httpError(400, 'Split at H1, H2, H3 or dividers.');
  const top = parseHtml(`<div>${note.html}</div>`).children[0]?.children ?? [];
  const parts = [];
  let cur = { title: note.title || 'Untitled', nodes: [], lead: true };
  const close = () => { if (!cur.lead || hasContent(cur.nodes)) parts.push(cur); };
  for (const n of top) {
    if (typeof n === 'object' && tags.includes(n.tag)) {
      close();
      if (n.tag === 'hr') cur = { title: null, nodes: [] };
      else cur = { title: textOf(n).trim() || 'Untitled', nodes: [] };
      continue;
    }
    cur.nodes.push(n);
  }
  close();
  // A part after a divider is named by its first line.
  parts.forEach((p, i) => {
    if (p.title) return;
    const first = p.nodes.map(textOf).map((t) => t.trim()).find(Boolean);
    p.title = first ? (first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first) : `${note.title || 'Untitled'} (${i + 1})`;
  });
  return parts.map(({ title, nodes }) => {
    const html = nodes.map(serialize).join('');
    return { title, html, words: (htmlToText(html).match(/\S+/g) ?? []).length };
  });
}

// ---------------------------------------------------------------- routes

export default async function noteToolRoutes(app) {
  // Body: { ids: [in order], title, notebook_id?, join: 'title' | 'divider', keep?: bool }
  app.post('/api/notes/merge', async (req) => {
    const b = req.body ?? {};
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(intParam))];
    if (ids.length < 2) throw httpError(400, 'Choose at least two notes to merge.');
    const notes = ids.map((id) => db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id));
    if (notes.some((n) => !n)) throw httpError(404, 'One of the notes is gone (in the Trash?).');
    const notebookId = b.notebook_id != null ? intParam(b.notebook_id) : notes[0].notebook_id;
    if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId)) throw httpError(404, 'Notebook not found');
    const title = String(b.title ?? '').trim().slice(0, 500) || notes[0].title || 'Untitled';
    const copies = notes.map((n) => copyFiles(n.id));
    try {
      return tx(() => {
        const now = Date.now();
        const created = Math.min(...notes.map((n) => n.created_at));
        const id = Number(db.prepare(`INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at)
          VALUES (?, ?, '', '', ?, ?)`).run(notebookId, title, created, now).lastInsertRowid);
        const html = notes.map((n, i) => {
          const body = pointAt(n.html, attachCopies(copies[i], id, now));
          if (b.join === 'divider') return (i ? '<hr>' : '') + body;
          return `<h1>${escapeHtml(n.title || 'Untitled')}</h1>${body}`;
        }).join('');
        db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(html, htmlToText(html), id);
        setNoteTags(id, [...new Set(notes.flatMap((n) => noteTags(n.id)))]);
        if (!b.keep) {
          const trash = db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?');
          for (const n of notes) { trash.run(now, n.id); repointLinks(n.id, id); }
        }
        return { id };
      });
    } catch (err) {
      unlinkStorage(copies.flat().map((f) => f.storage));
      throw err;
    }
  });

  // Body: { at: 'h1' | 'h2' | 'h3' | 'hr', preview?: bool, notebook: id | 'new', contents?: bool, keep?: bool }
  app.post('/api/notes/:id/split', async (req) => {
    const id = intParam(req.params.id);
    const b = req.body ?? {};
    const note = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!note) throw httpError(404, 'Note not found');
    const parts = splitParts(note, String(b.at ?? 'h1'));
    if (b.preview) return { parts: parts.map(({ title, words }) => ({ title, words })) };
    if (parts.length < 2) throw httpError(400, 'There’s nothing to split there: the note would stay one note.');
    const used = parts.map((p) => usedFiles(p.html));
    const copies = used.map((ids) => copyFiles(id, ids));
    try {
      return tx(() => {
        const now = Date.now();
        let notebookId = note.notebook_id;
        const tags = noteTags(id);
        if (b.notebook === 'new' || b.tagParts) {
          // 10.1: "keep the parts together" tags them with the note's title instead of making a notebook.
          notebookId = b.notebook === 'new' ? myNotesId() : notebookId;
          if (note.title?.trim()) tags.push(note.title.trim().slice(0, 100));
        } else if (b.notebook != null) {
          notebookId = intParam(b.notebook);
          if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId)) throw httpError(404, 'Notebook not found');
        }
        const ins = db.prepare(`INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, '', '', ?, ?)`);
        const setHtml = db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?');
        // Created a millisecond apart, in order, so "oldest first" lists them as they were.
        const ids = parts.map((p, i) => {
          const pid = Number(ins.run(notebookId, p.title.slice(0, 500), note.created_at + i, now).lastInsertRowid);
          const html = pointAt(p.html, attachCopies(copies[i], pid, now)) || '<p></p>';
          setHtml.run(html, htmlToText(html), pid);
          setNoteTags(pid, tags);
          return pid;
        });
        let contentsId = null;
        if (b.contents) {
          const list = parts.map((p, i) => `<li><p><a class="note-link" data-note-id="${ids[i]}" href="#note/${ids[i]}">${escapeHtml(p.title)}</a></p></li>`).join('');
          const html = `<ol>${list}</ol>`;
          contentsId = Number(ins.run(notebookId, (note.title || 'Untitled').slice(0, 500), note.created_at - 1, now).lastInsertRowid);
          setHtml.run(html, htmlToText(html), contentsId);
          setNoteTags(contentsId, tags);
        }
        if (!b.keep) {
          db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(now, id);
          repointLinks(id, contentsId ?? ids[0]);
        }
        return { ids, contentsId, notebookId };
      });
    } catch (err) {
      unlinkStorage(copies.flat().map((f) => f.storage));
      throw err;
    }
  });
}
