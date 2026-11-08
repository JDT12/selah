import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { htmlToText } from './html.js';
import { writeZip } from './zip.js';
import { exportFile } from './export.js';
import { getBrand, getDeck } from './slides.js';
import { deckLook } from '../shared/slideThemes.js';
import { outlineMarker } from '../shared/outline.js';
import { syncFolders } from './desktopbackup.js';

/**
 * Export for iPad (12.2): one sermon, lesson or note as a .selahlesson package for Selah Companion. The format is in
 * docs/selahlesson-format.md. The window builds the text as blocks (it has Preach mode's delivery order, colors and
 * the Bible text); this adds what the library knows: the lesson's stable id and version, the pictures, the deck and
 * how it looks, and a readable copy, and zips it as a download or (Selah Desktop) into the export folder.
 *
 * Blocks keep ids in the note (data-bid) so notes written beside them on the iPad stay with them after the lesson is
 * changed and exported again; /block-ids gives any block without one its id before the window builds the blocks.
 */

const FORMAT = 1;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;

db.exec(`
CREATE TABLE IF NOT EXISTS lesson_exports (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  exported_at INTEGER NOT NULL
);
`);

// ---------- block ids ----------

// The blocks the editor keeps an id on (client/src/editor/extensions.js, BlockId), by their opening tags. Attribute
// values can hold a ">" (the browser doesn't escape it there), so quoted values are skipped whole.
const OPEN_TAG = /<(p|h[1-6]|li|blockquote|img|table|pre)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const BID = /\sdata-bid="([^"]*)"/i;
const newBid = () => `b${crypto.randomBytes(5).toString('hex')}`;

/** The note's HTML with an id on every block (a copied block's repeated id gets a new one). */
export function withBlockIds(html) {
  const seen = new Set();
  return String(html ?? '').replace(OPEN_TAG, (whole, tag, attrs) => {
    const m = BID.exec(attrs);
    if (m && m[1] && !seen.has(m[1])) { seen.add(m[1]); return whole; }
    const id = newBid();
    seen.add(id);
    const rest = m ? attrs.replace(BID, '') : attrs;
    const selfClose = /\/\s*$/.test(rest);
    return `<${tag}${selfClose ? rest.replace(/\/\s*$/, '') : rest} data-bid="${id}"${selfClose ? ' /' : ''}>`;
  });
}

// ---------- the package ----------

const MAX_BLOCKS = 20_000;
const ELEMENTS = new Set(['explanation', 'illustration', 'argumentation', 'application', 'other']);

/** Walks the window's blocks, counting them and handing each picture's attachment (src "att:ID") to `onImage`. */
function walkBlocks(blocks, onImage, depth = 0, count = { n: 0 }) {
  if (!Array.isArray(blocks)) return;
  if (depth > 40) throw httpError(400, 'The text is nested too deeply to export.');
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (++count.n > MAX_BLOCKS) throw httpError(400, 'The text is too long to export.');
    if (b.type === 'image' && typeof b.src === 'string') {
      const m = /^att:(\d+)$/.exec(b.src);
      b.src = m ? onImage(Number(m[1])) : null;
    }
    if (b.type === 'element' && !ELEMENTS.has(b.element)) b.element = 'other';
    walkBlocks(b.children, onImage, depth + 1, count);
    if (Array.isArray(b.items)) for (const it of b.items) walkBlocks(it?.children, onImage, depth + 1, count);
  }
}

/** The package's pictures: attachment id -> { path, file, mime, bytes }, added as they're asked for. */
function mediaSet() {
  const byId = new Map();
  const pending = [];
  const ask = (id) => {
    if (!id) return null;
    if (byId.has(id)) return byId.get(id).path;
    const a = db.prepare('SELECT id, filename, mime, size, storage FROM attachments WHERE id = ?').get(id);
    if (!a) return null;
    const ext = (path.extname(a.filename).toLowerCase().replace(/^\.(heic|heif)$/, '.jpg') || '.bin').replace(/[^.a-z0-9]/g, '');
    const entry = { path: `media/${a.id}${ext}`, a };
    byId.set(id, entry);
    pending.push(entry);
    return entry.path;
  };
  /** The zip entries and the manifest's list (HEIC photos go as their JPEG copy). */
  const resolve = async () => {
    const out = [];
    for (const e of pending) {
      const f = await exportFile(e.a);
      if (!fs.existsSync(f.file)) continue;
      out.push({ name: e.path, file: f.file, mime: f.mime, bytes: fs.statSync(f.file).size });
    }
    return out;
  };
  return { ask, resolve };
}

