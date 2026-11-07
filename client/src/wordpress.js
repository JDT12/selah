import { api } from './api.js';
import { drawingToPng } from './editor/Drawing.jsx';
import { scriptureCopyrights } from './esv.js';

/**
 * Converts a note's HTML into WordPress block markup (so the post is editable block by block),
 * uploading its pictures, drawings and files to the site's media library on the way.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const block = (name, attrs, html) => `<!-- wp:${name}${attrs ? ` ${JSON.stringify(attrs)}` : ''} -->\n${html}\n<!-- /wp:${name} -->`;

// Highlighter and text colors on the site (the light theme's shades; a plain highlight stays a bare <mark>).
const WP_HIGHLIGHT = { green: '#c9f0d2', blue: '#cfe3ff', pink: '#ffd3e6', orange: '#ffdcb5', purple: '#e3d4ff' };
const WP_TEXT_COLOR = { red: '#c62828', orange: '#b85600', green: '#2e7d32', blue: '#1f5fbf', purple: '#7b3fbf', gray: '#6b7280' };

const INLINE_KEEP = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'CODE', 'MARK', 'A', 'BR', 'SUB', 'SUP']);

/** Inline content with only plain formatting kept (no app classes, data attributes or styles). */
function inline(el) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { out += esc(n.textContent); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = n.tagName;
    if (tag === 'BR') { out += '<br>'; continue; }
    if (tag === 'SPAN' && WP_TEXT_COLOR[n.dataset.textColor]) {
      // WordPress's own text color format, so the block editor can still change it.
      out += `<mark style="background-color:rgba(0,0,0,0);color:${WP_TEXT_COLOR[n.dataset.textColor]}" class="has-inline-color">${inline(n)}</mark>`;
      continue;
    }
    if (!INLINE_KEEP.has(tag)) { out += inline(n); continue; } // unwrap
    const t = tag.toLowerCase();
    if (tag === 'SUP' && n.dataset.fnid) {
      // A footnote mark in WordPress's own format (see citationsForWordPress).
      const id = esc(n.dataset.fnid);
      out += `<sup data-fn="${id}" class="fn"><a href="#${id}" id="${id}-link">${esc(n.textContent)}</a></sup>`;
      continue;
    }
    if (tag === 'A') {
      const href = n.getAttribute('href') || '';
      if (n.dataset.noteId) { out += inline(n); continue; } // links to your own notes mean nothing on the site
      out += /^(https?:|mailto:|#)/i.test(href) ? `<a href="${esc(href)}">${inline(n)}</a>` : inline(n);
    } else if (tag === 'MARK' && WP_HIGHLIGHT[n.dataset.color]) {
      out += `<mark style="background-color:${WP_HIGHLIGHT[n.dataset.color]}">${inline(n)}</mark>`;
    } else {
      out += `<${t}>${inline(n)}</${t}>`;
    }
  }
  return out;
}

const fileId = (src) => Number(/^\/api\/files\/(\d+)/.exec(src || '')?.[1]) || null;

function imageBlock(media, alt = '') {
  return block('image', { id: media.id, sizeSlug: 'large', linkDestination: 'none' },
    `<figure class="wp-block-image size-large"><img src="${esc(media.url)}" alt="${esc(alt)}" class="wp-image-${media.id}"/></figure>`);
}

/** Paragraph text of a list item (its own paragraphs, not nested lists). */
function itemText(li) {
  const parts = [];
  for (const c of li.children) {
    if (c.tagName === 'UL' || c.tagName === 'OL') continue;
    if (c.tagName === 'LABEL') continue; // task checkbox
    if (c.tagName === 'DIV') { for (const p of c.children) if (p.tagName !== 'UL' && p.tagName !== 'OL') parts.push(inline(p)); continue; }
    parts.push(c.tagName === 'P' ? inline(c) : inline(c));
  }
  if (!li.children.length) parts.push(inline(li));
  return parts.filter((p) => p.trim()).join('<br>');
}

