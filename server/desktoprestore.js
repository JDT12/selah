import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { installUnpacked, scrubRestoredDb } from './backupfile.js';

// Selah Desktop: a restore staged by server/desktopbackup.js, put in place before db.js opens notes.db.
export const PENDING = path.join(config.dataDir, 'restore-pending');
export const BEFORE = path.join(path.dirname(config.storageDir), 'storage-before-restore');

/**
 * Called by db.js before it opens notes.db: puts a staged restore in place. The current library goes to
 * storage-before-restore/ (replacing an older one there). A Cloud backup's sign-ins, sharing and setup links are
 * dropped: there's no sign-in here and no other Selahs to share with.
 */
export function applyPendingRestore() {
  const ready = path.join(PENDING, 'ready.json');
  if (!fs.existsSync(ready)) return null;
  const dir = path.join(PENDING, 'unpacked');
  const info = JSON.parse(fs.readFileSync(ready, 'utf8'));
  fs.rmSync(BEFORE, { recursive: true, force: true });
  if (fs.existsSync(config.storageDir)) fs.renameSync(config.storageDir, BEFORE);
  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.writeFileSync(config.storageMarker, 'Selah Desktop library. Do not delete.\n');
  // The restore points belong with the library they were taken of; keep them with the old one.
  const key = path.join(config.dataDir, 'wordpress.key');
  if (fs.existsSync(key) && fs.existsSync(path.join(dir, 'config', 'wordpress.key'))) {
    fs.mkdirSync(BEFORE, { recursive: true });
    fs.renameSync(key, path.join(BEFORE, 'wordpress.key'));
  }
  scrubRestoredDb(path.join(dir, 'notes.db'));
  const fix = new DatabaseSync(path.join(dir, 'notes.db'));
  try {
    for (const t of fix.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'relay\\_%' ESCAPE '\\' OR name LIKE 'share\\_%' ESCAPE '\\')").all()) {
      if (t.name !== 'share_comments') fix.exec(`DELETE FROM "${t.name}"`);
    }
    fix.exec("DELETE FROM settings WHERE key IN ('password_hash', 'totp', 'recovery_codes', 'user_notice')");
  } finally {
    fix.close();
  }
  installUnpacked(dir, { db: config.dbPath, files: config.filesDir, data: config.dataDir, certs: null });
  fs.rmSync(PENDING, { recursive: true, force: true });
  fs.writeFileSync(path.join(config.dataDir, 'restored.json'), JSON.stringify({ ...info, appliedAt: Date.now() }));
  return info;
}

