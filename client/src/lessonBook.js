// 14.5: a lesson book's pages, as HTML, from its settings and its series' lessons (server/curricula.js). Two editions
// from the same lessons: the teacher guide (the whole lesson, answers filled in, leader notes, and optionally the
// student pages to copy) and the student book (marked words as blanks, room to write, the questions).
// Printed (printLessonBook), saved as Word (lessonBookParts) and kept as the book's note (the teacher guide).
//
// The book's settings (book.data): title, subtitle, author, size, font, textSize, header, footer, contents, copyPages,
// newPage (each lesson and page on a new page), intro, order (section keys: L:<note id>, P:<page key>, B:<break key>),
// pages ({ key: { title, html, edition } }), lessons ({ id: { skip, leader, questions, extra, parts: { teacher: [],
// student: [] } } }) and bank (pieces written for this book: [{ key, html }]).
import { handoutHtml, handoutSections } from './components/PresentMode.jsx';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const empty = (html) => !String(html ?? '').replace(/<[^>]*>/g, '').trim();

export const SIZES = { letter: { label: 'Letter (8.5 × 11 in)', page: '8.5in 11in', margin: '0.75in' }, half: { label: 'Half letter booklet (5.5 × 8.5 in)', page: '5.5in 8.5in', margin: '0.5in' } };
export const FONTS = {
  serif: { label: 'Book (Georgia)', css: "Georgia, 'Times New Roman', serif" },
  classic: { label: 'Classic (Times)', css: "'Times New Roman', Times, serif" },
  sans: { label: 'Clean (sans serif)', css: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
};
export const TEXT_SIZES = [10, 11, 12, 13, 14];
export const PAGE_EDITIONS = { both: 'Both books', teacher: 'Teacher guide only', student: 'Student book only' };

/** Marked words (the Blank button, or the highlighter in a lesson) as blanks or answers. */
export function blankify(html, student) {
  if (empty(html) || !/<mark\b/i.test(html)) return html ?? '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('mark').forEach((m) => {
    const span = doc.createElement('span');
    span.className = student ? 'handout-blank' : 'handout-answer';
    span.textContent = student ? ' '.repeat(Math.max(8, Math.round(m.textContent.length * 1.6))) : m.textContent;
    m.replaceWith(span);
  });
  return doc.body.innerHTML;
}

/** The book's sections in order: lessons (numbered as they come), custom pages and page breaks. */
export function bookSections(book) {
  const d = book.data;
  const byId = new Map(book.lessons.map((l) => [`L:${l.id}`, l]));
  const keys = (d.order ?? []).filter((k) => byId.has(k) || (k.startsWith('P:') && d.pages?.[k.slice(2)]) || k.startsWith('B:'));
  for (const l of book.lessons) if (!keys.includes(`L:${l.id}`)) keys.push(`L:${l.id}`);
  let n = 0;
  return keys.map((key) => {
    if (key.startsWith('L:')) {
      const l = byId.get(key);
      const opts = d.lessons?.[l.id] ?? {};
      return { key, type: 'lesson', lesson: { ...l, opts, n: opts.skip ? null : ++n }, skip: !!opts.skip };
    }
    if (key.startsWith('P:')) return { key, type: 'page', page: d.pages[key.slice(2)] };
    return { key, type: 'break' };
  });
}

/** The lessons that go in, in book order. */
export const bookLessons = (book) => bookSections(book).filter((s) => s.type === 'lesson' && !s.skip).map((s) => s.lesson);

/** A lesson's own parts (its top headings), for choosing what each edition prints. */
export const lessonParts = (l) => handoutSections(l.html ?? '');

/** One lesson's body (no title) in an edition. */
function lessonBody(l, edition) {
  const student = edition === 'student';
  const skip = l.opts.parts?.[edition] ?? [];
  const html = handoutHtml({ title: l.title, html: l.html }, { blanks: true, answers: !student, lines: student, space: student, mainPoints: false, skip })
    .replace(/^<h1>[\s\S]*?<\/h1>/, '');
  let out = '';
  if (l.ref) out += `<p class="lb-ref">${esc(l.ref)}</p>`;
  if (!student && !empty(l.opts.leader)) out += `<aside class="lb-leader"><h3>For the leader</h3>${blankify(l.opts.leader, false)}</aside>`;
  out += html;
  if (!empty(l.opts.extra)) out += `<div class="lb-extra">${blankify(l.opts.extra, student)}</div>`;
  if (!empty(l.opts.questions)) {
    out += `<section class="lb-questions"><h3>${student ? 'Talk it over' : 'Discussion questions'}</h3>${blankify(l.opts.questions, student)}`;
    if (student) out += '<div class="handout-lines"></div>';
    out += '</section>';
  }
  return out;
}

const heading = (l) => `Lesson ${l.n}: ${esc(l.title)}`;
const pageIn = (p, edition) => p && (!p.edition || p.edition === 'both' || p.edition === edition);

