import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { encrypt, decrypt } from '../secrets.js';
import { paths } from './paths.js';

/**
 * The admin console's records: the multi-tenant settings, the tenants, a copy of every tenant's security log,
 * alerts and the history of jobs (backups, restores, updates). All in the admin console's own database.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  port INTEGER NOT NULL UNIQUE,
  control_port INTEGER NOT NULL UNIQUE,
  control_token TEXT NOT NULL,                -- encrypted
  limits TEXT NOT NULL DEFAULT '{}',
  time_zone TEXT,
  release TEXT,
  previous_release TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  health TEXT,
  health_at INTEGER,
  log_cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tenant_events (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ip TEXT,
  device TEXT,
  detail TEXT,
  UNIQUE (slug, source_id)
);
CREATE INDEX IF NOT EXISTS tenant_events_at ON tenant_events(at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  slug TEXT,
  level TEXT NOT NULL,                        -- info | warning | danger
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_at ON alerts(at);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                         -- backup | verify | restore | test-restore | restore-notes | update | rollback | prepare | promote | demo-reset
  slug TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  phase TEXT,
  detail TEXT
);
`);

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };

// ---------- settings ----------

export const DEFAULT_LIMITS = { quotaMb: 5120, uploadMb: 512, memoryMb: 1024, cpuPercent: 100, jobMinutes: 10, tasks: 256 };
export const LIMIT_RANGES = {
  quotaMb: [100, 1_000_000], uploadMb: [1, 4096], memoryMb: [256, 16384], cpuPercent: [10, 800], jobMinutes: [1, 60], tasks: [64, 4096],
};

const DEFAULTS = {
  domain: null,            // tenants are <name>.<domain>; the console is admin.<domain>
  gatewayPort: 443,
  runner: 'process',       // process (systemd user services) | docker
  unitPrefix: 'selah-tenant',
  tls: 'files',            // files (certs/ from the private CA) | acme (Let's Encrypt wildcard via Cloudflare, 6.0.1)
                           // | acme-host (Let's Encrypt per name, any DNS provider, 12.0)
  adminPort: 9450,
  portBase: 9500,
  timeZone: 'America/Chicago',
  allowIps: [],
  limits: DEFAULT_LIMITS,
  backupTime: '02:30',     // UTC, before the tenants' own OneDrive backups (03:15–06:15)
};

export function cloud() {
  const s = json(getSetting('cloud'), {});
  return { ...DEFAULTS, ...s, limits: { ...DEFAULT_LIMITS, ...(s.limits ?? {}) } };
}
export const saveCloud = (patch) => setSetting('cloud', JSON.stringify({ ...json(getSetting('cloud'), {}), ...patch }));

/** Let's Encrypt either way (a public server): HSTS, the console only from listed addresses, renewal by Caddy. */
export const publicTls = (c = cloud()) => c.tls === 'acme' || c.tls === 'acme-host';
export const tenantHost = (slug) => `${slug}.${cloud().domain}`;
export const adminHost = () => `admin.${cloud().domain}`;
export function publicUrl(host) {
  const port = cloud().gatewayPort;
  return `https://${host}${port === 443 ? '' : `:${port}`}`;
}

/** Checks and fills in a set of limits (numbers within their ranges; missing ones from the defaults). */
export function cleanLimits(l = {}, base = cloud().limits) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGES)) {
    const v = l[k] ?? base[k];
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw httpError(400, `${k} must be between ${lo} and ${hi}.`);
    out[k] = n;
  }
  return out;
}

// ---------- tenants ----------

const RESERVED = new Set(['admin', 'www', 'api', 'mail', 'smtp', 'selah', 'app', 'static', 'assets', 'status', 'help', 'support', 'root', 'ns1', 'ns2', 'autoconfig', 'autodiscover']);
export function checkSlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(s) || s.includes('--')) {
    throw httpError(400, 'Use 3 to 32 lowercase letters, numbers and single hyphens, starting with a letter.');
  }
  if (RESERVED.has(s)) throw httpError(400, `“${s}” is kept for Selah’s own use. Choose another name.`);
  return s;
}

