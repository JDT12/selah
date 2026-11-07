import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db, tx, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { htmlToText } from './html.js';
import { broadcast } from './events.js';
import { methodOfNote } from './methods.js';
import { itemsOf } from './studies.js';
import { importPackage } from './notepack.js';

/**
 * Sharing between tenants (8.0): notes, notebooks and projects (Desk studies) shared live and read-only with
 * contacts, with margin comments going back to the owner.
 *
 * Tenants can't reach each other, or the admin console. The console keeps a request open to each tenant's control
 * port (GET /control/sharing/outbox, below) and gets this Selah's messages from the outbox as they're queued; it
 * checks them (contacts, who owns a share) and delivers them to the other tenant (POST /control/sharing/inbox).
 *
 * A share's content travels as a snapshot: this Selah writes sharing/out/<id>/snapshot.json and links the
 * attachments beside it (files/); the console copies that folder to the other tenant's sharing/in/<id>/ and tells it.
 * Snapshots are written again a few seconds after any of the shared notes change.
 *
 * Only in tenant mode: a home server (single mode) has no one to share with.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const enabled = () => config.mode === 'tenant';
const SHARE_ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const KINDS = ['note', 'notebook', 'study'];
const MAX_NOTES = 500;
const DIR = path.join(config.storageDir, 'sharing');
const outDir = (id) => path.join(DIR, 'out', id);
const inDir = (id) => path.join(DIR, 'in', id);
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const uid = () => crypto.randomBytes(16).toString('hex');
const myName = () => process.env.NOTEAPP_TENANT_NAME || config.tenant || '';

// Not in the admin console's database (it loads this file through tenant.js, but relays with its own tables).
if (config.mode !== 'admin') db.exec(`
CREATE TABLE IF NOT EXISTS share_contacts (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                    -- accepted | incoming (they asked) | outgoing (I asked)
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares_out (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- note | notebook | study
  ref_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  allow_copy INTEGER NOT NULL DEFAULT 0,
  allow_comments INTEGER NOT NULL DEFAULT 1,
  sig TEXT,                                -- what the last snapshot was made from
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
CREATE TABLE IF NOT EXISTS shares_in (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  allow_copy INTEGER NOT NULL DEFAULT 0,
  allow_comments INTEGER NOT NULL DEFAULT 1,
  project TEXT,                            -- a project's kind and description
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS shared_notes (
  share_id TEXT NOT NULL REFERENCES shares_in(id) ON DELETE CASCADE,
  note_key INTEGER NOT NULL,               -- the note's id in the owner's Selah
  position INTEGER NOT NULL,
  grp TEXT NOT NULL DEFAULT '',            -- a project's part it belongs to (a week, "Chapters")
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  work TEXT,                               -- { type, method, passage } for the page view
  attachments TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, note_key)
);
CREATE TABLE IF NOT EXISTS share_comments (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  side TEXT NOT NULL,                      -- out (on a share of mine) | in (on one shared with me)
  peer TEXT NOT NULL,                      -- the other person in the thread: the commenter (out) or the owner (in)
  note_key INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_comments_note ON share_comments(side, note_key);
CREATE TABLE IF NOT EXISTS share_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused: the console remembers the last one it had
  at INTEGER NOT NULL,
  msg TEXT NOT NULL
);`);

// ---------- the outbox the console reads ----------

const outboxEvents = new EventEmitter();
outboxEvents.setMaxListeners(20);

function send(msg) {
  db.prepare('INSERT INTO share_outbox (at, msg) VALUES (?, ?)').run(Date.now(), JSON.stringify(msg));
  outboxEvents.emit('queued');
}

/** Messages after `after` (those up to it were delivered, so they're dropped); waits up to `wait` ms for one. */
async function readOutbox(after, wait) {
  // After a restore from a backup the numbers can be behind the console's: start again from the first.
  const top = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'share_outbox'").get()?.seq ?? 0;
  if (after > top) after = 0;
  db.prepare('DELETE FROM share_outbox WHERE seq <= ?').run(after);
  const rows = () => db.prepare('SELECT seq, msg FROM share_outbox WHERE seq > ? ORDER BY seq LIMIT 50').all(after);
  let list = rows();
  if (!list.length && wait > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(done, wait);
      function done() { clearTimeout(t); outboxEvents.off('queued', done); resolve(); }
      outboxEvents.on('queued', done);
    });
    list = rows();
  }
  return list.map((r) => ({ seq: r.seq, ...json(r.msg, {}) }));
}

const changed = (what, extra = {}) => broadcast({ sharing: what, ...extra });

// ---------- contacts ----------

const sharingOn = () => getSetting('sharing_off') !== 'yes';
function mustBeOn() {
  if (!enabled()) throw httpError(404, 'Sharing is only for Selah in the cloud.');
  if (!sharingOn()) throw httpError(403, 'Sharing is turned off for your Selah. Ask your Selah host.');
}

