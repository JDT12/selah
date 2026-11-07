import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import {
  FOLDER, SERVICE_NAMES, buildConf, obscure, onedriveDrive, onedriveSection, oneDriveAuthorizer, parseToken, probeStorage, rclonePath, rcloneRunner,
  rcloneVersion, storageSection, storageTarget, writeConf,
} from './rclone.js';

/**
 * Encrypted off-site backup to storage the person owns, through rclone (scripts/install-rclone.sh): OneDrive, any
 * S3-compatible service (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3, others) or a WebDAV server (Nextcloud,
 * Synology, Koofr…).
 *
 * rclone holds the sign-in (for OneDrive from `rclone authorize "onedrive"`, run here or on any computer with a
 * browser; for the others a key or password) as the [target] remote (configs made before 6.1: [onedrive]), and a
 * "crypt" layer keyed by the user's passphrase, so file contents and names are encrypted before they leave this
 * server. Its config lives in data/offsite/rclone.conf (mode 600).
 * Because it's standard rclone crypt, the backup can also be read with rclone alone.
 *
 * Inside the encrypted folder:
 *   db/notes-<UTC stamp>.db.gz   database snapshots: KEEP_DAYS days, but never fewer than the newest KEEP_MIN
 *   files/                       attachments, synced incrementally
 *   deleted/<UTC stamp>/         attachments removed since the previous run (kept KEEP_DELETED_DAYS)
 *   config/certs/, config/wordpress.key   the server's certificates (none for a tenant, which has no TLS of its own) and the WordPress key
 *   manifest.json                what the latest backup contains
 *
 * Runs nightly from scripts/backup.js, or from Settings → Off-site backup. One run at a time
 * (a lock file shared by the server and the nightly script).
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

const DIR = path.join(config.dataDir, 'offsite');
const CONF = path.join(DIR, 'rclone.conf');
const LOCK = path.join(DIR, 'lock.json');
const KEEP_DAYS = Number(process.env.NOTEAPP_OFFSITE_DAYS || 30);
const KEEP_MIN = Number(process.env.NOTEAPP_OFFSITE_MIN || 3);
const KEEP_DELETED_DAYS = KEEP_DAYS;
const VERIFY_EVERY = 6.5 * 86_400_000;
// Tests point the backup at a local folder instead of OneDrive.
const TEST_REMOTE = process.env.NOTEAPP_OFFSITE_TEST_REMOTE || null;
const PKG = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'));
const rclone = rcloneRunner(CONF);

// ---------- state ----------

const readJson = (key, fallback) => {
  try { return JSON.parse(getSetting(key)) ?? fallback; } catch { return fallback; }
};
const connection = () => (fs.existsSync(CONF) ? readJson('offsite', null) : null);
export const offsiteConfigured = () => !!connection();
/** Where the encrypted folder is (remote:path). Connections made before 6.1 were all OneDrive. */
const rootOf = (c) => c?.root ?? `onedrive:${FOLDER}`;
const serviceOf = (c) => c?.service ?? 'onedrive';

/** For the admin console's health check. */
export function offsiteState() {
  const c = connection();
  const s = readJson('offsite_status', {});
  return {
    configured: !!c, account: c?.account ?? null, service: c ? SERVICE_NAMES[serviceOf(c)] : null,
    last: s.last ?? null, lastSuccess: s.lastSuccess ?? null,
  };
}

/**
 * Tenant mode: the nightly backup runs at a time between 03:15 and 06:15 UTC picked from the tenant's name, so tenants
 * on one server don't all upload at once (scheduled in server/tenant.js).
 */
export function nightlySlot(name = config.tenant ?? '') {
  const h = crypto.createHash('sha256').update(name).digest().readUInt16BE(0);
  return 3 * 60 + 15 + (h % 180); // minutes after midnight UTC
}

