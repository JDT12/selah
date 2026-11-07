import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Selah Desktop (12.0): the library in a sync folder (OneDrive, iCloud Drive, Dropbox, a USB stick), the parts that
 * don't need the database. server/desktopsync.js has the rest.
 *
 * The live database never lives in the sync folder (sync apps upload half-written SQLite files, make conflict copies
 * and turn files into online-only placeholders). Each PC works on its own copy in %LOCALAPPDATA%\Selah, and the PC
 * that's editing writes a consistent copy to the folder every few minutes and when it closes:
 *
 *   <folder>/library.json        { format, gen, savedAt, savedBy: { id, pc }, version, notes }   (written last)
 *   <folder>/notes.db            a snapshot of the database
 *   <folder>/files/<storage>     every attachment
 *   <folder>/config/wordpress.key  the key that opens stored sign-ins (ESV, WordPress) on another PC
 *   <folder>/pcs/<id>.json       one file per PC, written only by that PC (so a sync app never sees two PCs write
 *                                the same file): { pc, state: 'editing' | 'reading' | 'closed', since, beat, ask?, forced? }
 *   <folder>/conflicts/          a PC's changes that couldn't be saved to the folder in time, as a backup file
 *
 * One PC edits at a time: the one whose pcs file says 'editing' with a heartbeat in the last STALE minutes (the
 * earliest `since` if two do). Another PC opens read-only, and can ask to take over (the editing PC saves, closes
 * its turn and drops to read-only) or, when that PC isn't answering, take over anyway.
 */

export const STALE = 10 * 60_000;
export const SYNC_FILE = path.join(config.dataDir, 'sync.json');
export const BEFORE_SYNC = path.join(path.dirname(config.storageDir), 'storage-before-sync');

const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
export function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

/** This PC's sync settings: { folder, id, gen (the folder copy it has), dirty, pulledAt, pushedAt } or null. */
export function syncState() {
  const s = readJson(SYNC_FILE);
  return s?.folder ? s : null;
}
export function saveSyncState(patch) {
  const s = { ...(readJson(SYNC_FILE) ?? {}), ...patch };
  if (!s.id) s.id = crypto.randomBytes(8).toString('hex');
  writeJson(SYNC_FILE, s);
  return s;
}
export const pcName = () => os.hostname();

export const libraryInfo = (folder) => readJson(path.join(folder, 'library.json'));
export const pcFile = (folder, id) => path.join(folder, 'pcs', `${id}.json`);

/** Every PC's file: [{ id, pc, state, since, beat, ask, forced }]. */
export function pcs(folder) {
  let names = [];
  try { names = fs.readdirSync(path.join(folder, 'pcs')); } catch { return []; }
  return names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n))
    .map((n) => ({ id: n.slice(0, 16), ...readJson(path.join(folder, 'pcs', n), {}) }))
    .filter((p) => p.state);
}

/** The PC editing now (or null): a fresh 'editing' heartbeat; a forced take-over beats an older turn. */
export function editor(folder, now = Date.now()) {
  const live = pcs(folder).filter((p) => p.state === 'editing' && now - (p.beat ?? 0) < STALE);
  live.sort((a, b) => (b.forced ?? 0) - (a.forced ?? 0) || (a.since ?? 0) - (b.since ?? 0));
  return live[0] ?? null;
}

function copyIfNeeded(from, to) {
  try {
    const a = fs.statSync(from);
    try { if (fs.statSync(to).size === a.size) return false; } catch { /* not there yet */ }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, `${to}.part`);
    fs.renameSync(`${to}.part`, to);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * At start, before db.js opens notes.db: when the folder has a newer copy than this PC, it becomes this PC's library.
 * This PC's own copy goes to storage-before-sync/ first (and, if it had changes it never saved to the folder, into
 * the folder's conflicts/ as well, by desktopsync.js once the server is up: `conflict` in the result).
 */
export function pullAtStart() {
  const s = syncState();
  if (!s || config.edition !== 'desktop') return null;
  const lib = libraryInfo(s.folder);
  if (!lib || !(lib.gen > (s.gen ?? -1))) return null;
  const src = path.join(s.folder, 'notes.db');
  if (!fs.existsSync(src)) return null;
  const conflict = !!s.dirty && fs.existsSync(config.dbPath);
  // Keep this PC's copy aside (the newest one only).
  fs.rmSync(BEFORE_SYNC, { recursive: true, force: true });
  fs.mkdirSync(BEFORE_SYNC, { recursive: true });
  for (const f of ['notes.db', 'notes.db-wal', 'notes.db-shm']) {
    const p = path.join(config.storageDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(BEFORE_SYNC, f));
  }
  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.copyFileSync(src, `${config.dbPath}.part`);
  fs.renameSync(`${config.dbPath}.part`, config.dbPath);
  // Attachments: the ones this PC doesn't have yet.
  const files = path.join(s.folder, 'files');
  let names = [];
  try { names = fs.readdirSync(files); } catch { /* none */ }
  fs.mkdirSync(config.filesDir, { recursive: true });
  for (const n of names) if (!n.endsWith('.part')) copyIfNeeded(path.join(files, n), path.join(config.filesDir, n));
  // The key that opens stored sign-ins; the app seals it the next time it starts.
  const key = path.join(s.folder, 'config', 'wordpress.key');
  if (fs.existsSync(key)) fs.copyFileSync(key, path.join(config.dataDir, 'wordpress.key'));
  saveSyncState({ gen: lib.gen, dirty: false, pulledAt: Date.now(), conflict: conflict ? { at: Date.now() } : null });
  return { gen: lib.gen, from: lib.savedBy?.pc ?? null, conflict };
}

/** Copies attachments to the folder (new ones) and removes ones the library no longer has. */
export function pushFiles(folder) {
  const to = path.join(folder, 'files');
  fs.mkdirSync(to, { recursive: true });
  let mine = [];
  try { mine = fs.readdirSync(config.filesDir); } catch { /* none */ }
  const have = new Set(mine);
  let copied = 0;
  for (const n of mine) if (copyIfNeeded(path.join(config.filesDir, n), path.join(to, n))) copied++;
  for (const n of fs.readdirSync(to)) if (!have.has(n) && !n.endsWith('.part')) fs.rmSync(path.join(to, n), { force: true });
  return copied;
}
