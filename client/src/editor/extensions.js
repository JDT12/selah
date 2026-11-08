import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { dropPoint } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Table, TableCell, TableHeader, TableKit, TableView } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeRangeSelection, isNodeRangeSelection } from '@tiptap/extension-node-range';
import { common, createLowlight } from 'lowlight';
import powershell from 'highlight.js/lib/languages/powershell';
import CodeBlockView from './CodeBlockView.jsx';
import { Attachment } from './Attachment.jsx';
import { Drawing } from './Drawing.jsx';
import { Callout } from './Callout.jsx';
import { SlashCommand } from './SlashCommand.jsx';
import { Citation } from './Citation.js';
import { ScriptureLinks } from './ScriptureLinks.js';
import { WordMarks } from './WordMarks.js';
import { LogosPaste } from './LogosPaste.js';
import { FindInNote } from './FindInNote.js';
import { ReviseMarks } from './ReviseMarks.js';
import { CommentMarks } from './CommentMarks.js';
import { WorkSections } from './WorkSections.js';
import { openLink } from '../logos.js';
import { NoteLink, NoteLinkSuggest, openNoteEvent } from './NoteLinks.jsx';

const lowlight = createLowlight(common);
lowlight.register({ powershell });
lowlight.registerAlias({ powershell: ['ps', 'ps1', 'pwsh'] });

