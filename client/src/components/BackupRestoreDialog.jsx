import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shortWhen = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const STATES = {
  deleted: ['Deleted since', 'is-bad'],
  trash: ['In the Trash', 'is-warn'],
  changed: ['Changed since', 'is-info'],
  same: ['Same as now', ''],
};

/**
 * Restore from a backup: pick a day (this Selah's restore points, or the off-site backup's snapshots), look through
 * its notebooks and notes, and bring back whole notebooks or single notes as copies. Nothing that's here now changes.
 * Closes with what was restored ({ notes, notebooks }) or nothing.
 */
export default function BackupRestoreDialog({ tree, close }) {
  const [sources, setSources] = useState(null);
  const [offsite, setOffsite] = useState(null); // { snapshots } | { error }
  const [source, setSource] = useState('');
  const [opened, setOpened] = useState(null); // { token, at, label, notebooks, total }
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const [notebook, setNotebook] = useState(null);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pickedNotes, setPickedNotes] = useState(new Map()); // id -> title
  const [pickedBooks, setPickedBooks] = useState(new Set());
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.restoreSources().then((s) => {
      setSources(s);
      if (s.local[0]) setSource(s.local[0].source);
      else if (s.files?.[0]) setSource(s.files[0].source);
      if (s.offsite) {
        api.restoreOffsiteList().then((r) => {
          setOffsite(r);
          if (!s.local[0] && r.snapshots[0]) setSource(r.snapshots[0].source);
        }).catch((e) => setOffsite({ error: e.message }));
      }
    }).catch((e) => setError(e.message));
  }, []);
  // Close the backup on the server when the dialog goes.
  useEffect(() => () => { if (opened) api.restoreClose(opened.token).catch(() => {}); }, [opened]);

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      const o = await api.restoreOpen(source);
      setOpened({ ...o, source });
      setNotebook(o.notebooks.find((b) => b.count > 0)?.id ?? null);
      setPickedNotes(new Map());
      setPickedBooks(new Set());
      setPreview(null);
    } catch (e) {
      setError(e.message);
    }
    setOpening(false);
  };

  // The notes shown: the chosen notebook's, or a search across them all.
  useEffect(() => {
    if (!opened || (!notebook && !query.trim())) { setNotes(null); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.restoreList(opened.token, query.trim() ? { q: query.trim() } : { notebook })
        .then((l) => live && setNotes(l)).catch((e) => live && setError(e.message));
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [opened, notebook, query]);

  const showNote = async (n) => {
    setPreview({ id: n.id, loading: true });
    try { setPreview(await api.restorePreview(opened.token, n.id)); } catch (e) { setPreview({ id: n.id, error: e.message }); }
  };
  const toggleNote = (n) => setPickedNotes((m) => {
    const next = new Map(m);
    if (next.has(n.id)) next.delete(n.id); else next.set(n.id, n.title);
    return next;
  });
  const toggleBook = (id) => setPickedBooks((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const bookOf = useMemo(() => new Map((opened?.notebooks ?? []).map((b) => [b.id, b])), [opened]);
  // Notes inside a notebook that's coming back whole aren't counted twice.
  const looseNotes = [...pickedNotes.keys()].filter((id) => {
    const n = notes?.find((x) => x.id === id);
    return !n || !pickedBooks.has(n.notebook_id);
  });
  const nothing = !looseNotes.length && !pickedBooks.size;

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.restoreRun(opened.token, {
        notes: looseNotes, notebooks: [...pickedBooks], ...(into && looseNotes.length && !pickedBooks.size ? { notebook_id: Number(into) } : {}),
      });
      setDone(r);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  const localList = sources?.local ?? [];
  const offList = offsite?.snapshots ?? [];
  const fileList = sources?.files ?? [];
  const what = [pickedBooks.size && plural(pickedBooks.size, 'notebook'), looseNotes.length && plural(looseNotes.length, 'note')].filter(Boolean).join(' and ');

  return (
    <div className="history-dialog restore-dialog">
      <div className="dialog-header">
        <h2>Restore from a backup</h2>
        <button className="icon-btn" onClick={() => close(done)} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>

      {done ? (
        <div className="restore-done">
          <Icon name="check" size={22} />
          <div>
            <p><strong>Restored {plural(done.notes, 'note')}</strong>{done.notebooks.length ? ` in ${plural(done.notebooks.length, 'new notebook')}` : ''}, as copies from {shortWhen(opened.at)}.</p>
            <p className="muted">
              {done.attachments ? `${plural(done.attachments, 'attachment')} came back with them. ` : ''}
              {done.missing ? `${plural(done.missing, 'attachment')} couldn’t be found in the backup. ` : ''}
              {done.notes > 0 && `A note whose title was already used where it landed is marked “(${opened.label})”.`}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="restore-source">
            <label className="field-label" htmlFor="rb-source">Backup</label>
            <select id="rb-source" className="input" value={source} onChange={(e) => setSource(e.target.value)} disabled={!sources || opening}>
              {!localList.length && !offList.length && !fileList.length && <option value="">{sources ? 'No backups yet' : 'Loading…'}</option>}
              {localList.length > 0 && (
                <optgroup label={`On this Selah (the last ${sources.keepDays} days)`}>
                  {localList.map((p) => <option key={p.source} value={p.source}>{when(p.at)}</option>)}
                </optgroup>
              )}
              {fileList.length > 0 && (
                <optgroup label="Backup files (automatic backups and conflict copies)">
                  {fileList.map((p) => <option key={p.source} value={p.source}>{p.label}: {when(p.at)}</option>)}
                </optgroup>
              )}
              {offList.length > 0 && (
                <optgroup label={`Off-site backup (${sources.offsite.service})`}>
                  {offList.map((p) => <option key={p.source} value={p.source}>{when(p.at)}</option>)}
                </optgroup>
              )}
            </select>
            <button type="button" className="btn btn-primary" disabled={!source || opening || opened?.source === source} onClick={open}>
              {opening ? (source.startsWith('offsite:') ? 'Downloading…' : 'Opening…') : opened?.source === source ? 'Opened' : 'Open'}
            </button>
          </div>
          {sources?.offsite && !offsite && <p className="muted restore-note">Checking the off-site backup…</p>}
          {offsite?.error && <p className="muted restore-note">The off-site backup couldn’t be read: {offsite.error}</p>}
          {sources && !localList.length && !sources.offsite && (
            <p className="muted restore-note">Selah keeps a copy of your notes each day for {sources.keepDays} days. The first one is made soon after the server starts; come back tomorrow for one from before today’s changes.</p>
          )}
          {error && <p className="form-error">{error}</p>}

          {opened && (
            <div className="restore-body">
              <div className="restore-books" aria-label="Notebooks in the backup">
                <div className="history-day">Notebooks on {shortWhen(opened.at)}</div>
                {opened.notebooks.map((b) => (
                  <div key={b.id} className={`restore-book ${notebook === b.id && !query ? 'is-active' : ''}`}>
                    <input type="checkbox" checked={pickedBooks.has(b.id)} onChange={() => toggleBook(b.id)}
                      aria-label={`Restore the whole notebook ${b.name}`} title="Restore the whole notebook" />
                    <button type="button" onClick={() => { setNotebook(b.id); setQuery(''); }}>
                      <span className="restore-book-name">{b.name}</span>
                      <span className="muted">{b.count}{b.here ? '' : ' · not here now'}</span>
                    </button>
                  </div>
                ))}
              </div>
              <div className="restore-notes">
                <div className="search-box">
                  <Icon name="search" size={15} className="muted" />
                  <input type="search" placeholder="Search the backup…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                {!notes ? <p className="muted">{notebook || query ? 'Loading…' : 'Choose a notebook.'}</p>
                  : !notes.length ? <p className="muted">{query ? 'No notes match.' : 'This notebook was empty.'}</p>
                    : notes.map((n) => {
                      const [stateLabel, stateClass] = STATES[n.state];
                      const whole = pickedBooks.has(n.notebook_id);
                      return (
                        <div key={n.id} className={`restore-note-row ${preview?.id === n.id ? 'is-active' : ''}`}>
                          <input type="checkbox" checked={whole || pickedNotes.has(n.id)} disabled={whole} onChange={() => toggleNote(n)}
                            aria-label={`Restore ${n.title || 'Untitled'}`} />
                          <button type="button" onClick={() => showNote(n)}>
                            <span className="restore-note-title">{n.title || 'Untitled'}</span>
                            <span className="restore-note-meta">
                              <span className={`restore-state ${stateClass}`}>{stateLabel}</span>
                              {query && bookOf.get(n.notebook_id) && <span className="muted">{bookOf.get(n.notebook_id).name}</span>}
                              {n.attachments > 0 && <span className="muted"><Icon name="paperclip" size={11} />{n.attachments}</span>}
                            </span>
                          </button>
                        </div>
                      );
                    })}
              </div>
              <div className="restore-preview">
                {!preview ? <p className="muted">Click a note to read it as it was.</p>
                  : preview.loading ? <p className="muted">Loading…</p>
                    : preview.error ? <p className="form-error">{preview.error}</p> : (
                      <>
                        <div className="restore-preview-title">{preview.title || 'Untitled'}</div>
                        <p className="muted restore-preview-meta">
                          Last changed {when(preview.updated_at)} · {STATES[preview.state][0].toLowerCase()}
                          {preview.tags.length > 0 && <> · {preview.tags.map((t) => `#${t}`).join(' ')}</>}
                        </p>
                        {preview.attachments.length > 0 && (
                          <ul className="restore-files">
                            {preview.attachments.map((a, i) => <li key={i}><Icon name="paperclip" size={12} /> {a.filename} <span className="muted">{size(a.size)}</span></li>)}
                          </ul>
                        )}
                        <div className="history-diff restore-text">{preview.text || <span className="muted">No text.</span>}</div>
                      </>
                    )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="modal-actions spread">
        <span className="muted restore-summary">
          {!done && opened && (nothing ? 'Tick notebooks or notes to restore. They come back as copies; nothing here now changes.'
            : `${what} from ${shortWhen(opened.at)}`)}
        </span>
        <span className="modal-actions-group">
          <button className="btn" onClick={() => close(done)}>{done ? 'Done' : 'Cancel'}</button>
          {!done && opened && (
            <button className="btn btn-primary" disabled={nothing || busy} onClick={restore}>
              <Icon name="restore" size={15} /> {busy ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
