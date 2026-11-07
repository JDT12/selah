import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { db, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import {
  SERVICE_NAMES, obscure, onedriveDrive, onedriveSection, oneDriveAuthorizer, parseToken, probeStorage, rclonePath, rcloneRunner,
  storageSection, storageTarget, writeConf,
} from '../rclone.js';
import {
  addTenant, alert, getTenant, listTenants, mustTenant, startJob, updateTenant,
} from './store.js';
import {
  backupKind, installUnpacked, scrubRestoredDb, unpackBackup,
} from '../backupfile.js';
import { readPackage } from '../notepackread.js';
import { paths } from './paths.js';
import { runner } from './runner.js';
import { control, waitHealthy } from './control.js';
import { pushGateway } from './gateway.js';

/**
 * The host backup: every tenant, every night, encrypted, to storage the admin controls. It covers everyone whether
 * or not they back up to storage of their own, and restores one tenant (or some of its notes) at a time.
 *
 * It can go to several places at once (console 1.2.0): OneDrive, S3-compatible storage, WebDAV, or any rclone remote.
 * Each destination has its own rclone config, admin/data/hostbackup/dests/<id>.conf (the first one, set up before
 * 1.2.0, is hostbackup/rclone.conf), with the storage as [hostremote] and an encrypted [hostbackup] on top, keyed by
 * the passphrase chosen for it. Inside each:
 *   tenants/<name>/db/notes-<stamp>.db.gz   database snapshots: 30 days, never fewer than the newest 3
 *   tenants/<name>/files/                   attachments, synced; removed ones go to deleted/<stamp>/ for 30 days
 *   tenants/<name>/config/                  the tenant's secrets key (wordpress.key) and its settings (tenant.json)
 *   tenants/<name>/manifest.json            the latest backup, and what each kept snapshot holds
 *   admin/db/, admin/config/                the admin console's own database and key
 * Each night's snapshot of a tenant is made once and copied to every destination.
 * A tenant's own off-site connection isn't copied (it holds their passphrase); after a restore they reconnect it.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const DIR = path.join(config.dataDir, 'hostbackup');
const LEGACY_CONF = 'rclone.conf';
export const FOLDER = 'Selah Host Backup';
const KEEP_DAYS = Number(process.env.NOTEAPP_OFFSITE_DAYS || 30);
const KEEP_MIN = Number(process.env.NOTEAPP_OFFSITE_MIN || 3);
const VERIFY_EVERY = 6.5 * 86_400_000;
const MAX_DESTS = 4;
const TEST_REMOTE = process.env.NOTEAPP_HOSTBACKUP_TEST_REMOTE || null;
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;

const readJson = (key, fallback) => { try { return JSON.parse(getSetting(key) ?? 'null') ?? fallback; } catch { return fallback; } };
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const stampTime = (s) => {
  const m = String(s).match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/);
  return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : null;
};

// ---------- destinations ----------

/**
 * Where backups go: [{ id, conf, kind, provider, service, account, folder, connectedAt }], first one first. The
 * connection from before 1.2.0 (host_backup_conn and rclone.conf) becomes the first destination.
 */
export function destinations() {
  let list = readJson('host_backup_dests', null);
  if (!list) {
    const old = readJson('host_backup_conn', null);
    list = old && fs.existsSync(path.join(DIR, LEGACY_CONF)) ? [{ id: 'main', conf: LEGACY_CONF, provider: old.kind === 'token' ? 'onedrive' : old.kind, ...old }] : [];
    if (list.length) setSetting('host_backup_dests', JSON.stringify(list));
  }
  return list.filter((d) => fs.existsSync(path.join(DIR, d.conf)));
}
const saveDestinations = (list) => setSetting('host_backup_dests', JSON.stringify(list));
const rcloneFor = (d) => rcloneRunner(path.join(DIR, d.conf));
function mustDest(id) {
  const all = destinations();
  const d = id ? all.find((x) => x.id === id) : all[0];
  if (!d) throw httpError(id ? 404 : 409, id ? 'That backup destination isn’t set up any more.' : 'The host backup isn’t set up yet (Backups → Set up).');
  return d;
}

/** The first destination (what the Overview shows), for code from before there were several. */
export const connection = () => {
  const all = destinations();
  return all.length ? { ...all[0], account: all.map((d) => d.account).join(' + ') } : null;
};
export const configured = () => destinations().length > 0;

const authorizer = oneDriveAuthorizer(path.join(DIR, 'authorize'));
const pendingTokens = new Map(); // session id -> { token, drive, expires }
export const connectStart = (sessionId) => authorizer.start(sessionId);
export async function connectFinish(sessionId, url) {
  const token = await authorizer.finish(sessionId, url);
  const drive = await onedriveDrive(token);
  pendingTokens.set(sessionId, { token, drive, expires: Date.now() + 30 * 60_000 });
  return { account: drive.account };
}

/**
 * The [hostremote] section and where in it the backup goes, for what the setup form sent: `provider` 'onedrive'
 * (signed in with Connect OneDrive, or a pasted `token`), 's3' or 'webdav' (the same fields as a person's own off-site
 * backup), or 'custom' (a pasted rclone remote and a folder or bucket path).
 */
async function storageFrom(sessionId, b) {
  const provider = b.provider ?? b.kind ?? 'onedrive';
  if (TEST_REMOTE) return { base: `[hostremote]\ntype = alias\nremote = ${TEST_REMOTE}${b.testSub ? `/${b.testSub}` : ''}\n`, folder: FOLDER, info: { provider: 'test', service: null, account: `Test folder${b.testSub ? ` ${b.testSub}` : ''}` } };
  if (provider === 'onedrive' || provider === 'token') {
    let t;
    let drive;
    if (b.connected || provider === 'onedrive' && !b.token) {
      const p = pendingTokens.get(sessionId);
      if (!p || p.expires < Date.now()) throw httpError(400, 'The OneDrive sign-in has expired. Click Connect OneDrive again.');
      ({ token: t, drive } = p);
    } else {
      t = parseToken(b.token);
      drive = await onedriveDrive(t);
    }
    return { base: onedriveSection({ token: t, drive, name: 'hostremote' }), folder: FOLDER, info: { provider: 'onedrive', service: 'onedrive', account: `OneDrive (${drive.account})` } };
  }
  if (provider === 's3' || provider === 'webdav') {
    const t = await storageTarget(b);
    const folder = provider === 's3' ? `${t.fields.bucket}/${FOLDER}` : FOLDER;
    return { base: await storageSection(t, 'hostremote'), folder, info: { provider, service: t.service, account: `${SERVICE_NAMES[t.service]} (${t.account})`, fields: t.fields } };
  }
  if (provider === 'custom') {
    const text = String(b.remote ?? '').trim();
    const type = text.match(/^type\s*=\s*(\S+)/m)?.[1];
    if (!type) throw httpError(400, 'Paste an rclone remote: a [name] line and its settings, including type = …');
    if (['alias', 'local', 'crypt'].includes(type)) throw httpError(400, 'Choose storage away from this server (not a local folder).');
    const folder = String(b.folder ?? '').trim().replace(/^\/+|\/+$/g, '') || FOLDER;
    if (/[\r\n]/.test(folder)) throw httpError(400, 'The folder can’t contain line breaks.');
    return { base: `[hostremote]\n${text.replace(/^\[[^\]\n]*\]\s*\n?/, '')}\n`, folder, info: { provider: 'custom', service: type, account: `${type} (${folder})` } };
  }
  throw httpError(400, 'Choose where backups go.');
}

/** Checks storage can be reached and written before a passphrase is chosen (the setup form's Test connection). */
export async function testStorage(sessionId, b) {
  if (!rclonePath()) throw httpError(400, 'rclone isn’t installed on the server. Run: npm run install-rclone');
  const s = await storageFrom(sessionId, b);
  const conf = path.join(DIR, `test-${crypto.randomBytes(6).toString('hex')}.conf`);
  writeConf(conf, s.base);
  try {
    await probeStorage(rcloneRunner(conf), `hostremote:${s.folder}`);
  } catch (e) {
    throw httpError(400, e.message);
  } finally {
    fs.rmSync(conf, { force: true });
  }
  return { account: s.info.account };
}

/**
 * Adds a destination, or with `id` connects an existing one again (new sign-in or keys). Its passphrase must open
 * a backup already in that folder.
 */
export async function connect(sessionId, b) {
  if (running) throw httpError(409, 'A backup is running. Try again when it finishes.');
  if (!rclonePath()) throw httpError(400, 'rclone isn’t installed on the server. Run: npm run install-rclone');
  const passphrase = String(b.passphrase ?? '');
  if (passphrase.length < 16) throw httpError(400, 'Use a passphrase of at least 16 characters, and keep it somewhere safe away from this server.');
  if (/[\r\n]/.test(passphrase)) throw httpError(400, 'The passphrase can’t contain line breaks.');
  const list = destinations();
  const existing = b.id ? list.find((d) => d.id === b.id) : null;
  if (b.id && !existing) throw httpError(404, 'That backup destination isn’t set up any more.');
  if (!existing && list.length >= MAX_DESTS) throw httpError(400, `The host backup can go to at most ${MAX_DESTS} places.`);
  const s = await storageFrom(sessionId, b);
  const id = existing?.id ?? crypto.randomBytes(4).toString('hex');
  const conf = existing?.conf ?? path.join('dests', `${id}.conf`);
  const file = path.join(DIR, conf);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  writeConf(file, `${s.base}\n[hostbackup]\ntype = crypt\nremote = hostremote:${s.folder}\npassword = ${await obscure(passphrase)}\n`);
  const rclone = rcloneRunner(file);
  try {
    const there = (await rclone(['lsf', '--max-depth', '1', `hostremote:${s.folder}`]).catch((e) => {
      if (/not found|doesn't exist|directory not found|404/i.test(e.message)) return '';
      throw e;
    })).trim();
    // (On S3, cat of a file it can't find prints nothing and succeeds; OneDrive fails. Either means "can't open".)
    if (there && !(await rclone(['cat', 'hostbackup:manifest.json']).catch(() => '')).trim()) {
      throw httpError(400, `“${s.folder}” already holds a backup this passphrase can’t open. Enter the passphrase it was made with, or choose an empty folder.`);
    }
    if (!there && !TEST_REMOTE) await probeStorage(rclone, `hostremote:${s.folder}`);
  } catch (e) {
    if (previous) writeConf(file, previous); else fs.rmSync(file, { force: true });
    throw e.statusCode ? e : httpError(400, e.message);
  }
  pendingTokens.delete(sessionId);
  const dest = { id, conf, kind: s.info.provider, ...s.info, folder: s.folder, connectedAt: Date.now() };
  saveDestinations(existing ? list.map((d) => (d.id === id ? dest : d)) : [...list, dest]);
  return { id, account: dest.account };
}

/** Stops backing up to one destination (what's there stays). */
export function disconnect(id) {
  if (running) throw httpError(409, 'A backup is running. Try again when it finishes.');
  const d = mustDest(id);
  fs.rmSync(path.join(DIR, d.conf), { force: true });
  saveDestinations(destinations().filter((x) => x.id !== d.id));
  if (!destinations().length) db.prepare("DELETE FROM settings WHERE key = 'host_backup_conn'").run();
  const s = status();
  for (const t of Object.values(s.tenants ?? {})) delete t.dests?.[d.id];
  setSetting('host_backup_status', JSON.stringify(s));
}

// ---------- status ----------

const status = () => readJson('host_backup_status', { tenants: {} });
function saveTenantRun(slug, run) {
  const s = status();
  const prev = s.tenants?.[slug] ?? {};
  const next = { ...prev, last: run, dests: { ...(prev.dests ?? {}) } };
  if (run.ok) next.lastSuccess = run;
  if (run.verify) next.lastVerify = run.verify;
  for (const [id, r] of Object.entries(run.dests ?? {})) {
    const d = { ...(next.dests[id] ?? {}), last: r };
    if (r.ok) d.lastSuccess = r;
    if (r.verify) d.lastVerify = r.verify;
    next.dests[id] = d;
  }
  s.tenants = { ...(s.tenants ?? {}), [slug]: next };
  setSetting('host_backup_status', JSON.stringify(s));
}
function saveRun(run) {
  const s = status();
  s.last = run;
  s.history = [run, ...(s.history ?? [])].slice(0, 20);
  setSetting('host_backup_status', JSON.stringify(s));
}
export function backupStatus() {
  const s = status();
  const dests = destinations().map(({ conf, ...d }) => ({ ...d, last: s.dests?.[d.id] ?? null }));
  return {
    rclone: !!rclonePath(), configured: dests.length > 0, connection: connection(), dests, maxDests: MAX_DESTS, running,
    last: s.last ?? null, history: s.history ?? [], tenants: s.tenants ?? {}, keepDays: KEEP_DAYS, keepMin: KEEP_MIN,
  };
}
export const forgetTenantStatus = (slug) => {
  const s = status();
  if (s.tenants?.[slug]) { delete s.tenants[slug]; setSetting('host_backup_status', JSON.stringify(s)); }
};

// ---------- backing up ----------

let running = null; // { jobId, slug, phase }

async function gzipTo(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(dest));
}

function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      count++;
      bytes += fs.statSync(path.join(dir, f.name)).size;
    }
  } catch { /* none */ }
  return { count, bytes };
}

