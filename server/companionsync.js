import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt } from './secrets.js';
import { allWork } from './work.js';
import { htmlToText } from './html.js';
import { findReferences } from '../shared/scripture.js';

/**
 * Companion sync (Selah Desktop only): Selah Companion on an iPad, on the same Wi-Fi, takes a copy of your sermons,
 * lessons and Bible studies to preach and teach from with no connection. Nothing goes through a server of anyone's.
 *
 * Off until switched on in Settings. Then a second, separate listener opens on the network (Selah itself still only
 * answers this PC): it serves the sync and nothing else. An iPad is paired once, by scanning a QR code that carries
 * this PC's addresses and a key made for that iPad; everything either side sends after that is sealed with the key
 * (AES-256-GCM), so only a paired iPad can ask for anything or read the answers. A pairing is confirmed by the
 * iPad's first request, within ten minutes of showing the code.
 *
 * What an iPad gets for each piece of work is what Selah's own Preach, Teach and slides screens ask this server for
 * (the note, its sermon or lesson, its slides, ink, Bible text, pictures), kept under the request each answers, so
 * the Companion shows those same screens from its copy.
 */
const SETTING = 'companion_sync';
const DEFAULT_PORT = 47631;
const PAIR_MINUTES = 10;
const MAX_BODY = 1024 * 1024;
const MAX_DEVICES = 10;
// Bible text kept per sermon or lesson, as for the iPad export (the publishers' quoting limits).
const MAX_VERSES = 500;
const MAX_PASSAGES = 60;

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function load() {
  let s = {};
  try { s = JSON.parse(getSetting(SETTING) ?? '{}') ?? {}; } catch { /* start fresh */ }
  // NOTEAPP_COMPANION_PORT: another port (two test libraries on one PC, or one in use by something else).
  return { on: !!s.on, port: Number(process.env.NOTEAPP_COMPANION_PORT) || Number(s.port) || DEFAULT_PORT, serverId: s.serverId || null, devices: Array.isArray(s.devices) ? s.devices : [] };
}
const save = (s) => setSetting(SETTING, JSON.stringify(s));

/** The saved state, with a server id the first time and unconfirmed pairings past their ten minutes dropped. */
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

/** This PC's addresses on the network (IPv4, not loopback or link-local). */
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

// ---------- sealing ----------

/** nonce (12) + ciphertext + tag (16). `aad` ties a message to its device and direction. */
function seal(key, aad, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, data, c.getAuthTag()]);
}

function open(key, aad, sealed) {
  if (sealed.length < 28) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
}

// ---------- what an iPad gets ----------

/** "GET /api/bible/passage?q=John 3:16": a request as both sides name it (the query decoded, in order of its names). */
export function answerKey(method, url) {
  const u = new URL(url, 'http://selah');
  const q = [...u.searchParams.entries()].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  return `${method} ${u.pathname}${q ? `?${q}` : ''}`;
}

let mainApp = null;
/** Asks Selah itself, as its own window would. */
async function ask(url) {
  const r = await mainApp.inject({
    method: 'GET', url, remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin', 'user-agent': 'Selah Companion sync', 'x-selah-desktop': config.desktopKey },
  });
  return { status: r.statusCode, type: r.headers['content-type'] ?? 'application/json', text: r.body ?? '' };
}

const passageUrl = (q, t = '') => `/api/bible/passage?${new URLSearchParams(t ? { q, t } : { q })}`;

/** What every piece of work shares: the slides' look and which Bible is connected. */
async function common() {
  const answers = {};
  for (const url of ['/api/slides/brand', '/api/bible']) answers[answerKey('GET', url)] = await ask(url);
  return { answers, files: filesIn(answers) };
}

/** The pictures the answers point at: /api/files/<n> in a note, and a deck's or the brand's picture numbers. */
function filesIn(answers) {
  const ids = new Set();
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'number' && Number.isInteger(v) && v > 0 && ['image', 'bg', 'logo'].includes(key)) ids.add(v);
    else if (typeof v === 'string') for (const m of v.matchAll(/\/api\/files\/(\d+)/g)) ids.add(Number(m[1]));
  };
  for (const a of Object.values(answers)) {
    if (a.status !== 200) continue;
    try { walk(JSON.parse(a.text), ''); } catch { /* not JSON */ }
  }
  const row = db.prepare('SELECT id, mime, size, storage FROM attachments WHERE id = ?');
  return [...ids].sort((a, b) => a - b).map((id) => row.get(id)).filter(Boolean)
    .map((r) => ({ id: r.id, mime: r.mime, size: r.size, hash: fileHash(r.storage) })).filter((f) => f.hash);
}

