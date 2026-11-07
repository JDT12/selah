import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { db } from '../db.js';
import { config } from '../config.js';
import * as auth from '../auth.js';
import { twoFactorOn } from '../security.js';
import {
  DEFAULT_LIMITS, LIMIT_RANGES, cleanLimits, cloud, listAlerts, listJobs, listTenants, markAlertsSeen, mustTenant, saveCloud,
  activeJobs, adminHost, publicUrl,
} from './store.js';
import { paths, repoRoot } from './paths.js';
import { dockerAvailable, runner } from './runner.js';
import { allowedRanges, certificateInfo, gatewayStatus, pushGateway, PRIVATE_RANGES } from './gateway.js';
import {
  changeTenant, createTenant, deleteTenant, restartTenant, resumeTenant, setupLink, suspendTenant,
} from './lifecycle.js';
import * as backups from './backups.js';
import { backupKind, passphraseFits } from '../backupfile.js';
import {
  betaRelease, currentRelease, listReleases, prepareRelease, promoteRelease, releaseVersion, repoVersion, rollBack, rollingUpdate, updateRunning,
} from './releases.js';
import { DEMO_SLUG, demoResetRunning, resetDemo } from './demo.js';
import { monitorState, runMonitorNow } from './monitor.js';
import * as maintenance from './maintenance.js';
import { getNotice, saveNotice } from './notice.js';
import { setSharing, sharingOverview } from './sharing.js';
import { ADMIN_VERSION } from './version.js';

/** The admin console's API. Everything but signing in needs two-step sign-in turned on. */

const httpError = (code, message, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const STARTED = Date.now();

/** "203.0.113.7" or "203.0.113.0/24" or an IPv6 range, normalized; throws if it isn't one. */
export function cleanRange(v) {
  const s = String(v ?? '').trim();
  const [ip, bits] = s.split('/');
  const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!type) throw httpError(400, `“${s}” isn’t an IP address or range.`);
  const max = type === 'ipv4' ? 32 : 128;
  const n = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > max) throw httpError(400, `“${s}” has a bad range size.`);
  if (n < (type === 'ipv4' ? 8 : 16)) throw httpError(400, `“${s}” is too wide a range.`);
  return `${ip}/${n}`;
}

