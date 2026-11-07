import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt } from './secrets.js';
import { backupKind, passphraseFits, unpackBackup, writeBackup } from './backupfile.js';
import { compareVersions } from '../shared/whatsnew.js';
import { BEFORE, PENDING } from './desktoprestore.js';

/**
 * Selah Desktop (12.0): automatic backups and replacing the whole library.
 *
 * Backups are ordinary backup files (server/backupfile.js: .tar.gz, or .selahbak with a passphrase) written to a
 * folder the person picks, usually their OneDrive, iCloud Drive or Dropbox folder (suggested below), so a lost PC
 * doesn't lose the library. One is made after the app starts when the last is older than the chosen interval, then
 * checked every half hour while it runs; the newest `keep` stay. Each is written to a hidden .part file first and
 * renamed when finished, so a sync app never uploads half a backup.
 *
 * Restoring (from one of these, or Import a library from any backup file, including a Cloud one) replaces the whole
 * library. It can't happen under the open database, so the file is unpacked and checked into data/restore-pending/
 * and the app restarts the server; db.js calls applyPendingRestore() before it opens notes.db, which moves the current
 * library aside to storage-before-restore/ (server/desktoprestore.js) (the newest one only) and puts the backup's in place.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const NAME_RE = /^selah-backup-(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)(?:-\d+)?\.(tar\.gz|selahbak)$/;
const EVERY = { daily: 86_400_000, weekly: 7 * 86_400_000, off: Infinity };

// ---------- settings ----------

/** { folder, every, keep, passphrase (sealed), last: { at, file, bytes } | null, error } */
function state() {
  let s = {};
  try { s = JSON.parse(getSetting('desktop_backup') ?? '{}') ?? {}; } catch { /* defaults */ }
  return {
    folder: typeof s.folder === 'string' ? s.folder : null,
    every: Object.hasOwn(EVERY, s.every) ? s.every : 'daily',
    keep: Number.isInteger(s.keep) && s.keep >= 2 && s.keep <= 60 ? s.keep : 10,
    passphrase: s.passphrase ?? null,
    last: s.last ?? null,
    error: s.error ?? null,
  };
}
const save = (patch) => setSetting('desktop_backup', JSON.stringify({ ...state(), ...patch }));
const passphraseOf = (s) => { try { return s.passphrase ? decrypt(s.passphrase) : null; } catch { return null; } };

/** Sync folders on this PC that a backup folder could go in: [{ name, path }]. */
export function syncFolders() {
  const home = os.homedir();
  const found = [];
  const add = (name, p) => {
    if (!p || found.some((f) => f.path.toLowerCase() === p.toLowerCase())) return;
    try { if (fs.statSync(p).isDirectory()) found.push({ name, path: p }); } catch { /* not here */ }
  };
  add('OneDrive', process.env.OneDriveConsumer);
  add('OneDrive', process.env.OneDrive);
  add('OneDrive for work or school', process.env.OneDriveCommercial);
  add('iCloud Drive', path.join(home, 'iCloudDrive'));
  add('Dropbox', path.join(home, 'Dropbox'));
  add('Google Drive', path.join(home, 'Google Drive'));
  add('Google Drive', path.join(home, 'My Drive'));
  return found;
}

/** The suggested backup folder: "Selah backups" in the first sync folder, else in Documents. */
export function suggestedFolder() {
  const base = syncFolders()[0]?.path ?? path.join(os.homedir(), 'Documents');
  return path.join(base, 'Selah backups');
}

function checkFolder(folder) {
  const p = path.resolve(String(folder ?? ''));
  if (!folder || !path.isAbsolute(String(folder))) throw httpError(400, 'Choose a folder.');
  // The library's own folder would be backed up into itself, and lost with it.
  const lib = path.dirname(config.storageDir).toLowerCase();
  if (p.toLowerCase() === lib || p.toLowerCase().startsWith(lib + path.sep)) throw httpError(400, 'Choose a folder outside Selah’s own library folder.');
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.selah-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw httpError(400, `Selah can’t write to that folder (${e.code ?? e.message}).`);
  }
  return p;
}

// ---------- the backups in the folder ----------

/** Backups in the folder, newest first: [{ file, at, bytes, encrypted }]. */
export function listBackups(folder = state().folder) {
  if (!folder) return [];
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((n) => NAME_RE.test(n)).map((n) => {
    const st = fs.statSync(path.join(folder, n));
    return { file: n, at: st.mtimeMs, bytes: st.size, encrypted: n.endsWith('.selahbak') };
  }).sort((a, b) => b.at - a.at);
}

