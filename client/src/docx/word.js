import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, FootnoteReferenceRun, HeadingLevel, ImageRun,
  LevelFormat, Packer, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

// The highlighter and text colors as they look on paper (the light theme's shades in styles.css).
const HIGHLIGHT_FILL = { green: 'C9F0D2', blue: 'CFE3FF', pink: 'FFD3E6', orange: 'FFDCB5', purple: 'E3D4FF' };
const TEXT_COLOR = { red: 'C62828', orange: 'B85600', green: '2E7D32', blue: '1F5FBF', purple: '7B3FBF', gray: '6B7280' };
import { citationStyle, formatCitations } from '../citations/index.js';
import { ELEMENT_COLORS } from '../sermon.js';
import { scriptureCopyrights } from '../esv.js';
// A color-coded sermon's elements (data-element), as a stripe down the left of their paragraphs.
const ELEMENT_COLOR = { ...Object.fromEntries(Object.entries(ELEMENT_COLORS).map(([k, [light]]) => [k, light.slice(1).toUpperCase()])), other: '6B7280' };

/**
 * Notes as Word documents (.docx), made in the browser (loaded only when you export). Three formats:
 * - turabian: Times New Roman 12, double-spaced, indented paragraphs, an optional title page, footnotes,
 *   a bibliography on its own page and page numbers (Turabian 9th, as far as Word layout goes);
 * - manuscript: clean and single-spaced, for sermons, lessons and articles;
 * - plain: the note as written, in Word's usual look.
 * Citations become real Word footnotes (note styles) or text (author–date styles), numbered straight through all
 * the parts, with one bibliography at the end.
 */

const TWIP = 1440; // per inch
const FORMATS = {
  turabian: { font: 'Times New Roman', size: 24, line: 480, after: 0, indent: 720, noteSize: 20, center: true },
  manuscript: { font: 'Georgia', size: 24, line: 276, after: 160, indent: 0, noteSize: 20, center: false },
  plain: { font: 'Calibri', size: 22, line: 259, after: 160, indent: 0, noteSize: 18, center: false },
};

const NUMBERED = 'numbered';
// The editor's outline numbering: 1. → A. → I. → a. → i. → (1) → (a).
const LEVEL_FORMATS = [LevelFormat.DECIMAL, LevelFormat.UPPER_LETTER, LevelFormat.UPPER_ROMAN, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER];
const levelText = (i) => (i < 5 ? `%${i + 1}.` : `(%${i + 1})`);

const plain = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? '';
const blank = (n = 1) => Array.from({ length: n }, () => new Paragraph({ children: [] }));

