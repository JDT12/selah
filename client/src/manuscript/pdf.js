import pdfMake from 'pdfmake/build/pdfmake';
import serif400 from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff?url';
import serif400i from '@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff?url';
import serif700 from '@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff?url';
import serif700i from '@fontsource/source-serif-4/files/source-serif-4-latin-700-italic.woff?url';
import ext400 from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff?url';
import ext400i from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-italic.woff?url';
import ext700 from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-700-normal.woff?url';
import ext700i from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-700-italic.woff?url';
import greek400 from '@fontsource/inter/files/inter-greek-400-normal.woff?url';
import greek400i from '@fontsource/inter/files/inter-greek-400-italic.woff?url';
import greek700 from '@fontsource/inter/files/inter-greek-700-normal.woff?url';
import greek700i from '@fontsource/inter/files/inter-greek-700-italic.woff?url';
import poly400 from '@fontsource/inter/files/inter-greek-ext-400-normal.woff?url';
import poly400i from '@fontsource/inter/files/inter-greek-ext-400-italic.woff?url';
import poly700 from '@fontsource/inter/files/inter-greek-ext-700-normal.woff?url';
import poly700i from '@fontsource/inter/files/inter-greek-ext-700-italic.woff?url';
import sans400 from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import sans700 from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import hebrew400 from '@fontsource/noto-serif-hebrew/files/noto-serif-hebrew-hebrew-400-normal.woff?url';
import hebrew700 from '@fontsource/noto-serif-hebrew/files/noto-serif-hebrew-hebrew-700-normal.woff?url';
import { CALLOUT_BAR, readManuscript } from './model.js';

/**
 * A manuscript as a PDF (11.0), made in the browser: Letter pages with one-inch margins, Source Serif text, page
 * numbers, footnotes gathered as Notes at the end, then the bibliography and the Bible publishers' notices. The
 * fonts come in pieces by alphabet, so each stretch of text is set in the piece that has its letters: Latin (and
 * accented Latin) in Source Serif, Greek (with breathings and accents) in Inter, Hebrew in Noto Serif Hebrew.
 */

const abs = (u) => new URL(u, location.href).href;
const FAMILIES = {
  Serif: [serif400, serif700, serif400i, serif700i],
  SerifExt: [ext400, ext700, ext400i, ext700i],
  Greek: [greek400, greek700, greek400i, greek700i],
  GreekExt: [poly400, poly700, poly400i, poly700i],
  Sans: [sans400, sans700, sans400, sans700],
  Hebrew: [hebrew400, hebrew700, hebrew400, hebrew700],
};

const LATIN = /[\u0000-ÿıŒœʻʼˆ˚˜ -⁯€™↑↓−∕﻿�]/;
const LATIN_EXT = /[Ā-˿ᴀ-ᶿḀ-ỿ₠-⃄ℓⱠ-Ɀ꜠-ꟿ]/;
const GREEK = /[Ͱ-Ͽ]/;
const GREEK_EXT = /[ἀ-῿]/;
const HEBREW = /[֐-׿יִ-ﭏ]/;
const MARK = /\p{M}/u;
const familyOf = (ch, prev) => {
  if (MARK.test(ch) && prev) return prev; // an accent stays with its letter
  if (LATIN.test(ch)) return 'Serif';
  if (GREEK.test(ch)) return 'Greek';
  if (GREEK_EXT.test(ch)) return 'GreekExt';
  if (HEBREW.test(ch)) return 'Hebrew';
  if (LATIN_EXT.test(ch)) return 'SerifExt';
  return 'Serif';
};
// A phrase of several Hebrew words reads right to left: its words go in the other order (each word's own letters
// are turned around by the font engine).
const HEBREW_PHRASE = /[֐-׿יִ-ﭏ]+(?:[  ]+[֐-׿יִ-ﭏ]+)+/g;
const visual = (text) => text.replace(HEBREW_PHRASE, (m) => m.split(/([  ]+)/).reverse().join(''));

class Writer {
  constructor(size) {
    this.size = size;
    this.used = new Set(['Serif']);
  }

