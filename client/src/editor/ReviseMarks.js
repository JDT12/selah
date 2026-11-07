import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { analyze, docBlocks } from '../revise.js';

export const reviseKey = new PluginKey('reviseMarks');

const draw = (doc, s) => {
  if (!s.on) return s.reading ? DecorationSet.create(doc, [Decoration.inline(s.reading.from, s.reading.to, { class: 'rv-reading' })]) : DecorationSet.empty;
  const decos = s.result.issues
    .filter((i) => s.kinds.has(i.kind) && !s.dismissed.has(i.key))
    .map((i) => Decoration.inline(i.from, i.to, { class: `rv-mark rv-${i.kind}${s.current && s.current.key === i.key && s.current.from === i.from ? ' is-current' : ''}` }));
  if (s.reading) decos.push(Decoration.inline(s.reading.from, s.reading.to, { class: 'rv-reading' }));
  return DecorationSet.create(doc, decos);
};

/**
 * The Revise panel's highlights (decorations only; the note isn't changed). The panel sets it with
 * tr.setMeta(reviseKey, { on, kinds, opts, dismissed, current, reading }); the state keeps the checks' result
 * (revise.js analyze) up to date as the note changes while it's on. Clicking a highlight tells the panel
 * (editor.storage.reviseMarks.onPick), and the cursor still goes there.
 */
export const ReviseMarks = Extension.create({
  name: 'reviseMarks',
  addStorage: () => ({ onPick: null }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    const empty = { issues: [], stats: null, paragraphs: [] };
    return [new Plugin({
      key: reviseKey,
      state: {
        init: () => ({ on: false, kinds: new Set(), opts: {}, dismissed: new Set(), current: null, reading: null, result: empty, decos: DecorationSet.empty }),
        apply(tr, old) {
          const meta = tr.getMeta(reviseKey);
          if (!meta && !tr.docChanged) return old;
          const s = { ...old, ...(meta ?? {}) };
          // The reading highlight follows edits; the checks run again when the note or the options change.
          if (!meta?.reading && old.reading && tr.docChanged) s.reading = { from: tr.mapping.map(old.reading.from), to: tr.mapping.map(old.reading.to) };
          if (s.on && (tr.docChanged || meta?.on !== undefined || meta?.opts)) s.result = analyze(docBlocks(tr.doc), s.opts);
          if (!s.on) s.result = empty;
          s.decos = draw(tr.doc, s);
          return s;
        },
      },
      props: {
        decorations: (state) => reviseKey.getState(state).decos,
        handleClick(view, pos) {
          const s = reviseKey.getState(view.state);
          if (!s.on) return false;
          const hit = s.result.issues.find((i) => s.kinds.has(i.kind) && !s.dismissed.has(i.key) && pos >= i.from && pos <= i.to);
          if (hit) storage.onPick?.(hit);
          return false;
        },
      },
    })];
  },
});