/** The deck for Companion: as kept, with its look worked out and its pictures as media paths. */
function deckOut(noteId, media, { art, arts = {}, slideBlocks }) {
  const { deck } = getDeck(noteId);
  if (!deck?.slides?.length) return null;
  const brand = getBrand();
  const look = deckLook(deck, brand);
  // As in Selah, the church logo goes on slides in the church's own theme.
  const logo = deck.logo === false || deck.theme !== 'brand' ? null : brand.logo ? { src: media.ask(brand.logo), corner: brand.logoPos ?? 'tr' } : null;
  const blocks = slideBlocks && typeof slideBlocks === 'object' ? slideBlocks : {};
  return {
    kind: deck.kind ?? null,
    look: {
      palette: look.palette,
      fonts: { id: look.fonts.id, head: look.fonts.head.family, body: look.fonts.body.family, headWeight: look.fonts.head.weight, headItalic: look.fonts.head.style === 'italic', headUpper: !!look.fonts.head.upper },
      art: art ? 'media/art.png' : null,
      artKind: look.art,
      arts: Object.fromEntries(Object.entries(arts).map(([id, a]) => [id, { src: `media/art-${id}.png`, texture: a.texture }])),
      background: deck.bg ? media.ask(deck.bg) : null,
      dim: typeof deck.dim === 'number' ? deck.dim : null,
      logo: logo?.src ? logo : null,
    },
    translation: deck.translation ?? null,
    slides: deck.slides.map((s) => ({
      ...s,
      image: s.image ? media.ask(s.image) : null,
      bg: s.bg ? media.ask(s.bg) : null,
      block: typeof blocks[s.id] === 'string' ? blocks[s.id].slice(0, 40) : null,
    })),
  };
}

// ---------- the readable copy ----------

