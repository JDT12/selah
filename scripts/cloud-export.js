// Packs this home server's Selah for moving to a cloud server (6.0.1). Usage:
//   npm run cloud-export -- <folder> [--with-offsite]
// The folder gets a consistent copy of the database (taken while the server runs), the attachments, the secrets key
// (wordpress.key, which unlocks the saved WordPress, Zotero and ESV keys), shared captures and the Windows app
// downloads, plus manifest.json: counts and a SHA-256 for every file, which the cloud server checks when it imports
// it (npm run admin -- import). --with-offsite also brings the OneDrive backup connection; leave it out for a trial
// copy, so the home server and the cloud don't both back up into the same OneDrive folder. Nothing here is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { config } from '../server/config.js';

const argv = process.argv.slice(2);
const out = argv.find((a) => !a.startsWith('--'));
const withOffsite = argv.includes('--with-offsite');
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (!out) fail('Usage: npm run cloud-export -- <folder> [--with-offsite]');
if (config.mode !== 'single') fail('Run this on the home server (single mode).');
if (!fs.existsSync(config.storageMarker)) fail(`The notes disk isn't there (${config.storageDir}).`);
const dest = path.resolve(out);
if (fs.existsSync(dest) && fs.readdirSync(dest).length) fail(`${dest} isn't empty.`);

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const files = [];
async function copyTree(from, to, rel) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, `${rel}/${e.name}`);
    else if (e.isFile()) {
      fs.copyFileSync(a, b);
      fs.chmodSync(b, 0o600);
      files.push({ path: `${rel}/${e.name}`, size: fs.statSync(b).size, sha256: await sha256(b) });
    }
  }
}

fs.mkdirSync(path.join(dest, 'storage'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dest, 'data'), { recursive: true, mode: 0o700 });

// The database: an online backup, so it's consistent even while Selah is writing.
const dbOut = path.join(dest, 'storage', 'notes.db');
const src = new DatabaseSync(config.dbPath, { readOnly: true });
try { await backup(src, dbOut); } finally { src.close(); }
// One self-contained file (no -wal/-shm beside it); Selah turns WAL back on when it opens it.
const snap = new DatabaseSync(dbOut);
snap.exec('PRAGMA journal_mode = DELETE');
const count = (table) => { try { return snap.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; } };
const counts = {
  notes: snap.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL').get().n,
  notesInTrash: snap.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL').get().n,
  notebooks: count('notebooks'), attachments: count('attachments'), tags: count('tags'), tasks: count('tasks'),
  events: count('events'), prayers: count('prayers'), sermons: count('sermons'), studies: count('studies'),
};
const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
snap.close();
if (integrity !== 'ok') fail(`The database copy failed its integrity check: ${integrity}`);
fs.chmodSync(dbOut, 0o600);
files.push({ path: 'storage/notes.db', size: fs.statSync(dbOut).size, sha256: await sha256(dbOut) });

await copyTree(config.filesDir, path.join(dest, 'storage', 'files'), 'storage/files');
// From the data folder, only what a tenant uses (not certificates, local backups or caches).
async function copyOne(rel) {
  const a = path.join(config.dataDir, rel);
  if (!fs.existsSync(a)) return;
  const b = path.join(dest, 'data', rel);
  fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
  fs.copyFileSync(a, b);
  fs.chmodSync(b, 0o600);
  files.push({ path: `data/${rel}`, size: fs.statSync(b).size, sha256: await sha256(b) });
}
await copyOne('wordpress.key');
await copyTree(path.join(config.dataDir, 'shares'), path.join(dest, 'data', 'shares'), 'data/shares');
await copyTree(path.join(config.dataDir, 'desktop'), path.join(dest, 'data', 'desktop'), 'data/desktop');
if (withOffsite) await copyOne(path.join('offsite', 'rclone.conf'));

const pkg = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'));
const manifest = {
  format: 'selah-move-1',
  version: pkg.version,
  exportedAt: Date.now(),
  from: os.hostname(),
  timeZone: config.timeZone,
  withOffsite,
  counts,
  files,
};
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`✓ Exported to ${dest}: ${counts.notes} notes, ${counts.notebooks} notebooks, ${counts.attachments} attachments; ${files.length} files, ${(total / 1e6).toFixed(0)} MB`);
console.log(withOffsite ? '  With the OneDrive backup connection: stop the home server’s backups once the cloud copy is in use.' : '  Without the OneDrive backup connection (a trial copy).');
