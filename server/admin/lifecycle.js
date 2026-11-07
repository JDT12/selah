import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  addTenant, alert, cleanLimits, cloud, getTenant, mustTenant, removeTenantRecord, saveHealth, updateTenant,
} from './store.js';
import { db } from '../db.js';
import { paths } from './paths.js';
import { crashLoop, runner } from './runner.js';
import { pushGateway } from './gateway.js';
import { control, waitHealthy } from './control.js';
import { currentRelease } from './releases.js';

/** Creating, inviting, pausing, changing and deleting tenants. */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const TRASH_DAYS = 7;

/** A tenant's folders, with the storage marker the server looks for before it opens a database. */
export function makeFolders(slug) {
  const p = paths.tenant(slug);
  for (const d of [p.data, p.files]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);
  const marker = path.join(p.storage, '.note-app-storage');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Selah tenant storage. Do not delete.\n');
}

export const setupUrl = (t, token) => `${t.url}/#setup=${token}`;

/** A new one-time setup link: 'invite' (first time) or 'reset' (a new password and authenticator). */
export async function setupLink(slug, kind = 'invite') {
  const t = mustTenant(slug);
  if (t.status !== 'active') throw httpError(409, `${slug} is paused. Resume it first.`);
  const { token, expires } = await control(t, 'POST', '/control/setup-link', { kind });
  return { url: setupUrl(t, token), expires, kind };
}

export async function createTenant({ slug, name, limits, timeZone }) {
  const t = addTenant({ slug, name, limits, timeZone, release: currentRelease() });
  try {
    makeFolders(t.slug);
    await runner().start(t);
    await pushGateway();
    await waitHealthy(t, { timeout: 90_000, failFast: crashLoop(t) });
    const link = await setupLink(t.slug, 'invite');
    // Its state as it is now (with the setup link waiting), not as the monitor last saw it.
    saveHealth(t.slug, await control(t, 'GET', '/control/health'));
    alert(t.slug, 'info', 'tenant-created', `${t.slug} was created.`, { quiet: 0 });
    return { tenant: getTenant(t.slug), link };
  } catch (e) {
    // Leave nothing half made.
    await runner().stop(t).catch(() => {});
    removeTenantRecord(t.slug);
    fs.rmSync(paths.tenant(t.slug).dir, { recursive: true, force: true });
    await pushGateway().catch(() => {});
    throw e;
  }
}

export async function suspendTenant(slug) {
  const t = mustTenant(slug);
  await control(t, 'POST', '/control/sign-out-all').catch(() => {});
  await runner().stop(t);
  updateTenant(slug, { status: 'suspended' });
  await pushGateway();
  alert(slug, 'info', 'tenant-suspended', `${slug} was paused.`, { quiet: 0 });
  return getTenant(slug);
}

export async function resumeTenant(slug) {
  const t = updateTenant(mustTenant(slug).slug, { status: 'active' });
  await runner().start(t);
  await pushGateway();
  saveHealth(slug, await waitHealthy(t, { failFast: crashLoop(t) }));
  return getTenant(slug);
}

export async function restartTenant(slug) {
  const t = mustTenant(slug);
  if (t.status !== 'active') throw httpError(409, `${slug} is paused.`);
  await runner().start(t); // start stops it first
  saveHealth(slug, await waitHealthy(t, { failFast: crashLoop(t) }));
  return getTenant(slug);
}

/** Name, time zone and limits; a running tenant restarts so the new limits apply. */
export async function changeTenant(slug, { name, limits, timeZone }) {
  const t = mustTenant(slug);
  const patch = {};
  if (typeof name === 'string') patch.name = name.trim().slice(0, 80);
  if (typeof timeZone === 'string' && timeZone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw httpError(400, 'Unknown time zone.'); }
    patch.timeZone = timeZone;
  }
  if (limits) patch.limits = cleanLimits(limits, t.limits);
  const next = updateTenant(slug, patch);
  if (next.status === 'active' && (patch.limits || patch.timeZone || patch.name)) {
    await runner().start(next);
    await waitHealthy(next, { failFast: crashLoop(next) });
  }
  return getTenant(slug);
}

/**
 * Deletes a tenant: stopped, taken off the gateway, its folder moved to trash/ (removed for good after TRASH_DAYS)
 * and its host backups and security log copy removed. `why` is 'admin' or 'requested' (the person asked, in
 * Settings → Account).
 */
export async function deleteTenant(slug, why = 'admin') {
  const t = mustTenant(slug);
  await runner().stop(t).catch(() => {});
  removeTenantRecord(slug);
  await pushGateway().catch(() => {});
  const p = paths.tenant(slug);
  if (fs.existsSync(p.dir)) {
    fs.mkdirSync(paths.trash, { recursive: true, mode: 0o700 });
    fs.renameSync(p.dir, path.join(paths.trash, `${slug}-${stamp()}`));
  }
  db.prepare('DELETE FROM tenant_events WHERE slug = ?').run(slug);
  (await import('./sharing.js')).forgetTenant(slug);
  const { purgeHostBackup } = await import('./backups.js');
  await purgeHostBackup(slug).catch((e) => alert(slug, 'warning', 'purge-failed', `${slug}’s host backup couldn’t be removed: ${e.message}`));
  alert(null, 'info', 'tenant-deleted', `${slug} was deleted${why === 'requested' ? ' (they asked to delete their account)' : ''}. Its folder is kept in trash for ${TRASH_DAYS} days.`, { quiet: 0 });
}