function saveRun(run) {
  const s = readJson('offsite_status', {});
  const next = { ...s, last: run, history: [run, ...(s.history ?? [])].slice(0, 10) };
  if (run.ok && run.kind === 'backup') next.lastSuccess = run;
  if (run.verify) next.lastVerify = run.verify;
  setSetting('offsite_status', JSON.stringify(next));
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** The run in progress, if any (clears a lock left behind by a process that died). */
function running() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (alive(l.pid)) return l;
    fs.rmSync(LOCK, { force: true });
  } catch { /* no lock */ }
  return null;
}

function lock(kind, trigger) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  running(); // clears a stale lock
  const l = { pid: process.pid, kind, trigger, startedAt: Date.now(), phase: 'Starting' };
  try {
    fs.writeFileSync(LOCK, JSON.stringify(l), { flag: 'wx' });
  } catch {
    throw httpError(409, 'A backup is already running.');
  }
  return {
    phase(p) { l.phase = p; fs.writeFileSync(LOCK, JSON.stringify(l)); },
    release() { fs.rmSync(LOCK, { force: true }); },
  };
}

// ---------- backup ----------

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261018T031500Z

function localFiles() {
  let count = 0;
  let bytes = 0;
  for (const f of fs.readdirSync(config.filesDir, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    count++;
    bytes += fs.statSync(path.join(config.filesDir, f.name)).size;
  }
  return { count, bytes };
}

async function snapshot(tmp) {
  const raw = path.join(tmp, 'notes.db');
  await backup(db, raw);
  const snap = new DatabaseSync(raw, { readOnly: true });
  const notes = snap.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
  snap.close();
  const name = `notes-${stamp()}.db.gz`;
  await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 9 }), fs.createWriteStream(path.join(tmp, name)));
  return { file: path.join(tmp, name), name, notes, bytes: fs.statSync(path.join(tmp, name)).size };
}

