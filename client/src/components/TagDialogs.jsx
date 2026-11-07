import { useEffect, useId, useMemo, useState } from 'react';
import { api, formatDate } from '../api.js';
import { TAG_COLORS } from '../tagColors.js';
import Icon from './Icon.jsx';

/** Pick a color for one or more tags. Resolves to a color key, '' for no color, or null when cancelled. */
export function TagColorDialog({ title, value, close }) {
  return (
    <div className="tag-color-dialog">
      <h2>{title}</h2>
      <div className="swatches" role="radiogroup" aria-label="Color">
        {Object.entries(TAG_COLORS).map(([key, hex]) => (
          <button key={key} type="button" role="radio" aria-checked={value === key} aria-label={key} title={key}
            className={`swatch ${value === key ? 'is-active' : ''}`} style={{ '--swatch': hex }} onClick={() => close(key)} />
        ))}
        <button type="button" role="radio" aria-checked={!value} className={`swatch swatch-none ${!value ? 'is-active' : ''}`}
          aria-label="No color" title="No color" onClick={() => close('')}><Icon name="x" size={14} /></button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Tick the notes that should have a tag; saving adds and removes it. `tag` is an existing tag ({ id, name })
 * or a new name ({ name }). Resolves to { added, removed } or null.
 */
export function TagNotesDialog({ tag, close }) {
  const [notes, setNotes] = useState(null);
  const [had, setHad] = useState(new Set());
  const [checked, setChecked] = useState(new Set());
  const [q, setQ] = useState('');
  const [onlyTagged, setOnlyTagged] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.listNotes({ sort: 'updated' }),
      tag.id ? api.listNotes({ tag: tag.id }) : Promise.resolve([]),
    ]).then(([all, tagged]) => {
      const ids = new Set(tagged.map((n) => n.id));
      setNotes(all);
      setHad(ids);
      setChecked(new Set(ids));
    }).catch((e) => setError(e.message));
  }, [tag.id]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (notes ?? []).filter((n) => (!onlyTagged || checked.has(n.id))
      && words.every((w) => `${n.title} ${n.snippet}`.toLowerCase().includes(w)));
  }, [notes, q, onlyTagged, checked]);

  const toggle = (id) => setChecked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const setShown = (on) => setChecked((s) => {
    const next = new Set(s);
    for (const n of shown) { if (on) next.add(n.id); else next.delete(n.id); }
    return next;
  });

  const add = [...checked].filter((id) => !had.has(id));
  const remove = [...had].filter((id) => !checked.has(id));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.applyTag({ ...(tag.id ? { tag_id: tag.id } : { name: tag.name }), add, remove });
      close({ added: add.length, removed: remove.length });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="tag-notes-dialog" onSubmit={save}>
      <h2>Tag notes with <span className="tag-name">#{tag.name}</span></h2>
      <p className="modal-message">Tick the notes that should have this tag. {checked.size} note{checked.size === 1 ? '' : 's'} ticked.</p>
      <div className="tag-notes-tools">
        <div className="search-box">
          <Icon name="search" size={15} className="muted" />
          <input type="search" autoFocus placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="tag-notes-only"><input type="checkbox" checked={onlyTagged} onChange={(e) => setOnlyTagged(e.target.checked)} /> Ticked only</label>
      </div>
      <div className="tag-notes-bulk">
        <button type="button" className="link-btn" onClick={() => setShown(true)} disabled={!shown.length}>Tick all shown</button>
        <button type="button" className="link-btn" onClick={() => setShown(false)} disabled={!shown.length}>Untick all shown</button>
      </div>
      <div className="tag-notes-list">
        {!notes && !error && <p className="muted">Loading notes…</p>}
        {notes && shown.length === 0 && <p className="muted">No matching notes.</p>}
        {shown.slice(0, 300).map((n) => (
          <label key={n.id} className={`tag-note ${checked.has(n.id) ? 'is-checked' : ''}`}>
            <input type="checkbox" checked={checked.has(n.id)} onChange={() => toggle(n.id)} />
            <span className="tag-note-title">{n.title || 'Untitled'}</span>
            <span className="tag-note-date">{formatDate(n.updated_at)}</span>
          </label>
        ))}
        {shown.length > 300 && <p className="muted">Showing 300 of {shown.length}. Search to narrow the list.</p>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <span className="muted tag-notes-summary">
          {add.length || remove.length ? `Adds to ${add.length}, removes from ${remove.length}` : 'No changes'}
        </span>
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || (!add.length && !remove.length)}>Save</button>
      </div>
    </form>
  );
}

/** 10.1: tag an Inbox note to file it in My notes. Resolves to the tag's name or null. */
export function TagToFileDialog({ title, tags, close }) {
  const [name, setName] = useState('');
  const listId = useId();
  const submit = (e) => {
    e?.preventDefault();
    if (name.trim()) close(name.trim());
  };
  return (
    <form onSubmit={submit}>
      <h2>Tag “{title || 'Untitled'}”</h2>
      <p className="muted">A tagged note moves from the Inbox to My notes.</p>
      <label className="field-label" htmlFor={`${listId}-in`}>Tag</label>
      <input id={`${listId}-in`} className="input" autoFocus list={listId} value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Type or pick a tag" />
      <datalist id={listId}>{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Tag and file</button>
      </div>
    </form>
  );
}

/** Add a tag to, or remove one from, several notes. Resolves to { name, remove } or null. */
export function BulkTagDialog({ count, tags, close }) {
  const [name, setName] = useState('');
  const listId = useId();
  const submit = (remove) => (e) => {
    e?.preventDefault();
    if (name.trim()) close({ name: name.trim(), remove });
  };
  const known = tags.some((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  return (
    <form onSubmit={submit(false)}>
      <h2>Tag {count} notes</h2>
      <label className="field-label" htmlFor={`${listId}-in`}>Tag</label>
      <input id={`${listId}-in`} className="input" autoFocus list={listId} value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Type or pick a tag" />
      <datalist id={listId}>{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="button" className="btn btn-danger-text" disabled={!known} onClick={submit(true)}>Remove from {count}</button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Add to {count}</button>
      </div>
    </form>
  );
}
