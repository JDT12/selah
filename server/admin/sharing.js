import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { cloud, getTenant, listTenants, saveCloud } from './store.js';
import { paths } from './paths.js';
import { control } from './control.js';

/**
 * Sharing between tenants (Admin 3.0, Selah 8.0): the relay. Tenants can't reach each other or the console, so the
 * console keeps a request open to each tenant's control port for the messages it has queued (contact requests,
 * shares, comments; server/sharing.js), checks each one and delivers it to the other tenant.
 *
 * What's checked here, not trusted from the tenant: who is a contact of whom, which tenant a share belongs to and who
 * it's shared with, whether it takes comments, and whether sharing is on for both. Names come from the tenant list.
 * A share's snapshot is a folder the owner writes (storage/sharing/out/<id>); it's copied to each person's
 * storage/sharing/in/<id>, attachments as hard links where they can be. The console sees titles, never the notes.
 *
 * Messages for a tenant that isn't answering wait in relay_held and go when it's back, in order.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const SHARE_ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const WAIT = Number(process.env.NOTEAPP_SHARE_WAIT_MS || 25_000);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const json = (s, fallback) => { try { return JSON.parse(s ?? 'null') ?? fallback; } catch { return fallback; } };

db.exec(`
CREATE TABLE IF NOT EXISTS relay_contacts (
  a TEXT NOT NULL,                     -- the pair in name order (a < b)
  b TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | accepted
  requested_by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS relay_shares (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  allow_comments INTEGER NOT NULL DEFAULT 1,
  allow_copy INTEGER NOT NULL DEFAULT 0,
  people TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_held (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  msg TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  other TEXT,
  title TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS relay_log_at ON relay_log(at);
CREATE TABLE IF NOT EXISTS relay_cursors (
  slug TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);`);

// ---------- records ----------

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const contactRow = (x, y) => db.prepare('SELECT * FROM relay_contacts WHERE a = ? AND b = ?').get(...pair(x, y));
const areContacts = (x, y) => contactRow(x, y)?.status === 'accepted';
const log = (kind, slug, other = null, title = null, detail = null) =>
  db.prepare('INSERT INTO relay_log (at, kind, slug, other, title, detail) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), kind, slug, other, title ? clip(title, 300) : null, detail);

export const sharingOff = () => new Set(cloud().sharingOff ?? []);
const allowed = (slug) => {
  const t = getTenant(slug);
  return !!t && t.status === 'active' && !sharingOff().has(slug);
};
const nameOf = (slug) => getTenant(slug)?.name || slug;
const shareRow = (id) => {
  const s = db.prepare('SELECT * FROM relay_shares WHERE id = ?').get(id);
  return s ? { ...s, people: json(s.people, []) } : null;
};

// ---------- delivery ----------

/** Sends a message to a tenant now, or holds it (behind any already held) until it answers. */
async function deliver(slug, msg) {
  const t = getTenant(slug);
  if (!t) return;
  if (db.prepare('SELECT 1 FROM relay_held WHERE slug = ? LIMIT 1').get(slug)) {
    db.prepare('INSERT INTO relay_held (slug, msg, at) VALUES (?, ?, ?)').run(slug, JSON.stringify(msg), Date.now());
    return;
  }
  try {
    await control(t, 'POST', '/control/sharing/inbox', msg, { timeout: 10_000 });
  } catch {
    db.prepare('INSERT INTO relay_held (slug, msg, at) VALUES (?, ?, ?)').run(slug, JSON.stringify(msg), Date.now());
  }
}

async function sendHeld(t) {
  for (const h of db.prepare('SELECT * FROM relay_held WHERE slug = ? ORDER BY id').all(t.slug)) {
    try {
      await control(t, 'POST', '/control/sharing/inbox', json(h.msg, {}), { timeout: 10_000 });
    } catch { return; }
    db.prepare('DELETE FROM relay_held WHERE id = ?').run(h.id);
  }
}

// ---------- snapshots ----------

const sharingDir = (slug, side, id) => path.join(paths.tenant(slug).storage, 'sharing', side, id);

