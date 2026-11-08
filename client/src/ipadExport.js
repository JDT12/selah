import { api } from './api.js';
import { findReferences } from '../../shared/scripture.js';
import { deliveryHtml, hasDeliveryOrder, isSermonHtml } from './sermonBoard.js';
import { PARTS } from './lesson.js';
import { bibleConnected, biblePassage } from './esv.js';
import { anchorElements, findAnchor } from './slides.js';
import { deckLook, loadBrand } from './slideLook.js';
import { artPng, isTexture } from './slideArt.js';

/**
 * Export for iPad (12.2): a sermon, lesson or note as the blocks of a .selahlesson package (docs/selahlesson-format.md)
 * for Selah Companion. The text is laid out as Preach and Teach modes show it (a sermon in delivery order, its
 * elements marked for color coding), with the Bible text of its references when asked; the server adds the stable id,
 * version, pictures and deck, and zips it.
 */

const MAX_VERSES = 500; // the most verse text one package carries (the publishers' quoting limits)
const STYLE = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', S: 's', DEL: 's', STRIKE: 's', CODE: 'code', MARK: 'mark', SUP: 'sup', SUB: 'sub' };
const FLAGS = ['b', 'i', 'u', 's', 'code', 'mark', 'sup', 'sub', 'ref', 'link'];
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const isList = (n) => n?.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL');
const bidOf = (el) => el?.getAttribute?.('data-bid') || null;

// ---------- runs ----------

function addRun(out, text, st) {
  if (!text) return;
  const r = { text };
  for (const f of FLAGS) if (st[f]) r[f] = st[f];
  const last = out[out.length - 1];
  if (last && !last.br && FLAGS.every((f) => last[f] === r[f])) last.text += text;
  else out.push(r);
}
function pushText(out, raw, st) {
  const text = raw.replace(/\s+/g, ' ');
  if (!text) return;
  if (st.ref || st.code) { addRun(out, text, st); return; }
  let at = 0;
  for (const f of findReferences(text)) {
    addRun(out, text.slice(at, f.from), st);
    addRun(out, f.text, { ...st, ref: f.text });
    at = f.to;
  }
  addRun(out, text.slice(at), st);
}
/** Inline nodes as runs (pictures, lists and element labels are left to the blocks). */
function runsOf(nodes, st = {}, out = []) {
  for (const n of nodes) {
    if (n.nodeType === 3) { pushText(out, n.textContent, st); continue; }
    if (n.nodeType !== 1) continue;
    if (n.tagName === 'BR') { out.push({ br: true }); continue; }
    if (n.tagName === 'IMG' || isList(n) || n.hasAttribute('data-element-label') || n.hasAttribute('data-attachment')) continue;
    let s = st;
    if (STYLE[n.tagName]) s = { ...s, [STYLE[n.tagName]]: true };
    if (n.tagName === 'A') {
      const text = n.textContent.trim();
      const found = findReferences(text);
      if (found.length === 1 && found[0].text.length >= text.length - 2) s = { ...s, ref: found[0].text };
      else if (/^https?:/i.test(n.getAttribute('href') ?? '')) s = { ...s, link: n.getAttribute('href') };
    }
    runsOf(n.childNodes, s, out);
  }
  return out;
}
/** Runs without the spaces at either end (and none at all when there's no text). */
function trimRuns(runs) {
  while (runs.length && (runs[0].br || !runs[0].text.trim())) runs.shift();
  while (runs.length && (runs[runs.length - 1].br || !runs[runs.length - 1].text.trim())) runs.pop();
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
  }
  return runs;
}

// ---------- blocks ----------

const imageBlock = (img) => {
  const m = /\/api\/files\/(\d+)/.exec(img.getAttribute('src') ?? '');
  return m ? { type: 'image', id: bidOf(img), src: `att:${m[1]}`, alt: img.getAttribute('alt') ?? '' } : null;
};

function listBlock(list) {
  const task = list.getAttribute('data-type') === 'taskList';
  const items = [];
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const labelEl = li.querySelector(':scope > [data-element-label], :scope > p > [data-element-label], :scope > div > p > [data-element-label]');
    const item = { id: bidOf(li), children: blocksOf([...li.childNodes]) };
    if (li.hasAttribute('data-element')) {
      item.element = li.getAttribute('data-element');
      item.label = labelEl?.textContent.trim() || null;
    }
    if (task) item.checked = li.getAttribute('data-checked') === 'true';
    items.push(item);
  }
  const start = Number(list.getAttribute('start')) || 1;
  return { type: 'list', ordered: list.tagName === 'OL', start, items };
}

