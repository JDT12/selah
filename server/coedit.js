import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { db } from './db.js';
import { config } from './config.js';
import { deviceName } from './auth.js';
import { hasStream, onStreamGone, sendTo } from './events.js';

/**
 * Live co-editing (14.3). A note open in several windows (this PC, the web, a phone or tablet) is one shared Yjs
 * document: each window sends its typing here as Yjs updates, and this passes them on to the others in the note
 * through their own live-updates stream (events.js sendTo). Nothing merges on the server but Yjs itself; the
 * windows still save the note's HTML as before (PATCH /api/notes/:id with `live`), so everything else in Selah reads
 * the note as it always has.
 *
 * A room is one note's document while anyone has it open. Its state is kept in note_live too, with the note's
 * updated_at it belongs to (html_at): opened again later, the state is used only if the note hasn't changed since in
 * some other way. A change from outside the room (a builder, Preach's check-offs, an import, an older window) resets
 * the room: everyone in it loads the note again, and the first to join builds the document from its HTML ("seed").
 * `epoch` counts those resets, so a window coming back from a dropped connection can tell whether its document still
 * belongs.
 *
 * Messages to a window: { coedit, note, epoch, ... } with coedit = update | awareness | seeded | seed | reset.
 */

db.exec(`CREATE TABLE IF NOT EXISTS note_live (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',
  epoch INTEGER NOT NULL DEFAULT 1,
  state BLOB,
  html_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, kind)
)`);

const httpError = (code, message, data) => Object.assign(new Error(message), { statusCode: code, ...(data ? { data } : {}) });
const CLIENT_ID = /^[\w-]{8,64}$/;
const MAX_UPDATE = 8 * 1024 * 1024; // base64, one batch
const KEEP_EMPTY = 30_000; // a room no one is in stays in memory this long (a reload comes straight back)
const PERSIST_AFTER = 1_000;
const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

// Two kinds of room for a note: 'note' (the note editor, a TipTap document) and 'builder' (a sermon, lesson or study
// builder's model, client/src/liveModel.js). They don't share a document: a save from one is a change from outside
// for the other, which then starts again from the saved note.
const KINDS = new Set(['note', 'builder']);
const kindOf = (v) => (KINDS.has(v) ? v : 'note');
// 14.3 sharing: someone on another Selah of the server, in a note shared with them, is a member too, as
// 'hub:<their Selah>:<their window>' (sharing.js passes their messages through the share hub).
const REMOTE = /^hub:/;
let remoteSend = null;
/** sharing.js: how a message gets to a member on another Selah. */
export function setRemoteSender(fn) { remoteSend = fn; }
const deliver = (id, msg) => (REMOTE.test(id) ? (remoteSend?.(id, msg), true) : sendTo(id, msg));
const reachable = (id) => REMOTE.test(id) || hasStream(id);

/** 14.3 sharing: who last changed a note from another Selah (their name), for its version history. */
export const lastEditor = new Map();

/** 'kind:noteId' → room */
const rooms = new Map();
const roomKey = (kind, noteId) => `${kind}:${noteId}`;

function noteRow(id) {
  return db.prepare('SELECT title, html, updated_at, deleted_at FROM notes WHERE id = ?').get(id);
}

function newDoc() {
  const doc = new Y.Doc({ gc: true });
  return { doc, awareness: new Awareness(doc) };
}

function openRoom(kind, noteId) {
  let room = rooms.get(roomKey(kind, noteId));
  if (room) { clearTimeout(room.dropTimer); room.dropTimer = null; return room; }
  const note = noteRow(noteId);
  if (!note) throw httpError(404, 'Note not found');
  const saved = db.prepare('SELECT epoch, state, html_at FROM note_live WHERE note_id = ? AND kind = ?').get(noteId, kind);
  const { doc, awareness } = newDoc();
  // The awareness of the server's own document isn't anyone's: no state of its own.
  awareness.setLocalState(null);
  let seeded = false;
  // A builder's state also holds what's kept beside the note (a sermon's passage, its worksheet), which can change
  // without the note changing: a builder room no one is in always starts again from the note.
  if (kind === 'note' && saved?.state && saved.html_at === note.updated_at) {
    try { Y.applyUpdate(doc, new Uint8Array(saved.state)); seeded = true; } catch { /* a bad state: build it again */ }
  }
  room = {
    kind, noteId, doc, awareness, epoch: (saved?.epoch ?? 0) + (seeded ? 0 : 1), seeded, seeder: null,
    members: new Map(), // clientId → { awarenessId, device }
    htmlAt: note.updated_at, lastHtml: note.html, lastTitle: note.title,
    persistTimer: null, dropTimer: null,
  };
  if (!seeded) persist(room, true);
  doc.on('update', () => schedulePersist(room));
  rooms.set(roomKey(kind, noteId), room);
  return room;
}

