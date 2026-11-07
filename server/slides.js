import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import QRCode from 'qrcode';
import { db, getSetting, setSetting, unlinkStorage } from './db.js';
import { config } from './config.js';
import { ART_IDS, COLOR_IDS, FONT_IDS, THEME_IDS } from '../shared/slideThemes.js';
import { broadcast } from './events.js';

/**
 * Slide decks for lessons and sermons. A deck belongs to its note and holds plain text only (the browser lays it out
 * and escapes it): a theme and the slides, each a title, point, passage, image, question or custom slide. Slides
 * built from the note's outline keep where they came from (`src`) and what they were built from (`gen`), so the
 * editor can tell when the note has changed since. `anchor` is the text of the place in the note that brings the
 * slide up while preaching or teaching.
 *
 * The phone remote: the window presenting a deck says where it is (PUT /api/slides/live), and the server passes that
 * to every open Selah window as a `slides` message; the remote's buttons come back the same way (`cmd`). Nothing of
 * it is stored: a presentation that stops saying where it is (closed, or the computer asleep) is over after a minute.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const clip = (v, n) => String(v ?? '').slice(0, n);

db.exec(`
CREATE TABLE IF NOT EXISTS slide_decks (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export const TYPES = ['title', 'point', 'passage', 'image', 'question', 'custom'];
const MAX_SLIDES = 300;

const point = (p) => ({ text: clip(p?.text, 1000), level: Math.max(0, Math.min(3, Number(p?.level) || 0)), anchor: clip(p?.anchor, 200) });
const gen = (g) => (g && typeof g === 'object' ? JSON.parse(clip(JSON.stringify(g), 8000)) : null);

/** A slide as it's kept: known fields only, text clipped. */
function cleanSlide(s, i) {
  if (!s || typeof s !== 'object') throw httpError(400, `Slide ${i + 1} isn't a slide`);
  if (!TYPES.includes(s.type)) throw httpError(400, `Slide ${i + 1} has an unknown type`);
  const out = {
    id: clip(s.id, 40) || `s${Date.now().toString(36)}${i}`,
    type: s.type,
    title: clip(s.title, 300),
    text: clip(s.text, 6000),
    anchor: clip(s.anchor, 200),
  };
  if (Array.isArray(s.points)) out.points = s.points.slice(0, 40).map(point);
  if (s.type === 'passage') out.ref = clip(s.ref, 200);
  if (s.type === 'question') out.answer = clip(s.answer, 4000);
  if (s.type === 'image') {
    out.image = Number.isInteger(s.image) && s.image > 0 ? s.image : null;
    out.fit = s.fit === 'cover' ? 'cover' : 'contain';
  }
  // 11.0: a passage's own translation, the slide's own art ('none' for none), a picture behind it, no logo.
  if (s.type === 'passage' && s.tr) out.tr = clip(s.tr, 20);
  if (s.art === 'none' || ART_IDS.includes(s.art)) out.art = s.art;
  if (Number.isInteger(s.bg) && s.bg > 0) out.bg = s.bg;
  if (s.logo === false) out.logo = false;
  if (s.notes) out.notes = clip(s.notes, 4000);
  if (s.src) out.src = clip(s.src, 80);
  if (s.gen) out.gen = gen(s.gen);
  if (s.kept) out.kept = clip(s.kept, 80);
  return out;
}

