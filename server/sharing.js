import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { broadcast } from './events.js';
import { methodOfNote } from './methods.js';
import { itemsOf } from './studies.js';
import { importPackage } from './notepack.js';
import { pushToAll } from './push.js';

/**
 * Sharing between the Selahs of a Selah Ministry server (8.0; through the share hub since 14.1): notes, notebooks and
 * projects (Desk studies) shared live and read-only with contacts, with margin comments going back to the owner.
 *
 * The share hub (server/hub/) keeps it all in one place: contacts, who each share is for, one copy of each shared
 * note and attachment, and the comments. This Selah reaches it over its own private network with its own key
 * (NOTEAPP_HUB_URL, NOTEAPP_HUB_KEY, from the admin console) and keeps only its own record of what it shares
 * (shares_out, share_people): every few seconds a share whose notes changed sends the hub a new snapshot. What's
 * shared with me is read from the hub when it's opened, never copied here. Events from the hub (a contact request,
 * something new shared, a comment) come in through a waiting request (GET /v1/events).
 *
 * Only on a Ministry Selah with a hub: Selah Desktop and Selah Cloud have no one to share with.
 */

const httpError = (code, message, data) => Object.assign(new Error(message), { statusCode: code, ...(data ? { data } : {}) });
const HUB = (process.env.NOTEAPP_HUB_URL || '').replace(/\/+$/, '');
const KEY = process.env.NOTEAPP_HUB_KEY || '';
delete process.env.NOTEAPP_HUB_KEY;
const enabled = () => config.mode === 'tenant' && !!HUB && !!KEY;
const SHARE_ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const KINDS = ['note', 'notebook', 'study'];
const MAX_NOTES = 500;
const OLD_DIR = path.join(config.storageDir, 'sharing'); // 8.0's snapshot folders, gone once moved to the hub
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const uid = () => crypto.randomBytes(16).toString('hex');
const myName = () => process.env.NOTEAPP_TENANT_NAME || config.tenant || '';

// Not in the admin console's database (it loads this file through tenant.js). The 8.0 tables after shares_out and
// share_people are only read once, to move to the hub, then emptied.
if (config.mode !== 'admin') db.exec(`
CREATE TABLE IF NOT EXISTS shares_out (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- note | notebook | study
  ref_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  allow_copy INTEGER NOT NULL DEFAULT 0,
  allow_comments INTEGER NOT NULL DEFAULT 1,
  sig TEXT,                                -- what the last snapshot the hub took was made from
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, ref_id)
);
CREATE TABLE IF NOT EXISTS share_people (
  share_id TEXT NOT NULL REFERENCES shares_out(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, slug)
);
CREATE TABLE IF NOT EXISTS share_contacts (slug TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shares_in (id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', allow_copy INTEGER NOT NULL DEFAULT 0, allow_comments INTEGER NOT NULL DEFAULT 1, project TEXT,
  received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seen_at INTEGER);
CREATE TABLE IF NOT EXISTS shared_notes (share_id TEXT NOT NULL, note_key INTEGER NOT NULL, position INTEGER NOT NULL, grp TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', work TEXT, attachments TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL, PRIMARY KEY (share_id, note_key));
CREATE TABLE IF NOT EXISTS share_comments (id TEXT PRIMARY KEY, share_id TEXT NOT NULL, side TEXT NOT NULL, peer TEXT NOT NULL,
  note_key INTEGER NOT NULL, thread_id TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '', prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  resolved_at INTEGER, seen_at INTEGER);
CREATE TABLE IF NOT EXISTS share_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, msg TEXT NOT NULL);`);

// ---------- talking to the hub ----------

let hubUp = false;
const unavailable = () => httpError(503, 'Sharing isn’t available right now. Try again in a minute.');