  /** One run as pdfmake text pieces, split where the alphabet changes. */
  pieces(r) {
    const base = {
      bold: !!r.b, italics: !!r.i,
      decoration: [r.u || r.link ? 'underline' : null, r.s ? 'lineThrough' : null].filter(Boolean),
      color: r.link ? '#2F5D86' : r.color ? `#${r.color}` : undefined,
      background: r.highlight ? `#${r.highlight}` : undefined,
      link: r.link || undefined,
      sup: r.sup ? true : undefined, sub: r.sub ? true : undefined,
      fontSize: r.small ? Math.round(this.size * 0.78) : undefined,
      characterSpacing: r.small ? 0.6 : undefined,
    };
    if (!base.decoration.length) delete base.decoration;
    for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
    if (r.code) { this.used.add('Sans'); return [{ ...base, text: r.text, font: 'Sans', fontSize: Math.round(this.size * 0.88), preserveLeadingSpaces: true }]; }
    const out = [];
    let cur = '';
    let fam = null;
    for (const ch of visual(r.text)) {
      const f = familyOf(ch, fam);
      if (f !== fam && cur) { out.push({ ...base, text: cur, font: fam }); cur = ''; }
      fam = f;
      cur += ch;
    }
    if (cur) out.push({ ...base, text: cur, font: fam });
    for (const p of out) this.used.add(p.font);
    return out;
  }

  text(runs) {
    const t = runs.flatMap((r) => this.pieces(r));
    return t.length ? t : [{ text: ' ' }];
  }

  /** A left bar down the side of a block (a color-coded element, a quotation or a callout). */
  barred(node, color, last) {
    return {
      table: { widths: ['*'], body: [[{ ...node, margin: [0, 0, 0, 0] }]] },
      layout: {
        hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => `#${color}`,
        paddingLeft: () => 9, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => (last ? 0 : Math.round(this.size * 0.55)),
      },
      margin: [0, 0, 0, last ? Math.round(this.size * 0.55) : 0],
    };
  }

  blocks(list) {
    const out = [];
    const after = Math.round(this.size * 0.55);
    list.forEach((b, i) => {
      const next = list[i + 1];
      const left = (b.indent ?? 0) * 24;
      let node;
      switch (b.t) {
        case 'h': {
          const scale = [1.4, 1.22, 1.08, 1, 1, 1][b.level - 1];
          node = { text: this.text(b.runs.map((r) => ({ ...r, b: b.level <= 4 || r.b, i: b.level >= 4 || r.i }))), fontSize: Math.round(this.size * scale), headlineLevel: b.level, margin: [0, Math.round(this.size * (b.level <= 2 ? 1.1 : 0.7)), 0, Math.round(this.size * 0.35)] };
          if (b.level <= 2) node.color = '#1C2B3A';
          break;
        }
        case 'label':
          node = { text: this.text([{ text: b.text, b: true, small: true, color: b.color }]), headlineLevel: 9, margin: [left, 2, 0, 2] };
          break;
        case 'p':
          node = { text: this.text(b.runs), alignment: b.align ?? undefined, margin: [left, 0, 0, after], lineHeight: 1.18 };
          break;
        case 'li': {
          const level = b.level ?? 0;
          node = {
            columns: [
              { width: 22 + level * 22, text: b.marker ?? '', alignment: 'right', margin: [0, 0, 6, 0], font: 'Serif' },
              { width: '*', text: this.text(b.runs), lineHeight: 1.18 },
            ],
            columnGap: 0,
            margin: [0, 0, 0, next?.t === 'li' ? Math.round(after / 2) : after],
          };
          break;
        }
        case 'pre':
          this.used.add('Sans');
          node = { text: b.lines.join('\n'), font: 'Sans', fontSize: Math.round(this.size * 0.82), preserveLeadingSpaces: true, margin: [left + 18, 0, 0, after], lineHeight: 1.1 };
          break;
        case 'hr':
          node = { text: '*      *      *', alignment: 'center', margin: [0, 4, 0, after + 4] };
          break;
        case 'img': {
          const w = Math.min(b.w * 0.75, 468 - left);
          node = { image: `data:image/png;base64,${base64(b.png)}`, width: w, alignment: 'center', margin: [left, 0, 0, after] };
          break;
        }
        case 'table':
          node = this.table(b, after);
          break;
        default:
          return;
      }
      if (b.stripe) {
        const joins = next?.stripe === b.stripe;
        node = this.barred(node, b.stripe, !joins);
        if (b.t === 'p' || b.t === 'li') node.table.body[0][0].margin = [0, 0, 0, 0];
      }
      out.push(node);
    });
    return out;
  }

