import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { clientId } from './live.js';

/**
 * Live co-editing (14.3, server/coedit.js). A note open in more than one window is one Yjs document: this window's
 * typing goes to the server in small batches, and the others' comes back through the live-updates stream
 * ('noteapp:coedit'). The editor binds to `doc` (TipTap's Collaboration) and shows the others' cursors from
 * `awareness` (CollaborationCaret). Saving the note's HTML stays with the editor, as before.
 *
 * joinCoedit resolves with a session that's ready to edit, or null when live editing isn't available here (an older
 * server, no live-updates stream): the editor then works as it did before 14.3.
 */

const REMOTE = 'coedit-remote';
const SEND_AFTER = 30;
// One color for each window in a note: cursors and the who's-here circles.
const COLORS = ['#2b6cb0', '#c05621', '#2f855a', '#b83280', '#6b46c1', '#c53030', '#0f766e', '#975a16'];

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function post(path, body, { keepalive = false } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    keepalive,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export class CoeditSession {
  /**
   * opts.base: where the room is reached (default /api/coedit/<noteId>; a note shared with me: its address on my
   * Selah, which passes it through the share hub to the owner's). opts.id: what the room's messages name it by.
   */
  constructor(noteId, kind = 'note', opts = {}) {
    this.noteId = opts.id ?? noteId;
    this.base = opts.base ?? `/api/coedit/${noteId}`;
    this.canWrite = true;
    this.kind = kind; // 'note' (the note editor) or 'builder' (liveModel.js)
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.epoch = null;
    this.seed = null; // { html, title } when this window builds the document
    this.who = { name: '', device: '' };
    this.queue = [];
    this.awarenessDirty = false;
    this.sending = false;
    this.timer = null;
    this.closed = false;
    this.listeners = { reset: new Set(), peers: new Set() };
    this.onDocUpdate = (update, origin) => { if (origin !== REMOTE) { this.queue.push(update); this.schedule(); } };
    this.onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'local') { this.awarenessDirty = true; this.schedule(); }
      if (added.length || updated.length || removed.length) for (const fn of this.listeners.peers) fn(this.peers());
    };
    this.onMessage = (e) => this.message(e.detail);
    this.onReconnect = () => { if (!this.closed) this.rejoin(); };
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwareness);
    window.addEventListener('noteapp:coedit', this.onMessage);
    window.addEventListener('noteapp:live-reconnect', this.onReconnect);
    this.waiting = null; // resolves when the document arrives from the window building it
  }

  on(kind, fn) { this.listeners[kind].add(fn); return () => this.listeners[kind].delete(fn); }

  get title() { return this.doc.getText('title'); }

  /** Everyone else with the note open: [{ id, name, device, color }]. */
  peers() {
    const out = [];
    for (const [id, s] of this.awareness.getStates()) {
      if (id === this.doc.clientID || !s?.user) continue;
      out.push({ id, ...s.user });
    }
    return out;
  }

  get user() {
    return this.awareness.getLocalState()?.user ?? {};
  }

  async join() {
    let r;
    for (let i = 0; ; i++) {
      try {
        r = await post(`${this.base}/join`, { kind: this.kind, awareness_id: this.doc.clientID });
        break;
      } catch (e) {
        // The live-updates stream may still be connecting.
        if (e.status !== 409 || i >= 6) throw e;
        await sleep(300);
      }
    }
    if (r.idle) throw new Error('nobody is editing it');
    this.epoch = r.epoch;
    this.who = r.who ?? this.who;
    this.canWrite = r.canWrite !== false;
    if (r.awareness) applyAwarenessUpdate(this.awareness, fromB64(r.awareness), REMOTE);
    const color = COLORS[this.doc.clientID % COLORS.length];
    this.awareness.setLocalStateField('user', { name: this.who.name || '', device: this.who.device || '', color });
    if (r.state) Y.applyUpdate(this.doc, fromB64(r.state), REMOTE);
    else if (r.seed) this.seed = { html: r.html ?? '', title: r.title ?? '' };
    else if (r.wait) {
      await new Promise((resolve, reject) => {
        this.waiting = { resolve, reject };
        setTimeout(() => reject(new Error('timed out')), 8000);
      });
      this.waiting = null;
    }
    return this;
  }

  /** The editor has built the document from the note's HTML: send it as the room's. */
  seedDone() {
    if (!this.seed) return;
    this.seeding = true;
    this.seed = null;
    this.flush();
  }

  message(m) {
    if (!m || m.note !== this.noteId || (m.kind ?? 'note') !== this.kind || this.closed) return;
    if (m.coedit === 'reset') { this.emitReset(); return; }
    if (m.epoch !== this.epoch) return;
    if (m.coedit === 'update') Y.applyUpdate(this.doc, fromB64(m.update), REMOTE);
    else if (m.coedit === 'awareness') applyAwarenessUpdate(this.awareness, fromB64(m.update), REMOTE);
    else if (m.coedit === 'seeded') {
      Y.applyUpdate(this.doc, fromB64(m.state), REMOTE);
      this.waiting?.resolve();
    } else if (m.coedit === 'seed' && this.waiting) {
      // The window that was building it went away: this one does.
      this.seed = { html: m.html ?? '', title: m.title ?? '' };
      this.waiting.resolve();
    }
  }

  emitReset() {
    if (this.closed) return;
    for (const fn of this.listeners.reset) fn();
  }

  schedule() {
    if (this.timer || this.closed || this.seed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SEND_AFTER);
  }

  async flush() {
    if (this.sending || this.closed || this.seed) return;
    if (!this.queue.length && !this.awarenessDirty) return;
    const updates = this.queue.splice(0);
    const body = { kind: this.kind, epoch: this.epoch };
    if (updates.length) body.update = toB64(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    if (this.awarenessDirty) {
      this.awarenessDirty = false;
      body.awareness = toB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    }
    if (this.seeding) body.seeded = true;
    this.sending = true;
    try {
      const r = await post(`${this.base}/sync`, body);
      if (r.rejoin) { this.queue.unshift(...updates); await this.rejoin(r.epoch); }
      else this.seeding = false;
    } catch (e) {
      // Refused (14.3: a share that's read-only now): nothing to send. Otherwise kept for the next try.
      if (e.status === 403) { this.queue = []; this.awarenessDirty = false; this.sending = false; this.emitReset(); return; }
      this.queue.unshift(...updates);
      await sleep(1000);
    } finally {
      this.sending = false;
    }
    if (this.queue.length || this.awarenessDirty) this.schedule();
  }

  /** Back after a dropped connection: carry on if the room is the same, else start again. */
  async rejoin(epoch) {
    if (this.closed) return;
    if (epoch != null && epoch !== this.epoch) { this.emitReset(); return; }
    try {
      const r = await post(`${this.base}/join`, {
        kind: this.kind, awareness_id: this.doc.clientID, epoch: this.epoch, state: toB64(Y.encodeStateAsUpdate(this.doc)),
      });
      if (r.epoch !== this.epoch || !r.state) { this.emitReset(); return; }
      this.queue = [];
      Y.applyUpdate(this.doc, fromB64(r.state), REMOTE);
      if (r.awareness) applyAwarenessUpdate(this.awareness, fromB64(r.awareness), REMOTE);
      this.awarenessDirty = true;
      this.schedule();
    } catch { /* tried again at the next reconnect */ }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    window.removeEventListener('noteapp:coedit', this.onMessage);
    window.removeEventListener('noteapp:live-reconnect', this.onReconnect);
    const last = this.queue.length ? toB64(Y.mergeUpdates(this.queue)) : null;
    const base = this.base;
    const epoch = this.epoch;
    const kind = this.kind;
    (async () => {
      if (last && epoch != null) await post(`${base}/sync`, { kind, epoch, update: last }, { keepalive: true }).catch(() => {});
      post(`${base}/leave`, { kind }, { keepalive: true }).catch(() => {});
    })();
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** A ready session for this note, or null when live editing isn't available (the editor then works as before). */
export async function joinCoedit(noteId, kind = 'note', opts = {}) {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return null;
  const s = new CoeditSession(noteId, kind, opts);
  try {
    await s.join();
    return s;
  } catch {
    s.destroy();
    return null;
  }
}

/** Sets a Y.Text to `next` with the smallest change (what's the same at both ends stays), so others' typing merges. */
export function setYText(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  ytext.doc.transact(() => {
    if (prev.length - start - end > 0) ytext.delete(start, prev.length - start - end);
    if (next.length - start - end > 0) ytext.insert(start, next.slice(start, next.length - end));
  });
}
