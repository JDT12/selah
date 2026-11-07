import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(root, process.env.NOTEAPP_DATA_DIR || 'data');
// Notes database + attachments live on their own disk, mounted here.
const storageDir = path.resolve(root, process.env.NOTEAPP_STORAGE_DIR || 'notes-data');

// How this server runs (6.0):
//   single  one person's Selah on their own server, as before (the default)
//   tenant  one invited person's Selah, started and looked after by the admin console (server/admin/)
//   admin   the admin console itself
const mode = ['tenant', 'admin'].includes(process.env.NOTEAPP_MODE) ? process.env.NOTEAPP_MODE : 'single';
// 12.0: Selah Desktop (desktop-app/, Electron) runs this server in single mode on the person's own PC: only on
// 127.0.0.1, plain HTTP, no sign-in. The app starts it with a fresh key each launch (NOTEAPP_DESKTOP_KEY) and adds
// it to every request its windows make, so nothing else on the PC (another program, a web page) can use it.
const edition = mode === 'single' && process.env.NOTEAPP_EDITION === 'desktop' ? 'desktop' : 'server';
const desktopKey = edition === 'desktop' ? (process.env.NOTEAPP_DESKTOP_KEY || null) : null;
delete process.env.NOTEAPP_DESKTOP_KEY;
// Selah Desktop keeps the secrets key (server/secrets.js) sealed with Windows DPAPI and hands it over here.
const secretKey = edition === 'desktop' && /^[A-Za-z0-9+/]{43}=$/.test(process.env.NOTEAPP_SECRET_KEY ?? '')
  ? Buffer.from(process.env.NOTEAPP_SECRET_KEY, 'base64') : null;
delete process.env.NOTEAPP_SECRET_KEY;
if (edition === 'desktop' && (!desktopKey || desktopKey.length < 32)) {
  console.error('Selah Desktop: NOTEAPP_DESKTOP_KEY is missing or too short.');
  process.exit(1);
}
// The admin console's key for a tenant's control port. Read once and taken out of the environment, so programs the
// server starts (rclone, ffmpeg) never see it.
const controlToken = process.env.NOTEAPP_CONTROL_TOKEN || null;
delete process.env.NOTEAPP_CONTROL_TOKEN;

export const config = {
  root,
  dataDir,
  storageDir,
  // Written by `npm run move-storage`. If it's missing the disk probably isn't mounted, and the
  // server refuses to start rather than create an empty database on the root filesystem.
  storageMarker: path.join(storageDir, '.note-app-storage'),
  filesDir: path.join(storageDir, 'files'),
  // Nightly copies of the database and attachments removed since (server/restorepoints.js), on the same disk as the
  // notes so a removed file is only moved, and outside files/ so they don't count toward a storage quota.
  restoreDir: path.join(storageDir, 'restore-points'),
  certDir: path.join(dataDir, 'certs'),
  dbPath: path.join(storageDir, 'notes.db'),
  clientDir: path.join(root, 'client', 'dist'),
  host: edition === 'desktop' ? '127.0.0.1' : (process.env.NOTEAPP_HOST || '0.0.0.0'),
  port: Number(process.env.NOTEAPP_PORT || 8443),
  // Max size of a single attachment upload / ENEX import (bytes)
  maxUpload: Number(process.env.NOTEAPP_MAX_UPLOAD || 1024 * 1024 * 1024),
  maxImport: Number(process.env.NOTEAPP_MAX_IMPORT || 8 * 1024 * 1024 * 1024),
  sessionDays: 30,
  // Calendar/tasks: all times are wall-clock times in this zone.
  timeZone: process.env.NOTEAPP_TZ || 'America/Chicago',
  mode,
  edition,
  desktopKey,
  secretKey,
  // Desktop: automatic .selahbak backups go here (the app chooses the folder; NOTEAPP_BACKUP_DIR).
  backupDir: process.env.NOTEAPP_BACKUP_DIR ? path.resolve(process.env.NOTEAPP_BACKUP_DIR) : null,
  // Plain HTTP (NOTEAPP_TLS=0) behind Caddy, which holds the certificate; HTTPS with data/certs otherwise. Desktop is
  // always plain HTTP on 127.0.0.1.
  tls: edition !== 'desktop' && process.env.NOTEAPP_TLS !== '0',
  // Tenant mode: the tenant's name (its subdomain), the admin console's control port and key, and its limits.
  tenant: process.env.NOTEAPP_TENANT || null,
  controlPort: Number(process.env.NOTEAPP_CONTROL_PORT || 0),
  controlHost: process.env.NOTEAPP_CONTROL_HOST || '127.0.0.1',
  controlToken,
  // Storage for notes and attachments, in bytes (0 = no limit).
  quota: Number(process.env.NOTEAPP_QUOTA || 0),
  // The longest one OCR, HEIC or audio/video job may run (milliseconds).
  jobTimeout: Number(process.env.NOTEAPP_JOB_TIMEOUT || 10 * 60 * 1000),
  // Memory for one HEIC conversion (MB; 0 = no limit of its own). The tenant's whole memory limit is set on its service.
  jobMemoryMb: Number(process.env.NOTEAPP_JOB_MEMORY_MB || 0),
};
