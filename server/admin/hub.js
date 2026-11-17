import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { cloud, listTenants } from './store.js';
import { paths, repoRoot } from './paths.js';
import { releaseDir, run } from './runner.js';

/**
 * The share hub (14.1, server/hub/): the console runs it and tells it who the Selahs are.
 *
 * With Docker it's one container (<prefix>-hub) from the main release's image, its records in <cloud root>/hub. Each
 * Selah runs on its own network (<prefix>-net-<name>), which only it and the hub are on: the hub joins every one as
 * "hub", so a Selah reaches http://hub:8090 and nothing else of the others. Without Docker (the process runner) the
 * hub is a service on 127.0.0.1 like the Selahs.
 *
 * Each Selah has its own key (kept here, given to the Selah in its environment, sent to the hub as a hash's source).
 * The console reaches the hub's own port on 127.0.0.1 with the control token.
 */

const docker = () => cloud().runner === 'docker';
export const hubName = () => `${cloud().unitPrefix}-hub`;
export const netName = (slug) => `${cloud().unitPrefix}-net-${slug}`;
const hubPort = () => Number(cloud().hubPort ?? 9440);
const hubControlPort = () => Number(cloud().hubControlPort ?? 9441);
const hubDir = () => path.join(paths.root, 'hub');
const token = (bytes) => crypto.randomBytes(bytes).toString('hex');
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };

function controlToken() {
  let t = getSetting('hub_control_token');
  if (!t) { t = token(32); setSetting('hub_control_token', t); }
  return t;
}

/** The Selah's key for the hub (made the first time). */
export function hubKey(slug) {
  const keys = json(getSetting('hub_keys'), {});
  if (!keys[slug]) { keys[slug] = token(32); setSetting('hub_keys', JSON.stringify(keys)); }
  return keys[slug];
}
function dropKey(slug) {
  const keys = json(getSetting('hub_keys'), {});
  delete keys[slug];
  setSetting('hub_keys', JSON.stringify(keys));
}

/** What a Selah's environment gets to reach the hub (store.js tenantEnv). */
export const hubEnv = (slug, { docker: inDocker = false } = {}) => ({
  NOTEAPP_HUB_URL: inDocker ? 'http://hub:8090' : `http://127.0.0.1:${hubPort()}`,
  NOTEAPP_HUB_KEY: hubKey(slug),
});