const contact = (slug) => db.prepare('SELECT * FROM share_contacts WHERE slug = ?').get(slug);
const isContact = (slug) => contact(slug)?.status === 'accepted';

function setContact(slug, status, name) {
  db.prepare(`INSERT INTO share_contacts (slug, name, status, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET status = excluded.status, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE share_contacts.name END, at = excluded.at`)
    .run(slug, clip(name, 80), status, Date.now());
}

/** Everything shared between me and `slug` ends: their shares to me go, and they come off mine. */
function dropPerson(slug) {
  for (const s of db.prepare('SELECT id FROM shares_in WHERE owner = ?').all(slug)) removeIncoming(s.id);
  const mine = db.prepare('SELECT share_id FROM share_people WHERE slug = ?').all(slug).map((r) => r.share_id);
  db.prepare('DELETE FROM share_people WHERE slug = ?').run(slug);
  for (const id of mine) {
    if (!db.prepare('SELECT 1 FROM share_people WHERE share_id = ?').get(id)) stopShare(id, { tell: false });
  }
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

/** What the snapshot depends on: when it differs from the last one sent, a new snapshot goes out. */
function signature(share, notes) {
  const title = refTitle(share.kind, share.ref_id) ?? share.title;
  const study = share.kind === 'study' ? db.prepare('SELECT updated_at FROM studies WHERE id = ?').get(share.ref_id)?.updated_at : null;
  return crypto.createHash('sha1').update(JSON.stringify([title, study, share.allow_copy, share.allow_comments, people(share.id),
    notes.map((n) => [n.id, n.updated_at, n.grp])])).digest('hex');
}

function linkFile(from, to) {
  if (fs.existsSync(to)) return;
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

/** Writes the share's snapshot (and links its attachments beside it) and queues it for the console. */
function sendSnapshot(share, notes = notesOf(share)) {
  const title = refTitle(share.kind, share.ref_id) ?? share.title;
  const dir = outDir(share.id);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const keep = new Set();
  const list = notes.map((n, position) => {
    const atts = db.prepare('SELECT id, filename, mime, size, storage, created_at FROM attachments WHERE note_id = ?').all(n.id)
      .filter((a) => fs.existsSync(path.join(config.filesDir, a.storage)));
    for (const a of atts) {
      linkFile(path.join(config.filesDir, a.storage), path.join(dir, 'files', a.storage));
      keep.add(a.storage);
    }
    return { key: n.id, position, grp: n.grp, title: n.title, html: n.html, updated_at: n.updated_at, work: workOf(n.id), attachments: atts };
  });
  for (const f of fs.readdirSync(path.join(dir, 'files'))) if (!keep.has(f)) fs.rmSync(path.join(dir, 'files', f), { force: true });
  let project = null;
  if (share.kind === 'study') {
    const s = db.prepare('SELECT kind, description FROM studies WHERE id = ?').get(share.ref_id);
    project = s ? { kind: s.kind, description: clip(s.description, 2000) } : null;
  }
  const snapshot = { app: 'Selah', kind: 'share', version: 1, id: share.id, shareKind: share.kind, title, project,
    allowCopy: !!share.allow_copy, allowComments: !!share.allow_comments, sentAt: Date.now(), notes: list };
  fs.writeFileSync(path.join(dir, 'snapshot.json.new'), JSON.stringify(snapshot));
  fs.renameSync(path.join(dir, 'snapshot.json.new'), path.join(dir, 'snapshot.json'));
  db.prepare('UPDATE shares_out SET title = ?, sig = ?, sent_at = ? WHERE id = ?').run(title, signature(share, notes), Date.now(), share.id);
  send({ type: 'share', id: share.id, kind: share.kind, title, allowCopy: !!share.allow_copy, allowComments: !!share.allow_comments, people: people(share.id) });
}

function stopShare(id, { tell = true } = {}) {
  db.prepare('DELETE FROM shares_out WHERE id = ?').run(id);
  fs.rmSync(outDir(id), { recursive: true, force: true });
  if (tell) send({ type: 'share-stop', id });
}

/** Every few seconds: a share whose notes changed sends a new snapshot; one whose note or notebook is gone stops. */
function checkShares() {
  if (!sharingOn()) return;
  for (const share of db.prepare('SELECT * FROM shares_out').all()) {
    try {
      if (refTitle(share.kind, share.ref_id) == null) { stopShare(share.id); continue; }
      const notes = notesOf(share);
      if (signature(share, notes) !== share.sig) sendSnapshot(share, notes);
    } catch (e) {
      console.error(`Sharing: snapshot of ${share.id} failed: ${e.message}`);
    }
  }
}

// ---------- shared with me ----------

function removeIncoming(id) {
  db.prepare('DELETE FROM shares_in WHERE id = ?').run(id);
  db.prepare("DELETE FROM share_comments WHERE side = 'in' AND share_id = ?").run(id);
  fs.rmSync(inDir(id), { recursive: true, force: true });
}

const NOTE_LINK = /<a\b[^>]*\bdata-note-id="\d+"[^>]*>([\s\S]*?)<\/a>/gi;
/** Links to the owner's other notes would open mine: they become plain text. Images come from the share. */
function forViewer(html, id) {
  return String(html ?? '')
    .replace(NOTE_LINK, '$1')
    .replace(/(<img\b[^>]*\bsrc=")\/api\/files\/(\d+)(?:\?[^"]*)?"/gi, `$1/api/shared/${id}/files/$2"`);
}

/** A snapshot the console just put in sharing/in/<id>/: its notes replace the ones kept for that share. */
function receiveSnapshot(from, fromName, id) {
  if (!SHARE_ID.test(id)) return;
  const snap = json(fs.readFileSync(path.join(inDir(id), 'snapshot.json'), 'utf8'), null);
  if (!snap || snap.kind !== 'share' || snap.id !== id || !Array.isArray(snap.notes) || !KINDS.includes(snap.shareKind)) return;
  const existing = db.prepare('SELECT owner, title, updated_at FROM shares_in WHERE id = ?').get(id);
  if (existing && existing.owner !== from) return;
  const now = Date.now();
  const title = clip(snap.title, 300);
  let changedNotes = 0;
  tx(() => {
    db.prepare(`INSERT INTO shares_in (id, owner, owner_name, kind, title, allow_copy, allow_comments, project, received_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_name = excluded.owner_name, kind = excluded.kind, title = excluded.title,
        allow_copy = excluded.allow_copy, allow_comments = excluded.allow_comments, project = excluded.project`)
      .run(id, from, clip(fromName, 80), snap.shareKind, title, snap.allowCopy ? 1 : 0, snap.allowComments ? 1 : 0,
        snap.project ? JSON.stringify({ kind: clip(snap.project.kind, 20), description: clip(snap.project.description, 2000) }) : null, now, now);
    const before = new Map(db.prepare('SELECT note_key, updated_at FROM shared_notes WHERE share_id = ?').all(id).map((r) => [r.note_key, r.updated_at]));
    db.prepare('DELETE FROM shared_notes WHERE share_id = ?').run(id);
    const ins = db.prepare(`INSERT OR IGNORE INTO shared_notes (share_id, note_key, position, grp, title, html, text, work, attachments, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [i, n] of snap.notes.slice(0, MAX_NOTES).entries()) {
      const key = Number(n.key);
      if (!Number.isInteger(key) || key <= 0) continue;
      const html = forViewer(n.html, id);
      const atts = (Array.isArray(n.attachments) ? n.attachments : []).map((a) => ({
        id: Number(a.id), filename: clip(a.filename, 255), mime: clip(a.mime, 100), size: Number(a.size) || 0, storage: String(a.storage ?? ''),
        created_at: Number(a.created_at) || now,
      })).filter((a) => Number.isInteger(a.id) && /^[\w.-]+$/.test(a.storage));
      const work = n.work && ['sermon', 'study', 'lesson'].includes(n.work.type)
        ? JSON.stringify({ type: n.work.type, method: n.work.method ? clip(n.work.method, 40) : null, passage: clip(n.work.passage, 120) }) : null;
      const updated = Number(n.updated_at) || now;
      if (before.get(key) !== updated) changedNotes++;
      ins.run(id, key, i, clip(n.grp, 200), clip(n.title, 500), html, htmlToText(html).slice(0, 200_000), work, JSON.stringify(atts), updated);
    }
    // Updated for the person only when something they'd see changed (not, say, only the list of people).
    const count = db.prepare('SELECT COUNT(*) AS n FROM shared_notes WHERE share_id = ?').get(id).n;
    if (existing && (changedNotes || count !== before.size || title !== existing.title)) db.prepare('UPDATE shares_in SET updated_at = ? WHERE id = ?').run(now, id);
  });
  if (!existing || changedNotes) changed(existing ? 'updated' : 'new', { share: id, from: fromName || from, title });
  else changed('quiet', { share: id });
}

// ---------- comments ----------

function commentRow(c) {
  return {
    id: c.id, shareId: c.share_id, side: c.side, peer: c.peer, noteKey: c.note_key, threadId: c.thread_id, author: c.author,
    authorName: c.author_name, mine: c.author === config.tenant, body: c.body, quote: c.quote, prefix: c.prefix, suffix: c.suffix,
    createdAt: c.created_at, resolvedAt: c.resolved_at, seen: !!c.seen_at || c.author === config.tenant,
  };
}

/** Comments grouped into threads (oldest first), unresolved threads first. */
function threads(rows) {
  const map = new Map();
  for (const c of rows.map(commentRow)) {
    if (!map.has(c.threadId)) map.set(c.threadId, { id: c.threadId, shareId: c.shareId, noteKey: c.noteKey, peer: c.peer, quote: '', prefix: '', suffix: '', comments: [] });
    const t = map.get(c.threadId);
    if (c.id === c.threadId) Object.assign(t, { quote: c.quote, prefix: c.prefix, suffix: c.suffix, resolvedAt: c.resolvedAt });
    t.comments.push(c);
  }
  return [...map.values()].sort((a, b) => (!!a.resolvedAt - !!b.resolvedAt) || a.comments[0].createdAt - b.comments[0].createdAt);
}

const cleanComment = (c) => ({
  id: String(c?.id ?? ''), noteKey: Number(c?.noteKey), threadId: String(c?.threadId ?? ''), body: clip(c?.body, 4000),
  quote: clip(c?.quote, 500), prefix: clip(c?.prefix, 60), suffix: clip(c?.suffix, 60), createdAt: Number(c?.createdAt) || Date.now(),
});
const goodComment = (c) => SHARE_ID.test(c.id) && SHARE_ID.test(c.threadId) && Number.isInteger(c.noteKey) && c.noteKey > 0 && c.body;

function storeComment(shareId, side, peer, author, authorName, c, seen) {
  db.prepare(`INSERT OR IGNORE INTO share_comments (id, share_id, side, peer, note_key, thread_id, author, author_name, body, quote, prefix, suffix, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, shareId, side, peer, c.noteKey, c.threadId, author, clip(authorName, 80), c.body, c.quote, c.prefix, c.suffix, c.createdAt, seen ? Date.now() : null);
}

/** A note of mine is in the share (a comment on it is about something I shared). */
function shareHasNote(shareId, noteKey) {
  const share = db.prepare('SELECT * FROM shares_out WHERE id = ?').get(shareId);
  return !!share && notesOf(share).some((n) => n.id === noteKey);
}

// ---------- messages from the console ----------

function receive(msg) {
  const from = SLUG.test(String(msg.from ?? '')) ? msg.from : null;
  switch (msg.type) {
    case 'contact-request':
      if (!from) return;
      if (contact(from)?.status === 'outgoing') { setContact(from, 'accepted', msg.name); send({ type: 'contact-accept', to: from }); changed('contacts', { from: msg.name || from, accepted: true }); return; }
      if (!isContact(from)) setContact(from, 'incoming', msg.name);
      changed('contacts', { from: msg.name || from, request: true });
      return;
    case 'contact-accepted':
      if (!from) return;
      setContact(from, 'accepted', msg.name);
      changed('contacts', { from: msg.name || from, accepted: true });
      return;
    case 'contact-removed':
      if (!from) return;
      db.prepare('DELETE FROM share_contacts WHERE slug = ?').run(from);
      dropPerson(from);
      changed('contacts');
      return;
    case 'contact-error':
      if (SLUG.test(String(msg.to ?? ''))) db.prepare("DELETE FROM share_contacts WHERE slug = ? AND status = 'outgoing'").run(msg.to);
      changed('error', { error: clip(msg.error, 300) });
      return;
    case 'share-error':
      changed('error', { error: clip(msg.error, 300) });
      return;
    case 'share-snapshot':
      if (from && isContact(from)) receiveSnapshot(from, msg.name, String(msg.id ?? ''));
      return;
    case 'share-revoked': {
      const id = String(msg.id ?? '');
      if (from && db.prepare('SELECT 1 FROM shares_in WHERE id = ? AND owner = ?').get(id, from)) {
        removeIncoming(id);
        changed('revoked', { share: id });
      }
      return;
    }
    case 'comment': {
      const shareId = String(msg.shareId ?? '');
      const c = cleanComment(msg.comment);
      if (!from || !goodComment(c)) return;
      if (db.prepare('SELECT 1 FROM shares_out WHERE id = ? AND allow_comments = 1').get(shareId) && people(shareId).includes(from) && shareHasNote(shareId, c.noteKey)) {
        // On a share of mine: from the person it's shared with. A reply joins a thread they started.
        const thread = db.prepare("SELECT peer FROM share_comments WHERE id = ? AND side = 'out'").get(c.threadId);
        if (c.threadId !== c.id && thread?.peer !== from) return;
        storeComment(shareId, 'out', from, from, msg.name, c, false);
        changed('comment', { share: shareId, note: c.noteKey, from: msg.name || from });
      } else if (db.prepare('SELECT 1 FROM shares_in WHERE id = ? AND owner = ?').get(shareId, from)) {
        // On one shared with me: the owner's reply to a thread of mine.
        if (!db.prepare("SELECT 1 FROM share_comments WHERE id = ? AND side = 'in' AND share_id = ?").get(c.threadId, shareId)) return;
        storeComment(shareId, 'in', from, from, msg.name, c, false);
        changed('reply', { share: shareId, note: c.noteKey, from: msg.name || from });
      }
      return;
    }
    case 'comment-resolve': {
      const shareId = String(msg.shareId ?? '');
      if (!from || !db.prepare('SELECT 1 FROM shares_in WHERE id = ? AND owner = ?').get(shareId, from)) return;
      db.prepare("UPDATE share_comments SET resolved_at = ? WHERE side = 'in' AND share_id = ? AND id = ?")
        .run(msg.resolved ? Date.now() : null, shareId, String(msg.threadId ?? ''));
      changed('comment', { share: shareId });
      return;
    }
    case 'comment-delete': {
      const shareId = String(msg.shareId ?? '');
      if (!from) return;
      const c = db.prepare('SELECT * FROM share_comments WHERE id = ? AND share_id = ? AND author = ?').get(String(msg.id ?? ''), shareId, from);
      if (!c) return;
      if (c.id === c.thread_id) db.prepare('DELETE FROM share_comments WHERE thread_id = ? AND share_id = ?').run(c.id, shareId);
      else db.prepare('DELETE FROM share_comments WHERE id = ?').run(c.id);
      changed('comment', { share: shareId });
      return;
    }
    default:
  }
}

// ---------- what the pages ask for ----------

function contactsList() {
  return db.prepare("SELECT slug, name, status, at FROM share_contacts ORDER BY status = 'accepted', name COLLATE NOCASE, slug").all();
}

function sharedWithMe() {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shared_notes n WHERE n.share_id = s.id) AS notes,
      (SELECT COUNT(*) FROM share_comments c WHERE c.side = 'in' AND c.share_id = s.id AND c.seen_at IS NULL AND c.author != ?) AS replies
    FROM shares_in s ORDER BY s.updated_at DESC`).all(config.tenant).map((s) => ({
    id: s.id, owner: s.owner, ownerName: s.owner_name || s.owner, kind: s.kind, title: s.title, allowCopy: !!s.allow_copy,
    allowComments: !!s.allow_comments, project: json(s.project, null), receivedAt: s.received_at, updatedAt: s.updated_at,
    unseen: !s.seen_at || s.seen_at < s.updated_at, isNew: !s.seen_at, notes: s.notes, replies: s.replies,
  }));
}

function myShares() {
  const names = new Map(contactsList().map((c) => [c.slug, c.name || c.slug]));
  return db.prepare('SELECT * FROM shares_out ORDER BY created_at DESC').all().map((s) => ({
    id: s.id, kind: s.kind, refId: s.ref_id, title: s.title || refTitle(s.kind, s.ref_id) || '', allowCopy: !!s.allow_copy,
    allowComments: !!s.allow_comments, sentAt: s.sent_at, people: people(s.id).map((slug) => ({ slug, name: names.get(slug) ?? slug })),
    comments: db.prepare("SELECT COUNT(*) AS n FROM share_comments WHERE side = 'out' AND share_id = ? AND seen_at IS NULL").get(s.id).n,
  }));
}

function mustIncoming(id) {
  const s = db.prepare('SELECT * FROM shares_in WHERE id = ?').get(String(id));
  if (!s) throw httpError(404, 'This was shared with you but isn’t any more.');
  return s;
}

function sharedNote(s, key) {
  const n = db.prepare('SELECT * FROM shared_notes WHERE share_id = ? AND note_key = ?').get(s.id, key);
  if (!n) throw httpError(404, 'That note isn’t in the share any more.');
  return n;
}

function ownerShareOf(kind, refId) {
  return db.prepare('SELECT * FROM shares_out WHERE kind = ? AND ref_id = ?').get(kind, refId);
}

// ---------- routes ----------

const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|audio\/|video\/)/;

