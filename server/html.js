const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK_END = /<\/(p|div|h[1-6]|li|blockquote|pre|tr|summary|details|table)>|<br\s*\/?>|<hr\s*\/?>/gi;

/** Plain text for full-text search and list snippets. */
export function htmlToText(html) {
  const text = html
    .replace(/<div[^>]*data-attachment[^>]*>([\s\S]*?)<\/div>/gi, ' $1 ')
    .replace(BLOCK_END, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// ---------- 14.3: HTML from someone else's Selah ----------

import sax from 'sax';

// What a note can hold (the editor's own output); anything else is dropped with what's in it (script, style,
// iframe…) or unwrapped (an unknown tag keeps its text).
const KEEP_TAGS = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins',
  'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
  'span', 'div', 'sup', 'sub', 'small', 'details', 'summary', 'label', 'input', 'figure', 'figcaption', 'aside', 'section', 'svg', 'path',
  'g', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'textarea', 'select',
  'button', 'link', 'meta', 'base', 'noscript', 'template', 'math', 'foreignobject', 'title']);
const VOID = new Set(['br', 'hr', 'img', 'col', 'input']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background']);
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/(?!\/)|logosres:|logos4:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;

/**
 * A note's HTML from outside this Selah (live co-editing in a share, 14.3), with only what the editor makes: no
 * scripts, event attributes, frames, forms or javascript: links. (The page's Content-Security-Policy blocks scripts
 * too; this keeps them out of the note.)
 */
export function sanitizeNoteHtml(html) {
  const out = [];
  const stack = [];
  let dropping = 0;
  const parser = sax.parser(false, { lowercase: true, trim: false, normalize: false });
  parser.onerror = () => { parser.error = null; parser.resume(); };
  parser.onopentag = (node) => {
    const name = node.name;
    if (dropping || DROP_WITH_CONTENT.has(name)) { if (!node.isSelfClosing && !VOID.has(name)) dropping += 1; stack.push({ name, kept: false, drop: true }); return; }
    const kept = KEEP_TAGS.has(name) && !(name === 'input' && String(node.attributes.type ?? '').toLowerCase() !== 'checkbox');
    stack.push({ name, kept, drop: false });
    if (!kept) return;
    let attrs = '';
    for (const [k, v] of Object.entries(node.attributes)) {
      const key = k.toLowerCase();
      if (!/^[a-z][a-z0-9:_-]*$/.test(key) || key.startsWith('on') || key === 'srcdoc' || key === 'formaction') continue;
      const val = String(v);
      if (URL_ATTRS.has(key) && !SAFE_URL.test(val.trim().replace(/[\u0000-\u001f\s]+/g, ''))) continue;
      if (key === 'style' && /expression\s*\(|url\s*\(\s*['"]?\s*javascript:|@import|behavior\s*:/i.test(val)) continue;
      attrs += ` ${key}="${escapeHtml(val)}"`;
    }
    out.push(`<${name}${attrs}>`);
  };
  parser.onclosetag = (name) => {
    const top = stack.pop();
    if (!top) return;
    if (top.drop) { if (!VOID.has(name) && dropping > 0) dropping -= 1; return; }
    if (top.kept && !VOID.has(name)) out.push(`</${name}>`);
  };
  parser.ontext = (t) => { if (!dropping) out.push(escapeHtml(t)); };
  parser.oncdata = () => {};
  parser.oncomment = () => {};
  parser.write(`<div>${String(html ?? '')}</div>`).close();
  const s = out.join('');
  return s.startsWith('<div>') && s.endsWith('</div>') ? s.slice(5, -6) : s;
}
