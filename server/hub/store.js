import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * The share hub's records (14.1). One database for a Selah Ministry server: who each Selah is (and its key), who are
 * contacts, what is shared with whom, the shared notes (one copy, however many people see them), their comments, and
 * a queue of events for each Selah to pick up. Attachments live in files/<share id>/<storage name>.
 *
 * Selahs reach the hub with their own key over their own private network (server/hub/main.js), so a request's Selah
 * is known from the key, never from what it says about itself.
 */

export const DIR = path.resolve(process.env.NOTEAPP_HUB_DIR || path.join(process.cwd(), 'notes-data', 'hub'));
export const FILES = path.join(DIR, 'files');
fs.mkdirSync(FILES, { recursive: true });

export const db = new DatabaseSync(path.join(DIR, 'hub.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS tenants (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  sharing INTEGER NOT NULL DEFAULT 1,       -- the console can turn sharing off for one Selah
  active INTEGER NOT NULL DEFAULT 1,        -- paused Selahs keep their records but can't be shared with
  seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS contacts (
  a TEXT NOT NULL,                          -- the pair in name order (a < b)
  b TEXT NOT NULL,
  status TEXT NOT NULL,                     -- pending | accepted
  requested_by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- note | notebook | study
  title TEXT NOT NULL DEFAULT '',
  project TEXT,                             -- a project's kind and description (JSON)
  allow_comments INTEGER NOT NULL DEFAULT 1,
  allow_copy INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL               -- when something a reader sees last changed
);
CREATE TABLE IF NOT EXISTS share_people (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  seen_at INTEGER,
  PRIMARY KEY (share_id, slug)
);
CREATE TABLE IF NOT EXISTS notes (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  note_key INTEGER NOT NULL,                -- the note's id in the owner's Selah
  position INTEGER NOT NULL,
  grp TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  work TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, note_key)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  note_key INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  peer TEXT NOT NULL,                       -- the person (not the owner) the thread is with
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS comments_note ON comments(share_id, note_key);
CREATE TABLE IF NOT EXISTS comment_seen (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  PRIMARY KEY (comment_id, slug)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  at INTEGER NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_slug ON events(slug, seq);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  other TEXT,
  title TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS log_at ON log(at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 14.1: someone whose shares a person has hidden (Shared with me → Hide), without them being told.
CREATE TABLE IF NOT EXISTS hides (
  slug TEXT NOT NULL,                       -- who hides
  hides TEXT NOT NULL,                      -- whose shares
  at INTEGER NOT NULL,
  PRIMARY KEY (slug, hides)
);`);
// 14.1: "Show me to others" (on unless the person turns it off): everyone shown, with sharing on, is everyone's contact.
if (!db.prepare("SELECT 1 FROM pragma_table_info('tenants') WHERE name = 'listed'").get()) db.exec('ALTER TABLE tenants ADD COLUMN listed INTEGER NOT NULL DEFAULT 1');

export const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };
export const clip = (v, n) => String(v ?? '').trim().slice(0, n);
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
export const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

export const log = (kind, slug, other = null, title = null, detail = null) =>
  db.prepare('INSERT INTO log (at, kind, slug, other, title, detail) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), kind, slug, other, title ? clip(title, 300) : null, detail);

// ---------- Selahs ----------

export const tenant = (slug) => db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
export const nameOf = (slug) => tenant(slug)?.name || slug;
/** Can share and be shared with: known, running, and sharing not turned off for it. */
export const allowed = (slug) => { const t = tenant(slug); return !!t && !!t.active && !!t.sharing; };

/** The Selah a key belongs to, or null. Keys are 32 random bytes, kept only as hashes (so looking one up by its hash
 * gives nothing away about the others). */
export function slugForKey(key) {
  if (!key || key.length < 32) return null;
  return db.prepare('SELECT slug FROM tenants WHERE key_hash = ?').get(sha256(key))?.slug ?? null;
}

// ---------- contacts ----------

/**
 * On a Ministry server everyone belongs to the same church (14.1): every Selah with sharing on that shows itself to
 * others is every other one's contact, with no requests. (The contacts table is 8.0's, kept only as a record.)
 */
export const pair = (x, y) => (x < y ? [x, y] : [y, x]);
export const contactRow = (x, y) => db.prepare('SELECT * FROM contacts WHERE a = ? AND b = ?').get(...pair(x, y));
export const listed = (slug) => allowed(slug) && !!tenant(slug)?.listed;
export const areContacts = (x, y) => x !== y && listed(x) && listed(y);
export const hides = (slug, owner) => !!db.prepare('SELECT 1 FROM hides WHERE slug = ? AND hides = ?').get(slug, owner);

// ---------- shares ----------

export const shareRow = (id) => db.prepare('SELECT * FROM shares WHERE id = ?').get(String(id));
export const peopleOf = (id) => db.prepare('SELECT slug FROM share_people WHERE share_id = ? ORDER BY slug').all(id).map((r) => r.slug);
export const sharesWith = (slug, id) => !!db.prepare('SELECT 1 FROM share_people WHERE share_id = ? AND slug = ?').get(id, slug);
export const shareFiles = (id) => path.join(FILES, id);

/** Removes a share, its notes, comments and files. */
export function dropShare(id) {
  db.prepare('DELETE FROM shares WHERE id = ?').run(id);
  fs.rmSync(shareFiles(id), { recursive: true, force: true });
}

// ---------- events ----------

const waiting = new Map(); // slug -> Set of wake functions
export function emit(slug, msg) {
  db.prepare('INSERT INTO events (slug, at, msg) VALUES (?, ?, ?)').run(slug, Date.now(), JSON.stringify(msg));
  for (const wake of waiting.get(slug) ?? []) wake();
}

/** Events for a Selah after `after` (those up to it were received, so they go); waits up to `wait` ms for one. */
export async function eventsFor(slug, after, wait) {
  const top = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0;
  if (after > top) after = 0; // the hub's records were restored from an older backup
  db.prepare('DELETE FROM events WHERE slug = ? AND seq <= ?').run(slug, after);
  const rows = () => db.prepare('SELECT seq, msg FROM events WHERE slug = ? AND seq > ? ORDER BY seq LIMIT 100').all(slug, after);
  let list = rows();
  if (!list.length && wait > 0) {
    await new Promise((resolve) => {
      const set = waiting.get(slug) ?? new Set();
      waiting.set(slug, set);
      const done = () => { clearTimeout(t); set.delete(done); resolve(); };
      const t = setTimeout(done, wait);
      set.add(done);
    });
    list = rows();
  }
  return list.map((r) => ({ seq: r.seq, ...json(r.msg, {}) }));
}
