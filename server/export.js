import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { db } from './db.js';
import { config } from './config.js';
import { escapeHtml } from './html.js';
import { parseHtml } from './enml.js';
import { writeZip } from './zip.js';
import { noteTags } from './tags.js';
import { heicJpeg, isHeic } from './heic.js';
import { notebookFileEntries } from './notebookfile.js';

/**
 * Export notes as Markdown (.md files), HTML pages, .enex files or a Selah notebook file (.selahnb, server/notebookfile.js), with their attachments. What's exported:
 * notes (ids), notebooks (ids), a shelf, a tag or everything. Markdown and HTML come as a zip, laid out
 * shelf/notebook/note with each notebook's files in an attachments folder (one note without files comes as a single
 * file). .enex comes as one file per notebook (a zip when there are several), which Selah's importer reads back.
 *
 * Selah's own pieces: citations and your footnotes become numbered footnotes, drawings become SVG pictures, to-do
 * lists become checkboxes, links between notes become links between the exported files (plain text when the other
 * note isn't in the export), callouts become Markdown callouts (> [!note]) or boxes.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const FORMATS = ['md', 'html', 'enex', 'selahnb'];
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const MAX_TOTAL = 3.5 * 1024 ** 3; // the zip writer has no ZIP64

const isEl = (n) => typeof n === 'object';
const textOf = (n) => (typeof n === 'string' ? n : n.tag === 'br' ? '\n' : n.children.map(textOf).join(''));
const cleanName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
const fileIdOf = (src) => { const m = /^\/api\/files\/(\d+)/.exec(src ?? ''); return m ? Number(m[1]) : null; };
const iso = (ms) => new Date(ms).toISOString();
const day = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timeZone });

// ---------------------------------------------------------------- what to export

/** { name, notes, single } for the request's scope; notes carry their notebook, shelf and tags. */
export function exportScope(q) {
  const ids = (v) => String(v ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000);
  let where = '';
  let args = [];
  let name = 'Selah';
  let byNotebook = true; // folders per shelf/notebook
  if (q.notes) {
    const list = ids(q.notes);
    if (!list.length) throw httpError(400, 'No notes to export.');
    where = `AND n.id IN (${list.map(() => '?').join(',')})`;
    args = list;
    byNotebook = false;
  } else if (q.notebooks) {
    const list = ids(q.notebooks);
    if (!list.length) throw httpError(400, 'No notebooks to export.');
    where = `AND n.notebook_id IN (${list.map(() => '?').join(',')})`;
    args = list;
    if (list.length === 1) {
      name = db.prepare('SELECT name FROM notebooks WHERE id = ?').get(list[0])?.name ?? 'Notebook';
      byNotebook = false;
    } else name = 'Notebooks';
  } else if (q.stack) {
    const s = db.prepare('SELECT id, name FROM stacks WHERE id = ?').get(Number(q.stack));
    if (!s) throw httpError(404, 'Shelf not found');
    where = 'AND nb.stack_id = ?';
    args = [s.id];
    name = s.name;
  } else if (q.tag) {
    const t = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(Number(q.tag));
    if (!t) throw httpError(404, 'Tag not found');
    where = 'AND n.id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)';
    args = [t.id];
    name = `Tag ${t.name}`;
  } else if (!q.all) throw httpError(400, 'Choose what to export.');
  const notes = db.prepare(`SELECT n.id, n.notebook_id, n.title, n.html, n.created_at, n.updated_at,
      nb.name AS notebook, s.name AS shelf
    FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id LEFT JOIN stacks s ON s.id = nb.stack_id
    WHERE n.deleted_at IS NULL ${where}
    ORDER BY s.name COLLATE NOCASE, nb.name COLLATE NOCASE, n.title COLLATE NOCASE, n.id`).all(...args);
  if (!notes.length) throw httpError(404, 'There are no notes to export there.');
  if (q.notes) name = notes.length === 1 ? notes[0].title || 'Untitled' : 'Selected notes';
  const att = db.prepare('SELECT id, filename, mime, size, storage, created_at FROM attachments WHERE note_id = ? ORDER BY id');
  for (const n of notes) {
    n.tags = noteTags(n.id);
    n.attachments = att.all(n.id);
    n.folder = byNotebook ? [n.shelf, n.notebook ?? 'Notebook'].filter(Boolean).map(cleanName).join('/') : '';
  }
  return { name: cleanName(name) || 'Selah', notes };
}

// ---------------------------------------------------------------- drawings

const PEN = { blue: '#2f6fd6', red: '#d93b30', green: '#2f9a5c', orange: '#e07b16' };
const HIGHLIGHT = { yellow: '#f5d000', green: '#5fd38d', pink: '#ff7eb6', blue: '#6cb6ff' };

