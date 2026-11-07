import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import SourcesPanel from './SourcesPanel.jsx';
import RevisePanel from './RevisePanel.jsx';
import CommentThreads from './CommentThreads.jsx';
import { biblePassage, passageCardHtml, passageNoteHtml } from '../esv.js';
import { Credit, TranslationPicker, useBible } from './TranslationPicker.jsx';
import { findReferences } from '../../../shared/scripture.js';

/**
 * Beside the open note (7.0): one panel with tabs instead of a panel each. Outline (the note's headings), Passage
 * (the Bible text of the passages the note names), Sources (a writing project's reading notes and citations),
 * Revise, and Comments on a shared note (8.0). `tab` is which one shows; closing it closes the panel.
 */
export default function SidePanel({ tab, onTab, onClose, editor, note, title, method, writingStudy, flush, readOnly, onOpenScripture, comments }) {
  const open = comments?.threads.filter((t) => !t.resolvedAt).length ?? 0;
  const tabs = [['outline', 'Outline'], ['passage', 'Passage'], ...(writingStudy ? [['sources', 'Sources']] : []), ['revise', 'Revise'],
    ...(comments ? [['comments', open ? `Comments ${open}` : 'Comments']] : [])];
  const shown = tabs.some(([k]) => k === tab) ? tab : 'outline';
  return (
    <aside className="side-panel" aria-label="Side panel">
      <div className="side-panel-head">
        <div className="side-panel-tabs" role="tablist" aria-label="Side panel">
          {tabs.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={shown === k} className={shown === k ? 'is-active' : ''} onClick={() => onTab(k)}>{l}</button>
          ))}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the side panel" title="Close"><Icon name="x" size={15} /></button>
      </div>
      {shown === 'outline' && <Outline editor={editor} />}
      {shown === 'passage' && <Passage editor={editor} title={title} readOnly={readOnly} onOpenScripture={onOpenScripture} />}
      {shown === 'sources' && writingStudy && <SourcesPanel study={writingStudy} noteId={note.id} editor={editor} readOnly={readOnly} onClose={onClose} />}
      {shown === 'comments' && comments && (
        <div className="side-panel-body">
          <CommentThreads threads={comments.threads} side="out" editor={editor} current={comments.current} setCurrent={comments.setCurrent} onChanged={comments.reload} />
        </div>
      )}
      {shown === 'revise' && <RevisePanel editor={editor} noteId={note.id} method={method} flush={flush} readOnly={readOnly} onClose={onClose} />}
    </aside>
  );
}

/** Follows the note as it changes (redrawn at most once a frame). */
function useDocTick(editor) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return undefined;
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick((t) => t + 1)); };
    editor.on('update', on);
    return () => { editor.off('update', on); cancelAnimationFrame(raf); };
  }, [editor]);
}

/** The note's headings; click one to go there. */
function Outline({ editor }) {
  useDocTick(editor);
  const heads = [];
  editor?.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') heads.push({ pos, level: node.attrs.level, text: node.textContent.trim() });
    return node.type.name !== 'heading';
  });
  const go = (h) => {
    editor.chain().focus().setTextSelection(h.pos + 1).run();
    requestAnimationFrame(() => editor.view.nodeDOM(h.pos)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };
  const top = Math.min(...heads.map((h) => h.level), 6);
  return (
    <div className="side-panel-body">
      {heads.length ? (
        <ol className="outline-list">
          {heads.map((h) => (
            <li key={h.pos} style={{ paddingLeft: `${(h.level - top) * 14}px` }}>
              <button type="button" className={`outline-item is-h${h.level}`} onClick={() => go(h)}>{h.text || 'Untitled heading'}</button>
            </li>
          ))}
        </ol>
      ) : <p className="muted side-panel-hint">Headings in the note show here, so you can jump between its parts.</p>}
    </div>
  );
}

/** The passages the note names (its title first), with the Bible text of the one picked (in the pane's translation). */
function Passage({ editor, title, readOnly, onOpenScripture }) {
  useDocTick(editor);
  const text = `${title ?? ''}\n${editor ? editor.state.doc.textBetween(0, Math.min(editor.state.doc.content.size, 6000), '\n') : ''}`;
  const refs = useMemo(() => [...new Set(findReferences(text).map((r) => r.text))].slice(0, 8), [text]);
  const [pick, setPick] = useState(null);
  const [typed, setTyped] = useState('');
  const bible = useBible('side');
  const { connected, tr } = bible;
  const [state, setState] = useState({ q: null, data: null, error: null });
  const q = pick ?? refs[0] ?? null;
  useEffect(() => {
    if (!q || !connected) return;
    let live = true;
    setState({ q, data: null, error: null });
    biblePassage(q, tr).then((data) => live && setState({ q, data, error: null })).catch((e) => live && setState({ q, data: null, error: e.message }));
    return () => { live = false; };
  }, [q, connected, tr]);
  const insert = () => {
    if (state.data) editor.chain().focus().insertContent(passageNoteHtml(state.data)).run();
  };
  return (
    <div className="side-panel-body">
      <form className="passage-look" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setPick(typed.trim()); }}>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Look up a passage" aria-label="Look up a passage" />
      </form>
      {refs.length > 0 && (
        <div className="passage-refs">
          {refs.map((r) => <button key={r} type="button" className={`passage-ref ${q === r ? 'is-active' : ''}`} onClick={() => setPick(r)}>{r}</button>)}
        </div>
      )}
      {!q && <p className="muted side-panel-hint">No passage in this note yet. Name one in the title or text, or look one up above.</p>}
      {q && connected === false && <p className="muted side-panel-hint">Connect a Bible in Settings → Connections → Bible to read {q} here.</p>}
      {q && connected && (
        <div className="passage-text">
          <div className="passage-text-head"><h3>{state.data?.reference ?? q}</h3><TranslationPicker bible={bible} /></div>
          {state.error ? <p className="muted">{state.error}</p>
            : !state.data ? <p className="muted">Loading…</p>
            : <div className="esv-card-body" dangerouslySetInnerHTML={{ __html: passageCardHtml(state.data.text) }} />}
          <Credit passage={state.data} />
          <div className="passage-actions">
            {!readOnly && state.data && <button type="button" className="btn btn-small" onClick={insert}>Insert as a quotation</button>}
            {onOpenScripture && <button type="button" className="btn btn-small" onClick={() => onOpenScripture(q)}>Open in Scripture</button>}
          </div>
        </div>
      )}
    </div>
  );
}
