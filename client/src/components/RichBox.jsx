import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { splitLogosQuote } from '../editor/LogosPaste.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Where an offset in `before` is in `after` (what's the same at the start stays put). */
function shiftOffset(pos, before, after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  return pos <= p ? pos : Math.max(p, pos + after.length - before.length);
}
/** The editor's HTML, with an empty box as ''. */
const htmlOf = (editor) => (editor.isEmpty ? '' : editor.getHTML());

/**
 * A builder's box (10.0): a small editor for one part of the note, with bold, italic, bullet and numbered lists, and
 * links (paste a web address, select text and press Ctrl+K, or use the toolbar). It writes the part's HTML, so lists
 * and links reach the note as they are. What it can hold is sermon.js's boxCanHold; anything more is edited in the
 * note. A Logos quote pastes as the quote with its citation after it, as the text areas did.
 */
export default function RichBox({ html, onChange, placeholder = '', rows = 3, label }) {
  const dialog = useDialog();
  const sent = useRef(html ?? '');
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const linkRef = useRef(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, codeBlock: false, horizontalRule: false, dropcursor: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Placeholder.configure({ placeholder: placeholder.split('\n')[0] }),
    ],
    content: html ?? '',
    editorProps: {
      attributes: { class: 'rb-body', role: 'textbox', 'aria-multiline': 'true', ...(label ? { 'aria-label': label } : {}), style: `min-height: ${1.5 * rows + 0.9}em` },
      handleKeyDown: (view, e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          e.stopPropagation(); // not the command palette
          // A selection made with Shift+arrows a moment ago may not have reached the editor yet.
          view.domObserver?.flush?.();
          linkRef.current?.();
          return true;
        }
        return false;
      },
      handlePaste: (view, e) => {
        const split = splitLogosQuote(e.clipboardData?.getData('text/html') ?? '', e.clipboardData?.getData('text/plain') ?? '');
        if (!split) return false;
        const text = `“${split.quote.map((p) => p.text).join(' ')}” (${split.citation.text.replace(/\.\s*$/, '')})`;
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const out = htmlOf(ed);
      sent.current = out;
      changeRef.current?.({ html: out });
    },
  });

  // A change from outside (a photo's words added, the reiteration refreshed, the builder reloaded, 14.3: someone
  // else typing) shows in the box, before the page is drawn, so nothing typed in between is lost.
  useLayoutEffect(() => {
    if (!editor || (html ?? '') === sent.current) return;
    sent.current = html ?? '';
    // 14.3: someone else typing in this box (live co-editing): the cursor stays where it was, moved by what they
    // added or took out before it.
    if (!editor.isFocused) { editor.commands.setContent(html ?? '', { emitUpdate: false }); return; }
    const textTo = (d, p) => d.textBetween(0, p, '\n', '\n');
    const old = editor.state.doc;
    const { from, to } = editor.state.selection;
    const oldText = textTo(old, old.content.size);
    const marks = [textTo(old, from).length, textTo(old, to).length];
    // Spaces kept as they are: a space typed at the end of a line is still there when the others' typing arrives.
    editor.commands.setContent(html ?? '', { emitUpdate: false, parseOptions: { preserveWhitespace: 'full' } });
    const doc = editor.state.doc;
    const newText = textTo(doc, doc.content.size);
    // A text offset back to a place in the document (the text grows with the position).
    const posAt = (n) => {
      let lo = 0;
      let hi = doc.content.size;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (textTo(doc, mid).length < n) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const [a, b] = marks.map((n) => posAt(shiftOffset(n, oldText, newText)));
    try { editor.commands.setTextSelection({ from: a, to: b }); } catch { /* past the end */ }
  }, [html, editor]);

  const setLink = async () => {
    if (!editor) return;
    const was = editor.getAttributes('link').href ?? '';
    const { empty } = editor.state.selection;
    const href = await dialog.prompt({ title: was ? 'Edit link' : 'Add a link', label: 'Web address', value: was, placeholder: 'https://…', okLabel: was ? 'Save' : 'Add' });
    if (href == null) { editor.commands.focus(); return; }
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) { chain.unsetLink().run(); return; }
    const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (empty && !was) chain.insertContent(`<a href="${esc(full)}">${esc(url)}</a> `).run();
    else chain.setLink({ href: full }).run();
  };
  linkRef.current = setLink;

  if (!editor) return null;
  const tool = (name, icon, title, run, active) => (
    <button type="button" className={`rb-tool ${active ? 'is-active' : ''}`} title={title} aria-label={title} aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()} onClick={run}><Icon name={icon} size={14} /></button>
  );
  return (
    <div className="rb">
      <div className="rb-tools" role="toolbar" aria-label={label ? `${label} formatting` : 'Formatting'}>
        {tool('bold', 'bold', 'Bold (Ctrl+B)', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
        {tool('italic', 'italic', 'Italic (Ctrl+I)', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
        <span className="rb-sep" />
        {tool('bullets', 'list', 'Bulleted list', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
        {tool('numbers', 'listOrdered', 'Numbered list', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
        <span className="rb-sep" />
        {tool('link', 'link', 'Link (Ctrl+K)', setLink, editor.isActive('link'))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
