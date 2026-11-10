import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import QRCode from 'qrcode';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import * as auth from './auth.js';
import { freshRecoveryCodes, saveTotp, twoFactorOn } from './security.js';
import { matchCode, newSecret, otpauthUri } from './totp.js';
import { checkIdentity, identity, saveIdentity } from './account.js';
import { nightlySlot, offsiteConfigured, offsiteState, runOffsite } from './offsite.js';
import { sharingControl, sharingHealth } from './sharing.js';
import { pushControl } from './push.js';

/**
 * A Selah that belongs to one invited person on a shared host (NOTEAPP_MODE=tenant), and the account features every
 * Selah has:
 * - setup links: a one-time link (made by the admin console) where the person chooses their username, email and
 *   password, and turns on two-step sign-in (recommended; since 10.0 it can wait), so the admin never knows the password;
 * - Settings → Account: storage used and delete my account (downloading everything is server/backupdownload.js);
 * - the storage quota, checked before uploads and imports;
 * - the control port: a second, private listener the admin console uses for health, the security log, setup links
 *   and backup status, with its own key (NOTEAPP_CONTROL_TOKEN), never reachable through Caddy;
 * - the nightly off-site backup, which a home server runs from a systemd timer, scheduled here instead.
 */

const httpError = (code, message, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const STARTED = Date.now();
const readJson = (key, fallback) => {
  try { return JSON.parse(getSetting(key) ?? 'null') ?? fallback; } catch { return fallback; }
};

// ---------- storage used ----------

function dirBytes(dir) {
  let bytes = 0;
  let count = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { bytes, count }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const d = dirBytes(p); bytes += d.bytes; count += d.count; }
    else if (e.isFile()) { try { bytes += fs.statSync(p).size; count++; } catch { /* just removed */ } }
  }
  return { bytes, count };
}

let usageCache = { at: 0, value: null };
/** Notes (the database) and attachments, in bytes; counted at most every 30 seconds. */
export function storageUsed({ fresh = false } = {}) {
  if (!fresh && usageCache.value && Date.now() - usageCache.at < 30_000) return usageCache.value;
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const dbBytes = size(config.dbPath) + size(`${config.dbPath}-wal`);
  const files = dirBytes(config.filesDir);
  const value = { bytes: dbBytes + files.bytes, db: dbBytes, files: files.bytes, fileCount: files.count, quota: config.quota || null };
  usageCache = { at: Date.now(), value };
  return value;
}

const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/**
 * With a quota, an upload or import that wouldn't fit is refused before it's read (registered on the app itself in
 * index.js). Browsers send the size with every upload, so Content-Length is enough to go on.
 */
export function quotaCheck(app) {
  if (!config.quota) return;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return;
    const len = Number(req.headers['content-length'] || 0);
    if (len < 256 * 1024) return;
    const used = storageUsed();
    if (used.bytes + len > config.quota) {
      return reply.code(413).send({
        error: `There isn’t room for this: ${mb(used.bytes)} of your ${mb(config.quota)} is used. Delete some attachments (Attachments page) or ask your Selah host for more space.`,
      });
    }
    usageCache.at = 0; // count again after it lands
  });
}

// ---------- setup links ----------

const SETUP_DAYS = 7;
/** The setup link waiting to be used, or null. Only its hash is kept. */
const setupLink = () => {
  const l = readJson('setup_link', null);
  return l && l.expires > Date.now() ? l : null;
};

/** A new one-time setup link token (replacing any earlier one); kind 'invite' or 'reset'. */
export function newSetupLink(kind = 'invite', days = SETUP_DAYS) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + Math.min(30, Math.max(1, days)) * 86400_000;
  setSetting('setup_link', JSON.stringify({ hash: sha256(token), kind, expires, createdAt: Date.now() }));
  auth.logEvent('setup-link', null, { kind, from: 'admin' });
  return { token, expires };
}

