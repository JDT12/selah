import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// __Host- cookies are tied to this exact host name (no Domain, Path=/, Secure): another site on the same parent
// domain can't set or read them. Sessions from before 5.13 used the old name and move over on their next request.
export const COOKIE = '__Host-selah_session';
export const OLD_COOKIE = 'noteapp_session';
export const cookieOptions = (expires) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'strict', expires });

const MINUTE = 60_000;
const DAY = 86400_000;
// How long ago a password (and code) confirmation still counts for sensitive changes.
const CONFIRM_WINDOW = 10 * MINUTE;
export const MIN_PASSWORD = 12;

const httpError = (code, message, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- schema (5.13) ----------
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  for (const [col, type] of [['ip', 'TEXT'], ['user_agent', 'TEXT'], ['app', 'TEXT'], ['last_seen_at', 'INTEGER'],
    ['two_factor', 'INTEGER NOT NULL DEFAULT 0'], ['confirmed_at', 'INTEGER']]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS security_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ip TEXT,
  device TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS security_log_kind_at ON security_log(kind, at);
`);
}

// ---------- passwords ----------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(key, expected);
}

/** Sets the password and signs out every session (the caller makes a new one for the device that changed it). */
export async function setPassword(password) {
  setSetting('password_hash', await hashPassword(password));
  db.prepare('DELETE FROM sessions').run();
}

export const passwordIsSet = () => !!getSetting('password_hash');
export const checkPassword = (pw) => verifyPassword(pw, getSetting('password_hash'));

/**
 * Why a new password won't do, or null: too short, or found in a known data breach. The breach check sends only the
 * first 5 characters of the password's SHA-1 to Have I Been Pwned (k-anonymity) and is skipped if the site can't be
 * reached.
 */
export async function passwordProblem(pw) {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (process.env.NOTEAPP_BREACH_CHECK === '0') return null;
  const hash = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Selah password check' }, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const hit = (await res.text()).split('\n').find((line) => line.startsWith(hash.slice(5)));
    if (hit && Number(hit.split(':')[1]) > 0) return 'That password has appeared in a data breach, so it’s on the lists attackers try first. Choose another.';
  } catch { /* offline: length is the only check */ }
  return null;
}

// ---------- security settings and log ----------

export const IDLE_CHOICES = [1, 7, 14, 30];
export function securitySettings() {
  let s = {};
  try { s = JSON.parse(getSetting('security') ?? '{}') ?? {}; } catch { /* defaults */ }
  return { idleDays: IDLE_CHOICES.includes(s.idleDays) ? s.idleDays : 14 };
}
export const saveSecuritySettings = (s) => setSetting('security', JSON.stringify({ ...securitySettings(), ...s }));

/** "Edge on Windows", "Selah for Windows", "Safari on iPhone" from a request's user agent (and the app it says it is). */
export function deviceName(ua = '', app = '') {
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  if (app === 'windows') return 'Selah for Windows';
  const base = browser && os ? `${browser} on ${os}` : browser || os || (ua ? ua.slice(0, 60) : 'Unknown device');
  return app === 'installed' ? `${base} (installed app)` : base;
}
const reqDevice = (req) => deviceName(String(req?.headers?.['user-agent'] ?? ''), req?.session?.app ?? '');

const KEEP_LOG = 365 * DAY;
let lastPrune = 0;
/** Adds a line to the security log (Settings → Security → Activity). */
export function logEvent(kind, req = null, detail = null) {
  const now = Date.now();
  db.prepare('INSERT INTO security_log (at, kind, ip, device, detail) VALUES (?, ?, ?, ?, ?)')
    .run(now, kind, req?.ip ?? null, req ? reqDevice(req) : null, detail == null ? null : JSON.stringify(detail));
  if (now - lastPrune > DAY) {
    lastPrune = now;
    db.prepare('DELETE FROM security_log WHERE at < ?').run(now - KEEP_LOG);
    db.prepare('DELETE FROM security_log WHERE id <= (SELECT id FROM security_log ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  }
}

// ---------- failed attempts ----------
// Counted from the log, so a restart doesn't reset them. Per address, and for the whole account (spread over many
// addresses); with two-step sign-in on, a guessed password alone still isn't enough.

export const FAIL_KINDS = ['sign-in-failed', 'code-failed', 'confirm-failed', 'setup-failed'];
const FAIL_SQL = `kind IN (${FAIL_KINDS.map(() => '?').join(', ')})`;
const WINDOW = 15 * MINUTE;
const PER_IP = 10;
const PER_ACCOUNT = 50;

export function attemptsLeft(ip) {
  const since = Date.now() - WINDOW;
  const fromIp = db.prepare(`SELECT COUNT(*) AS n FROM security_log WHERE ${FAIL_SQL} AND at > ? AND ip = ?`).get(...FAIL_KINDS, since, ip).n;
  const all = db.prepare(`SELECT COUNT(*) AS n FROM security_log WHERE ${FAIL_SQL} AND at > ?`).get(...FAIL_KINDS, since).n;
  return Math.min(PER_IP - fromIp, PER_ACCOUNT - all);
}

/** Throws 429 (and logs it once per address per window) when there have been too many failures. */
export function checkAttempts(req) {
  if (attemptsLeft(req.ip) > 0) return;
  const recent = db.prepare("SELECT 1 FROM security_log WHERE kind = 'locked' AND ip = ? AND at > ?").get(req.ip, Date.now() - WINDOW);
  if (!recent) logEvent('locked', req);
  throw httpError(429, 'Too many failed attempts. Try again in 15 minutes.');
}

/** Failed attempts since the sign-in before this one, for the notice after signing in. */
export function failuresSinceLastSignIn() {
  const prev = db.prepare("SELECT at FROM security_log WHERE kind = 'sign-in' ORDER BY id DESC LIMIT 1 OFFSET 1").get();
  return db.prepare(`SELECT COUNT(*) AS n FROM security_log WHERE ${FAIL_SQL} AND at > ?`).get(...FAIL_KINDS, prev?.at ?? 0).n;
}

// ---------- sessions ----------

export function createSession(req, { twoFactor = false, app = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + config.sessionDays * DAY;
  db.prepare(`INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent, app, last_seen_at, two_factor, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), now, expires, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), app || null, now, twoFactor ? 1 : 0, now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { token, expires: new Date(expires) };
}

