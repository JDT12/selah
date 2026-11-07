import fs from 'node:fs';
import { db, getSetting, setSetting } from '../db.js';
import { alert, cloud, listTenants, publicTls, saveHealth, updateTenant } from './store.js';
import { paths } from './paths.js';
import { runner } from './runner.js';
import { control } from './control.js';
import { certificateInfo, gatewayStatus, pushGateway } from './gateway.js';
import { deleteTenant, emptyTrash } from './lifecycle.js';
import { backupRunning, configured as backupConfigured, runHostBackups } from './backups.js';
import { updateRunning } from './releases.js';
import { demoResetRunning } from './demo.js';
import { checkMaintenance } from './maintenance.js';
import { getNotice, pushNotice } from './notice.js';
import { pushSharingState, sharingOff } from './sharing.js';
import { holdingTenants, leaveMaintenance, maintenanceMode } from './maintenancemode.js';

/**
 * Once a minute: each tenant's health (restarting one that stopped), new lines from each tenant's security log
 * (copied here for the all-tenants view) and the alerts they call for, deletions people asked for, disk space, the
 * certificate, the gateway, the nightly host backup, and the monthly server maintenance and the server's patches.
 */

const MINUTE = 60_000;
const EVERY = Number(process.env.NOTEAPP_MONITOR_MS || MINUTE);
const FAILS = new Set(['sign-in-failed', 'code-failed', 'confirm-failed', 'setup-failed']);
let lastRun = { at: 0, ms: 0 };
export const monitorState = () => ({ ...lastRun, every: EVERY });

