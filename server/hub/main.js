import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import {
  allowed, areContacts, clip, contactRow, db, dropShare, emit, eventsFor, getSetting, httpError, json, log, nameOf, pair,
  peopleOf, setSetting, shareFiles, shareRow, sharesWith, sha256, slugForKey, tenant, tx,
} from './store.js';
import { htmlToText } from '../html.js';

/**
 * The share hub (14.1): sharing between the Selahs of a Selah Ministry server, in one place. Started by the admin
 * console (server/admin/hub.js) as its own container (or service), from the same release as the Selahs:
 *   node server/hub/main.js
 * Two listeners:
 *   - the Selahs' API (NOTEAPP_HUB_PORT, 8090): each Selah reaches it over its own private network, with its own key
 *     (Authorization: Bearer). Contacts, shares (one copy of the notes and attachments), comments, and events
 *     each Selah picks up with a waiting request. Below, `me` is always the Selah the key belongs to.
 *   - the console's (NOTEAPP_HUB_CONTROL_PORT, 8091, published only on 127.0.0.1): the list of Selahs and their keys,
 *     sharing on or off for one, forgetting one, the overview for the console's Sharing page, and moving the console's
 *     older records (the 8.0 relay) in.
 * What a Selah says about itself is never trusted: who is a contact of whom, who owns a share and who it's shared with
 * are all checked here.
 */

const PORT = Number(process.env.NOTEAPP_HUB_PORT || 8090);
const CONTROL_PORT = Number(process.env.NOTEAPP_HUB_CONTROL_PORT || 8091);
const HOST = process.env.NOTEAPP_HUB_HOST || '0.0.0.0';
// In its container the console's port listens only on the first network (eth0: Docker's bridge, where the published
// 127.0.0.1 port arrives), not on the Selahs' networks the hub joins later (NOTEAPP_HUB_CONTROL_IFACE=eth0).
function controlHost() {
  const iface = process.env.NOTEAPP_HUB_CONTROL_IFACE;
  if (!iface) return process.env.NOTEAPP_HUB_CONTROL_HOST || '0.0.0.0';
  const a = (os.networkInterfaces()[iface] ?? []).find((x) => x.family === 'IPv4');
  if (!a) { console.error(`No IPv4 address on ${iface} for the console's port.`); process.exit(1); }
  return a.address;
}
const CONTROL_HOST = controlHost();
const CONTROL_TOKEN = process.env.NOTEAPP_HUB_CONTROL_TOKEN || '';
delete process.env.NOTEAPP_HUB_CONTROL_TOKEN;
if (CONTROL_TOKEN.length < 32) { console.error('NOTEAPP_HUB_CONTROL_TOKEN is missing or too short.'); process.exit(1); }
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const SHARE_ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const STORAGE = /^[\w.-]{1,200}$/;
const KINDS = ['note', 'notebook', 'study'];
const MAX_NOTES = 500;
const MAX_FILE = Number(process.env.NOTEAPP_HUB_MAX_FILE || 1024 * 1024 * 1024);
const uid = () => crypto.randomBytes(16).toString('hex');

// ---------- what a Selah sees ----------

function contactsOf(me) {
  return db.prepare('SELECT * FROM contacts WHERE a = ? OR b = ?').all(me, me).map((c) => {
    const slug = c.a === me ? c.b : c.a;
    return { slug, name: nameOf(slug), status: c.status === 'accepted' ? 'accepted' : c.requested_by === me ? 'outgoing' : 'incoming', at: c.at };
  }).sort((x, y) => (x.status === 'accepted') - (y.status === 'accepted') || x.name.localeCompare(y.name));
}

const unseenWhere = "NOT EXISTS (SELECT 1 FROM comment_seen s WHERE s.comment_id = c.id AND s.slug = ?) AND c.author != ?";

function sharedWithMe(me) {
  return db.prepare(`SELECT s.*, p.seen_at, p.added_at,
      (SELECT COUNT(*) FROM notes n WHERE n.share_id = s.id) AS notes,
      (SELECT COUNT(*) FROM comments c WHERE c.share_id = s.id AND c.peer = ? AND ${unseenWhere}) AS replies
    FROM shares s JOIN share_people p ON p.share_id = s.id AND p.slug = ?
    WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.slug = s.owner AND t.active = 1)
    ORDER BY s.updated_at DESC`).all(me, me, me, me).map((s) => ({
    id: s.id, owner: s.owner, ownerName: nameOf(s.owner), kind: s.kind, title: s.title, allowCopy: !!s.allow_copy,
    allowComments: !!s.allow_comments, project: json(s.project, null), receivedAt: s.added_at, updatedAt: s.updated_at,
    unseen: !s.seen_at || s.seen_at < s.updated_at, isNew: !s.seen_at, notes: s.notes, replies: s.replies,
  }));
}

