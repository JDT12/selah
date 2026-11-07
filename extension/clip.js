// Clipping, shared by the popup and the background worker (shortcut and right-click menu).
import { SERVER } from './config.js';

export async function getToken() {
  return (await chrome.storage.local.get('token')).token ?? null;
}

/** A request to Selah with the clipper's key. */
export async function api(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error(`Can’t reach Selah at ${SERVER}. Is this computer online (and, for a Selah at home, on your home network)?`); });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    await chrome.storage.local.remove('token');
    throw new Error('This clipper isn’t connected any more. Open it and connect again.');
  }
  if (!res.ok) throw new Error(data?.error || `Selah said ${res.status}`);
  return data;
}

// ---- functions run inside the page ----

/** Title, address, description, preview image and the selected text (as HTML) of the page. */
function pageInfoInPage() {
  const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || '';
  let selection = '';
  const sel = getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const div = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i += 1) div.append(sel.getRangeAt(i).cloneContents());
    // Absolute addresses, so links and images still work once they're in a note.
    div.querySelectorAll('img[src]').forEach((img) => img.setAttribute('src', img.src));
    div.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', a.href));
    selection = div.innerHTML;
  }
  let image = meta('og:image');
  try { if (image) image = new URL(image, location.href).href; } catch { image = ''; }
  return {
    title: meta('og:title') || document.title || location.hostname,
    url: location.href,
    description: meta('og:description') || meta('description'),
    image,
    selection,
  };
}

/** The readable part of the page, with Mozilla's Readability (injected first). */
function articleInPage() {
  // eslint-disable-next-line no-undef
  const r = new Readability(document.cloneNode(true)).parse();
  return r ? { title: r.title, html: r.content } : null;
}

/** Lets you drag out a rectangle; resolves with it (in CSS pixels), or null on Escape. */
function pickAreaInPage() {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    const box = document.createElement('div');
    const tip = document.createElement('div');
    Object.assign(shade.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair', background: 'rgba(28,43,58,0.25)' });
    Object.assign(box.style, { position: 'fixed', border: '2px solid #e0a63b', background: 'rgba(255,255,255,0.08)', display: 'none', pointerEvents: 'none' });
    Object.assign(tip.style, { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', background: '#1c2b3a', color: '#fff', font: '13px Segoe UI, sans-serif', padding: '6px 12px', borderRadius: '6px', pointerEvents: 'none' });
    tip.textContent = 'Drag over the area to save · Esc to cancel';
    shade.append(box, tip);
    document.documentElement.append(shade);
    let start = null;
    const done = (rect) => {
      shade.remove();
      removeEventListener('keydown', onKey, true);
      // Two frames so the shade is gone from the screenshot.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(rect)));
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    addEventListener('keydown', onKey, true);
    shade.addEventListener('mousedown', (e) => { start = { x: e.clientX, y: e.clientY }; box.style.display = 'block'; e.preventDefault(); });
    shade.addEventListener('mousemove', (e) => {
      if (!start) return;
      Object.assign(box.style, {
        left: `${Math.min(start.x, e.clientX)}px`, top: `${Math.min(start.y, e.clientY)}px`,
        width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px`,
      });
    });
    shade.addEventListener('mouseup', (e) => {
      if (!start) return;
      const rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y), vw: innerWidth };
      done(rect.w > 4 && rect.h > 4 ? rect : null);
    });
  });
}

const run = async (tabId, func, files) => {
  if (files) await chrome.scripting.executeScript({ target: { tabId }, files });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return r?.result;
};

export async function pageInfo(tabId) {
  try {
    return await run(tabId, pageInfoInPage);
  } catch {
    return null; // e.g. edge:// pages and the store, where extensions can't run
  }
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(s)}`;
}

async function screenshot(tab, area) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!area) return shot;
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = bmp.width / area.vw; // screenshot pixels per CSS pixel (zoom and display scaling)
  const canvas = new OffscreenCanvas(Math.round(area.w * scale), Math.round(area.h * scale));
  canvas.getContext('2d').drawImage(bmp, area.x * scale, area.y * scale, area.w * scale, area.h * scale, 0, 0, canvas.width, canvas.height);
  return toDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

/**
 * Makes a clip and sends it. kind: article | selection | bookmark | screenshot | area | image | link.
 * opts: { title, notebook_id, tags, comment, append_to, srcUrl, linkUrl, linkText }.
 */
export async function clip(kind, tab, opts = {}) {
  const info = (await pageInfo(tab.id)) ?? { title: tab.title, url: tab.url, description: '', image: '', selection: '' };
  const base = {
    url: info.url || tab.url, title: opts.title || info.title, notebook_id: opts.notebook_id || undefined,
    tags: opts.tags ?? [], comment: opts.comment ?? '', append_to: opts.append_to || undefined,
  };
  let body;
  if (kind === 'article') {
    let article = null;
    try { article = await run(tab.id, articleInPage, ['Readability.js']); } catch { /* not readable */ }
    body = article?.html
      ? { ...base, kind: 'article', title: opts.title || article.title || info.title, html: article.html }
      : { ...base, kind: 'bookmark', description: info.description, image: info.image };
  } else if (kind === 'selection') {
    if (!info.selection) throw new Error('Select some text on the page first.');
    body = { ...base, kind: 'selection', html: info.selection };
  } else if (kind === 'bookmark') {
    body = { ...base, kind: 'bookmark', description: info.description, image: info.image };
  } else if (kind === 'screenshot' || kind === 'area') {
    let area = null;
    if (kind === 'area') {
      area = await run(tab.id, pickAreaInPage);
      if (!area) return null; // cancelled
    }
    body = { ...base, kind: 'screenshot', dataUrl: await screenshot(tab, area) };
  } else if (kind === 'image') {
    body = { ...base, kind: 'image', image: opts.srcUrl, title: opts.title || '' };
  } else if (kind === 'link') {
    body = { ...base, kind: 'link', url: opts.linkUrl, title: opts.linkText || '' };
  } else {
    throw new Error(`Unknown clip: ${kind}`);
  }
  return api('/api/clip', { method: 'POST', body });
}
