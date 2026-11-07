import { api } from './api.js';
import { quotedCopyrights } from '../../shared/bibleCopyright.js';

/**
 * Bible text for references, in any connected translation (ESV, NLT, API.Bible; see server/bible.js): a hover card
 * on any `.bible-ref` element (references in notes and on the Daily Walk page), and passages to insert into notes.
 * Each passage carries its translation's label and credit link, shown wherever its text is (the publishers ask
 * that the text is credited and isn't changed).
 */

let info = null; // Promise<{ favorite, translations, providers }>
/** The translations that can be read and the favorite (from Settings → Bible). */
export function bibleInfo(fresh = false) {
  if (!info || fresh) info = api.bibleStatus().catch(() => ({ favorite: null, translations: [], providers: {} }));
  return info;
}
/** Whether any translation is connected. */
export const bibleConnected = (fresh = false) => bibleInfo(fresh).then((i) => i.translations.length > 0);

const passages = new Map(); // "translation|ref" -> Promise<{ reference, text, verses, translation, credit, copyright }>
const warned = new Set();
/** Call after connecting, disconnecting or choosing a favorite, so hover cards and panes pick it up. */
export function bibleChanged() {
  passages.clear();
  bibleInfo(true);
  window.dispatchEvent(new CustomEvent('noteapp:bible-changed'));
}
/** A passage in translation `t` (an id from bibleInfo; empty: the favorite). */
export function biblePassage(q, t = '') {
  const k = `${t}|${q}`;
  if (!passages.has(k)) {
    const p = api.biblePassage(q, t);
    // Past 80% of a translation's lookups: say so once (App shows the toast).
    p.then((r) => {
      const which = `${r.translation}:${r.nearLimit}`;
      if (!r.nearLimit || warned.has(which)) return;
      warned.add(which);
      window.dispatchEvent(new CustomEvent('noteapp:esv-near-limit', { detail: { limit: r.nearLimit, translation: r.translation } }));
    }).catch(() => {});
    passages.set(k, p);
    p.catch(() => passages.delete(k));
  }
  return passages.get(k);
}

/**
 * The translation a view reads in ('hover', 'side', 'study', 'passage'), picked with its switcher and kept per
 * device; empty means the favorite.
 */
export function viewTranslation(view) {
  try { return localStorage.getItem(`noteapp.bible.${view}`) ?? ''; } catch { return ''; }
}
export function setViewTranslation(view, id) {
  try { if (id) localStorage.setItem(`noteapp.bible.${view}`, id); else localStorage.removeItem(`noteapp.bible.${view}`); } catch { /* storage unavailable */ }
}

/** The publishers' copyright notices for the Bibles a note's HTML quotes (ending a Word document or a WordPress post). */
export async function scriptureCopyrights(html) {
  const text = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent;
  return quotedCopyrights(text, (await bibleInfo()).translations);
}

/** The credit under a passage: its label linked to the publisher (and API.Bible, which its free plan asks for). */
export function creditHtml(p) {
  const c = p?.credit ?? { label: p?.translation ?? 'ESV', url: 'https://www.esv.org/' };
  const link = `<a href="${escape(c.url)}" target="_blank" rel="noopener noreferrer" title="${escape(p?.copyright ?? '')}">${escape(c.label)}</a>`;
  return p?.translationId?.startsWith('ab:') ? `${link} · <a href="https://api.bible/" target="_blank" rel="noopener noreferrer">API.Bible</a>` : link;
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Paragraphs and poetry lines of the API's text, with "[16]" verse numbers as <b>16</b>. */
function blocks(text) {
  return text.split(/\n\s*\n/).map((para) => para.split('\n').map((line) => ({
    indent: /^\s{3,}/.test(line),
    html: escape(line.trim()).replace(/\[(\d+)\]\s*/g, '<b class="verse-no">$1</b> '),
  })).filter((l) => l.html));
}

/** HTML for the hover card. */
export function passageCardHtml(text) {
  return blocks(text).map((lines) => `<p>${lines.map((l) => (l.indent ? `<span class="esv-indent">${l.html}</span>` : l.html)).join('<br>')}</p>`).join('');
}

/** A quotation for a note: the passage in a block quote, ending with "— John 3:16 (ESV)". */
export function passageNoteHtml({ reference, text, translation = 'ESV' }) {
  const paras = blocks(text).map((lines) => `<p>${lines.map((l) => l.html.replace(/<b class="verse-no">(\d+)<\/b>/g, '<strong>$1</strong>')).join('<br>')}</p>`);
  return `<blockquote>${paras.join('')}<p>— ${escape(reference)} (${escape(translation)})</p></blockquote><p></p>`;
}

/**
 * The passage inside a sentence: “For God so loved the world…” (John 3:16 ESV). Verse numbers and line breaks
 * go, and the passage's own double quotes become single ones. With `withRef: false` the reference is already
 * in the text just before it, so only (ESV) follows.
 */
export function passageInlineText({ reference, text, translation = 'ESV' }, { withRef = true } = {}) {
  const plain = text.replace(/\[\d+\]\s*/g, '').replace(/\s+/g, ' ').trim()
    .replace(/“/g, '‘').replace(/”/g, '’');
  return `“${plain}” (${withRef ? `${reference} ` : ''}${translation})`;
}

/** Quote or inline, as last chosen in the insert dialog (per device). */
export function esvStyle() {
  try { return localStorage.getItem('noteapp.esvStyle') === 'inline' ? 'inline' : 'quote'; } catch { return 'quote'; }
}
export function setEsvStyle(style) {
  try { localStorage.setItem('noteapp.esvStyle', style); } catch { /* storage unavailable */ }
}

// ---------- hover card ----------

const SHOW_AFTER = 350;
const HIDE_AFTER = 250;
const MAX_LINES = 14; // longer passages are cut, with a link to read on

let card = null;
let showTimer = null;
let hideTimer = null;
let current = null;
// While a chip switches the card's translation, the card stays put: it keeps its old text (dimmed) until the new one
// comes, and the pointer leaving it as its size changes doesn't hide it.
let switching = false;

function ensureCard() {
  if (card) return card;
  card = document.createElement('div');
  card.className = 'esv-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', () => scheduleHide());
  // A translation chip: read this passage (and later ones) in that translation.
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tr]');
    if (!b || !current) return;
    setViewTranslation('hover', b.dataset.tr);
    clearTimeout(hideTimer);
    show(current, { switching: true });
  });
  document.body.append(card);
  return card;
}

