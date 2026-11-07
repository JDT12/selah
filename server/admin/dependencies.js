import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rcloneVersion } from '../rclone.js';
import { cloud } from './store.js';
import { repoRoot } from './paths.js';

/**
 * What Selah depends on, with the versions on this server (Docs → Dependencies): the server's own software, the
 * pinned tools Selah installs itself, what each tenant's container is built from, the Node packages it runs, and the
 * outside services it talks to. Each says what it's for and how it's updated (MAINTENANCE-PROCEDURE.md says when).
 */

const CACHE_MS = 10 * 60_000;
let cache = { at: 0, value: null };

const sh = (cmd, args, timeout = 5000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});
const read = (file) => { try { return fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { return ''; } };
/** A pinned version from one of the install scripts or the Dockerfile. */
const pinned = (file, re) => read(file).match(re)?.[1] ?? null;

function osName() {
  try { return fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null; } catch { return null; }
}

const caddyPath = () => [process.env.NOTEAPP_CADDY, path.join(os.homedir(), '.local', 'bin', 'caddy')].find((p) => p && fs.existsSync(p)) ?? 'caddy';

async function collect() {
  const docker = cloud().runner === 'docker';
  const [dockerVer, caddyVer, unattended, dockerEnabled, images] = await Promise.all([
    docker ? sh('docker', ['version', '--format', '{{.Server.Version}}']) : null,
    sh(caddyPath(), ['version']),
    sh('systemctl', ['is-enabled', 'unattended-upgrades']),
    docker ? sh('systemctl', ['is-enabled', 'docker']) : null,
    docker ? sh('docker', ['image', 'ls', 'selah', '--format', '{{.Tag}}']) : null,
  ]);
  const nodePin = pinned('scripts/cloud-setup.sh', /^NODE_VERSION=(\S+)/m);
  const caddyPin = pinned('scripts/install-caddy.sh', /^VERSION=(\S+)/m);
  const rclonePin = pinned('scripts/install-rclone.sh', /^VERSION=(\S+)/m);
  const imageBase = pinned('Dockerfile', /^FROM\s+(\S+)/m);

  const server = [
    { name: 'Operating system', installed: osName() ?? `${os.type()} ${os.release()}`, purpose: 'Runs everything.', update: 'sudo apt update && sudo apt full-upgrade (security updates also install by themselves each day)', restart: 'Reboot when /var/run/reboot-required exists', note: unattended ? `Automatic security updates: ${unattended}` : null },
    { name: 'Linux kernel', installed: os.release(), purpose: 'The operating system’s core.', update: 'Comes with the system updates', restart: 'Reboot to use a new one' },
    ...(docker ? [{ name: 'Docker Engine', installed: dockerVer ?? 'not answering', purpose: 'Runs each tenant’s Selah in its own container.', update: 'Comes with the system updates (the docker.io package)', restart: 'Stop Selah first: an update restarts Docker', note: dockerEnabled ? `Starts at boot: ${dockerEnabled}` : null }] : []),
    { name: 'systemd (user services)', installed: 'selah-admin, selah-gateway', purpose: 'Starts the console and the gateway at boot (linger is on for this user).', update: 'Comes with the system updates', restart: '—' },
  ];
  const tools = [
    { name: 'Node.js', installed: process.version.replace(/^v/, ''), expected: nodePin, purpose: 'Runs the admin console and its command line, and builds Selah.', update: 'Bump NODE_VERSION (and its checksums) in scripts/cloud-setup.sh, run it again, then restart the console', restart: 'The console', where: '~/.local/node' },
    { name: 'Caddy (with the Cloudflare DNS module)', installed: caddyVer?.split(' ')[0]?.replace(/^v/, '') ?? 'not found', expected: caddyPin, purpose: 'The gateway: HTTPS for every address, and Let’s Encrypt certificates through Cloudflare.', update: 'Bump VERSION in scripts/install-caddy.sh, then npm run install-caddy', restart: 'The gateway (systemctl --user restart selah-gateway)', where: '~/.local/bin/caddy' },
    { name: 'rclone', installed: rcloneVersion()?.replace(/^v/, '') ?? 'not found', expected: rclonePin, purpose: 'The host backup (and, inside each container, tenants’ own off-site backups).', update: 'Bump VERSION in scripts/install-rclone.sh, then npm run install-rclone (the containers get it at the next Prepare release)', restart: 'Nothing', where: '~/.local/bin/rclone' },
  ];
  const image = docker ? [
    { name: 'Tenant image base', installed: imageBase, purpose: 'What each tenant’s container is built on: Node.js on Debian (slim).', update: 'docker pull ' + (imageBase ?? 'the base image') + ', then Prepare release and Update all (Updates) to rebuild with Debian’s fixes; bump the FROM line in the Dockerfile for a new Node.js', restart: 'Tenants, one at a time (Update all)' },
    { name: 'Tenant images on this server', installed: images ? images.split('\n').filter(Boolean).sort().reverse().slice(0, 6).join(', ') : '—', purpose: 'One per prepared release (selah:<version>); tenants run the newest.', update: 'Prepare release', restart: '—' },
  ] : [];

  const pkg = JSON.parse(read('package.json') || '{}');
  const installedOf = (n) => { try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', n, 'package.json'), 'utf8')).version; } catch { return null; } };
  const packages = Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({ name, range, installed: installedOf(name), purpose: PACKAGE_PURPOSE[name] ?? '' }));
  const built = Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({ name, range, installed: installedOf(name) }));

  return { at: Date.now(), selah: pkg.version, server, tools, image, packages, built, services: SERVICES };
}

