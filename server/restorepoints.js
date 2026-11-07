import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { db } from './db.js';
import { config } from './config.js';
import * as auth from './auth.js';
import { htmlToText } from './html.js';
import { importPackage, readPackage } from './notepack.js';
import { listBackups } from './desktopbackup.js';
import { syncState } from './desktopsyncfs.js';
import { unpackBackup } from './backupfile.js';
import { offsiteAttachment, offsiteConfigured, offsiteDownload, offsiteSnapshots, offsiteState } from './offsite.js';

/**
 * Restore from a backup: notes and notebooks as they were on an earlier day, brought back as copies.
 *
 * Restore points are made here, every day, whatever else is set up (config.restoreDir, on the notes disk):
 *   db/notes-<YYYY-MM-DD>.db.gz   the database as it was that day (its first hour the server was up): KEEP_DAYS days
 *   files/<YYYY-MM-DD>/           attachments removed that day (unlinkStorage in db.js moves them here), kept as long
 * The off-site backup (server/offsite.js), when it's connected, adds its own 30 days of snapshots.
 *
 * Opening one unpacks its database into restoreDir/open/ (read-only, removed after OPEN_IDLE). Restoring takes the
 * chosen notes or notebooks out of it as a package (server/notepack.js) and adds them as new notes: nothing here is
 * changed or replaced. Their attachments come from this Selah's files (unchanged since), the removed files kept
 * above, or the off-site backup.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const KEEP_DAYS = Number(process.env.NOTEAPP_RESTORE_DAYS || 14);
const OPEN_IDLE = 30 * 60_000;
const DB_DIR = path.join(config.restoreDir, 'db');
const FILES_DIR = path.join(config.restoreDir, 'files');
const OPEN_DIR = path.join(config.restoreDir, 'open');
const POINT_RE = /^notes-(\d{4}-\d\d-\d\d)\.db\.gz$/;
const DAY_RE = /^\d{4}-\d\d-\d\d$/;

const localDay = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: config.timeZone });
const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: config.timeZone, month: 'short', day: 'numeric' });

// ---------- making restore points ----------

/** The restore points here, newest first: [{ day, at, bytes }]. */
function points() {
  let names = [];
  try { names = fs.readdirSync(DB_DIR); } catch { return []; }
  return names.filter((n) => POINT_RE.test(n)).map((n) => {
    const st = fs.statSync(path.join(DB_DIR, n));
    return { day: POINT_RE.exec(n)[1], at: st.mtimeMs, bytes: st.size };
  }).sort((a, b) => b.day.localeCompare(a.day));
}