export default async function sharingRoutes(app) {
  app.get('/api/sharing', async () => {
    if (!enabled()) return { enabled: false };
    return {
      enabled: true, on: sharingOn(), me: { slug: config.tenant, name: myName() },
      contacts: contactsList(), sharedWithMe: sharedWithMe(), myShares: myShares(),
      // My notes with comments I haven't read, for Home.
      newComments: db.prepare(`SELECT c.note_key AS noteId, n.title, COUNT(*) AS count, MAX(c.created_at) AS at,
          (SELECT author_name FROM share_comments x WHERE x.side = 'out' AND x.note_key = c.note_key AND x.seen_at IS NULL ORDER BY created_at DESC LIMIT 1) AS fromName
        FROM share_comments c JOIN notes n ON n.id = c.note_key AND n.deleted_at IS NULL
        WHERE c.side = 'out' AND c.seen_at IS NULL GROUP BY c.note_key ORDER BY at DESC LIMIT 20`).all(),
    };
  });

  app.post('/api/sharing/contacts', async (req) => {
    mustBeOn();
    const slug = String(req.body?.slug ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\..*$/, '');
    if (!SLUG.test(slug)) throw httpError(400, 'Type their Selah name: the first part of their Selah web address.');
    if (slug === config.tenant) throw httpError(400, 'That’s you.');
    const c = contact(slug);
    if (c?.status === 'accepted') throw httpError(409, `${c.name || slug} is already a contact.`);
    if (c?.status === 'incoming') {
      setContact(slug, 'accepted', c.name);
      send({ type: 'contact-accept', to: slug });
    } else {
      setContact(slug, 'outgoing', '');
      send({ type: 'contact-request', to: slug });
    }
    return { contacts: contactsList() };
  });

  app.post('/api/sharing/contacts/:slug/accept', async (req) => {
    mustBeOn();
    const c = contact(String(req.params.slug));
    if (!c || c.status !== 'incoming') throw httpError(404, 'There’s no request from them.');
    setContact(c.slug, 'accepted', c.name);
    send({ type: 'contact-accept', to: c.slug });
    return { contacts: contactsList() };
  });

  // Declines a request, cancels mine, or removes a contact (which ends everything shared between us).
  app.delete('/api/sharing/contacts/:slug', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    const c = contact(String(req.params.slug));
    if (!c) throw httpError(404, 'Not a contact.');
    db.prepare('DELETE FROM share_contacts WHERE slug = ?').run(c.slug);
    dropPerson(c.slug);
    send({ type: 'contact-remove', to: c.slug });
    return { contacts: contactsList() };
  });

  // The share of a note, notebook or project of mine (null when it isn't shared).
  app.get('/api/sharing/item', async (req) => {
    if (!enabled()) return { share: null };
    const kind = String(req.query.kind);
    if (!KINDS.includes(kind)) throw httpError(400, 'Bad kind');
    const s = ownerShareOf(kind, Number(req.query.id));
    return { share: s ? myShares().find((x) => x.id === s.id) : null };
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
    for (const slug of list) if (!isContact(slug)) throw httpError(400, `${slug} isn’t one of your contacts.`);
    let s = ownerShareOf(kind, refId);
    if (!list.length) {
      if (s) stopShare(s.id);
      return { share: null };
    }
    if (!s) {
      const id = uid();
      db.prepare('INSERT INTO shares_out (id, kind, ref_id, title, allow_copy, allow_comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, kind, refId, refTitle(kind, refId), b.allowCopy ? 1 : 0, b.allowComments === false ? 0 : 1, Date.now());
      s = db.prepare('SELECT * FROM shares_out WHERE id = ?').get(id);
    } else {
      db.prepare('UPDATE shares_out SET allow_copy = ?, allow_comments = ? WHERE id = ?').run(b.allowCopy ? 1 : 0, b.allowComments === false ? 0 : 1, s.id);
    }
    const now = Date.now();
    tx(() => {
      db.prepare(`DELETE FROM share_people WHERE share_id = ? AND slug NOT IN (${list.map(() => '?').join(', ')})`).run(s.id, ...list);
      for (const slug of list) db.prepare('INSERT OR IGNORE INTO share_people (share_id, slug, added_at) VALUES (?, ?, ?)').run(s.id, slug, now);
    });
    sendSnapshot(db.prepare('SELECT * FROM shares_out WHERE id = ?').get(s.id));
    return { share: myShares().find((x) => x.id === s.id) };
  });

  app.delete('/api/sharing/out/:id', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    const s = db.prepare('SELECT id FROM shares_out WHERE id = ?').get(String(req.params.id));
    if (!s) throw httpError(404, 'Not shared');
    stopShare(s.id);
    return { ok: true };
  });

  // ----- shared with me -----

  app.get('/api/shared/:id', async (req) => {
    const s = mustIncoming(req.params.id);
    const notes = db.prepare('SELECT note_key, position, grp, title, substr(text, 1, 220) AS snippet, work, updated_at FROM shared_notes WHERE share_id = ? ORDER BY position').all(s.id);
    const counts = new Map(db.prepare("SELECT note_key, COUNT(*) AS n FROM share_comments WHERE side = 'in' AND share_id = ? AND resolved_at IS NULL AND id = thread_id GROUP BY note_key").all(s.id).map((r) => [r.note_key, r.n]));
    return {
      share: sharedWithMe().find((x) => x.id === s.id),
      notes: notes.map((n) => ({ key: n.note_key, grp: n.grp, title: n.title, snippet: n.snippet, work: json(n.work, null), updatedAt: n.updated_at, comments: counts.get(n.note_key) ?? 0 })),
    };
  });

  app.post('/api/shared/:id/seen', async (req) => {
    const s = mustIncoming(req.params.id);
    db.prepare('UPDATE shares_in SET seen_at = ? WHERE id = ?').run(Date.now(), s.id);
    return { ok: true };
  });

  app.get('/api/shared/:id/notes/:key', async (req) => {
    const s = mustIncoming(req.params.id);
    const n = sharedNote(s, Number(req.params.key));
    db.prepare("UPDATE share_comments SET seen_at = ? WHERE side = 'in' AND share_id = ? AND note_key = ? AND seen_at IS NULL").run(Date.now(), s.id, n.note_key);
    return {
      key: n.note_key, title: n.title, html: n.html, grp: n.grp, work: json(n.work, null), updatedAt: n.updated_at,
      attachments: json(n.attachments, []).map(({ storage, ...a }) => a),
      threads: threads(db.prepare("SELECT * FROM share_comments WHERE side = 'in' AND share_id = ? AND note_key = ? ORDER BY created_at").all(s.id, n.note_key)),
    };
  });

  app.get('/api/shared/:id/files/:att', async (req, reply) => {
    const s = mustIncoming(req.params.id);
    const att = Number(req.params.att);
    let a = null;
    for (const r of db.prepare('SELECT attachments FROM shared_notes WHERE share_id = ?').all(s.id)) {
      a = json(r.attachments, []).find((x) => x.id === att);
      if (a) break;
    }
    const file = a && /^[\w.-]+$/.test(a.storage) ? path.join(inDir(s.id), 'files', a.storage) : null;
    if (!file || !fs.existsSync(file)) throw httpError(404, 'File not found');
    // The type comes from someone else's Selah: only plain media show in the page, and nothing runs.
    const inline = INLINE_MIME.test(a.mime) && !req.query.download;
    reply.header('Content-Type', inline ? a.mime : 'application/octet-stream');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    reply.header('Cache-Control', 'private, no-cache');
    if (a.mime !== 'application/pdf') reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    return reply.sendFile(a.storage, path.join(inDir(s.id), 'files'), { contentType: false, cacheControl: false });
  });

  // A copy of the note (key) or the whole share, as my own notes, when the owner allows it.
  app.post('/api/shared/:id/copy', async (req) => {
    const s = mustIncoming(req.params.id);
    if (!s.allow_copy) throw httpError(403, `${s.owner_name || s.owner} hasn’t allowed copying this.`);
    const key = req.body?.key != null ? Number(req.body.key) : null;
    const rows = key != null ? [sharedNote(s, key)] : db.prepare('SELECT * FROM shared_notes WHERE share_id = ? ORDER BY position').all(s.id);
    const nbName = key != null ? `From ${s.owner_name || s.owner}` : s.title || `From ${s.owner_name || s.owner}`;
    const now = Date.now();
    const pkg = {
      app: 'Selah', kind: 'notes', version: 1, createdAt: now,
      notebooks: [{ key: 'shared', id: null, name: nbName, stack: null, whole: key == null }],
      notes: rows.map((n) => ({
        id: n.note_key, notebook: 'shared', title: n.title,
        html: n.html.replace(new RegExp(`/api/shared/${s.id}/files/(\\d+)`, 'g'), '/api/files/$1'),
        created_at: n.updated_at, updated_at: n.updated_at, pinned: 0, is_template: 0, tags: [], attachments: json(n.attachments, []),
      })),
    };
    const r = await importPackage(pkg, { resolveFile: (storage) => path.join(inDir(s.id), 'files', storage), label: 'copy', newNotebooks: key == null });
    return { ...r, noteId: r.noteIds?.[0] ?? null };
  });

  // A comment on a note shared with me (a new thread, or a reply in one of mine).
  app.post('/api/shared/:id/comments', async (req) => {
    mustBeOn();
    const s = mustIncoming(req.params.id);
    if (!s.allow_comments) throw httpError(403, `${s.owner_name || s.owner} turned comments off for this.`);
    const b = req.body ?? {};
    const n = sharedNote(s, Number(b.noteKey));
    const id = uid();
    const threadId = b.threadId ? String(b.threadId) : id;
    if (threadId !== id && !db.prepare("SELECT 1 FROM share_comments WHERE id = ? AND side = 'in' AND share_id = ?").get(threadId, s.id)) throw httpError(404, 'That thread is gone.');
    const c = cleanComment({ id, threadId, noteKey: n.note_key, body: b.body, quote: threadId === id ? b.quote : '', prefix: threadId === id ? b.prefix : '', suffix: threadId === id ? b.suffix : '', createdAt: Date.now() });
    if (!c.body) throw httpError(400, 'Write a comment first.');
    storeComment(s.id, 'in', s.owner, config.tenant, myName(), c, true);
    send({ type: 'comment', to: s.owner, shareId: s.id, comment: c });
    return { threads: threads(db.prepare("SELECT * FROM share_comments WHERE side = 'in' AND share_id = ? AND note_key = ? ORDER BY created_at").all(s.id, n.note_key)) };
  });

  // ----- comments on my notes -----

  app.get('/api/notes/:id/share-comments', async (req) => {
    const noteId = Number(req.params.id);
    if (!enabled()) return { shares: [], threads: [] };
    const shares = myShares().filter((s) => {
      const share = db.prepare('SELECT * FROM shares_out WHERE id = ?').get(s.id);
      return share && (share.kind === 'note' ? share.ref_id === noteId : notesOf(share).some((n) => n.id === noteId));
    });
    return {
      shares: shares.map((s) => ({ id: s.id, kind: s.kind, refId: s.refId, title: s.title, people: s.people, allowComments: s.allowComments })),
      threads: threads(db.prepare("SELECT * FROM share_comments WHERE side = 'out' AND note_key = ? ORDER BY created_at").all(noteId)),
    };
  });

  app.post('/api/notes/:id/share-comments/seen', async (req) => {
    db.prepare("UPDATE share_comments SET seen_at = ? WHERE side = 'out' AND note_key = ? AND seen_at IS NULL").run(Date.now(), Number(req.params.id));
    return { ok: true };
  });

  // A reply in a thread (on my note: to the person who started it; on a shared note: to its owner).
  app.post('/api/sharing/threads/:thread/reply', async (req) => {
    mustBeOn();
    const root = db.prepare('SELECT * FROM share_comments WHERE id = ? AND thread_id = id').get(String(req.params.thread));
    if (!root) throw httpError(404, 'That thread is gone.');
    if (root.side === 'in') {
      const s = mustIncoming(root.share_id);
      if (!s.allow_comments) throw httpError(403, 'Comments are turned off for this.');
    } else if (!db.prepare('SELECT 1 FROM shares_out WHERE id = ?').get(root.share_id) || !people(root.share_id).includes(root.peer)) {
      throw httpError(409, 'It isn’t shared with them any more, so they wouldn’t see a reply.');
    }
    const c = cleanComment({ id: uid(), threadId: root.id, noteKey: root.note_key, body: req.body?.body, createdAt: Date.now() });
    if (!c.body) throw httpError(400, 'Write a reply first.');
    storeComment(root.share_id, root.side, root.peer, config.tenant, myName(), c, true);
    send({ type: 'comment', to: root.peer, shareId: root.share_id, comment: c });
    return { ok: true };
  });

  // The owner resolves a thread (it folds away for both), or opens it again.
  app.post('/api/sharing/threads/:thread/resolve', async (req) => {
    const root = db.prepare("SELECT * FROM share_comments WHERE id = ? AND thread_id = id AND side = 'out'").get(String(req.params.thread));
    if (!root) throw httpError(404, 'That thread is gone.');
    const resolved = req.body?.resolved !== false;
    db.prepare('UPDATE share_comments SET resolved_at = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ?').run(resolved ? Date.now() : null, Date.now(), root.id);
    send({ type: 'comment-resolve', to: root.peer, shareId: root.share_id, threadId: root.id, resolved });
    return { ok: true };
  });

  // Deletes a comment of mine (a thread's first comment takes the thread with it).
  app.delete('/api/sharing/comments/:id', async (req) => {
    const c = db.prepare('SELECT * FROM share_comments WHERE id = ? AND author = ?').get(String(req.params.id), config.tenant);
    if (!c) throw httpError(404, 'Not found');
    if (c.id === c.thread_id) db.prepare('DELETE FROM share_comments WHERE thread_id = ?').run(c.id);
    else db.prepare('DELETE FROM share_comments WHERE id = ?').run(c.id);
    send({ type: 'comment-delete', to: c.peer, shareId: c.share_id, id: c.id });
    return { ok: true };
  });
}