/** A run of nodes as blocks; loose inline nodes (text in a list item, say) become a paragraph. */
function blocksOf(nodes) {
  const out = [];
  let loose = [];
  const flush = () => {
    const runs = trimRuns(runsOf(loose));
    if (runs.length) out.push({ type: 'paragraph', id: null, runs });
    loose = [];
  };
  for (const n of nodes) {
    if (n.nodeType === 3 || (n.nodeType === 1 && /^(STRONG|B|EM|I|U|S|DEL|CODE|MARK|SUP|SUB|A|SPAN|BR)$/.test(n.tagName) && !n.hasAttribute('data-element-label'))) {
      loose.push(n);
      continue;
    }
    flush();
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (n.hasAttribute('data-element-label')) continue;
    if (tag === 'P') {
      const runs = trimRuns(runsOf(n.childNodes));
      if (runs.length) out.push({ type: 'paragraph', id: bidOf(n), runs });
      for (const img of n.querySelectorAll('img')) { const b = imageBlock(img); if (b) out.push(b); }
    } else if (/^H[1-6]$/.test(tag)) {
      const runs = trimRuns(runsOf(n.childNodes));
      if (runs.length) out.push({ type: 'heading', id: bidOf(n), level: Math.max(3, Number(tag[1])), runs });
    } else if (isList(n)) {
      const l = listBlock(n);
      if (l.items.length) out.push(l);
    } else if (tag === 'BLOCKQUOTE') {
      out.push({ type: 'quote', id: bidOf(n), children: blocksOf([...n.childNodes]) });
    } else if (tag === 'IMG') {
      const b = imageBlock(n);
      if (b) out.push(b);
    } else if (tag === 'TABLE') {
      const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => ({ runs: trimRuns(runsOf(td.childNodes.length === 1 && td.firstElementChild?.tagName === 'P' ? td.firstElementChild.childNodes : td.childNodes)), ...(td.tagName === 'TH' ? { header: true } : {}) })));
      if (rows.length) out.push({ type: 'table', id: bidOf(n), rows });
    } else if (tag === 'PRE') {
      out.push({ type: 'code', id: bidOf(n), text: n.textContent });
    } else if (tag === 'HR') {
      out.push({ type: 'rule' });
    } else if (n.hasAttribute('data-attachment')) {
      out.push({ type: 'file', id: null, name: n.getAttribute('data-filename') || 'Attachment' });
    } else if (n.hasAttribute('data-element')) {
      const label = n.querySelector(':scope > [data-element-label]')?.textContent.trim() || null;
      const children = blocksOf([...n.childNodes]);
      if (children.length) out.push({ type: 'element', element: n.getAttribute('data-element'), label, children });
    } else if (n.hasAttribute('data-drawing')) {
      out.push({ type: 'file', id: null, name: 'Drawing' });
    } else {
      out.push(...blocksOf([...n.childNodes])); // a wrapper (details, a callout, the delivery list)
    }
  }
  flush();
  return out;
}

/** The note's HTML as blocks, each Heading 1 and 2 a section holding what follows it (as Preach mode folds them). */
export function contentBlocks(html, { lesson = false, headingIds = null } = {}) {
  const body = doc(html);
  const root = { children: [] };
  const stack = [{ level: 0, node: root, pending: [] }];
  const flushTop = () => {
    const top = stack[stack.length - 1];
    if (top.pending.length) top.node.children.push(...blocksOf(top.pending));
    top.pending = [];
  };
  for (const n of [...body.childNodes]) {
    const m = n.nodeType === 1 && /^H([12])$/.exec(n.tagName);
    if (!m) { stack[stack.length - 1].pending.push(n); continue; }
    flushTop();
    const level = Number(m[1]);
    while (stack[stack.length - 1].level >= level) { stack.pop(); flushTop(); }
    const title = n.textContent.replace(/\s+/g, ' ').trim();
    // The sermon layout writes its headings again (without their ids): those come from the note by their text.
    const sec = { type: 'section', id: bidOf(n) ?? headingIds?.get(`${level}|${title}`) ?? null, level, title, children: [] };
    if (lesson && level === 1) {
      const step = PARTS.find((x) => x.match.test(title))?.key;
      if (step) sec.step = step;
    }
    stack[stack.length - 1].node.children.push(sec);
    stack.push({ level, node: sec, pending: [] });
  }
  while (stack.length) { flushTop(); stack.pop(); }
  // A lesson's Look: its first list is the questions (the lines under each are answers).
  if (lesson) {
    const look = root.children.find((b) => b.type === 'section' && b.step === 'look');
    const list = look?.children.find((b) => b.type === 'list');
    list?.items.forEach((it) => { it.question = true; });
  }
  return root.children;
}