/** A request to the hub's control port. */
export async function hubControl(method, url, body, { timeout = 10_000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${hubControlPort()}${url}`, {
    method,
    headers: { authorization: `Bearer ${controlToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The share hub answered ${res.status}`), { statusCode: res.status });
  return data;
}

// ---------- networks ----------

/**
 * The range each Selah's network gets a small piece of (cloud.netBase, a /16; default 10.201.0.0). Docker's own pools
 * run out after about 30 networks, so each network is given its own /29 (room for the Selah and the hub) from here:
 * 8,192 of them. The Selahs trust this range for the gateway's forwarded addresses (store.js).
 */
export const netBase = () => cloud().netBase || '10.201.0.0';
export const netRange = () => `${netBase()}/16`;

function subnetFor(slug) {
  const nets = json(getSetting('hub_nets'), {});
  if (nets[slug] == null) {
    const used = new Set(Object.values(nets));
    let i = 0;
    while (used.has(i)) i++;
    if (i >= 8192) throw new Error('No room left for another Selah’s network.');
    nets[slug] = i;
    setSetting('hub_nets', JSON.stringify(nets));
  }
  const [a, b] = netBase().split('.').map(Number);
  const n = nets[slug] * 8;
  return `${a}.${b}.${Math.floor(n / 256)}.${n % 256}/29`;
}

/** The Selah's own network (made if it isn't there), for the runner to start it on. */
export async function ensureNetwork(slug) {
  const name = netName(slug);
  const has = await run('docker', ['network', 'inspect', name]);
  if (!has.ok) {
    const r = await run('docker', ['network', 'create', '--driver', 'bridge', '--subnet', subnetFor(slug), '--label', 'selah=tenant-net', name]);
    if (!r.ok && !/already exists/.test(r.stderr)) throw new Error(`docker network create ${name}: ${r.stderr.trim()}`);
  }
  return name;
}

/** The hub on the Selah's network as "hub" (nothing if the hub isn't running; it joins them all when it starts). */
export async function joinHub(slug) {
  if (!docker()) return;
  const r = await run('docker', ['network', 'connect', '--alias', 'hub', netName(slug), hubName()]);
  if (!r.ok && !/already exists|is already connected|No such container/i.test(r.stderr)) throw new Error(`docker network connect: ${r.stderr.trim()}`);
}

export async function dropNetwork(slug) {
  if (!docker()) return;
  await run('docker', ['network', 'disconnect', '-f', netName(slug), hubName()]);
  await run('docker', ['network', 'rm', netName(slug)]);
  const nets = json(getSetting('hub_nets'), {});
  delete nets[slug];
  setSetting('hub_nets', JSON.stringify(nets));
}

// ---------- running it ----------

/**
 * The release the hub runs from: main if it has the hub (14.1 or later), else the beta if that has it (while 14.1 is
 * being tried on the demo, main is still older), else the console's own code (process runner) or nothing.
 */
function hubRelease() {
  const has = (r) => fs.existsSync(path.join(releaseDir(r), 'server', 'hub', 'main.js'));
  for (const r of [getSetting('current_release'), getSetting('beta_release')].filter(Boolean)) if (has(r)) return r;
  return null;
}
const image = () => (hubRelease() ? `selah:${hubRelease()}` : null);
const unit = () => `${cloud().unitPrefix}-hub.service`;

/** Is the hub running, and on which image (Docker)? */
async function state() {
  if (docker()) {
    const r = await run('docker', ['inspect', '-f', '{{.State.Status}} {{.Config.Image}}', hubName()]);
    const [status, img] = r.stdout.trim().split(' ');
    return { running: status === 'running', image: img ?? null };
  }
  const r = await run('systemctl', ['--user', 'is-active', unit()]);
  return { running: r.stdout.trim() === 'active', image: null };
}

/** Starts the hub (again), on the main release. */
export async function startHub() {
  fs.mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  const env = {
    NODE_ENV: 'production',
    NOTEAPP_HUB_CONTROL_TOKEN: controlToken(),
  };
  if (docker()) {
    await run('docker', ['rm', '-f', hubName()]);
    const envFile = path.join(hubDir(), 'hub.docker.env');
    fs.writeFileSync(envFile, Object.entries({ ...env, NOTEAPP_HUB_DIR: '/data/hub', NOTEAPP_HUB_CONTROL_IFACE: 'eth0' }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const r = await run('docker', [
      'run', '-d', '--name', hubName(), '--restart', 'unless-stopped', '--env-file', envFile,
      '-v', `${hubDir()}:/data/hub`, '-p', `127.0.0.1:${hubControlPort()}:8091`,
      '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '256',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${process.getuid()}:${process.getgid()}`,
      image(), 'node', 'server/hub/main.js',
    ]);
    if (!r.ok) throw new Error(`Couldn’t start the share hub: ${r.stderr.trim()}`);
    for (const t of listTenants()) {
      await ensureNetwork(t.slug).catch(() => {});
      await joinHub(t.slug).catch(() => {});
    }
  } else {
    const dir = releaseDir(hubRelease());
    await run('systemctl', ['--user', 'stop', unit()]);
    await run('systemctl', ['--user', 'reset-failed', unit()]);
    const r = await run('systemd-run', [
      '--user', `--unit=${unit()}`, '--description=Selah share hub', '--collect', '--quiet', `--working-directory=${fs.existsSync(dir) ? dir : repoRoot}`,
      ...Object.entries({ ...env, NOTEAPP_HUB_DIR: hubDir(), NOTEAPP_HUB_HOST: '127.0.0.1', NOTEAPP_HUB_PORT: hubPort(),
        NOTEAPP_HUB_CONTROL_HOST: '127.0.0.1', NOTEAPP_HUB_CONTROL_PORT: hubControlPort() }).map(([k, v]) => `--setenv=${k}=${v}`),
      '--property=Restart=on-failure', '--property=RestartSec=3', '--property=NoNewPrivileges=yes', '--property=UMask=0077',
      process.execPath, 'server/hub/main.js',
    ]);
    if (!r.ok) throw new Error(`Couldn’t start the share hub: ${r.stderr.trim()}`);
  }
  // Up within half a minute.
  for (let i = 0; i < 30; i++) {
    try { await hubControl('GET', '/control/health', undefined, { timeout: 2000 }); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error('The share hub didn’t answer after it started.');
}

export async function stopHub() {
  if (docker()) await run('docker', ['rm', '-f', hubName()]);
  else await run('systemctl', ['--user', 'stop', unit()]);
}

/** Every Selah, its name, key and whether it may share, to the hub. */
export async function syncHub() {
  const off = new Set(cloud().sharingOff ?? []);
  for (const t of listTenants()) {
    await hubControl('PUT', `/control/tenants/${t.slug}`, { name: t.name || t.slug, key: hubKey(t.slug), active: t.status === 'active', sharing: !off.has(t.slug) });
  }
}

/** The 8.0 relay's contacts, into the hub once (shares come from their owners' Selahs). */
async function importRelay() {
  if (getSetting('hub_imported')) return;
  const { db } = await import('../db.js');
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'relay_contacts'").get();
  const contacts = has ? db.prepare('SELECT a, b, status, requested_by, at FROM relay_contacts').all() : [];
  await hubControl('POST', '/control/import', { contacts });
  setSetting('hub_imported', String(Date.now()));
}

/**
 * Keeps the hub running on the main release with every Selah known to it. From the monitor every minute, and at
 * start. Returns what it did, for the log.
 */
export async function checkHub(logger) {
  const s = await state();
  const want = docker() ? image() : null;
  if (docker() && !want) return 'no release with the hub yet';
  if (!s.running || (want && s.image !== want)) {
    if (docker() && !(await run('docker', ['image', 'inspect', want])).ok) return 'no image yet';
    await startHub();
    logger?.info?.(`Share hub started${want ? ` on ${want}` : ''}.`);
  }
  await syncHub();
  await importRelay();
  return 'ok';
}

export async function forgetInHub(slug) {
  await hubControl('DELETE', `/control/tenants/${slug}`).catch(() => {});
  await dropNetwork(slug).catch(() => {});
  dropKey(slug);
}