/** Snapshots older than KEEP_DAYS go, except the newest KEEP_MIN (so a long outage never empties the backup). */
async function prune() {
  const snaps = (await rclone(['lsf', '--files-only', 'offsite:db'])).split('\n').filter((n) => /^notes-\d{8}T\d{6}Z\.db\.gz$/.test(n)).sort();
  const snapCutoff = stamp(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  const old = snaps.slice(0, Math.max(0, snaps.length - KEEP_MIN)).filter((n) => n.slice(6, 22) < snapCutoff);
  for (const n of old) await rclone(['deletefile', `offsite:db/${n}`]);
  const cutoff = stamp(new Date(Date.now() - KEEP_DELETED_DAYS * 86_400_000));
  const dirs = (await rclone(['lsf', '--dirs-only', 'offsite:deleted']).catch(() => '')).split('\n').map((d) => d.replace(/\/$/, '')).filter(Boolean);
  for (const d of dirs.filter((x) => x < cutoff)) await rclone(['purge', `offsite:deleted/${d}`]);
  return snaps.length - old.length;
}

/** Download the latest snapshot and check it opens; check every attachment is there and matches. */
async function verify(tmp, setPhase) {
  setPhase('Checking the backup can be restored');
  const manifest = JSON.parse(await rclone(['cat', 'offsite:manifest.json']));
  await rclone(['copyto', `offsite:db/${manifest.snapshot}`, path.join(tmp, 'check.db.gz')]);
  await pipeline(fs.createReadStream(path.join(tmp, 'check.db.gz')), zlib.createGunzip(), fs.createWriteStream(path.join(tmp, 'check.db')));
  const check = new DatabaseSync(path.join(tmp, 'check.db'), { readOnly: true });
  const integrity = check.prepare('PRAGMA integrity_check').get();
  const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
  check.close();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('The latest database snapshot is damaged.');
  if (notes !== manifest.notes) throw new Error(`The latest snapshot has ${notes} notes; expected ${manifest.notes}.`);
  setPhase('Checking attachments');
  // Every local attachment must exist in the backup with the same content (hashes, nothing downloaded).
  await rclone(['cryptcheck', '--one-way', config.filesDir, 'offsite:files']);
  return { at: Date.now(), ok: true, snapshot: manifest.snapshot, notes, files: localFiles().count };
}

/** One backup (or with kind 'verify', only a check of the existing one). Never throws; returns the run record. */
export async function runOffsite({ trigger = 'manual', kind = 'backup', forceVerify = false } = {}) {
  if (!offsiteConfigured()) throw httpError(409, 'Off-site backup isn’t set up.');
  const l = lock(kind, trigger);
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(DIR, 'tmp-'));
  const run = { kind, trigger, startedAt: started, ok: false };
  let verifying = false;
  try {
    if (kind === 'backup') {
      const prev = readJson('offsite_status', {}).lastSuccess;
      const files = localFiles();
      // A missing or unmounted notes disk looks like "every attachment was deleted": don't mirror that.
      if (files.count === 0 && (prev?.files?.count ?? 0) > 10) {
        throw new Error(`No attachments found in ${config.filesDir}, but the last backup had ${prev.files.count}. Not backing up an empty folder over them.`);
      }

      l.phase('Copying the database');
      const snap = await snapshot(tmp);
      await rclone(['copyto', snap.file, `offsite:db/${snap.name}`]);

      l.phase('Uploading attachments');
      const sent = { count: 0, bytes: 0 };
      await rclone(['sync', config.filesDir, 'offsite:files', '--backup-dir', `offsite:deleted/${stamp(new Date(started))}`, '--transfers', '4'], {
        log: true,
        onLog: (e) => { if (/^Copied/.test(e.msg)) { sent.count++; sent.bytes += e.size ?? 0; } },
      });

      l.phase('Uploading certificates and keys');
      // A tenant (or any server with NOTEAPP_TLS=0) has no certs folder: syncing a missing folder fails the whole run.
      const certs = fs.existsSync(config.certDir);
      if (certs) await rclone(['sync', config.certDir, 'offsite:config/certs']);
      const wpKey = path.join(config.dataDir, 'wordpress.key');
      if (fs.existsSync(wpKey)) await rclone(['copyto', wpKey, 'offsite:config/wordpress.key']);

      const manifest = {
        app: 'note-app', version: PKG.version, createdAt: new Date().toISOString(), timeZone: config.timeZone,
        snapshot: snap.name, notes: snap.notes, files, certs, wordpressKey: fs.existsSync(wpKey),
      };
      await rclone(['rcat', 'offsite:manifest.json'], { input: JSON.stringify(manifest, null, 2) });

      l.phase('Removing old snapshots');
      run.snapshots = await prune();
      Object.assign(run, { snapshot: snap.name, notes: snap.notes, dbBytes: snap.bytes, files, sent });
    }
    const lastVerify = readJson('offsite_status', {}).lastVerify;
    if (kind === 'verify' || forceVerify || !lastVerify?.ok || Date.now() - lastVerify.at > VERIFY_EVERY) {
      verifying = true;
      run.verify = await verify(tmp, (p) => l.phase(p));
    }
    run.ok = true;
  } catch (e) {
    run.error = e.message;
    if (verifying) run.verify = { at: Date.now(), ok: false, error: e.message };
  } finally {
    run.finishedAt = Date.now();
    fs.rmSync(tmp, { recursive: true, force: true });
    saveRun(run);
    l.release();
  }
  return run;
}

// ---------- notes from an older snapshot (Restore from a backup, server/restorepoints.js) ----------

const SNAP_RE = /^notes-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.db\.gz$/;

/** The database snapshots the off-site backup holds, newest first: [{ name, at }]. */
export async function offsiteSnapshots() {
  if (!offsiteConfigured()) return [];
  const names = (await rclone(['lsf', '--files-only', 'offsite:db'])).split('\n').filter((n) => SNAP_RE.test(n));
  return names.map((name) => {
    const m = SNAP_RE.exec(name);
    return { name, at: Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) };
  }).sort((a, b) => b.at - a.at);
}

/** Downloads (and decrypts) one snapshot to `dest`, still gzipped. */
export async function offsiteDownload(name, dest) {
  if (!SNAP_RE.test(String(name))) throw httpError(400, 'That isn’t one of the backup’s snapshots.');
  await rclone(['copyto', `offsite:db/${name}`, dest]);
}

