import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findQuote } from '../sharing.js';

export const commentKey = new PluginKey('commentMarks');

/**
 * Margin comments' highlights (8.0): the words each open thread is about, in a shared note (the viewer's copy) and in
 * the owner's own note. Decorations only; the note isn't changed. Set with tr.setMeta(commentKey, { threads, current }).
 * A thread is found again by its quote and the words around it (sharing.js findQuote), so edits since don't lose it;
 * one whose words are gone just isn't marked. Clicking a highlight calls editor.storage.commentMarks.onPick(threadId).
 */
const draw = (doc, s) => {
  const decos = [];
  for (const t of s.threads) {
    if (t.resolvedAt) continue;
    const r = findQuote(doc, t);
    if (r) decos.push(Decoration.inline(r.from, r.to, { class: `cm-mark${s.current === t.id ? ' is-current' : ''}`, 'data-thread': t.id }, { thread: t.id }));
  }
  return DecorationSet.create(doc, decos);
};

export const CommentMarks = Extension.create({
  name: 'commentMarks',
  addStorage: () => ({ onPick: null }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({
      key: commentKey,
      state: {
        init: () => ({ threads: [], current: null, decos: DecorationSet.empty }),
        apply(tr, old) {
          const meta = tr.getMeta(commentKey);
          if (!meta && !tr.docChanged) return old;
          const s = { ...old, ...(meta ?? {}) };
          if (!s.threads.length) return { ...s, decos: DecorationSet.empty };
          // While typing, the marks move with the text; they're found again from scratch when the threads change.
          s.decos = meta ? draw(tr.doc, s) : old.decos.map(tr.mapping, tr.doc);
          return s;
        },
      },
      props: {
        decorations: (state) => commentKey.getState(state).decos,
        handleClick(view, pos) {
          const s = commentKey.getState(view.state);
          const hit = s.decos.find(pos, pos)[0];
          if (hit) storage.onPick?.(hit.spec.thread);
          return false;
        },
      },
    })];
  },
});
