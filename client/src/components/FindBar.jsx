import { useEffect, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { findKey, findMatches } from '../editor/FindInNote.js';
import Icon from './Icon.jsx';

/**
 * Find in note (Ctrl+F): matches are highlighted as you type, Enter and Shift+Enter step through them, Esc closes and
 * leaves the cursor on the match. A match in a collapsed section opens it. `seed` (the selected text when it opened)
 * fills the box.
 */
export default function FindBar({ editor, seed, n, onClose }) {
  const input = useRef(null);
  const [query, setQuery] = useState(seed ?? '');
  const [state, setState] = useState({ matches: [], current: 0 });

  useEffect(() => {
    if (seed) setQuery(seed);
    input.current?.focus();
    input.current?.select();
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the count current as the note changes, and clear the highlights on close.
  useEffect(() => {
    const sync = () => {
      const s = findKey.getState(editor.state);
      if (s) setState({ matches: s.matches, current: s.current });
    };
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: '', current: 0 }));
    };
  }, [editor]);

  /** Highlights match i and scrolls to it; a cursor at its start opens a collapsed section it's in. */
  const go = (q, i) => {
    const matches = findMatches(editor.state.doc, q);
    const current = matches.length ? ((i % matches.length) + matches.length) % matches.length : 0;
    const tr = editor.state.tr.setMeta(findKey, { query: q, current });
    if (matches.length) tr.setSelection(TextSelection.near(editor.state.doc.resolve(matches[current].from)));
    editor.view.dispatch(tr);
    requestAnimationFrame(() => editor.view.dom.querySelector('.find-hit.is-current')?.scrollIntoView({ block: 'center' }));
  };

  // Typing starts from the first match at or after the cursor.
  useEffect(() => {
    const from = editor.state.selection.from;
    const at = findMatches(editor.state.doc, query).findIndex((m) => m.to >= from);
    go(query, Math.max(at, 0));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (d) => state.matches.length && go(query, state.current + d);
  const close = () => {
    const m = state.matches[state.current];
    if (m) editor.chain().setTextSelection(m).focus().run();
    else editor.commands.focus();
    onClose();
  };

  const count = !query ? '' : state.matches.length ? `${state.current + 1} of ${state.matches.length}` : 'No matches';
  return (
    <div className="find-wrap">
      <div className="find-bar" role="search">
        <Icon name="search" size={14} />
        <input ref={input} value={query} placeholder="Find in note" aria-label="Find in note" spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); input.current.select(); }
          }} />
        <span className={`find-count ${query && !state.matches.length ? 'is-none' : ''}`} aria-live="polite">{count}</span>
        <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={!state.matches.length} aria-label="Previous match" title="Previous (Shift+Enter)">
          <Icon name="chevron-up" size={15} />
        </button>
        <button type="button" className="icon-btn" onClick={() => step(1)} disabled={!state.matches.length} aria-label="Next match" title="Next (Enter)">
          <Icon name="chevron-down" size={15} />
        </button>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close find" title="Close (Esc)"><Icon name="x" size={15} /></button>
      </div>
    </div>
  );
}