function diskInfo() {
  try {
    const s = fs.statfsSync(paths.root);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

const recentEvents = ({ slug = null, kind = null, limit = 200 } = {}) => db.prepare(
  `SELECT id, slug, at, kind, ip, device, detail FROM tenant_events WHERE (? IS NULL OR slug = ?) AND (? IS NULL OR kind = ?) ORDER BY at DESC, id DESC LIMIT ?`,
).all(slug, slug, kind, kind, Math.min(1000, limit)).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

export default async function adminRoutes(app) {
  app.get('/api/session', async (req) => ({
    authenticated: !!req.session, passwordSet: auth.passwordIsSet(), mode: 'admin', timeZone: config.timeZone, cert: null, tenant: null,
  }));
  // The console's update banner compares both with what the page was built with.
  app.get('/api/version', async () => ({ version: VERSION, adminVersion: ADMIN_VERSION }));

  app.register(async (admin) => {
    admin.addHook('preHandler', async () => {
      if (!twoFactorOn()) throw httpError(403, 'Turn on two-step sign-in first (Security).', { needTwoStep: true });
    });

    // ---------- overview ----------
    admin.get('/api/admin/overview', async () => {
      const tenants = listTenants();
      const unseen = listAlerts({ unseen: true, limit: 50 });
      return {
        version: VERSION, adminVersion: ADMIN_VERSION, startedAt: STARTED, host: os.hostname(), cloud: cloud(), adminUrl: publicUrl(adminHost()),
        tenants: { total: tenants.length, active: tenants.filter((t) => t.status === 'active').length, healthy: tenants.filter((t) => t.status === 'active' && t.health?.ok).length },
        alerts: unseen, disk: diskInfo(), certificate: await certificateInfo(), gateway: await gatewayStatus(), monitor: monitorState(),
        backup: backups.backupStatus(), jobs: activeJobs(), runner: cloud().runner,
        load: os.loadavg(), memory: { free: os.freemem(), total: os.totalmem() }, uptime: os.uptime(),
        maintenance: await maintenance.maintenanceInfo(),
      };
    });

    // ---------- tenants ----------
    admin.get('/api/admin/tenants', async () => ({
      tenants: await Promise.all(listTenants().map(async (t) => ({ ...t, state: await runner().status(t), version: releaseVersion(t.release) }))),
      defaults: cloud().limits, ranges: LIMIT_RANGES, timeZone: cloud().timeZone,
    }));

    admin.get('/api/admin/tenants/:slug', async (req) => {
      const t = mustTenant(req.params.slug);
      return {
        tenant: { ...t, state: await runner().status(t), version: releaseVersion(t.release) },
        events: recentEvents({ slug: t.slug, limit: 50 }),
        jobs: listJobs({ slug: t.slug, limit: 20 }),
        backup: backups.backupStatus().tenants[t.slug] ?? null,
      };
    });

    admin.get('/api/admin/tenants/:slug/logs', async (req) => ({ text: await runner().logs(mustTenant(req.params.slug), 300) }));

    admin.post('/api/admin/tenants', async (req) => {
      auth.requireConfirmed(req);
      const b = req.body ?? {};
      const r = await createTenant({ slug: b.slug, name: b.name, limits: b.limits, timeZone: b.timeZone || null });
      auth.logEvent('tenant-created', req, { slug: r.tenant.slug });
      return r;
    });

    admin.patch('/api/admin/tenants/:slug', async (req) => changeTenant(req.params.slug, req.body ?? {}));

    admin.post('/api/admin/tenants/:slug/setup-link', async (req) => {
      auth.requireConfirmed(req);
      const r = await setupLink(req.params.slug, req.body?.kind === 'reset' ? 'reset' : 'invite');
      auth.logEvent('setup-link', req, { slug: req.params.slug, kind: r.kind });
      return r;
    });

    admin.post('/api/admin/tenants/:slug/suspend', async (req) => {
      const t = await suspendTenant(req.params.slug);
      auth.logEvent('tenant-suspended', req, { slug: t.slug });
      return t;
    });
    admin.post('/api/admin/tenants/:slug/resume', async (req) => {
      const t = await resumeTenant(req.params.slug);
      auth.logEvent('tenant-resumed', req, { slug: t.slug });
      return t;
    });
    admin.post('/api/admin/tenants/:slug/restart', async (req) => restartTenant(req.params.slug));

    admin.delete('/api/admin/tenants/:slug', async (req) => {
      auth.requireConfirmed(req);
      const t = mustTenant(req.params.slug);
      if (String(req.body?.confirm ?? '') !== t.slug) throw httpError(400, `Type ${t.slug} to confirm.`);
      await deleteTenant(t.slug, 'admin');
      auth.logEvent('tenant-deleted', req, { slug: t.slug });
      return { ok: true };
    });

    // ---------- security log and alerts ----------
    admin.get('/api/admin/events', async (req) => ({ events: recentEvents({ slug: req.query.slug || null, kind: req.query.kind || null, limit: Number(req.query.limit) || 200 }) }));
    admin.get('/api/admin/alerts', async (req) => ({ alerts: listAlerts({ limit: Math.min(500, Number(req.query.limit) || 100) }) }));
    admin.post('/api/admin/alerts/seen', async (req) => {
      markAlertsSeen(req.body?.id ? Number(req.body.id) : null);
      return { ok: true };
    });
    admin.post('/api/admin/monitor/run', async () => {
      await runMonitorNow();
      return monitorState();
    });

    // ---------- server maintenance ----------
    admin.get('/api/admin/maintenance', async (req) => maintenance.maintenanceInfo({ fresh: req.query.fresh === '1' }));
    admin.post('/api/admin/maintenance/done', async (req) => {
      const entry = maintenance.markDone(req.body ?? {});
      auth.logEvent('maintenance-done', req, { checks: Object.keys(entry.checks).filter((k) => entry.checks[k]).length });
      return maintenance.maintenanceInfo({ fresh: true });
    });
    admin.post('/api/admin/maintenance/snooze', async (req) => {
      maintenance.snooze(req.body?.until);
      return maintenance.maintenanceInfo();
    });
    // The maintenance banner for users (notice.js).
    admin.get('/api/admin/notice', async () => getNotice());
    admin.put('/api/admin/notice', async (req) => {
      const r = await saveNotice(req.body ?? {});
      auth.logEvent('user-notice', req, { on: r.notice.on, start: r.notice.start });
      return r;
    });
    // Sharing between tenants (sharing.js): who shares with whom, and the switch for each tenant.
    admin.get('/api/admin/sharing', async () => sharingOverview());
    admin.put('/api/admin/sharing/:slug', async (req) => {
      const r = await setSharing(String(req.params.slug), req.body?.on !== false);
      auth.logEvent('sharing-switch', req, { tenant: req.params.slug, on: req.body?.on !== false });
      return r;
    });
    admin.put('/api/admin/maintenance/schedule', async (req) => {
      maintenance.saveSchedule(req.body ?? {});
      return maintenance.maintenanceInfo();
    });

    // ---------- jobs ----------
    admin.get('/api/admin/jobs', async (req) => ({
      jobs: listJobs({ limit: Math.min(200, Number(req.query.limit) || 50), kind: req.query.kind || null, slug: req.query.slug || null }),
      active: activeJobs(),
    }));

    // ---------- host backup ----------
    admin.get('/api/admin/backups', async () => ({ ...backups.backupStatus(), backupTime: cloud().backupTime, tenants: listTenants().map((t) => ({ slug: t.slug, status: t.status, own: t.health?.offsite ?? null, host: backups.backupStatus().tenants[t.slug] ?? null })) }));
    admin.post('/api/admin/backups/connect/start', async (req) => {
      auth.requireConfirmed(req);
      return { url: await backups.connectStart(req.session.id) };
    });
    admin.post('/api/admin/backups/connect/finish', async (req) => backups.connectFinish(req.session.id, req.body?.url));
    // Adds a destination (or with `id`, connects one again).
    admin.put('/api/admin/backups', async (req) => {
      auth.requireConfirmed(req);
      const r = await backups.connect(req.session.id, req.body ?? {});
      auth.logEvent('host-backup-connected', req, { account: r.account });
      return r;
    });
    admin.post('/api/admin/backups/test', async (req) => backups.testStorage(req.session.id, req.body ?? {}));
    admin.delete('/api/admin/backups/dests/:id', async (req) => {
      auth.requireConfirmed(req);
      const d = backups.destinations().find((x) => x.id === req.params.id);
      backups.disconnect(req.params.id);
      auth.logEvent('host-backup-disconnected', req, { account: d?.account ?? null });
      return { ok: true };
    });
    admin.put('/api/admin/backups/schedule', async (req) => {
      const v = String(req.body?.backupTime ?? '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw httpError(400, 'Use a 24-hour time like 02:30 (UTC).');
      saveCloud({ backupTime: v });
      return { backupTime: v };
    });
    admin.post('/api/admin/backups/run', async (req) => backups.runHostBackups({
      trigger: 'manual', slugs: Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : null, forceVerify: !!req.body?.verify,
    }));
    admin.get('/api/admin/backups/in-backup', async () => ({ tenants: await backups.backupTenants() }));
    admin.get('/api/admin/backups/:slug/snapshots', async (req) => backups.snapshots(req.params.slug, req.query.dest || null));
    admin.post('/api/admin/backups/:slug/test-restore', async (req) => backups.testRestore(req.params.slug, req.body?.snapshot || null, req.body?.dest || null));
    admin.post('/api/admin/backups/:slug/restore', async (req) => {
      auth.requireConfirmed(req);
      if (String(req.body?.confirm ?? '') !== req.params.slug) throw httpError(400, `Type ${req.params.slug} to confirm.`);
      auth.logEvent('tenant-restore', req, { slug: req.params.slug, snapshot: req.body?.snapshot ?? null });
      return backups.restoreLive(req.params.slug, req.body?.snapshot || null, req.body?.dest || null);
    });
    // Some notes or notebooks back into a running tenant: open a snapshot (names and titles only), then restore.
    admin.post('/api/admin/backups/:slug/items', async (req) => {
      auth.requireConfirmed(req);
      return backups.openItems(req.params.slug, req.body?.snapshot || null, req.body?.dest || null);
    });
    admin.post('/api/admin/backups/items/:token/restore', async (req) => {
      auth.requireConfirmed(req);
      const b = req.body ?? {};
      const r = backups.restoreItems(req.params.token, { notes: Array.isArray(b.notes) ? b.notes : [], notebooks: Array.isArray(b.notebooks) ? b.notebooks : [] });
      auth.logEvent('tenant-restore-notes', req, { slug: String(b.slug ?? ''), notes: (b.notes ?? []).length, notebooks: (b.notebooks ?? []).length });
      return r;
    });
    admin.delete('/api/admin/backups/items/:token', async (req) => {
      backups.closeItemSession(req.params.token);
      return { ok: true };
    });
    // Restoring from a backup file (Download a backup in Selah): upload it (streamed to disk), then restore it.
    admin.register(async (up) => {
      up.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
      up.put('/api/admin/backups/:slug/upload', async (req) => backups.saveUpload(req.params.slug, req.body));
    });
    admin.post('/api/admin/backups/:slug/restore-file', async (req) => {
      auth.requireConfirmed(req);
      const { slug } = req.params;
      if (String(req.body?.confirm ?? '') !== slug) throw httpError(400, `Type ${slug} to confirm.`);
      const file = backups.uploadPath(slug, req.body?.upload);
      const passphrase = req.body?.passphrase ? String(req.body.passphrase) : null;
      if (backupKind(file) === 'encrypted') {
        if (!passphrase) throw httpError(400, 'This backup is encrypted. Enter its passphrase.');
        if (!await passphraseFits(file, passphrase)) throw httpError(400, 'That’s not the passphrase this backup was made with.');
      }
      auth.logEvent('tenant-restore', req, { slug, source: 'file' });
      return { jobId: backups.restoreFromFile(slug, file, passphrase, { remove: true }).jobId };
    });

    // ---------- updates ----------
    admin.get('/api/admin/releases', async () => ({
      repoVersion: repoVersion(), current: currentRelease(), beta: betaRelease(), releases: listReleases(), running: updateRunning() ?? demoResetRunning(),
      tenants: listTenants().map((t) => ({ slug: t.slug, status: t.status, release: t.release, previousRelease: t.previousRelease, version: releaseVersion(t.release), running: t.health?.version ?? null })),
      docker: cloud().runner === 'docker' ? await dockerAvailable() : null,
    }));
    // Body: { channel: 'beta' (default) | 'main' }.
    admin.post('/api/admin/releases/prepare', async (req) => {
      const r = prepareRelease({ channel: req.body?.channel === 'main' ? 'main' : 'beta' });
      auth.logEvent('release-prepared', req, { release: r.release, channel: req.body?.channel === 'main' ? 'main' : 'beta' });
      return r;
    });
    admin.post('/api/admin/releases/promote', async (req) => {
      const r = promoteRelease(req.body?.release ? String(req.body.release) : undefined);
      auth.logEvent('release-promoted', req, { release: r.release, from: r.from });
      return r;
    });
    admin.post('/api/admin/releases/update', async (req) => {
      if (demoResetRunning()) throw httpError(409, 'The demo is being reset. Try again when it’s finished.');
      return rollingUpdate({
        release: req.body?.release ?? currentRelease(), slugs: Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : null,
      });
    });
    // Body (optional): { slugs } to roll several back, one at a time.
    admin.post('/api/admin/releases/rollback', async (req) => {
      const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : [];
      if (!slugs.length) throw httpError(400, 'Choose the tenants to roll back.');
      return rollBack(slugs);
    });
    admin.post('/api/admin/tenants/:slug/rollback', async (req) => rollBack([req.params.slug]));

    // ---------- the demo tenant ----------
    admin.post('/api/admin/demo/reset', async (req) => {
      if (String(req.body?.confirm ?? '') !== DEMO_SLUG) throw httpError(400, `Type ${DEMO_SLUG} to confirm.`);
      const r = resetDemo();
      auth.logEvent('demo-reset', req, {});
      return r;
    });

    // ---------- settings ----------
    admin.get('/api/admin/settings', async () => ({
      cloud: cloud(), allowed: allowedRanges(), privateRanges: PRIVATE_RANGES, yourIp: null, defaults: DEFAULT_LIMITS, ranges: LIMIT_RANGES,
      paths: { root: paths.root, code: repoRoot },
    }));
    admin.get('/api/admin/whoami', async (req) => ({ ip: req.ip }));
    admin.put('/api/admin/settings/allow-ips', async (req) => {
      auth.requireConfirmed(req);
      const list = [...new Set((Array.isArray(req.body?.allowIps) ? req.body.allowIps : []).map(cleanRange))];
      // Never lock out the address making the change.
      if (list.length) {
        const bl = new net.BlockList();
        for (const r of list) { const [ip, bits] = r.split('/'); bl.addSubnet(ip, Number(bits), net.isIPv6(ip) ? 'ipv6' : 'ipv4'); }
        const ip = req.ip.replace(/^::ffff:/, '');
        if (!bl.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')) throw httpError(400, `Your address (${ip}) isn’t in that list, so saving it would lock you out. Add it first.`);
      }
      saveCloud({ allowIps: list });
      const g = await pushGateway();
      auth.logEvent('allow-ips-changed', req, { count: list.length });
      return { allowIps: list, gateway: g };
    });
    admin.put('/api/admin/settings/limits', async (req) => {
      const limits = cleanLimits(req.body?.limits ?? {}, DEFAULT_LIMITS);
      saveCloud({ limits });
      return { limits };
    });
    admin.put('/api/admin/settings/time-zone', async (req) => {
      const tz = String(req.body?.timeZone ?? '');
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw httpError(400, 'Unknown time zone.'); }
      saveCloud({ timeZone: tz });
      return { timeZone: tz };
    });
    admin.post('/api/admin/gateway/reload', async () => pushGateway());

    // ---------- docs ----------
    admin.get('/api/admin/docs/changelog', async () => ({ markdown: fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8') }));
    admin.get('/api/admin/docs/admin-changelog', async () => ({ markdown: fs.readFileSync(path.join(repoRoot, 'ADMIN-CHANGELOG.md'), 'utf8') }));
    admin.get('/api/admin/docs/maintenance', async () => {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const places = { APP: repoRoot, DATA: path.join(repoRoot, 'data'), NOTES: path.join(repoRoot, 'notes-data'), PORT: 8443, SERVER: os.hostname(), CLOUD: paths.root };
      const html = fs.readFileSync(path.join(repoRoot, 'server', 'guide', 'maintenance-guide.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in places ? esc(places[k]) : m));
      return { html };
    });
    admin.get('/api/admin/docs/disaster-recovery', async () => ({ markdown: fs.readFileSync(path.join(repoRoot, 'DISASTER-RECOVERY.md'), 'utf8') }));
    admin.get('/api/admin/docs/maintenance-procedure', async () => ({ markdown: fs.readFileSync(path.join(repoRoot, 'MAINTENANCE-PROCEDURE.md'), 'utf8') }));
    admin.get('/api/admin/dependencies', async (req) => (await import('./dependencies.js')).dependencies({ fresh: !!req.query.fresh }));
  });
}
