import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';

const longDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Whether a builder's note is marked complete (server/methods.js): [completedAt | null, toggle, loaded]. The flag is
 * saved at once, apart from the builder's own Save.
 */
export function useComplete(noteId, onError) {
  const [at, setAt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    api.noteComplete(noteId).then((r) => { if (live) { setAt(r.completed_at); setLoaded(true); } }).catch(() => live && setLoaded(true));
    return () => { live = false; };
  }, [noteId]);
  const toggle = useCallback(async () => {
    try {
      const r = await api.setNoteComplete(noteId, !at);
      setAt(r.completed_at);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
    } catch (e) {
      onError?.(e);
    }
  }, [noteId, at, onError]);
  return [at, toggle, loaded];
}

/** The last page's "Mark complete" box: what's still open, then the button (or when it was completed, with Undo). */
export default function MarkComplete({ at, onToggle, what, open = 0 }) {
  if (at) {
    return (
      <div className="mark-complete is-complete">
        <Icon name="checkCircle" size={20} />
        <span className="mark-complete-text"><strong>{what} complete</strong><span className="muted">Marked {longDay(at)}</span></span>
        <button type="button" className="btn btn-small" onClick={onToggle}>Mark not complete</button>
      </div>
    );
  }
  return (
    <div className="mark-complete">
      <Icon name="flag" size={18} />
      <span className="mark-complete-text"><strong>Finished?</strong>
        <span className="muted">{open ? `${open} step${open === 1 ? '' : 's'} still open. You can mark it complete anyway.` : 'Every step has something written.'}</span>
      </span>
      <button type="button" className="btn btn-primary btn-small" onClick={onToggle}><Icon name="check" size={14} /> Mark complete</button>
    </div>
  );
}