/** Per-editor app hooks (file picker, uploads) + paste/drop of files. */
const NoteApp = Extension.create({
  name: 'noteApp',
  addOptions() {
    return { onFiles: null };
  },
  addStorage() {
    return {
      pickFile: null, takePhoto: null, recordAudio: null, insertTemplate: null, cite: null, footnote: null, editCitation: null,
      bibleMenu: null, linkMenu: null, logosLink: null, esvPassage: null, notify: null,
      noteId: null, notebookName: null, createLinkedNote: null,
      handwriting: null, drawingToText: null, attachmentToText: null, imageMenu: null,
      fileUrl: null, // (id) => URL: set for a note shared with me (8.0), whose files come from the share
    };
  },
  addProseMirrorPlugins() {
    const { onFiles } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const files = [...(event.clipboardData?.files ?? [])];
            if (!files.length || !onFiles) return false;
            onFiles(files, null);
            return true;
          },
          handleDrop(view, event, slice, moved) {
            const files = [...(event.dataTransfer?.files ?? [])];
            if (moved || !files.length || !onFiles) return false;
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            onFiles(files, pos);
            return true;
          },
          handleDOMEvents: {
            // Right-click on a picture: its own menu (open, download, handwriting to text).
            contextmenu: (view, event) => {
              const img = event.target.closest?.('img');
              const menu = this.storage.imageMenu;
              if (!img || !menu || !view.dom.contains(img)) return false;
              let at = null;
              view.state.doc.descendants((node, pos) => {
                if (at === null && node.type.name === 'image' && view.nodeDOM(pos)?.contains(img)) at = pos;
                return at === null;
              });
              if (at === null) return false;
              menu(event, at);
              return true;
            },
          },
          // Ctrl/Cmd+click follows links while editing.
          handleClick(view, pos, event) {
            // A click on a link to another note opens it.
            const noteLink = event.target.closest?.('a.note-link[data-note-id]');
            if (noteLink && !event.shiftKey) {
              openNoteEvent(Number(noteLink.dataset.noteId), event.ctrlKey || event.metaKey);
              return true;
            }
            const a = event.target.closest?.('a[href]');
            if (a && (event.ctrlKey || event.metaKey || !view.editable)) {
              openLink(a.href); // Logos links may open in the desktop app
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * The stock detailsContent view starts hidden and *toggles* on each open/close event, which
 * can drift out of sync with the node's `open` attribute (e.g. a section created open).
 * This version derives visibility from the actual state instead.
 */
const SyncedDetailsContent = DetailsContent.extend({
  addNodeView() {
    return ({ HTMLAttributes, getPos, editor }) => {
      const dom = document.createElement('div');
      const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': this.name });
      Object.entries(attrs).forEach(([k, v]) => dom.setAttribute(k, v));
      try {
        const pos = getPos();
        dom.hidden = typeof pos === 'number' ? !editor.state.doc.resolve(pos).parent.attrs.open : false;
      } catch {
        dom.hidden = false;
      }
      dom.addEventListener('toggleDetailsContent', () => {
        const wrapper = dom.closest('[data-type="details"]');
        dom.hidden = wrapper ? !wrapper.classList.contains('is-open') : false;
      });
      return {
        dom,
        contentDOM: dom,
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false;
          return !dom.contains(mutation.target) || dom === mutation.target;
        },
        update: (node) => node.type === this.type,
      };
    };
  },
});

/**
 * Enter on an empty last line inside a collapsible section or callout exits the block
 * (the same way lists and quotes behave), so you can continue writing below it.
 */
const ExitContainers = Extension.create({
  name: 'exitContainers',
  priority: 200,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return false;
        const isEmptyPara = (n) => n.type.name === 'paragraph' && n.content.size === 0;

        // Enter in an open section's title: jump into the body, reusing an empty first line.
        if ($from.parent.type.name === 'detailsSummary') {
          const details = $from.node(-1);
          const content = details.child(1);
          if (!details.attrs.open || content.childCount !== 1 || !isEmptyPara(content.firstChild)) return false;
          const bodyPos = $from.after() + 2; // into detailsContent > paragraph
          editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, bodyPos)).scrollIntoView());
          return true;
        }

        if (!isEmptyPara($from.parent)) return false;
        const container = $from.node(-1);
        const kind = container?.type.name;
        if (kind !== 'detailsContent' && kind !== 'callout') return false;
        const index = $from.index(-1);
        if (index === 0) return false;
        // Only exit when everything after the cursor in the block is empty lines too.
        for (let i = index + 1; i < container.childCount; i++) {
          if (!isEmptyPara(container.child(i))) return false;
        }
        const wrapperDepth = kind === 'detailsContent' ? $from.depth - 2 : $from.depth - 1;
        const tr = state.tr.delete($from.before(), $from.end(-1));
        const pos = tr.mapping.map($from.after(wrapperDepth));
        const next = tr.doc.nodeAt(pos);
        if (!next || !isEmptyPara(next)) tr.insert(pos, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});

/**
 * Collapsible H1/H2 headings. A top-level heading's `collapsed` attribute (saved with the
 * note) hides every block below it: an H1 folds up to the next H1, an H2 up to the next
 * H2 (or H1). Moving the cursor into a hidden block (e.g. Enter at the end of the heading)
 * expands it.
 */
const FOLDABLE = 2;
const foldKey = new PluginKey('headingFold');

/** Hidden top-level blocks: [{ from, to, heading }] where heading is the collapsed heading's pos. */
function foldedBlocks(doc) {
  const out = [];
  let fold = null;
  doc.forEach((node, offset) => {
    // A heading starts a new fold region unless it sits inside a collapsed higher-level one.
    if (node.type.name === 'heading' && node.attrs.level <= FOLDABLE && (!fold || node.attrs.level <= fold.level)) {
      fold = node.attrs.collapsed ? { level: node.attrs.level, pos: offset } : null;
      return;
    }
    if (fold) out.push({ from: offset, to: offset + node.nodeSize, heading: fold.pos });
  });
  return out;
}

function foldToggle(view, getPos, collapsed) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'heading-fold';
  btn.contentEditable = 'false';
  btn.title = collapsed ? 'Expand section' : 'Collapse section';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const $pos = view.state.doc.resolve(pos);
    const headingPos = $pos.before();
    const heading = view.state.doc.nodeAt(headingPos);
    if (heading?.type.name !== 'heading') return;
    // Park the cursor in the heading so collapsing doesn't immediately re-expand around it.
    const tr = view.state.tr.setNodeMarkup(headingPos, null, { ...heading.attrs, collapsed: !heading.attrs.collapsed });
    tr.setSelection(TextSelection.create(tr.doc, headingPos + heading.nodeSize - 1));
    view.dispatch(tr);
  });
  return btn;
}