function shape(row) {
  if (!row) return null;
  return {
    slug: row.slug, name: row.name, status: row.status, port: row.port, controlPort: row.control_port,
    limits: { ...cloud().limits, ...json(row.limits, {}) }, timeZone: row.time_zone || cloud().timeZone,
    release: row.release, previousRelease: row.previous_release, createdAt: row.created_at, updatedAt: row.updated_at,
    health: json(row.health, null), healthAt: row.health_at, logCursor: row.log_cursor,
    host: tenantHost(row.slug), url: publicUrl(tenantHost(row.slug)),
  };
}

export const listTenants = () => db.prepare('SELECT * FROM tenants ORDER BY slug').all().map(shape);
export const getTenant = (slug) => shape(db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug));
export function mustTenant(slug) {
  const t = getTenant(String(slug ?? ''));
  if (!t) throw httpError(404, 'No tenant by that name.');
  return t;
}
export const controlToken = (slug) => decrypt(db.prepare('SELECT control_token FROM tenants WHERE slug = ?').get(slug).control_token);

/** The next free pair of ports (Selah, then its control port), from portBase up. */
function freePorts() {
  const used = new Set(db.prepare('SELECT port, control_port FROM tenants').all().flatMap((r) => [r.port, r.control_port]));
  for (let p = cloud().portBase; p < cloud().portBase + 2000; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) return [p, p + 1];
  }
  throw httpError(507, 'No free ports left for another tenant.');
}

export function addTenant({ slug, name, limits, timeZone, release }) {
  const s = checkSlug(slug);
  if (getTenant(s)) throw httpError(409, `There’s already a tenant called ${s}.`);
  if (fs.existsSync(paths.tenant(s).dir)) throw httpError(409, `A folder for ${s} is still on the server (${paths.tenant(s).dir}). Remove it first.`);
  const [port, controlPort] = freePorts();
  const now = Date.now();
  db.prepare(`INSERT INTO tenants (slug, name, status, port, control_port, control_token, limits, time_zone, release, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s, String(name ?? '').trim().slice(0, 80), port, controlPort, encrypt(crypto.randomBytes(32).toString('base64url')),
      JSON.stringify(cleanLimits(limits)), timeZone || null, release ?? null, now, now);
  return getTenant(s);
}

export function updateTenant(slug, patch) {
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries({ name: 'name', status: 'status', limits: 'limits', timeZone: 'time_zone', release: 'release', previousRelease: 'previous_release', logCursor: 'log_cursor' })) {
    if (!(k in patch)) continue;
    sets.push(`${col} = ?`);
    args.push(k === 'limits' ? JSON.stringify(patch[k]) : patch[k]);
  }
  if (!sets.length) return getTenant(slug);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')}, updated_at = ? WHERE slug = ?`).run(...args, Date.now(), slug);
  return getTenant(slug);
}

export const saveHealth = (slug, health) => db.prepare('UPDATE tenants SET health = ?, health_at = ? WHERE slug = ?').run(JSON.stringify(health), Date.now(), slug);
export const removeTenantRecord = (slug) => db.prepare('DELETE FROM tenants WHERE slug = ?').run(slug);

