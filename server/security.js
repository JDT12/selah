import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, getSetting, setSetting } from './db.js';
import * as auth from './auth.js';
import { encrypt, decrypt } from './secrets.js';
import { hashRecovery, matchCode, newRecoveryCodes, newSecret, normalizeRecovery, otpauthUri } from './totp.js';
import { clipToken, CLIP_PATHS } from './capture.js';
import { config } from './config.js';
import { identity, isMe } from './account.js';

/**
 * Signing in and keeping it safe: the password and two-step sign-in (an authenticator app's codes, plus recovery
 * codes), signed-in devices, the security log, and the request checks every API call goes through (same-origin
 * changes, rate limits).
 */
const httpError = (code, message, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};

// ---------- two-step sign-in ----------

function totpState() {
  try {
    const t = JSON.parse(getSetting('totp') ?? 'null');
    return t?.secret ? { ...t, secret: decrypt(t.secret) } : null;
  } catch { return null; }
}
export const saveTotp = (t) => setSetting('totp', t ? JSON.stringify({ ...t, secret: encrypt(t.secret) }) : 'null');
const recoveryCodes = () => { try { return JSON.parse(getSetting('recovery_codes') ?? '[]') ?? []; } catch { return []; } };
const recoveryLeft = () => recoveryCodes().filter((c) => !c.used).length;
export const twoFactorOn = () => !!totpState();

/** Makes and stores a fresh set of recovery codes (only their hashes are kept); returns the codes to show once. */
export function freshRecoveryCodes() {
  const codes = newRecoveryCodes();
  setSetting('recovery_codes', JSON.stringify(codes.map((c) => ({ h: hashRecovery(c), used: null }))));
  return codes;
}

/** Checks an authenticator code (or, with `recovery`, a recovery code, which is then used up). */
function checkSecondFactor(code, { recovery = false } = {}) {
  if (recovery) {
    const h = hashRecovery(code);
    if (normalizeRecovery(code).length !== 10) return null;
    const codes = recoveryCodes();
    const hit = codes.find((c) => !c.used && crypto.timingSafeEqual(Buffer.from(c.h), Buffer.from(h)));
    if (!hit) return null;
    hit.used = Date.now();
    setSetting('recovery_codes', JSON.stringify(codes));
    return 'recovery';
  }
  const t = totpState();
  if (!t) return null;
  const step = matchCode(t.secret, code, t.lastStep ?? 0);
  if (step == null) return null;
  saveTotp({ ...t, lastStep: step });
  return 'code';
}

// Password accepted, code still to come: ticket -> { expires, tries, ip, app }. Kept in memory; 5 minutes, 5 tries.
const tickets = new Map();
const newTicket = (req, app) => {
  for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { expires: Date.now() + 5 * 60_000, tries: 0, ip: req.ip, app });
  return ticket;
};

// Secrets being set up but not yet confirmed with a code: session id -> { secret, expires }.
const pendingSetup = new Map();

// ---------- request checks ----------

// Requests per address per minute: any API call, and ones that end "not signed in". Generous for one person's
// devices, small for anyone hammering the server.
const LIMIT = Number(process.env.NOTEAPP_RATE_LIMIT || 2400);
const LIMIT_UNAUTHORIZED = 60;
const hits = new Map(); // ip -> { n, bad, reset, logged }
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
}, 60_000).unref();
const hitsFor = (ip) => {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) hits.set(ip, (h = { n: 0, bad: 0, reset: now + 60_000, logged: false, originLogged: false }));
  return h;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a state-changing request came from Selah's own pages. Browsers send Origin with every POST/PUT/PATCH/
 * DELETE (and Sec-Fetch-Site); a page on another site, including another subdomain of the same domain, is refused even
 * though SameSite cookies would let it through.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try { return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase(); } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

const PUBLIC_API = new Set(['/api/session', '/api/login', '/api/login/code', '/api/clip/pair',
  // A tenant's one-time setup link (server/tenant.js): choosing a password and turning on two-step sign-in.
  '/api/setup/check', '/api/setup/two-step', '/api/setup/finish']);

const desktopKeyBuf = config.desktopKey ? Buffer.from(config.desktopKey) : null;
const desktopKeyOk = (v) => {
  if (!desktopKeyBuf || typeof v !== 'string') return false;
  const b = Buffer.from(v);
  return b.length === desktopKeyBuf.length && crypto.timingSafeEqual(b, desktopKeyBuf);
};
// The one person at their own PC: always "confirmed", with no session row (id null, so live updates never end it).
const DESKTOP_SESSION = () => ({ id: null, app: 'windows', two_factor: 1, confirmed_at: Date.now(), created_at: 0, expires_at: Infinity });

