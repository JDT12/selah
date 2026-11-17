import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { config } from './config.js';
import * as auth from './auth.js';
import { DEFAULT_IMAGE, newerFirst, publishedVersions } from './admin/registry.js';
import { pipeline } from 'node:stream/promises';
import { db, getSetting } from './db.js';
import { backupKind } from './backupfile.js';
import { stageRestore } from './desktopbackup.js';

/**
 * Updates for Selah Cloud in its container (14.1, Settings → Updates). The versions come from the published image's
 * registry; the update itself is the updater's job (docker/cloud/updater.sh, beside this container), which this asks
 * by writing a request file into the shared updates folder and watches through the status file it writes back.
 * Before asking, the library's database is copied (pre-update.db, next to it): if the new version doesn't come up,
 * the updater puts the old version back with the database as it was.
 */

const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const updatesDir = () => process.env.NOTEAPP_UPDATES_DIR || null;
const image = () => process.env.NOTEAPP_IMAGE || DEFAULT_IMAGE;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

function updaterStatus() {
  const dir = updatesDir();
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'status'), 'utf8')); } catch { return null; }
}
const pending = () => { const dir = updatesDir(); return !!dir && fs.existsSync(path.join(dir, 'request')); };

export default async function cloudUpdate(app) {
  if (!config.cloudContainer) return;

  app.get('/api/cloud/updates', async (req) => {
    const out = { current: VERSION, image: image(), latest: null, beta: null, newer: null, status: updaterStatus(), pending: pending(), error: null };
    if (!updatesDir()) out.error = 'This Selah has no updater beside it. Update it on the server: selah update';
    try {
      const p = await publishedVersions(image(), { fresh: req.query?.fresh === '1' });
      out.latest = p.latest;
      out.beta = p.beta;
      out.newer = p.latest && newerFirst(p.latest, VERSION) < 0 ? p.latest : null;
    } catch (e) {
      out.error = out.error ?? `Couldn’t check for new versions (${e.message}).`;
    }
    return out;
  });

  // Body: { version }. A beta only when asked for by name (Settings shows it only to someone already on a beta).
  app.post('/api/cloud/updates', async (req) => {
    auth.requireConfirmed(req);
    const dir = updatesDir();
    if (!dir) throw httpError(409, 'This Selah has no updater beside it. Update it on the server: selah update');
    const version = String(req.body?.version ?? '');
    if (!/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(version)) throw httpError(400, 'Which version?');
    if (version === VERSION) throw httpError(409, `Selah is already on ${version}.`);
    if (pending()) throw httpError(409, 'An update is already waiting to start.');
    const s = updaterStatus();
    if (s && ['pulling', 'starting'].includes(s.state)) throw httpError(409, 'An update is already running.');
    // The database as it is now, for the updater to put back if the new version doesn't come up.
    const copy = path.join(config.storageDir, 'pre-update.db');
    fs.rmSync(copy, { force: true });
    await backup(db, copy);
    fs.writeFileSync(path.join(dir, 'request'), `${version}\n`);
    auth.logEvent('update-requested', req, { from: VERSION, to: version });
    return { ok: true, version };
  });

  // ---------- replacing the library from a backup file (Settings → Data & backup) ----------
  // A backup from Selah Desktop, another Selah Cloud or a Ministry Selah: uploaded (streamed to disk), checked and
  // unpacked, then Selah restarts (its container comes back by itself) and puts it in place before opening the
  // library (server/desktoprestore.js). The library it replaces is kept aside, and this Selah keeps its own sign-in.
  const upload = path.join(config.dataDir, 'restore-upload');
  app.register(async (up) => {
    up.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
    up.put('/api/cloud/restore/upload', async (req) => {
      fs.rmSync(upload, { force: true });
      try {
        await pipeline(req.body, fs.createWriteStream(upload, { mode: 0o600 }));
      } catch (e) {
        fs.rmSync(upload, { force: true });
        throw httpError(400, `The upload didn’t finish (${e.message}).`);
      }
      const kind = backupKind(upload);
      if (kind !== 'encrypted' && kind !== 'plain') {
        fs.rmSync(upload, { force: true });
        throw httpError(400, kind === 'zip'
          ? 'That’s a zip from “Download all my data” in an older Selah. Use a file from Download a backup.'
          : 'That isn’t a Selah backup file (.selahbak or .tar.gz).');
      }
      return { ok: true, encrypted: kind === 'encrypted', bytes: fs.statSync(upload).size };
    });
  });

  // Body: { passphrase? }. Stages the uploaded file and restarts.
  app.post('/api/cloud/restore', async (req, reply) => {
    auth.requireConfirmed(req);
    if (!fs.existsSync(upload)) throw httpError(400, 'Upload the backup file first.');
    const r = await stageRestore(upload, req.body?.passphrase ? String(req.body.passphrase) : null);
    const { PENDING } = await import('./desktoprestore.js');
    const keep = Object.fromEntries(['password_hash', 'totp', 'recovery_codes', 'security', 'account_identity', 'account_identity_asked']
      .map((k) => [k, getSetting(k) ?? null]));
    fs.writeFileSync(path.join(PENDING, 'signin.json'), JSON.stringify(keep), { mode: 0o600 });
    fs.rmSync(upload, { force: true });
    auth.logEvent('library-restore', req, { notes: r.notes, version: r.manifest?.version ?? null });
    // Answer first, then stop: Docker starts Selah again (restart: unless-stopped), and db.js puts the backup in place.
    reply.raw.on('finish', () => setTimeout(() => process.exit(0), 500));
    return { ok: true, notes: r.notes, files: r.files, version: r.manifest?.version ?? null, restart: true };
  });
}
