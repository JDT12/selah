import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findReferences, logosLink } from '../../../shared/scripture.js';
import { openPassage } from '../logos.js';

const key = new PluginKey('scriptureLinks');

/** Underlines the Bible references in each paragraph (decorations only; the note's content isn't changed). */
function decorate(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock') return false;
    // One character per inline node, so string offsets line up with document positions.
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    for (const f of findReferences(text)) {
      const refs = f.refs.map((r) => r.label).join('; ');
      decos.push(Decoration.inline(pos + 1 + f.from, pos + 1 + f.to, {
        class: 'bible-ref',
        'data-refs': refs,
        'data-ref': JSON.stringify(f.refs[0]),
        // Shown in the hover card (esv.js), with the ESV text when it's connected.
        'data-hint': 'Ctrl+click to open in Logos, right-click for more',
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/**
 * Bible references link to Logos: Ctrl/⌘+click opens the passage (in the desktop app or on the web, see logos.js);
 * right-click asks editor.storage.noteApp.bibleMenu(event, { refs, ref, pos, end }) for a menu, and on any other link
 * editor.storage.noteApp.linkMenu(event, { href, pos }) (pos: a position inside the link, for removing it).
 */
export const ScriptureLinks = Extension.create({
  name: 'scriptureLinks',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
      },
      props: {
        decorations: (state) => key.getState(state),
        // A pasted Logos link ("Copy location as → URL", logosres:…) becomes a readable link that opens in Logos.
        handlePaste(view, event) {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          const link = logosLink(text);
          if (!link) return false;
          const { schema } = view.state;
          const mark = schema.marks.link.create({ href: link.url });
          view.dispatch(view.state.tr.replaceSelectionWith(schema.text(link.label, [mark]), false).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          click(view, event) {
            const el = event.target.closest?.('.bible-ref');
            if (!el || !(event.ctrlKey || event.metaKey || !view.editable)) return false;
            event.preventDefault();
            openPassage(JSON.parse(el.dataset.ref));
            return true;
          },
          contextmenu(view, event) {
            const el = event.target.closest?.('.bible-ref');
            const app = editor.storage.noteApp;
            if (el && app?.bibleMenu) {
              const pos = view.posAtDOM(el, 0);
              // The whole reference (marks can split its underline into several elements).
              const end = key.getState(view.state).find(pos, pos + 1)[0]?.to ?? pos + el.textContent.length;
              app.bibleMenu(event, { refs: el.dataset.refs, ref: JSON.parse(el.dataset.ref), pos, end });
              return true;
            }
            const a = event.target.closest?.('a[href]');
            if (a && app?.linkMenu && view.dom.contains(a)) {
              app.linkMenu(event, { href: a.getAttribute('href'), pos: view.posAtDOM(a, 0) });
              return true;
            }
            // Right-click on selected text: the app's menu (copy, sermon bank, prayer list).
            const { from, to, empty } = view.state.selection;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (!empty && !event.shiftKey && app?.selectionMenu && at != null && at >= from && at <= to) {
              app.selectionMenu(event);
              return true;
            }
            return false;
          },
        },
      },
    })];
  },
});