let running = null;

/** Makes a backup now (one at a time). Resolves to { file, at, bytes }. */
export function runBackup(log) {
  if (running) return running;
  const job = (async () => {
    const s = state();
    if (!s.folder) throw httpError(409, 'Choose a backup folder first.');
    const folder = checkFolder(s.folder);
    const passphrase = passphraseOf(s);
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: config.timeZone }));
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}-${pad(local.getHours())}${pad(local.getMinutes())}`;
    const ext = passphrase ? 'selahbak' : 'tar.gz';
    let name = `selah-backup-${stamp}.${ext}`;
    for (let i = 2; fs.existsSync(path.join(folder, name)); i++) name = `selah-backup-${stamp}-${i}.${ext}`;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(config.dataDir, 'autobackup-'));
    const part = path.join(folder, `.${name}.part`);
    try {
      const snap = path.join(tmp, 'notes.db');
      await backup(db, snap);
      const check = new DatabaseSync(snap, { readOnly: true });
      const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
      check.close();
      const r = await writeBackup(fs.createWriteStream(part), {
        snapshotDb: snap, filesDir: config.filesDir, dataDir: config.dataDir, certDir: null, keyData: config.secretKey,
        manifest: { app: 'Selah', kind: 'desktop-automatic', edition: 'desktop', version: VERSION, createdAt: now.toISOString(), tenant: null, timeZone: config.timeZone, notes },
        passphrase,
      });
      fs.renameSync(part, path.join(folder, name));
      const last = { at: Date.now(), file: name, bytes: r.bytes };
      save({ last, error: null });
      // The newest `keep` stay.
      for (const old of listBackups(folder).slice(s.keep)) fs.rmSync(path.join(folder, old.file), { force: true });
      return last;
    } catch (e) {
      fs.rmSync(part, { force: true });
      save({ error: { at: Date.now(), message: e.message } });
      log?.warn(`Automatic backup failed: ${e.message}`);
      throw e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  running = job.finally(() => { running = null; });
  return running;
}

/** A backup when the last is older than the chosen interval: soon after starting, then every half hour. */
export function scheduleDesktopBackups(log) {
  if (config.edition !== 'desktop') return;
  const tick = () => {
    const s = state();
    if (!s.folder || s.every === 'off' || running) return;
    const last = Math.max(s.last?.at ?? 0, listBackups(s.folder)[0]?.at ?? 0);
    if (Date.now() - last >= EVERY[s.every]) runBackup(log).catch(() => {});
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}

// ---------- the Desktop demo ----------

/**
 * Selah Desktop's demo library (NOTEAPP_DESKTOP_DEMO=1; desktop-app/scripts/demo.mjs): on an empty library, the demo
 * tenant's sample data (server/demo/seed.js), then automatic backups to Demo OneDrive/Selah backups beside the demo's Selah folder
 * dated over the last two weeks, so Settings → Data & backup shows a real-looking list. Run once; a library with
 * notes is left alone.
 */
export async function seedDesktopDemo(app, log) {
  if (config.edition !== 'desktop' || process.env.NOTEAPP_DESKTOP_DEMO !== '1') return;
  if (db.prepare('SELECT count(*) AS n FROM notes WHERE is_template = 0').get().n > 0) return;
  const { seedDemo } = await import('./demo/seed.js');
  const r = await seedDemo(app, {});
  // Beside the demo's Selah folder (a folder inside it isn't allowed for backups).
  const folder = path.join(path.dirname(path.dirname(config.storageDir)), 'Demo OneDrive', 'Selah backups');
  fs.mkdirSync(folder, { recursive: true });
  save({ folder, every: 'daily', keep: 10 });
  const pad = (n) => String(n).padStart(2, '0');
  // Newest first: yesterday morning back to two weeks ago.
  for (const [daysAgo, hh, mm] of [[1, 7, 4], [2, 7, 2], [3, 19, 41], [5, 7, 3], [8, 8, 15], [13, 7, 1]]) {
    const made = await runBackup(log);
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    d.setHours(hh, mm, 0, 0);
    const name = `selah-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(hh)}${pad(mm)}.tar.gz`;
    fs.renameSync(path.join(folder, made.file), path.join(folder, name));
    fs.utimesSync(path.join(folder, name), d, d);
  }
  const newest = listBackups(folder)[0];
  save({ last: { at: newest.at, file: newest.file, bytes: newest.bytes }, error: null });
  log.info(`Desktop demo: sample data (${JSON.stringify(r.counts ?? r)}) and ${listBackups(folder).length} backups.`);
}

// ---------- replacing the library ----------

/** A backup file to restore: one in the backup folder (by name), or a full path the app's file picker gave. */
function backupFile(body) {
  if (body?.file) {
    const folder = state().folder;
    if (!folder || !NAME_RE.test(String(body.file))) throw httpError(400, 'Choose a backup.');
    return path.join(folder, String(body.file));
  }
  const p = String(body?.path ?? '');
  if (!path.isAbsolute(p)) throw httpError(400, 'Choose a backup file.');
  return p;
}

async function stageRestore(file, passphrase) {
  if (!fs.existsSync(file)) throw httpError(404, 'That backup file isn’t there any more.');
  const kind = backupKind(file);
  if (kind === 'zip') throw httpError(400, 'That’s an older “Download all my data” file. Use Import instead.');
  if (!kind) throw httpError(400, 'That isn’t a Selah backup file.');
  if (kind === 'encrypted') {
    if (!passphrase) throw httpError(400, 'This backup is encrypted. Enter its passphrase.');
    if (!(await passphraseFits(file, passphrase))) throw httpError(400, 'That passphrase doesn’t open this backup.');
  }
  fs.rmSync(PENDING, { recursive: true, force: true });
  const dir = path.join(PENDING, 'unpacked');
  try {
    const r = await unpackBackup(file, kind === 'encrypted' ? passphrase : null, dir);
    // A backup from a newer Selah may hold tables this one doesn't know yet.
    const from = r.manifest?.version;
    if (from && compareVersions(from, VERSION) > 0) {
      throw httpError(400, `This backup is from Selah ${from}, newer than this app (${VERSION}). Update Selah first, then restore it.`);
    }
    fs.writeFileSync(path.join(PENDING, 'ready.json'), JSON.stringify({ at: Date.now(), from: path.basename(file), notes: r.notes, version: from ?? null }));
    return r;
  } catch (e) {
    fs.rmSync(PENDING, { recursive: true, force: true });
    throw e;
  }
}

// ---------- routes ----------

export default async function desktopBackups(app) {
  if (config.edition !== 'desktop') return;

  app.get('/api/desktop/backups', async () => {
    const s = state();
    let restored = null;
    try { restored = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'restored.json'), 'utf8')); } catch { /* none */ }
    return {
      folder: s.folder, every: s.every, keep: s.keep, encrypted: !!s.passphrase,
      last: s.last, error: s.error, running: !!running,
      backups: listBackups(s.folder),
      suggested: suggestedFolder(), syncFolders: syncFolders(),
      before: fs.existsSync(BEFORE), restored,
    };
  });

  app.put('/api/desktop/backups', async (req) => {
    const b = req.body ?? {};
    const patch = {};
    if (b.folder !== undefined) patch.folder = b.folder ? checkFolder(b.folder) : null;
    if (b.every !== undefined) {
      if (!Object.hasOwn(EVERY, b.every)) throw httpError(400, 'Choose how often.');
      patch.every = b.every;
    }
    if (b.keep !== undefined) {
      const k = Number(b.keep);
      if (!Number.isInteger(k) || k < 2 || k > 60) throw httpError(400, 'Keep between 2 and 60 backups.');
      patch.keep = k;
    }
    if (b.passphrase !== undefined) {
      if (b.passphrase === null || b.passphrase === '') patch.passphrase = null;
      else {
        const p = String(b.passphrase);
        if (p.length < 12) throw httpError(400, 'Use a passphrase of at least 12 characters.');
        if (/[\r\n]/.test(p)) throw httpError(400, 'The passphrase can’t contain line breaks.');
        patch.passphrase = encrypt(p);
      }
    }
    save(patch);
    return { ok: true };
  });

  app.post('/api/desktop/backups/run', async (req) => runBackup(req.log));

  // Checks and stages a restore; the app then restarts the server, which puts it in place.
  app.post('/api/desktop/restore', async (req) => {
    const file = backupFile(req.body);
    if (running) throw httpError(409, 'A backup is being made. Try again when it finishes.');
    const r = await stageRestore(file, req.body?.passphrase ? String(req.body.passphrase) : null);
    return { ok: true, notes: r.notes, files: r.files, createdAt: r.createdAt, version: r.manifest?.version ?? null, restart: true };
  });

  app.delete('/api/desktop/restore', async () => {
    fs.rmSync(PENDING, { recursive: true, force: true });
    return { ok: true };
  });

  app.delete('/api/desktop/restored', async () => {
    fs.rmSync(path.join(config.dataDir, 'restored.json'), { force: true });
    return { ok: true };
  });
}