// ---------- fingerprints ----------

const runsText = (runs) => (runs ?? []).map((r) => (r.br ? ' ' : r.text)).join('');
function ownText(b) {
  switch (b.type) {
    case 'section': return b.title;
    case 'paragraph': case 'heading': return runsText(b.runs);
    case 'quote': return (b.children ?? []).map(ownText).join(' ');
    case 'table': return b.rows.flat().map((c) => runsText(c.runs)).join(' ');
    case 'item': return (b.children ?? []).filter((c) => c.type !== 'list').map(ownText).join(' ');
    default: return '';
  }
}
const words = (t) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function sha1(t) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t)));
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
/** Gives each block you can write beside its fingerprint (fp). */
async function fingerprint(blocks) {
  for (const b of blocks ?? []) {
    if (['section', 'paragraph', 'heading', 'quote', 'table'].includes(b.type)) {
      const t = words(ownText(b));
      if (t) b.fp = await sha1(t);
    }
    if (b.type === 'list') {
      for (const it of b.items) {
        const t = words(ownText({ type: 'item', children: it.children }));
        if (t) it.fp = await sha1(t);
        await fingerprint(it.children);
      }
    }
    await fingerprint(b.children);
  }
}

/**
 * The outline is rebuilt from the delivery order, so its blocks come without ids: give each the id of the
 * manuscript block with the same fingerprint (a note written beside it in one view shows in the other).
 */
function idsFromManuscript(outline, manuscript) {
  const blocks = new Map();
  const items = new Map();
  (function collect(bs) {
    for (const b of bs ?? []) {
      if (b.id && b.fp && !blocks.has(b.fp)) blocks.set(b.fp, b.id);
      for (const it of b.items ?? []) {
        if (it.id && it.fp && !items.has(it.fp)) items.set(it.fp, it.id);
        collect(it.children);
      }
      collect(b.children);
    }
  })(manuscript);
  (function apply(bs) {
    for (const b of bs ?? []) {
      if (!b.id && b.fp && blocks.has(b.fp) && b.type !== 'list') b.id = blocks.get(b.fp);
      for (const it of b.items ?? []) {
        if (!it.id && it.fp && items.has(it.fp)) it.id = items.get(it.fp);
        apply(it.children);
      }
      apply(b.children);
    }
  })(outline);
}

/** Every Bible reference in the blocks (the `ref` runs), in order. */
function refsIn(blocks, out = new Set()) {
  for (const b of blocks ?? []) {
    for (const r of b.runs ?? []) if (r.ref) out.add(r.ref);
    for (const row of b.rows ?? []) for (const c of row) for (const r of c.runs ?? []) if (r.ref) out.add(r.ref);
    refsIn(b.children, out);
    for (const it of b.items ?? []) refsIn(it.children, out);
  }
  return out;
}

// ---------- metadata ----------

const reflectionText = (r) => (typeof r === 'string' ? r : r && typeof r === 'object' ? Object.values(r).filter((v) => typeof v === 'string' && v.trim()).join('\n\n') : '');

/** What the note is (sermon, lesson or note) and what the manifest says about it. */
export async function exportInfo(noteId) {
  const [sermon, lesson, method, slides, last] = await Promise.all([
    api.noteSermon(noteId).catch(() => null), api.lesson(noteId).catch(() => null), api.noteMethod(noteId).catch(() => null),
    api.slides(noteId).catch(() => null), api.ipadExportInfo(noteId).catch(() => null),
  ]);
  const deck = slides?.deck?.slides?.length ? slides.deck : null;
  let meta;
  if (sermon) {
    meta = {
      kind: 'sermon', passage: sermon.passage || null,
      series: sermon.series ? { title: sermon.series, color: sermon.series_color ?? null } : null,
      goalMinutes: sermon.data?.minutes ?? null, status: sermon.status ?? null, author: sermon.data?.author ?? '',
      log: (sermon.preachings ?? []).map((p) => ({ date: p.date, place: p.place, occasion: p.occasion, minutes: p.minutes, notes: p.notes })),
    };
  } else if (lesson?.item || lesson?.study) {
    const it = lesson.item ?? {};
    const notes = reflectionText(it.reflection);
    meta = {
      kind: 'lesson', passage: it.ref || null, date: it.date || null,
      course: lesson.study ? { title: lesson.study.title, week: it.week ?? null } : null,
      goalMinutes: lesson.study?.classMinutes ?? null, steps: it.data?.minutes ?? {},
      status: lesson.item ? (it.done ? 'taught' : 'planned') : null,
      log: it.done ? [{ date: it.date || null, notes }] : [],
    };
  } else {
    meta = { kind: 'note' };
  }
  meta.method = method?.method ?? null;
  return { meta, deck, last };
}

