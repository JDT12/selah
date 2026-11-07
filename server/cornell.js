import { db, getSetting, setSetting } from './db.js';
import { htmlToText } from './html.js';
import { cornellHtml } from '../shared/cornell.js';

/**
 * 5.3.0: a ready-made "Cornell notes" template, added once. It's an ordinary template after that, so it can be
 * changed or deleted, and a deleted one doesn't come back.
 */
export function addCornellTemplate() {
  if (getSetting('cornellTemplate') !== null) return;
  const html = cornellHtml('{{date}}');
  const nb = db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get()?.id ?? null;
  const now = Date.now();
  const id = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, is_template, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(nb, 'Cornell notes {{date}}', html, htmlToText(html), now, now).lastInsertRowid);
  setSetting('cornellTemplate', JSON.stringify({ noteId: id }));
}
