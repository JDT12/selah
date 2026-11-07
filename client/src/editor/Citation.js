import { Node } from '@tiptap/core';
import { formatCitations, htmlToPlain } from '../citations/index.js';

/**
 * A citation or footnote in the text. attrs.items: [{ id, locator, label, prefix, suffix }] (sources, by id in the
 * `sources` table); attrs.note: plain footnote text (used when there are no sources); attrs.noteHtml: the same with simple
 * formatting (italic titles), when it came from a paste rather than being typed; attrs.label: short text kept in
 * the saved HTML for search and for anything that reads the HTML without formatting it (e.g. "Wright 2013, 42").
 *
 * Saved as <sup class="citation" data-cite="[…]" data-note="…">label</sup>. Numbers, footnotes and the
 * bibliography are worked out by formatCitations() a moment after each change and kept in editor.storage.citation.
 */
export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      items: {
        default: [],
        parseHTML: (el) => { try { return JSON.parse(el.getAttribute('data-cite') || '[]'); } catch { return []; } },
        renderHTML: (a) => (a.items?.length ? { 'data-cite': JSON.stringify(a.items) } : {}),
      },
      note: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-note') ?? '',
        renderHTML: (a) => (a.note ? { 'data-note': a.note } : {}),
      },
      noteHtml: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-note-html') ?? '',
        renderHTML: (a) => (a.noteHtml ? { 'data-note-html': a.noteHtml } : {}),
      },
      label: {
        default: '',
        parseHTML: (el) => el.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup.citation' }, { tag: 'sup[data-cite]' }, { tag: 'sup[data-note]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['sup', { class: 'citation', ...HTMLAttributes }, node.attrs.label || (node.attrs.note ? '*' : '†')];
  },

  addStorage() {
    return {
      style: null,
      byPos: new Map(), // pos -> { mark, inText, html }
      notes: [],
      bibliography: [],
      noteStyle: true,
      listeners: new Set(),
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
      run: 0,
      timer: null,
      refresh: null, // set in onCreate: recompute now (e.g. after the style changes)
    };
  },

  addCommands() {
    return {
      insertCitation: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
      updateCitation: (pos, attrs) => ({ tr, dispatch }) => {
        const node = tr.doc.nodeAt(pos);
        if (node?.type.name !== this.name) return false;
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    // Ctrl+Alt+F, as in Word: insert a citation / footnote.
    return { 'Mod-Alt-f': () => { this.editor.storage.noteApp?.cite?.(); return true; } };
  },

  onCreate() {
    const storage = this.storage;
    const editor = this.editor;
    storage.refresh = async () => {
      const run = ++storage.run;
      const found = [];
      editor.state.doc.descendants((node, pos) => { if (node.type.name === 'citation') found.push({ pos, attrs: node.attrs }); });
      let out = { results: [], notes: [], bibliography: [], noteStyle: true };
      if (found.length && storage.style) {
        try {
          out = await formatCitations(found.map((f) => f.attrs), storage.style);
        } catch (e) {
          console.warn('citations', e); // eslint-disable-line no-console
          return;
        }
      }
      if (run !== storage.run || editor.isDestroyed) return; // a newer run has started
      storage.byPos = new Map(found.map((f, i) => [f.pos, out.results[i]]));
      storage.notes = out.notes.map((n) => ({ ...n, pos: found[n.index].pos }));
      storage.bibliography = out.bibliography;
      storage.noteStyle = out.noteStyle;
      storage.listeners.forEach((fn) => fn());
    };
    storage.refresh();
  },
  onUpdate() {
    clearTimeout(this.storage.timer);
    this.storage.timer = setTimeout(() => this.storage.refresh?.(), 250);
  },
  onDestroy() {
    clearTimeout(this.storage.timer);
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('sup');
      dom.className = 'citation';
      dom.contentEditable = 'false';
      let current = node;
      const render = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        const r = pos != null ? editor.storage.citation.byPos.get(pos) : null;
        dom.classList.toggle('is-in-text', !!r?.inText);
        dom.textContent = r ? (r.inText ? htmlToPlain(r.html) : r.mark) : (current.attrs.label || '…');
        dom.title = r?.html ? htmlToPlain(r.html) : (current.attrs.note || current.attrs.label || 'Citation');
      };
      render();
      const off = editor.storage.citation.subscribe(render);
      dom.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = getPos();
        if (editor.isEditable && pos != null) editor.storage.noteApp?.editCitation?.(pos);
      });
      return {
        dom,
        update: (n) => { if (n.type !== current.type) return false; current = n; render(); return true; },
        destroy: off,
        ignoreMutation: () => true,
      };
    };
  },
});
