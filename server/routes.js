import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db, tx, unlinkStorage, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { escapeHtml, htmlToText } from './html.js';
import { setNoteTags, noteTags, TAG_COLORS, cleanTagName, mergeTag, dropUnusedTags } from './tags.js';
import { importEnex } from './enex.js';
import { MarkdownImport } from './markdown.js';
import * as auth from './auth.js';
import { today } from './recurrence.js';
import { toM4a } from './media.js';
import { dropThumbs } from './attachments.js';
import { renameLinks, snapshot } from './links.js';
import { HEIC_DIR, heicJpeg, isHeic } from './heic.js';
import { inboxId } from './capture.js';
import { attachCopies, copyFiles, pointAt } from './notetools.js';
import { storageUsed } from './tenant.js';
import { identity } from './account.js';
import { absorbNotebooks, fileTaggedInbox, myNotesId, tagWork } from './mynotes.js';

/** Notes in the Trash are deleted forever after this many days (0: only when it's emptied). */
export const trashDays = () => Number(getSetting('trash_days') ?? 0) || 0;

/** Deletes notes in the Trash (those deleted before `before`, or all of them) and their attachments. */
export function purgeTrash(before = null) {
  const where = before ? 'deleted_at IS NOT NULL AND deleted_at < ?' : 'deleted_at IS NOT NULL';
  const args = before ? [before] : [];
  const files = db.prepare(`SELECT a.storage FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.${where}`).all(...args).map((r) => r.storage);
  const n = db.prepare(`DELETE FROM notes WHERE ${where}`).run(...args).changes;
  if (!n) return 0;
  dropUnusedTags();
  unlinkStorage(files);
  dropThumbs(files);
  return n;
}

/** Empties the Trash of notes past its setting, hourly. */
export function scheduleTrash(log) {
  const tick = () => {
    const days = trashDays();
    if (!days) return;
    try {
      const n = purgeTrash(Date.now() - days * 86_400_000);
      if (n) log.info(`Deleted ${n} note(s) from the Trash after ${days} days`);
    } catch (e) {
      log.warn(`Emptying the Trash failed: ${e.message}`);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3_600_000).unref();
}

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const name = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 200) throw httpError(400, 'Name must be 1-200 characters');
  return s;
};
const exists = (table, id) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);

// Types the browser may render inline. Everything else is forced to download, so an
// uploaded HTML/SVG file can never execute script on this origin.
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)$/;

/**
 * The private CA's SHA-256 fingerprint (so a downloaded ca.crt can be checked) and the names
 * the server certificate covers, for the in-app "Trust this device" guide.
 */
function certInfo() {
  try {
    const read = (f) => new crypto.X509Certificate(fs.readFileSync(path.join(config.certDir, f)));
    const hosts = (read('server.crt').subjectAltName ?? '').split(', ').map((s) => s.replace(/^(DNS|IP Address):/, ''));
    return { fingerprint: read('ca.crt').fingerprint256, hosts };
  } catch {
    return null;
  }
}

/** Template placeholders, in the app's time zone. */
export function fillPlaceholders(text) {
  const now = new Date();
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone, ...opts }).format(now);
  const values = {
    date: fmt({ month: 'long', day: 'numeric', year: 'numeric' }),
    time: fmt({ hour: 'numeric', minute: '2-digit' }),
    weekday: fmt({ weekday: 'long' }),
    year: fmt({ year: 'numeric' }),
  };
  return text.replace(/\{\{\s*(date|time|weekday|year)\s*\}\}/gi, (_, k) => values[k.toLowerCase()]);
}

// The version this server is running; the client compares it with its own to offer a reload after an update.
/**
 * 9.0: which builder made a note, for its chip in the notes list: the method it follows (shared/methods.js), else what
 * it is, the way server/methods.js reads notes from before 6.5 ('lesson' for a lesson without a known layout).
 */
const BUILDER_SQL = `COALESCE(
  (SELECT method FROM note_methods WHERE note_id = n.id),
  CASE
    WHEN EXISTS (SELECT 1 FROM bible_studies WHERE note_id = n.id) THEN 'ggw'
    WHEN EXISTS (SELECT 1 FROM sermons WHERE note_id = n.id) THEN 'mcdill'
  END,
  (SELECT COALESCE(CASE WHEN json_valid(s.data) THEN json_extract(s.data, '$.methods.writing') END, 'book')
    FROM study_notes sn JOIN studies s ON s.id = sn.study_id
    WHERE sn.note_id = n.id AND sn.role = 'chapter' AND s.kind = 'writing' ORDER BY sn.added_at LIMIT 1),
  CASE
    WHEN EXISTS (SELECT 1 FROM study_notes WHERE note_id = n.id AND role = 'lesson')
      OR EXISTS (SELECT 1 FROM study_items i JOIN studies s ON s.id = i.study_id WHERE i.note_id = n.id AND i.kind = 'session' AND s.kind = 'teaching') THEN 'lesson'
  END)`;

const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;