async function manifestOf(rclone, base) {
  try { return JSON.parse(await rclone(['cat', `${base}/manifest.json`])); } catch { return null; }
}

/** Snapshots older than KEEP_DAYS go, except the newest KEEP_MIN; old deleted/ folders too. Returns the kept list. */
async function prune(rclone, base, history) {
  const snaps = (await rclone(['lsf', '--files-only', `${base}/db`]).catch(() => '')).split('\n').filter((n) => /^notes-\d{8}T\d{6}Z\.db\.gz$/.test(n)).sort();
  const cutoff = stamp(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  const old = snaps.slice(0, Math.max(0, snaps.length - KEEP_MIN)).filter((n) => n.slice(6, 22) < cutoff);
  for (const n of old) await rclone(['deletefile', `${base}/db/${n}`]);
  const dirs = (await rclone(['lsf', '--dirs-only', `${base}/deleted`]).catch(() => '')).split('\n').map((d) => d.replace(/\/$/, '')).filter(Boolean);
  for (const d of dirs.filter((x) => x < cutoff)) await rclone(['purge', `${base}/deleted/${d}`]);
  const kept = new Set(snaps.filter((n) => !old.includes(n)));
  return history.filter((h) => kept.has(h.snapshot));
}

async function verifyTenant(rclone, t, base, tmp) {
  const manifest = await manifestOf(rclone, base);
  if (!manifest) throw new Error('The backup has no manifest.');
  await rclone(['copyto', `${base}/db/${manifest.snapshot}`, path.join(tmp, 'check.db.gz')]);
  await pipeline(fs.createReadStream(path.join(tmp, 'check.db.gz')), zlib.createGunzip(), fs.createWriteStream(path.join(tmp, 'check.db')));
  const check = new DatabaseSync(path.join(tmp, 'check.db'), { readOnly: true });
  const integrity = Object.values(check.prepare('PRAGMA integrity_check').get())[0];
  const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
  check.close();
  fs.rmSync(path.join(tmp, 'check.db'), { force: true });
  fs.rmSync(path.join(tmp, 'check.db.gz'), { force: true });
  if (integrity !== 'ok') throw new Error('The latest database snapshot is damaged.');
  if (notes !== manifest.notes) throw new Error(`The latest snapshot has ${notes} notes; expected ${manifest.notes}.`);
  await rclone(['cryptcheck', '--one-way', paths.tenant(t.slug).files, `${base}/files`]);
  return { at: Date.now(), ok: true, snapshot: manifest.snapshot, notes };
}

/** Copies a tenant's snapshot (made once, in `snap`) and its attachments to one destination. */
async function sendTenant(d, t, snap, tmp, { forceVerify }) {
  const rclone = rcloneFor(d);
  const p = paths.tenant(t.slug);
  const base = `hostbackup:tenants/${t.slug}`;
  const run = { dest: d.id, startedAt: Date.now(), ok: false };
  const where = destinations().length > 1 ? ` to ${d.account}` : '';
  try {
    running.phase = `Backing up ${t.slug}${where}: database`;
    await rclone(['copyto', snap.file, `${base}/db/${snap.name}`]);
    running.phase = `Backing up ${t.slug}${where}: attachments`;
    const sent = { count: 0, bytes: 0 };
    await rclone(['sync', p.files, `${base}/files`, '--backup-dir', `${base}/deleted/${stamp(snap.at)}`, '--transfers', '4'], {
      log: true, onLog: (e) => { if (/^Copied/.test(e.msg)) { sent.count++; sent.bytes += e.size ?? 0; } },
    });
    const key = path.join(p.data, 'wordpress.key');
    if (fs.existsSync(key)) await rclone(['copyto', key, `${base}/config/wordpress.key`]);
    const info = { slug: t.slug, name: t.name, limits: t.limits, timeZone: t.timeZone, release: t.release, version: t.health?.version ?? null };
    await rclone(['rcat', `${base}/config/tenant.json`], { input: JSON.stringify(info, null, 2) });

    const old = await manifestOf(rclone, base);
    const entry = { snapshot: snap.name, at: snap.at.getTime(), notes: snap.notes, attachments: snap.attachments, files: snap.files };
    let history = [entry, ...(old?.history ?? [])];
    running.phase = `Backing up ${t.slug}${where}: tidying old snapshots`;
    history = await prune(rclone, base, history);
    const manifest = { app: 'Selah', kind: 'tenant', version: VERSION, createdAt: snap.at.toISOString(), slug: t.slug, snapshot: snap.name, notes: snap.notes, attachments: snap.attachments, files: snap.files, history };
    await rclone(['rcat', `${base}/manifest.json`], { input: JSON.stringify(manifest, null, 2) });
    Object.assign(run, { snapshot: snap.name, notes: snap.notes, files: snap.files, sent, snapshots: history.length });

    const lastVerify = status().tenants?.[t.slug]?.dests?.[d.id]?.lastVerify;
    if (forceVerify || !lastVerify?.ok || Date.now() - lastVerify.at > VERIFY_EVERY) {
      running.phase = `Checking ${t.slug}’s backup${where}`;
      try {
        run.verify = await verifyTenant(rclone, t, base, tmp);
      } catch (e) {
        run.verify = { at: Date.now(), ok: false, error: e.message };
        throw new Error(`The backup check failed: ${e.message}`);
      }
    }
    run.ok = true;
  } catch (e) {
    run.error = e.message;
  }
  run.finishedAt = Date.now();
  return run;
}

async function backupTenant(t, tmpRoot, { forceVerify = false } = {}) {
  const p = paths.tenant(t.slug);
  const tmp = fs.mkdtempSync(path.join(tmpRoot, `${t.slug}-`));
  const run = { slug: t.slug, startedAt: Date.now(), ok: false, dests: {} };
  try {
    if (!fs.existsSync(p.db)) throw new Error('It has no database yet.');
    const prev = status().tenants?.[t.slug]?.lastSuccess;
    const files = countFiles(p.files);
    // A missing storage folder looks like "every attachment was deleted": don't mirror that.
    if (files.count === 0 && (prev?.files?.count ?? 0) > 10) throw new Error(`No attachments found, but the last backup had ${prev.files.count}. Not backing up an empty folder over them.`);

    running.phase = `Backing up ${t.slug}: database`;
    const raw = path.join(tmp, 'notes.db');
    const src = new DatabaseSync(p.db, { readOnly: true });
    try { await backup(src, raw); } finally { src.close(); }
    const check = new DatabaseSync(raw, { readOnly: true });
    const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
    const attachments = check.prepare('SELECT count(*) AS n FROM attachments').get().n;
    check.close();
    const at = new Date();
    const name = `notes-${stamp(at)}.db.gz`;
    await gzipTo(raw, path.join(tmp, name));
    fs.rmSync(raw, { force: true });
    const snap = { file: path.join(tmp, name), name, at, notes, attachments, files };

    for (const d of destinations()) run.dests[d.id] = await sendTenant(d, t, snap, tmp, { forceVerify });
    const results = Object.entries(run.dests);
    const failed = results.filter(([, r]) => !r.ok);
    const accounts = new Map(destinations().map((d) => [d.id, d.account]));
    const ok = results.find(([, r]) => r.ok)?.[1];
    Object.assign(run, { snapshot: name, notes, files, sent: ok?.sent ?? null, snapshots: ok?.snapshots ?? null });
    const verified = results.map(([, r]) => r.verify).filter(Boolean);
    if (verified.length) run.verify = verified.find((v) => !v.ok) ?? verified[0];
    if (failed.length) throw new Error(failed.map(([id, r]) => (results.length > 1 ? `${accounts.get(id)}: ${r.error}` : r.error)).join('; '));
    run.ok = true;
  } catch (e) {
    run.error = e.message;
  } finally {
    run.finishedAt = Date.now();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  saveTenantRun(t.slug, run);
  // Tell the tenant, so their dashboard can say they're covered.
  if (t.status === 'active') control(t, 'POST', '/control/host-backup', { at: run.finishedAt, ok: run.ok, snapshot: run.snapshot ?? null, error: run.error ?? null }).catch(() => {});
  return run;
}

async function backupAdmin(tmpRoot) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'admin-'));
  const errors = [];
  try {
    const raw = path.join(tmp, 'admin.db');
    await backup(db, raw);
    const name = `admin-${stamp()}.db.gz`;
    await gzipTo(raw, path.join(tmp, name));
    const key = path.join(config.dataDir, 'wordpress.key');
    for (const d of destinations()) {
      const rclone = rcloneFor(d);
      try {
        await rclone(['copyto', path.join(tmp, name), `hostbackup:admin/db/${name}`]);
        if (fs.existsSync(key)) await rclone(['copyto', key, 'hostbackup:admin/config/wordpress.key']);
        const snaps = (await rclone(['lsf', '--files-only', 'hostbackup:admin/db'])).split('\n').filter((n) => /^admin-\d{8}T\d{6}Z\.db\.gz$/.test(n)).sort();
        const cutoff = stamp(new Date(Date.now() - KEEP_DAYS * 86_400_000));
        for (const n of snaps.slice(0, Math.max(0, snaps.length - KEEP_MIN)).filter((x) => x.slice(6, 22) < cutoff)) await rclone(['deletefile', `hostbackup:admin/db/${n}`]);
      } catch (e) {
        errors.push(destinations().length > 1 ? `${d.account}: ${e.message}` : e.message);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (errors.length) throw new Error(errors.join('; '));
}

/** Backs up every tenant (or those in `slugs`) and the console itself. Runs in the background; returns the job id. */
export function runHostBackups({ trigger = 'manual', slugs = null, forceVerify = false } = {}) {
  if (!configured()) throw httpError(409, 'The host backup isn’t set up yet (Backups → Set up).');
  if (running) throw httpError(409, 'A backup is already running.');
  const job = startJob('backup', slugs?.length === 1 ? slugs[0] : null);
  running = { jobId: job.id, phase: 'Starting', startedAt: Date.now(), trigger };
  (async () => {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmpRoot = fs.mkdtempSync(path.join(DIR, 'tmp-'));
    const results = [];
    let adminError = null;
    try {
      for (const t of listTenants().filter((x) => !slugs || slugs.includes(x.slug))) {
        job.phase(running.phase = `Backing up ${t.slug}`);
        results.push(await backupTenant(t, tmpRoot, { forceVerify }));
      }
      if (!slugs) {
        job.phase(running.phase = 'Backing up the admin console');
        await backupAdmin(tmpRoot).catch((e) => { adminError = e.message; });
        for (const d of destinations()) {
          await rcloneFor(d)(['rcat', 'hostbackup:manifest.json'], { input: JSON.stringify({ app: 'Selah', kind: 'host', version: VERSION, createdAt: new Date().toISOString(), tenants: results.map((r) => r.slug) }, null, 2) }).catch(() => {});
        }
      }
    } catch (e) {
      adminError = adminError ?? e.message;
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      manifestCache.clear();
      const failed = results.filter((r) => !r.ok);
      const ok = !failed.length && !adminError;
      for (const f of failed) alert(f.slug, 'danger', 'backup-failed', `${f.slug}’s host backup failed: ${f.error}`);
      if (adminError) alert(null, 'danger', 'backup-failed', `The host backup had a problem: ${adminError}`);
      const run = { trigger, startedAt: running.startedAt, finishedAt: Date.now(), ok, tenants: results.length, failed: failed.map((f) => f.slug), error: adminError };
      // How each destination did across the tenants.
      const s = status();
      s.dests = Object.fromEntries(destinations().map((d) => {
        const mine = results.map((r) => r.dests?.[d.id]).filter(Boolean);
        return [d.id, { finishedAt: run.finishedAt, ok: mine.length > 0 && mine.every((r) => r.ok), error: mine.find((r) => !r.ok)?.error ?? null }];
      }));
      setSetting('host_backup_status', JSON.stringify(s));
      saveRun(run);
      job.finish(ok, run);
      running = null;
    }
  })();
  return { jobId: job.id };
}

export const backupRunning = () => running;

/** Removes a deleted tenant's host backup, everywhere it goes. */
export async function purgeHostBackup(slug) {
  forgetTenantStatus(slug);
  for (const d of destinations()) {
    await rcloneFor(d)(['purge', `hostbackup:tenants/${slug}`]).catch((e) => {
      if (!/not found|doesn't exist|no such file/i.test(e.message)) throw e;
    });
  }
}

// ---------- restoring ----------

/** The tenants the backups hold (across destinations), with when each was last backed up and whether it's on this server. */
export async function backupTenants() {
  if (!configured()) throw httpError(409, 'The host backup isn’t set up yet.');
  const bySlug = new Map();
  for (const d of destinations()) {
    const rclone = rcloneFor(d);
    const names = (await rclone(['lsf', '--dirs-only', 'hostbackup:tenants']).catch(() => '')).split('\n').map((x) => x.replace(/\/$/, '')).filter(Boolean);
    for (const slug of names) {
      const m = await manifestOf(rclone, `hostbackup:tenants/${slug}`);
      const prev = bySlug.get(slug);
      if (!prev || (m?.createdAt ?? '') > (prev.createdAt ?? '')) {
        bySlug.set(slug, { slug, createdAt: m?.createdAt ?? null, notes: m?.notes ?? null, snapshots: m?.history?.length ?? 0, here: !!getTenant(slug), dests: [...(prev?.dests ?? []), d.id] });
      } else prev.dests.push(d.id);
    }
  }
  return [...bySlug.values()];
}

// Manifests read for the restore dialog, kept a few minutes (reading one from OneDrive takes several seconds).
const manifestCache = new Map(); // `${dest}:${slug}` -> { at, m }
const MANIFEST_TTL = 5 * 60_000;
async function cachedManifest(d, slug) {
  const key = `${d.id}:${slug}`;
  const hit = manifestCache.get(key);
  if (hit && Date.now() - hit.at < MANIFEST_TTL) return hit.m;
  const m = await manifestOf(rcloneFor(d), `hostbackup:tenants/${slug}`);
  if (m) manifestCache.set(key, { at: Date.now(), m });
  return m;
}

/** A tenant's snapshots in one destination (the first that has a backup of it, if none is named). */
export async function snapshots(slug, destId = null) {
  if (!configured()) throw httpError(409, 'The host backup isn’t set up yet.');
  const candidates = destId ? [mustDest(destId)] : destinations();
  for (const d of candidates) {
    const m = await cachedManifest(d, slug);
    if (m) return { dest: d.id, latest: m.snapshot, history: m.history ?? [], dests: destinations().map((x) => ({ id: x.id, account: x.account })) };
  }
  throw httpError(404, `There’s no host backup of ${slug}${destId ? ' there' : ''}.`);
}

/** Downloads and checks one snapshot's database into `dir`; returns { file, snap, entry, manifest }. */
async function fetchSnapshot(rclone, slug, snapshot, dir) {
  const base = `hostbackup:tenants/${slug}`;
  const m = await manifestOf(rclone, base);
  if (!m) throw new Error(`There’s no host backup of ${slug}.`);
  const snap = snapshot || m.snapshot;
  const entry = (m.history ?? []).find((h) => h.snapshot === snap);
  if (!entry && snap !== m.snapshot) throw new Error('That snapshot isn’t in the backup any more.');
  const gz = path.join(dir, 'restore.db.gz');
  await rclone(['copyto', `${base}/db/${snap}`, gz]);
  const file = path.join(dir, 'restore.db');
  await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(file));
  fs.rmSync(gz, { force: true });
  return { file, snap, entry, manifest: m };
}

/** Fetches attachments (by storage name) into `filesDir`: from files/, or deleted/ for ones removed since. Returns those missing. */
async function fetchFiles(rclone, slug, names, filesDir, { all = false } = {}) {
  const base = `hostbackup:tenants/${slug}`;
  if (all) await rclone(['copy', `${base}/files`, filesDir, '--transfers', '8']);
  else for (const n of names) await rclone(['copyto', `${base}/files/${n}`, path.join(filesDir, n)]).catch(() => {});
  let missing = names.filter((n) => !fs.existsSync(path.join(filesDir, n)));
  if (missing.length) {
    const deleted = (await rclone(['lsf', '-R', '--files-only', `${base}/deleted`]).catch(() => '')).split('\n').filter(Boolean).sort().reverse();
    for (const name of missing) {
      const hit = deleted.find((x) => x.endsWith(`/${name}`));
      if (hit) await rclone(['copyto', `${base}/deleted/${hit}`, path.join(filesDir, name)]).catch(() => {});
    }
    missing = missing.filter((n) => !fs.existsSync(path.join(filesDir, n)));
  }
  return missing;
}

/**
 * Downloads a snapshot of `slug` into `target` ({ data, storage, files, db }) and checks it. Older snapshots can
 * refer to attachments deleted since; those come from deleted/.
 */
async function restoreInto(d, slug, snapshot, target, phase) {
  const rclone = rcloneFor(d);
  fs.mkdirSync(target.files, { recursive: true, mode: 0o700 });
  fs.mkdirSync(target.data, { recursive: true, mode: 0o700 });
  const marker = path.join(target.storage, '.note-app-storage');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Selah tenant storage. Do not delete.\n');

  phase('Downloading the database');
  const { file: tmpDb, snap, entry, manifest: m } = await fetchSnapshot(rclone, slug, snapshot, target.storage);
  const check = new DatabaseSync(tmpDb, { readOnly: true });
  const integrity = Object.values(check.prepare('PRAGMA integrity_check').get())[0];
  const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
  const needed = new Set(check.prepare('SELECT storage FROM attachments').all().map((r) => r.storage));
  try {
    const banner = JSON.parse(check.prepare("SELECT value FROM settings WHERE key = 'banner'").get()?.value ?? 'null');
    if (banner?.storage) needed.add(banner.storage);
  } catch { /* no banner */ }
  check.close();
  if (integrity !== 'ok') throw new Error('That snapshot is damaged. Try an older one.');
  // Nobody stays signed in through a restore (a device signed out since the backup would otherwise be back in), and
  // an old setup link or deletion request doesn't come back with it.
  const fix = new DatabaseSync(tmpDb);
  fix.exec("DELETE FROM sessions; DELETE FROM settings WHERE key IN ('setup_link', 'account_deletion')");
  fix.close();

  phase('Downloading attachments');
  const missing = await fetchFiles(rclone, slug, [...needed], target.files, { all: true });
  await rclone(['copyto', `hostbackup:tenants/${slug}/config/wordpress.key`, path.join(target.data, 'wordpress.key')]).catch(() => {});
  if (fs.existsSync(path.join(target.data, 'wordpress.key'))) fs.chmodSync(path.join(target.data, 'wordpress.key'), 0o600);
  fs.renameSync(tmpDb, target.db);
  for (const x of ['-wal', '-shm']) fs.rmSync(target.db + x, { force: true });
  const expected = entry?.notes ?? (snap === m.snapshot ? m.notes : null);
  return { snapshot: snap, at: entry?.at ?? stampTime(snap), notes, expectedNotes: expected, files: countFiles(target.files).count, missing: missing.length, integrity, dest: d.id };
}

/** Restores into a scratch folder, checks it and removes it: proof the backup can be restored. */
export function testRestore(slug, snapshot = null, destId = null) {
  if (running) throw httpError(409, 'A backup or restore is running.');
  const d = mustDest(destId);
  const job = startJob('test-restore', slug);
  running = { jobId: job.id, phase: 'Starting', startedAt: Date.now() };
  (async () => {
    const dir = path.join(paths.root, 'restore-check', `${slug}-${stamp()}`);
    const target = { data: path.join(dir, 'data'), storage: path.join(dir, 'storage'), files: path.join(dir, 'storage', 'files'), db: path.join(dir, 'storage', 'notes.db') };
    try {
      const r = await restoreInto(d, slug, snapshot, target, (p) => job.phase(running.phase = p));
      const problems = [];
      if (r.expectedNotes != null && r.notes !== r.expectedNotes) problems.push(`${r.notes} notes; the backup said ${r.expectedNotes}`);
      if (r.missing) problems.push(`${r.missing} attachment(s) missing`);
      job.finish(!problems.length, { ...r, account: d.account, problems });
      if (problems.length) alert(slug, 'warning', 'test-restore', `A test restore of ${slug} (${d.account}) found problems: ${problems.join('; ')}.`, { quiet: 0 });
    } catch (e) {
      job.finish(false, { error: e.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      running = null;
    }
  })();
  return { jobId: job.id };
}

/**
 * Restores a tenant from the host backup over its live data (moved aside to pre-restore-<stamp>/ first, not
 * deleted), or brings back a tenant that isn't on this server any more (e.g. on a new server).
 */
export function restoreLive(slug, snapshot = null, destId = null) {
  if (running) throw httpError(409, 'A backup or restore is running.');
  const d = mustDest(destId);
  const job = startJob('restore', slug);
  running = { jobId: job.id, phase: 'Starting', startedAt: Date.now() };
  (async () => {
    const p = paths.tenant(slug);
    let t = getTenant(slug);
    let aside = null;
    try {
      if (t) {
        job.phase(running.phase = `Stopping ${slug}`);
        aside = await setAside(t);
      } else {
        job.phase(running.phase = 'Reading the tenant’s settings from the backup');
        const info = JSON.parse(await rcloneFor(d)(['cat', `hostbackup:tenants/${slug}/config/tenant.json`]).catch(() => '{}'));
        t = addTenant({ slug, name: info.name ?? slug, limits: info.limits, timeZone: info.timeZone, release: (await import('./releases.js')).currentRelease() });
      }
      const r = await restoreInto(d, slug, snapshot, { data: p.data, storage: p.storage, files: p.files, db: p.db }, (x) => job.phase(running.phase = x));
      if (t.status !== 'active') t = updateTenant(slug, { status: 'active' });
      job.phase(running.phase = `Starting ${slug}`);
      await runner().start(mustTenant(slug));
      await pushGateway();
      const h = await waitHealthy(mustTenant(slug), { timeout: 90_000 });
      job.finish(true, { ...r, aside, healthNotes: h.notes });
      alert(slug, 'info', 'restored', `${slug} was restored from the backup of ${new Date(r.at).toUTCString()}.${aside ? ' The data it replaced is kept in its folder (pre-restore).' : ''}`, { quiet: 0 });
    } catch (e) {
      const back = aside ? await putBack(slug, aside) : false;
      job.finish(false, { error: e.message, putBack: back });
      alert(slug, 'danger', 'restore-failed', `Restoring ${slug} failed: ${e.message}${aside ? (back ? ' Its data was put back as it was.' : ` Its previous data is in ${aside}.`) : ''}`, { quiet: 0 });
    } finally {
      running = null;
    }
  })();
  return { jobId: job.id };
}

// ---------- restoring some notes ----------

/*
 * Single notes or notebooks back into a running tenant, as copies (Restore… → Notes and notebooks). The console
 * opens a snapshot only to list notebook names and note titles; it never shows or keeps what notes say. The chosen
 * notes go to the tenant as a note package (server/notepackread.js) in its restore-points/incoming/ folder, with
 * their attachments, and the tenant adds them itself (/control/import-package in server/tenant.js).
 */
const ITEM_IDLE = 30 * 60_000;
const itemSessions = new Map(); // token -> { slug, dest, snapshot, at, dir, db, used }

function closeItems(token) {
  const s = itemSessions.get(token);
  if (!s) return;
  itemSessions.delete(token);
  try { s.db.close(); } catch { /* closed */ }
  fs.rmSync(s.dir, { recursive: true, force: true });
}
setInterval(() => { for (const [k, s] of itemSessions) if (Date.now() - s.used > ITEM_IDLE) closeItems(k); }, 5 * 60_000).unref();

/** Opens a snapshot of a tenant: its notebooks (names and counts) and notes (titles only). */
export async function openItems(slug, snapshot = null, destId = null) {
  mustTenant(slug);
  const d = mustDest(destId);
  for (const [k, s] of itemSessions) if (s.slug === slug) closeItems(k);
  const token = crypto.randomBytes(16).toString('hex');
  const dir = path.join(paths.root, 'item-restore', `${slug}-${token.slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const { file, snap, entry } = await fetchSnapshot(rcloneFor(d), slug, snapshot, dir);
    const snapDb = new DatabaseSync(file, { readOnly: true });
    if (Object.values(snapDb.prepare('PRAGMA quick_check').get())[0] !== 'ok') { snapDb.close(); throw httpError(422, 'That snapshot is damaged. Try another.'); }
    const at = entry?.at ?? stampTime(snap);
    itemSessions.set(token, { slug, dest: d, snapshot: snap, at, dir, db: snapDb, used: Date.now() });
    const notebooks = snapDb.prepare(`SELECT nb.id, nb.name, s.name AS stack,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.is_template = 0) AS count
      FROM notebooks nb LEFT JOIN stacks s ON s.id = nb.stack_id ORDER BY s.name COLLATE NOCASE, nb.name COLLATE NOCASE`).all();
    const notes = snapDb.prepare(`SELECT id, notebook_id, title, updated_at,
        (SELECT COUNT(*) FROM attachments a WHERE a.note_id = notes.id) AS attachments
      FROM notes WHERE deleted_at IS NULL AND is_template = 0 ORDER BY title COLLATE NOCASE LIMIT 20000`).all();
    return { token, at, snapshot: snap, account: d.account, notebooks, notes };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e.statusCode ? e : httpError(502, e.message);
  }
}

export const closeItemSession = (token) => closeItems(String(token ?? ''));

/** Restores chosen notes and notebooks from an opened snapshot into the tenant, as copies. Runs as a job. */
export function restoreItems(token, { notes = [], notebooks = [] } = {}) {
  const s = itemSessions.get(String(token ?? ''));
  if (!s) throw httpError(410, 'That snapshot was closed. Open it again.');
  if (running) throw httpError(409, 'A backup or restore is running.');
  const t = mustTenant(s.slug);
  if (t.status !== 'active') throw httpError(409, `${s.slug} isn’t running. Resume it first.`);
  const pkg = readPackage(s.db, { noteIds: notes, notebookIds: notebooks });
  s.used = Date.now();
  const job = startJob('restore-notes', s.slug);
  running = { jobId: job.id, phase: 'Starting', startedAt: Date.now() };
  (async () => {
    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.join(paths.tenant(s.slug).storage, 'restore-points', 'incoming', id);
    try {
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
      const names = [...new Set(pkg.notes.flatMap((n) => n.attachments.map((a) => a.storage)))];
      // Attachments still in the tenant's own files need no download.
      const live = paths.tenant(s.slug).files;
      const fetch = [];
      for (const n of names) {
        if (fs.existsSync(path.join(live, n))) fs.copyFileSync(path.join(live, n), path.join(dir, 'files', n), fs.constants.COPYFILE_FICLONE);
        else fetch.push(n);
      }
      if (fetch.length) {
        job.phase(running.phase = `Downloading ${fetch.length} attachment${fetch.length === 1 ? '' : 's'}`);
        await fetchFiles(rcloneFor(s.dest), s.slug, fetch, path.join(dir, 'files'));
      }
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      job.phase(running.phase = `Adding them to ${s.slug}’s Selah`);
      const r = await control(t, 'POST', '/control/import-package', { id, at: s.at }, { timeout: 10 * 60_000 });
      const detail = { at: s.at, notes: r.notes, notebooks: r.notebooks.length, attachments: r.attachments, missing: r.missing, account: s.dest.account };
      job.finish(true, detail);
      alert(s.slug, 'info', 'restored', `${r.notes} note${r.notes === 1 ? '' : 's'} restored into ${s.slug} from the backup of ${new Date(s.at).toUTCString()}.`, { quiet: 0 });
    } catch (e) {
      job.finish(false, { error: e.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      running = null;
    }
  })();
  return { jobId: job.id };
}

/** Stops a tenant and moves its data and storage into pre-restore-<stamp>/ in its folder; returns that folder. */
async function setAside(t) {
  const p = paths.tenant(t.slug);
  await control(t, 'POST', '/control/sign-out-all').catch(() => {});
  await runner().stop(t);
  const aside = path.join(p.dir, `pre-restore-${stamp()}`);
  fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const d of ['data', 'storage']) if (fs.existsSync(path.join(p.dir, d))) fs.renameSync(path.join(p.dir, d), path.join(aside, d));
  return aside;
}

/** After a failed restore: the half-restored data goes to failed-restore-<stamp>/, the old data back, and it starts. */
async function putBack(slug, aside) {
  const p = paths.tenant(slug);
  try {
    const failed = path.join(p.dir, `failed-restore-${stamp()}`);
    fs.mkdirSync(failed, { recursive: true, mode: 0o700 });
    for (const d of ['data', 'storage']) {
      if (fs.existsSync(path.join(p.dir, d))) fs.renameSync(path.join(p.dir, d), path.join(failed, d));
      if (fs.existsSync(path.join(aside, d))) fs.renameSync(path.join(aside, d), path.join(p.dir, d));
    }
    fs.rmSync(aside, { recursive: true, force: true });
    await runner().start(mustTenant(slug));
    return true;
  } catch {
    return false; // left for the admin; the alert says where
  }
}

// ---------- restoring from a backup file ----------

const UPLOADS = path.join(paths.root, 'uploads');

/** A backup file uploaded from the console (Restore… → From a backup file), streamed to disk. */
export async function saveUpload(slug, stream) {
  mustTenant(slug);
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  // Uploads that were never restored go after a day.
  for (const f of fs.readdirSync(UPLOADS)) {
    if (Date.now() - fs.statSync(path.join(UPLOADS, f)).mtimeMs > 86_400_000) fs.rmSync(path.join(UPLOADS, f), { force: true });
  }
  const id = `${slug}-${stamp()}-${Math.random().toString(36).slice(2, 8)}.upload`;
  const file = path.join(UPLOADS, id);
  try {
    await pipeline(stream, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw httpError(400, `The upload didn’t finish (${e.message}).`);
  }
  const kind = backupKind(file);
  if (kind !== 'encrypted' && kind !== 'plain') {
    fs.rmSync(file, { force: true });
    throw httpError(400, kind === 'zip'
      ? 'That’s a zip from “Download all my data” in an older Selah. Restoring needs a file from Download a backup.'
      : 'That isn’t a Selah backup file (.selahbak or .tar.gz).');
  }
  return { upload: id, bytes: fs.statSync(file).size, encrypted: kind === 'encrypted' };
}

/** The path of an upload made for `slug`, or a 404. */
export function uploadPath(slug, id) {
  const name = String(id ?? '');
  if (!/^[a-z0-9-]+-\d{8}T\d{6}Z-[a-z0-9]+\.upload$/.test(name) || !name.startsWith(`${slug}-`)) throw httpError(404, 'That upload isn’t here any more. Upload the file again.');
  const file = path.join(UPLOADS, name);
  if (!fs.existsSync(file)) throw httpError(404, 'That upload isn’t here any more. Upload the file again.');
  return file;
}

/**
 * Restores a tenant from a backup file (a .selahbak from Download a backup, or its .tar.gz form): unpacked and
 * checked first while the tenant keeps running, then it stops, its data is moved aside (kept) and the backup put in
 * its place. `remove` deletes the file once restored (an upload).
 */
export function restoreFromFile(slug, file, passphrase = null, { remove = false } = {}) {
  if (running) throw httpError(409, 'A backup or restore is running.');
  let t = mustTenant(slug);
  const job = startJob('restore', slug);
  running = { jobId: job.id, phase: 'Starting', startedAt: Date.now() };
  const done = (async () => {
    const p = paths.tenant(slug);
    const scratch = path.join(p.dir, `restore-file-${stamp()}`);
    let aside = null;
    try {
      job.phase(running.phase = 'Unpacking and checking the backup file');
      const r = await unpackBackup(file, passphrase, scratch);
      if (r.manifest?.tenant && r.manifest.tenant !== slug) job.phase(running.phase = `Restoring ${r.manifest.tenant}’s backup into ${slug}`);
      scrubRestoredDb(path.join(scratch, 'notes.db'));
      job.phase(running.phase = `Stopping ${slug}`);
      aside = await setAside(t);
      installUnpacked(scratch, { db: p.db, files: p.files, data: p.data });
      fs.writeFileSync(path.join(p.storage, '.note-app-storage'), 'Selah tenant storage. Do not delete.\n');
      if (t.status !== 'active') t = updateTenant(slug, { status: 'active' });
      job.phase(running.phase = `Starting ${slug}`);
      await runner().start(mustTenant(slug));
      await pushGateway();
      const h = await waitHealthy(mustTenant(slug), { timeout: 90_000 });
      const at = Date.parse(r.createdAt ?? '') || null;
      const result = { source: 'file', at, notes: r.notes, files: r.files, missing: r.missing.length, from: r.manifest?.tenant ?? null, aside, healthNotes: h.notes };
      job.finish(true, result);
      alert(slug, 'info', 'restored', `${slug} was restored from a backup file${at ? ` made ${new Date(at).toUTCString()}` : ''}. The data it replaced is kept in its folder (pre-restore).`, { quiet: 0 });
      if (remove) fs.rmSync(file, { force: true });
      return result;
    } catch (e) {
      const back = aside ? await putBack(slug, aside) : false;
      job.finish(false, { error: e.message, putBack: back });
      alert(slug, 'danger', 'restore-failed', `Restoring ${slug} from a file failed: ${e.message}${aside ? (back ? ' Its data was put back as it was.' : ` Its previous data is in ${aside}.`) : ''}`, { quiet: 0 });
      throw e;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      running = null;
    }
  })();
  done.catch(() => {});
  return { jobId: job.id, done };
}