function listBlock(el) {
  const ordered = el.tagName === 'OL';
  const task = el.getAttribute('data-type') === 'taskList';
  const items = [...el.children].filter((c) => c.tagName === 'LI').map((li) => {
    let text = itemText(li);
    if (task) text = `${li.getAttribute('data-checked') === 'true' ? '☑' : '☐'} ${text}`;
    const nested = [...li.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol')].map(listBlock).join('\n');
    return block('list-item', null, `<li>${text}${nested ? `\n${nested}\n` : ''}</li>`);
  });
  const tag = ordered ? 'ol' : 'ul';
  return block('list', ordered ? { ordered: true } : null, `<${tag} class="wp-block-list">\n${items.join('\n')}\n</${tag}>`);
}

/** Tables go in as a Classic block: the table block's exact markup varies between WordPress versions. */
function tableHtml(el) {
  const t = el.cloneNode(true);
  t.querySelectorAll('colgroup').forEach((c) => c.remove());
  t.querySelectorAll('*').forEach((c) => {
    for (const a of [...c.attributes]) if (!['colspan', 'rowspan'].includes(a.name)) c.removeAttribute(a.name);
  });
  t.removeAttribute('style');
  t.querySelectorAll('td > p:only-child, th > p:only-child').forEach((p) => p.replaceWith(...p.childNodes));
  return `<figure class="wp-block-table"><table>${t.innerHTML}</table></figure>`;
}

async function convertChildren(parent, ctx) {
  const out = [];
  for (const el of parent.children) {
    const html = await convertBlock(el, ctx);
    if (html) out.push(html);
  }
  return out.join('\n\n');
}

async function convertBlock(el, ctx) {
  const tag = el.tagName;
  if (tag === 'P') {
    const html = inline(el);
    return html.replace(/<br>/g, '').trim() ? block('paragraph', null, `<p>${html}</p>`) : '';
  }
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const html = inline(el);
    if (!html.trim()) return '';
    return block('heading', level === 2 ? null : { level }, `<h${level} class="wp-block-heading">${html}</h${level}>`);
  }
  if (tag === 'UL' || tag === 'OL') return listBlock(el);
  if (tag === 'BLOCKQUOTE' || (tag === 'DIV' && el.hasAttribute('data-callout'))) {
    return block('quote', null, `<blockquote class="wp-block-quote">\n${await convertChildren(el, ctx)}\n</blockquote>`);
  }
  if (tag === 'PRE') return block('code', null, `<pre class="wp-block-code"><code>${esc(el.textContent)}</code></pre>`);
  if (tag === 'HR') return block('separator', null, '<hr class="wp-block-separator has-alpha-channel-opacity"/>');
  if (tag === 'TABLE') return tableHtml(el);
  if (tag === 'DETAILS') {
    const summary = el.querySelector(':scope > summary');
    const body = el.querySelector(':scope > [data-type="detailsContent"]') ?? el;
    return block('details', null, `<details class="wp-block-details"><summary>${summary ? inline(summary) : ''}</summary>\n${await convertChildren(body, ctx)}\n</details>`);
  }
  if (tag === 'IMG') {
    const id = fileId(el.getAttribute('src'));
    if (id) return imageBlock(await ctx.attachment(id), el.getAttribute('alt') || '');
    const src = el.getAttribute('src') || '';
    return /^https?:/i.test(src)
      ? block('image', null, `<figure class="wp-block-image"><img src="${esc(src)}" alt="${esc(el.getAttribute('alt') || '')}"/></figure>`)
      : '';
  }
  if (tag === 'DIV' && el.hasAttribute('data-drawing')) {
    const strokes = el.getAttribute('data-strokes') || '[]';
    if (strokes === '[]') return '';
    const png = await drawingToPng({ strokes, height: Number(el.getAttribute('data-height')) || 400, paper: el.getAttribute('data-paper') || 'blank' });
    return imageBlock(await ctx.png(png, 'drawing.png'), 'Drawing');
  }
  if (tag === 'DIV' && el.hasAttribute('data-attachment')) {
    const id = Number(el.getAttribute('data-attachment'));
    const mime = el.getAttribute('data-mime') || '';
    const name = el.getAttribute('data-filename') || 'file';
    const media = await ctx.attachment(id);
    if (mime.startsWith('audio/')) {
      return block('audio', { id: media.id }, `<figure class="wp-block-audio"><audio controls src="${esc(media.url)}"></audio></figure>`);
    }
    if (mime.startsWith('video/')) {
      return block('video', { id: media.id }, `<figure class="wp-block-video"><video controls src="${esc(media.url)}"></video></figure>`);
    }
    return block('paragraph', null, `<p><a href="${esc(media.url)}">${esc(name)}</a></p>`);
  }
  if (el.children.length) return convertChildren(el, ctx);
  const html = inline(el);
  return html.trim() ? block('paragraph', null, `<p>${html}</p>`) : '';
}

