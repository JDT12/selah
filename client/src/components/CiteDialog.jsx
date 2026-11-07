import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { cacheSources, cachedSource, rememberSources } from '../citations/index.js';
import { LOCATOR_LABELS } from '../citations/styles.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { ZoteroConnectDialog } from './ZoteroDialogs.jsx';

/** "Wright, Paul and the Faithfulness of God (2013)" from CSL-JSON. */
export function describeSource(csl) {
  if (!csl) return { title: 'Source not found', who: '', year: '' };
  const people = csl.author ?? csl.editor ?? [];
  const who = people.length ? `${people[0].family ?? people[0].literal ?? ''}${people.length > 2 ? ' et al.' : people.length === 2 ? ` and ${people[1].family ?? people[1].literal ?? ''}` : ''}` : '';
  const year = csl.issued?.['date-parts']?.[0]?.[0] ?? (csl.issued?.raw ?? '').slice(0, 4);
  return { title: csl.title || '(untitled)', who, year: year ? String(year) : '' };
}

/** The short text stored with a citation for search: "Wright 2013, 42; Moo 1996". */
export function citationLabel(items) {
  return items.map((i) => {
    const d = describeSource(cachedSource(i.id));
    return [`${d.who.split(' ')[0] || d.title.split(' ').slice(0, 3).join(' ')}${d.year ? ` ${d.year}` : ''}`, i.locator].filter(Boolean).join(', ');
  }).join('; ');
}

/**
 * Insert or edit a citation (one or more sources, each with an optional page etc.) or a plain footnote.
 * `value` is an existing citation's attrs. Resolves to new attrs, { remove: true }, or null.
 */
