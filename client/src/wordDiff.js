/**
 * The changes between two texts as runs of { type: 'same' | 'add' | 'del', text }, by word (or by line when the
 * texts are long). Plain longest-common-subsequence; the common start and end are skipped first.
 */
export function wordDiff(a, b) {
  const words = (s) => s.match(/\s+|[^\s]+/g) ?? [];
  const lines = (s) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let A = words(a);
  let B = words(b);
  if (A.length * B.length > 6e6) { A = lines(a); B = lines(b); }
  if (A.length * B.length > 6e6) return [{ type: 'del', text: a }, { type: 'add', text: b }];

  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start += 1;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA -= 1; endB -= 1; }

  const n = endA - start;
  const m = endB - start;
  // lcs[i][j]: common length of A[start+i..] and B[start+j..]
  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[at(i, j)] = A[start + i] === B[start + j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last?.type === type) last.text += text;
    else out.push({ type, text });
  };
  if (start) push('same', A.slice(0, start).join(''));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[start + i] === B[start + j]) { push('same', A[start + i]); i += 1; j += 1; }
    else if (j < m && (i === n || lcs[at(i, j + 1)] >= lcs[at(i + 1, j)])) { push('add', B[start + j]); j += 1; }
    else { push('del', A[start + i]); i += 1; }
  }
  if (endA < A.length) push('same', A.slice(endA).join(''));
  return out;
}
