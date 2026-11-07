import { CONCLUSION_PARTS, DIVISION_PARTS, INTRO_PARTS, field, fieldOut, getPart, parseSermon, reiterationText, sermonHtml, setPart } from './sermon.js';

/**
 * The Arrange board's moves, on the builder's sermon model. The board shows the sermon as sections (Introduction,
 * each division, Conclusion), their parts (Explanation, Illustration… and whatever sits under the heading itself),
 * and each part's blocks: paragraphs and list items. Divisions, parts and blocks move (or go); only what a move touches is
 * written again, so everything else in the note keeps its exact HTML.
 */

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const isList = (el) => el?.nodeType === 1 && (el.tagName === 'UL' || el.tagName === 'OL') && !el.hasAttribute('data-type');
/** Text of nodes with line breaks as spaces (a <br> isn't text, so textContent runs the lines together). */
const textOf = (nodes) => nodes.map((n) => {
  if (n.nodeType !== 1) return n.textContent;
  const copy = n.cloneNode(true);
  copy.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return copy.textContent;
}).join(' ').replace(/\s+/g, ' ').trim();
const attrs = (el) => [...el.attributes].map((a) => ` ${a.name}="${esc(a.value).replace(/"/g, '&quot;')}"`).join('');

// ---------- blocks ----------

/**
 * A part's HTML as blocks: { kind: 'p' | 'li', html, text, depth, tag, liAttrs, order }. Lists are flattened, so each
 * list item (at any depth) is a block of its own; anything else at the top (a paragraph, a picture, a table, a task
 * list) is one block. `order` is the block's place in delivery order (its data-order), or null.
 */
export function blocksOf(html) {
  const out = [];
  const walk = (list, depth) => {
    for (const li of [...list.children]) {
      if (li.tagName !== 'LI') continue;
      const own = [...li.childNodes].filter((n) => !isList(n));
      const html = own.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '')).join('').trim();
      out.push({ kind: 'li', tag: list.tagName.toLowerCase(), depth, html: html || '<p></p>', text: textOf(own), liAttrs: attrs(li), order: li.getAttribute('data-order') });
      for (const n of li.children) if (isList(n)) walk(n, depth + 1);
    }
  };
  for (const n of [...doc(html).childNodes]) {
    if (n.nodeType === 3) {
      if (n.textContent.trim()) out.push({ kind: 'p', depth: 0, html: `<p>${esc(n.textContent.trim())}</p>`, text: n.textContent.trim(), order: null });
    } else if (isList(n)) walk(n, 0);
    else if (n.nodeType === 1) out.push({ kind: 'p', depth: 0, html: n.outerHTML, text: textOf([n]), order: n.getAttribute('data-order') });
  }
  return out;
}

/** Blocks back to HTML: list items in a row become a list again, nested by depth. */
export function blocksHtml(blocks) {
  let out = '';
  const stack = [];
  const closeTop = () => { out += `</li></${stack.pop()}>`; };
  for (const b of blocks) {
    if (b.kind !== 'li') {
      while (stack.length) closeTop();
      out += b.html;
      continue;
    }
    const d = Math.min(b.depth, stack.length);
    while (stack.length > d + 1) closeTop();
    if (stack.length === d + 1) {
      if (stack[d] !== b.tag) closeTop();
      else out += '</li>';
    }
    if (stack.length === d) { out += `<${b.tag}>`; stack.push(b.tag); }
    out += `<li${b.liAttrs ?? ''}>${b.html}`;
  }
  while (stack.length) closeTop();
  return out;
}

/** The block at `i` with the list items nested under it. */
export function subtree(blocks, i) {
  const b = blocks[i];
  let end = i + 1;
  if (b?.kind === 'li') while (end < blocks.length && blocks[end].kind === 'li' && blocks[end].depth > b.depth) end++;
  return [i, end];
}

// ---------- sections and parts ----------

/** Section ids: 'intro', 'concl', or a division's uid. */
const known = (sec) => (sec === 'intro' ? INTRO_PARTS : sec === 'concl' ? CONCLUSION_PARTS : DIVISION_PARTS);
const blankIntro = () => parseSermon('<h1>Introduction</h1>').intro;
const blankConcl = () => ({ title: 'Conclusion', lead: '', subs: [] });

export function sectionOf(model, sec) {
  if (sec === 'intro') return model.intro ?? blankIntro();
  if (sec === 'concl') return model.conclusion ?? blankConcl();
  return model.divisions.find((d) => d.uid === sec) ?? null;
}
function withSection(model, sec, fn) {
  if (sec === 'intro') return { ...model, intro: fn(model.intro ?? blankIntro()) };
  if (sec === 'concl') return { ...model, conclusion: fn(model.conclusion ?? blankConcl()) };
  return { ...model, divisions: model.divisions.map((d) => (d.uid === sec ? fn(d) : d)) };
}

