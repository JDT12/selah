// Rebuilds this server's notes, attachments, certificates and WordPress key from the encrypted
// off-site backup (Settings → Off-site backup: OneDrive, S3-compatible storage or WebDAV), or from a
// backup file (Settings → Data & backup → Download a backup), e.g. on a new server after the old one was lost.
//
// Usage: npm run restore                          (asks where the backup is, the sign-in and the passphrase)
//        npm run restore -- --snapshot notes-20261018T031500Z.db.gz   (an older snapshot)
//        npm run restore -- --rclone-config FILE  (use an existing rclone config, e.g. the old
//                                                  server's data/offsite/rclone.conf)
//        npm run restore -- --file FILE           (a downloaded .selahbak or .tar.gz, or a nightly
//                                                  data/backups/note-app-*.tar.gz; no rclone needed)
//        npm run restore -- --force               (move existing data aside first)
//
// Paths come from NOTEAPP_DATA_DIR / NOTEAPP_STORAGE_DIR like the server. Run it with the server stopped.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';
import {
  FOLDER, buildConf, onedriveDrive, onedriveSection, parseToken, rclonePath, rcloneRunner, storageSection, storageTarget, writeConf,
} from '../server/rclone.js';
import {
  backupKind, installUnpacked, passphraseFits, scrubRestoredDb, unpackBackup,
} from '../server/backupfile.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const force = args.includes('--force');
const started = Date.now();
const CONF = path.join(config.dataDir, 'offsite', 'rclone.conf');
const TMP = path.join(config.dataDir, 'offsite', 'restore-tmp');
const stampNow = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const step = (msg) => console.log(`\n▸ ${msg}`);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const when = (snap) => {
  const m = snap.match(/notes-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toLocaleString() : snap;
};

// ---------- prompts (the passphrase isn't echoed) ----------
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: out, terminal: true }) : null;
const ask = (q, { secret = false } = {}) => new Promise((resolve) => {
  if (!rl) fail(`${q.trim()} needs an interactive terminal (or use --rclone-config).`);
  process.stdout.write(q);
  muted = secret;
  rl.question('', (a) => { if (secret) process.stdout.write('\n'); muted = false; resolve(a); });
});

const fromFile = opt('--file');
console.log(fromFile ? 'Selah restore from a backup file' : 'Selah restore from the off-site backup');
console.log(`  data:  ${config.dataDir}\n  notes: ${config.storageDir}`);

// ---------- 1. preflight ----------
/** Without --force, a server that already has data isn't touched. */
function existingCheck() {
  const existing = [config.dbPath, config.filesDir, config.certDir, path.join(config.dataDir, 'wordpress.key')]
    .filter((p) => fs.existsSync(p) && (!fs.statSync(p).isDirectory() || fs.readdirSync(p).length));
  if (existing.length && !force) {
    fail(`This server already has data:\n  ${existing.join('\n  ')}\n`
      + 'Restoring would replace it. Run again with --force to move it aside first (nothing is deleted).');
  }
  return existing;
}
function moveAside() {
  for (const p of existingCheck()) {
    fs.renameSync(p, `${p}.pre-restore-${stampNow}`);
    for (const x of ['-wal', '-shm']) if (fs.existsSync(p + x)) fs.renameSync(p + x, `${p}${x}.pre-restore-${stampNow}`);
    console.log(`  moved aside: ${p}.pre-restore-${stampNow}`);
  }
}

