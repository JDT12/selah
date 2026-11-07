import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { onWordLibrary, startWordLibrary, wordMatcher } from '../wordLibrary.js';
import { openNoteEvent } from './NoteLinks.jsx';

const key = new PluginKey('wordMarks');

/**
 * Words you've studied (8.5): their Hebrew or Greek, transliteration and Strong's number (and the English word when
 * a study asks for it) are underlined lightly, with a hover card of the study (noteCards.js). Ctrl/⌘+click opens it.
 * Decorations only; the note's content isn't changed.
 */
function decorate(doc) {
  const { re, byTerm } = wordMatcher();
  if (!re) return DecorationSet.empty;
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock') return false;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const study = byTerm.get(m[0].toLowerCase());
      if (!study) continue;
      decos.push(Decoration.inline(pos + 1 + m.index, pos + 1 + m.index + m[0].length, { class: 'word-ref', 'data-word-note': String(study.note_id) }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const WordMarks = Extension.create({
  name: 'wordMarks',
  addProseMirrorPlugins() {
    startWordLibrary();
    return [new Plugin({
      key,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (tr, old) => (tr.docChanged || tr.getMeta(key) ? decorate(tr.doc) : old.map(tr.mapping, tr.doc)),
      },
      view(view) {
        const off = onWordLibrary(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true)); });
        return { destroy: off };
      },
      props: {
        decorations: (state) => key.getState(state),
        handleDOMEvents: {
          click(view, event) {
            const el = event.target.closest?.('.word-ref');
            if (!el || !(event.ctrlKey || event.metaKey || !view.editable)) return false;
            event.preventDefault();
            openNoteEvent(Number(el.dataset.wordNote));
            return true;
          },
        },
      },
    })];
  },
});
