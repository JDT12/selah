import { editField, field, fieldOut, textHtml, uid, words } from './sermon.js';
import { findReferences, logosUrl, parse } from '../../shared/scripture.js';

/**
 * A teaching lesson, read as the lesson builder sees it and written back without losing anything else in it. The
 * steps are Lawrence Richards's Hook, Book, Look, Took (Creative Bible Teaching), in the user's own lesson layout:
 *
 *   **Title: Fear God**
 *   **Verses:** [passage link]
 *   # Introduction (Hook)     paragraphs, then the passage link (present mode reads the text there)
 *   # Exposition (Book)       **Big idea:** …, then the outline as a numbered list with sub-points, which section
 *                             headings (Heading 2) can split
 *   # Inquisition (Look)      discussion questions as a numbered list
 *   # Application (Took)      paragraphs
 *
 * A part is rewritten only when the builder changed it; outline points keep their own formatting (bold, highlights
 * for handout blanks, links) as long as their text is the same.
 */
export const PARTS = [
  { key: 'hook', title: 'Introduction (Hook)', label: 'Hook', match: /hook|^introduction/i },
  { key: 'book', title: 'Exposition (Book)', label: 'Book', match: /\bbook\b|exposition/i },
  { key: 'look', title: 'Inquisition (Look)', label: 'Look', match: /\blook\b|inquisition|discussion/i },
  { key: 'took', title: 'Application (Took)', label: 'Took', match: /\btook\b|application/i },
];

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const outerOf = (n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '');
const outer = (nodes) => nodes.map(outerOf).join('');
const isBlank = (n) => (n.nodeType === 3 && !n.textContent.trim()) || (n.nodeType === 1 && n.tagName === 'P' && !n.textContent.trim() && !n.querySelector('img'));
const isList = (n) => n?.nodeType === 1 && (n.tagName === 'OL' || n.tagName === 'UL');
const isH2 = (n) => n?.nodeType === 1 && n.tagName === 'H2';
const headKey = (text) => `h:${norm(text)}`;
const BIG = /^\s*big idea\s*:\s*/i;

function cut(nodes, tag) {
  const lead = [];
  const parts = [];
  for (const n of nodes) {
    if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
    else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
  }
  return { lead, parts };
}

/** A paragraph that is only a passage (a Logos link or plain text). */
function passageOfP(n) {
  if (n?.nodeType !== 1 || n.tagName !== 'P') return '';
  const t = n.textContent.trim();
  const p = parse(t);
  return p.refs.length && !p.errors.length && n.querySelectorAll('a').length <= 1 ? t : '';
}

/** The passage as a Logos link (what the lesson layout uses), or plain text when it isn't a reference. */
export function passageLink(passage, bold = false) {
  const p = String(passage ?? '').trim();
  const r = parse(p).refs[0];
  const text = bold ? `<strong>${esc(p)}</strong>` : esc(p);
  return r ? `<a target="_blank" rel="noreferrer" href="${esc(logosUrl(r, 'esv'))}">${text}</a>` : text;
}

// ---------- outlines (nested numbered lists) ----------

/** A list as outline lines: [{ id, level, text }], and each line's own inline HTML by its text. */
function listLines(list, level = 0, out = [], inline = new Map()) {
  for (const li of [...list.children].filter((x) => x.tagName === 'LI')) {
    const own = [...li.childNodes].filter((n) => !isList(n));
    const text = own.map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const html = own.map((n) => (n.nodeType === 1 && n.tagName === 'P' ? n.innerHTML : outerOf(n))).join(' ').trim();
    out.push({ id: uid(), level, text });
    if (text) inline.set(norm(text), html);
    for (const sub of [...li.children].filter(isList)) listLines(sub, level + 1, out, inline);
  }
  return out;
}
const linesKey = (lines) => JSON.stringify(lines.filter((l) => l.text.trim()).map((l) => (l.heading ? ['h', l.text.trim()] : [l.level, l.text.trim()])));

/** Each line at most one level deeper than the one before it; a section heading starts again at the top level. */
export function tidyLevels(lines) {
  let prev = -1;
  return lines.map((l) => {
    if (l.heading) {
      prev = -1;
      return l.level === 0 ? l : { ...l, level: 0 };
    }
    const level = Math.max(0, Math.min(l.level, prev + 1));
    prev = level;
    return level === l.level ? l : { ...l, level };
  });
}