/** A request to the hub as this Selah; JSON in and out unless `raw`. Errors keep the hub's message and status. */
async function hub(method, url, body, { raw = false, timeout = 30_000, stream = null } = {}) {
  let res;
  try {
    res = await fetch(`${HUB}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(stream ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: stream ?? (body !== undefined ? JSON.stringify(body) : undefined),
      ...(stream ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    hubUp = false;
    throw unavailable();
  }
  hubUp = true;
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status === 401 || res.status >= 500 ? 503 : res.status, res.status === 401 ? 'Sharing isn’t set up for this Selah. Ask your Selah admin.' : data.error || 'The share hub said no.');
  return data;
}

const changed = (what, extra = {}) => broadcast({ sharing: what, ...extra });
const sharingOn = () => getSetting('sharing_off') !== 'yes';
function mustBeOn() {
  if (!enabled()) throw httpError(404, 'Sharing is part of Selah Ministry.');
  if (!sharingOn()) throw httpError(403, 'Sharing is turned off for your Selah. Ask your Selah admin.');
}

// ---------- my shares: what's in them, and their snapshots ----------

const NOTE_COLS = 'n.id, n.title, n.html, n.updated_at';

/** The shared notes, in reading order, with the part of a project each belongs to. */
function notesOf(share) {
  if (share.kind === 'note') {
    return db.prepare(`SELECT ${NOTE_COLS} FROM notes n WHERE n.id = ? AND n.deleted_at IS NULL`).all(share.ref_id).map((n) => ({ ...n, grp: '' }));
  }
  if (share.kind === 'notebook') {
    return db.prepare(`SELECT ${NOTE_COLS} FROM notes n WHERE n.notebook_id = ? AND n.deleted_at IS NULL AND n.is_template = 0
      ORDER BY n.pinned DESC, n.title COLLATE NOCASE LIMIT ?`).all(share.ref_id, MAX_NOTES).map((n) => ({ ...n, grp: '' }));
  }
  // A project: its schedule's notes in order, then chapters, then the rest of its notes.
  const seen = new Set();
  const out = [];
  const one = db.prepare(`SELECT ${NOTE_COLS} FROM notes n WHERE n.id = ? AND n.deleted_at IS NULL`);
  const add = (id, grp) => {
    if (!id || seen.has(id) || out.length >= MAX_NOTES) return;
    const n = one.get(id);
    if (!n) return;
    seen.add(id);
    out.push({ ...n, grp });
  };
  for (const it of itemsOf(share.ref_id)) add(it.note_id ?? it.noteId, it.title);
  for (const r of db.prepare("SELECT note_id FROM study_notes WHERE study_id = ? AND role = 'chapter' ORDER BY position, added_at").all(share.ref_id)) add(r.note_id, 'Chapters');
  for (const r of db.prepare("SELECT note_id FROM study_notes WHERE study_id = ? AND role != 'chapter' ORDER BY added_at").all(share.ref_id)) add(r.note_id, 'Notes');
  return out;
}

function refTitle(kind, id) {
  if (kind === 'note') return db.prepare('SELECT title FROM notes WHERE id = ? AND deleted_at IS NULL').get(id)?.title;
  if (kind === 'notebook') return db.prepare('SELECT name FROM notebooks WHERE id = ?').get(id)?.name;
  return db.prepare('SELECT title FROM studies WHERE id = ?').get(id)?.title;
}

function workOf(noteId) {
  const m = methodOfNote(noteId);
  if (!m || !['sermon', 'study', 'lesson'].includes(m.workflow)) return null;
  const passage = db.prepare('SELECT passage FROM sermons WHERE note_id = ?').get(noteId)?.passage
    ?? db.prepare('SELECT passage FROM bible_studies WHERE note_id = ?').get(noteId)?.passage ?? '';
  return { type: m.workflow, method: m.method ?? null, passage };
}

const people = (id) => db.prepare('SELECT slug FROM share_people WHERE share_id = ? ORDER BY slug').all(id).map((r) => r.slug);
const shareOf = (id) => db.prepare('SELECT * FROM shares_out WHERE id = ?').get(id);

/** What the snapshot depends on: when it differs from the last one the hub took, a new snapshot goes. */
function signature(share, notes) {
  const title = refTitle(share.kind, share.ref_id) ?? share.title;
  const study = share.kind === 'study' ? db.prepare('SELECT updated_at FROM studies WHERE id = ?').get(share.ref_id)?.updated_at : null;
  return crypto.createHash('sha1').update(JSON.stringify([title, study, share.allow_copy, share.allow_comments, people(share.id),
    notes.map((n) => [n.id, n.updated_at, n.grp])])).digest('hex');
}

let sending = Promise.resolve();
/** One snapshot at a time (the check loop and a person's Share both send). */
const queued = (fn) => { const p = sending.then(fn, fn); sending = p.catch(() => {}); return p; };

/** Sends the share's snapshot to the hub: attachments it doesn't have yet, then the notes. Returns who it's shared with. */
function sendSnapshot(share, notes = notesOf(share)) {
  return queued(async () => {
    const title = refTitle(share.kind, share.ref_id) ?? share.title;
    const list = notes.map((n, position) => {
      const atts = db.prepare('SELECT id, filename, mime, size, storage, created_at FROM attachments WHERE note_id = ?').all(n.id)
        .filter((a) => fs.existsSync(path.join(config.filesDir, a.storage)));
      return { key: n.id, position, grp: n.grp, title: n.title, html: n.html, updated_at: n.updated_at, work: workOf(n.id), attachments: atts };
    });
    const storages = [...new Set(list.flatMap((n) => n.attachments.map((a) => a.storage)))];
    const { missing } = await hub('POST', `/v1/shares/${share.id}/files/missing`, { storages });
    for (const f of missing) {
      await hub('PUT', `/v1/shares/${share.id}/files/${encodeURIComponent(f)}`, undefined,
        { stream: Readable.toWeb(fs.createReadStream(path.join(config.filesDir, f))), timeout: 30 * 60_000 });
    }
    let project = null;
    if (share.kind === 'study') {
      const s = db.prepare('SELECT kind, description FROM studies WHERE id = ?').get(share.ref_id);
      project = s ? { kind: s.kind, description: clip(s.description, 2000) } : null;
    }
    const r = await hub('PUT', `/v1/shares/${share.id}`, {
      kind: share.kind, title, project, allowCopy: !!share.allow_copy, allowComments: !!share.allow_comments, people: people(share.id), notes: list,
    }, { timeout: 120_000 });
    // The hub decides who it's really shared with (contacts, sharing on): this record follows.
    tx(() => {
      db.prepare(`DELETE FROM share_people WHERE share_id = ? AND slug NOT IN (${r.people.map(() => '?').join(', ') || "''"})`).run(share.id, ...r.people);
      db.prepare('UPDATE shares_out SET title = ?, sig = ?, sent_at = ? WHERE id = ?').run(title, signature(shareOf(share.id) ?? share, notes), Date.now(), share.id);
    });
    return r;
  });
}

/** Stops sharing: the hub forgets it (or will, if it isn't answering: the stop waits in pending_stops). */
async function stopShare(id) {
  db.prepare('DELETE FROM shares_out WHERE id = ?').run(id);
  try {
    await hub('DELETE', `/v1/shares/${id}`);
  } catch (e) {
    if (e.statusCode === 503) setSetting('hub_pending_stops', JSON.stringify([...new Set([...json(getSetting('hub_pending_stops'), []), id])]));
  }
}

let checking = false;
/** Every few seconds: a share whose notes changed sends a new snapshot; one whose note or notebook is gone stops. */
async function checkShares() {
  if (checking || !sharingOn()) return;
  checking = true;
  try {
    for (const id of json(getSetting('hub_pending_stops'), [])) {
      try { await hub('DELETE', `/v1/shares/${id}`); } catch (e) { if (e.statusCode === 503) return; }
      setSetting('hub_pending_stops', JSON.stringify(json(getSetting('hub_pending_stops'), []).filter((x) => x !== id)));
    }
    for (const share of db.prepare('SELECT * FROM shares_out').all()) {
      if (refTitle(share.kind, share.ref_id) == null) { await stopShare(share.id); continue; }
      const notes = notesOf(share);
      if (signature(share, notes) === share.sig) continue;
      try {
        await sendSnapshot(share, notes);
      } catch (e) {
        if (e.statusCode === 503) return; // the hub isn't answering: try again next time
        console.error(`Sharing: snapshot of ${share.id} failed: ${e.message}`);
      }
    }
  } finally {
    checking = false;
  }
}

// ---------- events from the hub ----------

function onEvent(e) {
  switch (e.type) {
    case 'contact-request':
      pushToAll(`${e.name || e.from} wants to share with you`, 'Open Shared with me to answer.', { section: 'shared' });
      return changed('contacts', { from: e.name || e.from, request: true });
    case 'contact-accepted':
      return changed('contacts', { from: e.name || e.from, accepted: true });
    case 'contact-removed':
      // Their shares to me ended at the hub; mine to them stop too.
      db.prepare('DELETE FROM share_people WHERE slug = ?').run(String(e.from ?? ''));
      for (const s of db.prepare('SELECT id FROM shares_out WHERE NOT EXISTS (SELECT 1 FROM share_people p WHERE p.share_id = shares_out.id)').all()) stopShare(s.id);
      return changed('contacts');
    case 'contact-error':
    case 'share-error':
      return changed('error', { error: clip(e.error, 300) });
    case 'share-new':
      pushToAll(`${e.name || e.from} shared with you`, e.title || 'Something new', { section: 'shared' });
      return changed('new', { share: e.id, from: e.name || e.from, title: e.title });
    case 'share-updated':
      return changed('updated', { share: e.id, from: e.name || e.from, title: e.title });
    case 'share-revoked':
      return changed('revoked', { share: e.id });
    case 'comment':
      return changed(e.reply ? 'reply' : 'comment', { share: e.shareId, note: e.noteKey, from: e.name || e.from });
    case 'comment-changed':
      return changed('comment', { share: e.shareId });
    case 'state':
      setSetting('sharing_off', e.on === false ? 'yes' : 'no');
      return changed('state');
    default:
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventLoop() {
  for (;;) {
    try {
      const after = Number(getSetting('hub_events_after') ?? 0);
      const { events } = await hub('GET', `/v1/events?after=${after}&wait=25000`, undefined, { timeout: 40_000 });
      for (const e of events) {
        try { onEvent(e); } catch (err) { console.error(`Sharing: event ${e.type} failed: ${err.message}`); }
        setSetting('hub_events_after', String(e.seq));
      }
      if (!getSetting('hub_moved')) await moveToHub();
    } catch {
      await pause(5000); // the hub is restarting or being updated
    }
  }
}

// ---------- moving in (14.1): 8.0's records to the hub, once ----------

/**
 * What this Selah kept before the hub: its own shares go to the hub as fresh snapshots (the console moved the
 * contacts in first), with the comments on them; the copies of what others shared with it, its contact list and the
 * snapshot folders are no longer needed. Waits until the hub has the console's contacts (me.ready).
 */
async function moveToHub() {
  const me = await hub('GET', '/v1/me');
  if (!me.ready) return;
  setSetting('sharing_off', me.sharing ? 'no' : 'yes');
  for (const share of db.prepare('SELECT * FROM shares_out').all()) {
    try {
      await sendSnapshot(share);
      const comments = db.prepare("SELECT * FROM share_comments WHERE side = 'out' AND share_id = ?").all(share.id).map((c) => ({
        id: c.id, noteKey: c.note_key, threadId: c.thread_id, peer: c.peer, author: c.author === config.tenant ? config.tenant : c.peer,
        authorName: c.author_name, body: c.body, quote: c.quote, prefix: c.prefix, suffix: c.suffix, createdAt: c.created_at,
        resolvedAt: c.resolved_at, seen: !!c.seen_at,
      }));
      if (comments.length) await hub('POST', '/v1/migrate/comments', { shareId: share.id, comments });
    } catch (e) {
      if (e.statusCode === 503) throw e;
      console.error(`Sharing: moving ${share.id} to the hub failed: ${e.message}`);
    }
  }
  tx(() => {
    for (const t of ['share_contacts', 'shares_in', 'shared_notes', 'share_comments', 'share_outbox']) db.exec(`DELETE FROM ${t}`);
    setSetting('hub_moved', String(Date.now()));
  });
  fs.rmSync(OLD_DIR, { recursive: true, force: true });
  changed('contacts');
}

// ---------- what the pages ask for ----------

async function myShares(contacts = null) {
  const list = db.prepare('SELECT * FROM shares_out ORDER BY created_at DESC').all();
  if (!list.length) return [];
  const names = new Map((contacts ?? (await hub('GET', '/v1/contacts')).contacts).map((c) => [c.slug, c.name || c.slug]));
  const unread = list.length ? (await hub('GET', '/v1/mine')).shares : {};
  return list.map((s) => ({
    id: s.id, kind: s.kind, refId: s.ref_id, title: s.title || refTitle(s.kind, s.ref_id) || '', allowCopy: !!s.allow_copy,
    allowComments: !!s.allow_comments, sentAt: s.sent_at, people: people(s.id).map((slug) => ({ slug, name: names.get(slug) ?? slug })),
    comments: unread[s.id] ?? 0,
  }));
}

const ownerShareOf = (kind, refId) => db.prepare('SELECT * FROM shares_out WHERE kind = ? AND ref_id = ?').get(kind, refId);
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|audio\/|video\/)/;
const sid = (v) => { const id = String(v ?? ''); if (!SHARE_ID.test(id)) throw httpError(404, 'This was shared with you but isn’t any more.'); return id; };

// ---------- routes ----------

export default async function sharingRoutes(app) {
  app.get('/api/sharing', async () => {
    if (!enabled()) return { enabled: false };
    const [{ contacts }, { shares }, mine] = await Promise.all([hub('GET', '/v1/contacts'), hub('GET', '/v1/shared'), hub('GET', '/v1/mine')]);
    const title = db.prepare('SELECT title FROM notes WHERE id = ? AND deleted_at IS NULL');
    return {
      enabled: true, on: sharingOn(), me: { slug: config.tenant, name: myName() },
      contacts, sharedWithMe: shares, myShares: await myShares(contacts),
      // My notes with comments I haven't read, for Home.
      newComments: mine.notes.map((n) => ({ noteId: n.noteKey, title: title.get(n.noteKey)?.title, count: n.count, at: n.at, fromName: n.fromName }))
        .filter((n) => n.title != null),
    };
  });

  app.post('/api/sharing/contacts', async (req) => {
    mustBeOn();
    const slug = String(req.body?.slug ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\..*$/, '');
    if (!SLUG.test(slug)) throw httpError(400, 'Type their Selah name: the first part of their Selah web address.');
    if (slug === config.tenant) throw httpError(400, 'That’s you.');
    return hub('POST', '/v1/contacts', { to: slug });
  });

  app.post('/api/sharing/contacts/:slug/accept', async (req) => {
    mustBeOn();
    return hub('POST', `/v1/contacts/${encodeURIComponent(req.params.slug)}/accept`);
  });

  // Declines a request, cancels mine, or removes a contact (which ends everything shared between us).
  app.delete('/api/sharing/contacts/:slug', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    const slug = String(req.params.slug);
    const r = await hub('DELETE', `/v1/contacts/${encodeURIComponent(slug)}`);
    db.prepare('DELETE FROM share_people WHERE slug = ?').run(slug);
    for (const s of db.prepare('SELECT id FROM shares_out WHERE NOT EXISTS (SELECT 1 FROM share_people p WHERE p.share_id = shares_out.id)').all()) await stopShare(s.id);
    return r;
  });

  // The share of a note, notebook or project of mine (null when it isn't shared).
  app.get('/api/sharing/item', async (req) => {
    if (!enabled()) return { share: null };
    const kind = String(req.query.kind);
    if (!KINDS.includes(kind)) throw httpError(400, 'Bad kind');
    const s = ownerShareOf(kind, Number(req.query.id));
    return { share: s ? (await myShares()).find((x) => x.id === s.id) : null };
  });

  // Shares it with these people (an empty list stops sharing it).
  app.put('/api/sharing/item', async (req) => {
    mustBeOn();
    const b = req.body ?? {};
    const kind = String(b.kind);
    const refId = Number(b.id);
    if (!KINDS.includes(kind) || !Number.isInteger(refId)) throw httpError(400, 'Bad item');
    if (refTitle(kind, refId) == null) throw httpError(404, 'Not found');
    const list = [...new Set((Array.isArray(b.people) ? b.people : []).map(String))];
    const { contacts } = await hub('GET', '/v1/contacts');
    for (const slug of list) if (!contacts.some((c) => c.slug === slug && c.status === 'accepted')) throw httpError(400, `${slug} isn’t one of your contacts.`);
    let s = ownerShareOf(kind, refId);
    if (!list.length) {
      if (s) await stopShare(s.id);
      return { share: null };
    }
    if (!s) {
      const id = uid();
      db.prepare('INSERT INTO shares_out (id, kind, ref_id, title, allow_copy, allow_comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, kind, refId, refTitle(kind, refId), b.allowCopy ? 1 : 0, b.allowComments === false ? 0 : 1, Date.now());
      s = shareOf(id);
    } else {
      db.prepare('UPDATE shares_out SET allow_copy = ?, allow_comments = ? WHERE id = ?').run(b.allowCopy ? 1 : 0, b.allowComments === false ? 0 : 1, s.id);
    }
    const now = Date.now();
    tx(() => {
      db.prepare(`DELETE FROM share_people WHERE share_id = ? AND slug NOT IN (${list.map(() => '?').join(', ')})`).run(s.id, ...list);
      for (const slug of list) db.prepare('INSERT OR IGNORE INTO share_people (share_id, slug, added_at) VALUES (?, ?, ?)').run(s.id, slug, now);
    });
    await sendSnapshot(shareOf(s.id));
    return { share: (await myShares(contacts)).find((x) => x.id === s.id) };
  });

  app.delete('/api/sharing/out/:id', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    const s = shareOf(String(req.params.id));
    if (!s) throw httpError(404, 'Not shared');
    await stopShare(s.id);
    return { ok: true };
  });

  // ----- shared with me (read from the hub) -----

  app.get('/api/shared/:id', async (req) => hub('GET', `/v1/shared/${sid(req.params.id)}`));
  app.post('/api/shared/:id/seen', async (req) => hub('POST', `/v1/shared/${sid(req.params.id)}/seen`));
  app.get('/api/shared/:id/notes/:key', async (req) => hub('GET', `/v1/shared/${sid(req.params.id)}/notes/${Number(req.params.key)}`));

  app.get('/api/shared/:id/files/:att', async (req, reply) => {
    const res = await hub('GET', `/v1/shared/${sid(req.params.id)}/files/${Number(req.params.att)}`, undefined, { raw: true, timeout: 30 * 60_000 });
    const mime = String(res.headers.get('x-selah-mime') ?? 'application/octet-stream');
    const filename = decodeURIComponent(String(res.headers.get('x-selah-filename') ?? 'file'));
    // The type comes from someone else's Selah: only plain media show in the page, and nothing runs.
    const inline = INLINE_MIME.test(mime) && !req.query.download;
    reply.header('Content-Type', inline ? mime : 'application/octet-stream');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    reply.header('Cache-Control', 'private, no-cache');
    if (res.headers.get('content-length')) reply.header('Content-Length', res.headers.get('content-length'));
    if (mime !== 'application/pdf') reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    return reply.send(Readable.fromWeb(res.body));
  });

  // A copy of the note (key) or the whole share, as my own notes, when the owner allows it.
  app.post('/api/shared/:id/copy', async (req) => {
    const id = sid(req.params.id);
    const key = req.body?.key != null ? Number(req.body.key) : null;
    const all = await hub('GET', `/v1/shared/${id}/all${key != null ? `?key=${key}` : ''}`);
    const from = all.ownerName || all.owner;
    const nbName = key != null ? `From ${from}` : all.title || `From ${from}`;
    const tmp = fs.mkdtempSync(path.join(config.dataDir, 'shared-copy-'));
    try {
      const now = Date.now();
      const pkg = {
        app: 'Selah', kind: 'notes', version: 1, createdAt: now,
        notebooks: [{ key: 'shared', id: null, name: nbName, stack: null, whole: key == null }],
        notes: all.notes.map((n) => ({
          id: n.key, notebook: 'shared', title: n.title,
          html: n.html.replace(new RegExp(`/api/shared/${id}/files/(\\d+)`, 'g'), '/api/files/$1'),
          created_at: n.updatedAt, updated_at: n.updatedAt, pinned: 0, is_template: 0, tags: [],
          attachments: n.attachments.map((a) => ({ ...a, storage: `att-${a.id}` })),
        })),
      };
      // Each attachment comes from the hub as it's needed.
      const resolveFile = async (storage) => {
        const att = Number(String(storage).replace(/^att-/, ''));
        const file = path.join(tmp, `att-${att}`);
        if (!fs.existsSync(file)) {
          const res = await hub('GET', `/v1/shared/${id}/files/${att}`, undefined, { raw: true, timeout: 30 * 60_000 });
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
        }
        return file;
      };
      const r = await importPackage(pkg, { resolveFile, label: 'copy', newNotebooks: key == null });
      return { ...r, noteId: r.noteIds?.[0] ?? null };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A comment on a note shared with me (a new thread, or a reply in one of mine).
  app.post('/api/shared/:id/comments', async (req) => {
    mustBeOn();
    return hub('POST', `/v1/shared/${sid(req.params.id)}/comments`, req.body ?? {});
  });

  // ----- comments on my notes -----

  app.get('/api/notes/:id/share-comments', async (req) => {
    const noteId = Number(req.params.id);
    if (!enabled()) return { shares: [], threads: [] };
    const mine = db.prepare('SELECT * FROM shares_out').all().filter((share) => (share.kind === 'note' ? share.ref_id === noteId : notesOf(share).some((n) => n.id === noteId)));
    if (!mine.length) return { shares: [], threads: [] };
    const shares = (await myShares()).filter((s) => mine.some((m) => m.id === s.id));
    const { threads } = await hub('GET', `/v1/mine/threads?note=${noteId}`);
    return {
      shares: shares.map((s) => ({ id: s.id, kind: s.kind, refId: s.refId, title: s.title, people: s.people, allowComments: s.allowComments })),
      threads,
    };
  });

  app.post('/api/notes/:id/share-comments/seen', async (req) => {
    if (!enabled()) return { ok: true };
    return hub('POST', '/v1/mine/seen', { note: Number(req.params.id) });
  });

  // A reply in a thread (on my note: to the person who started it; on a shared note: to its owner).
  app.post('/api/sharing/threads/:thread/reply', async (req) => {
    mustBeOn();
    return hub('POST', `/v1/threads/${encodeURIComponent(req.params.thread)}/reply`, { body: req.body?.body });
  });

  // The owner resolves a thread (it folds away for both), or opens it again.
  app.post('/api/sharing/threads/:thread/resolve', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    return hub('POST', `/v1/threads/${encodeURIComponent(req.params.thread)}/resolve`, { resolved: req.body?.resolved !== false });
  });

  // Deletes a comment of mine (a thread's first comment takes the thread with it).
  app.delete('/api/sharing/comments/:id', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    return hub('DELETE', `/v1/comments/${encodeURIComponent(req.params.id)}`);
  });
}

// ---------- the control port's part (server/tenant.js) ----------

export function sharingControl(app) {
  // Turned off (or on again) for this tenant from the console. Since 14.1 the hub says so too (a state event).
  app.post('/control/sharing/state', async (req) => {
    setSetting('sharing_off', req.body?.on === false ? 'yes' : 'no');
    changed('state');
    return { ok: true };
  });
}

export const sharingHealth = () => (enabled() ? {
  on: sharingOn(),
  hub: hubUp,
  sharing: db.prepare('SELECT COUNT(*) AS n FROM shares_out').get().n,
} : null);

/** Ministry with a hub: events from the hub, and changed shares looked for every few seconds. */
export function startSharing() {
  if (!enabled()) return;
  eventLoop();
  setInterval(() => { checkShares().catch((e) => console.error(`Sharing: ${e.message}`)); }, Number(process.env.NOTEAPP_SHARE_CHECK_MS || 4000)).unref();
}