// A picture's SHA-256, so an iPad knows it has this very file (numbers repeat from one PC to another). Kept until
// the file changes.
const hashes = new Map(); // storage -> { mtime, size, hash }
function fileHash(storage) {
  const file = path.join(config.filesDir, storage);
  if (!file.startsWith(path.resolve(config.filesDir) + path.sep)) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const had = hashes.get(storage);
  if (had && had.mtime === st.mtimeMs && had.size === st.size) return had.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  hashes.set(storage, { mtime: st.mtimeMs, size: st.size, hash });
  return hash;
}

/** One piece of work: every answer Preach, Teach and the slides ask for, and the pictures they show. */
async function bundle(noteId) {
  const answers = {};
  const get = async (url) => (answers[answerKey('GET', url)] = await ask(url));
  const note = await get(`/api/notes/${noteId}`);
  if (note.status !== 200) throw httpError(404, 'That note isn’t in Selah any more.');
  for (const part of ['sermon', 'lesson', 'slides', 'ink', 'attendance']) await get(`/api/notes/${noteId}/${part}`);

  // Bible text: the references in the note (tapped open in Preach and Teach), and the slides' passages.
  const wants = new Map();
  let html = '';
  try { html = JSON.parse(note.text).html ?? ''; } catch { /* no note */ }
  for (const f of findReferences(htmlToText(html))) wants.set(passageUrl(f.text), true);
  try {
    const deck = JSON.parse(answers[answerKey('GET', `/api/notes/${noteId}/slides`)].text)?.deck;
    for (const s of deck?.slides ?? []) {
      if (s.type === 'passage' && s.ref?.trim()) wants.set(passageUrl(s.ref.trim(), s.tr || deck.translation || ''), true);
    }
  } catch { /* no slides */ }
  let verses = 0;
  for (const url of [...wants.keys()].slice(0, MAX_PASSAGES)) {
    if (verses >= MAX_VERSES) break;
    const a = await ask(url);
    if (a.status !== 200) continue; // no Bible connected, or not a passage it has
    try { verses += Number(JSON.parse(a.text).verses) || 0; } catch { /* count nothing */ }
    answers[answerKey('GET', url)] = a;
  }
  const files = filesIn(answers);
  const hash = crypto.createHash('sha256').update(JSON.stringify([answers, files])).digest('hex').slice(0, 32);
  return { noteId, hash, answers, files };
}

/** Everything there is to take: each sermon, lesson and study, with a hash that changes when anything in it does. */
async function index() {
  const items = [];
  for (const w of allWork()) {
    let hash;
    try { hash = (await bundle(w.note_id)).hash; } catch { continue; }
    items.push({ noteId: w.note_id, kind: w.kind, title: w.title ?? '', passage: w.passage ?? '', series: w.series ?? null,
      date: w.date ?? null, done: !!w.done, updatedAt: w.updated_at, hash });
  }
  const c = await common();
  return { items, common: crypto.createHash('sha256').update(JSON.stringify([c.answers, c.files])).digest('hex').slice(0, 32) };
}

function fileBytes(id) {
  const a = db.prepare('SELECT storage, size FROM attachments WHERE id = ?').get(Number(id));
  if (!a) throw httpError(404, 'That picture isn’t in Selah any more.');
  const file = path.join(config.filesDir, a.storage);
  if (!file.startsWith(path.resolve(config.filesDir) + path.sep)) throw httpError(404, 'Not found');
  return fs.readFileSync(file);
}

let version = '';
try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { /* unknown */ }

/** One request from a paired iPad: returns a Buffer (a picture) or something to send as JSON. */
async function handle(device, msg) {
  switch (msg.op) {
    case 'hello': return { name: os.hostname(), version, app: 'Selah Desktop' };
    case 'index': return index();
    case 'common': return common();
    case 'note': return bundle(Number(msg.id));
    case 'file': return fileBytes(msg.id);
    default: throw httpError(400, 'Unknown request');
  }
}

// ---------- the listener ----------

let server = null;
let listening = null; // { port } | { error }
const failures = new Map(); // ip -> { n, reset }

function tooMany(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  return !!f && f.reset > now && f.n >= 20;
}
function failed(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.reset < now) failures.set(ip, { n: 1, reset: now + 60_000 });
  else f.n++;
}

