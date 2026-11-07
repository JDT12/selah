import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { htmlToText } from './html.js';
import { snapshot } from './links.js';

/**
 * The guides, kept as ordinary notes and opened from Settings → About. Each is made the first time it's opened and
 * the user can move it anywhere. When a release changes a guide, the next open brings the note up to date; the old
 * text is kept in its version history first. Guides open read-only.
 *
 * The maintenance guide names this server's folders, port and name ({{APP}} and so on, filled in here), so the
 * file in the repository has none of them. It starts in the Reference notebook when there is one.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const read = (file) => fs.readFileSync(path.join(config.root, 'server', 'guide', file), 'utf8').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PLACES = {
  APP: config.root, DATA: config.dataDir, NOTES: config.storageDir, PORT: config.port, SERVER: os.hostname(),
  CLOUD: path.resolve(config.root, process.env.NOTEAPP_CLOUD_ROOT || path.join('notes-data', 'cloud')),
};
const GUIDES = {
  user: { title: 'Selah User Guide', setting: 'userGuide', html: read('user-guide.html') },
  maintenance: {
    title: 'Selah Maintenance Guide', setting: 'maintenanceGuide', notebook: 'Reference',
    html: read('maintenance-guide.html').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in PLACES ? esc(PLACES[k]) : m)),
  },
};
for (const g of Object.values(GUIDES)) g.version = crypto.createHash('sha256').update(g.html).digest('hex').slice(0, 16);

/** Opens (makes or updates) a guide's note; returns { id, created?, updated? }. */
function openGuide({ title, setting, html, version, notebook }) {
  let saved = {};
  try { saved = JSON.parse(getSetting(setting) ?? '{}') ?? {}; } catch { /* start over */ }
  const now = Date.now();
  const note = saved.noteId ? db.prepare('SELECT id, deleted_at FROM notes WHERE id = ?').get(saved.noteId) : null;
  if (!note) {
    const nb = (notebook && db.prepare('SELECT id FROM notebooks WHERE name = ? COLLATE NOCASE').get(notebook)?.id)
      ?? db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get()?.id;
    if (!nb) throw httpError(400, 'Create a notebook first');
    const id = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, read_only, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(nb, title, html, htmlToText(html), now, now).lastInsertRowid);
    setSetting(setting, JSON.stringify({ noteId: id, version }));
    return { id, created: true };
  }
  // In the Trash: bring it back rather than make a second copy.
  if (note.deleted_at) db.prepare('UPDATE notes SET deleted_at = NULL WHERE id = ?').run(note.id);
  if (saved.version !== version) {
    snapshot(note.id, { reason: 'Before the guide was updated', force: true });
    // A new guide opens read-only again, even if you unlocked the old one.
    db.prepare('UPDATE notes SET title = ?, html = ?, text = ?, read_only = 1, updated_at = ? WHERE id = ?').run(title, html, htmlToText(html), now, note.id);
    setSetting(setting, JSON.stringify({ noteId: note.id, version }));
    return { id: note.id, updated: true };
  }
  return { id: note.id };
}

export default async function guideRoutes(app) {
  app.post('/api/guide', async () => openGuide(GUIDES.user));
  // Looking after the server is the host's job on a hosted Selah (it's in the admin console).
  app.post('/api/guide/maintenance', async () => {
    if (config.mode !== 'single') throw httpError(404, 'Not found');
    return openGuide(GUIDES.maintenance);
  });
}