function linkOrCopy(from, to) {
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

/** Copies the owner's snapshot of a share to one person (attachments they have already are kept). */
function copySnapshot(owner, to, id) {
  const src = sharingDir(owner, 'out', id);
  const dst = sharingDir(to, 'in', id);
  if (!fs.existsSync(path.join(src, 'snapshot.json'))) throw httpError(404, 'The snapshot is missing.');
  fs.mkdirSync(path.join(dst, 'files'), { recursive: true });
  const files = fs.existsSync(path.join(src, 'files')) ? fs.readdirSync(path.join(src, 'files')).filter((f) => /^[\w.-]+$/.test(f)) : [];
  const keep = new Set(files);
  for (const f of files) {
    const target = path.join(dst, 'files', f);
    if (!fs.existsSync(target)) linkOrCopy(path.join(src, 'files', f), target);
  }
  for (const f of fs.readdirSync(path.join(dst, 'files'))) if (!keep.has(f)) fs.rmSync(path.join(dst, 'files', f), { force: true });
  fs.copyFileSync(path.join(src, 'snapshot.json'), path.join(dst, 'snapshot.json.new'));
  fs.renameSync(path.join(dst, 'snapshot.json.new'), path.join(dst, 'snapshot.json'));
}

function dropSnapshot(to, id) {
  if (SHARE_ID.test(id)) fs.rmSync(sharingDir(to, 'in', id), { recursive: true, force: true });
}

async function revoke(share, slug) {
  dropSnapshot(slug, share.id);
  await deliver(slug, { type: 'share-revoked', from: share.owner, id: share.id });
}

// ---------- one message from a tenant ----------

async function handle(from, msg) {
  const to = SLUG.test(String(msg.to ?? '')) ? msg.to : null;
  const refuse = (type, error, extra = {}) => deliver(from, { type, error, ...extra });

  switch (msg.type) {
    case 'contact-request': {
      if (!to || to === from) return;
      if (!allowed(from)) return refuse('contact-error', 'Sharing is turned off for your Selah.', { to });
      if (!getTenant(to) || getTenant(to).status !== 'active') return refuse('contact-error', `There’s no one called “${to}” on this Selah server.`, { to });
      if (!allowed(to)) return refuse('contact-error', `${nameOf(to)} can’t take contact requests right now.`, { to });
      const c = contactRow(from, to);
      if (c?.status === 'accepted') return deliver(from, { type: 'contact-accepted', from: to, name: nameOf(to) });
      if (c?.status === 'pending' && c.requested_by === to) return accept(from, to);
      db.prepare('INSERT OR REPLACE INTO relay_contacts (a, b, status, requested_by, at) VALUES (?, ?, ?, ?, ?)').run(...pair(from, to), 'pending', from, Date.now());
      log('contact-request', from, to);
      return deliver(to, { type: 'contact-request', from, name: nameOf(from) });
    }
    case 'contact-accept': {
      if (!to) return;
      const c = contactRow(from, to);
      if (c?.status === 'accepted') return deliver(from, { type: 'contact-accepted', from: to, name: nameOf(to) });
      if (c?.status !== 'pending' || c.requested_by !== to) return;
      return accept(from, to);
    }
    case 'contact-remove': {
      if (!to || !contactRow(from, to)) return;
      db.prepare('DELETE FROM relay_contacts WHERE a = ? AND b = ?').run(...pair(from, to));
      // Everything shared between them ends.
      for (const s of db.prepare('SELECT * FROM relay_shares WHERE owner IN (?, ?)').all(from, to).map((r) => ({ ...r, people: json(r.people, []) }))) {
        const other = s.owner === from ? to : from;
        if (!s.people.includes(other)) continue;
        dropSnapshot(other, s.id);
        db.prepare('UPDATE relay_shares SET people = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(s.people.filter((p) => p !== other)), Date.now(), s.id);
      }
      log('contact-removed', from, to);
      return deliver(to, { type: 'contact-removed', from });
    }
    case 'share': {
      const id = String(msg.id ?? '');
      if (!SHARE_ID.test(id)) return;
      const title = clip(msg.title, 300);
      if (!allowed(from)) return refuse('share-error', 'Sharing is turned off for your Selah.');
      const old = shareRow(id);
      if (old && old.owner !== from) return;
      const wanted = [...new Set((Array.isArray(msg.people) ? msg.people : []).map(String))].filter((p) => SLUG.test(p) && p !== from);
      const ok = wanted.filter((p) => areContacts(from, p) && allowed(p));
      const now = Date.now();
      db.prepare(`INSERT INTO relay_shares (id, owner, kind, title, allow_comments, allow_copy, people, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, allow_comments = excluded.allow_comments,
          allow_copy = excluded.allow_copy, people = excluded.people, updated_at = excluded.updated_at`)
        .run(id, from, clip(msg.kind, 20), title, msg.allowComments ? 1 : 0, msg.allowCopy ? 1 : 0, JSON.stringify(ok), old?.created_at ?? now, now);
      const share = shareRow(id);
      for (const p of (old?.people ?? []).filter((x) => !ok.includes(x))) {
        await revoke(share, p);
        log('share-removed', from, p, title);
      }
      for (const p of ok) {
        try {
          copySnapshot(from, p, id);
        } catch (e) {
          log('share-failed', from, p, title, e.message);
          continue;
        }
        if (!old?.people.includes(p)) log('shared', from, p, title, msg.kind);
        await deliver(p, { type: 'share-snapshot', from, name: nameOf(from), id });
      }
      const refused = wanted.filter((p) => !ok.includes(p));
      if (refused.length) await refuse('share-error', `“${title}” couldn’t be shared with ${refused.map(nameOf).join(', ')}: ${refused.length === 1 ? 'they aren’t' : 'they aren’t all'} contacts, or sharing is off for them.`);
      return;
    }
    case 'share-stop': {
      const share = shareRow(String(msg.id ?? ''));
      if (!share || share.owner !== from) return;
      for (const p of share.people) await revoke(share, p);
      db.prepare('DELETE FROM relay_shares WHERE id = ?').run(share.id);
      log('share-stopped', from, null, share.title);
      return;
    }
    case 'comment': {
      const share = shareRow(String(msg.shareId ?? ''));
      if (!share || !to || !allowed(from)) return;
      // Between the owner and someone it's shared with, either way; a new comment only where comments are on.
      const fromOwner = share.owner === from && share.people.includes(to);
      const toOwner = share.owner === to && share.people.includes(from) && share.allow_comments;
      if (!fromOwner && !toOwner) return;
      if (!areContacts(from, to)) return;
      log(fromOwner ? 'reply' : 'comment', from, to, share.title);
      return deliver(to, { type: 'comment', from, name: nameOf(from), shareId: share.id, comment: msg.comment });
    }
    case 'comment-resolve':
    case 'comment-delete': {
      const share = shareRow(String(msg.shareId ?? ''));
      if (!share || !to) return;
      if (!((share.owner === from && share.people.includes(to)) || (share.owner === to && share.people.includes(from)))) return;
      if (msg.type === 'comment-resolve' && share.owner !== from) return;
      return deliver(to, msg.type === 'comment-resolve'
        ? { type: 'comment-resolve', from, shareId: share.id, threadId: String(msg.threadId ?? ''), resolved: !!msg.resolved }
        : { type: 'comment-delete', from, shareId: share.id, id: String(msg.id ?? '') });
    }
    default:
  }
}

async function accept(from, to) {
  db.prepare('UPDATE relay_contacts SET status = ?, at = ? WHERE a = ? AND b = ?').run('accepted', Date.now(), ...pair(from, to));
  log('contact-accepted', from, to);
  await deliver(to, { type: 'contact-accepted', from, name: nameOf(from) });
  await deliver(from, { type: 'contact-accepted', from: to, name: nameOf(to) });
}

// ---------- the loops: one waiting request per tenant ----------

const loops = new Map(); // slug -> { stop }
const cursor = (slug) => db.prepare('SELECT seq FROM relay_cursors WHERE slug = ?').get(slug)?.seq ?? 0;
const setCursor = (slug, seq) => db.prepare('INSERT INTO relay_cursors (slug, seq) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET seq = excluded.seq').run(slug, seq);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function runLoop(slug, logger) {
  const state = { stop: false };
  (async () => {
    while (!state.stop) {
      const t = getTenant(slug);
      if (!t || t.status !== 'active') break;
      let messages;
      try {
        await sendHeld(t);
        ({ messages } = await control(t, 'GET', `/control/sharing/outbox?after=${cursor(slug)}&wait=${WAIT}`, undefined, { timeout: WAIT + 10_000 }));
      } catch {
        await pause(5000); // restarting, updating, or stopped
        continue;
      }
      for (const m of messages ?? []) {
        try { await handle(slug, m); } catch (e) { logger?.warn?.(`Sharing: ${m.type} from ${slug} failed: ${e.message}`); }
        setCursor(slug, m.seq);
      }
    }
    loops.delete(slug);
  })();
  return state;
}

/** Keeps one loop for each active tenant (checked every 10 seconds, so new tenants join). */
export function startSharingRelay(logger) {
  const sync = () => {
    const active = new Set(listTenants().filter((t) => t.status === 'active').map((t) => t.slug));
    for (const [slug, l] of loops) if (!active.has(slug)) { l.stop = true; loops.delete(slug); }
    for (const slug of active) if (!loops.has(slug)) loops.set(slug, runLoop(slug, logger));
  };
  sync();
  setInterval(sync, 10_000).unref();
}

// ---------- the console ----------

/** Turns sharing off (or on) for a tenant, and tells it. Turning it off ends what it shares and what's shared with it. */
export async function setSharing(slug, on) {
  const t = getTenant(slug);
  if (!t) throw httpError(404, 'No tenant by that name.');
  const off = sharingOff();
  if (on) off.delete(slug); else off.add(slug);
  saveCloud({ sharingOff: [...off] });
  log(on ? 'sharing-on' : 'sharing-off', slug);
  if (!on) {
    for (const s of db.prepare('SELECT * FROM relay_shares').all().map((r) => ({ ...r, people: json(r.people, []) }))) {
      if (s.owner === slug) {
        for (const p of s.people) await revoke(s, p);
        db.prepare('DELETE FROM relay_shares WHERE id = ?').run(s.id);
      } else if (s.people.includes(slug)) {
        await revoke(s, slug);
        db.prepare('UPDATE relay_shares SET people = ? WHERE id = ?').run(JSON.stringify(s.people.filter((p) => p !== slug)), s.id);
      }
    }
  }
  await pushSharingState(t).catch(() => {});
  return sharingOverview();
}

export const pushSharingState = (t) => control(t, 'POST', '/control/sharing/state', { on: !sharingOff().has(t.slug) }, { timeout: 5000 });

export function sharingOverview() {
  const off = sharingOff();
  const tenants = listTenants().map((t) => ({
    slug: t.slug, name: t.name || t.slug, on: !off.has(t.slug),
    contacts: db.prepare("SELECT COUNT(*) AS n FROM relay_contacts WHERE status = 'accepted' AND (a = ? OR b = ?)").get(t.slug, t.slug).n,
    pending: db.prepare("SELECT COUNT(*) AS n FROM relay_contacts WHERE status = 'pending' AND (a = ? OR b = ?)").get(t.slug, t.slug).n,
    sharing: db.prepare('SELECT COUNT(*) AS n FROM relay_shares WHERE owner = ?').get(t.slug).n,
    sharedWith: db.prepare('SELECT COUNT(*) AS n FROM relay_shares s, json_each(s.people) p WHERE p.value = ?').get(t.slug).n,
    held: db.prepare('SELECT COUNT(*) AS n FROM relay_held WHERE slug = ?').get(t.slug).n,
    connected: loops.has(t.slug),
  }));
  return {
    tenants,
    contacts: db.prepare('SELECT a, b, status, requested_by AS requestedBy, at FROM relay_contacts ORDER BY at DESC').all(),
    shares: db.prepare('SELECT id, owner, kind, title, people, allow_comments AS allowComments, allow_copy AS allowCopy, updated_at AS updatedAt FROM relay_shares ORDER BY updated_at DESC').all()
      .map((s) => ({ ...s, people: json(s.people, []), allowComments: !!s.allowComments, allowCopy: !!s.allowCopy })),
    log: db.prepare('SELECT * FROM relay_log ORDER BY id DESC LIMIT 200').all(),
  };
}

/** Removes a tenant from sharing (deleted): its contacts and shares, and what it shared from the others. */
export function forgetTenant(slug) {
  for (const s of db.prepare('SELECT * FROM relay_shares').all().map((r) => ({ ...r, people: json(r.people, []) }))) {
    if (s.owner === slug) {
      for (const p of s.people) { dropSnapshot(p, s.id); deliver(p, { type: 'share-revoked', from: slug, id: s.id }).catch(() => {}); }
      db.prepare('DELETE FROM relay_shares WHERE id = ?').run(s.id);
    } else if (s.people.includes(slug)) {
      db.prepare('UPDATE relay_shares SET people = ? WHERE id = ?').run(JSON.stringify(s.people.filter((p) => p !== slug)), s.id);
    }
  }
  for (const c of db.prepare('SELECT * FROM relay_contacts WHERE a = ? OR b = ?').all(slug, slug)) {
    const other = c.a === slug ? c.b : c.a;
    deliver(other, { type: 'contact-removed', from: slug }).catch(() => {});
  }
  db.prepare('DELETE FROM relay_contacts WHERE a = ? OR b = ?').run(slug, slug);
  db.prepare('DELETE FROM relay_held WHERE slug = ?').run(slug);
  db.prepare('DELETE FROM relay_cursors WHERE slug = ?').run(slug);
  log('tenant-removed', slug);
}
