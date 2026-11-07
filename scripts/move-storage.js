// Sets up the notes storage directory (NOTEAPP_STORAGE_DIR, default ./notes-data) and moves an
// existing database and attachments there from the old location in the data directory.
// Stop the server first: systemctl --user stop note-app
// Usage: npm run move-storage
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { config } from '../server/config.js';

const { storageDir, storageMarker, dbPath, filesDir } = config;
const oldDb = path.join(config.dataDir, 'notes.db');
const oldFiles = path.join(config.dataDir, 'files');

if (fs.existsSync(storageMarker)) {
  console.log(`Notes storage is already set up at ${storageDir}`);
  process.exit(0);
}
try {
  fs.accessSync(storageDir, fs.constants.W_OK);
} catch {
  console.error(`Can't write to ${storageDir}. Make sure the disk is mounted and owned by you:\n`
    + `  sudo chown ${process.env.USER ?? '$USER'}: ${storageDir}`);
  process.exit(1);
}
if (fs.existsSync(dbPath)) {
  console.error(`${dbPath} already exists; refusing to overwrite it.`);
  process.exit(1);
}

fs.mkdirSync(filesDir, { recursive: true });
let moved = 0;
if (fs.existsSync(oldDb)) {
  // An online backup gives a consistent copy that includes anything still in the WAL.
  const src = new DatabaseSync(oldDb);
  await backup(src, dbPath);
  src.close();
  for (const f of fs.existsSync(oldFiles) ? fs.readdirSync(oldFiles) : []) {
    fs.copyFileSync(path.join(oldFiles, f), path.join(filesDir, f));
    moved++;
  }
  console.log(`Copied the database and ${moved} attachment files to ${storageDir}`);
}
fs.writeFileSync(storageMarker, 'Note App notes storage. Do not delete.\n');

if (fs.existsSync(oldDb)) {
  // Keep the originals until the new copy is known good, under a name the server won't use.
  const stamp = new Date().toISOString().slice(0, 10);
  const keep = path.join(config.dataDir, `pre-move-${stamp}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const f of ['notes.db', 'notes.db-wal', 'notes.db-shm', 'files']) {
    const p = path.join(config.dataDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, f));
  }
  console.log(`The old copy is kept in ${keep}; delete it once you've checked your notes.`);
}
console.log('Done. Start the server: systemctl --user start note-app');
