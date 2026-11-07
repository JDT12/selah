/**
 * Handwriting to text, the browser's half: turn a photo, a PDF or a pen drawing into clean page images for the
 * server's Tesseract (server/ocr.js), then turn what it read back into note paragraphs and lists.
 */

const MAX_SIDE = 2600; // big enough for small writing, small enough to read quickly
const MIN_WIDTH = 1400; // small pictures are scaled up; Tesseract likes letters 20-40 px tall
const MAX_PAGES = 30;
export const UNSURE = 60; // words read with less confidence than this get marked

export const isPdf = (type = '', name = '') => type === 'application/pdf' || /\.pdf$/i.test(name);

/** Pages ({ canvas, label }) from an image or PDF File/Blob. */
export async function pagesFromFile(file) {
  if (isPdf(file.type, file.name)) return pdfPages(file);
  if (/image\/(heic|heif)/i.test(file.type) || (!file.type && /\.(heic|heif)$/i.test(file.name ?? ''))) {
    throw new Error('HEIC photos can’t be read here. Set the camera to “Most Compatible” (JPEG), or share the photo as JPEG.');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This picture can’t be opened. Try a JPEG or PNG.');
  }
  const canvas = prepare(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  return [{ canvas, label: 'Photo' }];
}

/** Pages from a file already in the note (an image or a PDF attachment). */
export async function pagesFromUrl(url, name = '') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t load the file (${res.status})`);
  const blob = await res.blob();
  return pagesFromFile(new File([blob], name || 'file', { type: blob.type }));
}

// pdf.js 6 uses JavaScript added in 2025-26 (Map.getOrInsertComputed, Math.sumPrecise, Uint8Array.toHex…).
// Browsers that lag behind (Samsung Internet, older iPads) get them here, on this page and in pdf.js's worker.
// Self-contained: the worker gets its source text.
function addMissing() {
  const def = (o, k, f) => { if (!o[k]) Object.defineProperty(o, k, { value: f, writable: true, configurable: true }); };
  for (const M of [Map, WeakMap]) {
    def(M.prototype, 'getOrInsert', function getOrInsert(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); });
    def(M.prototype, 'getOrInsertComputed', function getOrInsertComputed(k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); });
  }
  def(Uint8Array.prototype, 'toHex', function toHex() { return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join(''); });
  def(Math, 'sumPrecise', (list) => { let sum = 0; for (const n of list) sum += n; return sum; });
  def(Promise, 'try', (f, ...args) => new Promise((resolve) => { resolve(f(...args)); }));
}

let pdfjsReady = null;
function loadPdfjs() {
  pdfjsReady ??= (async () => {
    addMissing();
    const pdfjs = await import(/* @vite-ignore */ '/pdfjs/build/pdf.mjs');
    const src = `(${addMissing.toString()})();\nawait import(${JSON.stringify(`${location.origin}/pdfjs/build/pdf.worker.mjs`)});`;
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return pdfjs;
  })().catch((e) => { pdfjsReady = null; throw e; });
  return pdfjsReady;
}

// If pdf.js stalls (a browser missing something it needs), say so rather than wait forever.
const inTime = (promise, ms = 60000) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error('This browser couldn’t open the PDF. Try it in an up-to-date Chrome, Edge or Safari.')), ms);
})]);

/** A PDF's own text (not OCR), page by page up to maxPages, lines kept. For a typed PDF like a syllabus. */
export async function pdfText(file, maxPages = 8) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await inTime(task.promise);
  let out = '';
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      for (const it of items) out += (it.str ?? '') + (it.hasEOL ? '\n' : '');
      out += '\n';
    }
  } finally {
    task.destroy();
  }
  return out;
}

async function pdfPages(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await inTime(task.promise);
  const pages = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(MAX_SIDE / Math.max(base.width, base.height), 4) });
      const raw = document.createElement('canvas');
      raw.width = Math.round(viewport.width);
      raw.height = Math.round(viewport.height);
      const ctx = raw.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, raw.width, raw.height);
      await inTime(page.render({ canvasContext: ctx, viewport }).promise);
      pages.push({ canvas: prepare(raw, raw.width, raw.height), label: `Page ${n}` });
    }
  } finally {
    task.destroy();
  }
  if (doc.numPages > MAX_PAGES) pages.truncated = doc.numPages;
  return pages;
}

/**
 * Scale the picture and even it out: gray, with the paper made white. Phone photos of paper have shadows and a
 * slope of light across them; dividing each pixel by the local paper brightness takes that out, so Tesseract's
 * black/white split keeps faint pencil and doesn't turn a shadow into a blot.
 */
function prepare(source, width, height) {
  let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (width * scale < MIN_WIDTH) scale = Math.min(MIN_WIDTH / width, MAX_SIDE / Math.max(width, height), 3);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

  // Paper brightness: the brightest pixels in each cell of a coarse grid, smoothed, then read back bilinearly.
  const cell = Math.max(16, Math.round(Math.max(w, h) / 40));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let max = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) max = Math.max(max, gray[y * w + x]);
      }
      grid[gy * gw + gx] = max;
    }
  }
  const smooth = new Float32Array(grid.length);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x >= 0 && y >= 0 && x < gw && y < gh) { sum += grid[y * gw + x]; n++; }
        }
      }
      smooth[gy * gw + gx] = sum / n;
    }
  }
  const at = (x, y) => smooth[Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    const fy = y / cell - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x / cell - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const paper = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      const j = y * w + x;
      // Even it out, then stretch: paper → white, ink a little darker.
      const v = paper > 24 ? (gray[j] / paper) * 255 : gray[j];
      const out = Math.max(0, Math.min(255, (v - 40) * (255 / 200)));
      const i = j * 4;
      px[i] = px[i + 1] = px[i + 2] = out;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export const canvasBlob = (canvas) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the picture'))), 'image/png'));

// ---- what Tesseract read → note HTML ----

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bare = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const BULLET = /^\s*(?:[-–—•*·▪●○◦>]|\+(?=\s))\s*/;
const NUMBER = /^\s*(\d{1,2})[.)]\s+/;

/** The words read with low confidence (as bare lowercase strings). */
export function unsureWords(results) {
  const out = new Set();
  for (const r of results) {
    for (const p of r.paragraphs) for (const l of p.lines) for (const w of l.words) if (w.confidence < UNSURE && bare(w.text)) out.add(bare(w.text));
  }
  return out;
}

/**
 * Text (as edited in the dialog) → HTML. A blank line starts a new paragraph. Lines starting with a dash or bullet
 * become a bulleted list, "1." or "1)" a numbered one. keepLines keeps each written line as its own paragraph;
 * otherwise the lines of a paragraph run together. Words in `unsure` that are still as read get highlighted.
 */
export function textToHtml(text, { keepLines = true, unsure = new Set() } = {}) {
  const inline = (s) => s.split(/(\s+)/).map((tok) => (tok.trim() && unsure.has(bare(tok)) ? `<mark>${esc(tok)}</mark>` : esc(tok))).join('');
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let list = null; // { tag, items }
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(...(keepLines ? para.map((l) => `<p>${inline(l)}</p>`) : [`<p>${inline(para.join(' '))}</p>`]));
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li><p>${inline(i)}</p></li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of lines) {
      const tag = BULLET.test(line) && line.replace(BULLET, '') ? 'ul' : NUMBER.test(line) ? 'ol' : null;
      if (tag) {
        flushPara();
        if (list?.tag !== tag) flushList();
        list ??= { tag, items: [] };
        list.items.push(line.replace(tag === 'ul' ? BULLET : NUMBER, ''));
      } else if (list && !keepLines) {
        // A wrapped list item: the next line carries on the same point.
        list.items[list.items.length - 1] += ` ${line}`;
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  }
  // Points of one list read as separate paragraphs still make one list.
  return out.join('').replace(/<\/(ul|ol)><\1>/g, '');
}