// ---------- the control port's part (server/tenant.js) ----------

export function sharingControl(app) {
  app.get('/control/sharing/outbox', async (req) => {
    const after = Number(req.query.after) || 0;
    const wait = Math.min(30_000, Math.max(0, Number(req.query.wait) || 0));
    return { messages: await readOutbox(after, wait) };
  });

  app.post('/control/sharing/inbox', async (req) => {
    try { receive(req.body ?? {}); } catch (e) { console.error(`Sharing: message ${req.body?.type} failed: ${e.message}`); }
    return { ok: true };
  });

  // Turned off (or on again) for this tenant from the console.
  app.post('/control/sharing/state', async (req) => {
    setSetting('sharing_off', req.body?.on === false ? 'yes' : 'no');
    changed('state');
    return { ok: true };
  });
}

export const sharingHealth = () => (enabled() ? {
  on: sharingOn(),
  contacts: db.prepare("SELECT COUNT(*) AS n FROM share_contacts WHERE status = 'accepted'").get().n,
  sharing: db.prepare('SELECT COUNT(*) AS n FROM shares_out').get().n,
  sharedWithMe: db.prepare('SELECT COUNT(*) AS n FROM shares_in').get().n,
} : null);

/** Tenant mode: looks for changed shares every few seconds. */
export function startSharing() {
  if (!enabled()) return;
  fs.mkdirSync(path.join(DIR, 'out'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'in'), { recursive: true });
  setInterval(() => { try { checkShares(); } catch (e) { console.error(`Sharing: ${e.message}`); } }, Number(process.env.NOTEAPP_SHARE_CHECK_MS || 4000)).unref();
}
