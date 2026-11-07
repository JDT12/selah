import { useMemo } from 'react';
import { findReferences, logosUrl } from '../../../shared/scripture.js';
import { openPassage } from '../logos.js';

/** Bible references in some HTML become Logos links with hover cards (Bible text when a translation is connected). */
export function linkRefs(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const found = findReferences(node.data);
    if (!found.length) continue;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(node.data.slice(at, f.from));
      const a = doc.createElement('a');
      a.className = 'bible-ref';
      a.href = logosUrl(f.refs[0]);
      a.textContent = node.data.slice(f.from, f.to);
      a.dataset.refs = f.refs.map((r) => r.label).join('; ');
      a.dataset.ref = JSON.stringify(f.refs[0]);
      a.dataset.hint = 'Click to open in Logos';
      frag.append(a);
      at = f.to;
    }
    frag.append(node.data.slice(at));
    node.replaceWith(frag);
  }
  return root.innerHTML;
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default function Scripture({ html, text, as: Tag = 'div', className }) {
  const inner = useMemo(() => linkRefs(html ?? escapeHtml(text ?? '')), [html, text]);
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: inner }} />;
}

/** A click handler for a container of Scripture: references open in Logos (the desktop app or the web, per Settings → Logos). */
export function openRefClick(e) {
  const a = e.target.closest?.('.bible-ref');
  if (!a) return;
  e.preventDefault();
  openPassage(JSON.parse(a.dataset.ref));
}