/** Removes trash older than TRASH_DAYS. */
export function emptyTrash() {
  let names = [];
  try { names = fs.readdirSync(paths.trash); } catch { return; }
  for (const n of names) {
    // <name>-20261025T031500Z: when it was deleted.
    const m = n.match(/-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
    const at = m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : null;
    if (at && Date.now() - at > TRASH_DAYS * 86400_000) fs.rmSync(path.join(paths.trash, n), { recursive: true, force: true });
  }
}

export const defaultLimits = () => cloud().limits;

// ---------- moving a home server in (6.0.1) ----------

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

function countsIn(dbFile) {
  const d = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const n = (sql) => { try { return d.prepare(sql).get().n; } catch { return null; } };
    const t = (table) => n(`SELECT COUNT(*) AS n FROM ${table}`);
    return {
      notes: n('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL'),
      notesInTrash: n('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL'),
      notebooks: t('notebooks'), attachments: t('attachments'), tags: t('tags'), tasks: t('tasks'),
      events: t('events'), prayers: t('prayers'), sermons: t('sermons'), studies: t('studies'),
    };
  } finally {
    d.close();
  }
}

/**
 * Imports a home server's Selah (a folder made by npm run cloud-export) as tenant `slug`: every file is checked
 * against the manifest first, sign-ins from the old server are dropped (the password and two-step sign-in carry over),
 * and the counts are compared once it's running. With `replace`, an existing tenant's data is swapped for the import
 * (its old folders go to the trash). Returns a report; throws if anything doesn't match.
 */
export async function importTenant({ slug, name, from, replace = false, log = () => {} }) {
  const dir = path.resolve(String(from ?? ''));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { throw httpError(400, `No manifest.json in ${dir}. Make the folder with npm run cloud-export on the home server.`); }
  if (manifest.format !== 'selah-move-1') throw httpError(400, 'That folder isn’t a Selah export this version understands.');

  log(`Checking ${manifest.files.length} files…`);
  for (const f of manifest.files) {
    if (f.path.includes('..') || path.isAbsolute(f.path) || !/^(storage|data)\//.test(f.path)) throw httpError(400, `Unexpected path in the manifest: ${f.path}`);
    const file = path.join(dir, f.path);
    if (!fs.existsSync(file)) throw httpError(400, `Missing from the export: ${f.path}`);
    if (fs.statSync(file).size !== f.size || (await sha256File(file)) !== f.sha256) throw httpError(400, `Changed or damaged in transit: ${f.path}`);
  }
  log('All files match the manifest.');

  let t = getTenant(String(slug ?? '').toLowerCase());
  let created = false;
  const p = () => paths.tenant(t.slug);
  if (t) {
    if (!replace) throw httpError(409, `There’s already a tenant called ${t.slug}. Add --replace to swap its data for this import.`);
    log(`Stopping ${t.slug} and moving its current data to the trash…`);
    await runner().stop(t);
    const keep = path.join(paths.trash, `${t.slug}-before-import-${stamp()}`);
    fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
    for (const sub of ['data', 'storage']) if (fs.existsSync(path.join(p().dir, sub))) fs.renameSync(path.join(p().dir, sub), path.join(keep, sub));
  } else {
    t = addTenant({ slug, name: name || slug, timeZone: manifest.timeZone, release: currentRelease() });
    created = true;
  }
  try {
    makeFolders(t.slug);
    log('Copying…');
    for (const f of manifest.files) {
      const to = path.join(p().dir, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(dir, f.path), to);
      fs.chmodSync(to, 0o600);
    }
    // Sign-ins and any waiting setup link belong to the old server; the password and two-step sign-in stay.
    const d = new DatabaseSync(p().db);
    try {
      d.exec('DELETE FROM sessions');
      d.prepare("DELETE FROM settings WHERE key IN ('setup_link', 'account_deletion')").run();
    } finally {
      d.close();
    }
    log('Starting…');
    await runner().start(t);
    await pushGateway();
    saveHealth(t.slug, await waitHealthy(t, { timeout: 120_000, failFast: crashLoop(t) }));
    const counts = countsIn(p().db);
    const differ = Object.keys(manifest.counts).filter((k) => manifest.counts[k] !== counts[k]);
    if (differ.length) throw httpError(500, `The imported copy doesn’t match: ${differ.map((k) => `${k} ${counts[k]} (expected ${manifest.counts[k]})`).join(', ')}`);
    alert(t.slug, 'info', 'tenant-imported', `${t.slug} was ${created ? 'created from' : 'replaced with'} an import from ${manifest.from} (${manifest.version}).`, { quiet: 0 });
    return { tenant: getTenant(t.slug), counts, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.size, 0), from: manifest.from, version: manifest.version, withOffsite: !!manifest.withOffsite };
  } catch (e) {
    await runner().stop(t).catch(() => {});
    if (created) {
      removeTenantRecord(t.slug);
      fs.rmSync(paths.tenant(t.slug).dir, { recursive: true, force: true });
      await pushGateway().catch(() => {});
    }
    throw e;
  }
}
