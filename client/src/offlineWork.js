import { api } from './api.js';
import { bibleConnected, biblePassage, passageCardHtml } from './esv.js';
import { deliveryHtml, isSermonHtml } from './sermonBoard.js';
import { preachHtml } from './components/PreachMode.jsx';
import { deckKind, md, newDeck, passagePages, slideTr } from './slides.js';
import { deckSource } from './components/PresentMode.jsx';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Bumped when what's saved changes shape, so everything saved before is built again.
const FORMAT = 3;
import { deckLook, loadBrand } from './slideLook.js';

/**
 * 13.0: what the app saves so a sermon or lesson can be delivered with no connection: the ones on the calendar in the
 * next four weeks and the most recent, laid out as Preach and Teach show them, with their slides and Bible text.
 * mobile-app/www/shell.js shows them. Everything is rendered here because that page can't reach the server.
 */
const AHEAD_DAYS = 28;
const MOST_UPCOMING = 14;
const MOST_RECENT = 6;
const MAX_VERSES = 500; // per sermon or lesson, as for the iPad export (the publishers' quoting limits)
const MAX_PICTURE = 2 * 1024 * 1024;
const MAX_PICTURES = 15 * 1024 * 1024;

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Which work to keep: upcoming first (soonest first), then the most recently edited. */
export function pickOfflineWork(rows, today) {
  const work = rows.filter((r) => r.kind === 'sermon' || r.kind === 'lesson');
  const last = addDays(today, AHEAD_DAYS);
  const upcoming = work.filter((r) => r.date && r.date >= today && r.date <= last).sort((a, b) => a.date.localeCompare(b.date)).slice(0, MOST_UPCOMING);
  const chosen = new Set(upcoming.map((r) => r.note_id));
  const recent = work.filter((r) => !chosen.has(r.note_id)).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, MOST_RECENT);
  return [...upcoming, ...recent];
}

function signature(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}.${h}`;
}

const asDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

async function pictureOf(id, budget) {
  try {
    const res = await fetch(`/api/files/${id}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_PICTURE || blob.size > budget.left) return null;
    budget.left -= blob.size;
    return await asDataUrl(blob);
  } catch { return null; }
}

/** Fetches passages until the verse limit; one that fails is left out. */
function passageReader(connected) {
  let verses = 0;
  const known = new Map();
  return async (ref, tr = '') => {
    const key = `${tr}|${ref}`;
    if (known.has(key)) return known.get(key);
    if (!connected || verses >= MAX_VERSES) return null;
    let out = null;
    try {
      const p = await biblePassage(ref, tr);
      const count = (p.text.match(/\[\d+\]/g) ?? []).length || 1;
      if (verses + count <= MAX_VERSES) {
        verses += count;
        out = { reference: p.reference, translation: p.translation ?? '', html: passageCardHtml(p.text), text: p.text };
      }
    } catch { /* a reference the translation doesn't have */ }
    known.set(key, out);
    return out;
  };
}

async function slidesOf(deck, passage, budget) {
  const out = [];
  for (const s of deck?.slides ?? []) {
    const slide = { type: s.type, title: s.title ?? '', html: s.text?.trim() ? md(s.text) : '', notes: s.notes ?? '', answer: s.answer ?? '' };
    slide.points = (s.points ?? []).filter((p) => p.text.trim()).map((p) => ({ level: p.level, html: md(p.text) }));
    if (s.type === 'passage' && s.ref?.trim()) {
      slide.ref = s.ref.trim();
      const p = await passage(slide.ref, slideTr(s, deck));
      // As the slides show it online: a verse a page (a long verse over several), each page a slide of its own.
      const pages = passagePages(p?.text);
      if (pages.length) {
        for (const pg of pages) {
          const where = pg.verse ? ` · verse ${pg.verse}${pg.parts > 1 ? ` (${pg.part} of ${pg.parts})` : ''}` : '';
          out.push({ ...slide, passage: { reference: p.reference, html: `<div class="slide-passage">${pg.html}<p class="sl-credit">${esc(p.translation || 'Bible')}${where}</p></div>` } });
        }
        continue;
      }
      slide.passage = p ? { reference: p.reference, html: p.html } : null;
    }
    if (s.type === 'image' && s.image) slide.picture = await pictureOf(s.image, budget);
    out.push(slide);
  }
  return out;
}

async function packetOf(row, old, ctx) {
  const [note, slides] = await Promise.all([api.getNote(row.note_id), api.slides(row.note_id).catch(() => null)]);
  let deck = slides?.deck?.slides?.length ? slides.deck : null;
  // Slides never opened yet: made from the outline here as Preach would (not saved; Preach saves them when it opens).
  if (!slides?.deck) {
    const sermonRow = row.kind === 'sermon' ? await api.noteSermon(row.note_id).catch(() => null) : null;
    const kind = deckKind(note.html, { sermon: sermonRow });
    if (kind) deck = newDeck(kind, await deckSource(note, sermonRow).catch(() => ({ title: note.title, html: note.html, passage: row.passage ?? '' })));
  }
  const sig = signature(`${FORMAT}|${note.updated_at}|${JSON.stringify(slides?.deck ?? null)}|${JSON.stringify(ctx.brand)}|${ctx.connected}`);
  const listing = { id: row.note_id, kind: row.kind, title: note.title || row.title || '', passage: row.passage ?? '', series: row.series ?? '', date: row.date ?? null };
  if (old?.sig === sig) {
    ctx.budget.left -= old.pictures ?? 0;
    return { ...old, ...listing };
  }
  const [sermon, lesson] = await Promise.all([
    row.kind === 'sermon' ? api.noteSermon(row.note_id).catch(() => null) : null,
    row.kind === 'lesson' ? api.lesson(row.note_id).catch(() => null) : null,
  ]);
  const html = preachHtml(isSermonHtml(note.html) ? deliveryHtml(note.html, {}) : note.html);
  const passage = passageReader(ctx.connected);
  const verses = {};
  const refs = new Set(['', ...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.pm-ref')].map((el) => el.dataset?.ref).filter(Boolean));
  for (const ref of refs) {
    const p = await passage(ref);
    if (p) verses[ref] = { reference: p.reference, translation: p.translation, html: p.html };
  }
  const before = ctx.budget.left;
  const list = await slidesOf(deck, passage, ctx.budget);
  const look = deck ? deckLook(deck, ctx.brand).palette : null;
  return {
    ...listing, sig, html, verses, slides: list, pictures: before - ctx.budget.left,
    colors: look ? { bg: look.bg, bg2: look.bg2, head: look.head, text: look.text, accent: look.accent } : null,
    minutes: Number(row.kind === 'sermon' ? sermon?.data?.minutes : lesson?.study?.classMinutes) || null,
  };
}

/** The packets for this device. `old` is what's saved now: anything unchanged is reused, and one that fails is kept. */
export async function buildOfflineWork(today, old = []) {
  const chosen = pickOfflineWork(await api.work(), today);
  const before = new Map(old.map((w) => [w.id, w]));
  const ctx = { brand: await loadBrand(true), connected: await bibleConnected().catch(() => false), budget: { left: MAX_PICTURES } };
  const out = [];
  for (const row of chosen) {
    try {
      out.push(await packetOf(row, before.get(row.note_id), ctx));
    } catch {
      if (before.has(row.note_id)) out.push(before.get(row.note_id));
    }
  }
  return out;
}
