import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { getSetting, setSetting } from '../db.js';
import {
  alert, cloud, getTenant, listTenants, mustTenant, startJob, updateTenant,
} from './store.js';
import { paths, repoRoot } from './paths.js';
import { crashLoop, releaseDir, run, runner } from './runner.js';
import { waitHealthy } from './control.js';

/**
 * Releases and rolling updates. A release is a copy of Selah at one version (releases/<version>/, and with Docker
 * the image selah:<version>), made from the code this console runs from once it's been updated and built (selah
 * update). Tenants move to a new release one at a time: each is backed up, restarted on the new code and checked;
 * if one doesn't come up, it goes back to the release it was on (with its database as it was) and the update stops.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const versionIn = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };
const KEEP = 3;

export const repoVersion = () => versionIn(repoRoot);
/** The main release: the one new tenants start on (null: the code this console runs from). */
export const currentRelease = () => getSetting('current_release') || null;
/**
 * The beta release (Admin 3.2): prepared for the demo tenant to try first, without changing what new tenants start
 * on. Promote makes it main once it's approved. Null when there's no beta waiting (or it was promoted).
 */
export const betaRelease = () => {
  const b = getSetting('beta_release') || null;
  return b && b !== currentRelease() && fs.existsSync(path.join(paths.releases, b)) ? b : null;
};
export const releaseVersion = (release) => (release ? versionIn(releaseDir(release)) : repoVersion());

/**
 * Compares two versions, numbers part by part, with a pre-release (10.3.0-beta.2) before its release (10.3.0) and
 * betas in their order. For sorting release names.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const at = String(v).indexOf('-');
    const core = at < 0 ? String(v) : String(v).slice(0, at);
    const pre = at < 0 ? null : String(v).slice(at + 1);
    return { core: core.split('.').map((n) => Number(n) || 0), pre: pre ? pre.split('.') : null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d;
  }
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const np = /^\d+$/.test(p) ? Number(p) : null;
    const nq = /^\d+$/.test(q) ? Number(q) : null;
    const d = np !== null && nq !== null ? np - nq : np !== null ? -1 : nq !== null ? 1 : p.localeCompare(q);
    if (d) return d;
  }
  return 0;
}

/** Main (new tenants start on it), Beta (being tried on the demo) or Old (kept for rolling back). */
const channelOf = (release) => (release === currentRelease() ? 'main' : release === betaRelease() ? 'beta' : 'old');

export function listReleases() {
  let names = [];
  try { names = fs.readdirSync(paths.releases).filter((n) => !n.endsWith('.tmp') && versionIn(path.join(paths.releases, n))); } catch { /* none yet */ }
  const tenants = listTenants();
  return names.sort(compareVersions).reverse().map((n) => ({
    release: n,
    version: versionIn(path.join(paths.releases, n)),
    preparedAt: fs.statSync(path.join(paths.releases, n)).mtimeMs,
    current: n === currentRelease(),
    channel: channelOf(n),
    tenants: tenants.filter((t) => t.release === n).map((t) => t.slug),
  }));
}

let busy = null;
// A release or update started from the command line (npm run admin) runs in that process, so it leaves a note in
// the database for the console (and its monitor, which then doesn't restart tenants mid-update) to see.
const CLI_LOCK_MS = 30 * 60_000;
function cliBusy() {
  try {
    const l = JSON.parse(getSetting('cli_busy') ?? 'null');
    return l && Date.now() - l.at < CLI_LOCK_MS ? { jobId: l.jobId, phase: `${l.what} (from the command line)` } : null;
  } catch { return null; }
}
export const updateRunning = () => busy ?? cliBusy();
/** Only what this process is running (the command line waits on this). */
export const runningHere = () => busy;
export const holdCliLock = (what, jobId) => setSetting('cli_busy', JSON.stringify({ what, jobId, at: Date.now() }));
export const releaseCliLock = () => setSetting('cli_busy', 'null');

/**
 * Copies this server's code (at its current version, built) into releases/<version> (and builds its image). As beta
 * (the default since Admin 3.2) it's only for the tenants you move to it, the demo first; as main, new tenants start
 * on it straight away (urgent fixes).
 */