/**
 * Downloads one attachment to `dest`: from files/, or from deleted/ (removed since, kept KEEP_DELETED_DAYS). `seen`
 * caches the deleted/ listing across calls. Resolves to dest, or null when the backup doesn't have it.
 */
export async function offsiteAttachment(storage, dest, seen = {}) {
  if (!/^[\w.-]+$/.test(storage)) return null;
  await rclone(['copyto', `offsite:files/${storage}`, dest]).catch(() => {});
  if (fs.existsSync(dest)) return dest;
  seen.deleted ??= (await rclone(['lsf', '-R', '--files-only', 'offsite:deleted']).catch(() => '')).split('\n').filter(Boolean).sort().reverse();
  const hit = seen.deleted.find((d) => d.endsWith(`/${storage}`));
  if (hit) await rclone(['copyto', `offsite:deleted/${hit}`, dest]).catch(() => {});
  return fs.existsSync(dest) ? dest : null;
}

/** For the dashboard: a warning when backups have stopped working, else null. */
export function offsiteWarning() {
  const c = connection();
  if (!c) return null;
  const s = readJson('offsite_status', {});
  if (s.last && !s.last.ok) return `The last off-site backup failed: ${s.last.error}`;
  if (s.lastVerify && !s.lastVerify.ok) return `The off-site backup check failed: ${s.lastVerify.error}`;
  const since = s.lastSuccess?.finishedAt ?? c.connectedAt;
  if (Date.now() - since > 48 * 3_600_000) {
    return s.lastSuccess ? 'No off-site backup in the last two days.' : 'Off-site backup is set up but hasn’t run yet.';
  }
  return null;
}

// ---------- setup ----------

// ---------- for the dashboard widget ----------

/** The local backups scripts/backup.js writes (same folder logic). */
function localBackups() {
  const dir = path.resolve(process.env.NOTEAPP_BACKUP_DIR || path.join(config.dataDir, 'backups'));
  try {
    const all = fs.readdirSync(dir).filter((f) => /^note-app-.*\.tar\.gz$/.test(f)).sort();
    const latest = all.at(-1);
    if (!latest) return { count: 0, latest: null };
    const st = fs.statSync(path.join(dir, latest));
    return { count: all.length, latest: { at: st.mtimeMs, bytes: st.size } };
  } catch {
    return { count: 0, latest: null };
  }
}