/** The link's record if `token` is the current one; logs and refuses otherwise (counts toward the lockout). */
function checkToken(req) {
  auth.checkAttempts(req);
  const l = setupLink();
  const token = String(req.body?.token ?? '');
  const ok = l && token && crypto.timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(l.hash));
  if (!ok) {
    auth.logEvent('setup-failed', req);
    throw httpError(404, 'This setup link has expired or was already used. Ask your Selah host for a new one.');
  }
  return l;
}

// Authenticator secrets shown during setup, not yet confirmed: link hash -> { secret, expires }.
const pendingSecrets = new Map();

// ---------- account deletion ----------

export const deletionRequested = () => readJson('account_deletion', null);

// ---------- status (Settings → Account, and the admin console's health check) ----------

const hostBackup = () => readJson('host_backup', null);

function health() {
  const lastSignIn = db.prepare("SELECT at FROM security_log WHERE kind = 'sign-in' ORDER BY id DESC LIMIT 1").get()?.at ?? null;
  const lastSeen = db.prepare('SELECT MAX(COALESCE(last_seen_at, created_at)) AS at FROM sessions').get()?.at ?? null;
  const off = offsiteState();
  return {
    ok: true,
    version: VERSION,
    tenant: config.tenant,
    startedAt: STARTED,
    passwordSet: auth.passwordIsSet(),
    twoFactor: twoFactorOn(),
    // 10.0: the username and email the person signs in with (the console shows them, so the host knows who to reach).
    signIn: identity() ? { username: identity().username, email: identity().email } : null,
    setupPending: setupLink() ? { kind: setupLink().kind, expires: setupLink().expires } : null,
    notes: db.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n,
    storage: storageUsed(),
    lastSignIn,
    lastActive: Math.max(lastSignIn ?? 0, lastSeen ?? 0) || null,
    sessions: db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now()).n,
    offsite: { configured: off.configured, account: off.account, service: off.service, lastSuccessAt: off.lastSuccess?.finishedAt ?? null, lastError: off.last && !off.last.ok ? off.last.error : null },
    hostBackup: hostBackup(),
    lastDownload: readJson('backup_download', null)?.at ?? null,
    deletion: deletionRequested(),
    noticeAt: readJson('user_notice', null)?.updatedAt ?? 0,
    sharing: sharingHealth(),
  };
}

// ---------- the control port ----------

