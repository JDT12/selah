import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { broadcast, sendTo } from './events.js';
import { dropRemote, joinRoom, lastEditor, leaveRoom, liveSaved, remoteCanSave, setRemoteSender, syncRoom } from './coedit.js';
import { deviceName } from './auth.js';
import { htmlToText, sanitizeNoteHtml } from './html.js';
import { snapshot, turnSnapshot } from './links.js';
import { methodOfNote } from './methods.js';
import { itemsOf } from './studies.js';
import { importPackage } from './notepack.js';
import { pushToAll } from './push.js';

/**
 * Sharing between the Selahs of a Selah Ministry server (8.0; through the share hub since 14.1): notes, notebooks and
 * projects (Desk studies) shared live and read-only with the others on the server (14.1: everyone who shares and
 * shows themselves; no contact requests), with margin comments going back to the owner.
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
// 14.3: what each person may do: read, edit (live co-editing) or full (edit, and add and delete notes).
if (config.mode !== 'admin' && !db.prepare("SELECT 1 FROM pragma_table_info('share_people') WHERE name = 'role'").get()) {
  db.exec("ALTER TABLE share_people ADD COLUMN role TEXT NOT NULL DEFAULT 'read'");
}
const ROLES = ['read', 'edit', 'full'];

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
const peopleRoles = (id) => db.prepare('SELECT slug, role FROM share_people WHERE share_id = ? ORDER BY slug').all(id);
const shareOf = (id) => db.prepare('SELECT * FROM shares_out WHERE id = ?').get(id);

/** What the snapshot depends on: when it differs from the last one the hub took, a new snapshot goes. */
function signature(share, notes) {
  const title = refTitle(share.kind, share.ref_id) ?? share.title;
  const study = share.kind === 'study' ? db.prepare('SELECT updated_at FROM studies WHERE id = ?').get(share.ref_id)?.updated_at : null;
  return crypto.createHash('sha1').update(JSON.stringify([title, study, share.allow_copy, share.allow_comments, peopleRoles(share.id),
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
      kind: share.kind, title, project, allowCopy: !!share.allow_copy, allowComments: !!share.allow_comments, people: peopleRoles(share.id), notes: list,
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
  dropRemote(`hub:${id}:`);
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

// ---------- live co-editing in shares (14.3) ----------
// The live room of a note I share is here (coedit.js); people on other Selahs are in it as
// 'hub:<share>:<their Selah>:<their window>'. What the room sends them goes through the hub, a few at a time.

const outLive = new Map(); // share id → [{ slug, client, msg }]
let liveTimer = null;
function flushLive() {
  liveTimer = null;
  for (const [shareId, messages] of outLive) {
    outLive.delete(shareId);
    hub('POST', `/v1/shares/${shareId}/live/send`, { messages }).catch(() => {});
  }
}
setRemoteSender((member, msg) => {
  const [, shareId, slug, client] = member.split(':');
  if (!outLive.has(shareId)) outLive.set(shareId, []);
  outLive.get(shareId).push({ slug, client, msg });
  if (!liveTimer) liveTimer = setTimeout(flushLive, 15);
});

const LIVE_STALE = 15_000;
async function answerLive(e) {
  if (e.at && Date.now() - e.at > LIVE_STALE) return null; // asked while this Selah was away: nobody's waiting any more
  const reply = (body) => (e.op === 'leave' ? null : hub('POST', `/v1/shares/${e.shareId}/live/reply`, { reqId: e.reqId, ...body }).catch(() => {}));
  try {
    const share = shareOf(String(e.shareId));
    if (!share || !sharingOn()) throw httpError(404, 'This isn’t shared any more.');
    const member = `hub:${share.id}:${e.from}:${e.client}`;
    const role = db.prepare('SELECT role FROM share_people WHERE share_id = ? AND slug = ?').get(share.id, String(e.from))?.role;
    if (!role) throw httpError(404, 'This isn’t shared with you any more.');
    const canWrite = role !== 'read';
    const key = Number(e.key);
    if (e.op !== 'add' && !notesOf(share).some((n) => n.id === key)) throw httpError(404, 'That note isn’t in the share any more.');
    const body = { ...(e.body ?? {}), kind: e.body?.kind === 'builder' ? 'builder' : 'note' };
    const who = { name: clip(e.name, 80) || String(e.from), device: clip(e.device, 80) };
    if (e.op === 'join') return reply({ body: joinRoom({ noteId: key, member, body, who, canWrite }) });
    if (e.op === 'sync') {
      if (!canWrite && body.update) throw httpError(403, 'You can read this, not change it.');
      return reply({ body: syncRoom({ noteId: key, member, body }) });
    }
    if (e.op === 'leave') { leaveRoom({ noteId: key, member, body }); return null; }
    if (!canWrite) throw httpError(403, 'You can read this, not change it.');
    if (e.op === 'save') return reply({ body: saveRemote(share, key, member, who.name, body) });
    if (e.op === 'builder') return reply({ body: await builderCall(share, key, member, who.name, String(body.method ?? ''), body.args) });
    if (e.op === 'add' || e.op === 'delete') {
      if (role !== 'full') throw httpError(403, 'Only the owner can add or take out notes here.');
      const r = e.op === 'add' ? addRemote(share, body, who.name) : deleteRemote(share, key);
      sendSnapshot(shareOf(share.id)).catch(() => {});
      return reply({ body: r });
    }
    throw httpError(400, 'Bad request');
  } catch (err) {
    return reply({ error: err.message, status: err.statusCode ?? 500 });
  }
}

const SHARED_FILE = (shareId) => new RegExp(`/api/shared/${shareId}/files/(\\d+)`, 'g');

/**
 * Someone editing a note I share saves it: their editor's HTML, cleaned (it comes from another Selah), with images
 * pointing at my files again. Version history keeps the note as it was before each person's turn, named.
 */
function saveRemote(share, noteId, member, name, b) {
  if (!remoteCanSave(noteId, member, b.live)) throw httpError(409, 'Open the note again to keep editing.');
  const html = typeof b.html === 'string' ? sanitizeNoteHtml(b.html).replace(SHARED_FILE(share.id), '/api/files/$1') : null;
  const title = typeof b.title === 'string' ? clip(b.title, 500) : null;
  if (html == null && title == null) throw httpError(400, 'Nothing to save');
  return tx(() => {
    const before = db.prepare('SELECT title, html, deleted_at FROM notes WHERE id = ?').get(noteId);
    if (!before || before.deleted_at) throw httpError(404, 'That note isn’t in the share any more.');
    const by = lastEditor.get(noteId);
    if (by !== name) turnSnapshot(noteId, by ?? null, name);
    else snapshot(noteId);
    const sets = [];
    const args = [];
    if (html != null) { sets.push('html = ?', 'text = ?'); args.push(html, htmlToText(html)); }
    if (title != null) { sets.push('title = ?'); args.push(title); }
    sets.push('updated_at = ?');
    args.push(Date.now());
    db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...args, noteId);
    lastEditor.set(noteId, name);
    liveSaved(noteId);
    broadcast({ url: `/api/notes/${noteId}`, method: 'PATCH', note: noteId, client: null });
    return db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(noteId);
  });
}

/** Full control: a new note in a notebook or project I share. */
function addRemote(share, b, name) {
  if (share.kind === 'note') throw httpError(400, 'Notes can only be added to a shared notebook or project.');
  const title = clip(b.title, 500) || 'Untitled';
  const now = Date.now();
  return tx(() => {
    let notebook = share.kind === 'notebook' ? share.ref_id : null;
    if (share.kind === 'study') {
      notebook = db.prepare('SELECT notebook_id FROM studies WHERE id = ?').get(share.ref_id)?.notebook_id
        ?? db.prepare('SELECT n.notebook_id FROM notes n JOIN study_notes sn ON sn.note_id = n.id WHERE sn.study_id = ? LIMIT 1').get(share.ref_id)?.notebook_id;
    }
    if (!notebook) throw httpError(400, 'There’s nowhere to put a new note in this.');
    const id = Number(db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(notebook, title, '', '', now, now).lastInsertRowid);
    if (share.kind === 'study') db.prepare("INSERT OR IGNORE INTO study_notes (study_id, note_id, role, added_at) VALUES (?, ?, 'note', ?)").run(share.ref_id, id, now);
    lastEditor.set(id, name);
    broadcast({ url: '/api/notes', method: 'POST', note: id, client: null });
    return { key: id };
  });
}

/** Full control: a note out of a notebook or project I share, into my Trash. */
function deleteRemote(share, noteId) {
  if (share.kind === 'note') throw httpError(400, 'Only the owner can stop sharing this note.');
  db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), noteId);
  broadcast({ url: `/api/notes/${noteId}`, method: 'DELETE', note: noteId, client: null });
  return { ok: true };
}


// ---------- builders in shares (14.3) ----------
// Someone who can edit a sermon, lesson or Bible study I share opens it in its builder. The builder's calls come
// here by name (only these), each checked against the shared note, and run through this Selah's own routes (signed in
// for the moment, as the demo seed does), so they're stored exactly as my own builder would. Saves are live saves in
// the note's builder room, their HTML cleaned first.

let selfApp = null;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

async function asOwner(method, url, payload, member) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent, app, last_seen_at, two_factor, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash, now, now + 60_000, '127.0.0.1', 'Selah share builder', null, now, 1, now);
  try {
    const r = await selfApp.inject({
      method, url, payload, remoteAddress: '127.0.0.1',
      headers: { cookie: `__Host-selah_session=${token}`, host: 'localhost', 'sec-fetch-site': 'same-origin', 'user-agent': 'Selah share builder', 'x-client-id': member,
        ...(config.desktopKey ? { 'x-selah-desktop': config.desktopKey } : {}) },
    });
    const data = r.body ? (() => { try { return JSON.parse(r.body); } catch { return null; } })() : null;
    if (r.statusCode >= 400) throw httpError(r.statusCode === 409 ? 409 : r.statusCode < 500 ? r.statusCode : 500, data?.error ?? 'That didn’t work.');
    return data;
  } finally {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
  }
}