async function syncLog(t) {
  let rows;
  try {
    rows = await control(t, 'GET', `/control/security-log?after=${t.logCursor}&limit=1000`);
  } catch { return; }
  if (!rows.length) return;
  const insert = db.prepare('INSERT OR IGNORE INTO tenant_events (slug, source_id, at, kind, ip, device, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(t.slug, r.id, r.at, r.kind, r.ip, r.device, r.detail);
  updateTenant(t.slug, { logCursor: rows.at(-1).id });

  // Alerts from what just came in.
  const since = Date.now() - 15 * MINUTE;
  const fails = db.prepare(`SELECT COUNT(*) AS n FROM tenant_events WHERE slug = ? AND at > ? AND kind IN (${[...FAILS].map(() => '?').join(', ')})`).get(t.slug, since, ...FAILS).n;
  if (fails >= 5) alert(t.slug, 'warning', 'failed-sign-ins', `${fails} failed sign-in attempts on ${t.slug} in the last 15 minutes.`);
  for (const r of rows) {
    if (r.kind === 'locked') alert(t.slug, 'danger', 'locked', `${t.slug} locked out sign-ins from ${r.ip ?? 'an address'} after too many failed attempts.`);
    if (r.kind === 'rate-limited') alert(t.slug, 'warning', 'rate-limited', `${t.slug} slowed down ${r.ip ?? 'an address'} sending too many requests.`);
    if (r.kind === 'blocked-origin') alert(t.slug, 'warning', 'blocked-origin', `${t.slug} blocked a request from another site (${r.ip ?? 'unknown address'}).`);
    if (r.kind === 'sign-in' && r.device) {
      // A device that hasn't signed in to this tenant in 90 days.
      const seen = db.prepare("SELECT 1 FROM tenant_events WHERE slug = ? AND kind = 'sign-in' AND device = ? AND at < ? AND at > ? LIMIT 1")
        .get(t.slug, r.device, r.at, r.at - 90 * 86400_000);
      if (!seen) alert(t.slug, 'info', `new-device:${r.device}`, `${t.slug} signed in from a new device: ${r.device} (${r.ip ?? 'unknown address'}).`, { quiet: 86400_000 });
    }
    if (r.kind === 'two-step-off') alert(t.slug, 'warning', 'two-step-off', `Two-step sign-in was turned off on ${t.slug}.`);
  }
}

async function checkTenant(t) {
  if (t.status !== 'active') return;
  let h = null;
  try {
    h = await control(t, 'GET', '/control/health', undefined, { timeout: 5000 });
  } catch (e) {
    // Not answering: is it running at all?
    const state = await runner().status(t);
    if (state !== 'active' && state !== 'activating' && !updateRunning() && !backupRunning() && !holdingTenants() && !demoResetRunning()) {
      alert(t.slug, 'danger', 'down', `${t.slug} had stopped (${state}); it was started again.`);
      await runner().start(t).catch((err) => alert(t.slug, 'danger', 'start-failed', `${t.slug} couldn’t be started: ${err.message}`));
    }
    saveHealth(t.slug, { ...(t.health ?? {}), ok: false, error: e.message, state });
    return;
  }
  saveHealth(t.slug, h);
  // The users' maintenance notice, to a tenant that hasn't got the latest (restarted, or new).
  const notice = getNotice();
  if ((h.noticeAt ?? 0) !== notice.updatedAt) await pushNotice(t, notice).catch(() => {});
  // Sharing switched off (or on) here while it was down, or before it ran 8.0.
  if (h.sharing && h.sharing.on === sharingOff().has(t.slug)) await pushSharingState(t).catch(() => {});
  if (h.deletion) {
    await deleteTenant(t.slug, 'requested');
    return;
  }
  const q = h.storage?.quota;
  if (q && h.storage.bytes > q * 0.9) alert(t.slug, 'warning', 'storage', `${t.slug} has used ${Math.round((h.storage.bytes / q) * 100)}% of its storage.`, { quiet: 86400_000 });
  await syncLog(t);
}

async function checkServer() {
  try {
    const s = fs.statfsSync(paths.root);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    if (free < 5e9 || free / total < 0.1) alert(null, 'danger', 'disk', `Only ${(free / 1e9).toFixed(1)} GB free on the tenants' disk.`, { quiet: 6 * 3_600_000 });
  } catch { /* not there */ }
  const cert = await certificateInfo();
  if (cert && cert.validTo - Date.now() < 21 * 86400_000) {
    // Caddy renews a Let's Encrypt certificate 30 days ahead, so this close it has been failing.
    const fix = publicTls() ? 'The gateway renews it itself and hasn’t managed to; see its log: journalctl --user -u selah-gateway' : 'Renew it: npm run admin -- cert';
    alert(null, 'danger', 'certificate', `The certificate expires on ${new Date(cert.validTo).toDateString()}. ${fix}`, { quiet: 86400_000 });
  }
}

async function checkGateway() {
  const g = await gatewayStatus();
  if (!g.running) {
    alert(null, 'danger', 'gateway', `The gateway (Caddy) isn’t running, so nobody can reach Selah: ${g.error}`, { quiet: 3_600_000 });
    return;
  }
  // After Caddy restarts it loads its config file, but load it again once in case the file was older.
  if (getSetting('gateway_loaded') !== 'yes') {
    const r = await pushGateway();
    if (r.loaded) setSetting('gateway_loaded', 'yes');
  }
}

function backupDue() {
  if (!backupConfigured() || backupRunning() || holdingTenants()) return false;
  const [hh, mm] = String(cloud().backupTime).split(':').map(Number);
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const last = Number(getSetting('host_backup_nightly_at') ?? 0);
  return minutes >= hh * 60 + mm && Date.now() - last > 20 * 3_600_000;
}

async function tick() {
  const started = Date.now();
  for (const t of listTenants()) {
    await checkTenant(t).catch((e) => alert(t.slug, 'warning', 'monitor', `Checking ${t.slug} failed: ${e.message}`));
  }
  await checkServer().catch(() => {});
  await checkGateway().catch(() => {});
  await checkMaintenance().catch(() => {});
  emptyTrash();
  db.prepare('DELETE FROM tenant_events WHERE at < ?').run(Date.now() - 365 * 86400_000);
  db.prepare('DELETE FROM alerts WHERE at < ? AND seen_at IS NOT NULL').run(Date.now() - 180 * 86400_000);
  if (backupDue()) {
    setSetting('host_backup_nightly_at', String(Date.now()));
    try { runHostBackups({ trigger: 'nightly' }); } catch (e) { alert(null, 'danger', 'backup-failed', `The nightly host backup didn’t start: ${e.message}`); }
  }
  lastRun = { at: Date.now(), ms: Date.now() - started };
}

/** Starts the minute-by-minute checks, first making sure every active tenant is running (e.g. after a reboot). */
export function startMonitor(log) {
  setSetting('gateway_loaded', 'no');
  // Maintenance mode from before a reboot is over: start everything as usual. In the same boot, leave tenants stopped.
  const mm = maintenanceMode();
  if (mm && !mm.sameBoot) {
    leaveMaintenance();
    log.info('The server rebooted during maintenance: starting every tenant');
  }
  (async () => {
    for (const t of holdingTenants() ? [] : listTenants().filter((x) => x.status === 'active')) {
      const state = await runner().status(t);
      if (state !== 'active' && state !== 'activating') {
        await runner().start(t).catch((e) => alert(t.slug, 'danger', 'start-failed', `${t.slug} couldn’t be started: ${e.message}`));
      }
    }
    await pushGateway().catch((e) => log.warn(`Gateway config: ${e.message}`));
  })().catch((e) => log.error(e));
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick().catch((e) => log.error(e)).finally(() => { ticking = false; });
  }, EVERY).unref();
}

export const runMonitorNow = () => tick();