/** When the nightly timer fires next (null if systemd can't say, e.g. not installed as a service). */
let nextRunCache = { at: 0, value: null };
function nextRun() {
  if (config.mode === 'tenant') {
    const d = new Date();
    d.setUTCHours(0, nightlySlot(), 0, 0);
    if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  if (Date.now() - nextRunCache.at < 60_000) return nextRunCache.value;
  const r = spawnSync('systemctl', ['--user', 'show', 'note-app-backup.timer', '-P', 'NextElapseUSecRealtime', '--timestamp=unix'], { encoding: 'utf8', timeout: 3000 });
  const m = r.stdout?.match(/@(\d+)/);
  nextRunCache = { at: Date.now(), value: m ? Number(m[1]) * 1000 : null };
  return nextRunCache.value;
}

// ---------- checking a passphrase ----------

const attempts = [];
/**
 * Does `passphrase` match the backup's? Two answers:
 * - matches: same key as this server uses. Crypt file names are deterministic per key, so the same name
 *   encrypted both ways is identical only for the same key (no network, nothing revealed).
 * - readsBackup: it actually decrypts the backup's manifest in the storage.
 */
async function checkPassphrase(passphrase) {
  const env = {
    RCLONE_CONFIG_CHECK_TYPE: 'crypt',
    RCLONE_CONFIG_CHECK_REMOTE: rootOf(connection()),
    RCLONE_CONFIG_CHECK_PASSWORD: await obscure(passphrase),
  };
  const name = (remote) => rclone(['cryptdecode', '--reverse', `${remote}:`, 'manifest.json'], { env }).then((o) => o.trim().split('\t').pop().trim());
  const matches = (await name('offsite')) === (await name('check'));
  let manifest = null;
  let error = null;
  try {
    const text = await rclone(['cat', 'check:manifest.json'], { env });
    if (!text.trim()) throw new Error('not found'); // S3: a name this key can't decrypt lists as nothing
    const m = JSON.parse(text);
    manifest = { createdAt: m.createdAt, notes: m.notes, files: m.files?.count ?? null };
  } catch (e) {
    error = /not found/i.test(e.message) ? null : e.message; // not found = can't decrypt the names
  }
  return { matches, readsBackup: !!manifest, manifest, error };
}

// Connect OneDrive in the browser (no rclone on a PC); the token waits here until the passphrase is chosen.
const authorizer = oneDriveAuthorizer(path.join(DIR, 'authorize'));
const pendingTokens = new Map(); // session id -> { token, drive, expires }

/**
 * The storage a setup request names: { section } for rclone.conf and { conn }, what's kept in settings (provider,
 * service, account, root, and the fields that can be shown again; never keys or passwords). OneDrive is signed in
 * with Connect OneDrive (`connected`) or a pasted rclone token; the others come with their key or password.
 */
async function targetFromBody(req) {
  const b = req.body ?? {};
  const provider = b.provider ?? 'onedrive';
  if (provider === 'onedrive') {
    let section;
    let account;
    if (TEST_REMOTE) {
      section = onedriveSection({ testDir: TEST_REMOTE, name: 'target' });
      account = 'Test folder';
    } else if (b.connected) {
      const p = pendingTokens.get(req.session.id);
      if (!p || p.expires < Date.now()) throw httpError(400, 'The OneDrive sign-in has expired. Click Connect OneDrive again.');
      section = onedriveSection({ token: p.token, drive: p.drive, name: 'target' });
      account = p.drive.account;
    } else {
      const token = parseToken(b.token);
      const drive = await onedriveDrive(token);
      section = onedriveSection({ token, drive, name: 'target' });
      account = drive.account;
    }
    return { section, conn: { provider, service: 'onedrive', account, root: `target:${FOLDER}`, fields: null } };
  }
  const t = await storageTarget(b);
  return { section: await storageSection(t), conn: { provider: t.provider, service: t.service, account: t.account, root: t.root, fields: t.fields } };
}

export default async function offsite(app) {
  app.post('/api/offsite/connect/start', async (req) => ({ url: await authorizer.start(req.session.id) }));

  app.post('/api/offsite/connect/finish', async (req) => {
    const token = await authorizer.finish(req.session.id, req.body?.url);
    const drive = await onedriveDrive(token);
    pendingTokens.set(req.session.id, { token, drive, expires: Date.now() + 30 * 60_000 });
    return { account: drive.account };
  });

  app.get('/api/offsite', async () => {
    const c = connection();
    const s = readJson('offsite_status', {});
    return {
      rclone: rcloneVersion(),
      configured: !!c,
      account: c?.account ?? null,
      provider: c ? (c.provider ?? 'onedrive') : null,
      service: c ? serviceOf(c) : null,
      serviceName: c ? SERVICE_NAMES[serviceOf(c)] : null,
      fields: c?.fields ?? null,
      folder: c?.provider === 's3' ? `${c.fields.bucket}/${FOLDER}` : FOLDER,
      connectedAt: c?.connectedAt ?? null,
      running: running(),
      last: s.last ?? null,
      lastSuccess: s.lastSuccess ?? null,
      lastVerify: s.lastVerify ?? null,
      history: s.history ?? [],
      keepDays: KEEP_DAYS,
      keepMin: KEEP_MIN,
      local: localBackups(),
      nextRun: nextRun(),
      passphraseCheckedAt: c?.passphraseCheckedAt ?? null,
    };
  });

  app.put('/api/offsite', async (req) => {
    if (running()) throw httpError(409, 'A backup is running. Try again when it finishes.');
    if (!rclonePath()) throw httpError(400, 'rclone isn’t installed on the server. Run: npm run install-rclone');
    const passphrase = String(req.body?.passphrase ?? '');
    if (passphrase.length < 12) throw httpError(400, 'Use a passphrase of at least 12 characters.');
    if (/[\r\n]/.test(passphrase)) throw httpError(400, 'The passphrase can’t contain line breaks.');

    const { section, conn } = await targetFromBody(req);
    const previous = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null;
    writeConf(CONF, await buildConf(section, passphrase, conn.root));
    try {
      // An existing backup must open with this passphrase, or the folder would end up with two keys.
      const existing = (await rclone(['lsf', '--max-depth', '1', conn.root]).catch((e) => {
        if (/not found|doesn't exist|directory not found|404/i.test(e.message)) return '';
        throw e;
      })).trim();
      // (On S3, cat of a file it can't find prints nothing and succeeds; OneDrive fails. Either means "can't open".)
      if (existing && !(await rclone(['cat', 'offsite:manifest.json']).catch(() => '')).trim()) {
        throw httpError(400, `There’s already a “${FOLDER}” folder there that this passphrase can’t open. `
          + 'Enter the passphrase it was made with, or delete or rename that folder to start a new backup.');
      } else if (!existing && !TEST_REMOTE) {
        await probeStorage(rclone, conn.root);
      }
    } catch (e) {
      if (previous) writeConf(CONF, previous); else fs.rmSync(CONF, { force: true });
      throw e.statusCode ? e : httpError(400, e.message);
    }
    pendingTokens.delete(req.session.id);
    setSetting('offsite', JSON.stringify({ ...conn, connectedAt: Date.now() }));
    return { ok: true, account: conn.account };
  });

  // Checks the storage before the passphrase is chosen: it can be reached and takes a write.
  app.post('/api/offsite/test', async (req) => {
    if (!rclonePath()) throw httpError(400, 'rclone isn’t installed on the server. Run: npm run install-rclone');
    const { section, conn } = await targetFromBody(req);
    const conf = path.join(DIR, `test-${crypto.randomBytes(6).toString('hex')}.conf`);
    writeConf(conf, section);
    try {
      await probeStorage(rcloneRunner(conf), conn.root);
    } catch (e) {
      throw httpError(400, e.message);
    } finally {
      fs.rmSync(conf, { force: true });
    }
    return { ok: true, account: conn.account, serviceName: SERVICE_NAMES[conn.service] };
  });

  app.delete('/api/offsite', async () => {
    if (running()) throw httpError(409, 'A backup is running. Try again when it finishes.');
    fs.rmSync(CONF, { force: true });
    db.prepare("DELETE FROM settings WHERE key IN ('offsite', 'offsite_status')").run();
    return { ok: true };
  });

  app.post('/api/offsite/check-passphrase', async (req) => {
    if (!offsiteConfigured()) throw httpError(409, 'Off-site backup isn’t set up.');
    const now = Date.now();
    while (attempts.length && attempts[0] < now - 15 * 60_000) attempts.shift();
    if (attempts.length >= 10) throw httpError(429, 'Too many tries. Wait a few minutes and try again.');
    attempts.push(now);
    const passphrase = String(req.body?.passphrase ?? '');
    if (!passphrase) throw httpError(400, 'Enter the passphrase.');
    const result = await checkPassphrase(passphrase);
    if (result.matches && result.readsBackup) {
      setSetting('offsite', JSON.stringify({ ...connection(), passphraseCheckedAt: now }));
    }
    return result;
  });

  // Starts a run in the background; poll GET /api/offsite for progress.
  app.post('/api/offsite/run', async (req) => {
    if (!offsiteConfigured()) throw httpError(409, 'Off-site backup isn’t set up.');
    if (running()) throw httpError(409, 'A backup is already running.');
    const kind = req.body?.kind === 'verify' ? 'verify' : 'backup';
    runOffsite({ trigger: 'manual', kind }).catch((e) => app.log.error(e));
    await new Promise((r) => setTimeout(r, 50)); // so the first poll already sees it running
    return { started: true };
  });
}
