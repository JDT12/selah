import { citationStyle, formatCitations } from '../citations/index.js';
import { ELEMENT_COLORS } from '../sermon.js';
import { scriptureCopyrights } from '../esv.js';
import { outlineMarker } from '../../../shared/outline.js';

/**
 * A note read once into plain blocks and runs (11.0), for the manuscript exports that aren't Word: PDF and rich
 * text (.rtf). Word keeps its own converter (docx/word.js); this follows the same rules so the three agree.
 *
 * Runs: { text, b, i, u, s, sup, sub, code, color, highlight, link, small, note } (colors as 'RRGGBB'; note is a
 * footnote number). Blocks (flat, in order):
 *   { t: 'p', runs, align, indent, stripe, quote }      a paragraph (indent in levels; stripe a left bar color)
 *   { t: 'h', level, runs }                             a heading
 *   { t: 'label', text, color, indent, stripe }         a color-coded element's name, in small capitals
 *   { t: 'li', runs, marker, level, stripe }            a list paragraph (marker null for its further paragraphs)
 *   { t: 'pre', lines, indent }   { t: 'hr' }   { t: 'img', png, w, h, indent }
 *   { t: 'table', rows: [[ [blocks] ]], widths }        widths in percent, or null for even columns
 * Returns { title, blocks, notes: [{ n, runs }], bibliography: [runs], copyrights: [text] }.
 */

const HIGHLIGHT = { green: 'C9F0D2', blue: 'CFE3FF', pink: 'FFD3E6', orange: 'FFDCB5', purple: 'E3D4FF' };
const TEXT_COLOR = { red: 'C62828', orange: 'B85600', green: '2E7D32', blue: '1F5FBF', purple: '7B3FBF', gray: '6B7280' };
export const ELEMENT = { ...Object.fromEntries(Object.entries(ELEMENT_COLORS).map(([k, [light]]) => [k, light.slice(1).toUpperCase()])), other: '6B7280' };
export const QUOTE_BAR = 'C9C2B6';
export const CALLOUT_BAR = '93613A';

// Numbered lists use the outline numbering in shared/outline.js.
export const marker = outlineMarker;
const BULLETS = ['•', '–', '◦'];

/** A picture as PNG bytes at most `max` px wide (drawing it on a canvas covers JPEG, WebP and SVG). */
async function png(src, wantWidth, max = 624) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image'));
      i.src = url;
    });
    const nw = img.naturalWidth || 600;
    const nh = img.naturalHeight || 400;
    const w = Math.min(max, wantWidth || nw);
    const canvas = document.createElement('canvas');
    canvas.width = nw;
    canvas.height = nh;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), w: Math.round(w), h: Math.round((w / nw) * nh) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

class Reader {
  constructor(cites) {
    this.cites = cites;
    this.notes = new Map();
  }