// ---------- the package ----------

/**
 * The body for POST /api/notes/:id/ipad-export: { content, meta, art, slideBlocks, slides }. Gives the note's blocks
 * their ids first. `onIds(note)` is told when that changed the note ({ html, updated_at }), for a builder that has it
 * open. Resolves to { body, skipped } (skipped: references left without their text past the verse limit).
 */
export async function buildPackage(noteId, { info, bibleText = true, slides = true, onIds } = {}) {
  const ids = await api.blockIds(noteId);
  if (ids.changed) onIds?.(ids);
  const { html } = ids;
  const { meta, deck } = info ?? await exportInfo(noteId);
  const sermon = isSermonHtml(html);
  const headingIds = new Map();
  for (const h of doc(html).querySelectorAll('h1[data-bid], h2[data-bid]')) {
    const k = `${h.tagName[1]}|${h.textContent.replace(/\s+/g, ' ').trim()}`;
    if (!headingIds.has(k)) headingIds.set(k, h.getAttribute('data-bid'));
  }
  const manuscript = contentBlocks(sermon ? deliveryHtml(html, { color: true }) : html, { lesson: meta.kind === 'lesson', headingIds });
  const outline = sermon && hasDeliveryOrder(html) ? contentBlocks(deliveryHtml(html, { color: true, list: true }), { headingIds }) : null;
  await fingerprint(manuscript);
  if (outline) {
    await fingerprint(outline);
    idsFromManuscript(outline, manuscript);
  }

  // The Bible text: every reference in the text, the passage, and the passage slides' (up to the verse limit).
  const passages = {};
  const skipped = [];
  const translations = new Set();
  const copyright = new Set();
  const useDeck = slides && deck;
  // Passage slides always carry their verses (a slide with only a reference is no use on the TV); "references only"
  // leaves out the text of the notes' references.
  const slideRefs = useDeck ? deck.slides.filter((s) => s.type === 'passage' && s.ref).map((s) => s.ref) : [];
  if ((bibleText || slideRefs.length) && (await bibleConnected())) {
    const refs = new Set([...slideRefs, ...(bibleText ? [...(meta.passage ? findReferences(meta.passage).map((f) => f.text) : []), ...refsIn(manuscript), ...refsIn(outline ?? [])] : [])]);
    let verses = 0;
    const list = [...refs];
    for (let i = 0; i < list.length; i += 4) {
      const got = await Promise.all(list.slice(i, i + 4).map((r) => biblePassage(r).then((p) => [r, p]).catch(() => [r, null])));
      for (const [r, p] of got) {
        if (!p?.text) continue;
        const n = (p.text.match(/\[\d+\]/g) ?? []).length || 1;
        if (verses + n > MAX_VERSES) { skipped.push(r); continue; }
        verses += n;
        passages[r] = { reference: p.reference, translation: p.translation, text: p.text, copyright: p.copyright ?? '' };
        if (p.translation) translations.add(p.translation);
        if (p.copyright) copyright.add(p.copyright);
      }
    }
  }
  const mode = bibleText && Object.keys(passages).length ? 'text' : 'refs';

  // Each slide's block (the block its anchor names), and the deck's art as a picture.
  let slideBlocks = {};
  let art = null;
  const arts = {};
  if (useDeck) {
    const root = doc(sermon ? deliveryHtml(html, { color: false }) : html);
    const cache = anchorElements(root);
    slideBlocks = Object.fromEntries(deck.slides.map((s) => [s.id, findAnchor(root, s.anchor, cache)?.closest('[data-bid]')?.getAttribute('data-bid') ?? null]).filter(([, b]) => b));
    try {
      const look = deckLook(deck, await loadBrand());
      // Every art the slides show (the deck's, and any a slide picks for itself), as pictures in the art color.
      const ids = new Set([look.art, ...deck.slides.map((s) => (s.art && s.art !== 'none' ? s.art : null))].filter(Boolean));
      for (const id of ids) {
        const png = await artPng(id, look.palette.art, { width: 1920 }).catch(() => null);
        if (png) arts[id] = { png, texture: isTexture(id) };
      }
      art = (look.art && arts[look.art]?.png) || null; // the deck's art, as Companion 1.0 reads it
    } catch { /* no art */ }
  }

  return {
    body: {
      content: { manuscript, outline, passages },
      meta: { ...meta, bible: { mode, translations: [...translations], copyright: [...copyright] } },
      art, arts, slideBlocks, slides: !!useDeck,
    },
    skipped,
  };
}