/**
 * Uploads (each file once) go through `uploads`, so the featured image and downloads reuse them.
 * onProgress(text) reports what's happening.
 */
export function mediaUploader(onProgress) {
  const cache = new Map();
  let count = 0;
  const track = async (key, fn) => {
    if (!cache.has(key)) {
      count += 1;
      onProgress?.(`Uploading files to WordPress (${count})…`);
      cache.set(key, fn());
    }
    return cache.get(key);
  };
  return {
    attachment: (id) => track(`att:${id}`, () => api.wordpressMediaFromAttachment(id)),
    png: (blob, name) => track(`png:${Math.random()}`, () => api.wordpressMediaFromPng(blob, name)),
  };
}

/**
 * Citations and footnotes for a post. Note-style citations and plain footnotes become WordPress footnotes (their
 * text goes in the post's `footnotes` meta, the marks stay in the text); author–date citations become plain text.
 * Returns the html to convert, the footnotes (JSON for the meta, or '' when there are none) and the blocks to add at
 * the end: the Footnotes block and the bibliography.
 */
export async function citationsForWordPress(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const sups = [...doc.querySelectorAll('sup.citation, sup[data-cite], sup[data-note]')];
  if (!sups.length) return { html, footnotes: '', tail: '' };
  const { formatCitations, citationStyle } = await import('./citations/index.js');
  const entries = sups.map((s) => {
    let items = [];
    try { items = JSON.parse(s.getAttribute('data-cite') || '[]'); } catch { /* keep none */ }
    return { items, note: s.getAttribute('data-note') || '', noteHtml: s.getAttribute('data-note-html') || '' };
  });
  const out = await formatCitations(entries, await citationStyle());
  const footnotes = [];
  sups.forEach((s, i) => {
    const r = out.results[i];
    if (r.inText) {
      s.replaceWith(doc.createTextNode(new DOMParser().parseFromString(r.html, 'text/html').body.textContent));
      return;
    }
    const id = crypto.randomUUID();
    const mark = doc.createElement('sup');
    mark.dataset.fnid = id;
    mark.textContent = String(footnotes.length + 1);
    s.replaceWith(mark);
    footnotes.push({ id, content: r.html });
  });
  const tail = [];
  if (footnotes.length) tail.push(block('heading', null, '<h2 class="wp-block-heading">Notes</h2>'), '<!-- wp:footnotes /-->');
  if (out.bibliography.length) {
    tail.push(block('heading', null, '<h2 class="wp-block-heading">Bibliography</h2>'));
    // Each entry is citeproc's HTML, already reduced to simple formatting.
    for (const entry of out.bibliography) {
      tail.push(block('paragraph', null, `<p>${inline(new DOMParser().parseFromString(`<body>${entry}</body>`, 'text/html').body)}</p>`));
    }
  }
  return { html: doc.body.innerHTML, footnotes: footnotes.length ? JSON.stringify(footnotes) : '', tail: tail.join('\n\n') };
}

/** Small paragraphs with the copyright notices of the Bibles a post quotes, for the end of the post ('' when none). */
export async function scriptureNoticeBlocks(html) {
  return (await scriptureCopyrights(html))
    .map((n) => block('paragraph', { fontSize: 'small' }, `<p class="has-small-font-size">${esc(n)}</p>`)).join('\n\n');
}

export async function noteToBlocks(html, uploads) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return convertChildren(doc.body, uploads);
}