const HeadingFold = Extension.create({
  name: 'headingFold',
  addGlobalAttributes() {
    return [{
      types: ['heading'],
      attributes: {
        collapsed: {
          default: false,
          parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
          renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: foldKey,
        props: {
          decorations(state) {
            const decos = [];
            state.doc.forEach((node, offset) => {
              if (node.type.name !== 'heading' || node.attrs.level > FOLDABLE || !node.content.size) return;
              const collapsed = !!node.attrs.collapsed;
              decos.push(Decoration.widget(offset + 1, (view, getPos) => foldToggle(view, getPos, collapsed), {
                side: -1, ignoreSelection: true, key: `fold-${offset}-${collapsed}`,
                // Keep ProseMirror's own mouse handling (cursor placement) off the button.
                stopEvent: () => true,
              }));
              if (collapsed) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-collapsed' }));
            });
            for (const b of foldedBlocks(state.doc)) decos.push(Decoration.node(b.from, b.to, { class: 'is-folded' }));
            return DecorationSet.create(state.doc, decos);
          },
        },
        appendTransaction(trs, oldState, state) {
          if (!trs.some((t) => t.selectionSet || t.docChanged)) return null;
          const { from } = state.selection;
          const hidden = foldedBlocks(state.doc).find((b) => from > b.from && from < b.to);
          if (!hidden) return null;
          const heading = state.doc.nodeAt(hidden.heading);
          return state.tr.setNodeMarkup(hidden.heading, null, { ...heading.attrs, collapsed: false });
        },
      }),
    ];
  },
});

/**
 * A sermon block's place in delivery order (numbered on the sermon builder's Arrange board), kept through editing the
 * note. A paragraph split with Enter doesn't copy it.
 */
const DeliveryOrder = Extension.create({
  name: 'deliveryOrder',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'listItem', 'taskItem', 'blockquote', 'callout', 'image', 'table'],
      attributes: {
        order: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el) => el.getAttribute('data-order'),
          renderHTML: (attrs) => (attrs.order ? { 'data-order': attrs.order } : {}),
        },
      },
    }];
  },
});

/**
 * A block's own id (data-bid), given when the note is exported for the iPad (server/lessonexport.js) and kept through
 * editing, so notes written beside a paragraph in Selah Companion stay with it after the next export. A block split
 * with Enter doesn't copy it (the new half gets its own at the next export).
 */
const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'callout', 'image', 'table', 'codeBlock'],
      attributes: {
        bid: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el) => el.getAttribute('data-bid'),
          renderHTML: (attrs) => (attrs.bid ? { 'data-bid': attrs.bid } : {}),
        },
      },
    }];
  },
});

/**
 * Dragging a heading by its grip carries its section with it: an H1 brings everything up to the next H1, an H2 up to
 * the next H2 or H1, and so on. The drag handle has already picked up the heading alone by the time the dragstart
 * reaches the document, so this widens what it carries.
 * A list item's grip moves that item; held with Alt it moves the whole list (the outermost one it's in). A single item
 * dropped outside any list goes in a list of its own kind, so it stays numbered (or a to-do) instead of ProseMirror
 * wrapping it in a bulleted list.
 */
function sectionEnd(doc, index, level) {
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    if (i > index && node.type.name === 'heading' && node.attrs.level <= level) return pos;
    pos += node.nodeSize;
  }
  return pos;
}

function sectionDragImage(view, from, to) {
  const wrap = document.createElement('div');
  wrap.className = 'section-drag-image note-body';
  let count = 0;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (count < 4) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof Element) wrap.append(dom.cloneNode(true));
    }
    count++;
    return false;
  });
  if (count > 4) {
    const more = document.createElement('div');
    more.className = 'section-drag-more';
    more.textContent = `+ ${count - 4} more block${count - 4 === 1 ? '' : 's'}`;
    wrap.append(more);
  }
  wrap.style.cssText = `position:absolute;top:-10000px;left:0;width:${view.dom.clientWidth}px`;
  document.body.append(wrap);
  return wrap;
}

