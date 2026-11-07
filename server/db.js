import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { applyPendingRestore } from './desktoprestore.js';

// Selah Desktop makes its library folder the first time (there's no separate disk to mount).
if (config.edition === 'desktop' && !fs.existsSync(config.storageMarker)) {
  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.writeFileSync(config.storageMarker, 'Selah Desktop library. Do not delete.\n');
}
if (config.edition === 'desktop') {
  try {
    const r = applyPendingRestore();
    if (r) console.log(`Restored the library from ${r.from}.`);
  } catch (e) {
    console.error(`Restoring the library failed: ${e.message}`);
  }
}
if (!fs.existsSync(config.storageMarker)) {
  console.error(`Notes storage not found at ${config.storageDir} (is the disk mounted?).\n`
    + 'To set it up, or to move existing notes there, run: npm run move-storage');
  process.exit(1);
}
fs.mkdirSync(config.filesDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stacks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  stack_id INTEGER REFERENCES stacks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS notes_notebook ON notes(notebook_id, deleted_at);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_note ON attachments(note_id);

-- Calendar events. start_at/end_at are floating wall-clock strings in the app time zone:
-- 'YYYY-MM-DD' (all-day, end inclusive) or 'YYYY-MM-DDTHH:mm'.
-- A recurring series has rrule set; exdates lists occurrence starts that were deleted or
-- overridden. An override (one edited occurrence) has parent_id + original_start.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'green',
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  parent_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  original_start TEXT,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_range ON events(start_at, end_at);
CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id);

-- Tasks. A recurring task has rrule + series_start; completing it creates the next one.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  due_time TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  series_start TEXT,
  completed_at INTEGER,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(completed_at, due_date);

-- Sidebar shortcuts to notebooks and stacks, in display order.
CREATE TABLE IF NOT EXISTS shortcuts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('notebook', 'stack', 'tag')),
  target_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (kind, target_id)
);
CREATE TRIGGER IF NOT EXISTS notebooks_shortcut_ad AFTER DELETE ON notebooks BEGIN
  DELETE FROM shortcuts WHERE kind = 'notebook' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS stacks_shortcut_ad AFTER DELETE ON stacks BEGIN
  DELETE FROM shortcuts WHERE kind = 'stack' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS tags_shortcut_ad AFTER DELETE ON tags BEGIN
  DELETE FROM shortcuts WHERE kind = 'tag' AND target_id = old.id;
END;

