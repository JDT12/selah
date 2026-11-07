import { api } from '../api.js';
import { DEFAULT_STYLE, styleInfo } from './styles.js';

// ---- sources: CSL-JSON by id, cached for the session ----
const cache = new Map();

/** Remember sources the browser already has (search results, recent list) and save them on the server. */
export async function rememberSources(list) {
  for (const s of list) cache.set(s.id, s);
  if (list.length) await api.saveSources(list);
}
export const cachedSource = (id) => cache.get(id);
/** Keep sources the server sent (e.g. the recently cited list) without saving them again. */
export const cacheSources = (list) => list.forEach((s) => cache.set(s.id, s));

async function getSources(ids) {
  const missing = ids.filter((id) => !cache.has(id));
  if (missing.length) for (const s of await api.sources(missing)) cache.set(s.id, s);
  return Object.fromEntries(ids.filter((id) => cache.has(id)).map((id) => [id, cache.get(id)]));
}
/** After "refresh sources", forget everything so notes re-read the new data. */
export const forgetSources = () => cache.clear();

// ---- style: one app-wide choice, stored as a preference ----
let style = null;
export async function citationStyle() {
  if (!style) style = (await api.getPref('citationStyle').catch(() => null)) || DEFAULT_STYLE;
  return style;
}
export async function setCitationStyle(id) {
  style = id;
  await api.setPref('citationStyle', id);
  window.dispatchEvent(new CustomEvent('noteapp:citation-style', { detail: id }));
}

// ---- formatting ----
let engine = null;
const loadEngine = () => (engine ??= import('./engine.js'));

/**
 * Formats a note's citations and footnotes, in document order. Each entry is a citation node's attrs:
 * { items: [{ id, locator, label, prefix, suffix }], note, noteHtml } (a footnote with only a note has no source).
 * Returns, per entry, its mark in the text ({ mark, inText, html }), the numbered notes, and the bibliography.
 */
export async function formatCitations(entries, styleId) {
  const info = styleInfo(styleId);
  const noteStyle = info.kind === 'note';
  const ids = [...new Set(entries.flatMap((e) => (e.items ?? []).map((i) => i.id)))];
  let n = 0;
  const clusters = [];
  const marks = entries.map((e, i) => {
    const sourced = e.items?.length > 0;
    // In note styles every citation is a footnote; in author–date styles only the plain footnotes are.
    const number = sourced && !noteStyle ? null : ++n;
    if (sourced) clusters.push({ id: `c${i}`, items: e.items, noteIndex: number ?? 0 });
    return { number, sourced };
  });
  let text = {};
  let bibliography = [];
  if (clusters.length) {
    const [{ format }, items] = await Promise.all([loadEngine(), getSources(ids)]);
    ({ text, bibliography } = format(info.id, items, clusters));
  }
  const results = entries.map((e, i) => {
    const m = marks[i];
    const sourceHtml = m.sourced ? clean(text[`c${i}`] ?? '') : '';
    const noteHtml = e.noteHtml ? clean(e.noteHtml) : e.note ? escapeHtml(e.note) : '';
    // A footnote can have a comment as well as sources: "See also …" then the citation.
    const html = [noteHtml, noteStyle ? sourceHtml : ''].filter(Boolean).join(' ');
    return m.number != null
      ? { mark: String(m.number), inText: false, number: m.number, html }
      : { mark: '', inText: true, html: sourceHtml, number: null };
  });
  return {
    noteStyle,
    results,
    notes: results.filter((r) => r.number != null).map((r, i) => ({ number: r.number, html: r.html, index: results.indexOf(r) })),
    bibliography: bibliography.map(clean),
  };
}

// ---- HTML from citeproc: keep simple formatting only ----
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ALLOWED = new Set(['I', 'B', 'EM', 'STRONG', 'SUP', 'SUB', 'SPAN', 'DIV', 'A']);
export function clean(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
        if (!ALLOWED.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        const smallCaps = /small-caps/.test(child.getAttribute('style') ?? '');
        const href = child.tagName === 'A' ? child.getAttribute('href') : null;
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
        if (smallCaps) child.setAttribute('style', 'font-variant: small-caps');
        if (href && /^https?:\/\//i.test(href)) { child.setAttribute('href', href); child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  // citeproc wraps bibliography entries in <div class="csl-entry">; the entry's content is enough.
  return root.innerHTML.replace(/^<div>([\s\S]*)<\/div>$/, '$1');
}
export const htmlToPlain = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
