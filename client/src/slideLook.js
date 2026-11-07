import { useEffect, useState } from 'react';
import { api } from './api.js';
import { deckLook } from '../../shared/slideThemes.js';

/**
 * How a deck looks on screen (11.0): the church brand (loaded once, shared by every slide), the CSS variables a slide
 * is drawn with, and which passage text a slide reads (its own translation, else the deck's, else your favorite).
 */

let brand = null;
let loading = null;
export function loadBrand(fresh = false) {
  if (fresh) { brand = null; loading = null; }
  loading ??= api.slideBrand().then((b) => { brand = b ?? {}; return brand; }).catch(() => { brand = {}; return brand; });
  return loading;
}
export function brandChanged(b) {
  brand = b;
  loading = Promise.resolve(b);
  window.dispatchEvent(new CustomEvent('noteapp:brand-changed', { detail: b }));
}
/** The church brand ({} until it loads or when there's none). */
export function useBrand() {
  const [b, setB] = useState(brand ?? {});
  useEffect(() => {
    let live = true;
    loadBrand().then((x) => live && setB(x));
    const on = (e) => setB(e.detail ?? {});
    window.addEventListener('noteapp:brand-changed', on);
    return () => { live = false; window.removeEventListener('noteapp:brand-changed', on); };
  }, []);
  return b;
}

/** A deck's look as CSS variables for a slide (see .slide in styles.css). */
export function lookVars(look) {
  const { palette: p, fonts: f } = look;
  return {
    '--s-bg': p.bg, '--s-bg2': p.bg2, '--s-text': p.text, '--s-muted': p.muted, '--s-accent': p.accent, '--s-head': p.head, '--s-art': p.art,
    '--s-head-font': `'${f.head.family}', Georgia, serif`, '--s-head-weight': f.head.weight, '--s-head-style': f.head.style ?? 'normal',
    '--s-head-case': f.head.upper ? 'uppercase' : 'none', '--s-body-font': `'${f.body.family}', system-ui, sans-serif`,
    // A script-like heading font (Classic's italic) is for titles only; slide headings then use the text font, bold.
    '--s-h2-font': f.head.style === 'italic' ? `'${f.body.family}', system-ui, sans-serif` : `'${f.head.family}', Georgia, serif`,
    '--s-h2-weight': f.head.style === 'italic' ? 700 : f.head.weight,
    '--s-h2-case': f.head.upper ? 'uppercase' : 'none',
    // Bible text in a book face: the pair's own when it's a serif, else Georgia.
    '--s-passage-font': ['Lora', 'Source Serif 4'].includes(f.body.family) ? `'${f.body.family}'` : 'Georgia',
  };
}
export { deckLook };
