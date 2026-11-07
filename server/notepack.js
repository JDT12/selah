import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx } from './db.js';
import { config } from './config.js';
import { htmlToText } from './html.js';
import { setNoteTags } from './tags.js';
import { pointAt } from './notetools.js';
import { checkPackage } from './notepackread.js';
import { absorbNotebooks } from './mynotes.js';

export { readPackage, checkPackage } from './notepackread.js';

/**
 * Note packages: notes taken out of a Selah database (a restore point, an off-site or host backup's snapshot, or this
 * one for a .selahnb export) and put into this one as copies. Nothing already here is changed.
 *
 *   { app: 'Selah', kind: 'notes', version: 1, createdAt,
 *     notebooks: [{ key, id, name, stack, whole }],
 *     notes: [{ id, notebook, title, html, created_at, updated_at, pinned, is_template, tags: [names],
 *               attachments: [{ id, filename, mime, size, created_at, storage }] }] }
 *
 * `notebook` is a notebook's key; `whole` marks a notebook taken as a whole (it comes back as a notebook of its own).
 * An attachment's `storage` names its file wherever the package's files are: importPackage asks `resolveFile` for it.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

const NOTE_LINK = /<a\b[^>]*\bdata-note-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Links between notes: to a note that came in the package they point at its copy; to any other note they stay
 * (`keepOthers`, a restore into the same Selah) or become plain text (a file from somewhere else).
 */
function relink(html, newIds, keepOthers) {
  return html.replace(NOTE_LINK, (m, id, inner) => {
    const to = newIds.get(Number(id));
    if (to) return m.replaceAll(`data-note-id="${id}"`, `data-note-id="${to}"`).replaceAll(`#note/${id}"`, `#note/${to}"`);
    return keepOthers ? m : inner;
  });
}

const liveNotebook = (name) => db.prepare('SELECT id FROM notebooks WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1').get(name)?.id ?? null;
const liveStack = (name) => (name ? db.prepare('SELECT id FROM stacks WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1').get(name)?.id ?? null : null);

/**
 * Puts a package's notes into this Selah as new notes, with copies of their attachments and their tags.
 * - `into`: a notebook id for every note; otherwise a whole notebook comes back as a new notebook (named with
 *   `label` if one of that name is here already) and single notes go to their notebook if it's still here (by id with
 *   `sameAccount`, else by name), or to a new one of its name.
 * - `label` (e.g. "restored Oct 20") also marks a note whose title is taken in the notebook it lands in.
 * - `resolveFile(storage)` gives the path of an attachment's file (or null if it can't be found); it may be async.
 * Returns what was made: { notes, notebooks (new ids), noteIds, attachments, missing }.
 */
export async function importPackage(pkg, { resolveFile, label = null, into = null, sameAccount = false, newNotebooks = false }) {
  checkPackage(pkg);
  if (into != null && !db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(into)) throw httpError(404, 'Notebook not found');
  if (!pkg.notes.length && !pkg.notebooks.some((b) => b.whole)) throw httpError(400, 'There’s nothing to restore there.');

  // Copy the attachments in first (outside the transaction: they may come over the network).
  const copied = new Map(); // `${noteId}:${attId}` -> { ...attachment, storage }
  let missing = 0;
  const made = [];
  try {
    for (const n of pkg.notes) {
      for (const a of n.attachments ?? []) {
        const from = /^[\w.-]+$/.test(String(a.storage ?? '')) ? await resolveFile(a.storage) : null;
        if (!from || !fs.existsSync(from)) { missing++; continue; }
        const storage = crypto.randomBytes(16).toString('hex');
        fs.copyFileSync(from, path.join(config.filesDir, storage), fs.constants.COPYFILE_FICLONE);
        made.push(storage);
        copied.set(`${n.id}:${a.id}`, { ...a, size: fs.statSync(path.join(config.filesDir, storage)).size, storage });
      }
    }
  } catch (err) {
    for (const s of made) fs.rmSync(path.join(config.filesDir, s), { force: true });
    throw err;
  }

  let res;
  try {
    res = tx(() => {
      const now = Date.now();
      const books = new Map();
      const created = [];
      const newBook = (b, name) => {
        const id = Number(db.prepare('INSERT INTO notebooks (name, stack_id, created_at) VALUES (?, ?, ?)')
          .run(String(name).slice(0, 200) || 'Restored notes', liveStack(b.stack), now).lastInsertRowid);
        created.push(id);
        return id;
      };
      for (const b of pkg.notebooks) {
        if (into != null) { books.set(b.key, into); continue; }
        const taken = liveNotebook(b.name);
        if (b.whole || newNotebooks) {
          let name = b.name;
          if (taken && label) {
            name = `${b.name} (${label})`;
            for (let n = 2; liveNotebook(name); n++) name = `${b.name} (${label} ${n})`;
          }
          books.set(b.key, newBook(b, name));
          continue;
        }
        const same = sameAccount && b.id ? db.prepare('SELECT id FROM notebooks WHERE id = ? AND name = ?').get(b.id, b.name)?.id : null;
        books.set(b.key, same ?? taken ?? newBook(b, b.name));
      }
      const fallback = () => db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get().id;
      const titleTaken = db.prepare('SELECT 1 FROM notes WHERE notebook_id = ? AND title = ? AND deleted_at IS NULL LIMIT 1');
      const ins = db.prepare(`INSERT INTO notes (notebook_id, title, html, text, pinned, is_template, created_at, updated_at)
        VALUES (?, ?, '', '', ?, ?, ?, ?)`);
      const att = db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      const newIds = new Map();
      const placed = [];
      for (const n of pkg.notes) {
        const nb = books.get(n.notebook) ?? fallback();
        let title = String(n.title).slice(0, 500);
        if (label && !created.includes(nb) && titleTaken.get(nb, title)) title = `${title} (${label})`.slice(0, 500);
        const id = Number(ins.run(nb, title, n.pinned ? 1 : 0, n.is_template ? 1 : 0, Number(n.created_at) || now, now).lastInsertRowid);
        newIds.set(Number(n.id), id);
        const fileIds = new Map();
        for (const a of n.attachments ?? []) {
          const c = copied.get(`${n.id}:${a.id}`);
          if (c) fileIds.set(Number(a.id), Number(att.run(id, String(c.filename).slice(0, 255), String(c.mime), c.size, c.storage, Number(c.created_at) || now).lastInsertRowid));
        }
        placed.push({ n, id, fileIds });
      }
      const upd = db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?');
      for (const { n, id, fileIds } of placed) {
        const html = relink(pointAt(n.html, fileIds), newIds, sameAccount);
        upd.run(html, htmlToText(html), id);
        setNoteTags(id, Array.isArray(n.tags) ? n.tags.map(String) : []);
      }
      return { notes: placed.length, notebooks: created, noteIds: placed.map((p) => p.id), attachments: copied.size, missing };
    });
  } catch (err) {
    for (const s of made) fs.rmSync(path.join(config.filesDir, s), { force: true });
    throw err;
  }
  // 10.1: notebooks a package brings fold into My notes, their names becoming tags.
  absorbNotebooks(res.notebooks);
  return { ...res, notebooks: [] };
}
