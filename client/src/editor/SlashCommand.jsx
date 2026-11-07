import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import Icon from '../components/Icon.jsx';
import { cornellHtml } from '../../../shared/cornell.js';

const longDate = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/** Block catalogue shared by the slash menu and the toolbar "Insert" menu. */
export const BLOCKS = [
  { title: 'Text', hint: 'Plain paragraph', icon: 'text', keywords: 'paragraph p', run: (c) => c.setParagraph() },
  { title: 'Heading 1', hint: 'Large section heading', icon: 'h1', keywords: 'h1 title', run: (c) => c.setHeading({ level: 1 }) },
  { title: 'Heading 2', hint: 'Medium section heading', icon: 'h2', keywords: 'h2 subtitle', run: (c) => c.setHeading({ level: 2 }) },
  { title: 'Heading 3', hint: 'Small section heading', icon: 'h3', keywords: 'h3', run: (c) => c.setHeading({ level: 3 }) },
  { title: 'Bulleted list', hint: 'Simple bullet list', icon: 'list', keywords: 'ul bullet unordered', run: (c) => c.toggleBulletList() },
  { title: 'Numbered list', hint: 'Ordered list', icon: 'listOrdered', keywords: 'ol ordered number', run: (c) => c.toggleOrderedList() },
  { title: 'To-do list', hint: 'Checklist with checkboxes', icon: 'todo', keywords: 'task checkbox todo check', run: (c) => c.toggleTaskList() },
  { title: 'Collapsible section', hint: 'Expandable / foldable block', icon: 'details', keywords: 'details toggle fold accordion collapse expand', run: (c) => c.setDetails() },
  { title: 'Quote', hint: 'Block quotation', icon: 'quote', keywords: 'blockquote citation', run: (c) => c.toggleBlockquote() },
  { title: 'Code block', hint: 'Syntax-highlighted code', icon: 'codeBlock', keywords: 'pre code snippet program', run: (c) => c.toggleCodeBlock() },
  { title: 'Callout', hint: 'Highlighted info / warning box', icon: 'callout', keywords: 'info note warning tip alert admonition', run: (c) => c.setCallout() },
  { title: 'Table', hint: '3 × 3 table', icon: 'table', keywords: 'grid spreadsheet', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { title: 'Cornell notes', hint: 'Cues beside your notes, with a summary', icon: 'cornell', keywords: 'cornell notes lecture class sermon cue summary study layout', run: (c) => c.insertContent(cornellHtml(longDate())) },
  { title: 'Divider', hint: 'Horizontal line', icon: 'hr', keywords: 'hr rule line separator', run: (c) => c.setHorizontalRule() },
  { title: 'Image or file', hint: 'Upload a picture, PDF, or any file', icon: 'paperclip', keywords: 'upload attach pdf picture photo document', action: 'file' },
  { title: 'Drawing', hint: 'Write or sketch with a pen', icon: 'pen', keywords: 'draw sketch handwriting ink pen stylus pencil canvas', run: (c) => c.insertDrawing() },
  { title: 'Handwriting to text', hint: 'Type up a photo, scan or PDF of written notes', icon: 'scan', keywords: 'handwriting handwritten ocr scan photo text convert type written paper', action: 'handwriting' },
  { title: 'Take photo', hint: 'Use the camera', icon: 'camera', keywords: 'camera picture photo snapshot', action: 'takePhoto' },
  { title: 'Record audio', hint: 'Voice memo from the microphone', icon: 'mic', keywords: 'audio voice memo microphone record sound', action: 'recordAudio' },
  { title: 'Template', hint: 'Insert one of your templates here', icon: 'copy', keywords: 'template boilerplate snippet insert', action: 'insertTemplate' },
  { title: 'Citation', hint: 'Cite a source from Zotero (footnote)', icon: 'cite', keywords: 'cite citation source reference zotero bibliography turabian', action: 'cite' },
  { title: 'Footnote', hint: 'A numbered footnote with your own text', icon: 'cite', keywords: 'footnote note endnote comment', action: 'footnote' },
  { title: 'Logos link', hint: 'Link to a place in a Logos book', icon: 'bible', keywords: 'logos commentary resource book ref.ly link', action: 'logosLink' },
  { title: 'Bible passage', hint: 'Insert Bible text (ESV, NLT…)', icon: 'bible', keywords: 'esv nlt kjv bible scripture verse passage quote quotation', action: 'esvPassage' },
];

export function runBlock(editor, block, range) {
  let chain = editor.chain().focus();
  if (range) chain = chain.deleteRange(range);
  if (block.action) {
    chain.run();
    const actions = { file: 'pickFile', takePhoto: 'takePhoto', recordAudio: 'recordAudio', insertTemplate: 'insertTemplate', cite: 'cite', footnote: 'footnote', logosLink: 'logosLink', esvPassage: 'esvPassage', handwriting: 'handwriting' };
    editor.storage.noteApp?.[actions[block.action]]?.();
    return;
  }
  block.run(chain).run();
}

const SlashMenu = forwardRef(function SlashMenu({ items, command }, ref) {
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') { setIndex((i) => (i + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setIndex((i) => (i + items.length - 1) % items.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { command(items[index]); return true; }
      return false;
    },
  }));

  if (!items.length) return <div className="slash-menu"><div className="slash-empty">No matching blocks</div></div>;
  return (
    <div className="slash-menu" ref={listRef}>
      {items.map((item, i) => (
        <button key={item.title} type="button" className={`slash-item ${i === index ? 'is-active' : ''}`}
          onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); command(item); }}>
          <span className="slash-icon"><Icon name={item.icon} size={18} /></span>
          <span className="slash-text">
            <span className="slash-title">{item.title}</span>
            <span className="slash-hint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

function place(el, rect) {
  if (!rect) return;
  const h = el.offsetHeight || 320;
  const w = el.offsetWidth || 280;
  const below = rect.bottom + 6 + h < window.innerHeight;
  el.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - h - 6)}px`;
  el.style.left = `${Math.min(rect.left, window.innerWidth - w - 8)}px`;
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          // Not inside code blocks.
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock';
        },
        items: ({ query }) => {
          const q = query.toLowerCase();
          if (!q) return BLOCKS;
          // Blocks whose name matches come before those matched by a keyword.
          const byTitle = BLOCKS.filter((b) => b.title.toLowerCase().includes(q));
          return [...byTitle, ...BLOCKS.filter((b) => !byTitle.includes(b) && b.keywords.includes(q))];
        },
        command: ({ editor, range, props }) => runBlock(editor, props, range),
        render: () => {
          let renderer;
          let el;
          return {
            onStart(props) {
              renderer = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              el = document.createElement('div');
              el.className = 'slash-popup';
              el.appendChild(renderer.element);
              document.body.appendChild(el);
              requestAnimationFrame(() => place(el, props.clientRect?.()));
            },
            onUpdate(props) {
              renderer.updateProps(props);
              el.style.display = '';
              place(el, props.clientRect?.());
            },
            onKeyDown({ event }) {
              if (event.key === 'Escape') { el.style.display = 'none'; return true; }
              if (el.style.display === 'none') return false;
              return renderer.ref?.onKeyDown(event) ?? false;
            },
            onExit() {
              el?.remove();
              renderer?.destroy();
            },
          };
        },
      }),
    ];
  },
});
