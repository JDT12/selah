import { escapeHtml } from './html.js';

/**
 * A small RTF reader, enough for documents exported from Logos (Sermon Builder) and from Word: paragraphs, headings
 * (by style or outline level), bold/italic/underline/superscript, links (HYPERLINK fields), line breaks, and lists
 * (numbered "1.<tab>" paragraphs indented by \li, or Word's \listtext markers). Pictures, tables' layout, fonts and
 * colors are left out. Returns { blocks, images }, blocks being [{ type: 'p' | 'h' | 'li', level, ordered, html,
 * text, border }].
 */

// Destinations whose text isn't part of the document.
const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'header', 'headerl', 'headerr', 'headerf', 'footer',
  'footerl', 'footerr', 'footerf', 'pict', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'revtbl', 'filetbl',
  'bkmkstart', 'bkmkend', 'fldinst', 'annotation', 'atnid', 'atnauthor', 'footnote', 'pntext', 'listtext', 'pntxta', 'pntxtb']);

const SYMBOLS = {
  endash: '–', emdash: '—', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', tab: '\t',
  emspace: ' ', enspace: ' ', qmspace: ' ',
};

// Windows-1252's 0x80–0x9F (the rest of \'hh is Latin-1).
const CP1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
const byteChar = (n) => CP1252[n] ?? String.fromCharCode(n);

const LIST_MARK = /^\s*(?:(\d{1,3}|[a-z]|[ivxlc]{1,6})[.)]|([•·o▪◦-]))\t/i;

