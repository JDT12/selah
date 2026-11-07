import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Sharing (8.0): one copy of /api/sharing for the whole app (contacts, what's shared with me, what I share), loaded
 * again when the server says something about sharing changed (a live message with `sharing`) or after a reconnect.
 * In single mode (a home server) it stays { enabled: false } and nothing shows.
 */

let state = null;
let loading = null;
const listeners = new Set();

export function loadSharing() {
  loading ??= api.sharing().then((s) => { state = s; listeners.forEach((fn) => fn(s)); return s; })
    .catch(() => state).finally(() => { loading = null; });
  return loading;
}

if (typeof window !== 'undefined') {
  window.addEventListener('noteapp:live', (e) => {
    const d = e.detail ?? {};
    if (d.sharing || d.url?.startsWith('/api/sharing') || d.url?.startsWith('/api/shared')) loadSharing();
  });
  window.addEventListener('noteapp:live-reconnect', () => loadSharing());
}

/** The sharing state (null until loaded). */
export function useSharing() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!state) loadSharing();
    return () => listeners.delete(setS);
  }, []);
  return s;
}

export const sharingOn = (s) => !!s?.enabled;
export const KIND_LABEL = { note: 'Note', notebook: 'Notebook', study: 'Project' };
export const KIND_ICON = { note: 'note', notebook: 'notebook', study: 'desk' };

/** People shared with me, each with their shares, newest activity first. */
export function byPerson(list = []) {
  const map = new Map();
  for (const s of list) {
    if (!map.has(s.owner)) map.set(s.owner, { owner: s.owner, name: s.ownerName, shares: [] });
    map.get(s.owner).shares.push(s);
  }
  return [...map.values()];
}

/**
 * Where a comment's text is in a ProseMirror document: the quoted words, using the words around them to pick the
 * right one when they appear more than once. Returns { from, to } or null when the text has changed past finding.
 */
export function findQuote(doc, { quote, prefix = '', suffix = '' }) {
  if (!quote) return null;
  // The document's text with a map back to positions (blocks separated by a space).
  let text = '';
  const pos = [];
  let lastBlock = null;
  doc.descendants((node, p) => {
    if (node.isText) {
      for (let i = 0; i < node.text.length; i++) { text += node.text[i]; pos.push(p + i); }
    } else if (node.isBlock && lastBlock !== null && text && !text.endsWith(' ')) {
      text += ' ';
      pos.push(p);
    }
    if (node.isBlock) lastBlock = p;
    return true;
  });
  const hits = [];
  for (let i = text.indexOf(quote); i >= 0 && hits.length < 50; i = text.indexOf(quote, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const score = (i) => {
    let s = 0;
    const before = text.slice(Math.max(0, i - prefix.length), i);
    const after = text.slice(i + quote.length, i + quote.length + suffix.length);
    for (let k = 1; k <= Math.min(before.length, prefix.length) && before[before.length - k] === prefix[prefix.length - k]; k++) s++;
    for (let k = 0; k < Math.min(after.length, suffix.length) && after[k] === suffix[k]; k++) s++;
    return s;
  };
  const best = hits.reduce((a, b) => (score(b) > score(a) ? b : a));
  return { from: pos[best], to: pos[best + quote.length - 1] + 1 };
}

/** The selected words (or those in `range`) and a little of what's around them, to find them again later. */
export function quoteOfSelection(editor, range = editor.state.selection) {
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  if (from === to) return null;
  const doc = editor.state.doc;
  const quote = doc.textBetween(from, to, ' ').trim().slice(0, 500);
  if (!quote) return null;
  const prefix = doc.textBetween(Math.max(0, from - 60), from, ' ').slice(-40);
  const suffix = doc.textBetween(to, Math.min(doc.content.size, to + 60), ' ').slice(0, 40);
  return { quote, prefix, suffix };
}