async function controlServer(log, mainApp) {
  if (!config.controlPort || !config.controlToken) return;
  const key = Buffer.from(sha256(config.controlToken));
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook('onRequest', async (req, reply) => {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!given || !crypto.timingSafeEqual(Buffer.from(sha256(given)), key)) return reply.code(401).send({ error: 'Not allowed' });
  });
  app.setErrorHandler((err, req, reply) => reply.code(err.statusCode ?? 500).send({ error: err.message }));

  app.get('/control/health', async () => health());

  // New lines of the security log since `after` (the admin console keeps its own copy for the all-tenants view).
  app.get('/control/security-log', async (req) => {
    const after = Number(req.query.after) || 0;
    const limit = Math.min(1000, Number(req.query.limit) || 500);
    return db.prepare('SELECT id, at, kind, ip, device, detail FROM security_log WHERE id > ? ORDER BY id LIMIT ?').all(after, limit);
  });

  app.post('/control/setup-link', async (req) => {
    const kind = req.body?.kind === 'reset' ? 'reset' : 'invite';
    return newSetupLink(kind, Number(req.body?.days) || SETUP_DAYS);
  });

  app.delete('/control/setup-link', async () => {
    setSetting('setup_link', 'null');
    return { ok: true };
  });

  // The maintenance banner for users, from the console (server/admin/notice.js); /api/notice shows it.
  app.post('/control/notice', async (req) => {
    const b = req.body ?? {};
    const t = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
    setSetting('user_notice', JSON.stringify({ on: !!b.on, start: t(b.start), end: t(b.end), showFrom: t(b.showFrom),
      message: String(b.message ?? '').slice(0, 300), updatedAt: t(b.updatedAt) ?? Date.now() }));
    return { ok: true };
  });

  // Sharing between tenants (8.0): the console reads the outbox and delivers messages here (server/sharing.js).
  sharingControl(app);
  // Push to the apps (13.0): the console sends what's queued with the host's keys (server/push.js).
  pushControl(app);

  app.post('/control/sign-out-all', async () => {
    const n = db.prepare('DELETE FROM sessions').run().changes;
    auth.logEvent('sessions-revoked', null, { count: n, from: 'admin' });
    return { count: n };
  });

  // After each nightly host backup, so the person's dashboard can say they're covered.
  app.post('/control/host-backup', async (req) => {
    const b = req.body ?? {};
    setSetting('host_backup', JSON.stringify({ at: Number(b.at) || Date.now(), ok: !!b.ok, snapshot: b.snapshot ?? null, error: b.ok ? null : String(b.error ?? '').slice(0, 300) }));
    return { ok: true };
  });

  // Notes or notebooks from the host backup (the admin console's Restore notes…): the console puts a note package
  // and its attachments in restore-points/incoming/<id>/, and they're added here as copies. The console never sees
  // more than titles; this is what reads the notes.
  app.post('/control/import-package', async (req) => {
    const id = String(req.body?.id ?? '');
    if (!/^[\w-]{8,64}$/.test(id)) throw httpError(400, 'Bad package');
    const dir = path.join(config.restoreDir, 'incoming', id);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const { importPackage } = await import('./notepack.js');
      const at = Number(req.body?.at) || Date.now();
      const label = `restored ${new Date(at).toLocaleDateString('en-US', { timeZone: config.timeZone, month: 'short', day: 'numeric' })}`;
      const r = await importPackage(pkg, { resolveFile: (s) => path.join(dir, 'files', s), label, sameAccount: true });
      auth.logEvent('notes-restored', null, { from: 'host', at, notes: r.notes, notebooks: r.notebooks.length });
      return r;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The demo tenant's Reset (server/admin/demo.js): on the empty database the console just started it on, the sign-in
  // it kept goes back and the sample data is added (server/demo/seed.js). Body: { settings, sessions }.
  app.post('/control/demo-seed', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    if (config.tenant !== 'demo') throw httpError(403, 'Only the demo tenant has sample data.');
    const { seedDemo } = await import('./demo/seed.js');
    const r = await seedDemo(mainApp, req.body ?? {});
    auth.logEvent('demo-reset', null, { from: 'admin' });
    return r;
  });

  // The smoke test after a beta goes out (scripts/smoke.mjs, through npm run admin -- demo-session): a sign-in for
  // the demo only, good for an hour, so the test never needs the demo's password. The test signs out when it's done.
  app.post('/control/demo-session', async () => {
    if (config.tenant !== 'demo') throw httpError(403, 'Only the demo tenant has a test sign-in.');
    const s = auth.createSession({ ip: '127.0.0.1', headers: { 'user-agent': 'Selah smoke test' } }, { twoFactor: true, app: 'smoke-test' });
    const expires = Date.now() + 3_600_000;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expires, sha256(s.token));
    auth.logEvent('smoke-test-session', null, { from: 'admin' });
    return { token: s.token, expires };
  });

  // What was ticked off and noted while trying betas (server/betareview.js).
  app.get('/control/beta-review', async () => {
    const { betaReviews } = await import('./betareview.js');
    return { reviews: betaReviews() };
  });

  await app.listen({ host: config.controlHost, port: config.controlPort });
  log.info(`Control port listening on ${config.controlHost}:${config.controlPort}`);
}

// ---------- nightly off-site backup (tenant mode) ----------

function scheduleBackups(log) {
  const slot = nightlySlot();
  const tick = async () => {
    if (!offsiteConfigured()) return;
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const last = Number(getSetting('offsite_nightly_at') ?? 0);
    if (minutes < slot || Date.now() - last < 20 * 3_600_000) return;
    setSetting('offsite_nightly_at', String(Date.now()));
    try {
      const run = await runOffsite({ trigger: 'nightly' });
      if (!run.ok) log.warn(`Nightly off-site backup failed: ${run.error}`);
    } catch (e) {
      log.warn(`Nightly off-site backup skipped: ${e.message}`);
    }
  };
  setInterval(() => tick().catch(() => {}), 5 * 60_000).unref();
}

