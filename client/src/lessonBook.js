// 14.5: a lesson book's pages, as HTML, from its settings and its series' lessons (server/curricula.js). Two editions
// from the same lessons: the teacher guide (the whole lesson, answers filled in, leader notes, and optionally the
// student pages to copy) and the student book (highlighted words as blanks, room to write, the questions).
// Printed (printLessonBook), saved as Word (lessonBookParts) and kept as the book's note (the teacher guide).
import { handoutHtml } from './components/PresentMode.jsx';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const empty = (html) => !String(html ?? '').replace(/<[^>]*>/g, '').trim();

export const SIZES = { letter: { label: 'Letter (8.5 × 11 in)', page: '8.5in 11in', margin: '0.75in' }, half: { label: 'Half letter booklet (5.5 × 8.5 in)', page: '5.5in 8.5in', margin: '0.5in' } };

/** The lessons that go in, in order, with their settings. */
export function bookLessons(book) {
  const per = book.data.lessons ?? {};
  return book.lessons.filter((l) => !per[l.id]?.skip).map((l, i) => ({ ...l, n: i + 1, opts: per[l.id] ?? {} }));
}

/** One lesson's body (no title) in an edition. */
function lessonBody(l, edition) {
  const note = { title: l.title, html: l.html };
  const student = edition === 'student';
  const html = handoutHtml(note, { blanks: true, answers: !student, lines: student, space: student, mainPoints: false, skip: [] })
    .replace(/^<h1>[\s\S]*?<\/h1>/, '');
  let out = '';
  if (l.ref) out += `<p class="lb-ref">${esc(l.ref)}</p>`;
  if (!student && !empty(l.opts.leader)) out += `<aside class="lb-leader"><h3>For the leader</h3>${l.opts.leader}</aside>`;
  out += html;
  if (!empty(l.opts.questions)) {
    out += `<section class="lb-questions"><h3>${student ? 'Talk it over' : 'Discussion questions'}</h3>${l.opts.questions}`;
    if (student) out += '<div class="handout-lines"></div>';
    out += '</section>';
  }
  return out;
}

const heading = (l) => `Lesson ${l.n}: ${esc(l.title)}`;

/** The whole book in an edition, ready to show or print. brand: the church's name, color and logo (slideLook.js). */
export function lessonBookHtml(book, edition = 'teacher', brand = {}) {
  const d = book.data;
  const lessons = bookLessons(book);
  const color = /^#[0-9a-f]{6}$/i.test(brand.primary ?? '') ? brand.primary : '#2f5d86';
  const parts = [];
  parts.push(`<section class="lb-cover" style="--lb-brand:${color}">
    ${brand.logo ? `<img class="lb-logo" src="/api/files/${Number(brand.logo)}" alt="" />` : ''}
    <h1 class="lb-title">${esc(d.title || 'Lesson book')}</h1>
    ${d.subtitle ? `<p class="lb-subtitle">${esc(d.subtitle)}</p>` : ''}
    <p class="lb-edition">${edition === 'student' ? 'Student book' : 'Teacher guide'}</p>
    ${d.author || brand.name ? `<p class="lb-by">${esc([d.author, brand.name].filter(Boolean).join(' · '))}</p>` : ''}
  </section>`);
  if (d.contents !== false && lessons.length) {
    parts.push(`<section class="lb-contents"><h2>Contents</h2><ol>${!empty(d.intro) ? '<li>Introduction</li>' : ''}${lessons.map((l) => `<li>${heading(l)}</li>`).join('')}${edition === 'teacher' && d.copyPages ? '<li>Pages to copy</li>' : ''}</ol></section>`);
  }
  if (!empty(d.intro)) parts.push(`<section class="lb-intro"><h2>Introduction</h2>${d.intro}</section>`);
  for (const l of lessons) parts.push(`<section class="lb-lesson"><h2>${heading(l)}</h2>${lessonBody(l, edition)}</section>`);
  if (edition === 'teacher' && d.copyPages) {
    parts.push('<section class="lb-copy-title"><h2>Pages to copy</h2><p>The student pages, one for each lesson, to copy for the class.</p></section>');
    for (const l of lessons) parts.push(`<section class="lb-lesson lb-copy"><h2>${heading(l)}</h2>${lessonBody(l, 'student')}</section>`);
  }
  return `<div class="lesson-book lb-${edition} lb-size-${d.size === 'half' ? 'half' : 'letter'}">${parts.join('')}</div>`;
}

/** The book as Word parts (docx/word.js): an introduction and a chapter per lesson. */
export function lessonBookParts(book, edition = 'teacher') {
  const d = book.data;
  const parts = [];
  if (!empty(d.intro)) parts.push({ title: 'Introduction', html: d.intro });
  for (const l of bookLessons(book)) parts.push({ title: `Lesson ${l.n}: ${l.title}`, html: lessonBody(l, edition) });
  return parts;
}

/** Prints the book (or saves it as a PDF from the print dialog) at its page size, with page numbers. */
export function printLessonBook(book, edition, brand) {
  const size = SIZES[book.data.size] ?? SIZES.letter;
  const box = document.createElement('div');
  box.id = 'handout-print';
  box.className = 'handout lesson-book-print';
  box.innerHTML = lessonBookHtml(book, edition, brand);
  const style = document.createElement('style');
  style.textContent = `@page { size: ${size.page}; margin: ${size.margin}; @bottom-center { content: counter(page); font: 9pt Georgia, serif; color: #555; } } @page :first { @bottom-center { content: none; } }`;
  document.head.append(style);
  document.body.append(box);
  document.body.classList.add('printing-handout');
  const done = () => { document.body.classList.remove('printing-handout'); box.remove(); style.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}