const mdEsc = (t) => String(t ?? '').replace(/([\\`*_[\]#])/g, '\\$1');
function runsMd(runs) {
  return (Array.isArray(runs) ? runs : []).map((r) => {
    if (r?.br) return '  \n';
    const raw = mdEsc(r?.text ?? '');
    if (!raw.trim()) return raw;
    // Markers go around the words, the spaces either side outside them ("**Verses:** ", not "**Verses: **").
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    let t = core;
    if (r.code) t = `\`${String(r.text).trim().replace(/`/g, '')}\``;
    if (r.b) t = `**${t}**`;
    if (r.i) t = `*${t}*`;
    if (r.s) t = `~~${t}~~`;
    if (r.link && /^https?:/i.test(r.link)) t = `[${t}](${r.link})`;
    return `${lead}${t}${tail}`;
  }).join('');
}
function blocksMd(blocks, indent = '', depth = 0) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b) continue;
    switch (b.type) {
      case 'section': out.push(`${'#'.repeat(Math.min(6, (b.level ?? 1) + 1))} ${mdEsc(b.title)}`, '', ...blocksMd(b.children, indent, depth)); break;
      case 'element': out.push(...(b.label ? [`${indent}*${mdEsc(b.label)}*`, ''] : []), ...blocksMd(b.children, indent, depth)); break;
      case 'heading': out.push(`${'#'.repeat(Math.min(6, (b.level ?? 3) + 1))} ${runsMd(b.runs)}`, ''); break;
      case 'paragraph': out.push(`${indent}${runsMd(b.runs)}`, ''); break;
      case 'quote': {
        const lines = blocksMd(b.children, '', depth);
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        out.push(...lines.map((l) => `${indent}> ${l}`.trimEnd()), '');
        break;
      }
      case 'image': if (b.src) out.push(`${indent}![${mdEsc(b.alt ?? '')}](${b.src})`, ''); break;
      case 'code': out.push('```', String(b.text ?? ''), '```', ''); break;
      case 'rule': out.push('---', ''); break;
      case 'file': out.push(`${indent}(Attachment: ${mdEsc(b.name)})`, ''); break;
      case 'table': {
        const rows = Array.isArray(b.rows) ? b.rows : [];
        rows.forEach((row, i) => {
          out.push(`| ${(row ?? []).map((c) => runsMd(c?.runs).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`);
          if (i === 0) out.push(`|${(row ?? []).map(() => ' --- ').join('|')}|`);
        });
        out.push('');
        break;
      }
      case 'list': {
        let n = Number(b.start) || 1;
        for (const it of Array.isArray(b.items) ? b.items : []) {
          const mark = b.ordered ? outlineMarker(depth, n++) : typeof it?.checked === 'boolean' ? `- [${it.checked ? 'x' : ' '}]` : '-';
          const lines = blocksMd(it?.children, `${indent}   `, depth + (b.ordered ? 1 : 0)).filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
          const first = lines.findIndex((l) => l.trim());
          const label = it?.label ? `*${mdEsc(it.label)}* ` : '';
          if (first < 0) { out.push(`${indent}${mark} ${label}`.trimEnd()); continue; }
          out.push(`${indent}${mark} ${label}${lines[first].trim()}`, ...lines.slice(first + 1).filter(Boolean));
        }
        out.push('');
        break;
      }
      default: break;
    }
  }
  return out;
}
function readme(manifest, content) {
  const sub = [manifest.passage, manifest.series?.title, manifest.course?.title, manifest.date].filter(Boolean).join(' · ');
  const lines = [`# ${mdEsc(manifest.title)}`, ''];
  if (sub) lines.push(`*${mdEsc(sub)}*`, '');
  lines.push(...blocksMd(content.manuscript));
  const copy = manifest.bible?.copyright ?? [];
  if (copy.length) lines.push('---', '', ...copy.map((c) => `${mdEsc(c)}  `), '');
  lines.push('', `*Exported from Selah ${VERSION} for Selah Companion (package version ${manifest.version}).*`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- metadata ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEPS = [['hook', 'Hook'], ['book', 'Book'], ['look', 'Look'], ['took', 'Took']];

/** The manifest's metadata, from what the window sends ({ kind, passage, ... }), checked and trimmed. */
function cleanMeta(m = {}, note) {
  const kind = ['sermon', 'lesson', 'note'].includes(m.kind) ? m.kind : 'note';
  const num = (v) => (Number(v) > 0 ? Math.min(600, Math.round(Number(v))) : null);
  const steps = kind === 'lesson' && m.steps && typeof m.steps === 'object'
    ? STEPS.map(([key, label]) => ({ key, label, minutes: num(m.steps[key]) })) : null;
  const log = (Array.isArray(m.log) ? m.log : []).slice(0, 200).map((p) => ({
    date: DATE.test(p?.date ?? '') ? p.date : null,
    place: clip(p?.place, 200), occasion: clip(p?.occasion, 200), minutes: num(p?.minutes), notes: clip(p?.notes, 4000),
  }));
  return {
    kind,
    title: clip(note.title || 'Untitled', 500),
    passage: clip(m.passage, 200) || null,
    series: m.series?.title ? { title: clip(m.series.title, 200), color: /^#[0-9a-f]{6}$/i.test(m.series.color ?? '') ? m.series.color : null } : null,
    course: m.course?.title ? { title: clip(m.course.title, 200), week: num(m.course.week) } : null,
    date: DATE.test(m.date ?? '') ? m.date : null,
    goalMinutes: num(m.goalMinutes),
    steps,
    tags: db.prepare('SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name').all(note.id).map((t) => t.name),
    status: ['building', 'ready', 'planned', 'taught'].includes(m.status) ? m.status : null,
    method: clip(m.method, 40) || null,
    author: clip(m.author, 200) || '',
    log,
    bible: {
      mode: m.bible?.mode === 'text' ? 'text' : 'refs',
      translations: (Array.isArray(m.bible?.translations) ? m.bible.translations : []).slice(0, 10).map((t) => clip(t, 40)),
      copyright: (Array.isArray(m.bible?.copyright) ? m.bible.copyright : []).slice(0, 10).map((t) => clip(t, 2000)),
    },
  };
}

/** The lesson's stable id and the version for this export (a new version when the content changed). */
function versionFor(noteId, hash) {
  const row = db.prepare('SELECT uid, version, hash FROM lesson_exports WHERE note_id = ?').get(noteId);
  const uid = row?.uid ?? crypto.randomUUID();
  const version = !row ? 1 : row.hash === hash ? row.version : row.version + 1;
  db.prepare(`INSERT INTO lesson_exports (note_id, uid, version, hash, exported_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET version = excluded.version, hash = excluded.hash, exported_at = excluded.exported_at`).run(noteId, uid, version, hash, Date.now());
  return { uid, version };
}

/** The package's file name: the title, safe on Windows, macOS and iPadOS. */
export const packageName = (title) => `${String(title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Untitled'}.selahlesson`;

/** Builds the package's zip entries and manifest. */
async function buildPackage(noteId, body) {
  const note = db.prepare('SELECT id, title FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId);
  if (!note) throw httpError(404, 'Note not found');
  const c = body?.content;
  if (!c || !Array.isArray(c.manuscript)) throw httpError(400, 'Nothing to export.');
  const media = mediaSet();
  walkBlocks(c.manuscript, media.ask);
  if (c.outline != null) walkBlocks(c.outline, media.ask);
  const content = {
    manuscript: c.manuscript,
    outline: Array.isArray(c.outline) ? c.outline : null,
    passages: c.passages && typeof c.passages === 'object' && !Array.isArray(c.passages) ? c.passages : {},
  };
  const png = (v) => (typeof v === 'string' && v.startsWith('data:image/png;base64,') ? Buffer.from(v.slice(22), 'base64') : null);
  const art = png(body.art);
  // Each art the slides show, by its id: media/art-<id>.png.
  const arts = {};
  if (body.arts && typeof body.arts === 'object') {
    for (const [id, a] of Object.entries(body.arts).slice(0, 20)) {
      const data = png(a?.png);
      if (/^[a-z0-9-]{1,30}$/.test(id) && data) arts[id] = { data, texture: !!a.texture };
    }
  }
  const deck = body.slides === false ? null : deckOut(noteId, media, { art, arts, slideBlocks: body.slideBlocks });
  const meta = cleanMeta(body.meta, note);

  const contentJson = JSON.stringify(content);
  const deckJson = deck ? JSON.stringify(deck) : null;
  const hash = crypto.createHash('sha256').update(contentJson).update('\n').update(deckJson ?? '').update('\n').update(JSON.stringify(meta)).digest('hex');
  const { uid, version } = versionFor(noteId, hash);
  const files = await media.resolve();
  if (art && deck) files.push({ name: 'media/art.png', data: art, mime: 'image/png', bytes: art.length });
  if (deck) for (const [id, a] of Object.entries(arts)) files.push({ name: `media/art-${id}.png`, data: a.data, mime: 'image/png', bytes: a.data.length });
  const manifest = {
    format: FORMAT, id: uid, version, hash, exportedAt: new Date().toISOString(),
    selah: { version: VERSION, edition: config.edition === 'desktop' ? 'desktop' : 'cloud' },
    ...meta,
    files: { content: 'content.json', deck: deck ? 'deck.json' : null, readme: 'README.md' },
    media: files.map((f) => ({ path: f.name, mime: f.mime, bytes: f.bytes })),
  };
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'content.json', data: Buffer.from(contentJson) },
    ...(deckJson ? [{ name: 'deck.json', data: Buffer.from(deckJson) }] : []),
    { name: 'README.md', data: Buffer.from(readme(manifest, content)) },
    ...files.map((f) => (f.data ? { name: f.name, data: f.data } : { name: f.name, file: f.file })),
  ];
  return { entries, manifest, name: packageName(note.title) };
}

// ---------- the export folder (Selah Desktop) ----------

const folderState = () => { try { return JSON.parse(getSetting('ipad_export') ?? '{}') ?? {}; } catch { return {}; } };
/** "Selah for iPad" in the first sync folder (iCloud Drive, OneDrive…), where the iPad's Files app can reach it. */
function suggestedFolder() {
  const all = syncFolders();
  const base = (all.find((f) => f.name === 'iCloud Drive') ?? all[0])?.path ?? path.join(os.homedir(), 'Documents');
  return path.join(base, 'Selah for iPad');
}
function checkFolder(folder) {
  if (!folder || !path.isAbsolute(String(folder))) throw httpError(400, 'Choose a folder.');
  const p = path.resolve(String(folder));
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.selah-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw httpError(400, `Selah can’t write to that folder (${e.code ?? e.message}).`);
  }
  return p;
}

const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export default async function lessonExport(app) {
  // Gives every block of the note an id (kept in the note; nothing else changes). { html, updated_at, changed }.
  app.post('/api/notes/:id/block-ids', async (req) => {
    const id = intParam(req.params.id);
    const note = db.prepare('SELECT html, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!note) throw httpError(404, 'Note not found');
    const html = withBlockIds(note.html);
    if (html === note.html) return { html, updated_at: note.updated_at, changed: false };
    const at = Math.max(Date.now(), note.updated_at + 1);
    db.prepare('UPDATE notes SET html = ?, text = ?, updated_at = ? WHERE id = ?').run(html, htmlToText(html), at, id);
    return { html, updated_at: at, changed: true };
  });

  // What the last export was: { id, version, exported_at } or null.
  app.get('/api/notes/:id/ipad-export', async (req) => {
    const row = db.prepare('SELECT uid, version, exported_at FROM lesson_exports WHERE note_id = ?').get(intParam(req.params.id));
    return row ? { id: row.uid, version: row.version, exported_at: row.exported_at } : null;
  });

  /**
   * The package. Body: { content, meta, art?, slideBlocks?, slides?, save?: 'download' | 'folder' }. A download
   * streams the zip; 'folder' (Selah Desktop) writes it into the export folder (replacing the lesson's earlier
   * file of the same name) and returns { file, folder, version }.
   */
  app.post('/api/notes/:id/ipad-export', async (req, reply) => {
    const id = intParam(req.params.id);
    const { entries, manifest, name } = await buildPackage(id, req.body ?? {});
    if (req.body?.save === 'folder') {
      if (config.edition !== 'desktop') throw httpError(400, 'Saving into a folder is for Selah Desktop.');
      const folder = checkFolder(folderState().folder);
      const part = path.join(folder, `.${name}.part`);
      try {
        const file = fs.createWriteStream(part);
        const closed = new Promise((resolve, reject) => { file.once('close', resolve); file.once('error', reject); });
        await writeZip(file, entries);
        await closed; // written to the disk before it takes its name
        fs.renameSync(part, path.join(folder, name));
      } catch (e) {
        fs.rmSync(part, { force: true });
        throw httpError(400, `Couldn’t save the file: ${e.message}`);
      }
      return { file: name, folder, version: manifest.version, id: manifest.id };
    }
    const out = new PassThrough();
    writeZip(out, entries).catch((e) => out.destroy(e));
    reply.header('Content-Type', 'application/vnd.selah.lesson+zip');
    reply.header('Content-Disposition', disposition(name));
    reply.header('X-Selah-Version', String(manifest.version));
    return reply.send(out);
  });

  // The export folder (Selah Desktop): { folder, suggested, desktop }.
  app.get('/api/ipad-export/settings', async () => ({
    desktop: config.edition === 'desktop',
    folder: config.edition === 'desktop' ? folderState().folder ?? null : null,
    suggested: config.edition === 'desktop' ? suggestedFolder() : null,
  }));
  app.put('/api/ipad-export/settings', async (req) => {
    if (config.edition !== 'desktop') throw httpError(400, 'The export folder is for Selah Desktop.');
    const folder = req.body?.folder ? checkFolder(req.body.folder) : null;
    setSetting('ipad_export', JSON.stringify({ ...folderState(), folder }));
    return { folder };
  });
}
