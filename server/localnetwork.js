import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { makeCertificate, fingerprintOfPem } from './lancert.js';

/**
 * 14.2 local network mode (Selah Desktop only): "Use Selah on my phone and tablet". The Selah app on a phone or tablet
 * on the same Wi-Fi opens this PC's library, the whole app as on Selah Cloud, and its changes go straight into it.
 * Nothing goes through anyone's server.
 *
 * Off until switched on in Settings. Then a second listener opens on the network (Selah's own one still answers only
 * this PC): HTTPS with a certificate this PC made for itself (lancert.js). A device is paired once by scanning a QR
 * code that carries the certificate's fingerprint and a key made for that device; the app trusts that certificate and
 * no other for this PC (pinned natively), and this side lets in only requests carrying a paired device's key (a cookie
 * the app's web view keeps). A plain browser gets neither. Each device can be removed in Settings.
 *
 * A request from a paired device goes through Selah exactly as one from the PC's own window does (app.routing), so
 * everything works the same; only this module's own settings can't be changed from a phone.
 */
const SETTING = 'local_network';
const DEFAULT_PORT = 47631;
const PAIR_MINUTES = 10;
const MAX_DEVICES = 10;
const COOKIE = 'selah_lan';
// Seen: saved at most once a minute per device.
const SEEN_EVERY = 60_000;

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hash = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

function load() {
  let s = {};
  try { s = JSON.parse(getSetting(SETTING) ?? '{}') ?? {}; } catch { /* start fresh */ }
  // NOTEAPP_LAN_PORT: another port (two test libraries on one PC, or one in use by something else).
  return { on: !!s.on, port: Number(process.env.NOTEAPP_LAN_PORT) || Number(s.port) || DEFAULT_PORT, serverId: s.serverId || null,
    devices: Array.isArray(s.devices) ? s.devices : [] };
}
const save = (s) => setSetting(SETTING, JSON.stringify(s));

/** The saved state, with a server id the first time and unused pairing codes past their ten minutes dropped. */
function state() {
  const s = load();
  const before = s.devices.length;
  s.devices = s.devices.filter((d) => d.confirmed_at || d.created_at > Date.now() - PAIR_MINUTES * 60_000);
  if (!s.serverId || s.devices.length !== before) {
    s.serverId ||= b64u(crypto.randomBytes(9));
    save(s);
  }
  return s;
}

/** This PC's addresses on the network (IPv4, not loopback or link-local), Wi-Fi and Ethernet first. */
export function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Virtual adapters (Hyper-V, WSL, VirtualBox, VPNs) aren't where a phone is.
    const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|docker|tailscale|zerotier|utun|awdl|llw|bridge/i.test(name);
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, virtual });
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((a) => a.address);
}

// ---------- the certificate ----------

const certDir = () => path.join(config.dataDir, 'local-network');
let cert = null; // { key, cert, fingerprint }

/** This PC's certificate, made the first time and kept (a new one means pairing every device again). */
function certificate() {
  if (cert) return cert;
  const dir = certDir();
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  try {
    const c = { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
    cert = { ...c, fingerprint: fingerprintOfPem(c.cert) };
    return cert;
  } catch { /* make one */ }
  const made = makeCertificate({ commonName: `Selah Desktop (${os.hostname()})`, names: [`${os.hostname()}.local`, os.hostname(), ...addresses()] });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert);
  cert = made;
  return cert;
}

// ---------- requests from the network ----------

let mainApp = null;
let server = null;
let listening = null; // { port } | { error }
const failures = new Map(); // ip -> { n, reset }
const seen = new Map(); // device id -> last time saved