/** A part's current HTML ('lead' is what sits under the section's own heading). Unsaved typing is included. */
export function partHtml(section, part) {
  if (part === 'lead') return typeof section.lead === 'string' ? section.lead : fieldOut(section.lead);
  const s = section.subs.find((x) => x.uid === part);
  return s ? fieldOut(s.field) : '';
}
function setPartHtml(section, part, html) {
  if (part === 'lead') return { ...section, lead: typeof section.lead === 'string' ? html : field(html) };
  return { ...section, subs: section.subs.map((x) => (x.uid === part ? { ...x, field: field(html) } : x)) };
}

/** The board's view of the model: sections → parts → blocks. */
export function boardOf(model) {
  const parts = (section) => [
    { uid: 'lead', key: null, title: null, blocks: blocksOf(partHtml(section, 'lead')) },
    ...section.subs.map((s) => ({ uid: s.uid, key: s.key, title: s.title, locked: s.key === 'bridging', blocks: s.key === 'bridging' ? [] : blocksOf(fieldOut(s.field)) })),
  ];
  const intro = model.intro ?? blankIntro();
  const concl = model.conclusion ?? blankConcl();
  return [
    { id: 'intro', kind: 'intro', title: intro.title || 'Introduction', parts: parts(intro) },
    ...model.divisions.map((d, i) => ({ id: d.uid, kind: 'division', n: i + 1, division: d, parts: parts(d), stale: isStale(model, i) })),
    { id: 'concl', kind: 'concl', title: concl.title || 'Conclusion', parts: parts(concl) },
  ];
}

// ---------- moves ----------

/** Moves the division at `from` to `to` (an index in the list as it is before the move). */
export function moveDivision(model, from, to) {
  const a = [...model.divisions];
  const [d] = a.splice(from, 1);
  a.splice(to > from ? to - 1 : to, 0, d);
  return a.every((x, i) => x === model.divisions[i]) ? model : { ...model, divisions: a };
}

/**
 * Moves a part (a sub-heading with what's under it) to section `to.sec`, before the part `to.before` (or at the end).
 * A known part going where that part already is (an Illustration into a division that has one) adds to it.
 */
export function movePart(model, from, to) {
  if (from.part === 'lead' || from.part === to.before) return model;
  const src = sectionOf(model, from.sec);
  const moving = src?.subs.find((x) => x.uid === from.part);
  if (!moving || moving.key === 'bridging') return model;
  const dst = sectionOf(model, to.sec);
  if (!dst) return model;
  // The part's name only means something where it's known (Attention in a division is just a heading).
  const key = known(to.sec).some(([k]) => k === moving.key) ? moving.key : null;
  const same = key && dst.subs.find((x) => x.key === key && x.uid !== moving.uid);
  let next = withSection(model, from.sec, (s) => ({ ...s, subs: s.subs.filter((x) => x !== moving) }));
  if (same) {
    return withSection(next, to.sec, (s) => {
      const into = s.subs.find((x) => x.uid === same.uid);
      return { ...s, subs: s.subs.map((x) => (x === into ? { ...x, field: field(fieldOut(x.field) + fieldOut(moving.field)) } : x)) };
    });
  }
  next = withSection(next, to.sec, (s) => {
    const subs = [...s.subs];
    const at = to.before ? subs.findIndex((x) => x.uid === to.before) : -1;
    subs.splice(at < 0 ? subs.length : at, 0, { ...moving, key });
    return { ...s, subs };
  });
  return next;
}

/**
 * Moves block `from.index` (with the list items under it) to part `to.part` of section `to.sec`, before block
 * `to.index` (or at the end). It takes the depth of the block it lands before, so a list item dropped among sub-points
 * becomes one.
 */
export function moveBlock(model, from, to) {
  const srcBlocks = blocksOf(partHtml(sectionOf(model, from.sec), from.part));
  const [a, b] = subtree(srcBlocks, from.index);
  if (a >= srcBlocks.length) return model;
  const samePart = from.sec === to.sec && from.part === to.part;
  if (samePart && to.index != null && to.index >= a && to.index <= b) return model;
  const moving = srcBlocks.slice(a, b);
  const rest = [...srcBlocks.slice(0, a), ...srcBlocks.slice(b)];
  let next = withSection(model, from.sec, (s) => setPartHtml(s, from.part, blocksHtml(rest)));
  return insertBlocks(next, { ...to, index: samePart && to.index != null && to.index > a ? to.index - (b - a) : to.index }, moving);
}