function persist(room, now = false) {
  clearTimeout(room.persistTimer);
  room.persistTimer = null;
  const state = room.seeded ? Buffer.from(Y.encodeStateAsUpdate(room.doc)) : null;
  const write = () => db.prepare(`INSERT INTO note_live (note_id, kind, epoch, state, html_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id, kind) DO UPDATE SET epoch = excluded.epoch, state = excluded.state, html_at = excluded.html_at, updated_at = excluded.updated_at`)
    .run(room.noteId, room.kind, room.epoch, state, room.htmlAt, Date.now());
  try { write(); } catch { /* the note was deleted */ }
  return now;
}

function schedulePersist(room) {
  if (room.persistTimer) return;
  room.persistTimer = setTimeout(() => persist(room), PERSIST_AFTER);
}

function others(room, clientId, msg) {
  for (const id of room.members.keys()) if (id !== clientId) deliver(id, { coedit: msg.coedit, note: room.noteId, kind: room.kind, epoch: room.epoch, ...msg });
}

function leave(room, clientId) {
  const m = room.members.get(clientId);
  if (!m) return;
  room.members.delete(clientId);
  if (m.awarenessId != null && room.awareness.states.has(m.awarenessId)) {
    removeAwarenessStates(room.awareness, [m.awarenessId], 'server');
    others(room, clientId, { coedit: 'awareness', update: b64(encodeAwarenessUpdate(room.awareness, [m.awarenessId])) });
  }
  if (room.seeder === clientId) {
    room.seeder = null;
    if (!room.seeded) askToSeed(room);
  }
  if (!room.members.size) {
    if (room.seeded) persist(room);
    room.dropTimer = setTimeout(() => {
      if (room.members.size) return;
      if (room.seeded) persist(room);
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(roomKey(room.kind, room.noteId));
    }, KEEP_EMPTY);
  }
}

/** The room has no document yet: the next window in it builds it from the note's HTML. */
function askToSeed(room) {
  const next = [...room.members.keys()].find((id) => reachable(id) && room.members.get(id).canWrite !== false);
  if (!next) return;
  room.seeder = next;
  const note = noteRow(room.noteId);
  room.lastHtml = note?.html ?? '';
  room.lastTitle = note?.title ?? '';
  room.htmlAt = note?.updated_at ?? room.htmlAt;
  deliver(next, { coedit: 'seed', note: room.noteId, kind: room.kind, epoch: room.epoch, html: room.lastHtml, title: room.lastTitle });
}

/** Someone outside the room changed the note: everyone in it starts again from the saved note. */
function reset(room) {
  room.epoch += 1;
  room.awareness.destroy();
  room.doc.destroy();
  Object.assign(room, newDoc());
  room.awareness.setLocalState(null);
  room.doc.on('update', () => schedulePersist(room));
  room.seeded = false;
  room.seeder = null;
  const note = noteRow(room.noteId);
  room.htmlAt = note?.updated_at ?? 0;
  room.lastHtml = note?.html ?? '';
  room.lastTitle = note?.title ?? '';
  persist(room, true);
  for (const id of room.members.keys()) deliver(id, { coedit: 'reset', note: room.noteId, kind: room.kind, epoch: room.epoch });
  room.members.clear();
}

/** After any change through the API: a room whose note was changed from outside it starts again. */
function checkRooms() {
  for (const room of rooms.values()) {
    const n = noteRow(room.noteId);
    if (!n) { reset(room); continue; }
    if (n.updated_at === room.htmlAt) continue;
    if (n.html === room.lastHtml && n.title === room.lastTitle) { room.htmlAt = n.updated_at; continue; }
    if (n.deleted_at || room.members.size || room.seeded) reset(room);
  }
}

/**
 * For a save of the note (PATCH /api/notes/:id, or a builder's PUT): is it from a window in the note's room of that
 * kind (and so not a conflict)?
 */
export function liveSave(noteId, clientId, epoch, kind = 'note') {
  const room = rooms.get(roomKey(kindOf(kind), noteId));
  return !!room && room.members.has(String(clientId ?? '')) && Number(epoch) === room.epoch;
}

/** After a live save: the room's document and the saved note agree again. */
export function liveSaved(noteId, kind = 'note') {
  const room = rooms.get(roomKey(kindOf(kind), noteId));
  const n = room && noteRow(noteId);
  if (!n) return;
  room.htmlAt = n.updated_at;
  room.lastHtml = n.html;
  room.lastTitle = n.title;
  schedulePersist(room);
}

onStreamGone((clientId) => {
  for (const room of rooms.values()) leave(room, clientId);
});

const clientOf = (req) => {
  const id = String(req.headers['x-client-id'] ?? '');
  if (!CLIENT_ID.test(id)) throw httpError(400, 'This window has no id');
  return id;
};

