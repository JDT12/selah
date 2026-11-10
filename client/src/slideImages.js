import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { toBlob } from 'html-to-image';
import JSZip from 'jszip';
import { SlideView } from './components/SlideView.jsx';
import { passageKey, passagePages } from './slides.js';

/**
 * A deck as pictures (13.0): each slide drawn exactly as it shows when presenting, 1920 × 1080 PNG, in a .zip
 * (01.png, 02.png …), for a church's own presentation software or a screen that only takes pictures. Every point
 * shows; a passage gives one picture per page, as in the PowerPoint. Resolves the file's name.
 */
const W = 1920;
const H = 1080;
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function settle(node) {
  // The brand (logo, colors) loads after the first render; pictures and fonts must be in before drawing.
  await tick();
  await tick();
  await document.fonts?.ready;
  await Promise.all([...node.querySelectorAll('img')].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  await tick();
}

export async function exportImages({ deck, passages = {}, title = 'Slides', onProgress }) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '-30000px', top: '0', width: `${W}px`, pointerEvents: 'none' });
  document.body.append(host);
  const root = createRoot(host);
  const zip = new JSZip();
  const pages = [];
  for (const s of deck.slides) {
    const n = s.type === 'passage' ? Math.max(1, passagePages(passages[passageKey(s, deck)]?.text).length) : 1;
    for (let step = 0; step < n; step++) pages.push({ slide: s, step, passage: s.type === 'passage' });
  }
  try {
    for (const [i, pg] of pages.entries()) {
      onProgress?.(i + 1, pages.length);
      // A passage page by its step; anything else with every point showing.
      root.render(createElement(SlideView, { slide: pg.slide, step: pg.step, all: !pg.passage, deck, passages, fit: true }));
      await settle(host);
      const node = host.querySelector('.slide');
      const blob = await toBlob(node, { width: W, height: H, pixelRatio: 1, cacheBust: false });
      if (!blob) throw new Error(`slide ${i + 1} couldn’t be drawn`);
      zip.file(`${String(i + 1).padStart(2, '0')}.png`, blob);
    }
  } finally {
    root.unmount();
    host.remove();
  }
  const name = `${String(title).replace(/[\\/:*?"<>|]+/g, '').trim() || 'Slides'} (slides).zip`;
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return name;
}