/** Tenant mode: the account is being deleted (Settings → Account), so nobody signs in again. */
const closing = () => config.mode === 'tenant' && !!getSetting('account_deletion');

/** The checks every request goes through (registered on the app itself in index.js). */
export function requestChecks(app) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    const h = hitsFor(req.ip);
    h.n++;
    if (h.n > LIMIT || h.bad > LIMIT_UNAUTHORIZED) {
      if (!h.logged) { h.logged = true; auth.logEvent('rate-limited', req, { path: url }); }
      reply.header('Retry-After', Math.ceil((h.reset - Date.now()) / 1000));
      return reply.code(429).send({ error: 'Too many requests. Wait a minute and try again.' });
    }

    const clipper = CLIP_PATHS.has(url) && /^Bearer /.test(req.headers.authorization ?? '');
    if (!SAFE_METHODS.has(req.method) && !clipper && url !== '/api/clip/pair' && !sameOrigin(req)) {
      // Logged once a minute per address, so a flood can't push real entries out of the log.
      if (!h.originLogged) { h.originLogged = true; auth.logEvent('blocked-origin', req, { path: url, origin: req.headers.origin ?? req.headers['sec-fetch-site'] ?? null }); }
      return reply.code(403).send({ error: 'Request blocked: it didn’t come from Selah.' });
    }

    // Selah Desktop: the app's own windows carry this launch's key; there's no sign-in. Anything else is refused,
    // including the clipper's routes (the clipper isn't paired with a desktop library).
    if (config.edition === 'desktop') {
      if (!desktopKeyOk(req.headers['x-selah-desktop'])) {
        h.bad++;
        return reply.code(401).send({ error: 'Not signed in' });
      }
      req.session = DESKTOP_SESSION();
      return;
    }

    let token = req.cookies[auth.COOKIE];
    let session = auth.sessionFor(token);
    // A session from before 5.13 moves to the __Host- cookie.
    if (!session && req.cookies[auth.OLD_COOKIE]) {
      token = req.cookies[auth.OLD_COOKIE];
      session = auth.sessionFor(token);
      if (session) reply.setCookie(auth.COOKIE, token, auth.cookieOptions(new Date(session.expires_at)));
      reply.clearCookie(auth.OLD_COOKIE, { path: '/' });
    }
    if (session) {
      auth.touchSession(session, req);
      req.session = session;
      req.sessionToken = token;
      return;
    }
    // The Edge clipper uses its own key, good only for adding clips (see capture.js).
    if (PUBLIC_API.has(url) || (clipper && clipToken(req))) return;
    h.bad++;
    return reply.code(401).send({ error: 'Not signed in' });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.url.split('?')[0];
    if (url === '/api/session' || url.startsWith('/api/login') || url.startsWith('/api/security')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

// ---------- routes ----------

const setSessionCookie = (reply, { token, expires }) => reply.setCookie(auth.COOKIE, token, auth.cookieOptions(expires));
const appKind = (v) => (['windows', 'installed'].includes(v) ? v : '');

function signedIn(req, reply, { twoFactor, app, method }) {
  setSessionCookie(reply, auth.createSession(req, { twoFactor, app }));
  auth.logEvent('sign-in', { ip: req.ip, headers: req.headers, session: { app } }, method === 'recovery' ? { method, left: recoveryLeft() } : null);
  const out = { ok: true, failed: auth.failuresSinceLastSignIn() };
  if (method === 'recovery') out.recoveryLeft = recoveryLeft();
  return out;
}

// Selah Desktop has no sign-in, so nothing to sign in with, change or log (a PIN or Windows Hello lock is the app's).
const SIGN_IN_ROUTES = /^\/api\/(login|logout|password|security|setup)(\/|$)/;

export default async function security(app) {
  if (config.edition === 'desktop') {
    app.addHook('onRequest', async (req, reply) => {
      if (SIGN_IN_ROUTES.test(req.url.split('?')[0])) return reply.code(404).send({ error: 'Not in Selah Desktop' });
    });
  }
  app.post('/api/login', async (req, reply) => {
    auth.checkAttempts(req);
    if (closing()) throw httpError(403, 'This account is being deleted.');
    if (!auth.passwordIsSet()) {
      throw httpError(400, config.mode === 'tenant' ? 'This Selah hasn’t been set up yet. Use the setup link you were sent.'
        : config.mode === 'admin' ? 'No password set. On the server, run: npm run admin -- set-password' : 'No password set. Run: npm run set-password');
    }
    // 10.0: with a username and email chosen, the first box must be one of them (checked after the password, so a
    // wrong name takes as long as a wrong password, and the answer doesn't say which was wrong).
    const ok = await auth.checkPassword(String(req.body?.password ?? ''));
    if (!ok || !isMe(req.body?.login)) {
      auth.logEvent('sign-in-failed', req);
      throw httpError(401, identity() ? 'That username or email and password don’t match.' : 'Incorrect password');
    }
    const kind = appKind(req.body?.app);
    if (twoFactorOn()) return { twoFactor: true, ticket: newTicket(req, kind) };
    return signedIn(req, reply, { twoFactor: false, app: kind });
  });

  app.post('/api/login/code', async (req, reply) => {
    auth.checkAttempts(req);
    const t = tickets.get(String(req.body?.ticket ?? ''));
    if (!t || t.expires < Date.now() || t.ip !== req.ip) throw httpError(401, 'That took too long. Enter your password again.', { restart: true });
    const recovery = !!req.body?.recovery;
    const method = checkSecondFactor(req.body?.code, { recovery });
    if (!method) {
      auth.logEvent('code-failed', req, recovery ? { recovery: true } : null);
      if (++t.tries >= 5) tickets.delete(req.body.ticket);
      throw httpError(401, recovery ? 'That recovery code isn’t right, or it was already used.' : 'That code isn’t right. Check your authenticator app and try the newest code.',
        t.tries >= 5 ? { restart: true } : {});
    }
    tickets.delete(req.body.ticket);
    return signedIn(req, reply, { twoFactor: true, app: t.app, method });
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.session) auth.logEvent('sign-out', req);
    auth.destroySession(req.sessionToken);
    reply.clearCookie(auth.COOKIE, { path: '/' });
    reply.clearCookie(auth.OLD_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Confirm it's you: password, and a code when two-step sign-in is on. Unlocks sensitive changes for 10 minutes. */
  app.post('/api/security/confirm', async (req) => {
    auth.checkAttempts(req);
    const okPassword = await auth.checkPassword(String(req.body?.password ?? ''));
    const okCode = !twoFactorOn() || (okPassword && checkSecondFactor(req.body?.code, { recovery: !!req.body?.recovery }));
    if (!okPassword || !okCode) {
      auth.logEvent('confirm-failed', req);
      throw httpError(401, okPassword ? 'That code isn’t right.' : 'Incorrect password');
    }
    auth.markConfirmed(req.session);
    return { ok: true };
  });

  app.post('/api/password', async (req, reply) => {
    auth.checkAttempts(req);
    const { current, next, code } = req.body ?? {};
    if (!(await auth.checkPassword(String(current ?? '')))) {
      auth.logEvent('confirm-failed', req);
      throw httpError(401, 'Current password is incorrect');
    }
    if (twoFactorOn() && !checkSecondFactor(code)) {
      auth.logEvent('confirm-failed', req);
      throw httpError(401, 'That code isn’t right. Check your authenticator app and try the newest code.');
    }
    const problem = await auth.passwordProblem(String(next ?? ''));
    if (problem) throw httpError(400, problem);
    const keep = { twoFactor: !!req.session.two_factor, app: req.session.app };
    await auth.setPassword(String(next));
    setSessionCookie(reply, auth.createSession(req, keep));
    auth.logEvent('password-changed', req);
    return { ok: true };
  });

  /** Everything on Settings → Security. */
  app.get('/api/security', async (req) => {
    const t = totpState();
    const sessions = db.prepare('SELECT rowid AS id, created_at, last_seen_at, ip, user_agent, app, two_factor FROM sessions WHERE expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC')
      .all(Date.now())
      .map((s) => ({ id: s.id, device: auth.deviceName(s.user_agent ?? '', s.app ?? ''), ip: s.ip, created_at: s.created_at,
        last_seen_at: s.last_seen_at ?? s.created_at, two_factor: !!s.two_factor, current: s.id === req.session.id }));
    const clippers = db.prepare('SELECT id, name, created_at, last_used_at FROM clip_tokens ORDER BY created_at DESC').all();
    const last = db.prepare("SELECT at, ip, device FROM security_log WHERE kind = 'sign-in' ORDER BY id DESC LIMIT 1 OFFSET 1").get() ?? null;
    return {
      twoFactor: { on: !!t, since: t?.since ?? null, recoveryLeft: t ? recoveryLeft() : 0 },
      settings: auth.securitySettings(), idleChoices: auth.IDLE_CHOICES, minPassword: auth.MIN_PASSWORD,
      sessions, clippers, lastSignIn: last,
      failedDay: db.prepare(`SELECT COUNT(*) AS n FROM security_log WHERE kind IN (${auth.FAIL_KINDS.map(() => '?').join(', ')}) AND at > ?`)
        .get(...auth.FAIL_KINDS, Date.now() - 86400_000).n,
    };
  });

  app.get('/api/security/log', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    return db.prepare('SELECT id, at, kind, ip, device, detail FROM security_log ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  });

  app.put('/api/security/settings', async (req) => {
    const idleDays = Number(req.body?.idleDays);
    if (!auth.IDLE_CHOICES.includes(idleDays)) throw httpError(400, 'Choose one of the listed times.');
    auth.saveSecuritySettings({ idleDays });
    auth.logEvent('settings-changed', req, { idleDays });
    return auth.securitySettings();
  });

  // Two-step sign-in: start (secret + QR code), then turn on with a code from the app.
  app.post('/api/security/two-step/start', async (req) => {
    auth.requireConfirmed(req);
    const secret = newSecret();
    pendingSetup.set(req.session.id, { secret, expires: Date.now() + 15 * 60_000 });
    const account = String(req.headers.host ?? 'Selah').split(':')[0];
    const uri = otpauthUri(secret, account);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr };
  });

  app.post('/api/security/two-step/enable', async (req, reply) => {
    auth.requireConfirmed(req);
    const p = pendingSetup.get(req.session.id);
    if (!p || p.expires < Date.now()) throw httpError(400, 'Setup timed out. Start again.');
    const step = matchCode(p.secret, req.body?.code);
    if (step == null) throw httpError(400, 'That code isn’t right. Check that the app’s clock is right and try the newest code.');
    pendingSetup.delete(req.session.id);
    saveTotp({ secret: p.secret, since: Date.now(), lastStep: step });
    const codes = freshRecoveryCodes();
    // Every other device signs in again, this time with a code; this one carries on.
    db.prepare('DELETE FROM sessions WHERE rowid != ?').run(req.session.id);
    db.prepare('UPDATE sessions SET two_factor = 1 WHERE rowid = ?').run(req.session.id);
    auth.logEvent('two-step-on', req);
    return { codes };
  });

  app.post('/api/security/two-step/disable', async (req) => {
    auth.requireConfirmed(req);
    // Recommended, not required, since 10.0; the admin console keeps it on (it can reach every Selah on the host).
    if (config.mode === 'admin') throw httpError(400, 'Two-step sign-in is required for the admin console. To move it to a new phone, set it up again.');
    saveTotp(null);
    setSetting('recovery_codes', '[]');
    auth.logEvent('two-step-off', req);
    return { ok: true };
  });

  app.post('/api/security/recovery-codes', async (req) => {
    auth.requireConfirmed(req);
    if (!twoFactorOn()) throw httpError(400, 'Two-step sign-in is off.');
    const codes = freshRecoveryCodes();
    auth.logEvent('recovery-codes-new', req);
    return { codes };
  });

  app.delete('/api/security/sessions/:id', async (req) => {
    const id = intParam(req.params.id);
    if (id === req.session.id) throw httpError(400, 'Use Sign out for this device.');
    const s = db.prepare('SELECT user_agent, app FROM sessions WHERE rowid = ?').get(id);
    if (!s) throw httpError(404, 'That device is already signed out.');
    db.prepare('DELETE FROM sessions WHERE rowid = ?').run(id);
    auth.logEvent('session-revoked', req, { device: auth.deviceName(s.user_agent ?? '', s.app ?? '') });
    return { ok: true };
  });

  app.post('/api/security/sessions/others', async (req) => {
    const n = db.prepare('DELETE FROM sessions WHERE rowid != ?').run(req.session.id).changes;
    auth.logEvent('sessions-revoked', req, { count: n });
    return { count: n };
  });
}
