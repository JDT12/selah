import { readManuscript } from './model.js';

/**
 * A manuscript as rich text (.rtf, 11.0): opens in Word, Pages, LibreOffice and WordPad. Georgia, Letter pages with
 * one-inch margins, page numbers, real footnotes, lists numbered the way the editor numbers them (written out, so
 * every program shows the same numbers), color-coded elements as a colored bar down the left.
 */

const TWIP = 20; // per point

/** Text for RTF: its special characters escaped and anything past ASCII as \uN (with ? for old readers). */
function esc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ch = text[i];
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (ch === '\t') out += '\\tab ';
    else if (c < 0x80) out += ch;
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

class Writer {
  constructor(size, notes) {
    this.half = size * 2; // RTF font sizes are in half points
    this.size = size;
    this.notes = new Map(notes.map((n) => [n.n, n.runs]));
    this.colors = [];
  }

  color(hex) {
    const k = hex.toUpperCase();
    let i = this.colors.indexOf(k);
    if (i < 0) { this.colors.push(k); i = this.colors.length - 1; }
    return i + 1; // 0 is "auto"
  }

  runs(list, { footnotes = true } = {}) {
    return list.map((r) => {
      if (r.note && footnotes) {
        const body = this.runs(this.notes.get(r.note) ?? [], { footnotes: false });
        return `{\\super\\chftn}{\\footnote\\pard\\plain\\f0\\fs${Math.round(this.half * 0.83)}\\sa60 {\\super\\chftn} ${body}}`;
      }
      let fmt = '';
      if (r.b) fmt += '\\b';
      if (r.i) fmt += '\\i';
      if (r.u || r.link) fmt += '\\ul';
      if (r.s) fmt += '\\strike';
      if (r.sup) fmt += '\\super';
      if (r.sub) fmt += '\\sub';
      if (r.code) fmt += `\\f1\\fs${Math.round(this.half * 0.85)}`;
      if (r.small) fmt += `\\fs${Math.round(this.half * 0.78)}\\expnd2`;
      if (r.link) fmt += `\\cf${this.color('2F5D86')}`;
      else if (r.color) fmt += `\\cf${this.color(r.color)}`;
      if (r.highlight) fmt += `\\highlight${this.color(r.highlight)}\\chcbpat${this.color(r.highlight)}`;
      const body = `{${fmt}${fmt ? ' ' : ''}${esc(r.text)}}`;
      return r.link ? `{\\field{\\*\\fldinst{HYPERLINK "${r.link.replace(/["\\{}]/g, '')}"}}{\\fldrslt ${body}}}` : body;
    }).join('');
  }

  /** \pard with the usual spacing, plus a left indent, alignment, and a colored bar. */
  pard(b = {}, extra = '', intbl = false) {
    const after = Math.round(this.size * 0.55 * TWIP);
    let s = `\\pard\\plain${intbl ? '\\intbl' : ''}\\f0\\fs${this.half}\\sa${b.after ?? after}\\sl276\\slmult1`;
    if (b.indent) s += `\\li${b.indent * 480}`;
    if (b.align === 'center') s += '\\qc';
    else if (b.align === 'right') s += '\\qr';
    else if (b.align === 'justify') s += '\\qj';
    if (b.stripe) s += `\\brdrl\\brdrs\\brdrw40\\brsp160\\brdrcf${this.color(b.stripe)}`;
    return s + extra;
  }

  blocks(list, intbl = false) {
    const out = [];
    list.forEach((b, i) => {
      const next = list[i + 1];
      switch (b.t) {
        case 'h': {
          const scale = [1.4, 1.22, 1.08, 1, 1, 1][b.level - 1];
          const before = Math.round(this.size * (b.level <= 2 ? 1.1 : 0.7) * TWIP);
          const runs = b.runs.map((r) => ({ ...r, b: b.level <= 4 || r.b, i: b.level >= 4 || r.i }));
          out.push(`${this.pard({ after: Math.round(this.size * 0.35 * TWIP) }, `\\keepn\\sb${before}\\outlinelevel${b.level - 1}`, intbl)}{\\fs${Math.round(this.half * scale)} ${this.runs(runs)}}\\par`);
          break;
        }
        case 'label':
          out.push(`${this.pard({ ...b, after: 40 }, '\\keepn\\sb40', intbl)}${this.runs([{ text: b.text, b: true, small: true, color: b.color }])}\\par`);
          break;
        case 'p':
          out.push(`${this.pard(b, '', intbl)} ${this.runs(b.runs)}\\par`);
          break;
        case 'li': {
          const left = 480 + (b.level ?? 0) * 480;
          const after = next?.t === 'li' ? Math.round(this.size * 0.28 * TWIP) : undefined;
          out.push(b.marker != null
            ? `${this.pard({ stripe: b.stripe, after }, `\\li${left}\\fi-360\\tx${left}`, intbl)} ${esc(b.marker)}\\tab ${this.runs(b.runs)}\\par`
            : `${this.pard({ stripe: b.stripe, after }, `\\li${left}`, intbl)} ${this.runs(b.runs)}\\par`);
          break;
        }
        case 'pre':
          out.push(`${this.pard({ indent: (b.indent ?? 0) + 1 }, '', intbl)}{\\f1\\fs${Math.round(this.half * 0.82)} ${b.lines.map(esc).join('\\line ')}}\\par`);
          break;
        case 'hr':
          out.push(`${this.pard({ align: 'center' }, '', intbl)} *\\tab *\\tab *\\par`);
          break;
        case 'img': {
          const hex = Array.from(b.png, (x) => x.toString(16).padStart(2, '0')).join('');
          out.push(`${this.pard({ align: 'center' }, '', intbl)}{\\pict\\pngblip\\picw${b.w}\\pich${b.h}\\picwgoal${b.w * 15}\\pichgoal${b.h * 15} ${hex}}\\par`);
          break;
        }
        case 'table':
          if (!intbl) out.push(this.table(b));
          break;
        default:
      }
    });
    return out.join('\n');
  }