  async runs(node, fmt = {}) {
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = fmt.code ? child.textContent : child.textContent.replace(/\s+/g, ' ');
        if (text) out.push({ ...fmt, text });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === 'SUP' && child.dataset.citeIndex != null) { out.push(...this.citation(Number(child.dataset.citeIndex), fmt)); continue; }
      if (tag === 'BR') { out.push({ ...fmt, text: '\n' }); continue; }
      if (tag === 'IMG') continue; // pictures inside a line are left out; a picture on its own is a block
      if (child.hasAttribute('data-element-label')) {
        // An outline's color-coded item starts with its element's name.
        out.push({ text: `${child.textContent.trim().toUpperCase()}  `, b: true, small: true, color: fmt.labelColor ?? ELEMENT.other });
        continue;
      }
      const next = { ...fmt };
      if (tag === 'STRONG' || tag === 'B') next.b = true;
      if (tag === 'EM' || tag === 'I') next.i = true;
      if (tag === 'U') next.u = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.s = true;
      if (tag === 'MARK') next.highlight = HIGHLIGHT[child.dataset.color] ?? 'FFF59D';
      if (TEXT_COLOR[child.dataset.textColor]) next.color = TEXT_COLOR[child.dataset.textColor];
      if (tag === 'CODE') next.code = true;
      if (tag === 'SUP') next.sup = true;
      if (tag === 'SUB') next.sub = true;
      const href = tag === 'A' ? child.getAttribute('href') ?? '' : '';
      if (tag === 'A' && /^https?:\/\//i.test(href) && !child.dataset.noteId) next.link = href;
      out.push(...await this.runs(child, next));
    }
    return out;
  }

  citation(i, fmt) {
    const r = this.cites[i];
    if (!r) return [];
    if (r.inText) return [{ ...fmt, text: plain(r.html) }];
    this.notes.set(r.number, r.html);
    return [{ ...fmt, text: String(r.number), sup: true, note: r.number }];
  }

  async blocks(parent, ctx = {}) {
    const out = [];
    for (const el of parent.children) out.push(...await this.block(el, ctx));
    return out;
  }

  async block(el, ctx) {
    const tag = el.tagName;
    const indent = ctx.indent ?? 0;
    const base = { indent, stripe: ctx.stripe ?? null, quote: !!ctx.quote };
    if (tag === 'P' && el.hasAttribute('data-element-label')) {
      return [{ t: 'label', text: el.textContent.trim().toUpperCase(), color: ctx.stripe ?? ELEMENT.other, indent, stripe: ctx.stripe ?? null }];
    }
    if (tag === 'P') {
      if (!el.textContent.trim()) return el.querySelector('img') ? this.blocks(el, ctx) : [];
      const align = ['center', 'right', 'justify'].includes(el.style?.textAlign) ? el.style.textAlign : null;
      return [{ t: 'p', runs: await this.runs(el, { labelColor: ctx.stripe }), align, ...base }];
    }
    if (/^H[1-6]$/.test(tag)) {
      if (!el.textContent.trim()) return [];
      return [{ t: 'h', level: Number(tag[1]), runs: await this.runs(el) }];
    }
    if (tag === 'UL' || tag === 'OL') return this.list(el, ctx, 0);
    if (tag === 'BLOCKQUOTE') return this.blocks(el, { ...ctx, quote: true, indent: indent + 1, stripe: ctx.stripe ?? QUOTE_BAR });
    if (tag === 'PRE') return [{ t: 'pre', lines: el.textContent.replace(/\n$/, '').split('\n'), indent }];
    if (tag === 'HR') return [{ t: 'hr' }];
    if (tag === 'TABLE') return [await this.table(el)];
    if (tag === 'IMG') return this.image(el.getAttribute('src'), Number(el.getAttribute('width')) || 0, el.getAttribute('alt'), base);
    if (el.dataset?.attachment) {
      const name = el.dataset.filename || 'file';
      if (/^image\//.test(el.dataset.mime ?? '')) return this.image(`/api/files/${el.dataset.attachment}`, 0, name, base);
      return [{ t: 'p', runs: [{ text: `[Attachment: ${name}]`, i: true }], ...base }];
    }
    if (el.hasAttribute?.('data-drawing')) return [{ t: 'p', runs: [{ text: '[Drawing]', i: true }], ...base }];
    if (el.dataset?.callout != null) return this.blocks(el, { ...ctx, stripe: CALLOUT_BAR });
    if (el.dataset?.element) return this.blocks(el, { ...ctx, stripe: ELEMENT[el.dataset.element] ?? ELEMENT.other });
    if (tag === 'DETAILS') {
      const summary = el.querySelector(':scope > summary');
      const out = summary ? [{ t: 'p', runs: await this.runs(summary, { b: true }), ...base }] : [];
      for (const c of el.children) if (c !== summary) out.push(...await this.block(c, ctx));
      return out;
    }
    return this.blocks(el, ctx);
  }

  async image(src, width, alt, base) {
    try {
      return [{ t: 'img', ...(await png(src, width)), indent: base.indent }];
    } catch {
      return [{ t: 'p', runs: [{ text: `[Picture: ${alt || 'not available'}]`, i: true }], ...base }];
    }
  }

  async list(el, ctx, level) {
    const numbered = el.tagName === 'OL';
    const tasks = el.dataset.type === 'taskList';
    const start = Number(el.getAttribute('start')) || 1;
    const indent = ctx.indent ?? 0;
    const out = [];
    let n = start - 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      n += 1;
      // An outline's color-coded item.
      const stripe = li.dataset.element ? ELEMENT[li.dataset.element] ?? ELEMENT.other : ctx.stripe ?? null;
      let first = true;
      const kids = [...li.children].flatMap((c) => (c.tagName === 'DIV' && !c.dataset.element ? [...c.children] : [c]));
      if (!kids.length && li.textContent.trim()) kids.push(li);
      for (const c of kids) {
        if (c.tagName === 'LABEL') continue;
        if (c.tagName === 'UL' || c.tagName === 'OL') { out.push(...await this.list(c, { ...ctx, stripe, indent, ol: (ctx.ol ?? 0) + (numbered ? 1 : 0) }, level + 1)); continue; }
        if (c !== li && !['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)) {
          out.push(...await this.block(c, { ...ctx, stripe, indent: indent + level + 1 }));
          continue;
        }
        const runs = await this.runs(c, { labelColor: stripe });
        let mark = null;
        if (first) mark = tasks ? (li.dataset.checked === 'true' ? '[x]' : '[  ]') : numbered ? marker(ctx.ol ?? 0, n) : BULLETS[level % BULLETS.length];
        out.push({ t: 'li', runs, marker: mark, level: indent + level, stripe });
        first = false;
      }
    }
    return out;
  }

  async table(el) {
    const widths = { notes: [30, 70], head: [17, 33, 17, 33] }[el.getAttribute('data-cornell')] ?? null;
    const rows = [];
    for (const tr of el.querySelectorAll('tr')) {
      const cells = [];
      for (const td of tr.children) {
        const blocks = await this.blocks(td, {});
        if (!td.children.length && td.textContent.trim()) blocks.push({ t: 'p', runs: [{ text: td.textContent.trim() }], indent: 0 });
        cells.push({ blocks, head: td.tagName === 'TH', span: Number(td.getAttribute('colspan')) || 1 });
      }
      if (cells.length) rows.push(cells);
    }
    return { t: 'table', rows, widths };
  }
}

