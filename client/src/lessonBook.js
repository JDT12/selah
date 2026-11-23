// 14.5: a lesson book. The book is one document (book.data.doc, edited in CurriculumBuilder.jsx) that both editions
// come from: blocks marked Teacher only or Student only (editor/BookNodes.js) show in one; marked words (the Blank
// button, the highlighter) are answers in the teacher guide and blanks in the student book; writing lines and page
// breaks print as such. Lessons are copied in as lesson blocks, which remember the version they came from.
// The cover and contents are made here from the book's settings and headings.
import { handoutHtml } from './components/PresentMode.jsx';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const empty = (html) => !String(html ?? '').replace(/<[^>]*>/g, '').trim();

export const SIZES = { letter: { label: 'Letter (8.5 × 11 in)', page: '8.5in 11in', margin: '0.75in' }, half: { label: 'Half letter booklet (5.5 × 8.5 in)', page: '5.5in 8.5in', margin: '0.5in' } };
export const FONTS = {
  serif: { label: 'Book (Georgia)', css: "Georgia, 'Times New Roman', serif" },
  classic: { label: 'Classic (Times)', css: "'Times New Roman', Times, serif" },
  sans: { label: 'Clean (sans serif)', css: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
};
export const TEXT_SIZES = [10, 11, 12, 13, 14];

// ---------- building the document ----------

/** A lesson's note as book content: its headings a level down (the lesson's title is the book's Heading 1). */
function lessonContent(l) {
  return handoutHtml({ title: l.title, html: l.html ?? '' }, { blanks: false, answers: false, lines: false, space: false, mainPoints: false, skip: [] })
    .replace(/^<h1>[\s\S]*?<\/h1>/, '');
}

/** A lesson copied into the book: a lesson block with its title, passage, the lesson and room to write. */
export function lessonBlockHtml(l, n, opts = {}) {
  const parts = [`<h1>${n ? `Lesson ${n}: ` : ''}${esc(l.title)}</h1>`];
  if (l.ref) parts.push(`<p><em>${esc(l.ref)}</em></p>`);
  if (!empty(opts.leader)) parts.push(`<div data-edition="teacher"><h3>For the leader</h3>${opts.leader}</div>`);
  parts.push(lessonContent(l) || '<p></p>');
  if (!empty(opts.extra)) parts.push(opts.extra);
  if (!empty(opts.questions)) parts.push(`<h3>Discussion questions</h3>${opts.questions}`);
  parts.push('<div data-edition="student"><h3>Notes</h3><div data-lines="4"></div></div>');
  return `<section data-lesson="${l.id}" data-synced="${Number(l.updated_at) || 0}">${parts.join('')}</section>`;
}

/**
 * The book's first document: from the settings of an earlier beta's book (order, pages, per-lesson notes) if it has
 * them, else the introduction placeholder and every lesson, each starting a new page.
 */
export function startingDoc(book) {
  const d = book.data;
  const out = [];
  out.push(empty(d.intro) ? '<h1>Introduction</h1><p>How to use this book, the series’ aim, a word to the leader…</p>' : `<h1>Introduction</h1>${d.intro}`);
  const byId = new Map(book.lessons.map((l) => [`L:${l.id}`, l]));
  const keys = (d.order ?? []).filter((k) => byId.has(k) || (k.startsWith('P:') && d.pages?.[k.slice(2)]) || k.startsWith('B:'));
  for (const l of book.lessons) if (!keys.includes(`L:${l.id}`)) keys.push(`L:${l.id}`);
  let n = 0;
  for (const k of keys) {
    if (k.startsWith('L:')) {
      const l = byId.get(k);
      const opts = d.lessons?.[l.id] ?? {};
      if (opts.skip) continue;
      if (d.newPage !== false) out.push('<div data-page-break></div>');
      out.push(lessonBlockHtml(l, ++n, opts));
    } else if (k.startsWith('P:')) {
      const p = d.pages[k.slice(2)];
      const body = `${p.title ? `<h1>${esc(p.title)}</h1>` : ''}${p.html || ''}${p.lines ? '<div data-lines="12"></div>' : ''}`;
      if (d.newPage !== false) out.push('<div data-page-break></div>');
      out.push(p.edition === 'teacher' || p.edition === 'student' ? `<div data-edition="${p.edition}">${body}</div>` : body);
    } else out.push('<div data-page-break></div>');
  }
  return out.join('');
}

/** Ready-made pages for the toolbar. */
export const PAGE_TEMPLATES = [
  { label: 'Welcome', html: '<h1>Welcome</h1><p>Welcome to this study. Over the next weeks…</p>' },
  { label: 'How to use this book', html: '<h1>How to use this book</h1><p>Each lesson has a passage to read, questions to talk over, and room for notes.</p><ul><li><p>Read the passage before you meet.</p></li><li><p>Bring your Bible and this book.</p></li></ul>' },
  { label: 'Prayer requests', html: '<h1>Prayer requests</h1><div data-lines="14"></div>' },
  { label: 'Notes', html: '<h1>Notes</h1><div data-lines="18"></div>' },
  { label: 'Memory verse card', html: '<h1>Memory verse</h1><div data-callout="info" class="callout"><p><strong>Reference</strong></p><p>Write the verse here.</p></div>' },
  { label: 'Answer key (teacher only)', html: '<div data-edition="teacher"><h1>Answer key</h1><ol><li><p></p></li></ol></div>' },
];

// ---------- the editions ----------

/** The document as one edition prints it. */
export function renderEdition(docHtml, edition) {
  const student = edition === 'student';
  const doc = new DOMParser().parseFromString(`<body>${docHtml ?? ''}</body>`, 'text/html');
  // Blocks for the other edition go; this edition's are unwrapped.
  for (const el of [...doc.querySelectorAll('[data-edition]')].reverse()) {
    if (el.getAttribute('data-edition') === edition) el.replaceWith(...el.childNodes);
    else el.remove();
  }
  doc.querySelectorAll('mark').forEach((m) => {
    const span = doc.createElement('span');
    span.className = student ? 'handout-blank' : 'handout-answer';
    span.textContent = student ? ' '.repeat(Math.max(8, Math.round(m.textContent.length * 1.6))) : m.textContent;
    m.replaceWith(span);
  });
  doc.querySelectorAll('[data-lines]').forEach((el) => {
    const box = doc.createElement('div');
    const n = Math.min(30, Math.max(1, Number(el.getAttribute('data-lines')) || 4));
    box.className = el.getAttribute('data-kind') === 'box' ? 'lb-answer-box' : 'handout-lines';
    box.setAttribute('style', `height:${(n * 0.27).toFixed(2)}in`);
    el.replaceWith(box);
  });
  doc.querySelectorAll('[data-page-break]').forEach((el) => {
    const b = doc.createElement('div');
    b.className = 'lb-pagebreak';
    el.replaceWith(b);
  });
  doc.querySelectorAll('section[data-lesson]').forEach((el) => { el.removeAttribute('data-synced'); el.className = 'lb-lesson'; });
  return doc.body.innerHTML;
}

/** The headings the contents page lists (each Heading 1 that this edition prints). */
export function contentsOf(rendered) {
  const doc = new DOMParser().parseFromString(`<body>${rendered}</body>`, 'text/html');
  return [...doc.querySelectorAll('h1')].map((h) => h.textContent.trim()).filter(Boolean);
}

/** The cover (and contents) for an edition. */
export function coverHtml(book, edition, brand = {}, contents = []) {
  const d = book.data;
  const parts = [`<section class="lb-cover">
    ${brand.logo ? `<img class="lb-logo" src="/api/files/${Number(brand.logo)}" alt="" />` : ''}
    <h1 class="lb-title">${esc(d.title || 'Lesson book')}</h1>
    ${d.subtitle ? `<p class="lb-subtitle">${esc(d.subtitle)}</p>` : ''}
    <p class="lb-edition">${edition === 'student' ? 'Student book' : 'Teacher guide'}</p>
    ${d.author || brand.name ? `<p class="lb-by">${esc([d.author, brand.name].filter(Boolean).join(' · '))}</p>` : ''}
  </section>`];
  if (d.contents !== false && contents.length) parts.push(`<div class="lb-pagebreak"></div><section class="lb-contents"><h2>Contents</h2><ol>${contents.map((c) => `<li>${esc(c)}</li>`).join('')}</ol></section>`);
  return parts.join('');
}

export function bookStyle(book, brand = {}) {
  const d = book.data;
  const color = /^#[0-9a-f]{6}$/i.test(brand.primary ?? '') ? brand.primary : '#2f5d86';
  const font = FONTS[d.font]?.css ?? FONTS.serif.css;
  const size = TEXT_SIZES.includes(Number(d.textSize)) ? Number(d.textSize) : (d.size === 'half' ? 10.5 : 12);
  return `--lb-brand:${color};--lb-font:${font};--lb-text:${size}pt`;
}

/** The whole book in an edition: cover, contents, the document, and (teacher guide) the student pages to copy. */
export function lessonBookHtml(book, edition = 'teacher', brand = {}) {
  const d = book.data;
  const body = renderEdition(d.doc ?? startingDoc(book), edition);
  let extra = '';
  if (edition === 'teacher' && d.copyPages) {
    const doc = new DOMParser().parseFromString(`<body>${d.doc ?? startingDoc(book)}</body>`, 'text/html');
    const lessons = [...doc.querySelectorAll('section[data-lesson]')].map((s) => renderEdition(s.innerHTML, 'student'));
    if (lessons.length) extra = `<div class="lb-pagebreak"></div><h1>Pages to copy</h1><p>The student pages, one for each lesson, to copy for the class.</p>${lessons.map((h) => `<div class="lb-pagebreak"></div>${h}`).join('')}`;
  }
  const contents = contentsOf(body + (extra ? '<h1>Pages to copy</h1>' : ''));
  return `<div class="lesson-book lb-${edition} lb-size-${d.size === 'half' ? 'half' : 'letter'}" style="${bookStyle(book, brand)}">${coverHtml(book, edition, brand, contents)}<div class="lb-pagebreak"></div>${body}${extra}</div>`;
}

/** Pieces for the bank, gathered from the book's lessons: whole parts, points and questions. */
export function lessonPieces(book) {
  const out = [];
  for (const l of book.lessons) {
    const doc = new DOMParser().parseFromString(`<body>${l.html ?? ''}</body>`, 'text/html');
    const top = doc.body.querySelector(':scope > h1') ? 'H1' : 'H2';
    let i = 0;
    for (const h of doc.body.querySelectorAll(`:scope > ${top.toLowerCase()}`)) {
      const bits = [`<h2>${h.innerHTML}</h2>`];
      for (let el = h.nextElementSibling; el && el.tagName !== top; el = el.nextElementSibling) bits.push(el.outerHTML);
      if (bits.length > 1) out.push({ key: `L${l.id}:s${i++}`, kind: 'part', label: h.textContent.trim(), html: bits.join(''), from: l.title });
    }
    for (const li of doc.body.querySelectorAll('li')) {
      if (li.querySelector('ul, ol')) continue;
      const text = li.textContent.trim();
      if (!text) continue;
      const question = /\?\s*$/.test(text);
      out.push({ key: `L${l.id}:p${i++}`, kind: question ? 'question' : 'point', label: text, html: question ? `<ul><li>${li.innerHTML}</li></ul>` : `<p>${li.innerHTML}</p>`, from: l.title });
    }
  }
  return out;
}

/** The book as Word parts (docx/word.js): a part per Heading 1. */
export function lessonBookParts(book, edition = 'teacher') {
  const body = renderEdition(book.data.doc ?? startingDoc(book), edition).replace(/<div class="lb-pagebreak"><\/div>/g, '');
  const doc = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
  const parts = [];
  let cur = { title: '', html: '' };
  const walk = (nodes) => {
    for (const el of nodes) {
      if (el.tagName === 'SECTION') { walk([...el.childNodes]); continue; }
      if (el.tagName === 'H1') { if (cur.title || !empty(cur.html)) parts.push(cur); cur = { title: el.textContent.trim(), html: '' }; continue; }
      cur.html += el.outerHTML ?? el.textContent ?? '';
    }
  };
  walk([...doc.body.childNodes]);
  if (cur.title || !empty(cur.html)) parts.push(cur);
  return parts;
}

const cssString = (t) => `"${String(t ?? '').replace(/["\\]/g, '\\$&').replace(/[\r\n]+/g, ' ').slice(0, 120)}"`;

/** Prints the book (or saves it as a PDF from the print dialog) at its page size, with its header and footer. */
export function printLessonBook(book, edition, brand = {}) {
  const d = book.data;
  const size = SIZES[d.size] ?? SIZES.letter;
  const foot = d.footer ?? { number: true, church: false };
  const box = document.createElement('div');
  box.id = 'handout-print';
  box.className = 'handout lesson-book-print';
  box.innerHTML = lessonBookHtml(book, edition, brand);
  const margin = (where, content) => `@${where} { content: ${content}; font: 8.5pt Georgia, serif; color: #555; }`;
  const boxes = [
    d.header === 'title' ? margin('top-center', cssString(d.title || 'Lesson book')) : '',
    foot.number !== false ? margin('bottom-center', 'counter(page)') : '',
    foot.church && brand.name ? margin('bottom-left', cssString(brand.name)) : '',
    foot.edition ? margin('bottom-right', cssString(edition === 'student' ? 'Student book' : 'Teacher guide')) : '',
  ].join(' ');
  const style = document.createElement('style');
  style.textContent = `@page { size: ${size.page}; margin: ${size.margin}; ${boxes} } @page :first { @top-center { content: none; } @bottom-center { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }`;
  document.head.append(style);
  document.body.append(box);
  document.body.classList.add('printing-handout');
  const done = () => { document.body.classList.remove('printing-handout'); box.remove(); style.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}