const PACKAGE_PURPOSE = {
  fastify: 'The web server', '@fastify/cookie': 'Sign-in cookies', '@fastify/multipart': 'Uploads', '@fastify/static': 'Serving the page and files',
  '@fontsource/cormorant-garamond': 'The Selah wordmark font', '@mozilla/readability': 'Web clipper: the article from a page',
  '@tesseract.js-data/eng': 'Handwriting and photo text (English data)', 'tesseract.js': 'Handwriting and photo text (OCR)',
  citeproc: 'Citations and bibliographies', 'ffmpeg-static': 'Audio and video thumbnails and recordings', 'heic-convert': 'iPhone photos (HEIC → JPEG)',
  marked: 'Markdown import and the changelogs', qrcode: 'Two-step sign-in and phone-remote QR codes', rrule: 'Repeating events and tasks',
  sax: '.enex file import', undici: 'Safe fetching of outside addresses (clipped pages, calendar feeds, the WordPress site)',
};

/** Services outside this server that Selah uses. */
const SERVICES = [
  { name: 'Your DNS provider', for: 'The wildcard record for the domain (with Cloudflare, also the API token the gateway can use to prove the domain to Let’s Encrypt)' },
  { name: 'Let’s Encrypt', for: 'The HTTPS certificate (renewed by Caddy 30 days ahead)' },
  { name: 'The host backup’s storage', for: 'Where the nightly encrypted backup of every tenant goes (Backups)' },
  { name: 'GitHub', for: 'The code and its releases (updates), and Selah Desktop’s builds' },
  { name: 'Microsoft (OneDrive sign-in)', for: 'Connecting OneDrive for backups' },
  { name: 'Crossway ESV API', for: 'Bible passages, per tenant with their own key' },
  { name: 'Zotero, WordPress', for: 'Per tenant, when they connect them' },
  { name: 'Have I Been Pwned (passwords)', for: 'Checking new passwords against known breaches (only a hash prefix is sent)' },
  { name: 'The VPS provider', for: 'The server itself' },
];

export async function dependencies({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  cache = { at: Date.now(), value: await collect() };
  return cache.value;
}