/** The whole book in an edition, ready to show or print. brand: the church's name, color and logo (slideLook.js). */
export function lessonBookHtml(book, edition = 'teacher', brand = {}) {
  const d = book.data;
  const sections = bookSections(book);
  const color = /^#[0-9a-f]{6}$/i.test(brand.primary ?? '') ? brand.primary : '#2f5d86';
  const newPage = d.newPage !== false;
  const parts = [];
  parts.push(`<section class="lb-cover">
    ${brand.logo ? `<img class="lb-logo" src="/api/files/${Number(brand.logo)}" alt="" />` : ''}
    <h1 class="lb-title">${esc(d.title || 'Lesson book')}</h1>
    ${d.subtitle ? `<p class="lb-subtitle">${esc(d.subtitle)}</p>` : ''}
    <p class="lb-edition">${edition === 'student' ? 'Student book' : 'Teacher guide'}</p>
    ${d.author || brand.name ? `<p class="lb-by">${esc([d.author, brand.name].filter(Boolean).join(' · '))}</p>` : ''}
  </section>`);
  const listed = sections.filter((s) => (s.type === 'lesson' && !s.skip) || (s.type === 'page' && pageIn(s.page, edition) && s.page.title));
  if (d.contents !== false && listed.length) {
    parts.push(`<section class="lb-contents lb-break"><h2>Contents</h2><ol>${!empty(d.intro) ? '<li>Introduction</li>' : ''}${listed.map((s) => `<li>${s.type === 'lesson' ? heading(s.lesson) : esc(s.page.title)}</li>`).join('')}${edition === 'teacher' && d.copyPages ? '<li>Pages to copy</li>' : ''}</ol></section>`);
  }
  if (!empty(d.intro)) parts.push(`<section class="lb-intro lb-break"><h2>Introduction</h2>${blankify(d.intro, edition === 'student')}</section>`);
  let forced = false; // a manual break before the next section
  for (const s of sections) {
    if (s.type === 'break') { forced = true; continue; }
    if (s.type === 'lesson' && s.skip) continue;
    if (s.type === 'page' && !pageIn(s.page, edition)) continue;
    const brk = newPage || forced ? ' lb-break' : '';
    forced = false;
    if (s.type === 'lesson') parts.push(`<section class="lb-lesson${brk}"><h2>${heading(s.lesson)}</h2>${lessonBody(s.lesson, edition)}</section>`);
    else parts.push(`<section class="lb-page${brk}">${s.page.title ? `<h2>${esc(s.page.title)}</h2>` : ''}${blankify(s.page.html, edition === 'student')}${s.page.lines ? '<div class="handout-lines lb-notes-lines"></div>' : ''}</section>`);
  }
  if (edition === 'teacher' && d.copyPages) {
    parts.push('<section class="lb-copy-title lb-break"><h2>Pages to copy</h2><p>The student pages, one for each lesson, to copy for the class.</p></section>');
    for (const l of bookLessons(book)) parts.push(`<section class="lb-lesson lb-copy lb-break"><h2>${heading(l)}</h2>${lessonBody(l, 'student')}</section>`);
  }
  const font = FONTS[d.font]?.css ?? FONTS.serif.css;
  const size = TEXT_SIZES.includes(Number(d.textSize)) ? Number(d.textSize) : (d.size === 'half' ? 10.5 : 12);
  return `<div class="lesson-book lb-${edition} lb-size-${d.size === 'half' ? 'half' : 'letter'}" style="--lb-brand:${color};--lb-font:${font};--lb-text:${size}pt">${parts.join('')}</div>`;
}

/** Pieces for the book bank, gathered from the book's lessons: points, questions and whole parts. */
export function lessonPieces(book) {
  const out = [];
  for (const l of book.lessons) {
    const doc = new DOMParser().parseFromString(`<body>${l.html ?? ''}</body>`, 'text/html');
    const top = doc.body.querySelector(':scope > h1') ? 'H1' : 'H2';
    let i = 0;
    // Whole parts: a top heading and what follows it.
    for (const h of doc.body.querySelectorAll(`:scope > ${top.toLowerCase()}`)) {
      const bits = [h.outerHTML.replace(/^<h1/, '<h3').replace(/<\/h1>$/, '</h3>').replace(/^<h2/, '<h3').replace(/<\/h2>$/, '</h3>')];
      for (let el = h.nextElementSibling; el && el.tagName !== top; el = el.nextElementSibling) bits.push(el.outerHTML);
      if (bits.length > 1) out.push({ key: `L${l.id}:s${i++}`, kind: 'part', label: h.textContent.trim(), html: bits.join(''), from: l.title });
    }
    // Points and questions: list items without lists inside.
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

/** The book as Word parts (docx/word.js): an introduction, the lessons and pages, in order. */
export function lessonBookParts(book, edition = 'teacher') {
  const d = book.data;
  const parts = [];
  if (!empty(d.intro)) parts.push({ title: 'Introduction', html: blankify(d.intro, edition === 'student') });
  for (const s of bookSections(book)) {
    if (s.type === 'lesson' && !s.skip) parts.push({ title: `Lesson ${s.lesson.n}: ${s.lesson.title}`, html: lessonBody(s.lesson, edition) });
    if (s.type === 'page' && pageIn(s.page, edition)) parts.push({ title: s.page.title || '', html: blankify(s.page.html, edition === 'student') });
  }
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
