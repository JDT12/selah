import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const findKey = new PluginKey('findInNote');

/** Every place the query appears in the note's text, ignoring case: [{ from, to }] in document positions. */
export function findMatches(doc, query) {
  const q = query.toLocaleLowerCase();
  const out = [];
  if (!q) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One character per inline node, so string offsets line up with document positions.
    const text = node.textBetween(0, node.content.size, undefined, '￼').toLocaleLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
    return false;
  });
  return out;
}

const draw = (doc, { matches, current }) => DecorationSet.create(doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-hit is-current' : 'find-hit' })));

/**
 * Find in note: highlights each match of the query (decorations only; the note isn't changed). The find bar sets it
 * with tr.setMeta(findKey, { query, current }); the state is { query, matches, current, decos }, kept up to date as
 * the note changes.
 */
export const FindInNote = Extension.create({
  name: 'findInNote',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => ({ query: '', matches: [], current: 0, decos: DecorationSet.empty }),
        apply(tr, old) {
          const meta = tr.getMeta(findKey);
          if (!meta && !tr.docChanged) return old;
          const query = meta?.query ?? old.query;
          const matches = findMatches(tr.doc, query);
          const current = matches.length ? Math.min(Math.max(meta?.current ?? old.current, 0), matches.length - 1) : 0;
          return { query, matches, current, decos: draw(tr.doc, { matches, current }) };
        },
      },
      props: { decorations: (state) => findKey.getState(state).decos },
    })];
  },
});