export function rtfToBlocks(rtf) {
  const src = String(rtf);
  if (!/^\s*\{\\rtf/.test(src)) throw Object.assign(new Error('That isn’t an RTF file'), { statusCode: 400 });
  const styles = new Map(); // style number -> heading level
  const blocks = [];
  let images = 0;

  // Character state, kept per group.
  const fresh = () => ({ b: false, i: false, u: false, sup: false, sub: false, skip: false, uc: 1, field: null, fldrslt: false, style: null, styleName: false });
  let st = fresh();
  const stack = [];
  // Paragraph state (reset by \pard).
  let para = { style: 0, li: 0, outline: null, border: false, list: null, ilvl: null };
  let runs = []; // [{ text, b, i, u, sup, sub, href }]
  let pendingSkip = 0; // characters to skip after \u
  let styleText = '';

  const addText = (text) => {
    if (!text) return;
    if (st.skip) {
      if (st.style !== null) styleText += text;
      if (st.fieldInst) st.fieldInst.value += text;
      if (st.listText) st.listText.value += text;
      return;
    }
    const href = linkOf();
    const last = runs[runs.length - 1];
    const fmt = { b: st.b, i: st.i, u: st.u && !href, sup: st.sup, sub: st.sub, href };
    if (last && ['b', 'i', 'u', 'sup', 'sub', 'href'].every((k) => last[k] === fmt[k])) last.text += text;
    else runs.push({ text, ...fmt });
  };
  const linkOf = () => {
    for (let k = stack.length; k >= 0; k -= 1) {
      const s = k === stack.length ? st : stack[k];
      if (s.fldrslt && s.field?.href) return s.field.href;
    }
    return null;
  };

  const endPara = () => {
    const text = runs.map((r) => r.text).join('');
    const level = para.outline != null ? para.outline + 1 : styles.get(para.style) ?? 0;
    let html = runsHtml(runs);
    let type = level ? 'h' : 'p';
    let ordered = false;
    let depth = 0;
    const mark = LIST_MARK.exec(text);
    if (type === 'p' && (mark || para.list)) {
      type = 'li';
      ordered = mark ? !!mark[1] : para.list === 'ol';
      depth = para.ilvl ?? Math.max(0, Math.round(para.li / 360) - 1);
      if (mark) html = stripLead(html, mark[0].length);
    }
    blocks.push({ type, level: type === 'h' ? Math.min(level, 6) : depth, ordered, html: html.trim(), text: (mark ? text.slice(mark[0].length) : text).trim(), border: para.border });
    runs = [];
    para = { ...para, list: null };
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '{') { stack.push(st); st = { ...st, style: null, fieldInst: null, listText: null }; i += 1; continue; }
    if (c === '}') {
      if (st.style !== null) {
        const name = styleText.replace(/;\s*$/, '').trim();
        const h = /heading\s*(\d)/i.exec(name);
        if (h) styles.set(st.style, Number(h[1]));
        styleText = '';
      }
      if (st.fieldInst) {
        const m = /HYPERLINK\s+"([^"]+)"/i.exec(st.fieldInst.value);
        if (m && st.field) st.field.href = m[1];
      }
      if (st.listText) para.list = /\d/.test(st.listText.value) ? 'ol' : 'ul';
      st = stack.pop() ?? fresh();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') { i += 1; continue; }
    if (c !== '\\') {
      let j = i;
      while (j < n && !'\\{}\r\n'.includes(src[j])) j += 1;
      let text = src.slice(i, j);
      if (pendingSkip) { const k = Math.min(pendingSkip, text.length); text = text.slice(k); pendingSkip -= k; }
      addText(text);
      i = j;
      continue;
    }
    // A control word or symbol.
    const next = src[i + 1];
    if (next === '\\' || next === '{' || next === '}') { addText(next); i += 2; continue; }
    if (next === '\'') {
      const code = parseInt(src.slice(i + 2, i + 4), 16);
      if (pendingSkip) pendingSkip -= 1; else addText(byteChar(code));
      i += 4;
      continue;
    }
    if (next === '~') { addText(' '); i += 2; continue; }
    if (next === '-' || next === '_') { addText(next === '_' ? '‑' : ''); i += 2; continue; }
    if (next === '*') { st.skip = st.skip || 'star'; i += 2; continue; }
    if (next === '\r' || next === '\n') { if (!st.skip) endPara(); i += 2; continue; }
    const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 46));
    if (!m) { i += 2; continue; }
    i += 1 + m[0].length;
    const word = m[1];
    const arg = m[2] != null ? Number(m[2]) : null;
    const on = arg !== 0;

    // Inside a skipped destination only the field instruction and style names matter.
    if (st.skip === 'star' && word === 'fldinst') { st.fieldInst = { value: '' }; continue; }
    if (word === 'fldinst') { st.skip = true; st.fieldInst = { value: '' }; continue; }
    if (word === 'field') { st.field = { href: null, skipped: !!st.skip }; continue; }
    // A field's result is text, unless the field sits in a skipped part (a footer's link).
    if (word === 'fldrslt') { st.skip = st.field?.skipped ?? st.skip; st.fldrslt = true; continue; }
    if (word === 'stylesheet') { st.skip = true; st.inStylesheet = true; continue; }
    if (st.inStylesheet && word === 's' && arg != null) { st.style = arg; styleText = ''; continue; }
    if (word === 'listtext' || word === 'pntext') {
      // Word's list marker for this paragraph ("1." or a bullet), read when its group ends.
      st.skip = true;
      st.listText = { value: '' };
      continue;
    }
    if (word === 'pict') { images += 1; st.skip = true; continue; }
    if (SKIP.has(word)) { st.skip = true; continue; }
    if (st.skip) continue;
    if (word === 'u' && arg != null) {
      addText(String.fromCodePoint(arg < 0 ? arg + 65536 : arg));
      pendingSkip = st.uc;
      continue;
    }
    switch (word) {
      case 'uc': st.uc = arg ?? 1; break;
      case 'par': case 'sect': case 'page': case 'row': endPara(); break;
      case 'line': addText('\n'); break;
      case 'cell': addText(' · '); break;
      case 'pard': para = { style: 0, li: 0, outline: null, border: false, list: null, ilvl: null }; break;
      case 's': para.style = arg ?? 0; break;
      case 'li': para.li = arg ?? 0; break;
      case 'outlinelevel': para.outline = arg; break;
      case 'ilvl': para.ilvl = arg; break;
      case 'ls': if (para.list !== 'ol' && para.list !== 'ul') para.list = 'ul'; break;
      case 'pnlvlbody': case 'pndec': para.list = 'ol'; break;
      case 'pnlvlblt': para.list = 'ul'; break;
      case 'brdrb': case 'brdrt': para.border = true; break;
      case 'b': st.b = on; break;
      case 'i': st.i = on; break;
      case 'ul': st.u = on; break;
      case 'ulnone': st.u = false; break;
      case 'super': st.sup = on; break;
      case 'sub': st.sub = on; break;
      case 'nosupersub': st.sup = false; st.sub = false; break;
      case 'plain': Object.assign(st, { b: false, i: false, u: false, sup: false, sub: false }); break;
      default:
        if (SYMBOLS[word]) addText(SYMBOLS[word]);
    }
  }
  if (runs.length) endPara();
  return { blocks: blocks.filter((b) => b.type === 'p' || b.text), images };
}