export default async function routes(app) {
  // ---------- auth ----------
  app.get('/api/session', async (req) => ({
    authenticated: !!req.session,
    passwordSet: auth.passwordIsSet(),
    // 10.0: the sign-in page asks for the username or email too, once they're chosen.
    signInName: !!identity(),
    timeZone: config.timeZone,
    // The private CA and "Trust this device" only exist on a home server; a hosted Selah has a public certificate.
    cert: config.mode === 'single' ? certInfo() : null,
    mode: config.mode,
    tenant: config.tenant,
    // 'desktop' in Selah Desktop (12.0): no sign-in, no sharing, automatic backups to a folder.
    edition: config.edition,
  }));

  app.get('/api/version', async () => ({ version: VERSION }));

  // The maintenance banner for users (sent by the admin console; server/tenant.js): while it's on, from its "show
  // from" time until maintenance ends (4 hours after the start when no end was given).
  app.get('/api/notice', async () => {
    let n = null;
    try { n = JSON.parse(getSetting('user_notice') ?? 'null'); } catch { /* none */ }
    const now = Date.now();
    const until = n?.end ?? (n?.start ? n.start + 4 * 3600_000 : 0);
    if (!n?.on || !n.start || now >= until || (n.showFrom && now < n.showFrom)) return { notice: null };
    return { notice: { id: n.updatedAt, start: n.start, end: n.end, message: n.message, now: now >= n.start } };
  });

  // ---------- sidebar tree ----------
  // The connected WordPress site's name (for the sidebar), without asking the site.
  const wordpressName = () => {
    try { return JSON.parse(getSetting('wordpress') ?? 'null')?.name ?? null; } catch { return null; }
  };
  const inboxCount = () => {
    const id = inboxId({ create: false });
    return id ? { id, count: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE notebook_id = ? AND deleted_at IS NULL AND is_template = 0').get(id).n } : null;
  };
  app.get('/api/tree', async () => {
    tagWork();
    const stacks = db.prepare('SELECT id, name FROM stacks ORDER BY name COLLATE NOCASE').all();
    const notebooks = db.prepare(`
      SELECT nb.id, nb.name, nb.stack_id, nb.created_at, nb.managed,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.is_template = 0) AS count,
        (SELECT MAX(updated_at) FROM notes n WHERE n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.is_template = 0) AS updated_at
      FROM notebooks nb ORDER BY nb.name COLLATE NOCASE`).all();
    const tags = db.prepare(`
      SELECT t.id, t.name, t.color, t.ignore_scripture, COUNT(n.id) AS count FROM tags t
      JOIN note_tags nt ON nt.tag_id = t.id
      JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL AND n.is_template = 0
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all();
    const counts = db.prepare(`
      SELECT SUM(deleted_at IS NULL AND is_template = 0) AS total, SUM(deleted_at IS NOT NULL) AS trash,
             SUM(deleted_at IS NULL AND is_template = 1) AS templates,
             SUM(deleted_at IS NULL AND is_template = 0 AND NOT EXISTS (SELECT 1 FROM note_tags WHERE note_id = notes.id)) AS untagged
      FROM notes`).get();
    const tasksDue = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE completed_at IS NULL AND due_date <= ?').get(today()).c;
    const shortcuts = db.prepare('SELECT id, kind, target_id FROM shortcuts ORDER BY position, id').all();
    return {
      stacks, notebooks, tags, shortcuts, total: counts.total ?? 0, trash: counts.trash ?? 0, templates: counts.templates ?? 0,
      untagged: counts.untagged ?? 0, tasksDue, wordpress: wordpressName(),
      attachments: db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n,
      inbox: inboxCount(),
      myNotes: myNotesId(),
    };
  });

  // ---------- preferences ----------
  // Small JSON UI preferences that should follow you across devices (e.g. dashboard layout).
  const prefKey = (k) => {
    if (!/^[a-z][\w-]{0,40}$/i.test(k)) throw httpError(400, 'Invalid preference');
    return `pref.${k}`;
  };
  app.get('/api/prefs/:key', async (req) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(prefKey(req.params.key));
    return { value: row ? JSON.parse(row.value) : null };
  });
  app.put('/api/prefs/:key', async (req) => {
    const json = JSON.stringify(req.body?.value ?? null);
    if (json.length > 20000) throw httpError(413, 'Preference too large');
    setSetting(prefKey(req.params.key), json);
    return { ok: true };
  });

  // ---------- dashboard banner ----------
  // One image shown across the top of the dashboard. The file lives with the attachments;
  // settings.banner holds { storage, mime, y } where y is the vertical focus (0-100%).
  const BANNER_MIME = /^image\/(png|jpeg|gif|webp|avif)$/;
  const getBanner = () => { try { return JSON.parse(getSetting('banner')); } catch { return null; } };
  app.get('/api/banner', async (req, reply) => {
    const b = getBanner();
    if (!b) throw httpError(404, 'No banner');
    reply.header('Content-Type', b.mime);
    // The URL carries the storage id (?v=…), so a new image gets a new URL.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.sendFile(b.storage, config.filesDir, { contentType: false, cacheControl: false });
  });
  app.post('/api/banner', async (req) => {
    const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024 } });
    if (!file) throw httpError(400, 'No file uploaded');
    const mime = (file.mimetype || '').toLowerCase();
    if (!BANNER_MIME.test(mime)) {
      file.file.resume();
      throw httpError(415, 'Choose a PNG, JPEG, GIF, WebP or AVIF image');
    }
    const storage = crypto.randomBytes(16).toString('hex');
    try {
      await pipeline(file.file, fs.createWriteStream(path.join(config.filesDir, storage)));
      if (file.file.truncated) throw httpError(413, 'Image is too large (25 MB max)');
    } catch (err) {
      unlinkStorage([storage]);
      throw err;
    }
    const old = getBanner();
    const banner = { storage, mime, y: 50 };
    setSetting('banner', JSON.stringify(banner));
    if (old) unlinkStorage([old.storage]);
    return { v: storage, y: banner.y };
  });
  app.patch('/api/banner', async (req) => {
    const b = getBanner();
    if (!b) throw httpError(404, 'No banner');
    const y = Number(req.body?.y);
    if (!Number.isFinite(y) || y < 0 || y > 100) throw httpError(400, 'Position must be 0-100');
    setSetting('banner', JSON.stringify({ ...b, y: Math.round(y) }));
    return { ok: true };
  });
  app.delete('/api/banner', async () => {
    const b = getBanner();
    if (b) {
      db.prepare("DELETE FROM settings WHERE key = 'banner'").run();
      unlinkStorage([b.storage]);
    }
    return { ok: true };
  });

  // ---------- shortcuts ----------
  app.post('/api/shortcuts', async (req) => {
    const kind = req.body?.kind;
    const table = { notebook: 'notebooks', stack: 'stacks', tag: 'tags' }[kind];
    if (!table) throw httpError(400, 'Shortcut must be a notebook, shelf or tag');
    const targetId = intParam(req.body?.target_id);
    if (!exists(table, targetId)) throw httpError(404, `${kind[0].toUpperCase()}${kind.slice(1)} not found`);
    db.prepare(`INSERT INTO shortcuts (kind, target_id, position)
      VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM shortcuts))
      ON CONFLICT(kind, target_id) DO NOTHING`).run(kind, targetId);
    return { ok: true };
  });

  // Body: { ids: [shortcut ids in the new order] }
  app.put('/api/shortcuts/order', async (req) => {
    const ids = (req.body?.ids ?? []).map(intParam);
    tx(() => ids.forEach((id, i) => db.prepare('UPDATE shortcuts SET position = ? WHERE id = ?').run(i + 1, id)));
    return { ok: true };
  });

  app.delete('/api/shortcuts/:id', async (req) => {
    db.prepare('DELETE FROM shortcuts WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // ---------- stacks ----------
  app.post('/api/stacks', async (req) => {
    const stackName = name(req.body?.name);
    return tx(() => {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO stacks (name, created_at) VALUES (?, ?)').run(stackName, Date.now());
      // Optionally move notebooks into the new stack right away.
      for (const nb of req.body?.notebookIds ?? []) {
        db.prepare('UPDATE notebooks SET stack_id = ? WHERE id = ?').run(id, intParam(nb));
      }
      return { id: Number(id) };
    });
  });

  app.patch('/api/stacks/:id', async (req) => {
    const id = intParam(req.params.id);
    db.prepare('UPDATE stacks SET name = ? WHERE id = ?').run(name(req.body?.name), id);
    return { ok: true };
  });

  // Deleting a stack keeps its notebooks (they become un-stacked).
  app.delete('/api/stacks/:id', async (req) => {
    db.prepare('DELETE FROM stacks WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // ---------- notebooks ----------
  app.post('/api/notebooks', async (req) => {
    const stackId = req.body?.stack_id ? intParam(req.body.stack_id) : null;
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO notebooks (name, stack_id, created_at) VALUES (?, ?, ?)')
      .run(name(req.body?.name), stackId, Date.now());
    return { id: Number(id) };
  });

  app.patch('/api/notebooks/:id', async (req) => {
    const id = intParam(req.params.id);
    if (!exists('notebooks', id)) throw httpError(404, 'Notebook not found');
    const b = req.body ?? {};
    if ('name' in b) db.prepare('UPDATE notebooks SET name = ? WHERE id = ?').run(name(b.name), id);
    if ('stack_id' in b) {
      const stackId = b.stack_id ? intParam(b.stack_id) : null;
      if (stackId && !exists('stacks', stackId)) throw httpError(404, 'Shelf not found');
      db.prepare('UPDATE notebooks SET stack_id = ? WHERE id = ?').run(stackId, id);
    }
    return { ok: true };
  });

  // Moves every note (including trashed ones) into another notebook, then deletes this one.
  app.post('/api/notebooks/:id/merge', async (req) => {
    const id = intParam(req.params.id);
    const into = intParam(req.body?.into);
    if (id === into) throw httpError(400, 'Choose a different notebook');
    if (!exists('notebooks', id) || !exists('notebooks', into)) throw httpError(404, 'Notebook not found');
    tx(() => {
      db.prepare('UPDATE notes SET notebook_id = ? WHERE notebook_id = ?').run(into, id);
      db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
    });
    return { ok: true };
  });

  // Deleting a notebook moves its notes to the trash.
  app.delete('/api/notebooks/:id', async (req) => {
    const id = intParam(req.params.id);
    tx(() => {
      if (db.prepare('SELECT COUNT(*) AS c FROM notebooks').get().c <= 1) {
        throw httpError(400, 'You must keep at least one notebook');
      }
      // Templates aren't in a notebook's list, so they aren't trashed with it (their notebook_id becomes NULL).
      // Its notes remember it, so restoring them brings it back.
      const nb = db.prepare('SELECT name, stack_id FROM notebooks WHERE id = ?').get(id);
      db.prepare('UPDATE notes SET deleted_at = COALESCE(deleted_at, ?), trash_notebook = ? WHERE notebook_id = ? AND is_template = 0')
        .run(Date.now(), nb ? JSON.stringify({ name: nb.name, stack_id: nb.stack_id }) : null, id);
      db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
    });
    return { ok: true };
  });

  // ---------- tags ----------
  // Counts: notes (not templates or trash), templates, and notes in the trash that use the tag.
  app.get('/api/tags', async () => db.prepare(`
    SELECT t.id, t.name, t.color, t.ignore_scripture,
      COUNT(n.id) FILTER (WHERE n.deleted_at IS NULL AND n.is_template = 0) AS count,
      COUNT(n.id) FILTER (WHERE n.deleted_at IS NULL AND n.is_template = 1) AS templates,
      COUNT(n.id) FILTER (WHERE n.deleted_at IS NOT NULL) AS trashed,
      MAX(n.updated_at) FILTER (WHERE n.deleted_at IS NULL AND n.is_template = 0) AS last_used
    FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id LEFT JOIN notes n ON n.id = nt.note_id
    GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all());

  // Rename, recolor, or keep the tag's notes out of the Scripture index. Renaming to another tag's name is refused (409) unless `merge` is set.
  app.patch('/api/tags/:id', async (req) => {
    const id = intParam(req.params.id);
    const b = req.body ?? {};
    return tx(() => {
      if (!exists('tags', id)) throw httpError(404, 'Tag not found');
      if ('color' in b) {
        if (b.color !== null && !TAG_COLORS.includes(b.color)) throw httpError(400, 'Unknown color');
        db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(b.color, id);
      }
      if ('ignore_scripture' in b) db.prepare('UPDATE tags SET ignore_scripture = ? WHERE id = ?').run(b.ignore_scripture ? 1 : 0, id);
      if ('name' in b) {
        const name = cleanTagName(b.name);
        if (!name) throw httpError(400, 'Enter a tag name');
        const other = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, id);
        if (other) {
          if (!b.merge) throw httpError(409, `There's already a tag called “${name}”`);
          mergeTag(id, other.id);
          return { id: other.id, merged: true };
        }
        db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
      }
      return { id };
    });
  });

  app.post('/api/tags/:id/merge', async (req) => {
    const id = intParam(req.params.id);
    const into = intParam(req.body?.into);
    if (id === into) throw httpError(400, 'Choose a different tag');
    if (!exists('tags', id) || !exists('tags', into)) throw httpError(404, 'Tag not found');
    tx(() => mergeTag(id, into));
    return { ok: true };
  });

  // Removes the tag from every note (the notes themselves are kept).
  app.delete('/api/tags/:id', async (req) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(intParam(req.params.id));
    return { ok: true };
  });

  // Add a tag to some notes and take it off others. Body: { tag_id } or { name } (made if new), add: [ids], remove: [ids].
  app.post('/api/tags/apply', async (req) => {
    const b = req.body ?? {};
    const add = (b.add ?? []).map(intParam);
    const remove = (b.remove ?? []).map(intParam);
    return tx(() => {
      let id = b.tag_id != null ? intParam(b.tag_id) : null;
      if (id == null) {
        const name = cleanTagName(b.name);
        if (!name) throw httpError(400, 'Enter a tag name');
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
        id = db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
      } else if (!exists('tags', id)) {
        throw httpError(404, 'Tag not found');
      }
      const link = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) SELECT id, ? FROM notes WHERE id = ?');
      const unlink = db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?');
      for (const n of add) link.run(id, n);
      for (const n of remove) unlink.run(n, id);
      dropUnusedTags();
      if (add.length) fileTaggedInbox();
      return { id: exists('tags', id) ? id : null };
    });
  });

  // ---------- notes ----------
  app.get('/api/notes', async (req) => {
    const q = req.query;
    const where = [];
    const args = [];
    let from = 'notes n';

    where.push(q.trash ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL');
    // Templates have their own list; the trash shows everything deleted.
    if (!q.trash) where.push(q.templates ? 'n.is_template = 1' : 'n.is_template = 0');
    if (q.notebook) { where.push('n.notebook_id = ?'); args.push(intParam(q.notebook)); }
    if (q.stack) {
      where.push('n.notebook_id IN (SELECT id FROM notebooks WHERE stack_id = ?)');
      args.push(intParam(q.stack));
    }
    if (q.tag) {
      where.push('n.id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)');
      args.push(intParam(q.tag));
    }
    if (q.untagged) where.push('NOT EXISTS (SELECT 1 FROM note_tags WHERE note_id = n.id)');
    // 10.1: My notes is every note but the Inbox's (builders' notes too, by their work's tag).
    if (q.mynotes) {
      tagWork();
      const inbox = inboxId({ create: false });
      if (inbox) { where.push('n.notebook_id IS NOT ?'); args.push(inbox); }
    }
    if (q.files) where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.note_id = n.id)');
    const terms = String(q.q ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length) {
      from += ' JOIN notes_fts f ON f.rowid = n.id';
      where.push('notes_fts MATCH ?');
      args.push(terms.map((t) => `"${t}"*`).join(' '));
    }
    let order = `n.pinned DESC, ${{ created: 'n.created_at DESC', title: 'n.title COLLATE NOCASE ASC', updated: 'n.updated_at DESC' }[q.sort] ?? 'n.updated_at DESC'}`;
    // rank=1 (the Ctrl+K palette): best matches first, titles containing the words ahead of the rest.
    if (q.rank && terms.length) {
      order = `${terms.map(() => '(n.title LIKE ?)').join(' + ')} DESC, f.rank`;
      args.push(...terms.map((t) => `%${t}%`));
    }
    const limit = q.limit ? Math.min(Math.max(intParam(q.limit), 1), 2000) : 2000;

    return db.prepare(`
      SELECT n.id, n.title, substr(n.text, 1, 220) AS snippet, n.notebook_id, n.pinned, n.dash_pinned, n.is_template, n.read_only,
             n.created_at, n.updated_at, n.deleted_at, n.trash_notebook,
             (SELECT COUNT(*) FROM attachments a WHERE a.note_id = n.id) AS attachments,
             (SELECT group_concat(tag_id) FROM note_tags WHERE note_id = n.id) AS tag_ids,
             ${BUILDER_SQL} AS builder
      FROM ${from} WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT ${limit}`).all(...args);
  });

  app.get('/api/notes/:id', async (req) => {
    const id = intParam(req.params.id);
    const note = db.prepare('SELECT id, notebook_id, title, html, pinned, dash_pinned, is_template, read_only, created_at, updated_at, deleted_at FROM notes WHERE id = ?').get(id);
    if (!note) throw httpError(404, 'Note not found');
    note.tags = noteTags(id);
    note.attachments = db.prepare('SELECT id, filename, mime, size, created_at FROM attachments WHERE note_id = ? ORDER BY id').all(id);
    // Before 5.3.3 a HEIC photo was sent as-is, and browsers keep files for a year: a new address (?jpg) makes them
    // fetch the JPEG copy instead.
    for (const a of note.attachments) {
      if (isHeic(a.mime, a.filename)) note.html = note.html.replaceAll(`src="/api/files/${a.id}"`, `src="/api/files/${a.id}?jpg"`);
    }
    note.wordpress = db.prepare(`SELECT post_id, link, status FROM wp_posts WHERE note_id = ? AND status NOT IN ('trash', 'deleted')`).get(id) ?? null;
    return note;
  });

  app.post('/api/notes', async (req) => {
    const notebookId = intParam(req.body?.notebook_id);
    if (!exists('notebooks', notebookId)) throw httpError(404, 'Notebook not found');
    const now = Date.now();
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(notebookId, String(req.body?.title ?? ''), html, htmlToText(html), now, now);
    return { id: Number(id) };
  });

  app.patch('/api/notes/:id', async (req, reply) => {
    const id = intParam(req.params.id);
    const b = req.body ?? {};
    const editsContent = typeof b.title === 'string' || typeof b.html === 'string';
    // base_updated_at is the version the editor started from. If the note has changed since (another window or
    // device saved it), the save is refused with the newer note, unless the editor chose to overwrite it.
    if (editsContent && typeof b.base_updated_at === 'number' && !b.overwrite) {
      const now = db.prepare('SELECT title, html, updated_at FROM notes WHERE id = ?').get(id);
      if (now && now.updated_at > b.base_updated_at) {
        reply.code(409);
        return { error: 'This note changed somewhere else', conflict: true, note: now };
      }
    }
    return tx(() => {
      const before = db.prepare('SELECT title, deleted_at FROM notes WHERE id = ?').get(id);
      if (!before) throw httpError(404, 'Note not found');
      // The note as it was before this editing session goes into its version history; when one window's text
      // replaces another's (overwrite), the replaced text is always kept.
      if (b.overwrite && editsContent && !before.deleted_at) snapshot(id, { reason: 'Replaced from another window', force: true });
      else if (editsContent && !before.deleted_at) snapshot(id);
      const sets = [];
      const args = [];
      let content = false;
      if (typeof b.title === 'string') { sets.push('title = ?'); args.push(b.title.slice(0, 500)); content = true; }
      if (typeof b.html === 'string') { sets.push('html = ?', 'text = ?'); args.push(b.html, htmlToText(b.html)); content = true; }
      if ('pinned' in b) { sets.push('pinned = ?'); args.push(b.pinned ? 1 : 0); }
      if ('dash_pinned' in b) { sets.push('dash_pinned = ?'); args.push(b.dash_pinned ? 1 : 0); }
      if ('is_template' in b) { sets.push('is_template = ?'); args.push(b.is_template ? 1 : 0); }
      if ('read_only' in b) { sets.push('read_only = ?'); args.push(b.read_only ? 1 : 0); }
      if ('notebook_id' in b) {
        const nb = intParam(b.notebook_id);
        if (!exists('notebooks', nb)) throw httpError(404, 'Notebook not found');
        sets.push('notebook_id = ?'); args.push(nb);
      }
      if (content) { sets.push('updated_at = ?'); args.push(Date.now()); }
      if (sets.length) db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      if (Array.isArray(b.tags)) setNoteTags(id, b.tags);
      if (typeof b.title === 'string') renameLinks(id, before.title, b.title.slice(0, 500));
      return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(id);
    });
  });

  app.delete('/api/notes/:id', async (req) => {
    const id = intParam(req.params.id);
    if (req.query.permanent) {
      const files = db.prepare('SELECT storage FROM attachments WHERE note_id = ?').all(id).map((r) => r.storage);
      db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      dropUnusedTags();
      unlinkStorage(files);
      dropThumbs(files);
    } else {
      db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    }
    return { ok: true };
  });

  // Copy a note: a new note from a template, or a duplicate. Attachments are copied too, so the copy keeps
  // working if the original is deleted. From a template, {{date}}, {{time}}, {{weekday}} and {{year}} are filled in.
  // With `into` (a note id) nothing is created: the attachments are copied to that note and the content
  // and tags are returned for the editor to insert.
  app.post('/api/notes/:id/copy', async (req) => {
    const id = intParam(req.params.id);
    const b = req.body ?? {};
    const src = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!src) throw httpError(404, 'Note not found');
    if (b.into != null) return insertCopy(src, intParam(b.into));
    const notebookId = b.notebook_id != null ? intParam(b.notebook_id)
      : (src.notebook_id ?? db.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get()?.id);
    if (!exists('notebooks', notebookId)) throw httpError(404, 'Notebook not found');
    const fromTemplate = !!src.is_template && !b.asTemplate;
    const fill = fromTemplate ? fillPlaceholders : (s) => s;
    const title = fill(typeof b.title === 'string' ? b.title : (fromTemplate ? src.title : `${src.title || 'Untitled'} (copy)`)).slice(0, 500);
    const copied = copyFiles(id);
    try {
      return tx(() => {
        const now = Date.now();
        const newId = Number(db.prepare(`INSERT INTO notes (notebook_id, title, html, text, is_template, created_at, updated_at)
          VALUES (?, ?, '', '', ?, ?, ?)`).run(notebookId, title, b.asTemplate || (!fromTemplate && src.is_template) ? 1 : 0, now, now).lastInsertRowid);
        const ids = attachCopies(copied, newId, now);
        const html = fill(pointAt(src.html, ids));
        db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(html, htmlToText(html), newId);
        setNoteTags(newId, noteTags(id));
        return { id: newId };
      });
    } catch (err) {
      unlinkStorage(copied.map((f) => f.storage));
      throw err;
    }
  });

  function insertCopy(src, into) {
    if (into === src.id) throw httpError(400, 'Choose a different template');
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(into)) throw httpError(404, 'Note not found');
    const copied = copyFiles(src.id);
    try {
      return tx(() => {
        const now = Date.now();
        const ids = attachCopies(copied, into, now);
        const fill = src.is_template ? fillPlaceholders : (x) => x;
        return {
          html: fill(pointAt(src.html, ids)),
          tags: noteTags(src.id),
          attachments: db.prepare(`SELECT id, filename, mime, size, created_at FROM attachments
            WHERE note_id = ? AND id IN (${[...ids.values()].map(() => '?').join(',') || 'NULL'}) ORDER BY id`).all(into, ...ids.values()),
        };
      });
    } catch (err) {
      unlinkStorage(copied.map((f) => f.storage));
      throw err;
    }
  }

  /**
   * Takes notes out of the Trash, into `into` (a notebook id) or where they were: their notebook, or if it was
   * deleted, a notebook of its name (made again, on its shelf if that's still here). Call inside tx().
   */
  function restoreNotes(ids, into = null) {
    if (into != null && !exists('notebooks', into)) throw httpError(404, 'Notebook not found');
    const get = db.prepare('SELECT notebook_id, is_template, trash_notebook FROM notes WHERE id = ? AND deleted_at IS NOT NULL');
    const put = db.prepare('UPDATE notes SET deleted_at = NULL, trash_notebook = NULL, notebook_id = ? WHERE id = ?');
    const made = [];
    let count = 0;
    for (const id of ids) {
      const note = get.get(id);
      if (!note) continue;
      let nb = into ?? note.notebook_id;
      if (!nb || !exists('notebooks', nb)) {
        let was = null;
        try { was = JSON.parse(note.trash_notebook ?? 'null'); } catch { /* none */ }
        nb = null;
        // 10.1: a deleted notebook isn't made again; the note goes to My notes with the notebook's name as a tag.
        if (!note.is_template) {
          nb = myNotesId();
          if (was?.name && !/^(first notebook|my notes|inbox)$/i.test(was.name.trim())) {
            const tagName = cleanTagName(was.name);
            if (tagName) {
              db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(tagName);
              db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, tagName);
            }
          }
        }
      }
      put.run(nb, id);
      count++;
    }
    return { count, notebooks: made };
  }

  app.post('/api/notes/:id/restore', async (req) => {
    const id = intParam(req.params.id);
    if (!exists('notes', id)) throw httpError(404, 'Note not found');
    const into = req.body?.notebook_id != null ? intParam(req.body.notebook_id) : null;
    return tx(() => restoreNotes([id], into));
  });

  // Several at once (the selection, or a group in the Trash): { ids, notebook_id? }.
  app.post('/api/trash/restore', async (req) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(intParam).slice(0, 5000);
    const into = req.body?.notebook_id != null ? intParam(req.body.notebook_id) : null;
    return tx(() => restoreNotes(ids, into));
  });

  app.delete('/api/trash', async () => {
    purgeTrash();
    return { ok: true };
  });

  // Emptying the Trash by itself after so many days (0 = never).
  app.get('/api/trash/settings', async () => ({ days: trashDays() }));
  app.put('/api/trash/settings', async (req) => {
    const days = Number(req.body?.days);
    if (![0, 30, 60, 90].includes(days)) throw httpError(400, 'Choose 30, 60 or 90 days, or never.');
    setSetting('trash_days', String(days));
    if (days) purgeTrash(Date.now() - days * 86_400_000);
    return { days };
  });

  // ---------- storage ----------
  // Space on the notes disk only (not the system disk). `capacity` is used + available, as df
  // computes Use%, so blocks reserved for root don't show up as space you can fill.
  app.get('/api/storage', async () => {
    // With a quota (a hosted Selah), the meter shows the quota, not the server's disk.
    if (config.quota) {
      const u = storageUsed({ fresh: true });
      return { capacity: config.quota, used: u.bytes, free: Math.max(0, config.quota - u.bytes), database: u.db, attachments: u.files, quota: true };
    }
    const s = fs.statfsSync(config.storageDir);
    const used = (s.blocks - s.bfree) * s.bsize;
    const free = s.bavail * s.bsize;
    const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    return {
      capacity: used + free,
      used,
      free,
      database: ['', '-wal', '-shm'].reduce((n, ext) => n + fileSize(config.dbPath + ext), 0),
      attachments: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachments').get().n,
    };
  });

  // ---------- attachments ----------
  app.post('/api/notes/:id/attachments', async (req) => {
    const noteId = intParam(req.params.id);
    if (!exists('notes', noteId)) throw httpError(404, 'Note not found');
    const file = await req.file({ limits: { fileSize: config.maxUpload } });
    if (!file) throw httpError(400, 'No file uploaded');
    const storage = crypto.randomBytes(16).toString('hex');
    const dest = path.join(config.filesDir, storage);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
      if (file.file.truncated) throw httpError(413, 'File is too large');
    } catch (err) {
      unlinkStorage([storage]);
      throw err;
    }
    let filename = path.basename(file.filename || 'file').slice(0, 255);
    let mime = (file.mimetype || 'application/octet-stream').toLowerCase();
    // Recordings made in the app are converted so they play on every device.
    if (req.query.recording && mime.startsWith('audio/')) {
      const converted = `${dest}.m4a`;
      if (await toM4a(dest, converted)) {
        fs.renameSync(converted, dest);
        filename = `${filename.replace(/\.[^.]*$/, '')}.m4a`;
        mime = 'audio/mp4';
      } else {
        req.log.warn({ filename }, 'could not convert recording; keeping the original');
      }
    }
    const size = fs.statSync(dest).size;
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(noteId, filename, mime, size, storage, Date.now());
    // From the attachment manager (?append=1) there's no editor open: add the file to the end of the note's text.
    if (req.query.append) {
      const a = { id: Number(id), filename, mime, size };
      const block = mime.startsWith('image/') ? `<img src="/api/files/${a.id}" alt="${escapeHtml(filename)}">`
        : `<div data-attachment="${a.id}" data-filename="${escapeHtml(filename)}" data-mime="${escapeHtml(mime)}" data-size="${size}">${escapeHtml(filename)}</div>`;
      const html = `${db.prepare('SELECT html FROM notes WHERE id = ?').get(noteId).html}${block}`;
      db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), Date.now(), noteId);
    }
    return { id: Number(id), filename, mime, size };
  });

  app.delete('/api/attachments/:id', async (req) => {
    const id = intParam(req.params.id);
    const row = db.prepare('SELECT storage FROM attachments WHERE id = ?').get(id);
    if (!row) throw httpError(404, 'Attachment not found');
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    unlinkStorage([row.storage]);
    dropThumbs([row.storage]);
    return { ok: true };
  });

  // Attachment numbers can be used again once the newest ones are deleted, so a browser must ask each time (an
  // unchanged file is a quick 304 by its ETag). Before 7.3 these were cached for a year as immutable, and a reused
  // number kept showing the old file (a PDF opened as an earlier image); /api/clear-cache clears those.
  const FILE_CACHE = 'private, no-cache';
  app.get('/api/clear-cache', async (req, reply) => {
    reply.header('Clear-Site-Data', '"cache"');
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const a = db.prepare('SELECT filename, mime, storage FROM attachments WHERE id = ?').get(intParam(req.params.id));
    if (!a) throw httpError(404, 'File not found');
    // HEIC photos are shown from a JPEG copy (browsers can't show HEIC); Download gives the original.
    const jpeg = !req.query.download && isHeic(a.mime, a.filename) ? await heicJpeg(a) : null;
    if (jpeg) {
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename.replace(/\.(heic|heif)$/i, '') + '.jpg')}`);
      reply.header('Cache-Control', FILE_CACHE);
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
      return reply.sendFile(path.basename(jpeg), HEIC_DIR, { contentType: false, cacheControl: false });
    }
    const inline = INLINE_MIME.test(a.mime) && !req.query.download;
    reply.header('Content-Type', inline ? a.mime : 'application/octet-stream');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    reply.header('Cache-Control', FILE_CACHE);
    if (a.mime !== 'application/pdf') reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    return reply.sendFile(a.storage, config.filesDir, { contentType: false, cacheControl: false });
  });

  // ---------- .enex import ----------
  app.post('/api/import/enex', async (req) => {
    const results = [];
    const mode = req.query.mode === 'into' ? 'into' : 'perFile';
    const stackId = req.query.stack ? intParam(req.query.stack) : null;
    const targetNotebook = mode === 'into' ? intParam(req.query.notebook) : null;
    if (targetNotebook && !exists('notebooks', targetNotebook)) throw httpError(404, 'Notebook not found');

    for await (const part of req.files({ limits: { fileSize: config.maxImport } })) {
      let notebookId = targetNotebook;
      if (!notebookId) {
        const nbName = (part.filename || 'Imported').replace(/\.enex$/i, '').slice(0, 200) || 'Imported';
        notebookId = Number(db.prepare('INSERT INTO notebooks (name, stack_id, created_at) VALUES (?, ?, ?)')
          .run(nbName, stackId, Date.now()).lastInsertRowid);
      }
      const r = await importEnex(part.file, notebookId);
      if (part.file.truncated) r.errors.push('File exceeded the import size limit and was truncated');
      if (notebookId !== targetNotebook) absorbNotebooks([notebookId]); // 10.1: the file's name becomes a tag
      results.push({ file: part.filename, notebook_id: notebookId !== targetNotebook ? myNotesId() : notebookId, ...r });
    }
    return { results };
  });

  // ---------- Markdown import ----------
  // Query: mode=into&notebook=ID, or mode=new&name=…[&stack=ID]. Body: an optional "mtimes" field
  // ({ path: lastModified }) followed by .md files and the files they reference, each named by its
  // relative path so links like ![](img/a.png) can be matched up.
  app.post('/api/import/markdown', async (req) => {
    let notebookId;
    if (req.query.mode === 'new') {
      const stackId = req.query.stack ? intParam(req.query.stack) : null;
      if (stackId && !exists('stacks', stackId)) throw httpError(404, 'Shelf not found');
      notebookId = Number(db.prepare('INSERT INTO notebooks (name, stack_id, created_at) VALUES (?, ?, ?)')
        .run(name(req.query.name), stackId, Date.now()).lastInsertRowid);
    } else {
      notebookId = intParam(req.query.notebook);
      if (!exists('notebooks', notebookId)) throw httpError(404, 'Notebook not found');
    }
    const imp = new MarkdownImport({ notebookId });
    try {
      for await (const part of req.parts({ limits: { fileSize: config.maxUpload, files: 20000 } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'mtimes') try { imp.mtimes = JSON.parse(part.value); } catch { /* optional */ }
        } else {
          await imp.add(part);
        }
      }
    } catch (err) {
      imp.abort();
      throw err;
    }
    const done = imp.finish();
    if (req.query.mode === 'new') {
      absorbNotebooks([notebookId]); // 10.1: the name becomes a tag on the notes, in My notes
      return { notebook_id: myNotesId(), ...done };
    }
    return { notebook_id: notebookId, ...done };
  });
}
