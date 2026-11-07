// Creates data/backups/note-app-YYYY-MM-DD-HHMM.tar.gz containing a consistent
// snapshot of the database plus all attachment files. Keeps the newest 14 backups.
// Usage: npm run backup   (safe to run while the server is running)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { config } from '../server/config.js';

const KEEP = Number(process.env.NOTEAPP_BACKUP_KEEP || 14);
const outDir = path.resolve(process.env.NOTEAPP_BACKUP_DIR || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const work = fs.mkdtempSync(path.join(outDir, '.tmp-'));
try {
  const src = new DatabaseSync(config.dbPath);
  await backup(src, path.join(work, 'notes.db'));
  src.close();
  const archive = path.join(outDir, `note-app-${stamp}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', work, 'notes.db', '-C', config.storageDir, 'files']);
  console.log(`Backup written: ${archive}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const old = fs.readdirSync(outDir).filter((f) => /^note-app-.*\.tar\.gz$/.test(f)).sort().reverse().slice(KEEP);
for (const f of old) fs.rmSync(path.join(outDir, f));

// Then the encrypted OneDrive copy, if it's set up (Settings → Off-site backup).
const { offsiteConfigured, runOffsite } = await import('../server/offsite.js');
if (offsiteConfigured()) {
  try {
    const run = await runOffsite({ trigger: 'nightly' });
    if (run.ok) {
      console.log(`Off-site backup done: ${run.snapshot}, ${run.sent.count} new attachment(s)${run.verify ? ', verified' : ''}`);
    } else {
      console.error(`Off-site backup failed: ${run.error}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`Off-site backup skipped: ${e.message}`);
    process.exitCode = 1;
  }
}