/** The session row for a cookie value ({ id, … }), or null if it's unknown, expired or idle too long. */
export function sessionFor(token) {
  if (!token) return null;
  const row = db.prepare('SELECT rowid AS id, * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  const idle = securitySettings().idleDays * DAY;
  if (row.expires_at <= now || (row.last_seen_at ?? row.created_at) < now - idle) {
    db.prepare('DELETE FROM sessions WHERE rowid = ?').run(row.id);
    return null;
  }
  return row;
}

export const validSession = (token) => !!sessionFor(token);

/** Notes when and from where a session was last used (at most once a minute, or when the address changes). */
export function touchSession(session, req) {
  const now = Date.now();
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
  if (now - (session.last_seen_at ?? 0) < MINUTE && session.ip === req.ip && session.user_agent === ua) return;
  db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ?, user_agent = ? WHERE rowid = ?').run(now, req.ip, ua, session.id);
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export const markConfirmed = (session) => db.prepare('UPDATE sessions SET confirmed_at = ? WHERE rowid = ?').run(Date.now(), session.id);

/**
 * For changes to how you sign in (two-step sign-in, recovery codes, pairing a clipper): the password (and a code,
 * with two-step sign-in on) must have been entered in this session in the last 10 minutes. The client asks for them
 * and repeats the request when it sees `reauth`.
 */
export function requireConfirmed(req) {
  if (!req.session || (req.session.confirmed_at ?? 0) < Date.now() - CONFIRM_WINDOW) {
    throw httpError(403, 'Confirm it’s you first.', { reauth: true });
  }
}