const plain = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? '';

export async function readManuscript(html, { title = '' } = {}) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const sups = [...doc.querySelectorAll('sup.citation, sup[data-cite], sup[data-note]')];
  const entries = sups.map((s, i) => {
    s.dataset.citeIndex = String(i);
    let items = [];
    try { items = JSON.parse(s.getAttribute('data-cite') || '[]'); } catch { /* none */ }
    return { items, note: s.getAttribute('data-note') || '', noteHtml: s.getAttribute('data-note-html') || '' };
  });
  const cited = entries.length ? await formatCitations(entries, await citationStyle()) : { results: [], bibliography: [] };
  const r = new Reader(cited.results);
  const blocks = await r.blocks(doc.body);
  const runsOf = async (h) => r.runs(new DOMParser().parseFromString(`<body><p>${h}</p></body>`, 'text/html').body.firstChild);
  const notes = [];
  for (const [n, h] of [...r.notes.entries()].sort((a, b) => a[0] - b[0])) notes.push({ n, runs: await runsOf(h) });
  const bibliography = [];
  for (const entry of cited.bibliography) bibliography.push(await runsOf(entry));
  return { title, blocks, notes, bibliography, copyrights: await scriptureCopyrights(html).catch(() => []) };
}

/** "Fear God.pdf" from a title. */
export const fileName = (title, ext) => `${(title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'}.${ext}`;