function commentView(c, me, side) {
  const seen = c.author === me || !!db.prepare('SELECT 1 FROM comment_seen WHERE comment_id = ? AND slug = ?').get(c.id, me);
  return {
    id: c.id, shareId: c.share_id, side, peer: side === 'out' ? c.peer : shareRow(c.share_id)?.owner ?? '', noteKey: c.note_key,
    threadId: c.thread_id, author: c.author, authorName: c.author_name || nameOf(c.author), mine: c.author === me, body: c.body,
    quote: c.quote, prefix: c.prefix, suffix: c.suffix, createdAt: c.created_at, resolvedAt: c.resolved_at, seen,
  };
}

/** Comments grouped into threads (oldest first), unresolved threads first: the shape the pages already use. */
function threads(rows, me, side) {
  const map = new Map();
  for (const c of rows.map((r) => commentView(r, me, side))) {
    if (!map.has(c.threadId)) map.set(c.threadId, { id: c.threadId, shareId: c.shareId, noteKey: c.noteKey, peer: c.peer, quote: '', prefix: '', suffix: '', comments: [] });
    const t = map.get(c.threadId);
    if (c.id === c.threadId) Object.assign(t, { quote: c.quote, prefix: c.prefix, suffix: c.suffix, resolvedAt: c.resolvedAt });
    t.comments.push(c);
  }
  return [...map.values()].sort((a, b) => (!!a.resolvedAt - !!b.resolvedAt) || a.comments[0].createdAt - b.comments[0].createdAt);
}

const markSeen = (ids, me) => {
  const put = db.prepare('INSERT OR IGNORE INTO comment_seen (comment_id, slug) VALUES (?, ?)');
  for (const id of ids) put.run(id, me);
};

function mustIncoming(me, id) {
  const s = shareRow(id);
  if (!s || !sharesWith(me, s.id) || !tenant(s.owner)?.active) throw httpError(404, 'This was shared with you but isn’t any more.');
  return s;
}
function mustMine(me, id) {
  const s = shareRow(id);
  if (!s || s.owner !== me) throw httpError(404, 'Not shared');
  return s;
}
function noteOf(s, key) {
  const n = db.prepare('SELECT * FROM notes WHERE share_id = ? AND note_key = ?').get(s.id, Number(key));
  if (!n) throw httpError(404, 'That note isn’t in the share any more.');
  return n;
}
const mustSharing = (me) => { if (!allowed(me)) throw httpError(403, 'Sharing is turned off for your Selah. Ask your Selah admin.'); };

// ---------- changes ----------

/** Everything shared between two Selahs ends (contact removed, or one of them forgotten). */
function endBetween(x, y) {
  for (const s of db.prepare('SELECT * FROM shares WHERE owner IN (?, ?)').all(x, y)) {
    const other = s.owner === x ? y : x;
    if (!sharesWith(other, s.id)) continue;
    db.prepare('DELETE FROM share_people WHERE share_id = ? AND slug = ?').run(s.id, other);
    db.prepare('DELETE FROM comments WHERE share_id = ? AND peer = ?').run(s.id, other);
    emit(other, { type: 'share-revoked', id: s.id, from: s.owner });
  }
}

function accept(me, other) {
  db.prepare('UPDATE contacts SET status = ?, at = ? WHERE a = ? AND b = ?').run('accepted', Date.now(), ...pair(me, other));
  log('contact-accepted', me, other);
  emit(other, { type: 'contact-accepted', from: me, name: nameOf(me) });
  emit(me, { type: 'contact-accepted', from: other, name: nameOf(other) });
}