function linesHtml(lines, inline, tag) {
  const all = tidyLevels(lines.filter((l) => l.text.trim()));
  if (!all.length) return `<${tag}><li><p></p></li></${tag}>`;
  // Section headings split the outline: a Heading 2, then its own numbered list.
  const groups = [];
  for (const l of all) {
    if (l.heading || !groups.length) groups.push({ heading: l.heading ? l : null, lines: [] });
    if (!l.heading) groups[groups.length - 1].lines.push(l);
  }
  const head = (h) => `<h2>${inline.get(headKey(h.text)) ?? esc(h.text.trim())}</h2>`;
  return groups.map((g) => (g.heading ? head(g.heading) : '') + (g.lines.length ? nestedList(g.lines, inline, tag) : '')).join('');
}

function nestedList(kept, inline, tag) {
  let i = 0;
  const build = (level) => {
    let h = `<${tag}>`;
    while (i < kept.length && kept[i].level === level) {
      const l = kept[i++];
      h += `<li><p>${inline.get(norm(l.text)) ?? esc(l.text.trim())}</p>`;
      if (i < kept.length && kept[i].level > level) h += build(level + 1);
      h += '</li>';
    }
    return `${h}</${tag}>`;
  };
  let h = '';
  while (i < kept.length) h += build(kept[i].level);
  return h;
}

/**
 * A Book or Look section: what's above its outline, the outline as lines, and anything after it. The outline is the
 * first list with the section headings and lists that follow it (and any headings just above it).
 */
function listSection(nodes, { big = false } = {}) {
  const gap = (n) => isH2(n) || isBlank(n);
  let at = nodes.findIndex(isList);
  if (at < 0) at = nodes.findIndex(isH2);
  let end = at + 1;
  if (at >= 0) {
    while (at > 0 && gap(nodes[at - 1])) at -= 1;
    while (end < nodes.length && (isList(nodes[end]) || gap(nodes[end]))) end += 1;
    // Headings with more of the note after them (and no list of their own) stay with what follows.
    const more = nodes.slice(end).some((n) => !isBlank(n));
    while (end > at + 1 && (isBlank(nodes[end - 1]) || (more && isH2(nodes[end - 1])))) end -= 1;
    while (at < end && isBlank(nodes[at])) at += 1;
  }
  const before = at < 0 ? nodes : nodes.slice(0, at);
  let bigIdea = null;
  const lead = before.filter((n) => {
    if (big && !bigIdea && n.nodeType === 1 && n.tagName === 'P' && BIG.test(n.textContent)) {
      const text = n.textContent.replace(BIG, '').trim();
      bigIdea = { text, original: text, html: n.outerHTML };
      return false;
    }
    return true;
  });
  const run = at < 0 ? [] : nodes.slice(at, end);
  const list = run.find(isList) ?? null;
  const inline = new Map();
  const lines = [];
  for (const n of run) {
    if (isList(n)) listLines(n, 0, lines, inline);
    else if (isH2(n) && n.textContent.trim()) {
      const text = n.textContent.replace(/\s+/g, ' ').trim();
      lines.push({ id: uid(), level: 0, text, heading: true });
      inline.set(headKey(text), n.innerHTML);
    }
  }
  const after = at < 0 ? [] : nodes.slice(end);
  return {
    bigIdea, lead: field(outer(lead.filter((n) => !(n.nodeType === 3 && !n.textContent.trim())))),
    lines: lines.length ? lines : [{ id: uid(), level: 0, text: '' }], original: linesKey(lines), listHtml: outer(run),
    tag: list?.tagName === 'UL' ? 'ul' : 'ol', inline,
    after: outer(after), afterText: after.some((n) => !isBlank(n)),
  };
}

// ---------- the lesson ----------

