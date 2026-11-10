import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { getTenant, listTenants } from './store.js';
import { paths } from './paths.js';
import { control } from './control.js';

/**
 * Push to the Selah apps (Admin 3.3, Selah 13.0): the sender. Each tenant queues pushes for its own devices
 * (server/push.js); the console keeps a request open to each tenant's control port, as it does for sharing, and sends
 * them through Apple (APNs) and Google (Firebase Cloud Messaging) with keys only the host has:
 *
 *   <cloud root>/push/apns.p8 + apns.json   { keyId, teamId, bundleId, production }   (npm run admin -- push-keys apns)
 *   <cloud root>/push/fcm.json               the Firebase service account              (npm run admin -- push-keys fcm)
 *
 * Tenants never see the keys; the console sees only the reminder's title and text on its way through. A token Apple or
 * Google says is gone goes back to the tenant to drop. Each tenant is told which platforms can be pushed to, so its
 * apps only register when it works.
 */

export const PUSH_DIR = path.join(paths.root, 'push');
const WAIT = Number(process.env.NOTEAPP_PUSH_WAIT_MS || 25_000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// ---------- keys ----------

let keyCache = { stamp: '', apns: null, fcm: null };
const stampOf = (f) => { try { return String(fs.statSync(f).mtimeMs); } catch { return '-'; } };

/** The keys on this host (read again when the files change): { apns: {...} | null, fcm: {...} | null }. */
export function pushKeys() {
  const files = ['apns.p8', 'apns.json', 'fcm.json'].map((f) => path.join(PUSH_DIR, f));
  const stamp = files.map(stampOf).join('|');
  if (stamp === keyCache.stamp) return keyCache;
  let apns = null;
  const meta = readJson(files[1]);
  try {
    if (meta?.keyId && meta?.teamId && meta?.bundleId) apns = { ...meta, key: crypto.createPrivateKey(fs.readFileSync(files[0], 'utf8')) };
  } catch { apns = null; }
  let fcm = null;
  const sa = readJson(files[2]);
  try {
    if (sa?.client_email && sa?.private_key && sa?.project_id) fcm = { email: sa.client_email, projectId: sa.project_id, key: crypto.createPrivateKey(sa.private_key) };
  } catch { fcm = null; }
  keyCache = { stamp, apns, fcm, apnsToken: null, fcmToken: null };
  return keyCache;
}
export const pushReady = () => { const k = pushKeys(); return { ios: !!k.apns, android: !!k.fcm }; };

// ---------- Apple ----------

let apnsSession = null;
function apnsJwt(k) {
  if (k.apnsToken && Date.now() - k.apnsToken.at < 45 * 60_000) return k.apnsToken.jwt;
  const head = b64url({ alg: 'ES256', kid: k.apns.keyId });
  const claims = b64url({ iss: k.apns.teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: k.apns.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  k.apnsToken = { at: Date.now(), jwt: `${head}.${claims}.${sig}` };
  return k.apnsToken.jwt;
}
function apnsConnection(production) {
  const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed && apnsSession.host === host) return apnsSession;
  apnsSession = http2.connect(host);
  apnsSession.host = host;
  apnsSession.on('error', () => { apnsSession = null; });
  apnsSession.on('goaway', () => { apnsSession = null; });
  apnsSession.unref?.();
  return apnsSession;
}

/** -> 'ok' | 'gone' (drop the token) | 'failed' */
async function sendApple(k, m) {
  const sync = m.kind === 'sync';
  const body = sync
    ? { aps: { 'content-available': 1 }, kind: 'sync' }
    : { aps: { alert: { title: m.title ?? '', body: m.body ?? '' }, sound: 'default' }, kind: 'alert', open: m.open ? JSON.stringify(m.open) : '' };
  const headers = {
    ':method': 'POST', ':path': `/3/device/${m.token}`,
    authorization: `bearer ${apnsJwt(k)}`, 'apns-topic': k.apns.bundleId,
    'apns-push-type': sync ? 'background' : 'alert', 'apns-priority': sync ? '5' : '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + (sync ? 3600 : 6 * 3600)),
    'content-type': 'application/json',
  };
  if (m.collapse) headers['apns-collapse-id'] = String(m.collapse).slice(0, 64);
  return new Promise((resolve) => {
    let req;
    try { req = apnsConnection(k.apns.production !== false).request(headers); } catch { resolve('failed'); return; }
    let status = 0;
    let text = '';
    req.setTimeout(15_000, () => { req.close(); resolve('failed'); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { text += d; });
    req.on('end', () => {
      if (status === 200) return resolve('ok');
      const reason = (() => { try { return JSON.parse(text).reason; } catch { return ''; } })();
      resolve(status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic' ? 'gone' : 'failed');
    });
    req.on('error', () => resolve('failed'));
    req.end(JSON.stringify(body));
  });
}

// ---------- Google ----------

async function fcmAccess(k) {
  if (k.fcmToken && Date.now() < k.fcmToken.until) return k.fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: k.fcm.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), k.fcm.key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed (${res.status})`);
  k.fcmToken = { value: body.access_token, until: Date.now() + (Math.max(300, Number(body.expires_in) || 3600) - 120) * 1000 };
  return k.fcmToken.value;
}

async function sendGoogle(k, m) {
  const sync = m.kind === 'sync';
  const message = {
    token: m.token,
    data: { kind: sync ? 'sync' : 'alert', open: m.open ? JSON.stringify(m.open) : '' },
    android: { priority: sync ? 'normal' : 'high', ttl: sync ? '3600s' : '21600s', ...(m.collapse ? { collapse_key: String(m.collapse).slice(0, 64) } : {}) },
  };
  if (!sync) {
    message.notification = { title: m.title ?? '', body: m.body ?? '' };
    message.android.notification = { icon: 'ic_stat_selah', color: '#2F5D86', ...(m.collapse ? { tag: String(m.collapse).slice(0, 64) } : {}) };
  }
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(k.fcm.projectId)}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${await fcmAccess(k)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return 'ok';
    const body = await res.json().catch(() => ({}));
    const code = body.error?.details?.find?.((d) => d.errorCode)?.errorCode ?? body.error?.status;
    return res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && code === 'INVALID_ARGUMENT' && /token/i.test(body.error?.message ?? '')) ? 'gone' : 'failed';
  } catch { return 'failed'; }
}

/** Sends one queued push. Exported for the console's test button and the tests. */
export async function sendPush(m) {
  const k = pushKeys();
  if (m.platform === 'ios') return k.apns ? sendApple(k, m) : 'failed';
  if (m.platform === 'android') return k.fcm ? sendGoogle(k, m) : 'failed';
  return 'gone';
}

// ---------- the loops: one waiting request per tenant ----------

const loops = new Map();
const cursors = new Map(); // a tenant's outbox drops what's up to the cursor, so memory is enough
const stats = { sent: 0, failed: 0, dropped: 0, lastError: null };

function runLoop(slug, logger) {
  const state = { stop: false, told: null, misses: 0 };
  (async () => {
    while (!state.stop) {
      const t = getTenant(slug);
      if (!t || t.status !== 'active') break;
      let messages;
      try {
        const ready = JSON.stringify(pushReady());
        if (state.told !== ready) { await control(t, 'POST', '/control/push/state', JSON.parse(ready), { timeout: 5000 }); state.told = ready; }
        ({ messages } = await control(t, 'GET', `/control/push/outbox?after=${cursors.get(slug) ?? 0}&wait=${WAIT}`, undefined, { timeout: WAIT + 10_000 }));
      } catch {
        // Restarting, updating, or on a release from before 13.0 (no push): try again, less often each time.
        state.told = null;
        state.misses++;
        await pause(Math.min(60_000, 5000 * state.misses));
        continue;
      }
      state.misses = 0;
      const gone = [];
      for (const m of messages ?? []) {
        const result = await sendPush(m).catch(() => 'failed');
        if (result === 'ok') stats.sent++;
        else if (result === 'gone') { gone.push(m.token); stats.dropped++; } else { stats.failed++; stats.lastError = { slug, at: Date.now(), platform: m.platform }; }
        cursors.set(slug, m.seq);
      }
      if (gone.length) await control(t, 'POST', '/control/push/drop', { tokens: [...new Set(gone)] }, { timeout: 5000 }).catch(() => {});
    }
    loops.delete(slug);
  })().catch((e) => logger?.warn?.(`Push loop for ${slug} stopped: ${e.message}`));
  return state;
}

/** Keeps one loop for each active tenant (checked every 10 seconds, so new tenants join). */
export function startPushRelay(logger) {
  const sync = () => {
    const active = new Set(listTenants().filter((t) => t.status === 'active').map((t) => t.slug));
    for (const [slug, l] of loops) if (!active.has(slug)) { l.stop = true; loops.delete(slug); }
    for (const slug of active) if (!loops.has(slug)) loops.set(slug, runLoop(slug, logger));
    // Keys added or removed: every tenant hears on its next round.
    const ready = JSON.stringify(pushReady());
    for (const l of loops.values()) if (l.told && l.told !== ready) l.told = null;
  };
  sync();
  setInterval(sync, 10_000).unref();
}

export const pushOverview = () => ({ ...pushReady(), ...stats, tenants: loops.size });
