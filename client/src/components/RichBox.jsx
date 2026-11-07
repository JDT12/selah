import { useEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { splitLogosQuote } from '../editor/LogosPaste.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // A change from outside (a photo's words added, the reiteration refreshed, the builder reloaded) shows in the box.
  useEffect(() => {
    if (!editor || (html ?? '') === sent.current) return;
    sent.current = html ?? '';
    editor.commands.setContent(html ?? '', { emitUpdate: false });
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
