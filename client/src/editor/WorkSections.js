import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const workKey = new PluginKey('workSections');

/** A paragraph that states the big idea (or a principle, keeper or proposition): it reads as a callout. */
const CALLOUT = /^\s*(big idea|main idea|the big idea|principle|proposition|keeper|theme)\s*:/i;
/** Lines above the first section that only repeat the title or name the verses: they read as small print. */
const PRELINE = /^\s*(title|verses?|passage|text)\s*:/i;

/**
 * The note's sections at the method's heading level: { title, pos, empty, part, firstEmpty } for each, where `part`
 * is whether it's one of the method's named sections (a sermon's divisions aren't) and `firstEmpty` is the position
 * of the empty paragraph under an empty section (where its prompt shows).
 */
export function workSections(doc, cfg) {
  const out = [];
  let cur = null;
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.attrs.level === cfg.level) {
      const title = node.textContent.trim();
      cur = { title, pos, node, empty: true, part: !cfg.parts || cfg.parts.some((re) => re.test(title)), firstEmpty: null };
      out.push(cur);
      return;
    }
    if (!cur) return;
    if (node.textContent.trim() || ['image', 'attachment', 'drawing', 'table', 'horizontalRule'].includes(node.type.name)) cur.empty = false;
    else if (cur.empty && cur.firstEmpty === null && node.type.name === 'paragraph') cur.firstEmpty = { pos, size: node.nodeSize };
  });
  return out;
}

function draw(doc, cfg) {
  if (!cfg?.on) return DecorationSet.empty;
  const decos = [];
  let seenSection = false;
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.attrs.level === cfg.level) seenSection = true;
    if (node.type.name !== 'paragraph') return;
    const t = node.textContent;
    if (CALLOUT.test(t)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'work-callout' }));
    else if (!seenSection && PRELINE.test(t)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'work-preline' }));
  });
  for (const s of workSections(doc, cfg)) {
    decos.push(Decoration.node(s.pos, s.pos + s.node.nodeSize, { class: `work-head ${s.part ? 'is-part' : 'is-division'}${s.empty ? ' is-empty' : ''}` }));
    const prompt = s.empty && s.firstEmpty && cfg.prompt?.(s.title, s.part);
    if (prompt) decos.push(Decoration.node(s.firstEmpty.pos, s.firstEmpty.pos + s.firstEmpty.size, { class: 'work-prompt', 'data-prompt': prompt }));
  }
  return DecorationSet.create(doc, decos);
}

/**
 * A lesson, sermon or Bible study read as a page (7.1): its sections' headings as small labels (a sermon's divisions
 * as headings of their own), the big idea as a callout, an empty section greyed with a prompt for what goes there,
 * and the Title and Verses lines in small print. Decorations only: the note isn't changed. NoteEditor turns it on with
 * tr.setMeta(workKey, { on, level, parts, prompt }).
 */
export const WorkSections = Extension.create({
  name: 'workSections',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: workKey,
      state: {
        init: () => ({ cfg: null, decos: DecorationSet.empty }),
        apply(tr, old) {
          const meta = tr.getMeta(workKey);
          if (!meta && !tr.docChanged) return old;
          const cfg = meta ?? old.cfg;
          return { cfg, decos: draw(tr.doc, cfg) };
        },
      },
      props: { decorations: (state) => workKey.getState(state).decos },
    })];
  },
});
