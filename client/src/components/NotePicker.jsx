import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

/** Pick a note to link (searchable). value: note id or null. */
export default function NotePicker({ value, onChange, onOpen }) {
  const [title, setTitle] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!value) { setTitle(null); return; }
    api.getNote(value).then((n) => setTitle(n.title || 'Untitled')).catch(() => setTitle('(missing note)'));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api.listNotes({ q: query }).then((r) => setResults(r.slice(0, 8))).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  if (value) {
    return (
      <div className="note-picker-link">
        <Icon name="note" size={15} />
        <button type="button" className="link-btn" onClick={() => onOpen?.(value)} title="Open note">{title ?? '…'}</button>
        <button type="button" className="icon-btn" onClick={() => onChange(null)} aria-label="Unlink note"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  return (
    <div className="note-picker" ref={ref}>
      <input className="input" placeholder="Search notes to link…" value={query}
        onFocus={() => setOpen(true)} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} />
      {open && results.length > 0 && (
        <div className="note-picker-list">
          {results.map((n) => (
            <button type="button" key={n.id} onClick={() => { onChange(n.id); setOpen(false); setQuery(''); }}>
              <strong>{n.title || 'Untitled'}</strong>
              <span>{n.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