function tooMany(ip) {
  const f = failures.get(ip);
  return !!f && f.reset > Date.now() && f.n >= 20;
}
function failed(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.reset < now) failures.set(ip, { n: 1, reset: now + 60_000 });
  else f.n++;
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** The paired device a "<id>.<key>" names, or null. Unconfirmed ones only when `pending` (the first connect). */
function deviceFor(s, value, { pending = false } = {}) {
  const [id, secret] = String(value ?? '').split('.');
  if (!id || !secret) return null;
  const d = s.devices.find((x) => x.id === id);
  if (!d || (!d.confirmed_at && !pending)) return null;
  const a = Buffer.from(hash(secret));
  const b = Buffer.from(String(d.secret_hash ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? d : null;
}

// In the Selah app (its bridge is on the page), a device this PC doesn't know goes back to the app's own first page,
// which says so and offers pairing again (mobile-app/www/shell.js, ?unpaired=1).
const BACK_TO_APP = '<script>(function(){var c=window.Capacitor;if(c&&c.isNativePlatform&&c.isNativePlatform()){'
  + "location.replace((c.getPlatform()==='ios'?'capacitor://localhost':'https://localhost')+'/index.html?unpaired=1');}})();</script>";

function page(res, code, title, text) {
  const body = Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + '<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 20px;color:#1f2a37;background:#f4efe8">'
    + `<h1 style="font-size:1.3rem">${title}</h1><p>${text}</p>${code === 401 ? BACK_TO_APP : ''}</body>`);
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function json(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const cookieHeader = (value) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${400 * 24 * 3600}`;

function onRequest(req, res) {
  const ip = req.socket.remoteAddress ?? '';
  const url = new URL(req.url, 'https://selah');
  if (tooMany(ip)) return json(res, 429, { error: 'Too many tries. Wait a minute.' });

  // How the app checks an address is this PC (it can change): says that Selah Desktop is here, which one, and this
  // PC's addresses now (so a paired device keeps up when the router gives the PC a new one).
  if (req.method === 'GET' && url.pathname === '/selah-lan/hello') {
    return json(res, 200, { selah: 'desktop', v: 1, id: state().serverId, name: os.hostname(), addresses: addresses() });
  }

  const s = state();
  // Whether a device's key still works, asked by the app before it opens Selah (so a removed device is told, not
  // shown an error page).
  if (req.method === 'GET' && url.pathname === '/selah-lan/check') {
    const d = deviceFor(s, `${url.searchParams.get('d') ?? ''}.${url.searchParams.get('k') ?? ''}`, { pending: true });
    if (!d) failed(ip);
    return json(res, 200, { paired: !!d });
  }
  // The first visit from a just-paired device: its key becomes the cookie it sends from then on.
  if (req.method === 'GET' && url.pathname === '/selah-lan/connect') {
    const value = `${url.searchParams.get('d') ?? ''}.${url.searchParams.get('k') ?? ''}`;
    const d = deviceFor(s, value, { pending: true });
    if (!d) { failed(ip); return page(res, 401, 'This device isn’t paired', 'The code has expired, or this device was removed from Selah Desktop. On the PC, open Settings → Phone and tablet and pair it again.'); }
    if (!d.confirmed_at) {
      d.confirmed_at = Date.now();
      mainApp?.log.warn(`Local network: paired ${d.name || 'a device'} (${ip}).`);
    }
    const name = String(url.searchParams.get('n') ?? '').trim().slice(0, 80);
    if (name) d.name = name;
    const platform = String(url.searchParams.get('o') ?? '');
    if (['ios', 'android'].includes(platform)) d.platform = platform;
    d.last_seen_at = Date.now();
    d.last_ip = ip;
    save(s);
    res.writeHead(302, { Location: '/', 'Set-Cookie': cookieHeader(value), 'Cache-Control': 'no-store' });
    return res.end();
  }

  const d = deviceFor(s, cookieOf(req));
  if (!d) {
    failed(ip);
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'This phone or tablet isn’t paired with Selah Desktop.', lan: 'unpaired' });
    return page(res, 401, 'Open this in the Selah app', 'This Selah Desktop is shared only with the Selah app on a phone or tablet you’ve paired. In Selah Desktop, open Settings → Phone and tablet.');
  }
  // Its own settings stay on the PC: a phone can't pair more devices or turn this off.
  if (url.pathname.startsWith('/api/local-network')) return json(res, 403, { error: 'Change this in Selah Desktop on the PC.' });

  if (Date.now() - (seen.get(d.id) ?? 0) > SEEN_EVERY) {
    seen.set(d.id, Date.now());
    d.last_seen_at = Date.now();
    d.last_ip = ip;
    save(s);
  }
  // From here it's as if this PC's own window asked: its key, no device cookie, and which device it is.
  req.headers['x-selah-desktop'] = config.desktopKey;
  delete req.headers['x-selah-lan'];
  const rest = String(req.headers.cookie ?? '').split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${COOKIE}=`));
  if (rest.length) req.headers.cookie = rest.join('; ');
  else delete req.headers.cookie;
  req.selahLanDevice = d.id;
  mainApp.routing(req, res);
}