-- WordPress: the post each note was sent to (form = the choices made, to prefill the next update),
-- and files already uploaded to a site's media library (key: 'att:<attachment id>' or 'png:<sha256>').
CREATE TABLE IF NOT EXISTS wp_posts (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  link TEXT,
  status TEXT,
  form TEXT,
  posted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wp_media (
  key TEXT NOT NULL,
  site TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (key, site)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, text, content='notes', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO notes_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
`);

// Columns added after the first release. Each runs once, when the column is missing.
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('notes', 'dash_pinned')) {
  // Since 2.9.0 "pinned" (top of the notebook) and "on the dashboard" are separate; notes pinned before
  // that were on the dashboard, so they stay there.
  db.exec('ALTER TABLE notes ADD COLUMN dash_pinned INTEGER NOT NULL DEFAULT 0; UPDATE notes SET dash_pinned = pinned;');
}
// 2.10.0: templates are notes kept out of the notebooks and lists, used to start new notes.
if (!hasColumn('notes', 'is_template')) db.exec('ALTER TABLE notes ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0');
// 5.2.2: notes that open locked (read-only) until you unlock them.
if (!hasColumn('notes', 'read_only')) db.exec('ALTER TABLE notes ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0');
// 6.3: a trashed note whose notebook was deleted remembers it ({"name", "stack_id"}), so Restore can bring it back.
if (!hasColumn('notes', 'trash_notebook')) db.exec('ALTER TABLE notes ADD COLUMN trash_notebook TEXT');
// 7.2: what a note was posted as on WordPress: 'post' (a blog post) or 'devotional' (Scripture Blog 2.7's devotionals).
if (!hasColumn('wp_posts', 'kind')) db.exec("ALTER TABLE wp_posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'post'");
// 3.5.0: task lists, manual task order and checklist steps (a JSON array of { id, title, done }).
db.exec(`CREATE TABLE IF NOT EXISTS task_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
if (!hasColumn('tasks', 'list_id')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN list_id INTEGER REFERENCES task_lists(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN position REAL NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
    UPDATE tasks SET position = id;`);
}
db.exec('CREATE INDEX IF NOT EXISTS tasks_list ON tasks(list_id, completed_at)');
// 3.5.1: start dates. A task that hasn't started yet stays out of Today.
if (!hasColumn('tasks', 'start_date')) db.exec('ALTER TABLE tasks ADD COLUMN start_date TEXT');
// 5.4.5: reminders chosen per event and task, as a JSON list of minutes before (NULL: the usual ones).
if (!hasColumn('events', 'reminders')) db.exec('ALTER TABLE events ADD COLUMN reminders TEXT');
if (!hasColumn('tasks', 'reminders')) db.exec('ALTER TABLE tasks ADD COLUMN reminders TEXT');
// 2.11.0: tag colors, and tags can be shortcuts (SQLite can't change a CHECK, so the table is rebuilt).
if (!hasColumn('tags', 'color')) db.exec('ALTER TABLE tags ADD COLUMN color TEXT');
// 5.4.5: a tag can keep its notes out of the Scripture index.
if (!hasColumn('tags', 'ignore_scripture')) db.exec('ALTER TABLE tags ADD COLUMN ignore_scripture INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shortcuts'").get().sql.includes("'tag'")) {
  db.exec(`
    BEGIN;
    CREATE TEMP TABLE shortcuts_old AS SELECT id, kind, target_id, position FROM shortcuts;
    DROP TABLE shortcuts;
    CREATE TABLE shortcuts (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('notebook', 'stack', 'tag')),
      target_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      UNIQUE (kind, target_id)
    );
    INSERT INTO shortcuts (id, kind, target_id, position) SELECT id, kind, target_id, position FROM shortcuts_old;
    DROP TABLE shortcuts_old;
    COMMIT;`);
}

if (!db.prepare('SELECT 1 FROM notebooks LIMIT 1').get()) {
  db.prepare('INSERT INTO notebooks (name, created_at) VALUES (?, ?)').run('First Notebook', Date.now());
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * Removes attachment files (rows are removed by FK cascade or explicitly). They're moved into today's folder of
 * removed files (server/restorepoints.js), kept as long as the nightly restore points, so a note restored from one
 * gets its attachments back; deleted outright if that fails.
 */
export function unlinkStorage(storages) {
  if (!storages.length) return;
  const keep = path.join(config.restoreDir, 'files', new Date().toLocaleDateString('en-CA', { timeZone: config.timeZone }));
  try { fs.mkdirSync(keep, { recursive: true, mode: 0o700 }); } catch { /* deleted below */ }
  for (const s of storages) {
    const from = path.join(config.filesDir, s);
    fs.rename(from, path.join(keep, s), (err) => { if (err && err.code !== 'ENOENT') fs.rm(from, { force: true }, () => {}); });
  }
}

// 9.0: the Library is gone. Its books' files, highlights and places are deleted; reading notes and quotations
// already in notes stay as ordinary notes and text (their links back become plain text), and sermon bank items
// clipped from a book lose the link back.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books'").get()) {
  for (const { storage } of db.prepare('SELECT storage FROM books').all()) fs.rmSync(path.join(config.filesDir, storage), { force: true });
  db.exec(`DROP TABLE IF EXISTS book_highlights;
    DROP TABLE books;
    UPDATE sermon_bank SET source_url = '', source_page = '' WHERE source_url LIKE '#book/%';`);
  // Links back into a book become their plain text.
  const unlink = db.prepare('UPDATE notes SET html = ? WHERE id = ?');
  for (const n of db.prepare(`SELECT id, html FROM notes WHERE html LIKE '%href="#book/%'`).all()) {
    unlink.run(n.html.replace(/<a\b[^>]*\bhref="#book\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1'), n.id);
  }
}