/** The lesson note as the builder's model. */
export function parseLesson(html) {
  const { lead, parts } = cut([...doc(html).childNodes], 'H1');
  const preamble = [];
  let versesText = '';
  let bigIdea = null;
  for (const n of lead) {
    if (n.nodeType === 3 && !n.textContent.trim()) continue;
    const t = n.textContent ?? '';
    if (n.nodeType === 1 && n.tagName === 'P' && /^\s*title\s*:/i.test(t)) preamble.push({ kind: 'title', html: n.outerHTML, text: t.replace(/^\s*title\s*:\s*/i, '').trim() });
    else if (n.nodeType === 1 && n.tagName === 'P' && /^\s*verses?\s*:/i.test(t)) {
      versesText = t.replace(/^\s*verses?\s*:\s*/i, '').trim();
      preamble.push({ kind: 'verses', html: n.outerHTML, text: versesText });
    } else if (n.nodeType === 1 && n.tagName === 'P' && BIG.test(t) && !bigIdea) {
      const text = t.replace(BIG, '').trim();
      bigIdea = { text, original: text, html: n.outerHTML, where: 'preamble' };
      preamble.push({ kind: 'big' });
    } else if (passageOfP(n)) preamble.push({ kind: 'passage', html: n.outerHTML, text: passageOfP(n) });
    else preamble.push({ kind: 'html', html: outerOf(n) });
  }
  const seen = new Set();
  const sections = parts.map((p) => {
    const part = PARTS.find((x) => !seen.has(x.key) && x.match.test(p.title));
    if (part) seen.add(part.key);
    const base = { key: part?.key ?? null, title: p.title, titleHtml: p.titleHtml };
    if (part?.key === 'hook') {
      // The passage paragraph that closes the hook is the builder's to keep in step with the passage.
      const nodes = [...p.nodes];
      while (nodes.length && isBlank(nodes[nodes.length - 1])) nodes.pop();
      const last = nodes[nodes.length - 1];
      const tail = passageOfP(last) ? last.outerHTML : '';
      const body = tail ? nodes.slice(0, -1) : p.nodes;
      return { ...base, field: field(outer(body)), tail, tailText: tail ? passageOfP(last) : '', originalHtml: outer(p.nodes) };
    }
    if (part?.key === 'book') {
      const s = listSection(p.nodes, { big: true });
      if (s.bigIdea && !bigIdea) bigIdea = { ...s.bigIdea, where: 'book' };
      else if (s.bigIdea) s.lead = field(s.bigIdea.html + s.lead.html);
      return { ...base, ...s };
    }
    if (part?.key === 'look') return { ...base, ...listSection(p.nodes) };
    if (part?.key === 'took') return { ...base, field: field(outer(p.nodes)) };
    return { ...base, html: outer(p.nodes) };
  });
  // Steps the note doesn't have yet go where they belong.
  for (const part of PARTS) {
    if (seen.has(part.key)) continue;
    const order = PARTS.map((x) => x.key);
    const at = sections.findIndex((s) => s.key && order.indexOf(s.key) > order.indexOf(part.key));
    const made = { key: part.key, title: part.title, titleHtml: esc(part.title), made: true };
    if (part.key === 'hook') Object.assign(made, { field: field(''), tail: '', tailText: '', originalHtml: '' });
    else if (part.key === 'book' || part.key === 'look') Object.assign(made, listSection([]));
    else Object.assign(made, { field: field('') });
    sections.splice(at < 0 ? sections.length : at, 0, made);
  }
  const passageP = preamble.find((x) => x.kind === 'passage')?.text ?? '';
  const passage = [versesText, passageP].find((t) => parse(t).refs.length && !parse(t).errors.length) ?? '';
  return { preamble, sections, passage, bigIdea: bigIdea ?? { text: '', original: '', html: '', where: null } };
}

export const isLessonNote = (html) => {
  const keys = new Set(parseLesson(html).sections.filter((s) => s.key && !s.made).map((s) => s.key));
  return keys.has('hook') && keys.has('took');
};

/** The passage a lesson is on: its session's reference, the note's Verses line, or one in its title. */
export function lessonPassage({ ref, model, title }) {
  if (ref?.trim()) return ref.trim();
  if (model?.passage) return model.passage;
  const found = findReferences(String(title ?? ''))[0];
  return found?.text ?? '';
}