function stop() {
  server?.close();
  server?.closeAllConnections?.();
  server = null;
  listening = null;
  tellApp();
}

/** Selah Desktop's own process keeps the PC awake while this is on, if asked to (desktop-app/main.cjs). */
function tellApp() {
  try { process.send?.({ type: 'local-network', on: !!listening?.port }); } catch { /* not under Selah Desktop */ }
}

function start(log) {
  stop();
  const s = state();
  if (!s.on) return;
  const c = certificate();
  const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    try { onRequest(req, res); } catch (e) { log.error(e); try { res.writeHead(500); res.end(); } catch { /* gone */ } }
  });
  srv.requestTimeout = 0; // live updates (server-sent events) stay open
  srv.headersTimeout = 15_000;
  srv.keepAliveTimeout = 30_000;
  srv.on('error', (e) => {
    listening = { error: e.code === 'EADDRINUSE' ? `Port ${s.port} is in use by another program.` : e.message };
    log.error(`Local network: ${e.message}`);
    tellApp();
  });
  srv.listen(s.port, '0.0.0.0', () => {
    listening = { port: s.port };
    log.warn(`Local network: listening on port ${s.port}.`);
    tellApp();
  });
  server = srv;
}

// ---------- Settings ----------

function view() {
  const s = state();
  return {
    on: s.on, port: s.port, listening: !!listening?.port, error: listening?.error ?? null, addresses: addresses(), name: os.hostname(),
    fingerprint: s.on ? certificate().fingerprint : null,
    devices: s.devices.filter((d) => d.confirmed_at).map((d) => ({ id: d.id, name: d.name || 'Phone or tablet', platform: d.platform ?? null,
      paired_at: d.confirmed_at, last_seen_at: d.last_seen_at ?? null })),
  };
}

/** The pairing link the QR code carries: selahapp://desktop?… (the phone's camera opens the Selah app with it). */
function pairLink(s, device, secret) {
  return `selahapp://desktop?${new URLSearchParams({
    v: '1', n: os.hostname(), h: `${os.hostname()}.local`, a: addresses().join(','), p: String(s.port),
    f: certificate().fingerprint, s: s.serverId, d: device.id, k: secret,
  })}`;
}

export default async function localNetwork(app) {
  if (config.product !== 'desktop') return;
  mainApp = app;
  app.addHook('onReady', async () => start(app.log));
  app.addHook('onClose', async () => stop());

  app.get('/api/local-network', async () => view());

  // Body: { on }.
  app.put('/api/local-network', async (req) => {
    const s = state();
    s.on = !!req.body?.on;
    save(s);
    start(app.log);
    // Give the listener a moment to say whether the port was free.
    await new Promise((r) => setTimeout(r, 300));
    return view();
  });

  /** A code for one device to scan: this PC's addresses, its certificate's fingerprint, a key for it. Ten minutes. */
  app.post('/api/local-network/pair', async () => {
    const s = state();
    if (!s.on) throw httpError(400, 'Turn on “Use Selah on my phone and tablet” first.');
    if (s.devices.filter((d) => d.confirmed_at).length >= MAX_DEVICES) throw httpError(400, `That’s ${MAX_DEVICES} devices already. Remove one first.`);
    const secret = b64u(crypto.randomBytes(32));
    const device = { id: b64u(crypto.randomBytes(9)), name: '', secret_hash: hash(secret), created_at: Date.now(), confirmed_at: null, last_seen_at: null };
    s.devices = s.devices.filter((d) => d.confirmed_at); // one code waiting at a time
    s.devices.push(device);
    save(s);
    const link = pairLink(s, device, secret);
    return { id: device.id, link, qr: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), expires_at: device.created_at + PAIR_MINUTES * 60_000 };
  });

  /** Whether the code shown has been used yet (Settings waits for it, to say "Paired"). */
  app.get('/api/local-network/pair/:id', async (req) => {
    const d = state().devices.find((x) => x.id === String(req.params.id));
    return { paired: !!d?.confirmed_at, name: d?.name || null, expired: !d };
  });

  app.delete('/api/local-network/devices/:id', async (req) => {
    const s = state();
    const before = s.devices.length;
    s.devices = s.devices.filter((d) => d.id !== String(req.params.id));
    if (s.devices.length === before) throw httpError(404, 'That device is already removed.');
    save(s);
    // Its open connections (live updates) end now, not when it next asks.
    if (server) { server.closeAllConnections?.(); }
    return view();
  });
}