function dropItemOutsideList(view, event, slice, moved) {
  const sel = view.state.selection;
  const item = slice.content.childCount === 1 ? slice.content.firstChild : null;
  if (!moved || !(sel instanceof NodeSelection) || !item || sel.node !== item || !['listItem', 'taskItem'].includes(item.type.name)) return false;
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (pos == null) return false;
  const at = dropPoint(view.state.doc, pos, slice);
  // Dropped among list items: the usual drop does the right thing.
  if (at == null || view.state.doc.resolve(at).parent.type.name.endsWith('List')) return false;
  const wrapped = new Slice(Fragment.from(sel.$from.parent.copy(Fragment.from(item))), 0, 0);
  const target = dropPoint(view.state.doc, pos, wrapped);
  if (target == null) return false;
  const tr = view.state.tr;
  sel.replace(tr);
  const into = tr.mapping.map(target);
  tr.insert(into, wrapped.content);
  tr.setSelection(NodeSelection.create(tr.doc, into));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

const SectionDrag = Extension.create({
  name: 'sectionDrag',
  // Ahead of the drag handle, which hides its grip on every key press: pressing Alt (to drag a whole list) mustn't.
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDrop: dropItemOutsideList,
          handleDOMEvents: { keydown: (view, event) => event.key === 'Alt' },
        },
        view(view) {
          let image = null;
          const clearImage = () => { image?.remove(); image = null; };
          const onDragStart = (event) => {
            const sel = view.state.selection;
            if (!view.dragging || view.dom.contains(event.target)) return;
            if (sel instanceof NodeSelection && ['listItem', 'taskItem'].includes(sel.node.type.name)) {
              if (!event.altKey) return;
              let d = 1;
              while (d < sel.$from.depth && !sel.$from.node(d).type.name.endsWith('List')) d++;
              const list = NodeSelection.create(view.state.doc, sel.$from.before(d));
              view.dragging = { slice: list.content(), move: true, node: list };
              view.dispatch(view.state.tr.setSelection(list));
              if (event.dataTransfer) {
                clearImage();
                image = sectionDragImage(view, list.from, list.to);
                event.dataTransfer.setDragImage(image, 0, 0);
              }
              return;
            }
            // In a NodeRangeSelection or (from the nested drag handle) a NodeSelection of one top-level block.
            const isBlock = isNodeRangeSelection(sel) ? sel.ranges.length === 1 : sel instanceof NodeSelection;
            if (!isBlock || sel.$from.depth !== 0) return;
            const heading = view.state.doc.nodeAt(sel.from);
            if (heading?.type.name !== 'heading') return;
            const to = sectionEnd(view.state.doc, sel.$from.index(0), heading.attrs.level);
            if (to <= sel.to) return;
            const section = NodeRangeSelection.create(view.state.doc, sel.from, to);
            view.dragging = { slice: section.content(), move: true };
            view.dispatch(view.state.tr.setSelection(section));
            if (event.dataTransfer) {
              clearImage();
              image = sectionDragImage(view, sel.from, to);
              event.dataTransfer.setDragImage(image, 0, 0);
            }
          };
          document.addEventListener('dragstart', onDragStart);
          document.addEventListener('dragend', clearImage);
          document.addEventListener('drop', clearImage);
          return {
            destroy() {
              clearImage();
              document.removeEventListener('dragstart', onDragStart);
              document.removeEventListener('dragend', clearImage);
              document.removeEventListener('drop', clearImage);
            },
          };
        },
      }),
    ];
  },
});

/**
 * Two lists of the same kind that end up touching (deleting the item between them, or the line that separated them)
 * join back into one, so a numbered list keeps counting instead of starting again at 1. Loading a note doesn't change
 * it; a note saved with a split list joins up at its next edit.
 */
const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

function listJoins(doc) {
  const joins = [];
  // `start` is where the node's content begins (0 for the document itself).
  const scan = (node, start) => {
    let at = start;
    for (let i = 0; i < node.childCount - 1; i++) {
      const a = node.child(i);
      at += a.nodeSize;
      if (LIST_TYPES.includes(a.type.name) && a.type === node.child(i + 1).type) joins.push(at);
    }
  };
  scan(doc, 0);
  doc.descendants((node, pos) => {
    if (node.isTextblock || node.isLeaf) return false;
    scan(node, pos + 1);
    return true;
  });
  return joins;
}

const ListJoin = Extension.create({
  name: 'listJoin',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(trs, oldState, state) {
          if (!trs.some((t) => t.docChanged && !t.getMeta('preventUpdate'))) return null;
          const joins = listJoins(state.doc);
          if (!joins.length) return null;
          const tr = state.tr;
          // Last first, so the earlier positions still hold.
          for (const pos of joins.sort((x, y) => y - x)) tr.join(pos);
          return tr;
        },
      }),
    ];
  },
});

