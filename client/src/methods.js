import { methodById, OTHER_NOTES } from '../../shared/methods.js';

/**
 * Switching a note to another method (shared/methods.js): the note is cut at its method's section headings, each
 * section is matched to a role, and the new method's skeleton is filled from those roles in order. Nothing is
 * dropped: a section the new method has no place for goes under Other notes with its own heading, and when more
 * than one section lands in the same place each keeps its heading there. Whatever came before the first section (the
 * passage line, a title line) stays at the top.
 */
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const outer = (nodes) => nodes.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '')).join('');
const hasContent = (nodes) => nodes.some((n) => (n.nodeType === 3 ? n.textContent.trim() : n.nodeType === 1 && (n.textContent.trim() || n.querySelector?.('img, [data-attachment], iframe') || n.tagName === 'IMG')));
const BIG_IDEA = /^\s*big idea\s*:\s*/i;

/** Headings inside moved content shift by `by` levels (kept between H1 and H6) so they stay under their new section. */
function shiftHeadings(nodes, by) {
  if (!by) return nodes;
  return nodes.map((n) => {
    if (n.nodeType !== 1) return n;
    const swap = (h) => {
      const level = Math.min(6, Math.max(1, Number(h.tagName[1]) + by));
      const made = h.ownerDocument.createElement(`h${level}`);
      for (const a of h.attributes) made.setAttribute(a.name, a.value);
      made.innerHTML = h.innerHTML;
      return made;
    };
    if (/^H[1-6]$/.test(n.tagName)) return swap(n);
    const copy = n.cloneNode(true);
    copy.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => h.replaceWith(swap(h)));
    return copy;
  });
}

/** The note as chunks: { preamble, chunks: [{ title, titleHtml, nodes, role, keepHeading }] }. */
export function readSections(html, method) {
  const tag = `H${method.level}`;
  const lead = [];
  const parts = [];
  for (const n of doc(html).childNodes) {
    if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
    else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
  }
  const used = new Set();
  const chunks = [];
  for (const p of parts) {
    const at = method.sections.findIndex((s, i) => !used.has(i) && s.match.test(p.title));
    if (at >= 0) {
      used.add(at);
      const roles = method.sections[at].roles;
      let nodes = p.nodes;
      // "Big idea: …" at the top of a section that holds the idea is the idea itself.
      if (roles.includes('idea') && roles[0] !== 'idea') {
        const big = nodes.find((n) => n.nodeType === 1 && n.tagName === 'P' && BIG_IDEA.test(n.textContent));
        if (big) {
          const text = big.textContent.replace(BIG_IDEA, '').trim();
          if (text) chunks.push({ title: 'Big idea', titleHtml: 'Big idea', nodes: [...doc(`<p>${esc(text)}</p>`).childNodes], role: 'idea', keepHeading: false });
          nodes = nodes.filter((n) => n !== big);
        }
      }
      // A section with no role of its own (a second or third point) is more of whatever came before it.
      const role = roles[0] ?? [...chunks].reverse().find((c) => !c.keepHeading)?.role ?? 'other';
      chunks.push({ title: p.title, titleHtml: p.titleHtml, nodes, role, keepHeading: !roles[0] });
    } else {
      chunks.push({ title: p.title, titleHtml: p.titleHtml, nodes: p.nodes, role: method.rest ?? 'other', keepHeading: true });
    }
  }
  return { preamble: lead, chunks: chunks.filter((c) => hasContent(c.nodes)) };
}

/** The note's HTML laid out in another method of the same workflow. */
export function convertHtml(html, fromId, toId) {
  const from = methodById(fromId);
  const to = methodById(toId);
  if (!from || !to || from.workflow !== to.workflow) throw new Error('Those methods aren’t for the same kind of note');
  const { preamble, chunks: read } = readSections(html, from);
  const shift = to.level - from.level;
  const sub = Math.min(6, to.level + 1);
  const into = to.sections.map(() => []);
  // Going to a method whose sections sit a level deeper (a lesson's exposition into the three points): headings at
  // that level inside a section that name one of the new method's sections go back to it.
  const chunks = [];
  for (const c of read) {
    if (shift <= 0 || c.keepHeading) { chunks.push(c); continue; }
    const tag = `H${to.level}`;
    const lead = [];
    const parts = [];
    for (const n of c.nodes) {
      if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
      else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
    }
    if (!parts.length) { chunks.push(c); continue; }
    if (hasContent(lead)) chunks.push({ ...c, nodes: lead });
    for (const p of parts) {
      const at = to.sections.findIndex((s, i) => s.match.test(p.title) && !into[i].length && !chunks.some((x) => x.target === i));
      chunks.push(at >= 0 ? { ...p, role: c.role, target: at, keepHeading: false, level: to.level } : { ...p, role: c.role, keepHeading: true, level: to.level });
    }
  }
  // Each chunk goes to its own section when it named one, else the first section of the new method that takes its role.
  const rest = [];
  const other = [];
  for (const c of chunks.filter((x) => hasContent(x.nodes))) {
    if (c.target !== undefined) { into[c.target].push(c); continue; }
    const at = to.sections.findIndex((s) => s.roles.includes(c.role));
    if (at >= 0) into[at].push(c);
    else if (to.rest && c.role === to.rest) rest.push(c);
    else other.push(c);
  }
  // A part cut at the new method's own level is already at its depth; everything else moves by the difference.
  const body = (c) => outer(shiftHeadings(c.nodes, c.level === to.level ? 0 : shift));
  const headed = (c) => `<h${sub}>${c.titleHtml}</h${sub}>${body(c)}`;
  const fill = (s, list) => {
    if (!list.length) return '<p></p>';
    // The big idea in a section that holds more than it (a lesson's exposition) reads "Big idea: …".
    return list.map((c) => {
      if (c.role === 'idea' && s.roles[0] !== 'idea') return `<p><strong>Big idea:</strong> ${esc(c.nodes.map((n) => n.textContent).join(' ').trim())}</p>`;
      return list.length === 1 && !c.keepHeading ? body(c) : headed(c);
    }).join('');
  };
  const out = [outer(preamble)];
  const sections = to.sections.map((s, i) => `<h${to.level}>${esc(s.title)}</h${to.level}>${fill(s, into[i])}`);
  // A method with a body of its own sections (a sermon's divisions) keeps them before its last section.
  if (rest.length) sections.splice(Math.max(1, sections.length - 1), 0, ...rest.map((c) => `<h${to.level}>${c.titleHtml}</h${to.level}>${body(c)}`));
  out.push(...sections);
  if (other.length) out.push(`<h${to.level}>${OTHER_NOTES}</h${to.level}>${other.map(headed).join('')}`);
  return out.join('');
}