/** The tenant's environment file (mode 600): how its Selah runs, and its limits. */
export function tenantEnv(t, { docker = false } = {}) {
  const p = paths.tenant(t.slug);
  const l = t.limits;
  const c = cloud();
  const env = {
    NODE_ENV: 'production',
    NOTEAPP_MODE: 'tenant',
    NOTEAPP_TENANT: t.slug,
    NOTEAPP_TENANT_NAME: t.name || t.slug,
    NOTEAPP_TLS: '0',
    NOTEAPP_HOST: docker ? '0.0.0.0' : '127.0.0.1',
    NOTEAPP_PORT: String(docker ? 8080 : t.port),
    NOTEAPP_CONTROL_HOST: docker ? '0.0.0.0' : '127.0.0.1',
    NOTEAPP_CONTROL_PORT: String(docker ? 8081 : t.controlPort),
    NOTEAPP_CONTROL_TOKEN: controlToken(t.slug),
    NOTEAPP_DATA_DIR: docker ? '/data/data' : p.data,
    NOTEAPP_STORAGE_DIR: docker ? '/data/storage' : p.storage,
    // Caddy, on this machine (or, from inside a container, the Docker bridge).
    NOTEAPP_TRUST_PROXY: docker ? 'loopback,172.16.0.0/12' : 'loopback',
    NOTEAPP_TZ: t.timeZone,
    NOTEAPP_QUOTA: String(l.quotaMb * 1024 * 1024),
    NOTEAPP_MAX_UPLOAD: String(l.uploadMb * 1024 * 1024),
    NOTEAPP_MAX_IMPORT: String(Math.min(l.quotaMb, 8192) * 1024 * 1024),
    NOTEAPP_JOB_TIMEOUT: String(l.jobMinutes * 60_000),
    NOTEAPP_JOB_MEMORY_MB: String(Math.max(128, Math.floor(l.memoryMb / 2))),
    ...(publicTls(c) ? { NOTEAPP_HSTS: '1' } : {}),
  };
  return Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, '')}`).join('\n') + '\n';
}

export function writeTenantEnv(t, opts) {
  const p = paths.tenant(t.slug);
  const tmp = `${p.env}.new`;
  fs.writeFileSync(tmp, tenantEnv(t, opts), { mode: 0o600 });
  fs.renameSync(tmp, p.env);
}

// ---------- alerts and events ----------

/** Adds an alert, unless the same kind for the same tenant was raised in the last `quiet` ms (default an hour). */
export function alert(slug, level, kind, message, { quiet = 3_600_000 } = {}) {
  const recent = db.prepare('SELECT 1 FROM alerts WHERE kind = ? AND COALESCE(slug, \'\') = ? AND at > ?').get(kind, slug ?? '', Date.now() - quiet);
  if (recent) return null;
  return db.prepare('INSERT INTO alerts (at, slug, level, kind, message) VALUES (?, ?, ?, ?, ?)').run(Date.now(), slug ?? null, level, kind, message).lastInsertRowid;
}
export const listAlerts = ({ limit = 100, unseen = false } = {}) => db.prepare(`SELECT * FROM alerts ${unseen ? 'WHERE seen_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`).all(limit);
export const markAlertsSeen = (id = null) => (id
  ? db.prepare('UPDATE alerts SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(Date.now(), id)
  : db.prepare('UPDATE alerts SET seen_at = ? WHERE seen_at IS NULL').run(Date.now()));

// ---------- jobs ----------

export function startJob(kind, slug = null) {
  const id = Number(db.prepare('INSERT INTO jobs (kind, slug, started_at, phase) VALUES (?, ?, ?, ?)').run(kind, slug, Date.now(), 'Starting').lastInsertRowid);
  return {
    id,
    phase: (p) => db.prepare('UPDATE jobs SET phase = ? WHERE id = ?').run(p, id),
    finish: (ok, detail = null) => db.prepare('UPDATE jobs SET finished_at = ?, ok = ?, phase = NULL, detail = ? WHERE id = ?').run(Date.now(), ok ? 1 : 0, detail == null ? null : JSON.stringify(detail), id),
  };
}
export const listJobs = ({ limit = 50, kind = null, slug = null } = {}) => db.prepare(
  `SELECT * FROM jobs WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR slug = ?) ORDER BY id DESC LIMIT ?`,
).all(kind, kind, slug, slug, limit).map((j) => ({ ...j, ok: j.ok == null ? null : !!j.ok, detail: json(j.detail, null) }));
export const activeJobs = () => db.prepare('SELECT * FROM jobs WHERE finished_at IS NULL ORDER BY id').all();
/** Jobs left unfinished by a restart of the console are marked as stopped. */
export const closeStaleJobs = () => db.prepare("UPDATE jobs SET finished_at = ?, ok = 0, phase = NULL, detail = '{\"error\":\"Stopped when the admin console restarted.\"}' WHERE finished_at IS NULL").run(Date.now());