/**
 * The placeholder hint ("Type '/' for blocks…") on the empty line holding the cursor. Tiptap's own Placeholder
 * patches its decorations incrementally and could leave a hint behind on a line the cursor had left, so this one is
 * worked out from the selection on every render. The CSS hides it while the editor doesn't have focus.
 */
function hintFor(node) {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
  if (node.type.name === 'detailsSummary') return 'Section title';
  return "Type '/' for blocks, or just start writing…";
}

const EmptyLineHint = Extension.create({
  name: 'emptyLineHint',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          decorations(state) {
            if (!editor.isEditable) return null;
            const { selection, doc } = state;
            const decos = [];
            const onlyLine = doc.childCount === 1 && doc.firstChild.isTextblock && !doc.firstChild.content.size;
            const $pos = selection.$anchor;
            const line = $pos.parent;
            if (selection.empty && line.isTextblock && !line.content.size && line.type.name !== 'codeBlock' && $pos.depth > 0) {
              decos.push(Decoration.node($pos.before(), $pos.after(), {
                class: onlyLine ? 'is-empty is-editor-empty' : 'is-empty', 'data-placeholder': hintFor(line),
              }));
            } else if (onlyLine) {
              decos.push(Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-empty is-editor-empty', 'data-placeholder': hintFor(doc.firstChild) }));
            }
            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});

/**
 * Highlighter and text colors. Like the cell colors below they're named, not stored as values, so each theme can show
 * them in a shade that reads well (styles.css). A highlight without a color is the original yellow one.
 */
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple'];
export const TEXT_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'gray'];

const ColorHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          const c = el.getAttribute('data-color');
          return c !== 'yellow' && HIGHLIGHT_COLORS.includes(c) ? c : null;
        },
        renderHTML: (attrs) => (attrs.color ? { 'data-color': attrs.color } : {}),
      },
    };
  },
}).configure({ multicolor: true });

const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (TEXT_COLORS.includes(el.getAttribute('data-text-color')) ? el.getAttribute('data-text-color') : null),
        renderHTML: (attrs) => (attrs.color ? { 'data-text-color': attrs.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-text-color]', getAttrs: (el) => (TEXT_COLORS.includes(el.getAttribute('data-text-color')) ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setTextColor: (color) => ({ commands }) => commands.setMark(this.name, { color }),
      unsetTextColor: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

/**
 * Moving one list item (with its sub-items) up or down within its list: Alt+↑ / Alt+↓, or the list buttons on a phone.
 * It stops at the ends of the list. Indent / Outdent are the list's own sink and lift.
 */
const ITEM_TYPES = ['listItem', 'taskItem'];

function listItemDepth($pos) {
  for (let d = $pos.depth; d > 0; d--) if (ITEM_TYPES.includes($pos.node(d).type.name)) return d;
  return null;
}

function moveListItem(dir) {
  return ({ state, dispatch }) => {
    const { $from, $to, anchor, head } = state.selection;
    const d = listItemDepth($from);
    // The whole selection has to sit in the one item.
    if (d === null || $to.depth < d || $to.before(d) !== $from.before(d)) return false;
    const list = $from.node(d - 1);
    const index = $from.index(d - 1);
    const other = index + dir;
    if (other < 0 || other >= list.childCount) return true; // at the end of the list: nothing to do, but the key is used
    const item = $from.node(d);
    const start = $from.before(d);
    if (dispatch) {
      const sibling = list.child(other);
      const from = dir < 0 ? start - sibling.nodeSize : start;
      const to = dir < 0 ? start + item.nodeSize : start + item.nodeSize + sibling.nodeSize;
      const shift = dir < 0 ? -sibling.nodeSize : sibling.nodeSize;
      const tr = state.tr.replaceWith(from, to, dir < 0 ? [item, sibling] : [sibling, item]);
      tr.setSelection(TextSelection.create(tr.doc, anchor + shift, head + shift));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

function itemType(state) {
  const d = listItemDepth(state.selection.$from);
  return d === null ? null : state.selection.$from.node(d).type.name;
}

const ListMove = Extension.create({
  name: 'listMove',
  addCommands() {
    return {
      moveListItemUp: () => moveListItem(-1),
      moveListItemDown: () => moveListItem(1),
      indentListItem: () => ({ state, commands }) => (itemType(state) ? commands.sinkListItem(itemType(state)) : false),
      outdentListItem: () => ({ state, commands }) => (itemType(state) ? commands.liftListItem(itemType(state)) : false),
    };
  },
  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': () => this.editor.commands.moveListItemUp(),
      'Alt-ArrowDown': () => this.editor.commands.moveListItemDown(),
    };
  },
});

/** Named, theme-aware cell background colors (stored as data-bg). */
export const CELL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const cellBackground = {
  backgroundColor: {
    default: null,
    parseHTML: (el) => (CELL_COLORS.includes(el.getAttribute('data-bg')) ? el.getAttribute('data-bg') : null),
    renderHTML: (attrs) => (attrs.backgroundColor ? { 'data-bg': attrs.backgroundColor } : {}),
  },
};
const ColoredCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...cellBackground }; } });
const ColoredHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...cellBackground }; } });