/** A snapshot from the owner: the share's details, who it's for, and its notes (attachments uploaded first). */
function saveShare(me, id, b) {
  const kind = String(b.kind);
  if (!KINDS.includes(kind)) throw httpError(400, 'Bad kind');
  const old = shareRow(id);
  if (old && old.owner !== me) throw httpError(403, 'Not your share.');
  const title = clip(b.title, 300);
  const wanted = [...new Set((Array.isArray(b.people) ? b.people : []).map(String))].filter((p) => SLUG.test(p) && p !== me);
  const ok = wanted.filter((p) => areContacts(me, p) && allowed(p));
  const refused = wanted.filter((p) => !ok.includes(p));
  const list = (Array.isArray(b.notes) ? b.notes : []).slice(0, MAX_NOTES);
  const dir = shareFiles(id);
  const now = Date.now();
  const before = old ? peopleOf(id) : [];
  let visible = !old;
  tx(() => {
    const project = b.project ? JSON.stringify({ kind: clip(b.project.kind, 20), description: clip(b.project.description, 2000) }) : null;
    if (old) {
      visible ||= old.title !== title || old.kind !== kind || old.project !== project || !!old.allow_copy !== !!b.allowCopy || !!old.allow_comments !== !!b.allowComments;
    }
    db.prepare(`INSERT INTO shares (id, owner, kind, title, project, allow_comments, allow_copy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, project = excluded.project,
        allow_comments = excluded.allow_comments, allow_copy = excluded.allow_copy`)
      .run(id, me, kind, title, project, b.allowComments ? 1 : 0, b.allowCopy ? 1 : 0, now, now);
    const was = new Map(db.prepare('SELECT note_key, updated_at FROM notes WHERE share_id = ?').all(id).map((r) => [r.note_key, r.updated_at]));
    db.prepare('DELETE FROM notes WHERE share_id = ?').run(id);
    const ins = db.prepare(`INSERT OR IGNORE INTO notes (share_id, note_key, position, grp, title, html, text, work, attachments, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const keep = new Set();
    for (const [i, n] of list.entries()) {
      const key = Number(n.key);
      if (!Number.isInteger(key) || key <= 0) continue;
      const atts = (Array.isArray(n.attachments) ? n.attachments : []).map((a) => ({
        id: Number(a.id), filename: clip(a.filename, 255), mime: clip(a.mime, 100), size: Number(a.size) || 0, storage: String(a.storage ?? ''),
        created_at: Number(a.created_at) || now,
      })).filter((a) => Number.isInteger(a.id) && STORAGE.test(a.storage) && fs.existsSync(path.join(dir, a.storage)));
      for (const a of atts) keep.add(a.storage);
      // Links to the owner's other notes would open the reader's own: they become plain text. Images come from here.
      const html = String(n.html ?? '')
        .replace(/<a\b[^>]*\bdata-note-id="\d+"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
        .replace(/(<img\b[^>]*\bsrc=")\/api\/files\/(\d+)(?:\?[^"]*)?"/gi, `$1/api/shared/${id}/files/$2"`);
      const work = n.work && ['sermon', 'study', 'lesson'].includes(n.work.type)
        ? JSON.stringify({ type: n.work.type, method: n.work.method ? clip(n.work.method, 40) : null, passage: clip(n.work.passage, 120) }) : null;
      const updated = Number(n.updated_at) || now;
      if (was.get(key) !== updated) visible = true;
      was.delete(key);
      ins.run(id, key, i, clip(n.grp, 200), clip(n.title, 500), html, htmlToText(html).slice(0, 200_000), work, JSON.stringify(atts), updated);
    }
    if (was.size) visible = true; // notes taken out
    if (visible && old) db.prepare('UPDATE shares SET updated_at = ? WHERE id = ?').run(now, id);
    db.prepare(`DELETE FROM share_people WHERE share_id = ? AND slug NOT IN (${ok.map(() => '?').join(', ') || "''"})`).run(id, ...ok);
    for (const p of ok) db.prepare('INSERT OR IGNORE INTO share_people (share_id, slug, added_at) VALUES (?, ?, ?)').run(id, p, now);
    // Attachments no note uses any more go.
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (!keep.has(f) && !f.endsWith('.part')) fs.rmSync(path.join(dir, f), { force: true });
  });
  for (const p of before.filter((x) => !ok.includes(x))) {
    db.prepare('DELETE FROM comments WHERE share_id = ? AND peer = ?').run(id, p);
    emit(p, { type: 'share-revoked', id, from: me });
    log('share-removed', me, p, title);
  }
  for (const p of ok) {
    if (!before.includes(p)) {
      emit(p, { type: 'share-new', id, from: me, name: nameOf(me), title });
      log('shared', me, p, title, kind);
    } else if (visible) emit(p, { type: 'share-updated', id, from: me, name: nameOf(me), title });
  }
  if (refused.length) {
    emit(me, { type: 'share-error', error: `“${title}” couldn’t be shared with ${refused.map(nameOf).join(', ')}: ${refused.length === 1 ? 'they aren’t' : 'they aren’t all'} contacts, or sharing is off for them.` });
  }
  return { people: ok, refused };
}

function stopShare(me, id) {
  const s = mustMine(me, id);
  for (const p of peopleOf(s.id)) emit(p, { type: 'share-revoked', id: s.id, from: me });
  dropShare(s.id);
  log('share-stopped', me, null, s.title);
}