/** A drawing block (data-strokes, see client/src/editor/Drawing.jsx) as an SVG picture, or null when it's empty. */
export function drawingSvg(attrs) {
  let list;
  try { list = JSON.parse(attrs['data-strokes'] || '[]'); } catch { return null; }
  const strokes = list.map((st) => {
    const pts = [];
    let x = 0, y = 0, p = 0;
    for (let i = 0; i + 2 < (st.d?.length ?? 0); i += 3) {
      x += st.d[i]; y += st.d[i + 1]; p += st.d[i + 2];
      pts.push([x / 2, y / 2, p / 100]);
    }
    return { ...st, pts };
  }).filter((st) => st.pts.length);
  if (!strokes.length) return null;
  const all = strokes.flatMap((st) => st.pts);
  // As wide as a note (drawings fill the note's width in Selah), wider if the strokes go further.
  const width = Math.ceil(Math.max(640, Math.max(...all.map((q) => q[0])) + 24));
  const height = Math.ceil(Math.max(Number(attrs['data-height']) || 0, Math.max(...all.map((q) => q[1])) + 24));
  const paths = strokes.map((st) => {
    const d = st.pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('')
      + (st.pts.length === 1 ? 'l0.01 0' : '');
    if (st.t === 'h') {
      return `<path d="${d}" stroke="${HIGHLIGHT[st.c] ?? HIGHLIGHT.yellow}" stroke-opacity="0.38" stroke-width="${st.w * 4}"/>`;
    }
    const avg = st.pts.reduce((n, q) => n + q[2], 0) / st.pts.length;
    return `<path d="${d}" stroke="${PEN[st.c] ?? '#1f2933'}" stroke-width="${(st.w * (0.45 + 0.9 * avg)).toFixed(2)}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" fill="#fff"/><g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g></svg>`;
}

// ---------------------------------------------------------------- per-note context

/**
 * Where a note's pieces go in the export. files: attachment id -> { href, a }; drawings are registered as they're
 * met; footnotes collect citations and your own notes in order.
 */
function noteContext(note, { fileHref, noteHref, addDrawing }) {
  return { note, fileHref, noteHref, addDrawing, footnotes: [], drawings: 0 };
}

function footnoteOf(el, ctx) {
  const own = el.attrs['data-note'];
  const text = own || textOf(el).trim();
  if (!text) return null;
  ctx.footnotes.push(text);
  return ctx.footnotes.length;
}

const isTaskList = (el) => el.attrs['data-type'] === 'taskList';
const isTaskItem = (el) => el.attrs['data-type'] === 'taskItem' || 'data-checked' in el.attrs;
const checkedOf = (el) => el.attrs['data-checked'] === 'true';
/** A task item's content (the editor saves it either bare or as label + div). */
const taskContent = (li) => li.children.flatMap((c) => (isEl(c) && c.tag === 'label' ? [] : isEl(c) && c.tag === 'div' && !Object.keys(c.attrs).length ? c.children : [c]));

// ---------------------------------------------------------------- Markdown

const mdEscape = (s) => s.replace(/\\/g, '\\\\').replace(/([*_`[\]<>|~])/g, '\\$1').replace(/ /g, ' ');
const mdUrl = (u) => (/[\s()<>]/.test(u) ? `<${u.replace(/>/g, '%3E')}>` : u);

function mdInline(nodes, ctx, cell = false) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { out += mdEscape(n.replace(/\n/g, ' ')); continue; }
    const inner = () => mdInline(n.children, ctx, cell);
    switch (n.tag) {
      case 'strong': case 'b': { const t = inner(); out += t.trim() ? `**${t}**` : t; break; }
      case 'em': case 'i': { const t = inner(); out += t.trim() ? `*${t}*` : t; break; }
      case 's': case 'del': case 'strike': { const t = inner(); out += t.trim() ? `~~${t}~~` : t; break; }
      case 'u': out += `<u>${inner()}</u>`; break;
      case 'mark': out += `<mark>${inner()}</mark>`; break;
      case 'code': { const t = textOf(n); const tick = t.includes('`') ? '``' : '`'; out += `${tick}${t.includes('`') ? ` ${t} ` : t}${tick}`; break; }
      case 'br': out += cell ? '<br>' : '  \n'; break;
      case 'a': {
        const t = inner();
        const noteId = Number(n.attrs['data-note-id']);
        const href = noteId ? ctx.noteHref(noteId) : n.attrs.href;
        out += href && !/^#note\//.test(href) ? `[${t}](${mdUrl(href)})` : t;
        break;
      }
      case 'sup':
        if (n.attrs.class?.includes('citation') || 'data-cite' in n.attrs || 'data-note' in n.attrs) {
          const k = footnoteOf(n, ctx);
          if (k) out += `[^${k}]`;
        } else out += `<sup>${inner()}</sup>`;
        break;
      case 'sub': out += `<sub>${inner()}</sub>`; break;
      case 'img': out += mdImage(n, ctx); break;
      case 'input': break;
      default: out += inner();
    }
  }
  return out;
}

function mdImage(n, ctx) {
  const f = ctx.fileHref(fileIdOf(n.attrs.src));
  const alt = mdEscape(n.attrs.alt ?? '');
  if (f) return `![${alt}](${mdUrl(f.href)})`;
  return /^https?:/.test(n.attrs.src ?? '') ? `![${alt}](${mdUrl(n.attrs.src)})` : '';
}

const indent = (s, pad) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');

function mdList(el, ctx) {
  const ordered = el.tag === 'ol';
  let n = Number(el.attrs.start) || 1;
  const items = [];
  for (const li of el.children.filter((c) => isEl(c) && c.tag === 'li')) {
    const task = isTaskList(el) || isTaskItem(li);
    const marker = ordered ? `${n++}. ` : '- ';
    const box = task ? (checkedOf(li) ? '[x] ' : '[ ] ') : '';
    const [first = '', ...rest] = mdBlockList(task ? taskContent(li) : li.children, ctx).join('\n').split('\n');
    items.push([`${marker}${box}${first}`, ...rest.map((l) => (l ? ' '.repeat(marker.length) + l : l))].join('\n'));
  }
  return items.join('\n');
}

function mdTable(el, ctx) {
  const rows = [];
  const walk = (n) => { for (const c of n.children) if (isEl(c)) { if (c.tag === 'tr') rows.push(c); else if (['thead', 'tbody', 'tfoot'].includes(c.tag)) walk(c); } };
  walk(el);
  const grid = rows.map((tr) => tr.children.filter((c) => isEl(c) && (c.tag === 'td' || c.tag === 'th'))
    .map((cell) => mdBlockList(cell.children, ctx, true).join('<br>').replace(/\n/g, '<br>') || ' '));
  if (!grid.length) return '';
  const cols = Math.max(...grid.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? ' ').join(' | ')} |`;
  return [line(grid[0]), `|${' --- |'.repeat(cols)}`, ...grid.slice(1).map(line)].join('\n');
}

/** Markdown for one block element, or '' (nothing to show). */
function mdBlock(n, ctx, cell = false) {
  if (typeof n === 'string') return n.trim() ? mdEscape(n.trim()) : '';
  switch (n.tag) {
    case 'p': {
      const t = mdInline(n.children, ctx, cell).trim();
      return cell ? t : t.replace(/^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|---)/, '\\$1');
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const t = mdInline(n.children, ctx, cell).trim();
      return t ? (cell ? `**${t}**` : `${'#'.repeat(Number(n.tag[1]))} ${t}`) : '';
    }
    case 'ul': case 'ol': return mdList(n, ctx);
    case 'blockquote': return mdBlockList(n.children, ctx).join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'pre': {
      const code = textOf(n).replace(/\n$/, '');
      const lang = /language-([\w+#-]+)/.exec(n.children.find(isEl)?.attrs?.class ?? '')?.[1] ?? '';
      const fence = code.includes('```') ? '~~~~' : '```';
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case 'hr': return '---';
    case 'table': return mdTable(n, ctx);
    case 'img': return mdImage(n, ctx);
    case 'div': {
      if ('data-attachment' in n.attrs) {
        const f = ctx.fileHref(Number(n.attrs['data-attachment']));
        if (!f) return mdEscape(n.attrs['data-filename'] ?? '');
        const name = mdEscape(f.a.filename);
        return f.a.mime.startsWith('image/') ? `![${name}](${mdUrl(f.href)})` : `[${name}](${mdUrl(f.href)})`;
      }
      if ('data-drawing' in n.attrs) {
        const href = ctx.addDrawing(n.attrs);
        return href ? `![Drawing](${mdUrl(href)})` : '';
      }
      if ('data-callout' in n.attrs) {
        const body = mdBlockList(n.children, ctx).join('\n\n');
        return [`[!${n.attrs['data-callout']}]`, ...body.split('\n')].map((l) => (l ? `> ${l}` : '>')).join('\n');
      }
      return mdBlockList(n.children, ctx, cell).join('\n\n');
    }
    default: {
      // Inline content sitting at block level.
      const t = mdInline([n], ctx, cell).trim();
      return t;
    }
  }
}

function mdBlockList(nodes, ctx, cell = false) {
  const out = [];
  let inline = [];
  const flush = () => {
    const t = mdInline(inline, ctx, cell).trim();
    if (t) out.push(t);
    inline = [];
  };
  for (const n of nodes) {
    if (typeof n === 'string' || INLINE_TAGS.has(n.tag)) { inline.push(n); continue; }
    flush();
    const b = mdBlock(n, ctx, cell);
    if (b) out.push(b);
  }
  flush();
  return out;
}
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'code', 'br', 'span', 'sup', 'sub', 'font', 'label', 'input']);

const yamlStr = (s) => (/^[\w][\w .,'()&-]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s));

/** A note as a Markdown file: front matter (title, tags, dates, notebook), its text and footnotes. */
export function noteMarkdown(note, ctx, { unreferenced = [] } = {}) {
  const body = mdBlockList(parseHtml(`<div>${note.html}</div>`).children, ctx).join('\n\n');
  const lines = ['---', `title: ${yamlStr(note.title || 'Untitled')}`];
  if (note.tags.length) lines.push(`tags: [${note.tags.map(yamlStr).join(', ')}]`);
  lines.push(`created: ${iso(note.created_at)}`, `updated: ${iso(note.updated_at)}`);
  if (note.notebook) lines.push(`notebook: ${yamlStr(note.notebook)}`);
  lines.push('---', '');
  let out = `${lines.join('\n')}\n${body}\n`;
  if (unreferenced.length) {
    out += `\n## Attachments\n\n${unreferenced.map((f) => `- [${mdEscape(f.a.filename)}](${mdUrl(f.href)})`).join('\n')}\n`;
  }
  if (ctx.footnotes.length) out += `\n${ctx.footnotes.map((t, i) => `[^${i + 1}]: ${t.replace(/\n+/g, ' ')}`).join('\n')}\n`;
  return out;
}

// ---------------------------------------------------------------- HTML

const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'colspan', 'rowspan', 'start', 'title']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'col']);
const attr = (k, v) => ` ${k}="${escapeHtml(v)}"`;

function htmlNodes(nodes, ctx) {
  return nodes.map((n) => htmlNode(n, ctx)).join('');
}

function htmlNode(n, ctx) {
  if (typeof n === 'string') return escapeHtml(n);
  const a = n.attrs;
  const inner = () => htmlNodes(n.children, ctx);
  if (n.tag === 'img') {
    const f = ctx.fileHref(fileIdOf(a.src));
    const src = f?.href ?? (/^https?:/.test(a.src ?? '') ? a.src : null);
    return src ? `<img${attr('src', src)}${attr('alt', a.alt ?? '')}>` : '';
  }
  if (n.tag === 'div' && 'data-attachment' in a) {
    const f = ctx.fileHref(Number(a['data-attachment']));
    if (!f) return `<p class="attachment">${escapeHtml(a['data-filename'] ?? '')}</p>`;
    if (f.a.mime.startsWith('image/')) return `<p><img${attr('src', f.href)}${attr('alt', f.a.filename)}></p>`;
    return `<p class="attachment"><a${attr('href', f.href)}>${escapeHtml(f.a.filename)}</a> <span>${sizeLabel(f.a.size)}</span></p>`;
  }
  if (n.tag === 'div' && 'data-drawing' in a) {
    const href = ctx.addDrawing(a);
    return href ? `<p><img class="drawing"${attr('src', href)} alt="Drawing"></p>` : '';
  }
  if (n.tag === 'div' && 'data-callout' in a) return `<div class="callout callout-${escapeHtml(a['data-callout'])}">${inner()}</div>`;
  if (n.tag === 'a') {
    const noteId = Number(a['data-note-id']);
    const href = noteId ? ctx.noteHref(noteId) : a.href;
    if (!href || /^#note\//.test(href)) return `<span class="note-ref">${inner()}</span>`;
    return `<a${attr('href', href)}${noteId ? ' class="note-link"' : ''}>${inner()}</a>`;
  }
  if (n.tag === 'sup' && (a.class?.includes('citation') || 'data-cite' in a || 'data-note' in a)) {
    const k = footnoteOf(n, ctx);
    return k ? `<sup class="fn"><a href="#fn-${k}" id="fnref-${k}">${k}</a></sup>` : '';
  }
  if (n.tag === 'ul' && isTaskList(n)) return `<ul class="tasks">${inner()}</ul>`;
  if (n.tag === 'li' && isTaskItem(n)) {
    const done = checkedOf(n);
    return `<li class="task${done ? ' done' : ''}"><input type="checkbox" disabled${done ? ' checked' : ''}><div>${htmlNodes(taskContent(n), ctx)}</div></li>`;
  }
  if (n.tag === 'label' || n.tag === 'input' || n.tag === 'colgroup') return '';
  if (n.tag === 'mark') return `<mark${a['data-color'] ? attr('class', `hl-${a['data-color']}`) : ''}>${inner()}</mark>`;
  if (n.tag === 'span' && a['data-text-color']) return `<span${attr('class', `tc-${a['data-text-color']}`)}>${inner()}</span>`;
  if (n.tag === 'table' && a['data-cornell']) return `<table class="cornell">${inner()}</table>`;
  if (n.tag === 'code' && /^language-[\w+#-]+$/.test(a.class ?? '')) return `<code${attr('class', a.class)}>${inner()}</code>`;
  let attrs = '';
  for (const [k, v] of Object.entries(a)) if (KEEP_ATTRS.has(k) && !(k === 'href' && /^\s*javascript:/i.test(v))) attrs += attr(k, v);
  if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
  if (!/^[a-z][a-z0-9]*$/.test(n.tag)) return inner();
  return `<${n.tag}${attrs}>${inner()}</${n.tag}>`;
}

const sizeLabel = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const dateLabel = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: config.timeZone, year: 'numeric', month: 'long', day: 'numeric' });

export const EXPORT_CSS = `:root { color-scheme: light dark; --bg: #fbf8f2; --text: #1f2933; --muted: #6b7280; --border: #e3ddd0; --accent: #2e5b8a; --soft: #f3eee3; }
@media (prefers-color-scheme: dark) { :root { --bg: #161b22; --text: #e6e1d6; --muted: #9aa3ad; --border: #2c333d; --accent: #8db4e2; --soft: #1e252e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.65 Georgia, 'Times New Roman', serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
nav.crumbs { font: 14px system-ui, sans-serif; color: var(--muted); margin-bottom: 18px; }
nav.crumbs a { color: var(--accent); }
h1, h2, h3, h4 { font-family: system-ui, sans-serif; line-height: 1.25; }
h1.title { font-size: 2em; margin: 0 0 6px; }
.meta { font: 14px system-ui, sans-serif; color: var(--muted); margin-bottom: 28px; }
.meta .tag { display: inline-block; padding: 1px 8px; border: 1px solid var(--border); border-radius: 99px; margin: 0 4px 0 0; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; }
img.drawing { border: 1px solid var(--border); border-radius: 8px; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
pre { background: var(--soft); padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 14px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
td, th { border: 1px solid var(--border); padding: 6px 10px; vertical-align: top; text-align: left; }
th { background: var(--soft); }
td > p:first-child, th > p:first-child, li > p:first-child { margin-top: 0; }
td > p:last-child, th > p:last-child, li > p:last-child { margin-bottom: 0; }
ul.tasks { list-style: none; padding-left: 4px; }
li.task { display: flex; gap: 8px; align-items: baseline; }
li.task.done > div { color: var(--muted); text-decoration: line-through; }
li.task > div > p { margin: 0.15em 0; }
.callout { border-left: 4px solid var(--accent); background: var(--soft); padding: 4px 16px; border-radius: 6px; margin: 1em 0; }
.callout-tip { border-color: #2f9a5c; } .callout-warning { border-color: #d98b16; } .callout-danger { border-color: #d93b30; }
mark { background: #ffef9e; color: inherit; } mark.hl-green { background: #c9f0d2; } mark.hl-blue { background: #cfe3ff; }
mark.hl-pink { background: #ffd3e6; } mark.hl-orange { background: #ffdcb5; } mark.hl-purple { background: #e3d4ff; }
@media (prefers-color-scheme: dark) { mark { background: #6b5d12; } mark[class] { filter: brightness(.55) saturate(1.4); color: #fff; } }
.tc-red { color: #c62828; } .tc-orange { color: #b85600; } .tc-green { color: #2e7d32; } .tc-blue { color: #1f5fbf; } .tc-purple { color: #7b3fbf; } .tc-gray { color: #6b7280; }
.attachment span { color: var(--muted); font: 13px system-ui, sans-serif; }
.footnotes { border-top: 1px solid var(--border); margin-top: 40px; font-size: 15px; }
.contents h2 { margin-top: 1.6em; font-size: 1.15em; } .contents ul { padding-left: 20px; } .contents .muted { color: var(--muted); font: 13px system-ui, sans-serif; }
`;

function htmlPage({ title, body, cssHref, crumbs = '' }) {
  const style = cssHref ? `<link rel="stylesheet" href="${escapeHtml(cssHref)}">` : `<style>${EXPORT_CSS}</style>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title>${style}</head><body><main>${crumbs}${body}</main></body></html>\n`;
}

/** A note as a web page. */
export function noteHtml(note, ctx, { cssHref = null, indexHref = null, unreferenced = [] } = {}) {
  const content = htmlNodes(parseHtml(`<div>${note.html}</div>`).children, ctx);
  const meta = [`${escapeHtml(note.notebook ?? '')}`, `Updated ${dateLabel(note.updated_at)}`].filter(Boolean).join(' · ')
    + (note.tags.length ? ` · ${note.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}` : '');
  let body = `<h1 class="title">${escapeHtml(note.title || 'Untitled')}</h1><p class="meta">${meta}</p>${content}`;
  if (unreferenced.length) {
    body += `<h2>Attachments</h2><ul>${unreferenced.map((f) => `<li><a${attr('href', f.href)}>${escapeHtml(f.a.filename)}</a></li>`).join('')}</ul>`;
  }
  if (ctx.footnotes.length) {
    body += `<section class="footnotes"><ol>${ctx.footnotes.map((t, i) => `<li id="fn-${i + 1}">${escapeHtml(t)} <a href="#fnref-${i + 1}">↩</a></li>`).join('')}</ol></section>`;
  }
  const crumbs = indexHref ? `<nav class="crumbs"><a href="${escapeHtml(indexHref)}">Contents</a></nav>` : '';
  return htmlPage({ title: note.title || 'Untitled', body, cssHref, crumbs });
}

// ---------------------------------------------------------------- .enex (ENML)

const ENML_TAGS = new Set(['a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'font']);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const CALLOUT_COLOR = { info: '#2e5b8a', tip: '#2f9a5c', warning: '#d98b16', danger: '#d93b30' };
const HL = { green: '#c9f0d2', blue: '#cfe3ff', pink: '#ffd3e6', orange: '#ffdcb5', purple: '#e3d4ff' };
const TC = { red: '#c62828', orange: '#b85600', green: '#2e7d32', blue: '#1f5fbf', purple: '#7b3fbf', gray: '#6b7280' };

function enmlNodes(nodes, ctx) { return nodes.map((n) => enmlNode(n, ctx)).join(''); }

function enmlNode(n, ctx) {
  if (typeof n === 'string') return xml(n);
  const a = n.attrs;
  const inner = () => enmlNodes(n.children, ctx);
  const media = (m) => (m ? `<en-media type="${xml(m.mime)}" hash="${m.hash}"/>` : '');
  if (n.tag === 'img') return media(ctx.media(fileIdOf(a.src)));
  if (n.tag === 'div' && 'data-attachment' in a) return `<div>${media(ctx.media(Number(a['data-attachment'])))}</div>`;
  if (n.tag === 'div' && 'data-drawing' in a) { const m = ctx.drawingMedia(a); return m ? `<div>${media(m)}</div>` : ''; }
  if (n.tag === 'div' && 'data-callout' in a) {
    return `<div style="border-left:4px solid ${CALLOUT_COLOR[a['data-callout']] ?? CALLOUT_COLOR.info};background:#f5f2ea;padding:4px 14px;margin:8px 0">${inner()}</div>`;
  }
  if (n.tag === 'ul' && isTaskList(n)) {
    return n.children.filter((c) => isEl(c) && c.tag === 'li').map((li) => {
      const [first, ...rest] = taskContent(li).filter((c) => isEl(c) || c.trim());
      const lead = first && isEl(first) && first.tag === 'p' ? enmlNodes(first.children, ctx) : first ? enmlNode(first, ctx) : '';
      return `<div><en-todo checked="${checkedOf(li)}"/>${lead}</div>${enmlNodes(rest, ctx)}`;
    }).join('');
  }
  if (n.tag === 'a') {
    const href = a.href ?? '';
    return 'data-note-id' in a || !/^(https?:|mailto:)/i.test(href) ? inner() : `<a href="${xml(href)}">${inner()}</a>`;
  }
  if (n.tag === 'sup' && (a.class?.includes('citation') || 'data-cite' in a || 'data-note' in a)) {
    const k = footnoteOf(n, ctx);
    return k ? `<sup>[${k}]</sup>` : '';
  }
  if (n.tag === 'mark') return `<span style="background-color:${HL[a['data-color']] ?? '#ffef9e'}">${inner()}</span>`;
  if (n.tag === 'span' && a['data-text-color']) return `<span style="color:${TC[a['data-text-color']] ?? 'inherit'}">${inner()}</span>`;
  if (n.tag === 'pre') return `<pre>${xml(textOf(n))}</pre>`;
  if (n.tag === 'br') return '<br/>';
  if (n.tag === 'hr') return '<hr/>';
  if (['label', 'input', 'colgroup', 'col'].includes(n.tag)) return '';
  if (n.tag === 'li' && isTaskItem(n)) return `<li>${enmlNodes(taskContent(n), ctx)}</li>`;
  if (!ENML_TAGS.has(n.tag)) return inner();
  let attrs = '';
  if (['td', 'th'].includes(n.tag)) for (const k of ['colspan', 'rowspan']) if (a[k]) attrs += ` ${k}="${xml(a[k])}"`;
  if (n.tag === 'ol' && a.start) attrs += ` start="${xml(a.start)}"`;
  return `<${n.tag}${attrs}>${inner()}</${n.tag}>`;
}

function noteEnml(note, ctx) {
  let body = enmlNodes(parseHtml(`<div>${note.html}</div>`).children, ctx);
  if (ctx.footnotes.length) body += `<hr/>${ctx.footnotes.map((t, i) => `<div><sup>[${i + 1}]</sup> ${xml(t)}</div>`).join('')}`;
  return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'
    + `<en-note>${body}</en-note>`;
}

const enexDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const cdata = (s) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

async function md5File(file) {
  const h = crypto.createHash('md5');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

/** The file to export for an attachment: HEIC photos as their JPEG copy (what you see in Selah). */
export async function exportFile(a) {
  if (isHeic(a.mime, a.filename)) {
    const jpg = await heicJpeg(a).catch(() => null);
    if (jpg) return { file: jpg, filename: a.filename.replace(/\.(heic|heif)$/i, '') + '.jpg', mime: 'image/jpeg' };
  }
  return { file: path.join(config.filesDir, a.storage), filename: a.filename, mime: a.mime };
}

/** An .enex file of notes, streamed: resources are read and base64-encoded as they're written. */
export async function* enexChunks(notes) {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n'
    + `<en-export export-date="${enexDate(Date.now())}" application="Selah" version="${VERSION}">\n`;
  for (const note of notes) {
    const resources = [];
    const byId = new Map();
    for (const a of note.attachments) {
      const f = await exportFile(a);
      const r = { ...f, hash: await md5File(f.file) };
      byId.set(a.id, r);
    }
    const ctx = noteContext(note, {});
    const used = new Set();
    ctx.media = (id) => {
      const r = byId.get(id);
      if (r && !used.has(id)) { used.add(id); resources.push(r); }
      return r ?? null;
    };
    ctx.drawingMedia = (attrs) => {
      const svg = drawingSvg(attrs);
      if (!svg) return null;
      const data = Buffer.from(svg, 'utf8');
      const r = { data, filename: `drawing-${++ctx.drawings}.svg`, mime: 'image/svg+xml', hash: crypto.createHash('md5').update(data).digest('hex') };
      resources.push(r);
      return r;
    };
    let content = noteEnml(note, ctx);
    // Files no block points at still go along, listed at the end so they show up when the file is imported.
    const extra = note.attachments.filter((a) => !used.has(a.id)).map((a) => ctx.media(a.id)).filter(Boolean);
    if (extra.length) content = content.replace('</en-note>', `${extra.map((m) => `<div><en-media type="${xml(m.mime)}" hash="${m.hash}"/></div>`).join('')}</en-note>`);
    yield `<note><title>${xml(note.title || 'Untitled')}</title><content>${cdata(content)}</content>`
      + `<created>${enexDate(note.created_at)}</created><updated>${enexDate(note.updated_at)}</updated>`
      + note.tags.map((t) => `<tag>${xml(t)}</tag>`).join('')
      + '<note-attributes><source>selah</source></note-attributes>\n';
    for (const r of resources) {
      yield '<resource><data encoding="base64">';
      if (r.data) yield r.data.toString('base64');
      else {
        let carry = Buffer.alloc(0);
        for await (const c of fs.createReadStream(r.file, { highWaterMark: 3 * 64 * 1024 })) {
          const buf = carry.length ? Buffer.concat([carry, c]) : c;
          const usable = buf.length - (buf.length % 3);
          yield buf.subarray(0, usable).toString('base64');
          carry = buf.subarray(usable);
        }
        if (carry.length) yield carry.toString('base64');
      }
      yield `</data><mime>${xml(r.mime)}</mime><resource-attributes><file-name>${xml(r.filename)}</file-name></resource-attributes></resource>\n`;
    }
    yield '</note>\n';
  }
  yield '</en-export>\n';
}

// ---------------------------------------------------------------- Markdown / HTML zips

/** Unique names within each folder (case-insensitive). */
function namer() {
  const used = new Set();
  return (folder, base, ext) => {
    const stem = cleanName(base) || 'Untitled';
    let name = `${stem}${ext}`;
    for (let n = 2; used.has(`${folder}/${name}`.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(`${folder}/${name}`.toLowerCase());
    return folder ? `${folder}/${name}` : name;
  };
}

const referenced = (html, id) => html.includes(`data-attachment="${id}"`) || new RegExp(`/api/files/${id}(?![0-9])`).test(html);

const rel = (fromFile, to) => {
  const r = path.posix.relative(path.posix.dirname(`/${fromFile}`), `/${to}`);
  return r.split('/').map(encodeURIComponent).join('/');
};

/** Builds the files of a Markdown or HTML export: [{ name, file | data, mtime }]. */
async function treeEntries(scope, format) {
  const ext = format === 'md' ? '.md' : '.html';
  const name = namer();
  const paths = new Map(); // note id -> path
  for (const n of scope.notes) paths.set(n.id, name(n.folder, n.title, ext));
  const entries = [];
  const fileNames = namer();
  for (const note of scope.notes) {
    const own = paths.get(note.id);
    const files = new Map();
    for (const a of note.attachments) {
      const f = await exportFile(a);
      const p = fileNames(path.posix.join(note.folder, 'attachments'), path.parse(f.filename).name, path.parse(f.filename).ext);
      files.set(a.id, { a: { ...a, filename: f.filename, mime: f.mime }, path: p, file: f.file, href: rel(own, p) });
    }
    const ctx = noteContext(note, {
      fileHref: (id) => files.get(id) ?? null,
      noteHref: (id) => (paths.has(id) ? rel(own, paths.get(id)) : null),
      addDrawing: (attrs) => {
        const svg = drawingSvg(attrs);
        if (!svg) return null;
        const p = fileNames(path.posix.join(note.folder, 'attachments'), `${note.title || 'Untitled'} drawing ${++ctx.drawings}`, '.svg');
        entries.push({ name: p, data: Buffer.from(svg, 'utf8'), mtime: note.updated_at });
        return rel(own, p);
      },
    });
    // Files no block points at are listed at the end.
    const unreferenced = [...files.values()].filter((f) => !referenced(note.html, f.a.id));
    const out = format === 'md'
      ? noteMarkdown(note, ctx, { unreferenced })
      : noteHtml(note, ctx, { cssHref: rel(own, 'style.css'), indexHref: rel(own, 'index.html'), unreferenced });
    entries.push({ name: own, data: Buffer.from(out, 'utf8'), mtime: note.updated_at });
    for (const f of files.values()) entries.push({ name: f.path, file: f.file, mtime: f.a.created_at });
  }
  if (format === 'html') {
    entries.push({ name: 'style.css', data: Buffer.from(EXPORT_CSS, 'utf8') });
    entries.push({ name: 'index.html', data: Buffer.from(contentsPage(scope, paths), 'utf8') });
  }
  return entries;
}

function contentsPage(scope, paths) {
  const groups = new Map();
  for (const n of scope.notes) {
    const key = [n.shelf, n.notebook].filter(Boolean).join(' / ') || 'Notes';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const one = groups.size === 1;
  const body = `<h1 class="title">${escapeHtml(scope.name)}</h1><p class="meta">Exported from Selah on ${dateLabel(Date.now())} · ${scope.notes.length} note${scope.notes.length === 1 ? '' : 's'}</p>`
    + `<div class="contents">${[...groups].map(([g, list]) => `${one ? '' : `<h2>${escapeHtml(g)}</h2>`}<ul>${list.map((n) => `<li><a${attr('href', rel('index.html', paths.get(n.id)))}>${escapeHtml(n.title || 'Untitled')}</a> <span class="muted">${dateLabel(n.updated_at)}</span></li>`).join('')}</ul>`).join('')}</div>`;
  return htmlPage({ title: scope.name, body, cssHref: 'style.css' });
}

// ---------------------------------------------------------------- route

const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export default async function exportRoutes(app) {
  // What an export would hold (the dialog shows it before you download): same scope as below.
  app.get('/api/export/summary', async (req) => {
    const scope = exportScope(req.query);
    const files = scope.notes.flatMap((n) => n.attachments);
    return {
      name: scope.name,
      notes: scope.notes.length,
      notebooks: new Set(scope.notes.map((n) => n.notebook_id)).size,
      attachments: files.length,
      bytes: files.reduce((n, a) => n + a.size, 0),
      tooBig: files.reduce((n, a) => n + a.size, 0) > MAX_TOTAL,
    };
  });

  // ?format=md|html|enex and one of notes=1,2 | notebooks=1,2 | stack=ID | tag=ID | all=1
  app.get('/api/export', async (req, reply) => {
    const format = String(req.query.format ?? '');
    if (!FORMATS.includes(format)) throw httpError(400, 'Unknown export format.');
    const scope = exportScope(req.query);
    const total = scope.notes.reduce((n, x) => n + x.attachments.reduce((m, a) => m + a.size, 0), 0);
    if (total > MAX_TOTAL) throw httpError(413, 'That’s more than 3.5 GB of attachments; export fewer notebooks at a time.');
    const out = new PassThrough();
    const fail = (err) => { req.log.error(err); out.destroy(err); };
    const stamp = day();

    // A Selah notebook file: the notes as they are, for another Selah (server/notebookfile.js).
    if (format === 'selahnb') {
      writeZip(out, notebookFileEntries(scope, req.query)).catch(fail);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', disposition(`${scope.name}${scope.notes.length > 1 ? ` ${stamp}` : ''}.selahnb`));
      return reply.send(out);
    }

    if (format === 'enex') {
      const books = new Map();
      for (const n of scope.notes) {
        const key = n.notebook_id ?? 0;
        if (!books.has(key)) books.set(key, { name: n.notebook ?? 'Notes', notes: [] });
        books.get(key).notes.push(n);
      }
      if (books.size === 1) {
        const [book] = books.values();
        (async () => { for await (const c of enexChunks(book.notes)) if (!out.write(c)) await new Promise((r) => out.once('drain', r)); out.end(); })().catch(fail);
        reply.header('Content-Type', 'application/enex+xml');
        reply.header('Content-Disposition', disposition(`${scope.notes.length === 1 ? scope.name : cleanName(book.name)}.enex`));
        return reply.send(out);
      }
      const names = namer();
      const entries = [...books.values()].map((b) => ({ name: names('', b.name, '.enex'), chunks: () => enexChunks(b.notes) }));
      writeZip(out, entries).catch(fail);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', disposition(`${scope.name} (enex) ${stamp}.zip`));
      return reply.send(out);
    }

    const entries = await treeEntries(scope, format);
    // One note with nothing beside it: just the file (an HTML page carries its own styles then).
    if (scope.notes.length === 1 && entries.filter((e) => !['style.css', 'index.html'].includes(e.name)).length === 1) {
      const note = scope.notes[0];
      const ctx = noteContext(note, { fileHref: () => null, noteHref: () => null, addDrawing: () => null });
      const body = format === 'md' ? noteMarkdown(note, ctx) : noteHtml(note, ctx);
      reply.header('Content-Type', format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8');
      reply.header('Content-Disposition', disposition(`${scope.name}.${format}`));
      return body;
    }
    const root = `${scope.name}${scope.notes.length > 1 ? ` ${stamp}` : ''}`;
    writeZip(out, entries.map((e) => ({ ...e, name: `${root}/${e.name}` }))).catch(fail);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', disposition(`${root}${format === 'html' ? ' (web pages)' : ''}.zip`));
    return reply.send(out);
  });
}