/**
 * The Cornell notes sheet (shared/cornell.js) is three tables marked data-cornell: head, notes and summary. The
 * resizable table view leaves a table's own attributes off, so this one copies the mark across for the styling.
 */
const CORNELL_PARTS = ['head', 'notes', 'summary'];
class MarkedTableView extends TableView {
  constructor(node, ...rest) {
    super(node, ...rest);
    this.mark(node);
  }

  update(node) {
    if (!super.update(node)) return false;
    this.mark(node);
    return true;
  }

  mark(node) {
    if (node.attrs.cornell) this.table.setAttribute('data-cornell', node.attrs.cornell);
    else this.table.removeAttribute('data-cornell');
  }
}

/** Tab past the last cell of the Cornell header goes on to the first cue; past the summary, out below the sheet. */
function cornellTab(editor) {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name !== 'table') continue;
    if (node.attrs.cornell !== 'head' && node.attrs.cornell !== 'summary') return false;
    const after = $from.after(d);
    const next = editor.state.doc.nodeAt(after);
    if (node.attrs.cornell === 'head' && next?.type.name === 'table') {
      // table > first row (the column titles) > ... the first cell of the second row.
      const firstCue = after + 1 + next.firstChild.nodeSize + 3;
      return editor.chain().setTextSelection(firstCue).scrollIntoView().run();
    }
    if (next?.isTextblock) return editor.chain().setTextSelection(after + 1).scrollIntoView().run();
    return editor.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).scrollIntoView().run();
  }
  return false;
}

const MarkedTable = Table.extend({
  addOptions() {
    return { ...this.parent?.(), resizable: true, View: MarkedTableView };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      cornell: {
        default: null,
        parseHTML: (el) => (CORNELL_PARTS.includes(el.getAttribute('data-cornell')) ? el.getAttribute('data-cornell') : null),
        renderHTML: (attrs) => (attrs.cornell ? { 'data-cornell': attrs.cornell } : {}),
      },
    };
  },
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      Tab: () => {
        if (this.editor.commands.goToNextCell()) return true;
        return cornellTab(this.editor) || parent.Tab?.() || false;
      },
    };
  },
});

export function buildExtensions({ onFiles }) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
      dropcursor: { color: 'var(--accent)', width: 3 },
    }),
    CodeBlockLowlight.extend({
      addNodeView() {
        return ReactNodeViewRenderer(CodeBlockView);
      },
    }).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // New collapsible sections start expanded so Enter in the title moves into the body.
    // (Saved/imported sections keep whatever open state they were stored with.)
    Details.extend({
      addAttributes() {
        const attrs = this.parent?.() ?? {};
        return { ...attrs, open: { ...attrs.open, default: true } };
      },
    }).configure({ persist: true, HTMLAttributes: { class: 'details' } }),
    DetailsSummary,
    SyncedDetailsContent,
    TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
    MarkedTable,
    ColoredCell,
    ColoredHeader,
    Image.configure({ resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 40, minHeight: 40 } }),
    ColorHighlight,
    TextColor,
    ListMove,
    EmptyLineHint,
    Callout,
    ExitContainers,
    HeadingFold,
    DeliveryOrder,
    BlockId,
    SectionDrag,
    ListJoin,
    Attachment,
    Drawing,
    Citation,
    ScriptureLinks,
    WordMarks,
    LogosPaste,
    FindInNote,
    ReviseMarks,
    CommentMarks,
    WorkSections,
    SlashCommand,
    NoteLink,
    NoteLinkSuggest,
    NoteApp.configure({ onFiles }),
  ];
}
