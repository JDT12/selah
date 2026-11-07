import PptxGenJS from 'pptxgenjs';
import { deckLook } from '../../shared/slideThemes.js';
import { artPng, isTexture } from './slideArt.js';
import { passageKey, passagePages } from './slides.js';

/**
 * A deck as a PowerPoint file (11.0), made in the browser: widescreen slides in the deck's theme, fonts and art, each
 * background (gradient, picture, texture) drawn into one image, line art and the church logo as pictures, and the
 * text as real, editable text. A passage runs over as many slides as it has pages; points all show (PowerPoint
 * builds aren't made). Your notes and a question's answer go in the speaker notes. Resolves the file's name.
 */

const W = 13.333;
const H = 7.5;
const hex = (c) => String(c ?? '#000000').replace('#', '').toUpperCase();

async function loadImage(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return img;
}
async function asDataUrl(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`picture ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
}

/**
 * Everything behind a slide's text as one picture: the gradient, a picture (covering, darkened), a texture, a line
 * drawing (faint, bottom right) and the logo in its corner. It becomes a slide master's background, so each is in the
 * file once however many slides use it.
 */
async function background(palette, { bg, dim, texture, line, logo }) {
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 1080);
  grad.addColorStop(0, palette.bg);
  grad.addColorStop(1, palette.bg2 ?? palette.bg);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1920, 1080);
  if (bg) {
    try {
      const img = await loadImage(`/api/files/${bg}`);
      const s = Math.max(1920 / img.naturalWidth, 1080 / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      g.drawImage(img, (1920 - w) / 2, (1080 - h) / 2, w, h);
      g.globalAlpha = dim ?? 0.45;
      g.fillStyle = palette.bg;
      g.fillRect(0, 0, 1920, 1080);
      g.globalAlpha = 1;
    } catch { /* the picture is gone: the gradient stays */ }
  }
  if (texture) {
    const png = await artPng(texture.id, texture.color);
    if (png) {
      g.globalAlpha = 0.55;
      g.drawImage(await loadImage(png), 0, 0, 1920, 1080);
      g.globalAlpha = 1;
    }
  }
  if (line) {
    // As on screen: 46% of the width, square, a little past the bottom-right corner.
    const png = await artPng(line.id, line.color, { width: 1800 });
    if (png) {
      const size = 0.46 * 1920;
      g.globalAlpha = line.opacity;
      g.drawImage(await loadImage(png), 1920 - size + 0.02 * 1920, 1080 - size + 0.03 * 1920, size, size);
      g.globalAlpha = 1;
    }
  }
  if (logo) {
    try {
      const img = await loadImage(logo.data);
      const maxW = 0.14 * 1920;
      const maxH = 0.08 * 1920;
      const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      const mx = 0.03 * 1920;
      const my = 0.026 * 1920;
      g.drawImage(img, logo.pos.endsWith('r') ? 1920 - w - mx : mx, logo.pos.startsWith('t') ? my : 1080 - h - my, w, h);
    } catch { /* no logo */ }
  }
  return c.toDataURL('image/jpeg', 0.9);
}

/** Slide text ("**bold**", "*italics*", "- " bullets) as pptxgenjs text runs. */
function runs(text, base = {}) {
  const out = [];
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  lines.forEach((line, li) => {
    const b = /^\s*[-•]\s+(.*)$/.exec(line);
    const body = b ? b[1] : line.trim();
    const parts = body.split(/(\*\*.+?\*\*|\*[^*\s][^*]*\*)/).filter(Boolean);
    parts.forEach((p, pi) => {
      const bold = /^\*\*.+\*\*$/.test(p);
      const italic = !bold && /^\*.+\*$/.test(p);
      const t = bold ? p.slice(2, -2) : italic ? p.slice(1, -1) : p;
      out.push({ text: t, options: { ...base, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}), ...(b && pi === 0 ? { bullet: { indent: 18 } } : {}), ...(pi === parts.length - 1 && li < lines.length - 1 ? { breakLine: true } : {}) } });
    });
  });
  return out;
}

/** A passage page's HTML as runs: verse numbers raised in the accent color, lines kept. */
function passageRuns(html, accent) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const out = [];
  for (const p of doc.querySelectorAll('p')) {
    if (out.length) out[out.length - 1].options.breakLine = true;
    const lead = p.classList.contains('sl-lead');
    for (const n of p.childNodes) {
      if (n.nodeName === 'SUP') out.push({ text: `${n.textContent} `, options: { superscript: true, color: accent, bold: true } });
      else if (n.nodeType === 1 && n.classList.contains('sl-line')) {
        out.push({ text: n.textContent.replace(/…$/, ' …'), options: { ...(lead ? { italic: true } : {}) } });
        if (n.nextSibling) out[out.length - 1].options.breakLine = true;
      } else if (n.textContent.trim()) out.push({ text: n.textContent, options: lead ? { italic: true } : {} });
    }
  }
  return out;
}

export async function exportPptx({ deck, passages = {}, title = 'Slides', brand = {} }) {
  const look = deckLook(deck, brand);
  const { palette: pal, fonts } = look;
  const head = fonts.head.family;
  const body = fonts.body.family;
  const h2Face = fonts.head.style === 'italic' ? body : head;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = brand?.name || 'Selah';
  pptx.company = brand?.name || '';

  const masters = new Map();
  let logoData = null;
  if (deck.theme === 'brand' && deck.logo !== false && brand?.logo) {
    try { logoData = await asDataUrl(`/api/files/${brand.logo}`); } catch { /* no logo */ }
  }

  for (const s of deck.slides) {
    const artId = s.type === 'image' || s.art === 'none' ? null : s.art || look.art;
    const tex = artId && isTexture(artId) ? { id: artId, color: pal.art } : null;
    const line = artId && !tex ? { id: artId, color: pal.art, opacity: ['title', 'question'].includes(s.type) ? 0.22 : 0.16 } : null;
    const bg = s.type === 'image' ? null : s.bg ?? deck.bg ?? null;
    const logo = logoData && s.type !== 'image' && s.logo !== false ? { data: logoData, pos: brand.logoPos || 'tr' } : null;
    // Everything behind the text is one picture in a slide master, so it's in the file once.
    const masterKey = s.type === 'image' ? 'image' : JSON.stringify([bg, deck.dim, tex?.id, line?.id, line?.opacity, !!logo]);
    if (!masters.has(masterKey)) {
      const name = `Selah ${masters.size + 1}`;
      pptx.defineSlideMaster({ title: name, background: s.type === 'image' ? { color: '000000' } : { data: await background(pal, { bg, dim: deck.dim, texture: tex, line, logo }) } });
      masters.set(masterKey, name);
    }
    const pages = s.type === 'passage' ? passagePages(passages[passageKey(s, deck)]?.text) : [null];
    for (const [pi, pg] of (pages.length ? pages : [null]).entries()) {
      const sl = pptx.addSlide({ masterName: masters.get(masterKey) });
      const text = { fontFace: body, color: hex(pal.text), fontSize: 26, valign: 'top', margin: 0 };
      const h2 = { fontFace: h2Face, color: hex(pal.head), fontSize: 36, bold: fonts.head.style === 'italic' || fonts.head.weight >= 600, italic: false, valign: 'top', margin: 0 };
      const upper = (t) => (fonts.head.upper ? String(t).toUpperCase() : t);

      if (s.type === 'title') {
        sl.addText(upper(s.title || ''), { x: 0.8, y: 2.1, w: W - 1.6, h: 1.8, fontFace: head, fontSize: 54, color: hex(pal.head), italic: fonts.head.style === 'italic', bold: fonts.head.weight >= 700, align: 'center', valign: 'bottom', margin: 0 });
        sl.addShape(pptx.ShapeType.rect, { x: W / 2 - 0.6, y: 4.08, w: 1.2, h: 0.05, fill: { color: hex(pal.accent) }, line: { color: hex(pal.accent), width: 0 } });
        if (s.text?.trim()) sl.addText(runs(s.text), { x: 0.8, y: 4.35, w: W - 1.6, h: 1.4, fontFace: body, fontSize: 24, color: hex(pal.muted), align: 'center', valign: 'top', margin: 0 });
      } else if (s.type === 'point') {
        const points = (s.points ?? []).filter((p) => p.text.trim());
        if (!s.title && !points.length) {
          sl.addText(runs(s.text), { x: 1.2, y: 1, w: W - 2.4, h: H - 2, fontFace: head, fontSize: 40, italic: fonts.head.style === 'italic', bold: fonts.head.weight >= 700, color: hex(pal.head), align: 'center', valign: 'middle', margin: 0 });
        } else {
          if (s.title) sl.addText(upper(s.title), { ...h2, x: 0.9, y: 0.6, w: W - 1.8, h: 1.2, valign: 'bottom' });
          const all = [
            ...runs(s.text),
            ...points.flatMap((p, k) => [{ text: p.text.replace(/\*\*|\*/g, ''), options: { bullet: { indent: 22 }, indentLevel: p.level, fontSize: p.level ? 22 : 26, breakLine: k < points.length - 1 } }]),
          ];
          if (s.text?.trim() && points.length) all[runs(s.text).length - 1].options.breakLine = true;
          sl.addText(all, { ...text, x: 0.9, y: s.title ? 2.0 : 1.0, w: W - 1.8, h: H - (s.title ? 2.6 : 1.8), paraSpaceAfter: 8 });
        }
      } else if (s.type === 'passage') {
        const p = passages[passageKey(s, deck)];
        sl.addText(upper(p?.reference || s.title || s.ref || 'Passage'), { ...h2, x: 0.9, y: 0.6, w: W - 1.8, h: 1.0, valign: 'bottom' });
        if (pg) sl.addText(passageRuns(pg.html, hex(pal.accent)), { ...text, fontFace: ['Lora', 'Source Serif 4'].includes(body) ? body : 'Georgia', fontSize: 30, x: 0.9, y: 1.85, w: W - 1.8, h: H - 2.8, lineSpacingMultiple: 1.25 });
        else if (s.text?.trim()) sl.addText(runs(s.text), { ...text, x: 0.9, y: 1.85, w: W - 1.8, h: H - 2.8 });
        const credit = `${p?.translation ?? ''}${pg?.verse ? ` · verse ${pg.verse}` : ''}${pages.length > 1 ? ` · ${pi + 1}/${pages.length}` : ''}`;
        if (credit.trim()) sl.addText(credit.replace(/^ · /, ''), { x: 0.9, y: H - 0.85, w: W - 1.8, h: 0.4, fontFace: body, fontSize: 12, color: hex(pal.muted), charSpacing: 1, margin: 0 });
      } else if (s.type === 'question') {
        sl.addText('DISCUSS', { x: 1, y: 2.0, w: W - 2, h: 0.5, fontFace: body, fontSize: 14, bold: true, charSpacing: 4, color: hex(pal.accent), align: 'center', margin: 0 });
        sl.addText(s.title || '', { ...h2, fontSize: 40, x: 1, y: 2.6, w: W - 2, h: 2.2, align: 'center', valign: 'middle' });
        if (s.text?.trim()) sl.addText(runs(s.text), { ...text, x: 1.4, y: 4.9, w: W - 2.8, h: 1.6, align: 'center' });
      } else if (s.type === 'image') {
        if (s.image) {
          try {
            const data = await asDataUrl(`/api/files/${s.image}`);
            sl.addImage({ data, x: 0, y: 0, w: W, h: H, sizing: { type: s.fit === 'cover' ? 'cover' : 'contain', w: W, h: H } });
          } catch { /* the picture is gone */ }
        }
        if (s.title) sl.addText(s.title, { x: 0, y: H - 0.8, w: W, h: 0.8, fontFace: body, fontSize: 20, color: 'FFFFFF', fill: { color: '000000', transparency: 45 }, margin: [0, 24, 0, 24] });
      } else {
        if (s.title) sl.addText(upper(s.title), { ...h2, x: 0.9, y: 0.6, w: W - 1.8, h: 1.2, valign: 'bottom' });
        sl.addText(runs(s.text), { ...text, x: 0.9, y: s.title ? 2.0 : 0.9, w: W - 1.8, h: H - (s.title ? 2.6 : 1.8), paraSpaceAfter: 8 });
      }
      const notes = [s.type === 'question' && s.answer?.trim() ? `Answer: ${s.answer.trim()}` : '', s.notes?.trim() ?? ''].filter(Boolean).join('\n\n');
      if (notes && pi === 0) sl.addNotes(notes);
    }
  }
  const fileName = `${(title || 'Slides').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Slides'}.pptx`;
  await pptx.writeFile({ fileName });
  return fileName;
}

