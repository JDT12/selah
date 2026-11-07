import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Merge notes into one: put them in order (drag, or the arrows), name it, choose how each note starts and where the
 * merged note goes. The originals go to the Trash unless kept. Resolves with the new note's id.
 */
export function MergeDialog({ notes: initial, tree, close }) {
  const [notes, setNotes] = useState(initial);
  const [title, setTitle] = useState(initial[0]?.title || '');
  const [notebook, setNotebook] = useState(initial[0]?.notebook_id ?? tree.notebooks[0]?.id);
  const [join, setJoin] = useState('title');
  const [keep, setKeep] = useState(false);
  const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const move = (from, to) => {
    if (to < 0 || to >= notes.length || from === to) return;
    const next = [...notes];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setNotes(next);
  };
  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.mergeNotes({ ids: notes.map((n) => n.id), title: title.trim(), notebook_id: notebook, join, keep });
      close(id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="notetool-dialog" onSubmit={run}>
      <div className="dialog-header">
        <h2>Merge {plural(notes.length, 'note')}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">In this order (drag to change it):</p>
      <ol className="merge-list">
        {notes.map((n, i) => (
          <li key={n.id} draggable className={drag === i ? 'is-dragging' : ''}
            onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }}
            onDragEnd={() => setDrag(null)}>
            <span className="merge-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
            <span className="merge-n">{i + 1}</span>
            <span className="merge-title">{n.title || 'Untitled'}</span>
            <button type="button" className="icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${n.title || 'Untitled'} up`}><Icon name="chevronUp" size={14} /></button>
            <button type="button" className="icon-btn" onClick={() => move(i, i + 1)} disabled={i === notes.length - 1} aria-label={`Move ${n.title || 'Untitled'} down`}><Icon name="chevronDown" size={14} /></button>
          </li>
        ))}
      </ol>
      <label className="field">Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" /></label>
      <div className="field">
        <span>Each note starts with</span>
        <div className="segmented" role="radiogroup" aria-label="Each note starts with">
          {[['title', 'Its title as a heading'], ['divider', 'A divider']].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={join === k} className={join === k ? 'is-active' : ''} onClick={() => setJoin(k)}>{l}</button>
          ))}
        </div>
      </div>
      <label className="check-row"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span><strong>Keep the original notes</strong><span className="muted">Otherwise they go to the Trash, and links to them point at the merged note.</span></span></label>
      <p className="muted notetool-hint">Tags and attachments come along.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Merging…' : 'Merge'}</button>
      </div>
    </form>
  );
}

const SPLIT_AT = [['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['hr', 'Dividers']];

/**
 * Split a note into notes at its headings or dividers, with a preview. Text before the first split point keeps the
 * note's title. Resolves with { ids, contentsId, notebookId }.
 */
export function SplitDialog({ note, tree, close }) {
  const [at, setAt] = useState(() => (/<h1[\s>]/.test(note.html) ? 'h1' : /<h2[\s>]/.test(note.html) ? 'h2' : /<hr/.test(note.html) ? 'hr' : 'h1'));
  const [parts, setParts] = useState(null);
  const [notebook, setNotebook] = useState('same');
  const [contents, setContents] = useState(true);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setParts(null);
    api.splitNote(note.id, { at, preview: true }).then((r) => live && setParts(r.parts)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [note.id, at]);

  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      close(await api.splitNote(note.id, { at, notebook: notebook === 'same' ? null : notebook, contents, keep }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const enough = parts && parts.length > 1;

  return (
    <form className="notetool-dialog" onSubmit={run}>
      <div className="dialog-header">
        <h2>Split “{note.title || 'Untitled'}”</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="field">
        <span>Start a new note at each</span>
        <div className="segmented" role="radiogroup" aria-label="Split at">
          {SPLIT_AT.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={at === k} className={at === k ? 'is-active' : ''} onClick={() => setAt(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="split-preview" aria-live="polite">
        {!parts ? <p className="muted">Looking…</p> : !enough ? (
          <p className="muted">{SPLIT_AT.find(([k]) => k === at)[1]}s don’t divide this note. Try another.</p>
        ) : (
          <>
            <p className="muted">{plural(parts.length, 'note')}:</p>
            <ol>{parts.map((p, i) => <li key={i}><span>{p.title}</span><span className="muted">{plural(p.words, 'word')}</span></li>)}</ol>
          </>
        )}
      </div>
      <label className="check-row"><input type="checkbox" checked={notebook === 'new'} onChange={(e) => setNotebook(e.target.checked ? 'new' : 'same')} />
        <span><strong>Tag them “{note.title || 'Untitled'}”</strong><span className="muted">So the parts stay together in My notes. They keep this note’s tags either way.</span></span></label>
      <label className="check-row"><input type="checkbox" checked={contents} onChange={(e) => setContents(e.target.checked)} />
        <span><strong>Add a contents note</strong><span className="muted">Named “{note.title || 'Untitled'}”, linking to each new note in order.</span></span></label>
      <label className="check-row"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span><strong>Keep the original note</strong><span className="muted">Otherwise it goes to the Trash, and links to it point at {contents ? 'the contents note' : 'the first new note'}.</span></span></label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !enough}>{busy ? 'Splitting…' : enough ? `Split into ${parts.length}` : 'Split'}</button>
      </div>
    </form>
  );
}