export function prepareRelease({ channel = 'beta' } = {}) {
  if (updateRunning()) throw httpError(409, 'An update is already running.');
  const version = repoVersion();
  if (!fs.existsSync(path.join(repoRoot, 'client', 'dist', 'index.html'))) throw httpError(409, 'This server’s code isn’t built. Run: npm run build');
  const dest = path.join(paths.releases, version);
  if (fs.existsSync(dest)) throw httpError(409, `Release ${version} is already prepared.`);
  const job = startJob('prepare');
  busy = { jobId: job.id, phase: 'Copying' };
  (async () => {
    const tmp = `${dest}.tmp`;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      job.phase(busy.phase = 'Copying the code');
      // Everything a server runs from; not the data or the desktop app. The browser extension stays: servers zip it up for download.
      const skip = ['/.git', '/data', '/notes-data', '/node_modules', '/client/dist', '/desktop', '/wordpress-plugin', '*.log'];
      const copy = await run('rsync', ['-a', ...skip.flatMap((x) => ['--exclude', x]), `${repoRoot}/`, `${tmp}/`], { timeout: 600_000 });
      if (!copy.ok) throw new Error(`rsync: ${copy.stderr.trim()}`);
      for (const d of ['client/dist', 'node_modules']) {
        job.phase(busy.phase = `Copying ${d}`);
        const r = await run('cp', ['-a', path.join(repoRoot, d), path.join(tmp, d)], { timeout: 600_000 });
        if (!r.ok) throw new Error(`Copying ${d}: ${r.stderr.trim()}`);
      }
      if (versionIn(tmp) !== version) throw new Error('The copied code has a different version.');
      if (cloud().runner === 'docker') {
        job.phase(busy.phase = 'Building the container image');
        const b = await run('docker', ['build', '-t', `selah:${version}`, tmp], { timeout: 1_800_000 });
        if (!b.ok) throw new Error(`docker build: ${b.stderr.trim().split('\n').slice(-3).join(' ')}`);
      }
      fs.renameSync(tmp, dest);
      if (channel === 'main') {
        setSetting('current_release', version);
        if (getSetting('beta_release') === version) setSetting('beta_release', '');
      } else {
        setSetting('beta_release', version);
      }
      pruneReleases();
      job.finish(true, { release: version, channel: channel === 'main' ? 'main' : 'beta' });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      job.finish(false, { error: e.message });
    } finally {
      busy = null;
    }
  })();
  return { jobId: job.id, release: version };
}

/**
 * Old releases nobody runs any more go. The newest few stay, and so do main, beta and every release a tenant runs or
 * could roll back to.
 */
function pruneReleases() {
  const keep = new Set([currentRelease(), betaRelease(), ...listTenants().flatMap((t) => [t.release, t.previousRelease])].filter(Boolean));
  const main = currentRelease();
  // A beta (11.1.0-beta.3) is done with once its release (11.1.0) or a later one is main, so it goes whatever its age.
  const spent = (r) => main && r.version?.includes('-') && compareVersions(r.version, main) < 0;
  const all = listReleases();
  for (const r of all.filter((x, i) => i >= KEEP || spent(x))) {
    if (!keep.has(r.release)) fs.rmSync(path.join(paths.releases, r.release), { recursive: true, force: true });
  }
}

/** Beta becomes main: new tenants start on it, and it's what Update offers. Tenants already on a release stay there. */
export function promoteRelease(release = betaRelease()) {
  if (updateRunning()) throw httpError(409, 'An update is already running.');
  if (!release || !fs.existsSync(path.join(paths.releases, release))) throw httpError(404, 'There’s no beta release to promote.');
  if (release === currentRelease()) throw httpError(409, `${release} is already main.`);
  const was = currentRelease();
  setSetting('current_release', release);
  if (getSetting('beta_release') === release) setSetting('beta_release', '');
  const job = startJob('promote');
  job.finish(true, { release, from: was });
  pruneReleases();
  return { release, from: was };
}

