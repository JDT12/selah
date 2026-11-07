import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { openNoteEvent } from '../editor/NoteLinks.jsx';

function Context({ c }) {
  if (!c) return null;
  return <span className="conn-context">{c.before}<mark>{c.match}</mark>{c.after}</span>;
}

/**
 * The foot of a note: other notes that link to it, notes that mention its title without a link (one click links
 * them), and notes about the same Scripture. Reloads when the note's title is saved (`title`).
 */
export default function NoteConnections({ noteId, title }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false); // every note opens with them folded away
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => api.noteConnections(noteId).then(setData).catch(() => setData(null)), [noteId]);
  // At once when the note opens; after a title change, once it has been saved.
  const first = useRef(true);
  useEffect(() => {
    const t = setTimeout(load, first.current ? 0 : 1500);
    first.current = false;
    return () => clearTimeout(t);
  }, [load, title]);

  if (!data) return null;
  const { linked, unlinked, scripture } = data;
  const total = linked.length + unlinked.length + scripture.length;

  const link = async (n) => {
    setBusy(n.id);
    try {
      await api.linkMention(noteId, n.id);
      dialog.toast(`Linked from “${n.title || 'Untitled'}”`);
      await load();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    setBusy(null);
  };

  const row = (n, extra) => (
    <li key={n.id} className="conn-item">
      <button type="button" className="conn-open" onClick={() => openNoteEvent(n.id)}>
        <span className="conn-title"><Icon name="note" size={14} /> {n.title || 'Untitled'}
          {n.notebook && <span className="conn-notebook">{n.notebook}</span>}</span>
        {n.context && <Context c={n.context} />}
        {n.refs && <span className="conn-refs">{n.refs.slice(0, 6).map((r) => <span key={r} className="conn-ref">{r}</span>)}</span>}
      </button>
      {extra}
    </li>
  );

  return (
    <section className="connections" aria-label="Connected notes">
      <button type="button" className="connections-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <Icon name="link" size={14} />
        <span>{total ? `${total} connected note${total === 1 ? '' : 's'}` : 'No connected notes yet'}</span>
      </button>
      {open && (
        <div className="connections-body">
          {!total && (
            <p className="conn-hint">
              Type <kbd>[[</kbd> in any note to link it here.
              {!data.intentional && <> Notes that mention “{title || 'this title'}” or the same Scripture will show up too.</>}
            </p>
          )}
          {linked.length > 0 && (
            <div className="conn-group">
              <h4>Linked from <span className="conn-count">{linked.length}</span></h4>
              <ul>{linked.map((n) => row(n))}</ul>
            </div>
          )}
          {unlinked.length > 0 && (
            <div className="conn-group">
              <h4>Mentions without a link <span className="conn-count">{unlinked.length}</span></h4>
              <ul>{unlinked.map((n) => row(n, (
                <button className="btn btn-small conn-link-btn" disabled={busy === n.id} onClick={() => link(n)}
                  title="Turn this mention into a link to this note">
                  <Icon name="link" size={13} /> Link
                </button>
              )))}</ul>
            </div>
          )}
          {scripture.length > 0 && (
            <div className="conn-group">
              <h4>Same Scripture <span className="conn-count">{scripture.length}</span>
                {data.refs.length > 0 && <span className="conn-of"> · {data.refs.slice(0, 4).join(', ')}{data.refs.length > 4 ? '…' : ''}</span>}</h4>
              <ul>{scripture.map((n) => row(n))}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