/** An image file as PNG (Word takes PNG/JPEG/GIF/BMP; drawing it on a canvas covers SVG and WebP too). */
async function imageData(src, wantWidth) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image'));
      i.src = url;
    });
    const natural = { w: img.naturalWidth || 600, h: img.naturalHeight || 400 };
    const max = 6.5 * 96; // the text width, at 96 px an inch
    const w = Math.min(max, wantWidth || natural.w);
    const h = Math.round((w / natural.w) * natural.h);
    const canvas = document.createElement('canvas');
    canvas.width = natural.w;
    canvas.height = natural.h;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { data: new Uint8Array(await png.arrayBuffer()), w: Math.round(w), h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

class Converter {
  constructor(format, cites) {
    this.f = FORMATS[format];
    this.format = format;
    this.cites = cites; // index -> result from formatCitations
    this.footnotes = {};
    this.lists = 0; // numbered lists so far (each restarts at 1)
  }

  // ---- inline ----
  async runs(node, fmt = {}) {
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = fmt.code ? child.textContent : child.textContent.replace(/\s+/g, ' ');
        if (text) out.push(new TextRun({ text, ...this.style(fmt) }));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === 'SUP' && child.dataset.citeIndex != null) { out.push(...this.citation(Number(child.dataset.citeIndex), fmt)); continue; }
      if (tag === 'BR') { out.push(new TextRun({ break: 1 })); continue; }
      if (tag === 'IMG') { const r = await this.image(child); if (r) out.push(r); continue; }
      const next = { ...fmt };
      if (tag === 'STRONG' || tag === 'B') next.bold = true;
      if (tag === 'EM' || tag === 'I') next.italics = true;
      if (tag === 'U') next.underline = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true;
      if (tag === 'MARK') next.highlight = HIGHLIGHT_FILL[child.dataset.color] ?? 'yellow';
      if (TEXT_COLOR[child.dataset.textColor]) next.color = TEXT_COLOR[child.dataset.textColor];
      if (tag === 'CODE') next.code = true;
      if (tag === 'SUP') next.sup = true;
      if (tag === 'SUB') next.sub = true;
      if (/small-caps/.test(child.getAttribute('style') ?? '')) next.smallCaps = true;
      const href = tag === 'A' ? child.getAttribute('href') ?? '' : '';
      if (tag === 'A' && /^https?:\/\//i.test(href) && !child.dataset.noteId) {
        out.push(new ExternalHyperlink({ link: href, children: await this.runs(child, { ...next, link: true }) }));
        continue;
      }
      out.push(...await this.runs(child, next));
    }
    return out;
  }

  style(fmt) {
    return {
      bold: fmt.bold, italics: fmt.italics, strike: fmt.strike, smallCaps: fmt.smallCaps,
      underline: fmt.underline || fmt.link ? {} : undefined,
      color: fmt.link && this.format !== 'turabian' ? '2F5D86' : fmt.color,
      // Word's own highlighter only has yellow among these colors; the others are shading in the same place.
      highlight: fmt.highlight === 'yellow' ? 'yellow' : undefined,
      shading: fmt.highlight && fmt.highlight !== 'yellow' ? { type: ShadingType.CLEAR, color: 'auto', fill: fmt.highlight } : undefined,
      superScript: fmt.sup, subScript: fmt.sub,
      font: fmt.code ? 'Consolas' : undefined,
      size: fmt.size,
    };
  }

  /** A citation: a footnote mark (with its note) or, in author–date styles, the citation text. */
  citation(i, fmt) {
    const r = this.cites[i];
    if (!r) return [];
    if (r.inText) return [new TextRun({ text: plain(r.html), ...this.style(fmt) })];
    this.footnotes[r.number] = r.html;
    return [new FootnoteReferenceRun(r.number)];
  }

  async image(img) {
    try {
      const { data, w, h } = await imageData(img.getAttribute('src'), Number(img.getAttribute('width')) || 0);
      return new ImageRun({ type: 'png', data, transformation: { width: w, height: h } });
    } catch {
      return new TextRun({ text: `[image: ${img.getAttribute('alt') || 'not available'}]`, italics: true });
    }
  }

  // ---- blocks ----
  para(children, opts = {}, ctx = {}) {
    const body = !ctx.list && !ctx.quote && !ctx.table && !ctx.callout && !opts.heading && !opts.alignment;
    return new Paragraph({
      children,
      ...opts,
      indent: opts.indent ?? (ctx.quote || ctx.callout ? { left: 720 } : body && this.f.indent ? { firstLine: this.f.indent } : undefined),
      // Turabian: block quotations single-spaced with a blank line after.
      spacing: opts.spacing ?? (ctx.quote && this.format === 'turabian' ? { line: 240, after: 240 } : ctx.table ? { line: 240, after: 0 } : undefined),
      border: ctx.callout ? { left: { style: BorderStyle.SINGLE, size: 12, color: '93613A', space: 8 } }
        : ctx.element ? { left: { style: BorderStyle.SINGLE, size: 18, color: ELEMENT_COLOR[ctx.element] ?? ELEMENT_COLOR.other, space: 8 } } : undefined,
    });
  }

  async blocks(parent, ctx = {}) {
    const out = [];
    for (const el of parent.children) out.push(...await this.block(el, ctx));
    return out;
  }

  async block(el, ctx) {
    const tag = el.tagName;
    const align = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }[el.style?.textAlign];
    if (tag === 'P' && el.hasAttribute('data-element-label')) {
      const color = ELEMENT_COLOR[ctx.element] ?? ELEMENT_COLOR.other;
      return [this.para([new TextRun({ text: el.textContent.trim().toUpperCase(), font: this.f.font, size: 16, bold: true, color, characterSpacing: 20 })],
        { indent: { left: 0 }, spacing: { before: 120, after: 40, line: 240 }, keepNext: true }, ctx)];
    }
    if (tag === 'P') {
      if (!el.textContent.trim() && !el.querySelector('img')) return [];
      return [this.para(await this.runs(el), align ? { alignment: align } : {}, ctx)];
    }
    if (/^H[1-6]$/.test(tag)) {
      if (!el.textContent.trim()) return [];
      const level = Number(tag[1]);
      return [this.para(await this.runs(el), { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][level - 1] }, ctx)];
    }
    if (tag === 'UL' || tag === 'OL') return this.list(el, ctx, 0);
    if (tag === 'BLOCKQUOTE') return this.blocks(el, { ...ctx, quote: true });
    if (tag === 'PRE') {
      return el.textContent.replace(/\n$/, '').split('\n').map((line) => new Paragraph({
        children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], spacing: { line: 240, after: 0 }, indent: { left: 360 },
      }));
    }
    if (tag === 'HR') return [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('*     *     *')] })];
    if (tag === 'TABLE') return [await this.table(el)];
    if (tag === 'IMG') { const r = await this.image(el); return r ? [new Paragraph({ children: [r], alignment: AlignmentType.CENTER })] : []; }
    if (el.dataset?.attachment) {
      const name = el.dataset.filename || 'file';
      if (/^image\//.test(el.dataset.mime ?? '')) {
        const img = document.createElement('img');
        img.setAttribute('src', `/api/files/${el.dataset.attachment}`);
        img.setAttribute('alt', name);
        return this.block(img, ctx);
      }
      return [this.para([new TextRun({ text: `[Attachment: ${name}]`, italics: true })], {}, { ...ctx, list: true })];
    }
    if (el.hasAttribute?.('data-drawing')) return [this.para([new TextRun({ text: '[Drawing]', italics: true })], {}, { ...ctx, list: true })];
    if (el.dataset?.callout != null) return this.blocks(el, { ...ctx, callout: true });
    if (el.dataset?.element) return this.blocks(el, { ...ctx, element: el.dataset.element });
    if (tag === 'DETAILS') {
      const summary = el.querySelector(':scope > summary');
      const rest = [...el.children].filter((c) => c !== summary);
      const out = summary ? [this.para(await this.runs(summary, { bold: true }), {}, { ...ctx, list: true })] : [];
      for (const c of rest) out.push(...await this.block(c, ctx));
      return out;
    }
    return this.blocks(el, ctx); // divs and other wrappers
  }

  async list(el, ctx, level) {
    const numbered = el.tagName === 'OL';
    const tasks = el.dataset.type === 'taskList';
    const instance = numbered && level === 0 ? ++this.lists : ctx.instance;
    const out = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      let first = true;
      for (const c of li.children) {
        if (c.tagName === 'UL' || c.tagName === 'OL') { out.push(...await this.list(c, { ...ctx, instance }, level + 1)); continue; }
        // A task item keeps its paragraphs inside a <div>, after the checkbox label.
        if (c.tagName === 'LABEL') continue;
        const paras = c.tagName === 'DIV' ? [...c.children] : [c];
        for (const p of paras) {
          if (p.tagName === 'UL' || p.tagName === 'OL') { out.push(...await this.list(p, { ...ctx, instance }, level + 1)); continue; }
          const runs = await this.runs(p);
          if (tasks && first) runs.unshift(new TextRun(li.dataset.checked === 'true' ? '☑ ' : '☐ '));
          const opts = first && !tasks
            ? (numbered ? { numbering: { reference: NUMBERED, level: Math.min(level, 6), instance } } : { bullet: { level: Math.min(level, 8) } })
            : { indent: { left: 720 * (level + 1) } };
          out.push(this.para(runs, { ...opts, spacing: { line: this.format === 'turabian' ? 480 : 240, after: this.format === 'turabian' ? 0 : 60 } }, { ...ctx, list: true }));
          first = false;
        }
      }
    }
    return out;
  }

  async table(el) {
    const rows = [];
    // Cornell notes keep their narrow cue column (and label columns in the header).
    const widths = { notes: [30, 70], head: [17, 33, 17, 33] }[el.getAttribute('data-cornell')];
    for (const tr of el.querySelectorAll('tr')) {
      const cells = [];
      for (const [i, td] of [...tr.children].entries()) {
        const children = await this.blocks(td, { table: true });
        if (!td.children.length && td.textContent.trim()) children.push(new Paragraph({ children: [new TextRun(td.textContent.trim())] }));
        cells.push(new TableCell({ children: children.length ? children : [new Paragraph('')], columnSpan: Number(td.getAttribute('colspan')) || 1,
          width: widths?.[i] ? { size: widths[i], type: WidthType.PERCENTAGE } : undefined }));
      }
      if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: tr.querySelector('th') != null && !rows.length }));
    }
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }

  /** The footnotes Word needs: each note's text as paragraphs. */
  async notes() {
    const out = {};
    for (const [n, html] of Object.entries(this.footnotes)) {
      const doc = new DOMParser().parseFromString(`<body><p>${html}</p></body>`, 'text/html');
      out[n] = { children: [new Paragraph({
        children: await this.runs(doc.body.firstChild, { size: this.f.noteSize }),
        indent: this.format === 'turabian' ? { firstLine: 720 } : undefined,
        spacing: { line: 240, after: this.format === 'turabian' ? 240 : 80 },
      })] };
    }
    return out;
  }
}