export function cleanDeck(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.slides)) throw httpError(400, 'Not a slide deck');
  if (d.slides.length > MAX_SLIDES) throw httpError(400, `A deck can have up to ${MAX_SLIDES} slides`);
  return {
    theme: THEME_IDS.includes(d.theme) ? d.theme : 'light',
    // 11.0: the deck's fonts and art (left out: the theme's own; art null: none), a picture behind every slide (with
    // how much it's darkened), its translation ('' = your favorite) and whether the brand logo shows.
    ...(FONT_IDS.includes(d.fonts) ? { fonts: d.fonts } : {}),
    // 11.0: colors from another theme, the brand or its own (custom: { bg, text, accent }); left out: the theme's.
    ...(COLOR_IDS.includes(d.colors) ? { colors: d.colors } : {}),
    ...(d.colors === 'custom' && d.custom && typeof d.custom === 'object'
      ? { custom: Object.fromEntries(['bg', 'text', 'accent'].filter((k) => /^#[0-9a-f]{6}$/i.test(d.custom[k] ?? '')).map((k) => [k, d.custom[k].toLowerCase()])) } : {}),
    ...(d.art === null || ART_IDS.includes(d.art) ? { art: d.art } : {}),
    ...(Number.isInteger(d.bg) && d.bg > 0 ? { bg: d.bg, dim: Math.max(0, Math.min(0.85, Number(d.dim) || 0)) } : {}),
    translation: clip(d.translation, 20),
    logo: d.logo !== false,
    kind: d.kind === 'sermon' ? 'sermon' : 'lesson',
    slides: d.slides.map(cleanSlide),
    // Outline items you chose not to make slides of (so they aren't offered again).
    dismissed: Array.isArray(d.dismissed) ? d.dismissed.slice(0, 500).map((x) => clip(x, 80)) : [],
  };
}

export function getDeck(noteId) {
  const row = db.prepare('SELECT data, updated_at FROM slide_decks WHERE note_id = ?').get(noteId);
  return row ? { deck: parseData(row.data), updated_at: row.updated_at } : { deck: null, updated_at: null };
}

/** The attachment ids a note's deck shows (so the attachment manager doesn't call them unused). */
export function deckImages(noteId) {
  const row = db.prepare('SELECT data FROM slide_decks WHERE note_id = ?').get(noteId);
  if (!row) return [];
  const d = parseData(row.data);
  return [d.bg, ...(d.slides ?? []).flatMap((s) => [s.image, s.bg])].filter(Boolean);
}


// ---------- 11.0: the church brand and the media library ----------

db.exec(`
CREATE TABLE IF NOT EXISTS slide_media (
  id INTEGER PRIMARY KEY,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
`);

const HEX = /^#[0-9a-f]{6}$/i;
const BASES = ['light', 'dark', 'color'];
const CORNERS = ['tr', 'tl', 'br', 'bl'];
/** The church brand (setting slide_brand): { name, primary, secondary, accent, base, fonts, art, logo, logoPos }. */
export function getBrand() {
  const b = parseData(getSetting('slide_brand') ?? '{}');
  if (b.logo && !db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(b.logo)) b.logo = null;
  return b;
}
function cleanBrand(b, cur) {
  const out = { ...cur };
  if ('name' in b) out.name = clip(b.name, 120);
  for (const k of ['primary', 'secondary', 'accent']) if (k in b) out[k] = HEX.test(b[k] ?? '') ? b[k].toLowerCase() : null;
  if ('base' in b) out.base = BASES.includes(b.base) ? b.base : 'light';
  if ('fonts' in b) out.fonts = FONT_IDS.includes(b.fonts) ? b.fonts : 'modern';
  if ('art' in b) out.art = ART_IDS.includes(b.art) ? b.art : null;
  if ('logoPos' in b) out.logoPos = CORNERS.includes(b.logoPos) ? b.logoPos : 'tr';
  return out;
}

/** The attachment ids the brand logo and the media library hold (files with no note, still in use). */
export function slideFiles() {
  const out = new Map(db.prepare('SELECT attachment_id FROM slide_media').all().map((r) => [r.attachment_id, 'Slide media']));
  const logo = parseData(getSetting('slide_brand') ?? '{}').logo;
  if (logo) out.set(logo, 'Church logo');
  return out;
}

/** An uploaded picture kept with no note: { id, filename, mime, size }. Pictures only. */
async function savePicture(req) {
  const file = await req.file({ limits: { fileSize: config.maxUpload } });
  if (!file) throw httpError(400, 'No file uploaded');
  const mime = (file.mimetype || '').toLowerCase();
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime)) { file.file.resume(); throw httpError(400, 'Choose a picture: PNG, JPEG, GIF, WebP or SVG.'); }
  const storage = crypto.randomBytes(16).toString('hex');
  const dest = path.join(config.filesDir, storage);
  try {
    await pipeline(file.file, fs.createWriteStream(dest));
    if (file.file.truncated) throw httpError(413, 'File is too large');
  } catch (err) {
    unlinkStorage([storage]);
    throw err;
  }
  const filename = path.basename(file.filename || 'picture').slice(0, 255);
  const size = fs.statSync(dest).size;
  const id = Number(db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (NULL, ?, ?, ?, ?, ?)')
    .run(filename, mime, size, storage, Date.now()).lastInsertRowid);
  return { id, filename, mime, size };
}
function dropFile(id) {
  const a = db.prepare('SELECT storage FROM attachments WHERE id = ? AND note_id IS NULL').get(id);
  if (!a) return;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  unlinkStorage([a.storage]);
}

// ---------- the phone remote ----------

const STALE = 60_000;
let live = null; // { note, index, step, black, count, title, mode, timer, at }
const current = () => (live && Date.now() - live.at < STALE ? live : null);
const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

export default async function slideRoutes(app) {
  app.get('/api/slides/live', async () => ({ live: current() }));

  // Body: { note, index, step, black, count, title, mode: 'preach' | 'teach' | 'present', timer: { start, acc, goal }, part }.
  app.put('/api/slides/live', async (req) => {
    const b = req.body ?? {};
    const note = intParam(b.note);
    const t = b.timer && typeof b.timer === 'object' ? b.timer : {};
    live = {
      note, index: num(b.index, 1000), step: num(b.step, 1000), black: !!b.black, count: num(b.count, 1000),
      title: clip(b.title, 300), mode: ['preach', 'teach', 'present'].includes(b.mode) ? b.mode : 'present',
      timer: { start: t.start ? num(t.start, 9e15) : null, acc: num(t.acc, 9e15), goal: t.goal ? num(t.goal, 600) : null },
      part: clip(b.part, 80), at: Date.now(),
    };
    broadcast({ slides: 'state', live });
    return { ok: true };
  });

  app.delete('/api/slides/live', async (req) => {
    if (live && (!req.query.note || Number(req.query.note) === live.note)) {
      broadcast({ slides: 'ended', note: live.note });
      live = null;
    }
    return { ok: true };
  });

  // Body: { note, cmd: 'next' | 'prev' | 'black' }: a remote's button, for the window presenting that note.
  app.post('/api/slides/live/command', async (req) => {
    const note = intParam(req.body?.note);
    const cmd = req.body?.cmd;
    if (!['next', 'prev', 'black'].includes(cmd)) throw httpError(400, 'Unknown command');
    if (!current() || current().note !== note) throw httpError(409, 'That isn’t being presented now');
    broadcast({ slides: 'cmd', note, cmd });
    return { ok: true };
  });

  // The remote's address as a QR code (SVG), for the phone's camera: this server as the browser reached it.
  app.get('/api/slides/remote-qr', async (req, reply) => {
    const host = String(req.headers.host ?? '').replace(/[^\w.:[\]-]/g, '');
    const url = `https://${host}/#remote`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, svg };
  });

  app.get('/api/slides/brand', async () => getBrand());
  app.put('/api/slides/brand', async (req) => {
    const b = cleanBrand(req.body ?? {}, getBrand());
    setSetting('slide_brand', JSON.stringify(b));
    return b;
  });
  app.post('/api/slides/brand/logo', async (req) => {
    const pic = await savePicture(req);
    const b = getBrand();
    if (b.logo) dropFile(b.logo);
    setSetting('slide_brand', JSON.stringify({ ...b, logo: pic.id }));
    return { ...b, logo: pic.id };
  });
  app.delete('/api/slides/brand/logo', async () => {
    const b = getBrand();
    if (b.logo) dropFile(b.logo);
    setSetting('slide_brand', JSON.stringify({ ...b, logo: null }));
    return { ...b, logo: null };
  });

  app.get('/api/slides/media', async () => db.prepare(`SELECT m.id, m.attachment_id, a.filename, a.mime, a.size, m.created_at
    FROM slide_media m JOIN attachments a ON a.id = m.attachment_id ORDER BY m.created_at DESC`).all());
  app.post('/api/slides/media', async (req) => {
    const pic = await savePicture(req);
    const now = Date.now();
    const id = Number(db.prepare('INSERT INTO slide_media (attachment_id, created_at) VALUES (?, ?)').run(pic.id, now).lastInsertRowid);
    return { id, attachment_id: pic.id, filename: pic.filename, mime: pic.mime, size: pic.size, created_at: now };
  });
  app.delete('/api/slides/media/:id', async (req) => {
    const m = db.prepare('SELECT attachment_id FROM slide_media WHERE id = ?').get(intParam(req.params.id));
    if (!m) throw httpError(404, 'Not in the media library');
    db.prepare('DELETE FROM slide_media WHERE id = ?').run(intParam(req.params.id));
    dropFile(m.attachment_id);
    return { ok: true };
  });

  app.get('/api/notes/:id/slides', async (req) => {
    const id = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw httpError(404, 'Note not found');
    return getDeck(id);
  });

  // Body: { deck: { theme, kind, slides, dismissed } }.
  app.put('/api/notes/:id/slides', async (req) => {
    const id = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL').get(id)) throw httpError(404, 'Note not found');
    const deck = cleanDeck(req.body?.deck);
    const has = (id) => !!db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id);
    for (const s of deck.slides) {
      if (s.image && !has(s.image)) s.image = null;
      if (s.bg && !has(s.bg)) delete s.bg;
    }
    if (deck.bg && !has(deck.bg)) { delete deck.bg; delete deck.dim; }
    const now = Date.now();
    db.prepare(`INSERT INTO slide_decks (note_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(note_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(id, JSON.stringify(deck), now, now);
    return { updated_at: now, deck };
  });

  app.delete('/api/notes/:id/slides', async (req) => {
    db.prepare('DELETE FROM slide_decks WHERE note_id = ?').run(intParam(req.params.id));
    return { ok: true };
  });
}
