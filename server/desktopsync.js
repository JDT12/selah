import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { db } from './db.js';
import { config } from './config.js';
import { writeBackup } from './backupfile.js';
import { secretKey } from './secrets.js';
import {
  BEFORE_SYNC, STALE, editor, libraryInfo, pcFile, pcName, pcs, pushFiles, saveSyncState, syncState, writeJson,
} from './desktopsyncfs.js';

/**
 * Selah Desktop: the library in a sync folder, while the server runs (the layout and the pull at start are in
 * server/desktopsyncfs.js).
 *
 * Editing: every BEAT this PC's heartbeat goes in its pcs file; every SAVE_EVERY (and when Selah closes), if anything
 * changed, a fresh copy goes to the folder. Another PC asking to take over (`ask` in its pcs file) gets a save, then
 * this PC's turn ends and it carries on read-only. A PC that took over anyway (`forced`) ends this PC's turn too;
 * changes this PC hadn't saved to the folder go into the folder's conflicts/ as a backup file.
 *
 * Read-only: changes are refused (syncGate, 423). The page offers Take over, and Reload once a newer copy is in the
 * folder or the other PC has finished (the app restarts the server, which pulls it at start).
 */

const BEAT = Number(process.env.NOTEAPP_SYNC_BEAT_MS || 30_000); // shorter in tests
const SAVE_EVERY = 5 * 60_000;
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

let role = null; // null (not syncing) | 'editing' | 'reading'
let since = Date.now();
let readOnlyBy = null; // { pc, since } of the PC editing while this one reads
let lastSave = null; // { at, gen, ok, error }
let saving = null;
let asking = null; // { at }: this PC asked the editing PC to hand over
let ticking = false;
const startTicking = (log) => {
  if (ticking) return;
  ticking = true;
  setInterval(() => tick(log).catch((e) => log.warn(`Sync: ${e.message}`)), BEAT).unref();
};
let forcedAt = null; // this PC took over without waiting: its turn beats the other PC's

const myFile = (s) => pcFile(s.folder, s.id);
function beat(s, state, extra = {}) {
  try {
    writeJson(myFile(s), { pc: pcName(), state, since, beat: Date.now(), version: VERSION, ...(state === 'editing' && forcedAt ? { forced: forcedAt } : {}), ...extra });
  } catch (e) {
    lastSave = { ...(lastSave ?? {}), error: `The sync folder can’t be written (${e.code ?? e.message}).` };
  }
}

/** True while Selah Desktop is reading a library another PC is editing: changes are refused. */
export const syncReadOnly = () => role === 'reading';

/** Refuses changes while read-only (registered on the app itself in index.js, like requestChecks). */
export function syncGate(app) {
  if (config.edition !== 'desktop') return;
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || !MUTATING.has(req.method)) return;
    if (url.startsWith('/api/desktop/')) return;
    if (role === 'reading') {
      return reply.code(423).send({ error: `Read-only: ${readOnlyBy?.pc ?? 'another PC'} is using your library. Take over to make changes here.`, readOnly: true });
    }
  });
  // Something changed: there's a copy to save.
  app.addHook('onResponse', async (req, reply) => {
    if (role !== 'editing' || !MUTATING.has(req.method) || reply.statusCode >= 400) return;
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url.startsWith('/api/desktop/sync') || url === '/api/events') return;
    const s = syncState();
    if (s && !s.dirty) saveSyncState({ dirty: true });
  });
}

