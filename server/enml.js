// Converts ENML (the XHTML inside an .enex file's <content>) into HTML the block editor understands.
// Also used for Markdown import (marked's HTML output), so it accepts plain HTML too.
import sax from 'sax';
import { escapeHtml } from './html.js';

const INLINE = new Set([
  'a', 'abbr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'span',
  'font', 'code', 'tt', 'kbd', 'samp', 'var', 'small', 'big', 'mark', 'cite', 'q', 'br', 'en-todo', 'label',
]);
const PASSTHROUGH = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'li', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'code', 'br', 'mark',
]);
const RENAME = { strike: 's', del: 's', tt: 'code', kbd: 'code', samp: 'code' };
const VOID = new Set(['br', 'hr', 'img']);
// Elements that never have children in HTML (they may be written without a closing tag).
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const CALLOUT_KIND = {
  note: 'info', info: 'info', abstract: 'info', summary: 'info', tldr: 'info', todo: 'info', question: 'info',
  help: 'info', faq: 'info', quote: 'info', cite: 'info', example: 'info',
  tip: 'tip', hint: 'tip', important: 'tip', success: 'tip', check: 'tip', done: 'tip',
  warning: 'warning', caution: 'warning', attention: 'warning',
  danger: 'danger', error: 'danger', bug: 'danger', failure: 'danger', fail: 'danger', missing: 'danger',
};

/** A loose HTML/XML parse into { tag, attrs, children } (text nodes are strings). Also used by export.js. */
export function parseHtml(enml) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const p = sax.parser(false, { lowercase: true, trim: false, normalize: false });
  p.onopentag = (n) => {
    const el = { tag: n.name, attrs: n.attributes, children: [] };
    stack.at(-1).children.push(el);
    if (!HTML_VOID.has(n.name)) stack.push(el);
  };
  p.onclosetag = (name) => {
    if (HTML_VOID.has(name)) return;
    const i = stack.findLastIndex((el) => el.tag === name);
    if (i > 0) stack.length = i;
  };
  p.ontext = (t) => stack.at(-1).children.push(t);
  p.oncdata = (t) => stack.at(-1).children.push(t);
  p.onerror = () => { p.error = null; p.resume(); };
  p.write(enml).close();
  return root;
}

const style = (el) => (el.attrs?.style || '').toLowerCase();
const isEl = (n) => typeof n === 'object';
const isBlank = (n) => typeof n === 'string' && !n.trim();

function textOf(node) {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  const inner = node.children.map(textOf).join('');
  return ['div', 'p', 'li', 'tr'].includes(node.tag) && !inner.endsWith('\n') ? inner + '\n' : inner;
}

const isCheckbox = (n) => isEl(n) && (n.tag === 'en-todo' || (n.tag === 'input' && n.attrs.type === 'checkbox'));
const isChecked = (n) => (n.tag === 'en-todo' ? n.attrs.checked === 'true' : 'checked' in n.attrs);

function firstMeaningful(el) {
  for (const c of el.children) {
    if (isBlank(c)) continue;
    if (isCheckbox(c)) return c;
    if (isEl(c) && ['span', 'font', 'div', 'p'].includes(c.tag)) return firstMeaningful(c);
    return null;
  }
  return null;
}

function stripFirstTodo(el) {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (isBlank(c)) continue;
    if (isCheckbox(c)) {
      el.children.splice(i, 1);
      if (typeof el.children[i] === 'string') el.children[i] = el.children[i].trimStart();
      return;
    }
    if (isEl(c)) return stripFirstTodo(c);
    return;
  }
}

/**
 * @param resources Map of en-media hash -> attachment
 * @param resolveLocal optional (src) -> attachment for relative image/link paths (Markdown import)
 */
export function enmlToHtml(enml, resources, resolveLocal = () => null) {
  const ctx = { resources, resolveLocal };
  const root = parseHtml(enml);
  const note = findTag(root, 'en-note') || root;
  return blockContainer(note.children, ctx);
}