/** A copy of the tenant's database before an update (the newest two are kept). */
async function snapshotBeforeUpdate(t, to) {
  const p = paths.tenant(t.slug);
  if (!fs.existsSync(p.db)) return null;
  const dir = path.join(p.data, 'pre-update');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${t.release ?? 'base'}-to-${to}-${stamp()}.db`);
  const src = new DatabaseSync(p.db, { readOnly: true });
  try { await backup(src, file); } finally { src.close(); }
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
  for (const f of all.slice(0, -2)) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Moves one tenant to `release`; on failure puts it back as it was and throws. */
async function moveTenant(slug, release, phase) {
  const t = mustTenant(slug);
  const from = t.release;
  const version = releaseVersion(release);
  if (t.status !== 'active') {
    updateTenant(slug, { release, previousRelease: from });
    return { slug, from, to: release, skipped: 'paused' };
  }
  phase(`Updating ${slug}: saving a copy of its notes`);
  const snap = await snapshotBeforeUpdate(t, release);
  phase(`Updating ${slug}: restarting on ${version}`);
  const next = updateTenant(slug, { release, previousRelease: from });
  try {
    await runner().start(next);
    await waitHealthy(next, { version, timeout: 90_000, failFast: crashLoop(next) });
    return { slug, from, to: release };
  } catch (e) {
    phase(`Updating ${slug} failed; putting it back`);
    await runner().stop(next).catch(() => {});
    // It never came up on the new code, so nothing was written since the copy: put the database back as it was.
    if (snap) {
      const db = paths.tenant(slug).db;
      fs.copyFileSync(snap, db);
      for (const x of ['-wal', '-shm']) fs.rmSync(db + x, { force: true });
    }
    const back = updateTenant(slug, { release: from, previousRelease: t.previousRelease });
    await runner().start(back).catch(() => {});
    await waitHealthy(back, { timeout: 60_000 }).catch(() => {});
    throw Object.assign(new Error(`${slug} didn’t come up on ${version}, so it’s back on ${releaseVersion(from)}. ${e.message}.`), { slug });
  }
}

/** Updates tenants (all, or `slugs`) to `release`, one at a time. Stops at the first one that fails. */
export function rollingUpdate({ release = currentRelease(), slugs = null } = {}) {
  if (updateRunning()) throw httpError(409, 'An update is already running.');
  if (release && !fs.existsSync(path.join(paths.releases, release))) throw httpError(404, `Release ${release} isn’t prepared.`);
  const targets = listTenants().filter((t) => (!slugs || slugs.includes(t.slug)) && t.release !== release);
  if (!targets.length) throw httpError(409, 'Every tenant is already on that release.');
  const job = startJob('update');
  busy = { jobId: job.id, phase: 'Starting' };
  (async () => {
    const done = [];
    try {
      for (const t of targets) {
        done.push(await moveTenant(t.slug, release, (p) => job.phase(busy.phase = p)));
      }
      job.finish(true, { release, done });
      alert(null, 'info', 'updated', `${done.length} tenant${done.length === 1 ? '' : 's'} updated to ${releaseVersion(release)}.`, { quiet: 0 });
    } catch (e) {
      // New tenants shouldn't start on a release that just failed: they go back to the one that worked.
      const failedOn = targets[done.length];
      let note = '';
      if (release === currentRelease() && failedOn) {
        setSetting('current_release', failedOn.release ?? '');
        note = ` New tenants start on ${releaseVersion(failedOn.release)} until it's fixed.`;
      }
      job.finish(false, { release, done, failed: e.slug ?? null, error: e.message, left: targets.slice(done.length + 1).map((t) => t.slug) });
      alert(e.slug ?? null, 'danger', 'update-failed', `The update stopped: ${e.message}${note}`, { quiet: 0 });
    } finally {
      busy = null;
    }
  })();
  return { jobId: job.id, tenants: targets.map((t) => t.slug) };
}

/**
 * Puts tenants back on the release each was on before its last update, one at a time. Tenants with nothing to go back
 * to are skipped; one that doesn't come up stops the rest.
 */
export function rollBack(slugs) {
  if (updateRunning()) throw httpError(409, 'An update is already running.');
  const list = (Array.isArray(slugs) ? slugs : [slugs]).map((x) => mustTenant(x));
  const targets = list.filter((t) => t.previousRelease || t.release);
  if (!targets.length) throw httpError(409, list.length === 1 ? `${list[0].slug} has nothing to go back to.` : 'None of those tenants has anything to go back to.');
  for (const t of targets) {
    if (t.previousRelease && !fs.existsSync(path.join(paths.releases, t.previousRelease))) throw httpError(409, `Release ${t.previousRelease} (for ${t.slug}) isn’t on the server any more.`);
  }
  const job = startJob('rollback', targets.length === 1 ? targets[0].slug : null);
  busy = { jobId: job.id, phase: 'Rolling back' };
  (async () => {
    const done = [];
    let at = null;
    try {
      for (const t of targets) {
        at = t.slug;
        job.phase(busy.phase = `Rolling ${t.slug} back`);
        const to = t.previousRelease;
        const next = updateTenant(t.slug, { release: to, previousRelease: t.release });
        if (next.status === 'active') {
          await runner().start(next);
          await waitHealthy(next, { version: releaseVersion(to), timeout: 90_000, failFast: crashLoop(next) });
        }
        done.push({ slug: t.slug, from: t.release, to });
      }
      job.finish(true, { done, ...(done.length === 1 ? { from: done[0].from, to: done[0].to } : {}) });
    } catch (e) {
      job.finish(false, { done, failed: at, error: e.message });
      alert(at, 'danger', 'rollback-failed', `Rolling ${at} back failed: ${e.message}`, { quiet: 0 });
    } finally {
      busy = null;
    }
  })();
  return { jobId: job.id, tenants: targets.map((t) => t.slug) };
}

export const tenantVersion = (slug) => releaseVersion(getTenant(slug)?.release ?? null);