/** Today's restore point, if there isn't one yet; then old ones (and old removed files) go. */
export async function takeRestorePoint() {
  const day = localDay();
  const file = path.join(DB_DIR, `notes-${day}.db.gz`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
    const raw = path.join(DB_DIR, `.tmp-${process.pid}.db`);
    try {
      await backup(db, raw);
      await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${file}.tmp`));
      fs.renameSync(`${file}.tmp`, file);
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    }
  }
  const cutoff = localDay(Date.now() - KEEP_DAYS * 86_400_000);
  for (const p of points().filter((x) => x.day < cutoff)) fs.rmSync(path.join(DB_DIR, `notes-${p.day}.db.gz`), { force: true });
  let removed = [];
  try { removed = fs.readdirSync(FILES_DIR); } catch { /* none yet */ }
  for (const d of removed.filter((x) => DAY_RE.test(x) && x < cutoff)) fs.rmSync(path.join(FILES_DIR, d), { recursive: true, force: true });
}

/** A restore point each day, checked every half hour (and soon after the server starts). */
export function scheduleRestorePoints(log) {
  fs.rmSync(OPEN_DIR, { recursive: true, force: true }); // backups left open before a restart
  const tick = () => takeRestorePoint().catch((e) => log.warn(`Making today’s restore point failed: ${e.message}`));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 30 * 60_000).unref();
  // Restore points left open.
  setInterval(() => { for (const [token, o] of opened) if (Date.now() - o.used > OPEN_IDLE) close(token); }, 5 * 60_000).unref();
}

/**
 * Selah Desktop: backup files notes can be restored from too: the automatic backups (unencrypted ones) and the sync
 * folder's conflict copies. [{ source: 'file:<path>', at, label }], newest first.
 */
function backupFiles() {
  if (config.edition !== 'desktop') return [];
  const out = [];
  let auto = null;
  try { auto = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'desktop_backup'").get()?.value ?? 'null')?.folder; } catch { /* none */ }
  if (auto) for (const b of listBackups(auto)) if (!b.encrypted) out.push({ source: `file:${path.join(auto, b.file)}`, at: b.at, label: 'Automatic backup' });
  const s = syncState();
  if (s) {
    const dir = path.join(s.folder, 'conflicts');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.tar.gz')); } catch { /* none */ }
    for (const n of names) out.push({ source: `file:${path.join(dir, n)}`, at: fs.statSync(path.join(dir, n)).mtimeMs, label: `Conflict copy (${n.replace(/^selah-|-\d{4}-.*$/g, '')})` });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ---------- opening one ----------

const opened = new Map(); // token -> { db, dir, source, at, label, used, seen }

function close(token) {
  const o = opened.get(token);
  if (!o) return;
  opened.delete(token);
  try { o.db.close(); } catch { /* closed */ }
  fs.rmSync(o.dir, { recursive: true, force: true });
}

function session(token) {
  const o = opened.get(String(token ?? ''));
  if (!o) throw httpError(410, 'That backup was closed. Open it again.');
  o.used = Date.now();
  return o;
}

/** Unpacks a restore point ('local:<day>') or an off-site snapshot ('offsite:<name>') and opens it read-only. */
async function open(source) {
  const [kind, id] = String(source ?? '').split(/:(.*)/s);
  for (const [token, o] of opened) if (o.source === source) { o.used = Date.now(); return token; }
  // At most two open at once.
  while (opened.size >= 2) close([...opened.entries()].sort((a, b) => a[1].used - b[1].used)[0][0]);
  const token = crypto.randomBytes(16).toString('hex');
  const dir = path.join(OPEN_DIR, token);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    let gz;
    let at;
    if (kind === 'local') {
      if (!DAY_RE.test(id)) throw httpError(400, 'Choose a restore point.');
      gz = path.join(DB_DIR, `notes-${id}.db.gz`);
      if (!fs.existsSync(gz)) throw httpError(404, 'That restore point isn’t here any more.');
      at = fs.statSync(gz).mtimeMs;
    } else if (kind === 'offsite') {
      if (!offsiteConfigured()) throw httpError(409, 'Off-site backup isn’t connected.');
      gz = path.join(dir, 'snapshot.db.gz');
      await offsiteDownload(id, gz);
      at = (await offsiteSnapshots()).find((s) => s.name === id)?.at ?? Date.now();
    } else if (kind === 'file') {
      // Only the backup files listed (never any path a page asks for).
      if (!backupFiles().some((b) => b.source === source)) throw httpError(404, 'That backup file isn’t there any more.');
      await unpackBackup(id, null, dir);
      at = fs.statSync(id).mtimeMs;
    } else {
      throw httpError(400, 'Choose a backup.');
    }
    const file = path.join(dir, 'notes.db');
    if (gz) await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(file));
    if (kind === 'offsite') fs.rmSync(gz, { force: true });
    const snap = new DatabaseSync(file, { readOnly: true });
    if (Object.values(snap.prepare('PRAGMA quick_check').get())[0] !== 'ok') {
      snap.close();
      throw httpError(422, 'That backup is damaged. Try another day.');
    }
    opened.set(token, { db: snap, dir, source, at, label: `restored ${shortDate(at)}`, used: Date.now(), seen: {} });
    return token;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e.statusCode ? e : httpError(502, `That backup couldn’t be opened: ${e.message}`);
  }
}

/** What a note in the backup is to this Selah now: the same, changed since, in the Trash or deleted. */
function stateOf(n) {
  const live = db.prepare('SELECT updated_at, deleted_at FROM notes WHERE id = ? AND created_at = ?').get(n.id, n.created_at);
  if (!live) return 'deleted';
  if (live.deleted_at) return 'trash';
  return live.updated_at === n.updated_at ? 'same' : 'changed';
}

/** Where an attachment's file is: here, among removed files, or (fetched) in the off-site backup. */
async function fileFor(o, storage) {
  const here = path.join(config.filesDir, storage);
  if (fs.existsSync(here)) return here;
  const unpacked = path.join(o.dir, 'files', storage); // a backup file's own attachments
  if (fs.existsSync(unpacked)) return unpacked;
  let days = [];
  try { days = fs.readdirSync(FILES_DIR).filter((d) => DAY_RE.test(d)).sort().reverse(); } catch { /* none */ }
  for (const d of days) {
    const p = path.join(FILES_DIR, d, storage);
    if (fs.existsSync(p)) return p;
  }
  if (!offsiteConfigured()) return null;
  return offsiteAttachment(storage, path.join(o.dir, `file-${storage}`), o.seen).catch(() => null);
}

// ---------- routes ----------

export default async function restorePointRoutes(app) {
  // Where notes can be restored from: this Selah's restore points, and the off-site backup if it's connected.
  app.get('/api/restore/sources', async () => {
    const off = offsiteState();
    return {
      keepDays: KEEP_DAYS,
      local: points().map((p) => ({ source: `local:${p.day}`, at: p.at, day: p.day })),
      files: backupFiles(),
      offsite: off.configured ? { service: off.service, account: off.account } : null,
    };
  });

  app.get('/api/restore/offsite', async () => {
    if (!offsiteConfigured()) throw httpError(409, 'Off-site backup isn’t connected.');
    try {
      return { snapshots: (await offsiteSnapshots()).map((s) => ({ source: `offsite:${s.name}`, at: s.at })) };
    } catch (e) {
      throw httpError(502, `The off-site backup couldn’t be read: ${e.message}`);
    }
  });

  // Opens a backup: its notebooks, with how many notes each had.
  app.post('/api/restore/open', async (req) => {
    const token = await open(req.body?.source);
    const o = session(token);
    const notebooks = o.db.prepare(`SELECT nb.id, nb.name, s.name AS stack,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.is_template = 0) AS count
      FROM notebooks nb LEFT JOIN stacks s ON s.id = nb.stack_id ORDER BY s.name COLLATE NOCASE, nb.name COLLATE NOCASE`).all()
      .map((b) => ({ ...b, here: !!db.prepare('SELECT 1 FROM notebooks WHERE id = ? AND name = ?').get(b.id, b.name) }));
    const total = o.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND is_template = 0').get().n;
    return { token, at: o.at, label: o.label, notebooks, total };
  });

  // Notes in the backup: one notebook's, or those matching `q` (titles), each with what it is here now.
  app.get('/api/restore/:token/notes', async (req) => {
    const o = session(req.params.token);
    const args = [];
    let where = 'n.deleted_at IS NULL AND n.is_template = 0';
    if (req.query.notebook) { where += ' AND n.notebook_id = ?'; args.push(Number(req.query.notebook)); }
    const q = String(req.query.q ?? '').trim();
    if (q) { where += ' AND (n.title LIKE ? OR n.text LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (!req.query.notebook && !q) throw httpError(400, 'Choose a notebook or search.');
    return o.db.prepare(`SELECT n.id, n.notebook_id, n.title, substr(n.text, 1, 160) AS snippet, n.created_at, n.updated_at,
        (SELECT COUNT(*) FROM attachments a WHERE a.note_id = n.id) AS attachments
      FROM notes n WHERE ${where} ORDER BY n.updated_at DESC LIMIT 500`).all(...args).map((n) => ({ ...n, state: stateOf(n) }));
  });

  // One note as it was, to read before restoring it.
  app.get('/api/restore/:token/notes/:id', async (req) => {
    const o = session(req.params.token);
    const n = o.db.prepare('SELECT id, notebook_id, title, html, created_at, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.id));
    if (!n) throw httpError(404, 'That note isn’t in this backup.');
    return {
      id: n.id, title: n.title, text: htmlToText(n.html), created_at: n.created_at, updated_at: n.updated_at, state: stateOf(n),
      tags: o.db.prepare('SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name').all(n.id).map((t) => t.name),
      attachments: o.db.prepare('SELECT filename, size FROM attachments WHERE note_id = ? ORDER BY id').all(n.id),
    };
  });

  // Brings notes and whole notebooks back as copies: { notes: [ids], notebooks: [ids], notebook_id? }.
  app.post('/api/restore/:token/restore', async (req) => {
    const o = session(req.params.token);
    const b = req.body ?? {};
    const pkg = readPackage(o.db, { noteIds: b.notes, notebookIds: b.notebooks });
    const into = b.notebook_id != null ? Number(b.notebook_id) : null;
    const r = await importPackage(pkg, { resolveFile: (s) => fileFor(o, s), label: o.label, into, sameAccount: true });
    auth.logEvent('notes-restored', req, { from: o.source.split(':')[0], at: o.at, notes: r.notes, notebooks: (b.notebooks ?? []).length });
    return r;
  });

  app.delete('/api/restore/:token', async (req) => {
    close(String(req.params.token));
    return { ok: true };
  });
}
