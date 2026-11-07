import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import * as auth from './auth.js';
import { backupContents, writeBackup } from './backupfile.js';
import { offsiteConfigured } from './offsite.js';

/**
 * Settings → Data & backup → Download a backup: a fresh snapshot of everything as one file, encrypted with a
 * passphrase (.selahbak) or not (.tar.gz), to keep wherever the person likes (iCloud Drive, a USB stick). The format
 * is in server/backupfile.js; it restores with `npm run restore -- --file` or the admin console.
 *
 * Confirm-it's-you first (it's the whole account). The download itself is a plain link, so it can't answer that
 * prompt: POST makes a one-time ticket (2 minutes, this session only) that holds the passphrase until the GET uses it.
 * One download is made at a time; nothing is kept on the server afterwards.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const readJson = (key, fallback) => { try { return JSON.parse(getSetting(key) ?? 'null') ?? fallback; } catch { return fallback; } };

const tickets = new Map(); // ticket -> { session, passphrase, expires }
let making = false;

const contents = () => backupContents({ filesDir: config.filesDir, dataDir: config.dataDir, certDir: config.mode === 'tenant' ? null : config.certDir });

export default async function backupDownload(app) {
  app.get('/api/backup/download', async () => {
    const c = contents();
    let dbBytes = 0;
    try { dbBytes = fs.statSync(config.dbPath).size; } catch { /* new server */ }
    return {
      notes: db.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n,
      attachments: c.count,
      bytes: c.bytes + dbBytes,
      last: readJson('backup_download', null),
      offsite: offsiteConfigured(),
      making,
    };
  });

  app.post('/api/backup/download', async (req) => {
    auth.requireConfirmed(req);
    const encrypt = req.body?.encrypt !== false;
    let passphrase = null;
    if (encrypt) {
      passphrase = String(req.body?.passphrase ?? '');
      if (passphrase.length < 12) throw httpError(400, 'Use a passphrase of at least 12 characters.');
      if (/[\r\n]/.test(passphrase)) throw httpError(400, 'The passphrase can’t contain line breaks.');
    }
    if (making) throw httpError(409, 'A backup download is already being made. Try again when it finishes.');
    for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
    const ticket = crypto.randomBytes(18).toString('base64url');
    tickets.set(ticket, { session: req.session.id, passphrase, expires: Date.now() + 2 * 60_000 });
    return { url: `/api/backup/download/${ticket}` };
  });

  app.get('/api/backup/download/:ticket', async (req, reply) => {
    const t = tickets.get(req.params.ticket);
    tickets.delete(req.params.ticket);
    if (!t || t.expires < Date.now() || t.session !== req.session?.id) {
      throw httpError(410, 'That download link has expired. Start it again from Settings → Data & backup.');
    }
    if (making) throw httpError(409, 'A backup download is already being made. Try again when it finishes.');
    making = true;
    const tmp = fs.mkdtempSync(path.join(config.dataDir, 'download-'));
    try {
      const snap = path.join(tmp, 'notes.db');
      await backup(db, snap);
      const check = new DatabaseSync(snap, { readOnly: true });
      const notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
      check.close();
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const name = `selah-backup-${config.tenant ? `${config.tenant}-` : ''}${day}${t.passphrase ? '.selahbak' : '.tar.gz'}`;
      auth.logEvent('backup-download', req, { encrypted: !!t.passphrase });
      reply.header('Content-Type', t.passphrase ? 'application/octet-stream' : 'application/gzip')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Cache-Control', 'no-store');
      reply.hijack();
      const out = reply.raw;
      out.writeHead(200, reply.getHeaders());
      try {
        const r = await writeBackup(out, {
          snapshotDb: snap, filesDir: config.filesDir, dataDir: config.dataDir, keyData: config.secretKey,
          certDir: config.mode === 'tenant' ? null : config.certDir,
          manifest: { app: 'Selah', kind: 'download', version: VERSION, createdAt: now.toISOString(), tenant: config.tenant ?? null, timeZone: config.timeZone, notes },
          passphrase: t.passphrase,
        });
        setSetting('backup_download', JSON.stringify({ at: Date.now(), encrypted: !!t.passphrase, bytes: r.bytes, notes, attachments: r.manifest.files.count }));
      } catch (e) {
        // Usually the browser stopped the download; the file it has is cut short and won't restore.
        req.log.warn({ err: e.message }, 'backup download stopped');
        out.destroy();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      making = false;
    }
  });
}
