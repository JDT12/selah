import { db } from './db.js';
import { fileTaggedInbox } from './mynotes.js';

// Keep in step with client/src/tagColors.js. Task lists use the same colors.
export const TAG_COLORS = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'sky', 'blue', 'indigo', 'purple', 'pink', 'gray'];

/** Tag names: trimmed, single spaces, no commas (the tag box splits on them), at most 100 characters. */
export const cleanTagName = (name) => String(name ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/** Moves every note from one tag to another and deletes the first. Call inside tx(). */
export function mergeTag(fromId, intoId) {
  db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) SELECT note_id, ? FROM note_tags WHERE tag_id = ?').run(intoId, fromId);
  db.prepare('DELETE FROM tags WHERE id = ?').run(fromId);
}

/** Tags are kept only while some note (including one in the trash) uses them. */
export function dropUnusedTags() {
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)').run();
}

/** Replace a note's tags with the given names (creating tags as needed). Call inside tx(). */
export function setNoteTags(noteId, names) {
  const clean = [...new Set(names.map(cleanTagName).filter(Boolean))].slice(0, 100);
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  const ins = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const get = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)');
  for (const name of clean) {
    ins.run(name);
    link.run(noteId, get.get(name).id);
  }
  dropUnusedTags();
  if (clean.length) fileTaggedInbox(); // 10.1: a tagged note leaves the Inbox for My notes
}

export function noteTags(noteId) {
  return db
    .prepare('SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ? ORDER BY t.name')
    .all(noteId)
    .map((r) => r.name);
}