// ---------- routes ----------

export default async function tenant(app) {
  if (config.mode === 'tenant') {
    app.post('/api/setup/check', async (req) => {
      const l = checkToken(req);
      const who = identity();
      return { kind: l.kind, tenant: config.tenant, name: process.env.NOTEAPP_TENANT_NAME || null, minPassword: auth.MIN_PASSWORD, expires: l.expires,
        username: who?.username ?? '', email: who?.email ?? '' };
    });

    app.post('/api/setup/two-step', async (req) => {
      const l = checkToken(req);
      const secret = newSecret();
      pendingSecrets.set(l.hash, { secret, expires: Date.now() + 30 * 60_000 });
      const account = String(req.headers.host ?? 'Selah').split(':')[0];
      const uri = otpauthUri(secret, account);
      const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr };
    });

    app.post('/api/setup/finish', async (req, reply) => {
      const l = checkToken(req);
      const who = checkIdentity(req.body);
      const password = String(req.body?.password ?? '');
      const problem = await auth.passwordProblem(password);
      if (problem) throw httpError(400, problem);
      // Two-step sign-in is recommended; "Skip for now" leaves it for Settings → Security (10.0).
      const skip = !!req.body?.skipTwoStep;
      let step = null;
      let secret = null;
      if (!skip) {
        const p = pendingSecrets.get(l.hash);
        if (!p || p.expires < Date.now()) throw httpError(400, 'Setting up the authenticator app took too long. Scan the new code.', { restart: true });
        step = matchCode(p.secret, req.body?.code);
        if (step == null) {
          auth.logEvent('setup-failed', req, { code: true });
          throw httpError(400, 'That code isn’t right. Check that the phone’s clock is right and try the newest code.');
        }
        secret = p.secret;
      }
      pendingSecrets.delete(l.hash);
      setSetting('setup_link', 'null');
      saveIdentity(who);
      setSetting('account_identity_asked', String(Date.now()));
      await auth.setPassword(password); // also signs out every device
      // A reset that skips the authenticator turns off the old one (that's usually why it was reset: a lost phone).
      if (skip) { saveTotp(null); setSetting('recovery_codes', '[]'); }
      else saveTotp({ secret, since: Date.now(), lastStep: step });
      const codes = skip ? null : freshRecoveryCodes();
      const s = auth.createSession(req, { twoFactor: !skip, app: ['windows', 'installed', 'mobile'].includes(req.body?.app) ? req.body.app : '' });
      reply.setCookie(auth.COOKIE, s.token, auth.cookieOptions(s.expires));
      auth.logEvent(l.kind === 'reset' ? 'setup-reset' : 'setup-done', req, skip ? { twoStep: false } : null);
      return { codes };
    });

    app.post('/api/account/delete', async (req, reply) => {
      auth.requireConfirmed(req);
      if (String(req.body?.confirm ?? '').trim().toLowerCase() !== String(config.tenant).toLowerCase()) {
        throw httpError(400, `Type ${config.tenant} to confirm.`);
      }
      setSetting('account_deletion', JSON.stringify({ at: Date.now() }));
      auth.logEvent('account-deletion', req);
      db.prepare('DELETE FROM sessions').run();
      reply.clearCookie(auth.COOKIE, { path: '/' });
      return { ok: true };
    });
  }

  app.get('/api/account', async () => ({
    mode: config.mode,
    tenant: config.tenant,
    storage: storageUsed({ fresh: true }),
    hostBackup: config.mode === 'tenant' ? hostBackup() : null,
    nightlySlot: config.mode === 'tenant' ? nightlySlot() : null,
  }));
}

/** Tenant mode: the control port and the nightly backup (called once the server is listening). */
export async function startTenant(log, app) {
  if (config.mode !== 'tenant') return;
  await controlServer(log, app);
  scheduleBackups(log);
}