/** Runs as inline HTML. Two line breaks in a row start a new paragraph (Logos sets verses apart that way). */
function runsHtml(runs) {
  return runs.map((r) => {
    let h = escapeHtml(r.text).replace(/\t/g, ' ').replace(/\n/g, '<br>');
    if (r.sup) h = `<sup>${h}</sup>`;
    if (r.sub) h = `<sub>${h}</sub>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.href) h = `<a href="${escapeHtml(r.href)}" target="_blank" rel="noopener noreferrer">${h}</a>`;
    return h;
  }).join('').replace(/<\/(strong|em|u|sup|sub)><\1>/g, '');
}

/** Drops the first `count` characters of text (a list marker) from inline HTML. */
function stripLead(html, count) {
  let left = count;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, text) => {
    if (tag || left <= 0) return m;
    const plain = text.replace(/&(amp|lt|gt|quot);/g, '_');
    if (plain.length <= left) { left -= plain.length; return ''; }
    // Entities only appear past the marker, so slicing the raw text by the plain count is safe here.
    const out = text.slice(left);
    left = 0;
    return out;
  }).replace(/^(\s|<(strong|em|u)>\s*<\/\2>)+/, '');
}

/** Blocks as note HTML: headings, paragraphs (split at blank lines) and nested lists. */
export function blocksToHtml(blocks) {
  let out = '';
  const open = []; // stack of 'ol' | 'ul'
  const closeTo = (depth) => {
    while (open.length > depth) out += `</li></${open.pop()}>`;
  };
  for (const b of blocks) {
    if (b.type !== 'li') {
      closeTo(0);
      if (b.type === 'h') out += `<h${b.level}>${b.html}</h${b.level}>`;
      else if (b.text.replace(/\u00a0/g, '').trim()) {
        out += b.html.split(/(?:<br>\s*){2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/^(<br>)+|(<br>)+$/g, '')}</p>`).join('');
      }
      continue;
    }
    const depth = b.level + 1;
    const tag = b.ordered ? 'ol' : 'ul';
    if (open.length >= depth) {
      closeTo(depth);
      if (open[depth - 1] !== tag) { out += `</li></${open.pop()}><${tag}>`; open.push(tag); } else out += '</li>';
      out += `<li><p>${b.html}</p>`;
      continue;
    }
    // Deeper: open lists down to this depth (a skipped level gets an empty item to hang from).
    while (open.length < depth) {
      if (open.length && open.length < depth - 1) { out += `<${tag}><li><p></p>`; open.push(tag); continue; }
      out += `<${tag}>`;
      open.push(tag);
      if (open.length < depth) out += '<li><p></p>';
    }
    out += `<li><p>${b.html}</p>`;
  }
  closeTo(0);
  return out;
}