function findTag(node, tag) {
  if (!isEl(node)) return null;
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const f = findTag(c, tag);
    if (f) return f;
  }
  return null;
}

function isInline(n) {
  if (typeof n === 'string') return true;
  return INLINE.has(n.tag); // en-media (images and files) renders as a block
}

/** Render children that must be block content; runs of inline content are wrapped in <p>. */
function blockContainer(children, ctx) {
  let out = '';
  let inline = [];
  let tasks = [];

  const flushInline = () => {
    if (!inline.length) return;
    const html = inline.map((n) => convert(n, ctx)).join('');
    inline = [];
    const text = html.replace(/<br\s*\/?>/g, '').replace(/&nbsp;|\s/g, '');
    if (text || /<br/.test(html)) out += `<p>${html.replace(/^(<br>)+$/, '')}</p>`;
  };
  const flushTasks = () => {
    if (!tasks.length) return;
    out += `<ul data-type="taskList">${tasks.join('')}</ul>`;
    tasks = [];
  };

  for (const c of children) {
    if (isInline(c)) {
      if (isBlank(c) && !inline.length) continue;
      flushTasks();
      inline.push(c);
      continue;
    }
    flushInline();
    if ((c.tag === 'div' || c.tag === 'p') && firstMeaningful(c)) {
      const todo = firstMeaningful(c);
      stripFirstTodo(c);
      const checked = isChecked(todo);
      tasks.push(`<li data-type="taskItem" data-checked="${checked}">${blockContainer(c.children, ctx) || '<p></p>'}</li>`);
      continue;
    }
    flushTasks();
    out += convert(c, ctx);
  }
  flushInline();
  flushTasks();
  return out;
}

function convertChildren(el, ctx) {
  return el.children.map((c) => convert(c, ctx)).join('');
}

function attachmentHtml(res) {
  if (res.mime.startsWith('image/')) {
    return `<img src="/api/files/${res.id}" alt="${escapeHtml(res.filename)}">`;
  }
  return `<div data-attachment="${res.id}" data-filename="${escapeHtml(res.filename)}" data-mime="${escapeHtml(res.mime)}" data-size="${res.size}">${escapeHtml(res.filename)}</div>`;
}

