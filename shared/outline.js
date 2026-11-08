// Outline numbering for numbered lists, used everywhere Selah numbers them (the editor's styles, Word and PDF exports,
// the iPad export, Selah Companion): 1. → A. → I. → 1. → a. → i. → (1) → (a) → (i), then round again.
const roman = (n) => [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  .reduce((s, [v, r]) => { let out = s; while (n >= v) { out += r; n -= v; } return out; }, '');
const letter = (n) => { let s = ''; let x = n; while (x > 0) { x -= 1; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26); } return s; };

/** The marker for item `n` (from 1) of a numbered list nested `level` numbered lists deep (0 = top). */
export function outlineMarker(level, n) {
  switch (level % 9) {
    case 0: case 3: return `${n}.`;
    case 1: return `${letter(n)}.`;
    case 2: return `${roman(n)}.`;
    case 4: return `${letter(n).toLowerCase()}.`;
    case 5: return `${roman(n).toLowerCase()}.`;
    case 6: return `(${n})`;
    case 7: return `(${letter(n).toLowerCase()})`;
    default: return `(${roman(n).toLowerCase()})`;
  }
}