/**
 * The .docx for one note or a whole project.
 * parts: [{ title, html }] (one per chapter; a single note is one part whose title is the document's).
 * options: { format, title, chapterTitles, titlePage: { title, subtitle, name, school, course, professor, date } | null,
 * bibliography }.
 */
export async function wordDocument(parts, { format = 'turabian', title = '', subtitle = '', size = null, chapterTitles = false, titlePage = null, bibliography = true } = {}) {
  // size: the text size in points (11.0: a manuscript in large print), else the format's own.
  const f = { ...(FORMATS[format] ?? FORMATS.plain), ...(size ? { size: size * 2 } : {}) };
  // Citations across every part, in order, so footnote numbers run straight through.
  const docs = parts.map((p) => new DOMParser().parseFromString(`<body>${p.html}</body>`, 'text/html'));
  const sups = docs.flatMap((d) => [...d.querySelectorAll('sup.citation, sup[data-cite], sup[data-note]')]);
  const entries = sups.map((s, i) => {
    s.dataset.citeIndex = String(i);
    let items = [];
    try { items = JSON.parse(s.getAttribute('data-cite') || '[]'); } catch { /* none */ }
    return { items, note: s.getAttribute('data-note') || '', noteHtml: s.getAttribute('data-note-html') || '' };
  });
  const cited = entries.length ? await formatCitations(entries, await citationStyle()) : { results: [], bibliography: [] };
  const c = new Converter(format, cited.results);

  const body = [];
  const heading = (text, opts = {}) => new Paragraph({ heading: HeadingLevel.TITLE, alignment: f.center ? AlignmentType.CENTER : undefined, children: [new TextRun(text)], ...opts });
  if (!titlePage && title) body.push(heading(title, subtitle ? { spacing: { after: 60 } } : {}));
  if (!titlePage && subtitle) body.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: subtitle, color: '5B6875', size: Math.round(f.size * 0.92) })] }));
  for (const [i, d] of docs.entries()) {
    if (chapterTitles && parts[i].title) {
      body.push(new Paragraph({
        heading: HeadingLevel.HEADING_1, pageBreakBefore: i > 0, // each chapter on a new page
        children: [new TextRun(parts[i].title)],
      }));
    }
    body.push(...await c.blocks(d.body));
  }
  // The publishers ask for their copyright notice wherever their Bible text is quoted.
  for (const notice of await scriptureCopyrights(parts.map((p) => p.html).join(''))) {
    body.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: notice, size: 18 })] }));
  }
  if (bibliography && cited.bibliography.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: format !== 'plain', alignment: f.center ? AlignmentType.CENTER : undefined, children: [new TextRun('Bibliography')] }));
    for (const entry of cited.bibliography) {
      const doc = new DOMParser().parseFromString(`<body><p>${entry}</p></body>`, 'text/html');
      body.push(new Paragraph({ children: await c.runs(doc.body.firstChild), indent: { left: 720, hanging: 720 }, spacing: { line: 240, after: 240 } }));
    }
  }

  const pageNumbers = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] });
  const margin = { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP };
  const sections = [];
  if (titlePage) {
    const t = titlePage;
    const line = (text, opts = {}) => (text ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: 240, after: 0 }, children: [new TextRun({ text, ...opts })] })] : []);
    sections.push({
      properties: { page: { margin } },
      children: [
        ...line(t.school),
        ...blank(t.school ? 9 : 10),
        ...line(t.title || title, { bold: true }),
        ...(t.subtitle ? [...blank(1), ...line(t.subtitle)] : []),
        ...blank(9),
        ...(t.professor ? line(`Submitted to ${t.professor}`) : []),
        ...line(t.course),
        ...((t.professor || t.course) ? blank(2) : []),
        ...(t.name ? [...line('by'), ...line(t.name)] : []),
        ...line(t.date),
      ],
    });
  }
  sections.push({ properties: { page: { margin, pageNumbers: { start: 1 } } }, footers: { default: pageNumbers }, children: body });

  const headingRun = (size, bold, italics = false) => ({ font: f.font, size, bold, italics, color: '000000' });
  const turabian = format === 'turabian';
  const doc = new Document({
    creator: 'Selah',
    title: title || parts[0]?.title || 'Untitled',
    styles: {
      default: {
        document: { run: { font: f.font, size: f.size }, paragraph: { spacing: { line: f.line, after: f.after } } },
      },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: headingRun(turabian ? 24 : 36, true), paragraph: { spacing: { after: turabian ? 480 : 240 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: headingRun(turabian ? 24 : 30, true), paragraph: { alignment: turabian ? AlignmentType.CENTER : undefined, keepNext: true, spacing: { before: 240, after: turabian ? 240 : 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: headingRun(turabian ? 24 : 26, !turabian), paragraph: { alignment: turabian ? AlignmentType.CENTER : undefined, keepNext: true, spacing: { before: 240, after: 120 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: headingRun(24, true), paragraph: { keepNext: true, spacing: { before: 240, after: 0 } } },
        { id: 'Heading4', name: 'Heading 4', basedOn: 'Normal', next: 'Normal', run: headingRun(24, true, true), paragraph: { keepNext: true } },
        { id: 'Heading5', name: 'Heading 5', basedOn: 'Normal', next: 'Normal', run: headingRun(24, false, true), paragraph: { keepNext: true } },
        { id: 'Heading6', name: 'Heading 6', basedOn: 'Normal', next: 'Normal', run: headingRun(24, false, true), paragraph: { keepNext: true } },
        { id: 'FootnoteText', name: 'footnote text', basedOn: 'Normal', run: { size: f.noteSize }, paragraph: { spacing: { line: 240, after: 0 } } },
      ],
    },
    numbering: {
      config: [{
        reference: NUMBERED,
        levels: LEVEL_FORMATS.map((format, level) => ({
          level, format, text: levelText(level), alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    footnotes: await c.notes(),
    sections,
  });
  return Packer.toBlob(doc);
}

/** A file name from a title: "Fear God.docx". */
export const fileName = (title) => `${(title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'}.docx`;

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