export default async function coeditRoutes(app) {
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400 || !rooms.size) return;
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/coedit/')) return;
    checkRooms();
  });
  app.addHook('preClose', async () => { for (const room of rooms.values()) if (room.seeded) persist(room); });

  app.post('/api/coedit/:id/join', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const clientId = clientOf(req);
    if (!hasStream(clientId)) throw httpError(409, 'Live updates aren’t connected');
    return joinRoom({
      noteId: Number(req.params.id), member: clientId, body: req.body ?? {},
      who: { name: process.env.NOTEAPP_TENANT_NAME || config.tenant || '', device: deviceName(String(req.headers['user-agent'] ?? ''), req.session?.app ?? '') },
    });
  });
  app.post('/api/coedit/:id/sync', { bodyLimit: 12 * 1024 * 1024 }, async (req) => syncRoom({ noteId: Number(req.params.id), member: clientOf(req), body: req.body ?? {} }));
  app.post('/api/coedit/:id/leave', async (req) => leaveRoom({ noteId: Number(req.params.id), member: clientOf(req), body: req.body ?? {} }));
}

/**
 * Join a note's room (a window here, or someone on another Selah: sharing.js). Returns its document (state), or
 * seed: true when this window is to build it from `html`, or wait: true while another window does (the state then
 * comes as a 'seeded' message). Coming back after a dropped connection, the window sends its epoch and its own state,
 * which merges in if the room hasn't started again. canWrite false: they see the typing and cursors, but nothing
 * they send changes the document (a share they can only read).
 */
export function joinRoom({ noteId, member, body: b, who, canWrite = true }) {
  if (!Number.isInteger(noteId) || noteId <= 0) throw httpError(400, 'Invalid id');
  const room = openRoom(kindOf(b.kind), noteId);
  room.members.set(member, { awarenessId: Number.isInteger(b.awareness_id) ? b.awareness_id : null, device: who.device, canWrite });
  if (canWrite && room.seeded && b.epoch === room.epoch && typeof b.state === 'string' && b.state.length < MAX_UPDATE) {
    try { Y.applyUpdate(room.doc, unb64(b.state), member); } catch { /* keep the room's own */ }
  }
  const awareness = room.awareness.states.size ? b64(encodeAwarenessUpdate(room.awareness, [...room.awareness.states.keys()])) : null;
  if (room.seeded) return { epoch: room.epoch, state: b64(Y.encodeStateAsUpdate(room.doc)), awareness, who, canWrite };
  if (canWrite && (!room.seeder || !room.members.has(room.seeder) || !reachable(room.seeder))) {
    room.seeder = member;
    const note = noteRow(noteId);
    room.lastHtml = note.html;
    room.lastTitle = note.title;
    room.htmlAt = note.updated_at;
    return { epoch: room.epoch, seed: true, html: note.html, title: note.title, awareness, who, canWrite };
  }
  // Someone who can only read, with nobody editing yet: nothing live to show (they read the shared copy).
  if (!canWrite && (!room.seeder || !room.members.has(room.seeder) || !reachable(room.seeder))) { room.members.delete(member); return { idle: true }; }
  return { epoch: room.epoch, wait: true, awareness, who, canWrite };
}

/** Typing and cursors: { epoch, update?, awareness?, seeded? } (base64 Yjs updates). */
export function syncRoom({ noteId, member, body: b }) {
  const room = rooms.get(roomKey(kindOf(b.kind), noteId));
  if (!room || !room.members.has(member) || b.epoch !== room.epoch) return { rejoin: true, epoch: room?.epoch ?? null };
  const canWrite = room.members.get(member).canWrite !== false;
  if (typeof b.update === 'string' && b.update) {
    if (!canWrite) throw httpError(403, 'You can read this, not change it.');
    if (b.update.length > MAX_UPDATE) throw httpError(413, 'Too much at once');
    if (!room.seeded && room.seeder !== member) return { rejoin: true, epoch: room.epoch };
    Y.applyUpdate(room.doc, unb64(b.update), member);
    if (!room.seeded && b.seeded) {
      room.seeded = true;
      room.seeder = null;
      persist(room);
      others(room, member, { coedit: 'seeded', state: b64(Y.encodeStateAsUpdate(room.doc)) });
    } else {
      others(room, member, { coedit: 'update', update: b.update });
    }
  }
  if (typeof b.awareness === 'string' && b.awareness && b.awareness.length < 64 * 1024) {
    applyAwarenessUpdate(room.awareness, unb64(b.awareness), member);
    others(room, member, { coedit: 'awareness', update: b.awareness });
  }
  return { ok: true };
}

export function leaveRoom({ noteId, member, body: b }) {
  const room = rooms.get(roomKey(kindOf(b?.kind), noteId));
  if (room) leave(room, member);
  return { ok: true };
}

/** For a save from someone on another Selah: are they in the room, at its epoch, and can they change it? */
export function remoteCanSave(noteId, member, epoch) {
  const room = rooms.get(roomKey('note', noteId));
  const m = room?.members.get(member);
  return !!m && m.canWrite !== false && Number(epoch) === room.epoch;
}

/** Everyone on another Selah in a room goes (their share ended, or their access was taken away). */
export function dropRemote(prefix) {
  for (const room of rooms.values()) for (const id of [...room.members.keys()]) if (id.startsWith(prefix)) leave(room, id);
}
