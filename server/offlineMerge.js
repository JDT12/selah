// 14.4: notes edited in the phone or tablet app with no connection (mobile-app/www/shell.js) merge back here when the
// app is online again. The note is split into its top-level blocks (paragraphs, headings, lists…) and merged three
// ways: the note as the device saved it (base), the device's edits (mine) and the note now (theirs). A block changed
// in only one place takes that change; a block changed in both keeps both, theirs first. Nothing asks which to keep.

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'source', 'wbr']);

/** The top-level blocks of a note's HTML, as strings (text between blocks is kept as its own block). */
export function splitBlocks(html) {
  const s = String(html ?? '');
  const out = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = 0;
  let m;
  while ((m = tag.exec(s))) {
    const [, close, name, selfClose] = m;
    const n = name.toLowerCase();
    if (depth === 0 && m.index > start) {
      const text = s.slice(start, m.index);
      if (text.trim()) out.push(text);
      start = m.index;
    }
    if (close) depth = Math.max(0, depth - 1);
    else if (!selfClose && !VOID.has(n)) depth++;
    if (depth === 0) {
      out.push(s.slice(start, tag.lastIndex));
      start = tag.lastIndex;
    }
  }
  if (s.slice(start).trim()) out.push(s.slice(start));
  return out;
}

/** Pairs of equal items (indexes into a and b), by longest common subsequence. */
function matches(a, b) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return pairs;
}

/**
 * Three-way merge of block lists. Returns { blocks, conflicts } where conflicts counts the places both sides changed
 * the same stretch differently (both kept).
 */
export function merge3(base, mine, theirs) {
  const toMine = new Map(matches(base, mine));
  const toTheirs = new Map(matches(base, theirs));
  // Base blocks kept unchanged on both sides anchor the merge.
  const anchors = base.map((_, i) => i).filter((i) => toMine.has(i) && toTheirs.has(i));
  const out = [];
  let conflicts = 0;
  let b0 = 0;
  let m0 = 0;
  let t0 = 0;
  const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  const chunk = (b1, m1, t1) => {
    const B = base.slice(b0, b1);
    const M = mine.slice(m0, m1);
    const T = theirs.slice(t0, t1);
    if (same(M, B)) out.push(...T);
    else if (same(T, B) || same(M, T)) out.push(...M);
    else { out.push(...T, ...M); conflicts++; }
  };
  for (const i of anchors) {
    chunk(i, toMine.get(i), toTheirs.get(i));
    out.push(base[i]);
    b0 = i + 1;
    m0 = toMine.get(i) + 1;
    t0 = toTheirs.get(i) + 1;
  }
  chunk(base.length, mine.length, theirs.length);
  return { blocks: out, conflicts };
}

/** Merges a device's offline edit of a note's HTML into the note as it is now. */
export function mergeOffline({ base, mine, theirs }) {
  if (mine === base) return { html: theirs, conflicts: 0, changed: false };
  if (theirs === base) return { html: mine, conflicts: 0, changed: true };
  const r = merge3(splitBlocks(base), splitBlocks(mine), splitBlocks(theirs));
  return { html: r.blocks.join(''), conflicts: r.conflicts, changed: true };
}