/** The first paragraph, trimmed to 40 words (what WordPress shows in lists). */
export function defaultExcerpt(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('sup.citation').forEach((s) => s.remove()); // footnote marks aren't part of the text
  const p = [...doc.body.querySelectorAll('p')].find((x) => x.textContent.trim() && !x.closest('li, td, th, [data-callout]'));
  const words = (p?.textContent ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 40 ? `${words.slice(0, 40).join(' ')}…` : words.join(' ');
}

// ---------- devotionals (Scripture Blog 2.7+) ----------

const SCRIPTURE_HEADING = /^(scripture|text|passage|read)/i;
const APPLICATION_HEADING = /application|takeaway|^response/i;
const REFLECTION_HEADING = /^(reflection|body|main)/i;
const VERSE_REF = /^[1-3]?\s?[A-Za-z][A-Za-z .]+\s\d+(:\d+([-–]\d+(:\d+)?)?)?/;

/** Simple HTML for a devotional's application box: paragraphs, lists, bold, italics and links, nothing else. */
function simpleHtml(nodes) {
  const keep = new Set(['P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'A', 'BR']);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (n) => {
    if (n.nodeType === 3) return esc(n.textContent);
    if (n.nodeType !== 1) return '';
    const inner = [...n.childNodes].map(walk).join('');
    if (n.tagName === 'BR') return '<br>';
    if (!keep.has(n.tagName)) return /^(DIV|BLOCKQUOTE|H\d)$/.test(n.tagName) && inner.trim() ? `<p>${inner}</p>` : inner;
    const tag = n.tagName.toLowerCase();
    if (tag === 'a') {
      const href = n.getAttribute('href') ?? '';
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href).replace(/"/g, '&quot;')}">${inner}</a>` : inner;
    }
    if (tag === 'li') return `<li>${inner.replace(/^<p>([\s\S]*)<\/p>$/, '$1')}</li>`;
    return `<${tag}>${inner}</${tag}>`;
  };
  return nodes.map(walk).join('').replace(/<p>\s*<\/p>/g, '').trim();
}

/** A paragraph's text with verse numbers (<strong>16</strong>, <b>16</b>) taken out. */
const verseLine = (el) => {
  const c = el.cloneNode(true);
  c.querySelectorAll('strong, b, sup').forEach((s) => { if (/^\s*\d+\s*$/.test(s.textContent)) s.remove(); });
  c.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return c.textContent.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
};

/**
 * Split a note written as a devotional (the Devotional method's Scripture / Reflection / Application / Prayer
 * headings) into the devotional's fields: the verse (reference, text, version) from the Scripture section, the
 * application from the Application section, and the rest as the devotional's text. A note without those headings
 * is all text. A leading Reflection heading goes, since the site's page has its own layout.
 */
export function splitDevotional(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const sections = [{ heading: null, nodes: [] }];
  for (const n of [...doc.body.childNodes]) {
    if (n.nodeType === 1 && /^H[1-3]$/.test(n.tagName)) sections.push({ heading: n, nodes: [] });
    else sections[sections.length - 1].nodes.push(n);
  }
  const title = (s) => s.heading?.textContent.trim() ?? '';
  const scripture = sections.find((s) => SCRIPTURE_HEADING.test(title(s)));
  const application = sections.find((s) => APPLICATION_HEADING.test(title(s)));

  const verse = { reference: '', text: '', version: '' };
  if (scripture) {
    const paras = scripture.nodes.filter((n) => n.nodeType === 1)
      .flatMap((n) => (n.tagName === 'BLOCKQUOTE' ? [...n.children] : [n]))
      .map(verseLine).filter(Boolean);
    // "— John 3:16 (ESV)" ends an inserted ESV passage; otherwise a short first line that reads as a reference.
    const cite = paras.findIndex((p) => /^[—–-]\s*\S/.test(p));
    let refLine = null;
    if (cite >= 0) refLine = paras.splice(cite, 1)[0].replace(/^[—–-]\s*/, '');
    else if (paras.length && paras[0].length < 80 && VERSE_REF.test(paras[0])) refLine = paras.shift();
    if (refLine) {
      const m = /^(.*?)\s*\(([A-Z]{2,6})\)\s*$/.exec(refLine);
      verse.reference = (m ? m[1] : refLine).trim();
      verse.version = m ? m[2] : '';
    }
    verse.text = paras.join('\n\n').replace(/^[“"]|[”"]$/g, '').trim();
  }

  const rest = sections.filter((s) => s !== scripture && s !== application);
  if (rest[0]?.heading == null && !rest[0]?.nodes.some((n) => n.textContent.trim())) rest.shift();
  if (rest[0] && REFLECTION_HEADING.test(title(rest[0]))) rest[0] = { heading: null, nodes: rest[0].nodes };
  const body = rest.map((s) => [s.heading?.outerHTML ?? '', ...s.nodes.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? n.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ''))].join('')).join('');

  return {
    verse,
    application: application ? simpleHtml(application.nodes) : '',
    hasApplication: !!application,
    html: body || '<p></p>',
    looksLikeDevotional: !!(scripture && application),
  };
}