/** Writes a copy of the library to the folder (when something changed, or `force`). */
export function saveToFolder(log, { force = false } = {}) {
  if (saving) return saving;
  const job = (async () => {
    const s = syncState();
    if (!s || role !== 'editing') return null;
    if (!force && !s.dirty) return lastSave;
    // Our turn may have ended without our noticing (another PC took over): never overwrite its copy.
    const ed = editor(s.folder);
    if (ed && ed.id !== s.id) { await endTurn(log, ed); return null; }
    const lib = libraryInfo(s.folder);
    if (lib && lib.gen > (s.gen ?? -1) && lib.savedBy?.id !== s.id) {
      // Someone else saved a newer copy since we pulled: keep ours as a conflict, don't overwrite theirs.
      await conflictBackup(log, null);
      await endTurn(log, { pc: lib.savedBy?.pc });
      return null;
    }
    const tmp = path.join(config.dataDir, `sync-${process.pid}.db`);
    try {
      saveSyncState({ dirty: false }); // changes made from here on count for the next save
      await backup(db, tmp);
      pushFiles(s.folder);
      const key = path.join(s.folder, 'config', 'wordpress.key');
      if (!fs.existsSync(key)) { fs.mkdirSync(path.dirname(key), { recursive: true }); fs.writeFileSync(key, secretKey()); }
      fs.copyFileSync(tmp, path.join(s.folder, 'notes.db.part'));
      fs.renameSync(path.join(s.folder, 'notes.db.part'), path.join(s.folder, 'notes.db'));
      const gen = Math.max(lib?.gen ?? 0, s.gen ?? 0) + 1;
      const notes = db.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
      writeJson(path.join(s.folder, 'library.json'), { format: 1, gen, savedAt: Date.now(), savedBy: { id: s.id, pc: pcName() }, version: VERSION, notes });
      saveSyncState({ gen, pushedAt: Date.now() });
      lastSave = { at: Date.now(), gen, ok: true };
      return lastSave;
    } catch (e) {
      saveSyncState({ dirty: true });
      lastSave = { at: Date.now(), ok: false, error: e.message };
      log?.warn(`Saving to the sync folder failed: ${e.message}`);
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  })();
  saving = job.finally(() => { saving = null; });
  return saving;
}

/** This PC's changes that never reached the folder, as a backup file in the folder's conflicts/. */
async function conflictBackup(log, dbFile) {
  const s = syncState();
  const tmp = path.join(config.dataDir, `conflict-${process.pid}.db`);
  try {
    if (dbFile) {
      // A copy kept aside at start (with its WAL beside it): opening it folds the WAL in.
      const old = new DatabaseSync(dbFile);
      await backup(old, tmp);
      old.close();
    } else {
      await backup(db, tmp);
    }
    const dir = path.join(s.folder, 'conflicts');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const name = `selah-${pcName().replace(/[^\w-]+/g, '_')}-${stamp}.tar.gz`;
    await writeBackup(fs.createWriteStream(path.join(dir, `${name}.part`)), {
      snapshotDb: tmp, filesDir: config.filesDir, dataDir: config.dataDir, keyData: config.secretKey,
      manifest: { app: 'Selah', kind: 'sync-conflict', edition: 'desktop', version: VERSION, createdAt: new Date().toISOString(), pc: pcName(), notes: null },
    });
    fs.renameSync(path.join(dir, `${name}.part`), path.join(dir, name));
    saveSyncState({ conflict: { at: Date.now(), file: `conflicts/${name}` } });
    log?.warn(`Sync conflict: this PC's unsaved changes are in ${name}.`);
  } catch (e) {
    log?.error(`Keeping this PC's changes as a conflict copy failed: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function endTurn(log, by) {
  const s = syncState();
  if (s?.dirty) await conflictBackup(log, null);
  role = 'reading';
  forcedAt = null;
  readOnlyBy = { pc: by?.pc ?? 'another PC', since: by?.since ?? Date.now() };
  since = Date.now();
  beat(s, 'reading');
  saveSyncState({ dirty: false });
}

/** Every BEAT: the heartbeat, a save now and then, and answering another PC that asks to take over. */
async function tick(log) {
  const s = syncState();
  if (!s || !role) return;
  if (role === 'editing') {
    const ed = editor(s.folder);
    if (ed && ed.id !== s.id) { await endTurn(log, ed); return; }
    const asker = pcs(s.folder).find((p) => p.id !== s.id && p.ask && Date.now() - p.ask < STALE && Date.now() - (p.beat ?? 0) < STALE);
    if (asker) {
      try { await saveToFolder(log, { force: !!s.dirty }); } catch { return; } // can't save: keep the turn
      role = 'reading';
      readOnlyBy = { pc: asker.pc, since: Date.now() };
      since = Date.now();
      beat(s, 'reading', { handedTo: asker.id });
      return;
    }
    beat(s, 'editing');
    if (Date.now() - (lastSave?.at ?? s.pushedAt ?? 0) >= SAVE_EVERY) saveToFolder(log).catch(() => {});
  } else {
    beat(s, 'reading', asking ? { ask: asking.at } : {});
    const ed = editor(s.folder);
    readOnlyBy = ed ? { pc: ed.pc, since: ed.since } : readOnlyBy;
  }
}

/** At start (after any pull): this PC edits, unless another PC is editing. */
export function startSync(log, pulled) {
  const s = syncState();
  if (config.edition !== 'desktop' || !s) return;
  const ed = editor(s.folder);
  since = Date.now();
  if (ed && ed.id !== s.id && !s.forceNext) {
    role = 'reading';
    readOnlyBy = { pc: ed.pc, since: ed.since };
    beat(s, 'reading');
  } else {
    role = 'editing';
    if (s.forceNext) { forcedAt = Date.now(); saveSyncState({ forceNext: false }); }
    beat(s, 'editing');
    // A brand-new folder (or one this PC hasn't saved to yet): put the library there now.
    if (!libraryInfo(s.folder)) saveToFolder(log, { force: true }).catch(() => {});
  }
  if (pulled?.conflict) conflictBackup(log, path.join(BEFORE_SYNC, 'notes.db')).catch(() => {});
  startTicking(log);
}

/** Selah is closing: a last save, and this PC's turn ends. */
async function finish(log) {
  const s = syncState();
  if (!s || !role) return;
  if (role === 'editing') {
    try { await saveToFolder(log); } catch { /* kept dirty: saved next time */ }
  }
  beat(s, 'closed');
}

// ---------- routes ----------

export default async function desktopSync(app) {
  if (config.edition !== 'desktop') return;
  app.addHook('onClose', async () => finish(app.log));

  app.get('/api/desktop/sync', async () => {
    const s = syncState();
    if (!s) return { enabled: false };
    const lib = libraryInfo(s.folder);
    const ed = editor(s.folder);
    return {
      enabled: true, folder: s.folder, role, pc: pcName(),
      readOnlyBy: role === 'reading' ? readOnlyBy : null,
      editorActive: !!(ed && ed.id !== s.id),
      folderCopy: lib ? { gen: lib.gen, savedAt: lib.savedAt, by: lib.savedBy?.pc ?? null, notes: lib.notes } : null,
      newer: !!(lib && lib.gen > (s.gen ?? -1)),
      dirty: !!s.dirty, lastSave, pulledAt: s.pulledAt ?? null, asking, conflict: s.conflict ?? null,
    };
  });

  // Turns it on: { folder } (answers { existing } when the folder already holds a library), then { folder, use:
  // 'folder' | 'mine' }. 'folder' makes the folder's library this PC's (restart: pulled at start); 'mine' saves this
  // PC's library over it.
  app.put('/api/desktop/sync', async (req) => {
    const folder = path.resolve(String(req.body?.folder ?? ''));
    if (!req.body?.folder || !path.isAbsolute(String(req.body.folder))) throw httpError(400, 'Choose a folder.');
    const lib = path.dirname(config.storageDir).toLowerCase();
    if (folder.toLowerCase().startsWith(lib)) throw httpError(400, 'Choose a folder outside Selah’s own library folder.');
    try { fs.mkdirSync(path.join(folder, 'pcs'), { recursive: true }); } catch (e) { throw httpError(400, `Selah can’t use that folder (${e.code ?? e.message}).`); }
    const existing = libraryInfo(folder);
    const use = req.body?.use;
    if (existing && !use) return { existing: { savedAt: existing.savedAt, by: existing.savedBy?.pc ?? null, notes: existing.notes } };
    const ed = editor(folder);
    if (existing && use === 'mine' && ed) throw httpError(409, `${ed.pc} is using the library in that folder now. Close Selah there first.`);
    saveSyncState({ folder, gen: use === 'folder' ? -1 : (existing?.gen ?? 0), dirty: use !== 'folder', conflict: null });
    if (use === 'folder') return { ok: true, restart: true };
    role = 'editing';
    since = Date.now();
    beat(syncState(), 'editing');
    await saveToFolder(app.log, { force: true });
    startTicking(app.log);
    return { ok: true };
  });

  app.delete('/api/desktop/sync', async () => {
    const s = syncState();
    if (!s) return { ok: true };
    if (role === 'editing') { try { await saveToFolder(app.log); } catch { /* the folder copy is just older */ } }
    beat(s, 'closed');
    fs.rmSync(path.join(config.dataDir, 'sync.json'), { force: true });
    role = null;
    return { ok: true, readOnlyWas: false };
  });

  app.post('/api/desktop/sync/save', async (req) => {
    if (role !== 'editing') throw httpError(409, 'This PC is read-only now.');
    return saveToFolder(req.log, { force: true });
  });

  // Asks the editing PC to hand over; { force: true } takes over without waiting (restart: this PC pulls the
  // folder's copy at start and edits).
  app.post('/api/desktop/sync/take-over', async (req) => {
    const s = syncState();
    if (!s || role !== 'reading') throw httpError(409, 'This PC is already editing.');
    if (req.body?.force) {
      asking = null;
      saveSyncState({ forceNext: true });
      return { ok: true, restart: true };
    }
    asking = { at: Date.now() };
    beat(s, 'reading', { ask: asking.at });
    return { ok: true, asking };
  });

  app.delete('/api/desktop/sync/conflict', async () => { saveSyncState({ conflict: null }); return { ok: true }; });
}