/** Puts blocks into a part (making the part when it's a known one the section doesn't have yet). */
export function insertBlocks(model, to, blocks) {
  if (!blocks.length) return model;
  let sec = sectionOf(model, to.sec);
  if (!sec) return model;
  let part = to.part;
  if (part.startsWith('key:')) {
    // A part the section doesn't have yet (an empty Illustration slot on the board).
    const key = part.slice(4);
    const found = sec.subs.find((x) => x.key === key);
    if (!found) {
      model = withSection(model, to.sec, (s) => setPart(s, key, known(to.sec), ''));
      sec = sectionOf(model, to.sec);
    }
    part = sec.subs.find((x) => x.key === key).uid;
  }
  const target = blocksOf(partHtml(sec, part));
  const at = to.index == null ? target.length : Math.min(to.index, target.length);
  const depth = target[at]?.kind === 'li' ? target[at].depth : 0;
  const shift = depth - blocks[0].depth;
  const placed = blocks.map((x) => (x.kind === 'li' ? { ...x, depth: Math.max(0, x.depth + shift) } : x));
  target.splice(at, 0, ...placed);
  return withSection(model, to.sec, (s) => setPartHtml(s, part, blocksHtml(target)));
}

/** Takes block `at.index` (with the list items under it) out of its part. */
export function removeBlock(model, at) {
  const blocks = blocksOf(partHtml(sectionOf(model, at.sec), at.part));
  const [a, b] = subtree(blocks, at.index);
  if (a >= blocks.length) return model;
  return withSection(model, at.sec, (s) => setPartHtml(s, at.part, blocksHtml([...blocks.slice(0, a), ...blocks.slice(b)])));
}

/** Takes a part (its sub-heading and what's under it) out of its section; for 'lead', what's under the section's heading. */
export function removePart(model, at) {
  const sec = sectionOf(model, at.sec);
  if (!sec) return model;
  if (at.part === 'lead') return partHtml(sec, 'lead').trim() ? withSection(model, at.sec, (s) => setPartHtml(s, 'lead', '')) : model;
  const part = sec.subs.find((x) => x.uid === at.part);
  if (!part || part.key === 'bridging') return model;
  return withSection(model, at.sec, (s) => ({ ...s, subs: s.subs.filter((x) => x !== part) }));
}

/** Takes the division at `i` out of the sermon. */
export const removeDivision = (model, i) => (model.divisions[i] ? { ...model, divisions: model.divisions.filter((_, j) => j !== i) } : model);

/** A list item one level in (under the item above it) or out. */
export function indentBlock(model, at, by) {
  const blocks = blocksOf(partHtml(sectionOf(model, at.sec), at.part));
  const [a, b] = subtree(blocks, at.index);
  const blk = blocks[a];
  if (blk?.kind !== 'li') return model;
  const prev = blocks[a - 1];
  const max = prev?.kind === 'li' ? prev.depth + 1 : 0;
  const depth = Math.max(0, Math.min(max, blk.depth + by));
  if (depth === blk.depth) return model;
  for (let i = a; i < b; i++) blocks[i] = { ...blocks[i], depth: blocks[i].depth + depth - blk.depth };
  return withSection(model, at.sec, (s) => setPartHtml(s, at.part, blocksHtml(blocks)));
}

/** Blocks from any HTML (a bank item going into the sermon). */
export const htmlBlocks = (html) => blocksOf(html);

// ---------- after a move ----------

/** A transition no longer leads where it was written to lead (its division moved, or the next one did). */
export function isStale(model, i) {
  const d = model.divisions[i];
  if (!d?.transition?.trim() || d.transTo === undefined) return false;
  return d.transTo !== (model.divisions[i + 1]?.uid ?? null);
}

/** Marks a division's transition as right for where it is now (it was rewritten, or it still fits). */
export const fitTransition = (model, uid) => ({
  ...model,
  divisions: model.divisions.map((d, i) => (d.uid === uid ? { ...d, transTo: model.divisions[i + 1]?.uid ?? null } : d)),
});

/**
 * After a move: when the conclusion's Reiteration was the divisions as listed (as the builder fills it in), it's
 * listed again in the new order. Returns the model and whether a reiteration written by hand may now be out of order.
 */