function convert(node, ctx) {
  if (typeof node === 'string') return escapeHtml(node);
  const { tag, attrs } = node;
  const st = style(node);

  switch (tag) {
    case 'en-media': {
      const res = ctx.resources.get((attrs.hash || '').toLowerCase());
      return res ? attachmentHtml(res) : '';
    }
    case 'en-todo':
    case 'input':
      return isCheckbox(node) ? (isChecked(node) ? '☑ ' : '☐ ') : '';
    case 'en-crypt':
      return '<p><em>[Encrypted content was not imported]</em></p>';
    case 'div':
    case 'p':
    case 'section':
    case 'article':
    case 'center':
    case 'en-note':
      if (/-en-codeblock\s*:\s*true/.test(st)) {
        return `<pre><code>${escapeHtml(textOf(node).replace(/\n$/, ''))}</code></pre>`;
      }
      return blockContainer(node.children, ctx);
    case 'pre': {
      const code = node.children.find((c) => isEl(c) && c.tag === 'code');
      const lang = /(?:^|\s)language-([\w+#-]+)/.exec(code?.attrs.class || '')?.[1];
      const cls = lang ? ` class="language-${escapeHtml(lang.toLowerCase())}"` : '';
      return `<pre><code${cls}>${escapeHtml(textOf(node).replace(/\n$/, ''))}</code></pre>`;
    }
    case 'blockquote':
      return calloutHtml(node, ctx) ?? `<blockquote>${blockContainer(node.children, ctx)}</blockquote>`;
    case 'h5':
    case 'h6':
      return `<h4>${convertChildren(node, ctx)}</h4>`;
    case 'ul':
    case 'ol': {
      const items = node.children.filter((c) => isEl(c) && c.tag === 'li');
      // GFM task list: every item starts with a checkbox.
      if (items.length && items.every((li) => firstMeaningful(li))) {
        return `<ul data-type="taskList">${items.map((li) => {
          const checked = isChecked(firstMeaningful(li));
          stripFirstTodo(li);
          return `<li data-type="taskItem" data-checked="${checked}">${blockContainer(li.children, ctx) || '<p></p>'}</li>`;
        }).join('')}</ul>`;
      }
      if (/-en-todo\s*:\s*true/.test(st)) {
        const items = node.children.filter((c) => isEl(c) && c.tag === 'li').map((li) => {
          const checked = /-en-checked\s*:\s*true/.test(style(li));
          return `<li data-type="taskItem" data-checked="${checked}">${blockContainer(li.children, ctx) || '<p></p>'}</li>`;
        });
        return `<ul data-type="taskList">${items.join('')}</ul>`;
      }
      return `<${tag}>${node.children.filter(isEl).map((c) => convert(c, ctx)).join('')}</${tag}>`;
    }
    case 'li':
      return `<li>${blockContainer(node.children, ctx)}</li>`;
    case 'td':
    case 'th': {
      const span = ['colspan', 'rowspan']
        .filter((a) => /^\d+$/.test(attrs[a] || ''))
        .map((a) => ` ${a}="${attrs[a]}"`).join('');
      return `<${tag}${span}>${blockContainer(node.children, ctx)}</${tag}>`;
    }
    case 'a': {
      const href = attrs.href || '';
      if (/^(https?|mailto|ftp|evernote):/i.test(href)) {
        return `<a href="${escapeHtml(href)}">${convertChildren(node, ctx)}</a>`;
      }
      const local = ctx.resolveLocal(href);
      if (local) return attachmentHtml(local);
      return convertChildren(node, ctx);
    }
    case 'img': {
      const src = attrs.src || '';
      const local = ctx.resolveLocal(src);
      if (local) return attachmentHtml(local);
      if (/^https?:/i.test(src)) return `<a href="${escapeHtml(src)}">[image: ${escapeHtml(src)}]</a>`;
      return '';
    }
    case 'span':
    case 'font': {
      let inner = convertChildren(node, ctx);
      if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) inner = `<strong>${inner}</strong>`;
      if (/font-style\s*:\s*italic/.test(st)) inner = `<em>${inner}</em>`;
      if (/text-decoration[^;]*underline/.test(st)) inner = `<u>${inner}</u>`;
      if (/text-decoration[^;]*line-through/.test(st)) inner = `<s>${inner}</s>`;
      if (/background(-color)?\s*:\s*(?!\s*(transparent|initial|inherit|none|rgb\(255,\s*255,\s*255\)|#fff))/.test(st)) inner = `<mark>${inner}</mark>`;
      return inner;
    }
    case 'script':
    case 'style':
    case 'object':
    case 'embed':
    case 'iframe':
    case 'title':
    case 'head':
      return '';
  }

  const out = RENAME[tag] || tag;
  if (PASSTHROUGH.has(out)) {
    if (VOID.has(out)) return `<${out}>`;
    return `<${out}>${convertChildren(node, ctx)}</${out}>`;
  }
  return convertChildren(node, ctx);
}

/** A Markdown callout: a blockquote starting with "[!note] Optional title". */
function calloutHtml(node, ctx) {
  const first = node.children.find((c) => isEl(c));
  const text = first?.tag === 'p' ? first.children[0] : null;
  const m = typeof text === 'string' ? /^\s*\[!(\w+)\][+-]?[ \t]*([^\n]*)\n?/.exec(text) : null;
  if (!m) return null;
  first.children[0] = text.slice(m[0].length);
  const title = m[2].trim();
  const body = blockContainer(node.children, ctx);
  return `<div data-callout="${CALLOUT_KIND[m[1].toLowerCase()] ?? 'info'}">${title ? `<p><strong>${escapeHtml(title)}</strong></p>` : ''}${body || '<p></p>'}</div>`;
}
