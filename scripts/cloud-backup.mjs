#!/usr/bin/env node
// Selah Cloud (14.1): the whole library as a backup file on standard output, for `selah backup` on the server
// (docker/cloud/selah), which saves it beside the install. The same file Settings → Data & backup downloads without a
// passphrase (a .tar.gz), so it restores the same way, here or into Selah Desktop or a Ministry Selah.
//   docker compose exec -T selah node scripts/cloud-backup.mjs > selah-backup.tar.gz
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

if (process.stdout.isTTY) {
  console.error('This writes the backup to standard output: send it to a file (selah backup does).');
  process.exit(1);
}
const { db } = await import('../server/db.js');
const { writeBackup } = await import('../server/backupfile.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;

const tmp = fs.mkdtempSync(path.join(config.dataDir, 'download-'));
try {
  const snap = path.join(tmp, 'notes.db');
  await backup(db, snap);
  const check = new DatabaseSync(snap, { readOnly: true });
  const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
  check.close();
  await writeBackup(process.stdout, {
    snapshotDb: snap, filesDir: config.filesDir, dataDir: config.dataDir, keyData: config.secretKey, certDir: null,
    manifest: { app: 'Selah', kind: 'download', version: VERSION, createdAt: new Date().toISOString(), tenant: null, timeZone: config.timeZone, notes },
  });
  console.error(`Backed up ${notes} notes.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