export function afterMove(before, after) {
  if (after === before) return { model: after, reiteration: false };
  const was = reiterationText(before);
  const now = reiterationText(after);
  if (was === now) return { model: after, reiteration: false };
  const r = getPart(after.conclusion, 'reiteration');
  if (!r.rich && r.text.trim() === was.trim() && was.trim()) {
    return { model: { ...after, conclusion: setPart(after.conclusion, 'reiteration', CONCLUSION_PARTS, now) }, reiteration: false };
  }
  return { model: after, reiteration: !!r.text.trim() };
}

// ---------- delivery order ----------

/** A block with its delivery number set (a string) or cleared (null). */
function withOrder(b, v) {
  if (b.kind === 'li') {
    const li = doc(`<ul><li${b.liAttrs ?? ''}></li></ul>`).querySelector('li');
    if (v) li.setAttribute('data-order', v); else li.removeAttribute('data-order');
    return { ...b, order: v, liAttrs: attrs(li) };
  }
  const el = doc(b.html).firstElementChild;
  if (!el) return b;
  if (v) el.setAttribute('data-order', v); else el.removeAttribute('data-order');
  return { ...b, order: v, html: el.outerHTML };
}
/** A block worth a number: something to say (not an empty line). */
export const numberable = (b) => b.depth === 0 && (!!b.text || /<img\b/i.test(b.html));

/** Sets (or, with no number, clears) where block `at.index` comes when the division is preached. */
export function setBlockOrder(model, at, n) {
  const sec = sectionOf(model, at.sec);
  if (!sec) return model;
  const blocks = blocksOf(partHtml(sec, at.part));
  const b = blocks[at.index];
  const v = Number(n) > 0 ? String(Math.min(999, Math.floor(Number(n)))) : null;
  if (!b || (b.order ?? null) === v) return model;
  blocks[at.index] = withOrder(b, v);
  return withSection(model, at.sec, (s) => setPartHtml(s, at.part, blocksHtml(blocks)));
}

/** Numbers a division's blocks 1, 2, 3… as they're grouped now (or clears them all). */
export function numberDivision(model, uid, clear = false) {
  const d = sectionOf(model, uid);
  if (!d) return model;
  let n = 0;
  let next = model;
  for (const part of ['lead', ...d.subs.map((s) => s.uid)]) {
    const blocks = blocksOf(partHtml(sectionOf(next, uid), part));
    if (!blocks.length) continue;
    const out = blocks.map((b) => (numberable(b) ? withOrder(b, clear ? null : String(++n)) : b));
    if (out.some((b, i) => b !== blocks[i])) next = withSection(next, uid, (s) => setPartHtml(s, part, blocksHtml(out)));
  }
  return next;
}

/**
 * A division's material in the order it will be preached: units of a top-level block with the sub-points under it,
 * each knowing which element (part) it came from. Numbered units go in number order; what's under the division
 * heading itself and isn't numbered stays first, and anything else unnumbered comes last, as it's grouped now.
 */
export function deliveryUnits(d) {
  const parts = [{ key: 'lead', title: null, html: partHtml(d, 'lead') }, ...d.subs.map((s) => ({ key: s.key, title: s.title, html: fieldOut(s.field) }))];
  const units = [];
  for (const p of parts) {
    const blocks = blocksOf(p.html);
    for (let i = 0; i < blocks.length;) {
      const [, e] = subtree(blocks, i);
      const order = Number(blocks[i].order) || null;
      units.push({ key: p.key, title: p.title, order, blocks: blocks.slice(i, e), seq: units.length });
      i = e;
    }
  }
  const rank = (u) => (u.order ? 1 : u.key === 'lead' ? 0 : 2);
  return units.sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0) || a.seq - b.seq);
}

const hasOrder = (d) => [partHtml(d, 'lead'), ...d.subs.map((s) => fieldOut(s.field))].some((h) => /data-order=/.test(h));
const elementOf = (key) => (DIVISION_PARTS.some(([k]) => k === key) ? key : 'other');
const wrap = (key, title, inner, color) => (color && key !== 'lead'
  ? `<div data-element="${elementOf(key)}"><p data-element-label="">${esc(title ?? '')}</p>${inner}</div>` : inner);

/** An element's top-level lines (split at its own line breaks), each as HTML. */
function linesOf(html) {
  const lines = [''];
  for (const n of [...doc(html).childNodes]) {
    if (n.nodeType === 1 && n.tagName === 'BR') lines.push('');
    else lines[lines.length - 1] += n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '';
  }
  return lines.map((l) => l.trim()).filter((l) => l.replace(/<[^>]+>/g, '').trim() || /<img\b/i.test(l));
}

/**
 * Units as one outline: each unit a main numbered item, the further lines of its paragraph and its own sub-points
 * as sub-levels. With `color`, a main item carries its element and name.
 */