// ---------- from a backup file: unpack and check it, then put it in place ----------
if (fromFile) {
  const file = path.resolve(fromFile);
  if (!fs.existsSync(file)) fail(`No such file: ${file}`);
  const kind = backupKind(file);
  if (kind !== 'encrypted' && kind !== 'plain') fail('That isn’t a Selah backup file (.selahbak, or a .tar.gz from Download a backup or data/backups/).');
  let passphrase = null;
  if (kind === 'encrypted') {
    passphrase = process.env.NOTEAPP_RESTORE_PASSPHRASE ?? await ask('  Backup passphrase: ', { secret: true });
    if (!await passphraseFits(file, passphrase)) fail('That’s not the passphrase this backup was made with.');
  }
  // Moving aside first would leave a half-restored server if the file turns out damaged, so check it first.
  existingCheck();
  step(`Unpacking and checking ${path.basename(file)}`);
  const scratch = path.join(config.storageDir, `.restore-${stampNow}`);
  const r = await unpackBackup(file, passphrase, scratch).catch((e) => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fail(e.message);
  });
  console.log(`  ✓ opens cleanly: ${r.notes} notes, ${r.files} files (${mb(r.bytes)})${r.createdAt ? `, made ${new Date(r.createdAt).toLocaleString()}` : ''}`);
  if (r.missing.length) console.log(`  ⚠ ${r.missing.length} attachment(s) the database refers to aren’t in the file: ${r.missing.slice(0, 10).join(', ')}${r.missing.length > 10 ? '…' : ''}`);
  if (r.manifest?.tenant) console.log(`  (a backup of the hosted Selah “${r.manifest.tenant}”: on a Selah host, npm run admin -- restore-file ${r.manifest.tenant} <file> puts it back there)`);
  step('Putting it in place');
  moveAside();
  scrubRestoredDb(path.join(scratch, 'notes.db'));
  installUnpacked(scratch, { db: config.dbPath, files: config.filesDir, data: config.dataDir, certs: config.certDir });
  if (!fs.existsSync(config.storageMarker)) fs.writeFileSync(config.storageMarker, 'Note App notes storage. Do not delete.\n');
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`  ✓ ${config.dbPath}\n  ✓ ${config.filesDir}${r.wordpressKey ? `\n  ✓ ${path.join(config.dataDir, 'wordpress.key')}` : ''}${r.certs ? `\n  ✓ ${config.certDir}` : ''}`);
  console.log(`
✓ Restored in ${Math.round((Date.now() - started) / 1000)} s: ${r.notes} notes, ${r.files} files.

Next:
  1. Start it:   bash scripts/install-service.sh      (or "npm start" to try it first)
  2. Sign in with the password the backup was made with (it's part of the restored data). Every device signs in again.
  3. Off-site backup isn't part of a backup file: set it up again in Settings → Off-site backup.`);
  rl?.close();
  process.exit(0);
}

if (!rclonePath()) fail('rclone isn’t installed. Run: npm run install-rclone');
moveAside();

// ---------- 2. connect to the storage ----------
step('Connecting to the backup storage');
const fromConf = opt('--rclone-config');
let root = null; // where the encrypted folder is, when this script writes the config
if (fromConf) {
  if (!fs.existsSync(fromConf)) fail(`No such file: ${fromConf}`);
  writeConf(CONF, fs.readFileSync(fromConf, 'utf8'));
  console.log(`  using ${fromConf}`);
} else {
  let storage;
  root = `target:${FOLDER}`;
  if (process.env.NOTEAPP_OFFSITE_TEST_REMOTE) {
    storage = onedriveSection({ testDir: process.env.NOTEAPP_OFFSITE_TEST_REMOTE, name: 'target' });
  } else {
    const where = (await ask('  Where is the backup?\n    1. OneDrive\n    2. S3-compatible storage (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3…)\n    3. WebDAV (Nextcloud, Synology…)\n  Choose [1]: ')).trim() || '1';
    if (where === '1') {
      console.log('  On a computer with a web browser, download rclone (https://rclone.org/downloads/), run:\n'
        + '      rclone authorize "onedrive"\n'
        + '  sign in with the Microsoft account that holds the backup, and paste what it prints between\n'
        + '  "--->" and "<---End paste" here, then press Enter.');
      let token = null;
      let pasted = '';
      while (!token) {
        pasted += `${await ask(pasted ? '' : '  > ')}\n`;
        try { token = parseToken(pasted); } catch { if (pasted.length > 20000) fail('That isn’t what rclone authorize prints.'); }
      }
      const drive = await onedriveDrive(token).catch((e) => fail(e.message));
      console.log(`  signed in: ${drive.account}’s OneDrive`);
      storage = onedriveSection({ token, drive, name: 'target' });
    } else if (where === '2') {
      const services = ['b2', 'wasabi', 'r2', 'aws', 's3'];
      const service = services[Number((await ask('  Which?  1. Backblaze B2  2. Wasabi  3. Cloudflare R2  4. Amazon S3  5. Other  [1]: ')).trim() || 1) - 1] ?? fail('No such number.');
      const input = { provider: 's3', service, bucket: await ask('  Bucket: ') };
      if (['wasabi', 'r2', 's3'].includes(service)) input.endpoint = await ask(`  Endpoint${service === 'wasabi' ? ' [s3.wasabisys.com]' : ''}: `);
      if (service === 'aws' || service === 's3') input.region = await ask(`  Region${service === 's3' ? ' (Enter if none)' : ''}: `);
      input.keyId = await ask(service === 'b2' ? '  Key ID: ' : '  Access key ID: ');
      input.secret = await ask(service === 'b2' ? '  Application key: ' : '  Secret access key: ', { secret: true });
      const t = await storageTarget(input).catch((e) => fail(e.message));
      storage = await storageSection(t);
      root = t.root;
    } else if (where === '3') {
      const t = await storageTarget({
        provider: 'webdav', url: await ask('  Server address (https://…): '), user: await ask('  User name: '), pass: await ask('  Password: ', { secret: true }),
      }).catch((e) => fail(e.message));
      storage = await storageSection(t);
      root = t.root;
    } else {
      fail('Choose 1, 2 or 3.');
    }
  }
  const passphrase = process.env.NOTEAPP_RESTORE_PASSPHRASE ?? await ask('  Backup passphrase: ', { secret: true });
  writeConf(CONF, await buildConf(storage, passphrase, root));
}
const rclone = rcloneRunner(CONF);
const manifest = await rclone(['cat', 'offsite:manifest.json']).then((t) => {
  if (!t.trim()) throw new Error('not found'); // S3 prints nothing for a file it can't find
  return JSON.parse(t);
}).catch((e) => fail(
  /not found/i.test(e.message)
    ? `Couldn’t open the backup in the folder “${FOLDER}”: either the passphrase is wrong, or this `
      + 'storage has no Selah backup.'
    : `Couldn’t read the backup: ${e.message}`,
));
console.log(`  latest backup: ${new Date(manifest.createdAt).toLocaleString()} (app ${manifest.version}), `
  + `${manifest.notes} notes, ${manifest.files.count} attachments (${mb(manifest.files.bytes)})`);