  table(b, after) {
    const cols = Math.max(...b.rows.map((r) => r.reduce((n, c) => n + c.span, 0)));
    const widths = b.widths && b.widths.length === cols ? b.widths.map((w) => `${w}%`) : Array(cols).fill('*');
    const body = b.rows.map((r) => {
      const row = [];
      for (const c of r) {
        const stack = this.blocks(c.blocks.map((x) => ({ ...x, indent: 0, ...(c.head && x.runs ? { runs: x.runs.map((r) => ({ ...r, b: true })) } : {}) })));
        row.push({ stack: stack.length ? stack : [{ text: ' ' }], colSpan: c.span > 1 ? c.span : undefined, fillColor: c.head ? '#F1EEE8' : undefined, bold: c.head || undefined });
        for (let k = 1; k < c.span; k++) row.push({});
      }
      while (row.length < cols) row.push({ text: ' ' });
      return row;
    });
    return { table: { widths, body, headerRows: b.rows[0]?.every((c) => c.head) ? 1 : 0 }, layout: { hLineColor: () => '#CFC8BC', vLineColor: () => '#CFC8BC', paddingTop: () => 4, paddingBottom: () => 0 }, margin: [0, 0, 0, after], fontSize: Math.round(this.size * 0.92) };
  }
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The PDF for a note's html: { title, subtitle, size (points, 12 by default) }. Resolves a Blob.
 */
export async function pdfDocument(html, { title = '', subtitle = '', size = 12 } = {}) {
  const m = await readManuscript(html, { title });
  const w = new Writer(size);
  const content = [];
  if (title) content.push({ text: w.text([{ text: title, b: true }]), fontSize: Math.round(size * 1.75), color: '#1C2B3A', margin: [0, 0, 0, subtitle ? 2 : 14] });
  if (subtitle) content.push({ text: w.text([{ text: subtitle }]), color: '#5B6875', fontSize: Math.round(size * 0.92), margin: [0, 0, 0, 16] });
  content.push(...w.blocks(m.blocks));
  if (m.notes.length) {
    content.push({ text: 'Notes', bold: true, fontSize: Math.round(size * 1.08), margin: [0, 18, 0, 6], headlineLevel: 3 });
    for (const n of m.notes) {
      content.push({ columns: [{ width: 22, text: `${n.n}.`, alignment: 'right', margin: [0, 0, 6, 0] }, { width: '*', text: w.text(n.runs) }], columnGap: 0, fontSize: Math.round(size * 0.85), margin: [0, 0, 0, 4] });
    }
  }
  if (m.bibliography.length) {
    content.push({ text: 'Bibliography', bold: true, fontSize: Math.round(size * 1.08), margin: [0, 18, 0, 6], headlineLevel: 3 });
    for (const e of m.bibliography) content.push({ text: w.text(e), margin: [24, 0, 0, 6], leadingIndent: -24, fontSize: Math.round(size * 0.92) });
  }
  for (const notice of m.copyrights) content.push({ text: w.text([{ text: notice }]), fontSize: Math.max(8, Math.round(size * 0.72)), color: '#5B6875', margin: [0, 12, 0, 0] });

  const fonts = {};
  for (const f of w.used) {
    const [normal, bold, italics, bolditalics] = FAMILIES[f].map(abs);
    fonts[f] = { normal, bold, italics, bolditalics };
  }
  pdfMake.addFonts(fonts);
  // Only this site's own font files are fetched.
  pdfMake.setUrlAccessPolicy((url) => url.startsWith(`${location.origin}/`));
  const doc = pdfMake.createPdf({
    info: { title: title || 'Untitled', creator: 'Selah' },
    pageSize: 'LETTER',
    pageMargins: [72, 66, 72, 66],
    defaultStyle: { font: 'Serif', fontSize: size, lineHeight: 1.12 },
    // A heading (or an element's name) never sits alone at the foot of a page.
    pageBreakBefore: (node, following) => !!node.headlineLevel && following.length === 0,
    footer: (page, count) => ({ text: count > 1 ? String(page) : '', alignment: 'center', fontSize: 9, color: '#5B6875', margin: [0, 24, 0, 0] }),
    content,
  });
  return doc.getBlob();
}