function outlineBlocks(units, color) {
  const out = [];
  for (const u of units) {
    const [first, ...subs] = u.blocks;
    const el = doc(first.html).firstElementChild;
    // A paragraph (or a list item's paragraph) splits into lines; a table, picture or quote stays whole.
    const para = first.kind === 'li' ? el?.tagName === 'P' && first.html.trim().startsWith('<p') && doc(first.html).children.length === 1 : el?.tagName === 'P';
    const lines = para ? linesOf(el.innerHTML) : [first.html];
    if (!lines.length) continue;
    const label = color && u.key !== 'lead' ? `<span data-element-label="">${esc(u.title ?? '')}</span> ` : '';
    const attrs = color && u.key !== 'lead' ? ` data-element="${elementOf(u.key)}"` : '';
    out.push({ kind: 'li', tag: 'ol', depth: 0, html: para ? `<p>${label}${lines[0]}</p>` : `${label ? `<p>${label}</p>` : ''}${first.html}`, liAttrs: attrs });
    for (const l of lines.slice(1)) out.push({ kind: 'li', tag: 'ol', depth: 1, html: `<p>${l}</p>` });
    for (const b of subs) out.push({ ...b, kind: 'li', tag: 'ol', depth: b.depth + 1, liAttrs: '' });
  }
  return out;
}

/** Whether a note reads as a sermon (a division with an Explanation, Illustration… under it). */
export function isSermonHtml(html) {
  if (!/<h2\b/i.test(html ?? '')) return false;
  return parseSermon(html).divisions.some((d) => d.subs.some((s) => DIVISION_PARTS.some(([k]) => k === s.key)));
}
export const hasDeliveryOrder = (html) => /data-order=/.test(html ?? '') && isSermonHtml(html);

/**
 * A sermon note as it will be preached, for preaching mode and Word: each numbered division's blocks in delivery
 * order (its Explanation/Illustration headings give way to the order), the rest as grouped. With `color`, each run of
 * one element is marked (data-element, with its name as a small label) for color coding. With `list`, a numbered
 * division is an outline instead: each block a numbered item, its further lines and sub-points beneath it.
 * The note itself is untouched.
 */
export function deliveryHtml(html, { order = true, color = false, list = false } = {}) {
  if (!html || !isSermonHtml(html) || (!color && !(order && /data-order=/.test(html)))) return html;
  const model = parseSermon(html);
  const divisions = model.divisions.map((d) => {
    if (order && hasOrder(d) && list) {
      return { ...d, lead: field(`<div data-delivery-list="">${blocksHtml(outlineBlocks(deliveryUnits(d), color))}</div>`), subs: [] };
    }
    if (order && hasOrder(d)) {
      const runs = [];
      for (const u of deliveryUnits(d)) {
        const last = runs[runs.length - 1];
        if (last && last.key === u.key) last.blocks.push(...u.blocks);
        else runs.push({ key: u.key, title: u.title, blocks: [...u.blocks] });
      }
      return { ...d, lead: field(runs.map((r) => wrap(r.key, r.title, blocksHtml(r.blocks), color)).join('')), subs: [] };
    }
    if (!color) return d;
    return { ...d, subs: d.subs.map((s) => (fieldOut(s.field).trim() ? { ...s, field: field(`<div data-element="${elementOf(s.key)}">${fieldOut(s.field)}</div>`) } : s)) };
  });
  return sermonHtml({ ...model, divisions });
}

// ---------- compare ----------

/** The sermon as outline lines, for comparing with the saved note. */
export function outlineLines(model) {
  const lines = [];
  for (const s of boardOf(model)) {
    const head = s.kind === 'division' ? `${s.n}. ${s.division.statement || 'Untitled Division'}` : s.title;
    lines.push({ level: 0, text: head });
    for (const p of s.parts) {
      if (p.title) lines.push({ level: 1, text: p.title });
      for (const b of p.blocks) if (b.text) lines.push({ level: 2 + b.depth, text: b.text.length > 90 ? `${b.text.slice(0, 88)}…` : b.text });
    }
  }
  return lines;
}

/** Which lines of two outlines are the same (longest common subsequence, by text and level). */
export function diffLines(a, b) {
  const key = (l) => `${l.level}|${l.text}`;
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = key(a[i]) === key(b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const keepA = new Set();
  const keepB = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (key(a[i]) === key(b[j])) { keepA.add(i++); keepB.add(j++); } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
  }
  return { a: a.map((l, i) => ({ ...l, changed: !keepA.has(i) })), b: b.map((l, i) => ({ ...l, changed: !keepB.has(i) })) };
}