function newComment(me, s, n, b, peer) {
  const id = uid();
  const threadId = b.threadId ? String(b.threadId) : id;
  if (threadId !== id) {
    const root = db.prepare('SELECT * FROM comments WHERE id = ? AND thread_id = id AND share_id = ?').get(threadId, s.id);
    if (!root || root.peer !== peer) throw httpError(404, 'That thread is gone.');
  }
  const c = {
    id, share_id: s.id, note_key: n.note_key, thread_id: threadId, peer, author: me, author_name: nameOf(me), body: clip(b.body, 4000),
    quote: threadId === id ? clip(b.quote, 500) : '', prefix: threadId === id ? clip(b.prefix, 60) : '', suffix: threadId === id ? clip(b.suffix, 60) : '',
    created_at: Date.now(),
  };
  if (!c.body) throw httpError(400, 'Write a comment first.');
  db.prepare(`INSERT INTO comments (id, share_id, note_key, thread_id, peer, author, author_name, body, quote, prefix, suffix, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.share_id, c.note_key, c.thread_id, c.peer, c.author, c.author_name, c.body, c.quote, c.prefix, c.suffix, c.created_at);
  const to = me === s.owner ? peer : s.owner;
  emit(to, { type: 'comment', shareId: s.id, noteKey: n.note_key, from: me, name: nameOf(me), reply: me === s.owner });
  log(me === s.owner ? 'reply' : 'comment', me, to, s.title);
  return c;
}

// ---------- the Selahs' API ----------

const api = Fastify({ logger: { level: process.env.NOTEAPP_LOG_LEVEL || 'info' }, bodyLimit: 64 * 1024 * 1024 });
api.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
api.addHook('onRequest', async (req) => {
  if (req.url === '/health') return;
  const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const me = slugForKey(key);
  if (!me) throw httpError(401, 'Unknown Selah.');
  const t = tenant(me);
  if (!t.active) throw httpError(403, 'This Selah is paused.');
  req.me = me;
  db.prepare('UPDATE tenants SET seen_at = ? WHERE slug = ?').run(Date.now(), me);
});
api.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: code >= 500 ? 'The share hub had a problem.' : err.message });
});

api.get('/health', async () => ({ ok: true, version: VERSION }));
// ready: the console has moved its older records in (POST /control/import), so a Selah can move its own shares in.
api.get('/v1/me', async (req) => ({ slug: req.me, name: nameOf(req.me), sharing: allowed(req.me), ready: !!getSetting('imported'), version: VERSION }));
api.get('/v1/events', async (req) => {
  const after = Number(req.query.after) || 0;
  const wait = Math.min(30_000, Math.max(0, Number(req.query.wait) || 0));
  return { events: await eventsFor(req.me, after, wait) };
});

// ----- contacts -----

api.get('/v1/contacts', async (req) => ({ contacts: contactsOf(req.me) }));

api.post('/v1/contacts', async (req) => {
  const me = req.me;
  mustSharing(me);
  const to = String(req.body?.to ?? '');
  if (!SLUG.test(to) || to === me) throw httpError(400, 'Type their Selah name: the first part of their Selah web address.');
  if (!tenant(to) || !tenant(to).active) throw httpError(404, `There’s no one called “${to}” on this Selah server.`);
  if (!allowed(to)) throw httpError(409, `${nameOf(to)} can’t take contact requests right now.`);
  const c = contactRow(me, to);
  if (c?.status === 'accepted') throw httpError(409, `${nameOf(to)} is already a contact.`);
  if (c?.status === 'pending' && c.requested_by === to) accept(me, to);
  else if (!c) {
    db.prepare('INSERT INTO contacts (a, b, status, requested_by, at) VALUES (?, ?, ?, ?, ?)').run(...pair(me, to), 'pending', me, Date.now());
    log('contact-request', me, to);
    emit(to, { type: 'contact-request', from: me, name: nameOf(me) });
  }
  return { contacts: contactsOf(me) };
});

api.post('/v1/contacts/:slug/accept', async (req) => {
  const me = req.me;
  mustSharing(me);
  const other = String(req.params.slug);
  const c = contactRow(me, other);
  if (!c || c.status !== 'pending' || c.requested_by !== other) throw httpError(404, 'There’s no request from them.');
  accept(me, other);
  return { contacts: contactsOf(me) };
});

// Declines a request, cancels mine, or removes a contact (which ends everything shared between us).
api.delete('/v1/contacts/:slug', async (req) => {
  const me = req.me;
  const other = String(req.params.slug);
  if (!contactRow(me, other)) throw httpError(404, 'Not a contact.');
  db.prepare('DELETE FROM contacts WHERE a = ? AND b = ?').run(...pair(me, other));
  endBetween(me, other);
  log('contact-removed', me, other);
  emit(other, { type: 'contact-removed', from: me });
  return { contacts: contactsOf(me) };
});

// ----- my shares -----

// Which attachments the hub doesn't have yet (so only those are uploaded).
api.post('/v1/shares/:id/files/missing', async (req) => {
  const id = String(req.params.id);
  if (!SHARE_ID.test(id)) throw httpError(400, 'Bad share');
  const s = shareRow(id);
  if (s && s.owner !== req.me) throw httpError(403, 'Not your share.');
  const list = (Array.isArray(req.body?.storages) ? req.body.storages : []).map(String).filter((f) => STORAGE.test(f));
  return { missing: list.filter((f) => !fs.existsSync(path.join(shareFiles(id), f))) };
});

api.put('/v1/shares/:id/files/:storage', async (req) => {
  const id = String(req.params.id);
  const name = String(req.params.storage);
  if (!SHARE_ID.test(id) || !STORAGE.test(name)) throw httpError(400, 'Bad file');
  const s = shareRow(id);
  if (s && s.owner !== req.me) throw httpError(403, 'Not your share.');
  mustSharing(req.me);
  const dir = shareFiles(id);
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `${name}.${crypto.randomBytes(4).toString('hex')}.part`);
  let size = 0;
  try {
    await pipeline(req.body, async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > MAX_FILE) throw httpError(413, 'That attachment is too big to share.');
        yield chunk;
      }
    }, fs.createWriteStream(part, { mode: 0o600 }));
    fs.renameSync(part, path.join(dir, name));
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e.statusCode ? e : httpError(400, `The upload didn’t finish (${e.message}).`);
  }
  return { ok: true };
});

api.put('/v1/shares/:id', async (req) => {
  const id = String(req.params.id);
  if (!SHARE_ID.test(id)) throw httpError(400, 'Bad share');
  mustSharing(req.me);
  return saveShare(req.me, id, req.body ?? {});
});

api.delete('/v1/shares/:id', async (req) => {
  stopShare(req.me, String(req.params.id));
  return { ok: true };
});

// For the owner's pages: unread comments on each share, and on each note (Home).
api.get('/v1/mine', async (req) => {
  const me = req.me;
  const shares = {};
  for (const r of db.prepare(`SELECT c.share_id AS id, COUNT(*) AS n FROM comments c JOIN shares s ON s.id = c.share_id AND s.owner = ?
      WHERE ${unseenWhere} GROUP BY c.share_id`).all(me, me, me)) shares[r.id] = r.n;
  const notes = db.prepare(`SELECT c.note_key AS noteKey, COUNT(*) AS count, MAX(c.created_at) AS at,
      (SELECT author_name FROM comments x JOIN shares y ON y.id = x.share_id AND y.owner = ? WHERE x.note_key = c.note_key AND x.author != ?
        AND NOT EXISTS (SELECT 1 FROM comment_seen z WHERE z.comment_id = x.id AND z.slug = ?) ORDER BY x.created_at DESC LIMIT 1) AS fromName
    FROM comments c JOIN shares s ON s.id = c.share_id AND s.owner = ? WHERE ${unseenWhere}
    GROUP BY c.note_key ORDER BY at DESC LIMIT 20`).all(me, me, me, me, me, me);
  return { shares, notes };
});

// Threads on one of my notes, across the shares it's in.
api.get('/v1/mine/threads', async (req) => {
  const me = req.me;
  const key = Number(req.query.note);
  return {
    threads: threads(db.prepare(`SELECT c.* FROM comments c JOIN shares s ON s.id = c.share_id AND s.owner = ?
      WHERE c.note_key = ? ORDER BY c.created_at`).all(me, key), me, 'out'),
  };
});

api.post('/v1/mine/seen', async (req) => {
  const me = req.me;
  const ids = db.prepare('SELECT c.id FROM comments c JOIN shares s ON s.id = c.share_id AND s.owner = ? WHERE c.note_key = ?').all(me, Number(req.body?.note)).map((r) => r.id);
  markSeen(ids, me);
  return { ok: true };
});

// ----- shared with me -----

api.get('/v1/shared', async (req) => ({ shares: sharedWithMe(req.me) }));

api.get('/v1/shared/:id', async (req) => {
  const me = req.me;
  const s = mustIncoming(me, req.params.id);
  const notes = db.prepare('SELECT note_key, position, grp, title, substr(text, 1, 220) AS snippet, work, updated_at FROM notes WHERE share_id = ? ORDER BY position').all(s.id);
  const counts = new Map(db.prepare('SELECT note_key, COUNT(*) AS n FROM comments WHERE share_id = ? AND peer = ? AND resolved_at IS NULL AND id = thread_id GROUP BY note_key')
    .all(s.id, me).map((r) => [r.note_key, r.n]));
  return {
    share: sharedWithMe(me).find((x) => x.id === s.id),
    notes: notes.map((n) => ({ key: n.note_key, grp: n.grp, title: n.title, snippet: n.snippet, work: json(n.work, null), updatedAt: n.updated_at, comments: counts.get(n.note_key) ?? 0 })),
  };
});

api.post('/v1/shared/:id/seen', async (req) => {
  const s = mustIncoming(req.me, req.params.id);
  db.prepare('UPDATE share_people SET seen_at = ? WHERE share_id = ? AND slug = ?').run(Date.now(), s.id, req.me);
  return { ok: true };
});

api.get('/v1/shared/:id/notes/:key', async (req) => {
  const me = req.me;
  const s = mustIncoming(me, req.params.id);
  const n = noteOf(s, req.params.key);
  const rows = db.prepare('SELECT * FROM comments WHERE share_id = ? AND note_key = ? AND peer = ? ORDER BY created_at').all(s.id, n.note_key, me);
  const out = {
    key: n.note_key, title: n.title, html: n.html, grp: n.grp, work: json(n.work, null), updatedAt: n.updated_at,
    attachments: json(n.attachments, []).map(({ storage, ...a }) => a),
    threads: threads(rows, me, 'in'),
  };
  markSeen(rows.map((r) => r.id), me);
  return out;
});

// Every note in full (for Copy), attachments without their storage names.
api.get('/v1/shared/:id/all', async (req) => {
  const s = mustIncoming(req.me, req.params.id);
  if (!s.allow_copy) throw httpError(403, `${nameOf(s.owner)} hasn’t allowed copying this.`);
  const key = req.query.key != null ? Number(req.query.key) : null;
  const rows = key != null ? [noteOf(s, key)] : db.prepare('SELECT * FROM notes WHERE share_id = ? ORDER BY position').all(s.id);
  return {
    owner: s.owner, ownerName: nameOf(s.owner), title: s.title,
    notes: rows.map((n) => ({ key: n.note_key, title: n.title, html: n.html, updatedAt: n.updated_at, attachments: json(n.attachments, []).map(({ storage, ...a }) => a) })),
  };
});

api.get('/v1/shared/:id/files/:att', async (req, reply) => {
  const s = mustIncoming(req.me, req.params.id);
  const att = Number(req.params.att);
  let a = null;
  for (const r of db.prepare('SELECT attachments FROM notes WHERE share_id = ?').all(s.id)) {
    a = json(r.attachments, []).find((x) => x.id === att);
    if (a) break;
  }
  const file = a && STORAGE.test(a.storage) ? path.join(shareFiles(s.id), a.storage) : null;
  if (!file || !fs.existsSync(file)) throw httpError(404, 'File not found');
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('X-Selah-Mime', a.mime);
  reply.header('X-Selah-Filename', encodeURIComponent(a.filename));
  reply.header('Content-Length', fs.statSync(file).size);
  return reply.send(fs.createReadStream(file));
});

// ----- comments -----

// A comment on a note shared with me (a new thread, or a reply in one of mine).
api.post('/v1/shared/:id/comments', async (req) => {
  const me = req.me;
  mustSharing(me);
  const s = mustIncoming(me, req.params.id);
  if (!s.allow_comments) throw httpError(403, `${nameOf(s.owner)} turned comments off for this.`);
  const n = noteOf(s, req.body?.noteKey);
  newComment(me, s, n, req.body ?? {}, me);
  return { threads: threads(db.prepare('SELECT * FROM comments WHERE share_id = ? AND note_key = ? AND peer = ? ORDER BY created_at').all(s.id, n.note_key, me), me, 'in') };
});

// A reply in a thread: the owner's to the person who started it, or that person's.
api.post('/v1/threads/:thread/reply', async (req) => {
  const me = req.me;
  mustSharing(me);
  const root = db.prepare('SELECT * FROM comments WHERE id = ? AND thread_id = id').get(String(req.params.thread));
  if (!root) throw httpError(404, 'That thread is gone.');
  const s = shareRow(root.share_id);
  if (me === s.owner) {
    if (!sharesWith(root.peer, s.id)) throw httpError(409, 'It isn’t shared with them any more, so they wouldn’t see a reply.');
  } else if (me === root.peer) {
    mustIncoming(me, s.id);
    if (!s.allow_comments) throw httpError(403, 'Comments are turned off for this.');
  } else throw httpError(404, 'That thread is gone.');
  newComment(me, s, noteOf(s, root.note_key), { ...req.body, threadId: root.id }, root.peer);
  return { ok: true };
});

// The owner resolves a thread (it folds away for both), or opens it again.
api.post('/v1/threads/:thread/resolve', async (req) => {
  const me = req.me;
  const root = db.prepare('SELECT * FROM comments WHERE id = ? AND thread_id = id').get(String(req.params.thread));
  if (!root || shareRow(root.share_id)?.owner !== me) throw httpError(404, 'That thread is gone.');
  const resolved = req.body?.resolved !== false;
  db.prepare('UPDATE comments SET resolved_at = ? WHERE id = ?').run(resolved ? Date.now() : null, root.id);
  markSeen([root.id], me);
  emit(root.peer, { type: 'comment-changed', shareId: root.share_id });
  return { ok: true };
});

// Deletes a comment of mine (a thread's first comment takes the thread with it).
api.delete('/v1/comments/:id', async (req) => {
  const me = req.me;
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND author = ?').get(String(req.params.id), me);
  if (!c) throw httpError(404, 'Not found');
  if (c.id === c.thread_id) db.prepare('DELETE FROM comments WHERE thread_id = ?').run(c.id);
  else db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  const s = shareRow(c.share_id);
  emit(me === s?.owner ? c.peer : s?.owner ?? c.peer, { type: 'comment-changed', shareId: c.share_id });
  return { ok: true };
});

// Moving in (14.1): an owner's comments from before the hub, kept in its own Selah. Once per share.
api.post('/v1/migrate/comments', async (req) => {
  const me = req.me;
  const s = mustMine(me, String(req.body?.shareId ?? ''));
  const put = db.prepare(`INSERT OR IGNORE INTO comments (id, share_id, note_key, thread_id, peer, author, author_name, body, quote, prefix, suffix, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  tx(() => {
    for (const c of Array.isArray(req.body?.comments) ? req.body.comments : []) {
      const peer = String(c.peer ?? '');
      const author = String(c.author ?? '');
      if (!SHARE_ID.test(String(c.id)) || !SHARE_ID.test(String(c.threadId)) || !sharesWith(peer, s.id) || ![me, peer].includes(author)) continue;
      put.run(c.id, s.id, Number(c.noteKey), c.threadId, peer, author, clip(c.authorName, 80), clip(c.body, 4000), clip(c.quote, 500),
        clip(c.prefix, 60), clip(c.suffix, 60), Number(c.createdAt) || Date.now(), c.resolvedAt ? Number(c.resolvedAt) : null);
      if (c.seen) markSeen([c.id], me);
      n++;
    }
  });
  return { ok: true, comments: n };
});

// ---------- the console's API ----------

const control = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
control.addHook('onRequest', async (req) => {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(CONTROL_TOKEN);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw httpError(401, 'No.');
});
control.setErrorHandler((err, req, reply) => reply.code(err.statusCode && err.statusCode < 600 ? err.statusCode : 500).send({ error: err.message }));

control.get('/control/health', async () => ({
  ok: true, version: VERSION,
  tenants: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
  shares: db.prepare('SELECT COUNT(*) AS n FROM shares').get().n,
}));

// Body: { name, key?, active, sharing }. A key is given when the Selah gets a new one (first time, or rotated).
control.put('/control/tenants/:slug', async (req) => {
  const slug = String(req.params.slug);
  if (!SLUG.test(slug)) throw httpError(400, 'Bad name');
  const b = req.body ?? {};
  const old = tenant(slug);
  if (!old && !b.key) throw httpError(400, 'A new Selah needs a key.');
  db.prepare(`INSERT INTO tenants (slug, name, key_hash, sharing, active) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, key_hash = excluded.key_hash, sharing = excluded.sharing, active = excluded.active`)
    .run(slug, clip(b.name, 80), b.key ? sha256(b.key) : old.key_hash, b.sharing === false ? 0 : 1, b.active === false ? 0 : 1);
  const on = b.sharing !== false && b.active !== false;
  const wasOn = !!old && !!old.sharing && !!old.active;
  if (old && wasOn && !on) {
    // Off: what it shares ends, and it comes off what's shared with it (its records stay, so turning it on again
    // brings back its contacts).
    for (const s of db.prepare('SELECT * FROM shares WHERE owner = ?').all(slug)) {
      for (const p of peopleOf(s.id)) emit(p, { type: 'share-revoked', id: s.id, from: slug });
      dropShare(s.id);
    }
    for (const r of db.prepare('SELECT share_id FROM share_people WHERE slug = ?').all(slug)) {
      db.prepare('DELETE FROM share_people WHERE share_id = ? AND slug = ?').run(r.share_id, slug);
      db.prepare('DELETE FROM comments WHERE share_id = ? AND peer = ?').run(r.share_id, slug);
      emit(slug, { type: 'share-revoked', id: r.share_id, from: shareRow(r.share_id)?.owner ?? '' });
    }
    log('sharing-off', slug);
  } else if (old && !wasOn && on) log('sharing-on', slug);
  if (!old || !!old.sharing !== (b.sharing !== false)) emit(slug, { type: 'state', on: b.sharing !== false });
  return { ok: true };
});

// A Selah deleted: its contacts and shares go, and it comes off what others shared with it.
control.delete('/control/tenants/:slug', async (req) => {
  const slug = String(req.params.slug);
  for (const s of db.prepare('SELECT * FROM shares WHERE owner = ?').all(slug)) {
    for (const p of peopleOf(s.id)) emit(p, { type: 'share-revoked', id: s.id, from: slug });
    dropShare(s.id);
  }
  for (const r of db.prepare('SELECT share_id FROM share_people WHERE slug = ?').all(slug)) {
    db.prepare('DELETE FROM comments WHERE share_id = ? AND peer = ?').run(r.share_id, slug);
  }
  db.prepare('DELETE FROM share_people WHERE slug = ?').run(slug);
  for (const c of db.prepare('SELECT * FROM contacts WHERE a = ? OR b = ?').all(slug, slug)) emit(c.a === slug ? c.b : c.a, { type: 'contact-removed', from: slug });
  db.prepare('DELETE FROM contacts WHERE a = ? OR b = ?').run(slug, slug);
  db.prepare('DELETE FROM events WHERE slug = ?').run(slug);
  db.prepare('DELETE FROM tenants WHERE slug = ?').run(slug);
  log('tenant-removed', slug);
  return { ok: true };
});

// The 8.0 relay's contacts, moved in once (the console's relay_contacts). Shares come from their owners' Selahs.
control.post('/control/import', async (req) => {
  if (getSetting('imported')) return { ok: true, already: true };
  let n = 0;
  tx(() => {
    for (const c of Array.isArray(req.body?.contacts) ? req.body.contacts : []) {
      const [a, b] = pair(String(c.a), String(c.b));
      if (!SLUG.test(a) || !SLUG.test(b) || a === b || !['pending', 'accepted'].includes(c.status)) continue;
      db.prepare('INSERT OR IGNORE INTO contacts (a, b, status, requested_by, at) VALUES (?, ?, ?, ?, ?)').run(a, b, c.status, String(c.requested_by ?? a), Number(c.at) || Date.now());
      n++;
    }
    setSetting('imported', String(Date.now()));
  });
  log('imported', '-', null, null, `${n} contacts`);
  return { ok: true, contacts: n };
});

// For the console's Sharing page: titles and who, never the notes.
control.get('/control/overview', async () => ({
  tenants: db.prepare('SELECT * FROM tenants').all().map((t) => ({
    slug: t.slug, on: !!t.sharing, active: !!t.active, seenAt: t.seen_at,
    contacts: db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status = 'accepted' AND (a = ? OR b = ?)").get(t.slug, t.slug).n,
    pending: db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status = 'pending' AND (a = ? OR b = ?)").get(t.slug, t.slug).n,
    sharing: db.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner = ?').get(t.slug).n,
    sharedWith: db.prepare('SELECT COUNT(*) AS n FROM share_people WHERE slug = ?').get(t.slug).n,
    waiting: db.prepare('SELECT COUNT(*) AS n FROM events WHERE slug = ?').get(t.slug).n,
  })),
  contacts: db.prepare('SELECT a, b, status, requested_by AS requestedBy, at FROM contacts ORDER BY at DESC').all(),
  shares: db.prepare('SELECT id, owner, kind, title, allow_comments AS allowComments, allow_copy AS allowCopy, updated_at AS updatedAt FROM shares ORDER BY updated_at DESC').all()
    .map((s) => ({ ...s, people: peopleOf(s.id), allowComments: !!s.allowComments, allowCopy: !!s.allowCopy })),
  log: db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT 200').all(),
}));

// ---------- start ----------

// Events nobody picked up for 30 days (a Selah long gone) don't pile up.
setInterval(() => db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - 30 * 86400_000), 3_600_000).unref();

await api.listen({ host: HOST, port: PORT });
await control.listen({ host: CONTROL_HOST, port: CONTROL_PORT });
console.log(`Selah share hub ${VERSION}: Selahs on ${HOST}:${PORT}, console on ${CONTROL_HOST}:${CONTROL_PORT}, records in ${process.env.NOTEAPP_HUB_DIR || 'notes-data/hub'}`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await api.close(); await control.close(); db.close(); process.exit(0); });
