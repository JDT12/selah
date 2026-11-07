import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import Icon from '../components/Icon.jsx';
import { api } from '../api.js';
import { recentNotes } from '../components/CommandPalette.jsx';

/**
 * Links between notes. The link points at the note's id (so it survives a rename; the server also updates link
 * text that still shows the old title) and is written `<a class="note-link" data-note-id="12" href="#note/12">`.
 * A click opens the note (the 'noteapp:open-note' event, handled in App.jsx); hovering shows a preview.
 */
export const NoteLink = Mark.create({
  name: 'noteLink',
  priority: 1001, // ahead of the ordinary link mark, which would also match <a href>
  inclusive: false,
  excludes: 'link',
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-note-id')) || null,
        renderHTML: (a) => ({ 'data-note-id': a.id, href: `#note/${a.id}` }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'a[data-note-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes({ class: 'note-link' }, HTMLAttributes), 0];
  },
});

/** Opens a note, or with `newTab` (Ctrl-click, a middle click) in a tab of its own (11.0). */
export const openNoteEvent = (id, newTab = false) => window.dispatchEvent(newTab
  ? new CustomEvent('noteapp:open-tab', { detail: { kind: 'note', id } })
  : new CustomEvent('noteapp:open-note', { detail: id }));

const LinkMenu = forwardRef(function LinkMenu({ items, command, query }, ref) {
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.children[index + 1]?.scrollIntoView({ block: 'nearest' });
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
  return (
    <div className="slash-menu note-link-menu" ref={listRef}>
      <div className="note-link-menu-head">{query.trim() ? 'Link to a note' : 'Link to a note: type its title'}</div>
      {items.map((item, i) => (
        <button key={item.create ? 'create' : item.id} type="button" className={`slash-item ${i === index ? 'is-active' : ''}`}
          onMouseMove={() => i !== index && setIndex(i)} onMouseDown={(e) => { e.preventDefault(); command(item); }}>
          <span className="slash-icon"><Icon name={item.create ? 'plus' : 'note'} size={18} /></span>
          <span className="slash-text">
            <span className="slash-title">{item.create ? `Create “${item.title}”` : item.title || 'Untitled'}</span>
            <span className="slash-hint">{item.create ? 'A new note in this notebook, linked here' : item.hint}</span>
          </span>
        </button>
      ))}
      {!items.length && <div className="slash-empty">{query.trim() ? 'Searching…' : 'No recent notes'}</div>}
    </div>
  );
});

function place(el, rect) {
  if (!rect) return;
  const h = el.offsetHeight || 320;
  const w = el.offsetWidth || 300;
  const below = rect.bottom + 6 + h < window.innerHeight;
  el.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - h - 6)}px`;
  el.style.left = `${Math.min(rect.left, window.innerWidth - w - 8)}px`;
}

/** Type [[ to link to a note (or create one). */
export const NoteLinkSuggest = Extension.create({
  name: 'noteLinkSuggest',
  addOptions() {
    return { tree: null };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      Suggestion({
        editor,
        pluginKey: new PluginKey('noteLinkSuggest'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        debounce: 120,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name === 'codeBlock') return false;
          const typed = state.doc.textBetween(range.from, range.to);
          return !typed.includes(']]') && typed.length < 120;
        },
        items: async ({ query }) => {
          const self = editor.storage.noteApp?.noteId;
          const q = query.trim();
          const notebookName = editor.storage.noteApp?.notebookName ?? (() => null);
          if (!q) return recentNotes().filter((n) => n.id !== self).slice(0, 8).map((n) => ({ id: n.id, title: n.title, hint: 'Recent' }));
          let found = [];
          try {
            found = (await api.listNotes({ q, rank: 1, limit: 8 })).filter((n) => n.id !== self)
              .map((n) => ({ id: n.id, title: n.title, hint: notebookName(n.notebook_id) ?? '' }));
          } catch { /* offline: offer to create only */ }
          const exact = found.some((n) => n.title.trim().toLowerCase() === q.toLowerCase());
          return exact ? found : [...found, { create: true, title: q }];
        },
        command: async ({ editor: ed, range, props }) => {
          let { id } = props;
          const title = props.title || 'Untitled';
          if (props.create) {
            id = await ed.storage.noteApp?.createLinkedNote?.(title);
            if (!id) return;
          }
          ed.chain().focus().insertContentAt(range, [
            { type: 'text', text: title, marks: [{ type: 'noteLink', attrs: { id } }] },
            { type: 'text', text: ' ' },
          ]).run();
        },
        render: () => {
          let renderer;
          let el;
          return {
            onStart(props) {
              renderer = new ReactRenderer(LinkMenu, { props, editor: props.editor });
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
