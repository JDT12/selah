import { db, tx, getSetting, setSetting } from './db.js';

/**
 * 10.1: notes are sorted by tags, not notebooks. You see one notebook, My notes, and the Inbox; the builders keep
 * notebooks of their own (a study's, Sermons, Bible Study), marked `managed` and never shown. A note in the Inbox
 * moves to My notes as soon as it has a tag. Every other notebook is folded into My notes, its name (and its shelf's)
 * becoming a tag on its notes: at the first start of 10.1, at every start after that, and after an import or a
 * restore that made one. Notes in a builder's notebook get the work's tag once, so they show in My notes too.
 */

const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('notebooks', 'managed')) db.exec('ALTER TABLE notebooks ADD COLUMN managed INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('notes', 'work_tagged')) db.exec('ALTER TABLE notes ADD COLUMN work_tagged INTEGER NOT NULL DEFAULT 0');

const exists = (id) => !!id && !!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id);

/** Names that say nothing about the notes in them, so folding their notebook adds no tag. */
const PLAIN = new Set(['first notebook', 'my notes', 'notes', 'inbox', 'restored notes', 'imported', 'untitled']);

/** The Inbox's id, or null (capture.js makes it when it's first needed). */
export function inboxNotebook() {
  const id = Number(getSetting('inboxNotebook'));
  return exists(id) ? id : null;
}

/** My notes' id, made the first time it's needed. */
export function myNotesId() {
  const id = Number(getSetting('myNotesNotebook'));
  if (exists(id)) return id;
  const inbox = inboxNotebook();
  const found = db.prepare("SELECT id FROM notebooks WHERE name = 'My notes' COLLATE NOCASE AND managed = 0 AND id IS NOT ? ORDER BY id LIMIT 1").get(inbox);
  const nb = found?.id ?? Number(db.prepare("INSERT INTO notebooks (name, created_at) VALUES ('My notes', ?)").run(Date.now()).lastInsertRowid);
  setSetting('myNotesNotebook', String(nb));
  return nb;
}

const addTag = (() => {
  let ins; let get; let link;
  return (noteId, name) => {
    ins ??= db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
    get ??= db.prepare('SELECT id FROM tags WHERE name = ?');
    link ??= db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)');
    const clean = String(name ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!clean) return;
    ins.run(clean);
    link.run(noteId, get.get(clean).id);
  };
})();

/** Tagged notes in the Inbox move to My notes. Cheap; called whenever tags change. */
export function fileTaggedInbox() {
  const inbox = inboxNotebook();
  if (!inbox) return 0;
  return Number(db.prepare(`UPDATE notes SET notebook_id = ? WHERE notebook_id = ? AND is_template = 0
    AND EXISTS (SELECT 1 FROM note_tags WHERE note_id = notes.id)`).run(myNotesId(), inbox).changes);
}

/** Marks the builders' notebooks as managed: each study's, course's and class's, Sermons and Bible Study. */
export function markManaged() {
  const keep = [myNotesId(), inboxNotebook()];
  db.prepare(`UPDATE notebooks SET managed = 1 WHERE managed = 0 AND id NOT IN (?, ?) AND (
    id IN (SELECT notebook_id FROM studies WHERE notebook_id IS NOT NULL)
    OR name COLLATE NOCASE IN ('Sermons', 'Bible Study'))`).run(keep[0], keep[1] ?? -1);
}

/**
 * Folds a notebook into My notes: its notes (in the Trash too) move there and get its name, and its shelf's, as
 * tags; templates move without tags. Then the notebook goes. Call inside tx().
 */
export function absorbNotebook(id) {
  const nb = db.prepare('SELECT n.id, n.name, n.managed, s.name AS stack FROM notebooks n LEFT JOIN stacks s ON s.id = n.stack_id WHERE n.id = ?').get(id);
  const into = myNotesId();
  if (!nb || nb.id === into || nb.id === inboxNotebook() || nb.managed) return 0;
  const names = [nb.name, nb.stack].filter((x) => x && !PLAIN.has(x.trim().toLowerCase()));
  const notes = db.prepare('SELECT id FROM notes WHERE notebook_id = ? AND is_template = 0').all(id);
  for (const { id: noteId } of notes) for (const name of names) addTag(noteId, name);
  db.prepare('UPDATE notes SET notebook_id = ? WHERE notebook_id = ?').run(into, id);
  db.prepare('UPDATE studies SET notebook_id = ? WHERE notebook_id = ?').run(into, id);
  db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
  return notes.length;
}

/** Folds every notebook made by an import or restore (ids) into My notes. */
export function absorbNotebooks(ids) {
  if (!ids?.length) return;
  tx(() => { for (const id of ids) absorbNotebook(Number(id?.id ?? id)); });
}

/**
 * Each note in a builder's notebook gets the work's tag once (the study's title, or the notebook's name: Sermons,
 * Bible Study), so it shows in My notes and in search. Removing the tag afterwards sticks.
 */
export function tagWork() {
  markManaged();
  const rows = db.prepare(`SELECT n.id, COALESCE((SELECT s.title FROM studies s WHERE s.notebook_id = nb.id ORDER BY s.id LIMIT 1), nb.name) AS work
    FROM notes n JOIN notebooks nb ON nb.id = n.notebook_id AND nb.managed = 1
    WHERE n.work_tagged = 0 AND n.is_template = 0 LIMIT 2000`).all();
  if (!rows.length) return;
  const done = db.prepare('UPDATE notes SET work_tagged = 1 WHERE id = ?');
  tx(() => {
    for (const r of rows) {
      addTag(r.id, r.work);
      done.run(r.id);
    }
  });
}

/**
 * The tidy-up at start: builders' notebooks are marked, every other notebook is folded into My notes, shelves and
 * notebook shortcuts go, notes without a notebook move to My notes, and tagged Inbox notes are filed. The first time
 * (the move to 10.1), a restore point is made first so the old layout can be brought back.
 */
export async function tidyNotebooks(log, takeRestorePoint) {
  const first = getSetting('notesLayout') !== 'tags';
  if (first && takeRestorePoint) {
    try { await takeRestorePoint(); } catch (e) { log?.warn(`Restore point before the 10.1 notes layout failed: ${e.message}`); }
  }
  let folded = 0;
  tx(() => {
    const into = myNotesId();
    markManaged();
    const inbox = inboxNotebook();
    for (const { id } of db.prepare('SELECT id FROM notebooks WHERE managed = 0 AND id IS NOT ? AND id IS NOT ?').all(into, inbox)) {
      folded += absorbNotebook(id);
    }
    db.prepare("DELETE FROM shortcuts WHERE kind IN ('notebook', 'stack')").run();
    db.prepare('UPDATE notebooks SET stack_id = NULL').run();
    db.prepare('DELETE FROM stacks').run();
    db.prepare('UPDATE notes SET notebook_id = ? WHERE notebook_id IS NULL AND is_template = 0 AND deleted_at IS NULL').run(into);
    if (first) db.prepare("DELETE FROM settings WHERE key = 'pref.railNotebooks'").run();
    setSetting('notesLayout', 'tags');
  });
  fileTaggedInbox();
  tagWork();
  if (folded) log?.info(`Folded ${folded} note(s) from other notebooks into My notes`);
}