export default function CiteDialog({ value, initialTab = 'source', close }) {
  const editing = !!value;
  const [tab, setTab] = useState(value ? (value.items?.length ? 'source' : 'note') : initialTab);
  // Saved citations keep only the fields that were filled in.
  const [items, setItems] = useState(() => (value?.items ?? []).map((i) => ({
    id: i.id, locator: i.locator ?? '', label: i.label ?? 'page', prefix: i.prefix ?? '', suffix: i.suffix ?? '',
  })));
  const [note, setNote] = useState(value?.note ?? '');
  const [zotero, setZotero] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [recent, setRecent] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);
  const dialog = useDialog();

  const loadStatus = () => api.zotero().then(setZotero).catch(() => setZotero({ connected: false }));
  useEffect(() => {
    loadStatus();
    api.recentSources().then((list) => { cacheSources(list); setRecent(list); }).catch(() => {});
  }, []);

  // Search as you type (after a pause).
  useEffect(() => {
    const term = q.trim();
    if (!term || !zotero?.connected) { setResults(null); return undefined; }
    const t = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try { setResults(await api.zoteroSearch(term)); } catch (e) { setError(e.message); }
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [q, zotero?.connected]);

  const add = async (source) => {
    await rememberSources([source]).catch(() => {});
    setItems((list) => (list.some((i) => i.id === source.id) ? list : [...list, { id: source.id, locator: '', label: 'page', prefix: '', suffix: '' }]));
    setQ('');
    setResults(null);
  };
  const change = (i, patch) => setItems((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeItem = (i) => setItems((list) => list.filter((_, j) => j !== i));

  const connect = async () => {
    await dialog.open((c) => <ZoteroConnectDialog close={c} />);
    loadStatus();
  };

  const submit = (e) => {
    e.preventDefault();
    if (tab === 'source') {
      if (!items.length) return;
      const clean = items.map(({ id, locator, label, prefix, suffix }) => ({
        id, ...(locator.trim() ? { locator: locator.trim(), label } : {}), ...(prefix.trim() ? { prefix: prefix.trim() } : {}), ...(suffix.trim() ? { suffix: suffix.trim() } : {}),
      }));
      close({ items: clean, note: '', noteHtml: '', label: citationLabel(clean) });
    } else {
      if (!note.trim()) return;
      // Formatting from a paste is kept unless the text was changed here.
      close({ items: [], note: note.trim(), noteHtml: note === value?.note ? (value?.noteHtml ?? '') : '', label: '*' });
    }
  };

  const list = q.trim() ? results : recent.map((csl) => ({ id: csl.id, csl, ...describeSource(csl), creator: describeSource(csl).who, library: 'Recently cited' }));

  return (
    <form className="cite-dialog" onSubmit={submit}>
      <div className="cite-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'is-active' : ''} onClick={() => setTab('source')}>
          <Icon name="notebook" size={15} /> Cite a source
        </button>
        <button type="button" role="tab" aria-selected={tab === 'note'} className={tab === 'note' ? 'is-active' : ''} onClick={() => setTab('note')}>
          <Icon name="text" size={15} /> Footnote
        </button>
      </div>

      {tab === 'source' && (
        <>
          {items.length > 0 && (
            <div className="cite-items">
              {items.map((it, i) => {
                const d = describeSource(cachedSource(it.id));
                return (
                  <div key={it.id} className="cite-item">
                    <div className="cite-item-head">
                      <span className="cite-item-title"><strong>{d.who}</strong>{d.who && ', '}<em>{d.title}</em>{d.year && ` (${d.year})`}</span>
                      <button type="button" className="icon-btn" onClick={() => removeItem(i)} aria-label={`Remove ${d.title}`}><Icon name="x" size={14} /></button>
                    </div>
                    <div className="cite-item-fields">
                      <select className="input input-inline" value={it.label} onChange={(e) => change(i, { label: e.target.value })} aria-label="Locator type">
                        {LOCATOR_LABELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                      <input className="input cite-locator" value={it.locator} onChange={(e) => change(i, { locator: e.target.value })}
                        placeholder="e.g. 42 or 42–45" aria-label="Page or other locator" autoFocus={i === items.length - 1} />
                      <input className="input" value={it.prefix} onChange={(e) => change(i, { prefix: e.target.value })} placeholder="Before (e.g. See)" aria-label="Text before" />
                      <input className="input" value={it.suffix} onChange={(e) => change(i, { suffix: e.target.value })} placeholder="After (e.g. emphasis added)" aria-label="Text after" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {zotero && !zotero.connected && (
            <p className="modal-message">
              Connect Zotero to search your library.{recent.length > 0 && ' Sources you’ve cited before are listed below.'}{' '}
              <button type="button" className="link-btn" onClick={connect}>Connect Zotero…</button>
            </p>
          )}
          {zotero?.connected && (
            <div className="search-box">
              <Icon name="search" size={15} className="muted" />
              <input ref={searchRef} type="search" autoFocus={!items.length} placeholder={items.length ? 'Add another source…' : 'Search Zotero: title, author or year…'}
                value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) e.preventDefault(); }} />
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="cite-results">
            {searching && <p className="muted">Searching…</p>}
            {!searching && q.trim() && results?.length === 0 && <p className="muted">Nothing in Zotero matches “{q.trim()}”.</p>}
            {!searching && list?.length > 0 && !q.trim() && <p className="cite-results-label">Recently cited</p>}
            {!searching && list?.map((r) => (
              <button type="button" key={r.id} className="cite-result" onClick={() => add(r.csl)}
                disabled={items.some((i) => i.id === r.id)}>
                <span className="cite-result-title">{r.title}</span>
                <span className="cite-result-meta">{[r.creator, r.year, q.trim() ? r.library : null].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {tab === 'note' && (
        <>
          <p className="modal-message">A numbered footnote with your own text (no source).</p>
          <textarea className="input cite-note" rows={4} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Footnote text" />
        </>
      )}

      <div className="modal-actions">
        {editing && <button type="button" className="btn btn-danger-text cite-remove" onClick={() => close({ remove: true })}>Remove</button>}
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={tab === 'source' ? !items.length : !note.trim()}>
          {editing ? 'Save' : 'Insert'}
        </button>
      </div>
    </form>
  );
}