export const section = (model, key) => model.sections.find((s) => s.key === key);
export const setSection = (model, key, patch) => ({ ...model, sections: model.sections.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
export const setText = (model, key, text) => setSection(model, key, { field: editField(section(model, key).field, text) });
export const setLines = (model, key, lines) => setSection(model, key, { lines });
export const setBigIdea = (model, text) => ({ ...model, bigIdea: { ...model.bigIdea, text } });
/** The points (or questions) written, without the section headings. */
export const linesText = (lines) => lines.filter((l) => l.text.trim() && !l.heading);

/** "Greed and Contentment (Ecclesiastes 5:8–6:9)" → "Greed and Contentment" for the Title line. */
const titleOnly = (title) => title.replace(/\s*\(([^)]*)\)\s*$/, (m, inner) => (parse(inner).refs.length ? '' : m)).trim();

/** The model as note HTML. */
export function lessonHtml(model, { title, originalTitle, passage, originalPassage }) {
  const out = [];
  const hasVerses = model.preamble.some((x) => x.kind === 'verses');
  const passageChanged = passage.trim() !== (originalPassage ?? '').trim();
  const titleLine = `<p><strong>Title: ${esc(titleOnly(title))}</strong></p>`;
  const versesLine = `<p><strong>Verses: </strong>${passageLink(passage, true)}</p>`;
  const big = model.bigIdea;
  const bigOut = big.text.trim() ? (big.text === big.original && big.html ? big.html : `<p><strong>Big idea:</strong> ${esc(big.text.trim())}</p>`) : '';
  if (!model.preamble.some((x) => x.kind === 'title')) out.push(titleLine);
  if (!hasVerses && !model.preamble.some((x) => x.kind === 'passage') && passage.trim()) out.push(versesLine);
  for (const x of model.preamble) {
    if (x.kind === 'title') out.push(title.trim() === (originalTitle ?? '').trim() ? x.html : titleLine);
    else if (x.kind === 'verses') out.push(!passageChanged ? x.html : passage.trim() ? versesLine : '<p><strong>Verses: </strong></p>');
    // A passage line above the Verses line only repeats it (the 5.10 study builder added some).
    else if (x.kind === 'passage') out.push(hasVerses ? '' : !passageChanged ? x.html : passage.trim() ? versesLine : '');
    else if (x.kind === 'big') out.push(bigOut);
    else out.push(x.html);
  }
  for (const s of model.sections) {
    out.push(`<h1>${s.titleHtml}</h1>`);
    if (s.key === 'hook') {
      const changed = s.field.text !== s.field.original;
      if (!changed && !passageChanged && (s.tail || !passage.trim())) { out.push(s.originalHtml); continue; }
      const body = fieldOut(s.field);
      // The passage closes the hook, so present mode shows its text before the exposition.
      const wantsTail = passage.trim() && (s.tail || s.made || !s.field.original.trim());
      out.push(body || '<p></p>', wantsTail ? `${body ? '<p></p>' : ''}<p>${passageLink(passage)}</p>` : '');
    } else if (s.key === 'book' || s.key === 'look') {
      if (s.key === 'book' && big.where !== 'preamble') out.push(bigOut);
      out.push(fieldOut(s.lead));
      out.push(linesKey(s.lines) === s.original && s.listHtml ? s.listHtml : linesHtml(s.lines, s.inline, s.tag));
      out.push(s.after);
    } else if (s.key === 'took') out.push(fieldOut(s.field) || '<p></p>');
    else out.push(s.html);
  }
  return out.join('');
}

// ---------- discussion questions ----------

export const QTYPES = [
  ['observe', 'Observe', 'What does the text say?'],
  ['interpret', 'Interpret', 'What does it mean?'],
  ['apply', 'Apply', 'How do we live it?'],
];
/** A guess at a question's kind, from its wording (you can change it). */
export function guessType(q) {
  const t = q.toLowerCase();
  if (/\b(we|us|our|ourselves|you|your|yourself|today|this week|our lives|modern|church|christians)\b/.test(t) && !/\b(mean|meant)\b/.test(t)) return 'apply';
  if (/\b(why|mean|meant|significan\w*|purpose|teach\w*|reveal\w*|impl\w*|relate\w*|point|lesson|principle)\b/.test(t)) return 'interpret';
  return 'observe';
}
export const typeOf = (q, overrides = {}) => overrides[norm(q)] ?? guessType(q);
export const typeKey = norm;

/** Soft checks on the questions: each kind there, in the usual order (observe, interpret, apply). */
export function questionWarnings(lines, overrides) {
  const qs = linesText(lines).filter((l) => l.level === 0).map((l) => typeOf(l.text, overrides));
  if (qs.length < 2) return [];
  const out = [];
  if (!qs.includes('apply')) out.push('None of the questions asks how to live it. End with at least one application question.');
  if (!qs.includes('observe')) out.push('Start with a question or two on what the text says, so everyone is in the passage first.');
  const firstApply = qs.indexOf('apply');
  if (firstApply >= 0 && qs.slice(firstApply + 1).includes('observe')) out.push('An observation question comes after an application one. The usual order is observe, interpret, then apply.');
  return out;
}

// ---------- timing ----------

export const TIMED = ['hook', 'book', 'look', 'took'];
/** A rough length for what's written: reading pace for paragraphs, a few minutes a point and a question. */
export function estimate(model) {
  const s = (k) => section(model, k);
  const prose = (f) => (f.text.trim() ? Math.max(1, Math.round(words(f.text) / 130)) : 0);
  const points = linesText(s('book').lines);
  const top = points.filter((l) => l.level === 0).length;
  return {
    hook: prose(s('hook').field),
    book: Math.round(top * 2 + (points.length - top) * 0.5) + prose(s('book').lead),
    look: linesText(s('look').lines).filter((l) => l.level === 0).length * 3,
    took: prose(s('took').field),
  };
}
/** A split of the class: a short hook and took, most of it in the text and discussion. */
export function suggestSplit(total) {
  const hook = Math.max(3, Math.round(total * 0.1));
  const took = Math.max(3, Math.round(total * 0.1));
  const look = Math.round(total * 0.35);
  return { hook, book: total - hook - took - look, look, took };
}

/** The first sentence of a paragraph (for recaps and look-aheads). */
export const firstSentence = (text) => (/^[\s\S]*?[.!?](?=\s|$)/.exec(String(text ?? '').trim())?.[0] ?? String(text ?? '').trim()).trim();

export { textHtml };