async function onRequest(req, res, log) {
  const ip = req.socket.remoteAddress ?? '';
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  if (tooMany(ip)) return send(429, Buffer.from('{}'));
  // So an iPad can find this PC again when its address changes: says only that Selah's sync is here, and which.
  if (req.method === 'GET' && req.url === '/hello') return send(200, Buffer.from(JSON.stringify({ selah: 'companion-sync', v: 1, id: state().serverId })));
  if (req.method !== 'POST' || req.url !== '/sync') { failed(ip); return send(404, Buffer.from('{}')); }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { failed(ip); return send(413, Buffer.from('{}')); }
    chunks.push(c);
  }
  const s = state();
  const id = String(req.headers['x-selah-device'] ?? '');
  const device = s.devices.find((d) => d.id === id);
  let msg = null;
  let key = null;
  if (device) {
    try {
      key = Buffer.from(decrypt(device.key), 'base64');
      msg = JSON.parse(open(key, `${id}>`, Buffer.concat(chunks)).toString('utf8'));
    } catch { msg = null; }
  }
  // An unknown iPad, a wrong key, or a message sent before (each must count higher than the last).
  if (!msg || typeof msg.n !== 'number' || msg.n <= (device.last_n ?? 0)) { failed(ip); return send(401, Buffer.from('{}')); }

  device.last_n = msg.n;
  device.last_seen_at = Date.now();
  if (!device.confirmed_at) {
    device.confirmed_at = Date.now();
    log.info(`Companion sync: paired with ${String(msg.name ?? 'an iPad').slice(0, 80)}.`);
  }
  if (typeof msg.name === 'string' && msg.name.trim()) device.name = msg.name.trim().slice(0, 80);
  save(s);

  let out;
  try {
    const r = await handle(device, msg);
    out = Buffer.isBuffer(r) ? Buffer.concat([Buffer.from([1]), r]) : Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(r))]);
  } catch (e) {
    if (!e.statusCode) log.error(e);
    out = Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ error: e.statusCode ? e.message : 'Selah couldn’t answer that.' }))]);
  }
  // First byte inside the seal: 0 JSON, 1 a picture's bytes, 2 an error.
  send(200, seal(key, `${id}<`, out), 'application/octet-stream');
}

function stop() {
  server?.close();
  server?.closeAllConnections?.();
  server = null;
  listening = null;
}

function start(log) {
  stop();
  const s = state();
  if (!s.on) return;
  const srv = http.createServer((req, res) => {
    onRequest(req, res, log).catch((e) => { log.error(e); try { res.writeHead(500); res.end(); } catch { /* gone */ } });
  });
  srv.requestTimeout = 30_000;
  srv.headersTimeout = 10_000;
  srv.on('error', (e) => {
    listening = { error: e.code === 'EADDRINUSE' ? `Port ${s.port} is in use by another program.` : e.message };
    log.error(`Companion sync: ${e.message}`);
  });
  srv.listen(s.port, '0.0.0.0', () => {
    listening = { port: s.port };
    log.info(`Companion sync is listening on port ${s.port}.`);
  });
  server = srv;
}

// ---------- Settings ----------

function view() {
  const s = state();
  return {
    on: s.on, port: s.port, listening: !!listening?.port, error: listening?.error ?? null, addresses: addresses(), name: os.hostname(),
    devices: s.devices.filter((d) => d.confirmed_at).map((d) => ({ id: d.id, name: d.name || 'iPad', paired_at: d.confirmed_at, last_seen_at: d.last_seen_at ?? null })),
  };
}

export default async function companionSync(app) {
  if (config.edition !== 'desktop') return;
  mainApp = app;
  app.addHook('onReady', async () => start(app.log));
  app.addHook('onClose', async () => stop());

  app.get('/api/companion-sync', async () => view());

  // Body: { on }.
  app.put('/api/companion-sync', async (req) => {
    const s = state();
    s.on = !!req.body?.on;
    save(s);
    start(app.log);
    // Give the listener a moment to say whether the port was free.
    await new Promise((r) => setTimeout(r, 300));
    return view();
  });

  /** A code for one iPad to scan: this PC's addresses and a key made for it. Good for ten minutes. */
  app.post('/api/companion-sync/pair', async () => {
    const s = state();
    if (!s.on) throw httpError(400, 'Turn Companion sync on first.');
    if (s.devices.filter((d) => d.confirmed_at).length >= MAX_DEVICES) throw httpError(400, `That’s ${MAX_DEVICES} iPads already. Remove one first.`);
    const key = crypto.randomBytes(32);
    const device = { id: b64u(crypto.randomBytes(9)), name: '', key: encrypt(key.toString('base64')), created_at: Date.now(), confirmed_at: null, last_seen_at: null, last_n: 0 };
    s.devices = s.devices.filter((d) => d.confirmed_at); // one code waiting at a time
    s.devices.push(device);
    save(s);
    const code = `selah-sync:1?${new URLSearchParams({ h: `${os.hostname()}.local`, a: addresses().join(','), p: String(s.port), d: device.id, k: b64u(key), s: s.serverId, n: os.hostname() })}`;
    return { code, qr: await QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), expires_at: device.created_at + PAIR_MINUTES * 60_000 };
  });

  app.delete('/api/companion-sync/devices/:id', async (req) => {
    const s = state();
    const before = s.devices.length;
    s.devices = s.devices.filter((d) => d.id !== String(req.params.id));
    if (s.devices.length === before) throw httpError(404, 'That iPad is already removed.');
    save(s);
    return view();
  });
}