function place(el) {
  const r = el.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const margin = 8;
  let left = Math.min(Math.max(margin, r.left), window.innerWidth - c.width - margin);
  let top = r.bottom + 6;
  if (top + c.height > window.innerHeight - margin && r.top - c.height - 6 > margin) top = r.top - c.height - 6;
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(margin, top)}px`;
}

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  current = null;
  if (card) card.hidden = true;
}
function scheduleHide() {
  if (switching) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_AFTER);
}

/** The card's translation chips (more than one translation connected), the one shown marked. */
function chips(all, shown) {
  if (all.length < 2) return '';
  return `<span class="esv-card-tr" role="group" aria-label="Translation">${all.map((t) => `<button type="button" data-tr="${escape(t.id)}"
    class="${t.id === shown ? 'is-on' : ''}" aria-pressed="${t.id === shown}" title="${escape(t.name)}">${escape(t.label)}</button>`).join('')}</span>`;
}

async function show(el, { switching: swap = false } = {}) {
  const refs = el.dataset.refs;
  if (!refs) return;
  current = el;
  switching = swap;
  ensureCard();
  const hint = el.dataset.hint ?? '';
  const head = `<div class="esv-card-head"><strong>${escape(refs)}</strong></div>`;
  const { translations: all, favorite } = await bibleInfo();
  if (current !== el) return;
  const picked = viewTranslation('hover');
  const tr = all.some((t) => t.id === picked) ? picked : favorite;
  // p: the passage (its credit), undefined while loading or on an error, null with no translation connected.
  const foot = (p) => `<div class="esv-card-foot">${hint ? `<span>${escape(hint)}</span>` : ''}${p ? `<span class="esv-card-credit">${creditHtml(p)}</span>` : ''}${p !== null ? chips(all, tr) : ''}</div>`;
  if (!all.length) {
    if (!hint) return;
    card.innerHTML = head + foot(null);
    card.hidden = false;
    place(el);
    return;
  }
  if (swap) {
    card.classList.add('is-switching');
    for (const b of card.querySelectorAll('[data-tr]')) b.classList.toggle('is-on', b.dataset.tr === tr);
  } else {
    card.innerHTML = `${head}<div class="esv-card-body muted">Loading…</div>${foot(undefined)}`;
    card.hidden = false;
    place(el);
  }
  // Your margin notes on these verses go under the text.
  const margin = api.verseNotes({ ref: refs }).catch(() => []);
  try {
    const p = await biblePassage(refs, tr);
    const notes = await margin;
    if (current !== el) return;
    const lines = p.text.split('\n');
    const cut = lines.length > MAX_LINES;
    const body = passageCardHtml(cut ? lines.slice(0, MAX_LINES).join('\n') : p.text);
    const more = !cut ? '' : p.translation === 'ESV'
      ? `<p class="esv-more"><a href="https://www.esv.org/${encodeURIComponent(p.reference)}/" target="_blank" rel="noopener noreferrer">Read all of ${escape(p.reference)} on esv.org…</a></p>`
      : `<p class="esv-more muted">Open ${escape(p.reference)} on the Scripture page to read it all.</p>`;
    const mine = notes.length ? `<div class="esv-card-notes">${notes.slice(0, 6).map((n) => `<p><b>${escape(n.ref.replace(/^.* (\d+:)/, '$1'))}</b> ${escape(n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text)}</p>`).join('')}${notes.length > 6 ? `<p class="muted">and ${notes.length - 6} more on the passage page</p>` : ''}</div>` : '';
    card.innerHTML = `<div class="esv-card-head"><strong>${escape(p.reference)}</strong></div><div class="esv-card-body">${body}${more}</div>${mine}${foot(p)}`;
  } catch (e) {
    if (current !== el) return;
    card.innerHTML = `${head}<div class="esv-card-body muted">${escape(e.message)}</div>${foot(undefined)}`;
  } finally {
    if (swap) { switching = false; card.classList.remove('is-switching'); }
  }
  if (current !== el) return;
  // A switch keeps the card where it is (so its chips stay under the pointer) unless it would run off the screen.
  const c = card.getBoundingClientRect();
  if (!swap || c.bottom > window.innerHeight - 8 || c.right > window.innerWidth - 8) place(el);
}

/** Starts hover cards for `.bible-ref` elements anywhere in the page. Call once. */
let installed = false;
export function installVerseCards() {
  if (installed || window.matchMedia('(hover: none)').matches) return; // phones: no hover
  installed = true;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.bible-ref');
    if (!el) { if (current && !card?.contains(e.target)) scheduleHide(); return; }
    clearTimeout(hideTimer);
    if (el === current) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), SHOW_AFTER);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest?.('.bible-ref');
    if (el && !el.contains(e.relatedTarget) && !card?.contains(e.relatedTarget)) { clearTimeout(showTimer); scheduleHide(); }
  });
  for (const ev of ['keydown', 'scroll', 'mousedown']) {
    document.addEventListener(ev, (e) => { if (!card?.contains(e.target)) hide(); }, true);
  }
}
