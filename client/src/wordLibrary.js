import { api } from './api.js';
import { termsRegex, wordTerms } from './wordStudy.js';

/**
 * The word library (8.5): your word studies, kept here for hover cards and the editor's marks (editor/WordMarks.js).
 * Loaded once, and again whenever notes change.
 */
let list = null;
let loading = null;
let matcher = { re: null, byTerm: new Map() };
const listeners = new Set();

function build(studies) {
  const terms = wordTerms(studies);
  const byTerm = new Map();
  for (const t of terms) {
    const key = t.term.toLowerCase();
    if (!byTerm.has(key)) byTerm.set(key, t.study);
  }
  matcher = { re: termsRegex(terms), byTerm };
}

/** Loads the library again (after a word study is saved). */
export function refreshWordLibrary() {
  loading = api.wordStudies().then((l) => {
    list = l;
    build(l);
    for (const fn of listeners) fn();
    return l;
  }).catch(() => list ?? []);
  return loading;
}
export const wordLibrary = () => (list ? Promise.resolve(list) : loading ?? refreshWordLibrary());

/** The current matcher: { re (global, or null), byTerm: Map(lowercased term → study) }. */
export const wordMatcher = () => matcher;
/** Calls `fn` when the library changes; returns the unsubscribe. */
export function onWordLibrary(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let started = false;
export function startWordLibrary() {
  if (started) return;
  started = true;
  refreshWordLibrary();
  let t = null;
  window.addEventListener('noteapp:notes-changed', () => { clearTimeout(t); t = setTimeout(refreshWordLibrary, 1500); });
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A word study's hover card: the word, its number and meaning, your keeper. */
export function wordCardHtml(s, hint = 'Click to open') {
  const lang = s.lang === 'greek' ? 'Greek' : s.lang === 'hebrew' ? 'Hebrew' : '';
  return `<div class="esv-card-head"><strong dir="auto">${esc(s.lemma || s.english || s.title)}</strong>${s.translit ? ` <span>${esc(s.translit)}</span>` : ''}</div>`
    + `<div class="esv-card-body note-card-body">`
    + `${[lang, s.strongs && `Strong’s ${s.strongs}`, s.gloss].filter(Boolean).length ? `<p class="muted">${esc([lang, s.strongs && `Strong’s ${s.strongs}`, s.gloss].filter(Boolean).join(' · '))}</p>` : ''}`
    + `${s.keeper ? `<p>“${esc(s.keeper)}”</p>` : '<p class="muted">No keeper yet.</p>'}`
    + `</div><div class="esv-card-foot"><span>Word study${s.passage ? ` · ${esc(s.passage)}` : ''}</span><span>${esc(hint)}</span></div>`;
}
