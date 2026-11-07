import { parseLesson, section, linesText, firstSentence } from './lesson.js';
import { parseSermon, joinStatement } from './sermon.js';
import { isSermonHtml } from './sermonBoard.js';

/**
 * Slide decks for lessons and sermons (kept by server/slides.js). A deck starts from the note's outline: for a lesson
 * the title, passage, big idea, each outline point (its sub-points come in one at a time), each discussion question
 * and the Took; for a sermon the title, passage, sermon idea, each division and a summary. Slides made that way
 * remember where they came from (`src`) and what they were made from (`gen`); when the note's outline changes, the
 * editor offers the change instead of making it (`reconcile`). Every slide can carry an `anchor`: the text of the
 * place in the note that brings it up while you preach or teach ('^' is the top of the note).
 *
 * Slide text is plain text with **bold**, *italics* and "- " bullet lines (`md`).
 */

export const SLIDE_TYPES = [
  ['title', 'Title'], ['point', 'Point'], ['passage', 'Passage'], ['image', 'Image'], ['question', 'Question'], ['custom', 'Custom'],
];
export const typeLabel = Object.fromEntries(SLIDE_TYPES);

let seq = 0;
export const slideId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
const norm = (t) => String(t ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const short = (t, n = 120) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- text ----------

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
/** Slide text as HTML: paragraphs, "- " bullet lines, **bold** and *italics*. Everything else is escaped. */
export function md(text) {
  const out = [];
  let list = null;
  for (const line of String(text ?? '').split('\n')) {
    const b = /^\s*[-•]\s+(.*)$/.exec(line);
    if (b) { (list ??= []).push(`<li>${inline(b[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
export const inlineMd = inline;

// ---------- passages ----------

const MAX_WORDS = 38; // a page of a passage: about six lines at slide size
const count = (t) => t.split(/\s+/).filter(Boolean).length;
/**
 * A verse in pieces that fit a slide: whole when it's short, else cut where it reads best. Each cut takes the
 * strongest break (a sentence's end, then a semicolon or colon, then a comma or poetry line) that leaves a piece of at
 * most MAX_WORDS and a rest that isn't a stub; among equals, the one nearest an even split.
 */
const SEG = /(?<=[.;:!?,]["\u201d\u2019)]*\s+)|(?<=\n)/;
function splitVerse(body) {
  const total = count(body);
  if (total <= MAX_WORDS) return [body];
  const segs = body.split(SEG).filter((x) => x.length);
  const strength = (seg) => (/[.!?]["\u201d\u2019)]*\s*$/.test(seg) ? 3 : /[;:]["\u201d\u2019)]*\s*$/.test(seg) ? 2 : 1);
  const out = [];
  let i = 0;
  while (i < segs.length) {
    const left = segs.slice(i).join('');
    const n = count(left);
    if (n <= MAX_WORDS) { out.push(left); break; }
    const ideal = n / Math.ceil(n / MAX_WORDS);
    let best = null;
    let w = 0;
    for (let j = i; j < segs.length - 1; j++) {
      w += count(segs[j]);
      if (w > MAX_WORDS) break;
      if (w < 6 || n - w < 6) continue;
      const score = strength(segs[j]) * 100 - Math.abs(w - ideal);
      if (!best || score > best.score) best = { j, score };
    }
    if (!best) {
      // No good break: an even share of the words, and the rest broken up again.
      const words = left.split(/(?<=\s)/);
      const take = Math.min(MAX_WORDS, Math.ceil(ideal));
      out.push(words.slice(0, take).join(''));
      segs.splice(i, segs.length - i, ...words.slice(take).join('').split(SEG).filter((x) => x.length));
      continue;
    }
    out.push(segs.slice(i, best.j + 1).join(''));
    i = best.j + 1;
  }
  return out;
}
const linesHtml = (t, more) => t.replace(/^\n+|\s+$/g, '').split('\n').filter((l) => l.trim())
  .map((l, i, all) => `<span class="sl-line${/^\s{2,}/.test(l) ? ' is-indent' : ''}">${esc(l.trim())}${more && i === all.length - 1 ? '<span class="sl-cont">…</span>' : ''}</span>`).join('');
/**
 * A passage's ESV text as slide pages: one verse a page, a long verse carried on over as many pages as it needs, so
 * the text stays large. A heading before the first verse (a psalm's title) goes on the first page. Each page is
 * { html, verse, part, parts }.
 */
export function passagePages(text) {
  if (!text) return [];
  const parts = String(text).replace(/\r/g, '').trim().split(/(?=\[\d+\])/);
  const lead = parts.length && !/^\[\d+\]/.test(parts[0]) ? parts.shift().trim() : '';
  const pages = [];
  for (const part of parts) {
    const m = /^\[(\d+)\]\s*([\s\S]*)$/.exec(part);
    if (!m || !m[2].trim()) continue;
    const pieces = splitVerse(m[2]);
    pieces.forEach((piece, i) => pages.push({
      verse: Number(m[1]), part: i + 1, parts: pieces.length,
      html: `${!pages.length && lead ? `<p class="sl-lead">${esc(lead)}</p>` : ''}<p>${i === 0 ? `<sup>${m[1]}</sup>` : '<span class="sl-cont">…</span>'}${linesHtml(piece, i < pieces.length - 1)}</p>`,
    }));
  }
  if (!pages.length && lead) pages.push({ verse: null, part: 1, parts: 1, html: `<p>${esc(lead)}</p>` });
  return pages;
}

/** The translation a slide's passage is read in (11.0: its own, else the deck's; '' for your favorite). */
export const slideTr = (slide, deck) => slide?.tr || deck?.translation || '';
/** The key a passage's text is kept under (usePassages): translation and reference. */
export const passageKey = (slide, deck) => `${slideTr(slide, deck)}|${(slide?.ref ?? '').trim()}`;

/** How many times Next stays on a slide: one for each point after the first, or each page of a passage after the first. */
export function stepsOf(slide, passages = {}, deck = null) {
  if (!slide) return 0;
  if (slide.type === 'passage') return Math.max(0, passagePages(passages[passageKey(slide, deck)]?.text).length - 1);
  const top = (slide.points ?? []).filter((p) => p.text.trim() && p.level === 0).length;
  return Math.max(0, top - (slide.text?.trim() ? 0 : 1));
}

// ---------- building from the note ----------

const gen = (s) => ({ title: s.title ?? '', text: s.text ?? '', ref: s.ref ?? '', answer: s.answer ?? '', points: (s.points ?? []).map((p) => [p.level, p.text]) });
const sig = (g) => JSON.stringify(g);
const make = (src, s) => ({ id: slideId(), ...s, src, gen: gen(s) });

/** The kind of deck a note gets: 'sermon', 'lesson', or null (a plain note presents the old way). */
export function deckKind(html, { sermon } = {}) {
  if (sermon || isSermonHtml(html)) return 'sermon';
  const m = parseLesson(html);
  const keys = new Set(m.sections.filter((s) => s.key && !s.made).map((s) => s.key));
  return keys.has('book') || (keys.has('hook') && keys.has('took')) ? 'lesson' : null;
}

/** Points with their sub-points, from outline lines ({ level, text }). */
function pointGroups(lines) {
  const groups = [];
  for (const l of linesText(lines)) {
    if (l.level === 0 || !groups.length) groups.push({ text: l.text.trim(), subs: [] });
    else groups[groups.length - 1].subs.push({ text: l.text.trim(), level: l.level - 1 });
  }
  return groups;
}

function fromLesson(title, html, passage) {
  const m = parseLesson(html);
  const out = [];
  const pass = passage || m.passage;
  out.push(make('title', { type: 'title', title: title || 'Untitled Lesson', text: pass ?? '', anchor: '^' }));
  if (m.bigIdea.text.trim()) out.push(make('big', { type: 'point', title: '', text: m.bigIdea.text.trim(), anchor: short(m.bigIdea.text, 80) }));
  const hook = section(m, 'hook');
  if (pass) out.push(make('passage', { type: 'passage', title: '', ref: pass, anchor: hook?.tailText || pass }));
  const book = section(m, 'book');
  for (const g of pointGroups(book?.lines ?? [])) {
    out.push(make('point', { type: 'point', title: g.text, points: g.subs.map((x) => ({ ...x, anchor: short(x.text, 80) })), anchor: short(g.text, 80) }));
  }
  const look = section(m, 'look');
  for (const g of pointGroups(look?.lines ?? [])) {
    // Lines under a question are what you hope to hear: shown only on your screen.
    out.push(make('question', { type: 'question', title: g.text, answer: g.subs.map((x) => x.text).join('\n'), anchor: short(g.text, 80) }));
  }
  const took = section(m, 'took');
  const tookText = took?.field?.text?.trim();
  if (tookText) out.push(make('took', { type: 'point', title: 'This Week', text: firstSentence(tookText), anchor: took.title }));
  return out;
}

function fromSermon(title, html, passage) {
  const m = parseSermon(html);
  const out = [];
  out.push(make('title', { type: 'title', title: title || 'Untitled Sermon', text: passage ?? '', anchor: '^' }));
  if (passage) out.push(make('passage', { type: 'passage', title: '', ref: passage, anchor: passage }));
  const idea = m.intro?.bridge?.sermonIdea?.trim();
  if (idea) out.push(make('big', { type: 'point', title: '', text: idea, anchor: short(idea, 80) }));
  const divs = m.divisions.filter((d) => d.statement.trim());
  divs.forEach((d, i) => {
    out.push(make('division', { type: 'point', title: `${i + 1}. ${d.statement.trim()}`, text: d.verses.trim(), anchor: short(d.original || joinStatement(d.statement, d.verses), 120) }));
  });
  if (divs.length > 1 && m.conclusion) {
    out.push(make('summary', { type: 'point', title: 'Summary', points: divs.map((d) => ({ text: d.statement.trim(), level: 0, anchor: '' })), anchor: m.conclusion.title || 'Conclusion' }));
  }
  return out;
}

/** The slides the note's outline makes now. */
export function outlineSlides(kind, { title, html, passage }) {
  return kind === 'sermon' ? fromSermon(title, html, passage) : fromLesson(title, html, passage);
}

/** A new deck from the note. */
export function newDeck(kind, source) {
  return { theme: kind === 'sermon' ? 'dark' : 'light', kind, slides: outlineSlides(kind, source), dismissed: [] };
}

/**
 * How the deck stands against the note's outline now: slides whose part of the note changed (`changed`: id → the
 * slide as the note would make it), slides whose part is gone (`gone`: ids), and parts with no slide yet (`fresh`).
 * Slides pair with outline items of the same kind: first those made from exactly the same thing, then in order.
 */
export function reconcile(deck, made) {
  const changed = {};
  const gone = [];
  const fresh = [];
  const kinds = new Set([...made.map((g) => g.src), ...deck.slides.filter((s) => s.src).map((s) => s.src)]);
  for (const k of kinds) {
    const gs = made.filter((g) => g.src === k);
    const ss = deck.slides.filter((s) => s.src === k);
    const pairs = new Map(); // slide id -> made
    const used = new Set();
    for (const s of ss) {
      const g = gs.find((x) => !used.has(x) && sig(x.gen) === sig(s.gen));
      if (g) { pairs.set(s.id, g); used.add(g); }
    }
    const restG = gs.filter((g) => !used.has(g));
    for (const s of ss) {
      if (pairs.has(s.id)) continue;
      const g = restG.shift();
      if (g) pairs.set(s.id, g);
      else if (s.kept !== 'gone') gone.push(s.id);
    }
    for (const g of restG) if (!deck.dismissed?.includes(`${k}|${sig(g.gen)}`)) fresh.push(g);
    for (const [id, g] of pairs) {
      const s = ss.find((x) => x.id === id);
      if (sig(g.gen) !== sig(s.gen) && s.kept !== sig(g.gen)) changed[id] = g;
    }
  }
  return { changed, gone, fresh };
}

/** A slide brought up to date with its part of the note (it keeps its id, its picture and your speaker notes). */
export const updateSlide = (slide, made) => ({ ...slide, ...made, id: slide.id, kept: undefined, notes: slide.notes });
/** "Keep mine": the slide stays as it is until the note changes again. */
export const keepSlide = (slide, made) => ({ ...slide, kept: made ? sig(made.gen) : 'gone' });
export const dismissKey = (made) => `${made.src}|${sig(made.gen)}`;

/** Where a new outline slide goes: after the last slide of the same kind, else by the outline's own order. */
export function insertMade(slides, made, all) {
  const out = [...slides];
  const same = out.map((s, i) => [s, i]).filter(([s]) => s.src === made.src);
  if (same.length) { out.splice(same[same.length - 1][1] + 1, 0, made); return out; }
  const order = all.map((g) => g.src);
  const after = out.map((s, i) => [s, i]).filter(([s]) => s.src && order.indexOf(s.src) >= 0 && order.indexOf(s.src) < order.indexOf(made.src));
  out.splice(after.length ? after[after.length - 1][1] + 1 : out.length, 0, made);
  return out;
}

/** A blank slide of a type. */
export function blankSlide(type) {
  const base = { id: slideId(), type, title: '', text: '', anchor: '' };
  if (type === 'point') base.points = [];
  if (type === 'passage') base.ref = '';
  if (type === 'question') base.answer = '';
  if (type === 'image') Object.assign(base, { image: null, fit: 'contain' });
  if (type === 'title') base.title = 'Title';
  return base;
}

// ---------- anchors ----------

/** Places in a note a slide can be tied to: headings, list items and paragraphs, as { text, label, depth }. */
export function anchorChoices(html) {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const out = [];
  const seen = new Set();
  for (const el of body.querySelectorAll('h1, h2, h3, li, p')) {
    if (el.tagName === 'P' && el.closest('li')) continue;
    const own = el.tagName === 'LI' ? [...el.childNodes].filter((n) => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map((n) => n.textContent).join(' ') : el.textContent;
    const text = short(own, 80);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, tag: el.tagName.toLowerCase(), label: text.length > 70 ? `${text.slice(0, 70)}…` : text });
  }
  return out;
}

/** The element an anchor names inside rendered note HTML: text that matches exactly first, then text that has it. */
export function findAnchor(root, anchor, cache) {
  if (!anchor || anchor === '^' || !root) return null;
  const want = norm(anchor);
  const els = cache ?? anchorElements(root);
  return els.find((x) => x.text === want)?.el ?? els.find((x) => x.text.startsWith(want))?.el ?? els.find((x) => x.text.includes(want))?.el ?? null;
}
export function anchorElements(root) {
  return [...root.querySelectorAll('h1, h2, h3, h4, li, p')].map((el) => {
    const own = el.tagName === 'LI' ? [...el.childNodes].filter((n) => !(n.nodeType === 1 && /^(UL|OL|DIV)$/.test(n.tagName))).map((n) => n.textContent).join(' ') : el.textContent;
    return { el, text: norm(own) };
  }).filter((x) => x.text);
}