const cleanWrite = (share, b) => ({
  ...(typeof b?.html === 'string' ? { html: sanitizeNoteHtml(b.html).replace(SHARED_FILE(share.id), '/api/files/$1') } : {}),
  ...(typeof b?.title === 'string' ? { title: clip(b.title, 500) } : {}),
  ...(b?.live != null ? { live: b.live } : {}),
});

async function builderCall(share, key, member, name, method, args) {
  const a = Array.isArray(args) ? args : [];
  const started = Date.now();
  const sameNote = (id) => { if (Number(id) !== key) throw httpError(403, 'Only the shared note can be opened here.'); };
  const sermonId = () => db.prepare('SELECT id FROM sermons WHERE note_id = ?').get(key)?.id;
  const bibleId = () => db.prepare('SELECT id FROM bible_studies WHERE note_id = ?').get(key)?.id;
  let r;
  switch (method) {
    case 'getNote': sameNote(a[0]); return asOwner('GET', `/api/notes/${key}`, undefined, member);
    case 'makeSermon': sameNote(a[0]); return asOwner('POST', `/api/notes/${key}/sermon`, undefined, member);
    case 'writeSermon': sameNote(a[0]); r = await asOwner('PUT', `/api/notes/${key}/sermon`, cleanWrite(share, a[1]), member); break;
    case 'updateSermon': {
      if (Number(a[0]) !== sermonId()) throw httpError(403, 'Only the shared sermon can be changed here.');
      const p = a[1] ?? {};
      return asOwner('PATCH', `/api/sermons/${a[0]}`, { ...pick(p, ['passage']), ...(p.data ? { data: pick(p.data, ['worksheet', 'minutes', 'step', 'stale']) } : {}) }, member);
    }
    case 'lesson': sameNote(a[0]); return asOwner('GET', `/api/notes/${key}/lesson`, undefined, member);
    case 'writeLesson': {
      sameNote(a[0]);
      const b = a[1] ?? {};
      r = await asOwner('PUT', `/api/notes/${key}/lesson`, { ...cleanWrite(share, b), ...pick(b, ['ref', 'date']),
        ...(b.lesson ? { lesson: pick(b.lesson, ['step', 'minutes', 'qtypes', 'levelOv', 'levels']) } : {}) }, member);
      break;
    }
    case 'makeBibleStudy': sameNote(a[0]); return asOwner('POST', `/api/notes/${key}/bible-study`, undefined, member);
    case 'writeBibleStudy': sameNote(a[0]); r = await asOwner('PUT', `/api/notes/${key}/bible-study`, cleanWrite(share, a[1]), member); break;
    case 'updateBibleStudy': {
      if (Number(a[0]) !== bibleId()) throw httpError(403, 'Only the shared study can be changed here.');
      const p = a[1] ?? {};
      return asOwner('PATCH', `/api/bible-studies/${a[0]}`, { ...pick(p, ['passage']), ...(p.data ? { data: pick(p.data, ['timesRead', 'translations', 'checks', 'step', 'keeper']) } : {}) }, member);
    }
    default: throw httpError(403, 'That isn’t available in a shared builder.');
  }
  // A save: version history names who it was (the builder's own "before it saved" copy says so), and the owner's
  // next turn keeps theirs.
  db.prepare(`UPDATE note_versions SET reason = ? WHERE id = (SELECT id FROM note_versions WHERE note_id = ? AND reason LIKE 'Before the % builder saved'
    AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1)`).run(`Before ${name} saved in the builder`, key, started);
  lastEditor.set(key, name);
  return r;
}

