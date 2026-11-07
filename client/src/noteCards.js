import { api } from './api.js';
import { wordCardHtml, wordLibrary } from './wordLibrary.js';

/**
 * A hover card for links to other notes (`a.note-link`): the note's title, notebook and first lines; a word study's
 * word, meaning and keeper. Words you've studied (`.word-ref`, editor/WordMarks.js) show their study's card too.
 */

const SHOW_AFTER = 350;
const HIDE_AFTER = 250;
const previews = new Map(); // id -> Promise

let card = null;
let showTimer = null;
let hideTimer = null;
let current = null;

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ensureCard() {
  if (card) return card;
  card = document.createElement('div');
  card.className = 'esv-card note-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', () => scheduleHide());
  document.body.append(card);
  return card;
}

function place(el) {
  const r = el.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(Math.max(margin, r.left), window.innerWidth - c.width - margin);
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
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_AFTER);
}

const TARGET = 'a.note-link[data-note-id], .word-ref[data-word-note]';

async function show(el) {
  const id = Number(el.dataset.noteId || el.dataset.wordNote);
  if (!id) return;
  current = el;
  ensureCard();
  const word = (await wordLibrary().catch(() => [])).find((s) => s.note_id === id);
  if (current !== el) return;
  if (word) {
    card.innerHTML = wordCardHtml(word, el.dataset.wordNote ? 'Ctrl+click to open' : 'Click to open');
    card.hidden = false;
    place(el);
    return;
  }
  if (!previews.has(id)) {
    const p = api.notePreview(id);
    previews.set(id, p);
    p.catch(() => {});
    setTimeout(() => previews.delete(id), 60_000); // notes change; don't keep a stale preview for long
  }
  card.innerHTML = '<div class="esv-card-body muted">Loading…</div>';
  card.hidden = false;
  place(el);
  try {
    const n = await previews.get(id);
    if (current !== el) return;
    const text = n.text.split('\n').filter(Boolean).slice(0, 6).map((l) => `<p>${escape(l)}</p>`).join('');
    card.innerHTML = `<div class="esv-card-head"><strong>${escape(n.title || 'Untitled')}</strong></div>`
      + `<div class="esv-card-body note-card-body">${text || '<p class="muted">This note is empty.</p>'}</div>`
      + `<div class="esv-card-foot"><span>${n.deleted_at ? 'In the Trash' : escape(n.notebook ?? '')}</span><span>Click to open</span></div>`;
  } catch (e) {
    if (current !== el) return;
    card.innerHTML = `<div class="esv-card-body muted">${escape(e.message)}</div>`;
  }
  place(el);
}

let installed = false;
/** Starts hover cards for `a.note-link` and `.word-ref` anywhere in the page. Call once. */
export function installNoteCards() {
  if (installed || window.matchMedia('(hover: none)').matches) return; // phones: no hover
  installed = true;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.(TARGET);
    if (!el) { if (current && !card?.contains(e.target)) scheduleHide(); return; }
    clearTimeout(hideTimer);
    if (el === current) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), SHOW_AFTER);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest?.(TARGET);
    if (el && !el.contains(e.relatedTarget) && !card?.contains(e.relatedTarget)) { clearTimeout(showTimer); scheduleHide(); }
  });
  for (const ev of ['keydown', 'scroll', 'mousedown']) {
    document.addEventListener(ev, (e) => { if (!card?.contains(e.target)) hide(); }, true);
  }
}
