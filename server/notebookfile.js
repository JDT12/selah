import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db } from './db.js';
import { config } from './config.js';
import { extractEntry, zipEntries } from './zip.js';
import { importPackage, readPackage } from './notepack.js';

/**
 * Selah notebook files (.selahnb): notebooks or notes with their tags and attachments, to keep, share or move to
 * another Selah. It's a zip of selah.json (a note package, server/notepack.js) and files/<name> for each attachment.
 * Exporting is a format of the export dialog (server/export.js); importing always makes new notebooks, so nothing
 * already here changes.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const MAX_JSON = 256 * 1024 * 1024;

/** The zip entries for an export of `scope` (exportScope's notes): whole notebooks when the export was of notebooks. */
export function notebookFileEntries(scope, q) {
  const notebookIds = q.notebooks ? String(q.notebooks).split(',').map(Number) : [];
  const pkg = readPackage(db, notebookIds.length ? { notebookIds } : { noteIds: scope.notes.map((n) => n.id) });
  pkg.name = scope.name;
  const files = new Map();
  for (const n of pkg.notes) for (const a of n.attachments) files.set(a.storage, a);
  return [
    { name: 'selah.json', data: Buffer.from(JSON.stringify(pkg)) },
    ...[...files.keys()].filter((s) => fs.existsSync(path.join(config.filesDir, s)))
      .map((s) => ({ name: `files/${s}`, file: path.join(config.filesDir, s), mtime: files.get(s).created_at })),
  ];
}

export default async function notebookFileRoutes(app) {
  // One .selahnb file; its notebooks come in as new notebooks (on a shelf if `stack` is given).
  app.post('/api/import/selahnb', async (req) => {
    const part = await req.file({ limits: { fileSize: config.maxImport } });
    if (!part) throw httpError(400, 'Choose a .selahnb file.');
    const dir = path.join(config.restoreDir, `import-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const zip = path.join(dir, 'upload.zip');
    try {
      await pipeline(part.file, fs.createWriteStream(zip));
      if (part.file.truncated) throw httpError(413, 'That file is larger than the import limit.');
      let entries;
      try { entries = zipEntries(zip); } catch { throw httpError(400, 'That isn’t a Selah notebook file (.selahnb).'); }
      const manifest = entries.find((e) => e.name === 'selah.json');
      if (!manifest) throw httpError(400, 'That isn’t a Selah notebook file (.selahnb).');
      if (manifest.size > MAX_JSON) throw httpError(413, 'That file’s notes are too large to import.');
      await extractEntry(zip, manifest, path.join(dir, 'selah.json'));
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'selah.json'), 'utf8')); } catch { throw httpError(400, 'That Selah notebook file is damaged.'); }
      const byName = new Map(entries.map((e) => [e.name, e]));
      const resolveFile = async (storage) => {
        const e = byName.get(`files/${storage}`);
        if (!e) return null;
        const dest = path.join(dir, `f-${storage}`);
        await extractEntry(zip, e, dest);
        return dest;
      };
      const r = await importPackage(pkg, { resolveFile, newNotebooks: true, label: 'imported' });
      // A shelf to put them on.
      const stack = req.query.stack ? Number(req.query.stack) : null;
      if (stack && db.prepare('SELECT 1 FROM stacks WHERE id = ?').get(stack)) {
        const set = db.prepare('UPDATE notebooks SET stack_id = ? WHERE id = ?');
        for (const id of r.notebooks) set.run(stack, id);
      }
      return { ...r, name: typeof pkg.name === 'string' ? pkg.name : null };
    } finally {
      part.file.resume?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