  table(b) {
    const width = 9360; // 6.5 inches of text
    const cols = Math.max(...b.rows.map((r) => r.reduce((n, c) => n + c.span, 0)));
    const pct = b.widths && b.widths.length === cols ? b.widths : Array(cols).fill(100 / cols);
    const border = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
    return b.rows.map((r) => {
      let edge = 0;
      let col = 0;
      let defs = '\\trowd\\trgaph108\\trleft0';
      for (const c of r) {
        edge += Math.round(pct.slice(col, col + c.span).reduce((a, x) => a + x, 0) / 100 * width);
        col += c.span;
        defs += `${border}${c.head ? `\\clcbpat${this.color('F1EEE8')}` : ''}\\cellx${edge}`;
      }
      const cells = r.map((c) => {
        const blocks = c.blocks.filter((x) => x.t !== 'table').map((x) => ({ ...x, indent: 0, stripe: null, ...(c.head ? { runs: x.runs?.map((y) => ({ ...y, b: true })) } : {}) }));
        const body = blocks.length ? this.blocks(blocks, true) : `${this.pard({}, '', true)}\\par`;
        return body.replace(/\\par$/, '\\cell');
      }).join('\n');
      return `${defs}\n${cells}\n\\row`;
    }).join('\n') + '\n\\pard\\plain\\par';
  }
}

/** The .rtf for a note's html: { title, subtitle, size (points) }. Resolves a Blob. */
export async function rtfDocument(html, { title = '', subtitle = '', size = 12 } = {}) {
  const m = await readManuscript(html, { title });
  const w = new Writer(size, m.notes);
  const parts = [];
  if (title) parts.push(`${w.pard({ after: subtitle ? 40 : 280 })}{\\b\\fs${Math.round(size * 2 * 1.75)}\\cf${w.color('1C2B3A')} ${esc(title)}}\\par`);
  if (subtitle) parts.push(`${w.pard({ after: 320 })}{\\fs${Math.round(size * 2 * 0.92)}\\cf${w.color('5B6875')} ${esc(subtitle)}}\\par`);
  parts.push(w.blocks(m.blocks));
  if (m.bibliography.length) {
    parts.push(`${w.pard({ after: 120 }, '\\keepn\\sb360')}{\\b\\fs${Math.round(size * 2 * 1.08)} Bibliography}\\par`);
    for (const e of m.bibliography) parts.push(`${w.pard({ after: 120 }, '\\li720\\fi-720')}{\\fs${Math.round(size * 2 * 0.92)} ${w.runs(e, { footnotes: false })}}\\par`);
  }
  for (const notice of m.copyrights) parts.push(`${w.pard({}, '\\sb240')}{\\fs${Math.max(16, Math.round(size * 2 * 0.72))}\\cf${w.color('5B6875')} ${esc(notice)}}\\par`);

  const body = parts.join('\n');
  const colortbl = `{\\colortbl;${w.colors.map((h) => `\\red${parseInt(h.slice(0, 2), 16)}\\green${parseInt(h.slice(2, 4), 16)}\\blue${parseInt(h.slice(4, 6), 16)};`).join('')}}`;
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1',
    '{\\fonttbl{\\f0\\froman\\fcharset0 Georgia;}{\\f1\\fmodern\\fcharset0 Consolas;}}',
    colortbl,
    `{\\info{\\title ${esc(title || 'Untitled')}}{\\author Selah}}`,
    '\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\widowctrl\\ftnbj\\aftnnar',
    `{\\footer\\pard\\plain\\qc\\f0\\fs18\\chpgn\\par}`,
    body,
    '}',
  ].join('\n');
  return new Blob([rtf], { type: 'application/rtf' });
}
