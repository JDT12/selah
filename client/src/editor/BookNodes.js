import { Node, mergeAttributes } from '@tiptap/core';

/**
 * 14.5: the lesson book's own elements, for its editor (CurriculumBuilder.jsx) on top of a note's. lessonBook.js turns
 * them into each edition: a page break starts a new page, writing lines become lines (or a box) to write in, an edition
 * block shows only in the teacher guide or the student book, and a lesson block is a lesson copied in from its note
 * (with the version it was copied from, so the builder can offer "Update from lesson").
 */

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'book-page-break', contenteditable: 'false' }],
});

export const WritingLines = Node.create({
  name: 'writingLines',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({
    count: { default: 4, parseHTML: (el) => Math.min(30, Math.max(1, Number(el.getAttribute('data-lines')) || 4)), renderHTML: (a) => ({ 'data-lines': a.count }) },
    kind: { default: 'lines', parseHTML: (el) => (el.getAttribute('data-kind') === 'box' ? 'box' : 'lines'), renderHTML: (a) => ({ 'data-kind': a.kind }) },
  }),
  parseHTML: () => [{ tag: 'div[data-lines]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: `book-lines book-lines-${node.attrs.kind}`, style: `--lines:${node.attrs.count}`, contenteditable: 'false' })],
});

export const EditionBlock = Node.create({
  name: 'editionBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    edition: { default: 'teacher', parseHTML: (el) => (el.getAttribute('data-edition') === 'student' ? 'student' : 'teacher'), renderHTML: (a) => ({ 'data-edition': a.edition }) },
  }),
  parseHTML: () => [{ tag: 'div[data-edition]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: `book-edition book-edition-${node.attrs.edition}` }), 0],
});

export const LessonBlock = Node.create({
  name: 'lessonBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    lesson: { default: null, parseHTML: (el) => Number(el.getAttribute('data-lesson')) || null, renderHTML: (a) => ({ 'data-lesson': a.lesson }) },
    synced: { default: 0, parseHTML: (el) => Number(el.getAttribute('data-synced')) || 0, renderHTML: (a) => ({ 'data-synced': a.synced }) },
  }),
  parseHTML: () => [{ tag: 'section[data-lesson]' }],
  renderHTML: ({ HTMLAttributes }) => ['section', mergeAttributes(HTMLAttributes, { class: 'book-lesson' }), 0],
});

export const BOOK_NODES = [PageBreak, WritingLines, EditionBlock, LessonBlock];