// ---------- 3. choose a snapshot ----------
const snaps = (await rclone(['lsf', '--files-only', 'offsite:db'])).split('\n').filter((n) => /^notes-.*\.db\.gz$/.test(n)).sort().reverse();
if (!snaps.length) fail('The backup has no database snapshots.');
let snap = opt('--snapshot');
if (snap && !snaps.includes(snap)) fail(`No snapshot named ${snap}. Available:\n  ${snaps.join('\n  ')}`);
if (!snap && rl && snaps.length > 1) {
  console.log('\n  Snapshots (newest first):');
  snaps.slice(0, 15).forEach((s, i) => console.log(`   ${String(i + 1).padStart(2)}. ${when(s)}${i === 0 ? '  (latest)' : ''}`));
  const pick = Number((await ask('  Restore which? [1] ')) || 1);
  snap = snaps[pick - 1] ?? fail('No such number.');
}
snap ??= snaps[0];

// ---------- 4. database ----------
step(`Downloading the database snapshot from ${when(snap)}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
await rclone(['copyto', `offsite:db/${snap}`, path.join(TMP, snap)]);
const snapDb = path.join(TMP, 'notes.db');
await pipeline(fs.createReadStream(path.join(TMP, snap)), zlib.createGunzip(), fs.createWriteStream(snapDb));
const check = new DatabaseSync(snapDb, { readOnly: true });
if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('That snapshot is damaged. Try an older one with --snapshot.');
const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
const needed = new Set(check.prepare('SELECT storage FROM attachments').all().map((r) => r.storage));
try {
  const banner = JSON.parse(check.prepare("SELECT value FROM settings WHERE key = 'banner'").get()?.value ?? 'null');
  if (banner?.storage) needed.add(banner.storage);
} catch { /* no banner */ }
check.close();
console.log(`  ✓ opens cleanly: ${notes} notes, ${needed.size} files referenced`);

// ---------- 5. attachments ----------
step('Downloading attachments');
fs.mkdirSync(config.filesDir, { recursive: true });
if (!fs.existsSync(config.storageMarker)) fs.writeFileSync(config.storageMarker, 'Note App notes storage. Do not delete.\n');
await rclone(['copy', 'offsite:files', config.filesDir, '--transfers', '8'], { progress: !!process.stdout.isTTY });
let missing = [...needed].filter((n) => !fs.existsSync(path.join(config.filesDir, n)));
if (missing.length) {
  // An older snapshot can refer to files deleted since; those are kept in deleted/<date>/ for a while.
  console.log(`  ${missing.length} file(s) not in the latest set; looking in recently deleted…`);
  const deleted = (await rclone(['lsf', '-R', '--files-only', 'offsite:deleted']).catch(() => '')).split('\n').filter(Boolean).sort().reverse();
  for (const name of missing) {
    const hit = deleted.find((d) => d.endsWith(`/${name}`));
    if (hit) await rclone(['copyto', `offsite:deleted/${hit}`, path.join(config.filesDir, name)]);
  }
  missing = missing.filter((n) => !fs.existsSync(path.join(config.filesDir, n)));
}
const files = fs.readdirSync(config.filesDir);
const bytes = files.reduce((t, f) => t + fs.statSync(path.join(config.filesDir, f)).size, 0);
console.log(`  ✓ ${files.length} files (${mb(bytes)})`);
if (missing.length) console.log(`  ⚠ ${missing.length} attachment(s) the snapshot refers to aren’t in the backup: ${missing.join(', ')}`);

step('Checking every attachment against the backup');
try {
  await rclone(['cryptcheck', '--one-way', config.filesDir, 'offsite:files']);
  console.log('  ✓ all match');
} catch (e) {
  if (snap === snaps[0]) fail(`Attachment check failed: ${e.message}`);
  console.log('  ✓ checked (some files came from “recently deleted”, which the check can’t compare: expected for an older snapshot)');
}

// ---------- 6. put the database in place ----------
step('Putting the database in place');
fs.mkdirSync(config.storageDir, { recursive: true });
fs.copyFileSync(snapDb, config.dbPath);
for (const x of ['-wal', '-shm']) fs.rmSync(config.dbPath + x, { force: true });
if (root) {
  // The restored settings must point where the config this script wrote keeps the backup.
  const d = new DatabaseSync(config.dbPath);
  const row = d.prepare("SELECT value FROM settings WHERE key = 'offsite'").get();
  if (row) {
    try {
      const c = JSON.parse(row.value);
      if (c.root !== root) d.prepare("UPDATE settings SET value = ? WHERE key = 'offsite'").run(JSON.stringify({ ...c, root }));
    } catch { /* not JSON: Settings will offer to set it up again */ }
  }
  d.close();
}
console.log(`  ✓ ${config.dbPath}`);

// ---------- 7. certificates and keys ----------
step('Restoring certificates and the WordPress key');
if (manifest.certs !== false) { // false: backed up from a server without TLS (a tenant), so there are none
  await rclone(['copy', 'offsite:config/certs', config.certDir]);
  for (const f of fs.readdirSync(config.certDir)) if (f.endsWith('.key')) fs.chmodSync(path.join(config.certDir, f), 0o600);
  console.log(`  ✓ ${fs.readdirSync(config.certDir).join(', ')}`);
}
if (manifest.wordpressKey) {
  const k = path.join(config.dataDir, 'wordpress.key');
  await rclone(['copyto', 'offsite:config/wordpress.key', k]);
  fs.chmodSync(k, 0o600);
  console.log('  ✓ wordpress.key (the WordPress connection works without signing in again)');
}
fs.rmSync(TMP, { recursive: true, force: true });

// ---------- done ----------
const hosts = fs.existsSync(path.join(config.certDir, 'hosts.txt')) ? fs.readFileSync(path.join(config.certDir, 'hosts.txt'), 'utf8').trim() : '?';
console.log(`
✓ Restored in ${Math.round((Date.now() - started) / 1000)} s: snapshot from ${when(snap)}, ${notes} notes, ${files.length} files.

Next:
  1. Start it:   bash scripts/install-service.sh      (or "npm start" to try it first)
  2. Address:    the certificate covers: ${hosts}
                 Point that name at this server in your DNS/router. Your devices keep trusting it,
                 because the certificate authority was restored. To add a new IP or name:
                   CERT_HOSTS="<ip> <name> localhost 127.0.0.1" npm run gen-certs
  3. Sign in with your usual password (it's part of the restored data).
  4. Nightly off-site backups carry on into the same folder. Make sure the old server is off,
     so two servers don't back up into it.`);
rl?.close();