// ---------- events from the hub ----------

function onEvent(e) {
  switch (e.type) {
    case 'people':
      // Someone was shown, hidden, added or removed (14.1: everyone shown is a contact).
      return changed('contacts');
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
    case 'live':
      // Someone a share of mine is for, in one of its notes (14.3): answered from the note's live room.
      answerLive(e);
      return undefined;
    case 'live-msg':
      // The live room of a note shared with me, to one of my windows.
      if (typeof e.client === 'string' && e.msg && typeof e.msg === 'object') sendTo(e.client, { ...e.msg, note: `${e.shareId}:${e.msg.note}` });
      return undefined;
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
    allowComments: !!s.allow_comments, sentAt: s.sent_at, people: peopleRoles(s.id).map(({ slug, role }) => ({ slug, role, name: names.get(slug) ?? slug })),
    comments: unread[s.id] ?? 0,
  }));
}

const ownerShareOf = (kind, refId) => db.prepare('SELECT * FROM shares_out WHERE kind = ? AND ref_id = ?').get(kind, refId);
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|audio\/|video\/)/;
const sid = (v) => { const id = String(v ?? ''); if (!SHARE_ID.test(id)) throw httpError(404, 'This was shared with you but isn’t any more.'); return id; };

// ---------- routes ----------

export default async function sharingRoutes(app) {
  selfApp = app;
  app.get('/api/sharing', async () => {
    if (!enabled()) return { enabled: false };
    const [{ contacts }, { shares }, mine, me] = await Promise.all([hub('GET', '/v1/contacts'), hub('GET', '/v1/shared'), hub('GET', '/v1/mine'), hub('GET', '/v1/me')]);
    const title = db.prepare('SELECT title FROM notes WHERE id = ? AND deleted_at IS NULL');
    return {
      // 14.1: contacts are everyone on the server who shares and shows themselves (me.listed: whether I do).
      enabled: true, on: sharingOn(), me: { slug: config.tenant, name: myName(), listed: me.listed },
      contacts, sharedWithMe: shares, myShares: await myShares(contacts),
      // My notes with comments I haven't read, for Home.
      newComments: mine.notes.map((n) => ({ noteId: n.noteKey, title: title.get(n.noteKey)?.title, count: n.count, at: n.at, fromName: n.fromName }))
        .filter((n) => n.title != null),
    };
  });

  // "Show me to others" (14.1). Off: nobody can share with me and I can't share, so what I share ends here too.
  app.put('/api/sharing/me', async (req) => {
    mustBeOn();
    const listed = req.body?.listed !== false;
    const r = await hub('PUT', '/v1/me', { listed });
    if (!listed) db.exec('DELETE FROM shares_out');
    changed('contacts');
    return r;
  });

  // Hides someone's shares from me, or shows them again (Shared with me → Hide). They aren't told.
  app.post('/api/sharing/hide/:slug', async (req) => {
    if (!enabled()) throw httpError(404, 'Not found');
    const r = await hub('POST', `/v1/hide/${encodeURIComponent(req.params.slug)}`, { hidden: req.body?.hidden !== false });
    changed('contacts');
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
    // 14.3: people as slugs, or { slug, role } (read, edit or full).
    const roles = new Map();
    for (const p of Array.isArray(b.people) ? b.people : []) {
      const slug = String(typeof p === 'object' && p ? p.slug : p);
      roles.set(slug, typeof p === 'object' && ROLES.includes(p?.role) ? p.role : 'read');
    }
    const list = [...roles.keys()];
    const { contacts } = await hub('GET', '/v1/contacts');
    for (const slug of list) if (!contacts.some((c) => c.slug === slug && c.status === 'accepted')) throw httpError(400, `${slug} can’t be shared with: sharing is off for them, or they’re hidden from others.`);
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
      for (const slug of list) {
        db.prepare('INSERT OR IGNORE INTO share_people (share_id, slug, added_at, role) VALUES (?, ?, ?, ?)').run(s.id, slug, now, roles.get(slug));
        db.prepare('UPDATE share_people SET role = ? WHERE share_id = ? AND slug = ?').run(roles.get(slug), s.id, slug);
      }
    });
    // Someone who can only read now (or isn't in it any more) leaves its live rooms; they come back to read.
    for (const slug of list) if (roles.get(slug) === 'read') dropRemote(`hub:${s.id}:${slug}:`);
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

  // 14.3 live co-editing in a note shared with me: to the owner's Selah through the hub.
  const live = (req, op, key, body) => hub('POST', `/v1/shared/${sid(req.params.id)}/live`, {
    op, key, client: String(req.headers['x-client-id'] ?? ''), device: deviceName(String(req.headers['user-agent'] ?? ''), req.session?.app ?? ''), body,
  }, { timeout: 20_000 });
  app.post('/api/shared/:id/notes/:key/coedit/:op', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const op = String(req.params.op);
    if (!['join', 'sync', 'leave'].includes(op)) throw httpError(404, 'Not found');
    return live(req, op, Number(req.params.key), req.body ?? {});
  });
  app.post('/api/shared/:id/notes/:key/save', { bodyLimit: 12 * 1024 * 1024 }, async (req) => live(req, 'save', Number(req.params.key), req.body ?? {}));
  app.post('/api/shared/:id/notes', async (req) => live(req, 'add', null, { title: clip(req.body?.title, 500) }));
  app.post('/api/shared/:id/notes/:key/builder', { bodyLimit: 12 * 1024 * 1024 }, async (req) => live(req, 'builder', Number(req.params.key), { method: String(req.body?.method ?? ''), args: req.body?.args ?? [] }));
  app.delete('/api/shared/:id/notes/:key', async (req) => live(req, 'delete', Number(req.params.key), {}));

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
