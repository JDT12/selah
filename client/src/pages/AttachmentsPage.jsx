import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, formatDate, formatSize, pdfViewerUrl } from '../api.js';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import NotePicker from '../components/NotePicker.jsx';
import { notebookOptions } from '../components/NoteEditor.jsx';
import { useStoredState } from '../useStoredState.js';

const KINDS = [
  ['', 'All'], ['image', 'Images'], ['pdf', 'PDFs'], ['document', 'Documents'], ['audio', 'Audio'], ['video', 'Video'], ['other', 'Other'],
];
const KIND_ICON = { image: 'image', pdf: 'pdf', document: 'file', audio: 'mic', video: 'camera', other: 'paperclip' };
const KIND_NAME = { image: 'Images', pdf: 'PDFs', document: 'Documents', audio: 'Audio', video: 'Video', other: 'Other' };
const SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['largest', 'Largest'], ['smallest', 'Smallest'], ['name', 'Name'], ['note', 'Note']];
const PAGE = 120;
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function Thumb({ a, big = false }) {
  const [failed, setFailed] = useState(false);
  if (a.thumb && !failed) {
    return (
      <span className={`att-thumb ${big ? 'is-big' : ''}`}>
        <img src={`/api/attachments/${a.id}/thumb`} alt="" loading="lazy" onError={() => setFailed(true)} />
        {a.kind === 'video' && <span className="att-play"><Icon name="play" size={14} /></span>}
      </span>
    );
  }
  return (
    <span className={`att-thumb is-icon kind-${a.kind} ${big ? 'is-big' : ''}`}>
      <Icon name={KIND_ICON[a.kind]} size={big ? 40 : 28} />
      <small>{a.filename.includes('.') ? a.filename.split('.').pop().slice(0, 5).toUpperCase() : a.kind.toUpperCase()}</small>
    </span>
  );
}

function Flags({ a }) {
  return (
    <>
      {a.inTrash && <span className="att-flag is-trash" title="The note is in the Trash">In Trash</span>}
      {!a.inTrash && !a.referenced && <span className="att-flag is-unused" title="Listed with the note but not shown in its text">Not in text</span>}
      {a.copies > 1 && <span className="att-flag is-dup" title="The same file is attached elsewhere too">{a.copies} copies</span>}
      {a.template && <span className="att-flag">Template</span>}
    </>
  );
}

/** Choose a note: an existing one, or (for uploads) a new note in a notebook. Resolves to { noteId } | { notebookId, title } | null. */
function NoteChoiceDialog({ title, message, okLabel, allowNew, tree, close }) {
  const [mode, setMode] = useState('existing');
  const [noteId, setNoteId] = useState(null);
  const options = useMemo(() => notebookOptions(tree), [tree]);
  const [nb, setNb] = useState(options[0]?.id ?? null);
  const [name, setName] = useState(`Files ${new Date().toLocaleDateString()}`);
  const ok = mode === 'existing' ? !!noteId : !!nb && !!name.trim();
  return (
    <form className="att-dialog" onSubmit={(e) => { e.preventDefault(); if (ok) close(mode === 'existing' ? { noteId } : { notebookId: nb, title: name.trim() }); }}>
      <h2>{title}</h2>
      {message && <p className="muted">{message}</p>}
      {allowNew && (
        <div className="segmented" role="group">
          <button type="button" className={mode === 'existing' ? 'is-active' : ''} onClick={() => setMode('existing')}>A note</button>
          <button type="button" className={mode === 'new' ? 'is-active' : ''} onClick={() => setMode('new')}>A new note</button>
        </div>
      )}
      {mode === 'existing'
        ? <div className="att-field"><NotePicker value={noteId} onChange={setNoteId} /></div>
        : (
          <div className="att-field">
            <label className="field-label" htmlFor="att-new-title">Title</label>
            <input id="att-new-title" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="field-label" htmlFor="att-new-nb">Notebook</label>
            <select id="att-new-nb" className="input" value={nb ?? ''} onChange={(e) => setNb(Number(e.target.value))}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!ok}>{okLabel}</button>
      </div>
    </form>
  );
}

/** A big preview with details, rename, and the other places the same file is attached. Arrow keys move through the list. */
function PreviewDialog({ list, start, close, onOpenNote, actions }) {
  const [i, setI] = useState(start);
  const a = list[i];
  const [detail, setDetail] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    setDetail(null);
    setRenaming(false);
    api.attachment(a.id).then(setDetail).catch(() => {});
  }, [a.id]);
  useEffect(() => {
    const key = (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.key === 'ArrowRight' && i < list.length - 1) setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [i, list.length]);
  const d = detail ?? a;
  const rename = async (e) => {
    e.preventDefault();
    if (await actions.rename(a, name)) { setRenaming(false); setDetail((x) => ({ ...(x ?? a), filename: name.includes('.') ? name : `${name}${a.filename.match(/\.[^.]+$/)?.[0] ?? ''}` })); }
  };
  return (
    <div className="att-preview">
      <div className="att-stage">
        {a.kind === 'image' && <img src={fileUrl(a.id)} alt={d.filename} />}
        {a.kind === 'pdf' && <iframe title={d.filename} src={pdfViewerUrl(a.id)} />}
        {a.kind === 'video' && <video src={fileUrl(a.id)} controls preload="metadata" />}
        {a.kind === 'audio' && <div className="att-audio"><Thumb a={a} big /><audio src={fileUrl(a.id)} controls preload="metadata" /></div>}
        {['document', 'other'].includes(a.kind) && (
          <div className="att-noview"><Thumb a={a} big /><p className="muted">No preview for this kind of file.</p>
            <a className="btn" href={`${fileUrl(a.id)}?download=1`}><Icon name="download" size={15} /> Download</a></div>
        )}
        {i > 0 && <button className="att-nav is-prev" onClick={() => setI(i - 1)} aria-label="Previous file"><Icon name="chevronLeft" size={22} /></button>}
        {i < list.length - 1 && <button className="att-nav is-next" onClick={() => setI(i + 1)} aria-label="Next file"><Icon name="chevronRight" size={22} /></button>}
      </div>
      <aside className="att-info">
        {renaming
          ? (
            <form className="att-rename" onSubmit={rename}>
              <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} aria-label="File name" />
              <button className="btn btn-small btn-primary" disabled={!name.trim()}>Save</button>
              <button type="button" className="btn btn-small" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          )
          : <h2 className="att-name" title={d.filename}>{d.filename}</h2>}
        <p className="att-flags"><Flags a={d} /></p>
        <dl className="att-facts">
          <dt>Size</dt><dd>{formatSize(d.size)}</dd>
          <dt>Type</dt><dd>{d.mime}</dd>
          <dt>Added</dt><dd>{formatDate(d.createdAt)}</dd>
          <dt>Note</dt>
          <dd>{d.noteId
            ? <button type="button" className="link-btn" onClick={() => { close(); onOpenNote(d.noteId); }}>{d.noteTitle || 'Untitled'}</button>
            : '—'}{d.notebook && <span className="muted"> in {d.notebook}</span>}</dd>
        </dl>
        {detail?.sameAs?.length > 0 && (
          <div className="att-same">
            <h3>Also attached to</h3>
            <ul>
              {detail.sameAs.map((x) => (
                <li key={x.id}><button type="button" className="link-btn" onClick={() => { close(); onOpenNote(x.noteId); }}>{x.noteTitle || 'Untitled'}</button>
                  <span className="muted"> as {x.filename}{x.inTrash ? ' (in Trash)' : ''}</span></li>
              ))}
            </ul>
          </div>
        )}
        <div className="att-info-actions">
          <a className="btn" href={`${fileUrl(a.id)}?download=1`}><Icon name="download" size={15} /> Download</a>
          <a className="btn" href={fileUrl(a.id)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Open</a>
          <button className="btn" onClick={() => { setName(d.filename); setRenaming(true); }}><Icon name="pen" size={15} /> Rename</button>
          <button className="btn" onClick={async () => { if (await actions.move([a])) close(); }}><Icon name="merge" size={15} /> Move…</button>
          <button className="btn btn-danger-text" onClick={async () => { if (await actions.remove([a])) close(); }}><Icon name="trash" size={15} /> Delete…</button>
        </div>
        <p className="muted att-count">{i + 1} of {list.length} · ← → to move through</p>
        <div className="modal-actions"><button className="btn" onClick={() => close()}>Close</button></div>
      </aside>
    </div>
  );
}

/** Attachments: every file in every note, with storage use, filters, previews, duplicates, and bulk download, move and delete. */
export default function AttachmentsPage({ tree, onOpenNote, onChanged, onMenu }) {
  const dialog = useDialog();
  const [view, setView] = useStoredState('noteapp.attView', 'grid');
  const [sort, setSort] = useStoredState('noteapp.attSort', 'newest');
  const [kind, setKind] = useState('');
  const [filter, setFilter] = useState('');
  const [notebook, setNotebook] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Map()); // id -> attachment
  const [busy, setBusy] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const lastClicked = useRef(null);
  const fileInput = useRef(null);
  const nbOptions = useMemo(() => notebookOptions(tree), [tree]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const params = { q: query, kind, filter, notebook, sort };
  const load = useCallback(async (more = false) => {
    try {
      const r = await api.attachments({ ...params, offset: more ? data?.items.length ?? 0 : 0, limit: PAGE });
      setData((old) => (more && old ? { ...r, items: [...old.items, ...r.items] } : r));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [query, kind, filter, notebook, sort, data?.items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(false); setSelected(new Map()); }, [query, kind, filter, notebook, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  // Files added since the last look are compared for duplicates in the background (each file is read once, ever).
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!data || data.hashedAll || checking) return;
    setChecking(true);
    api.scanAttachments().then(() => load(false)).catch(() => {}).finally(() => setChecking(false));
  }, [data?.hashedAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = async () => {
    await load(false);
    onChanged?.();
  };

  // ---- actions ----
  const fail = (e) => { dialog.toast(e.message, 'error'); return false; };
  const actions = {
    rename: async (a, name) => {
      try { await api.renameAttachment(a.id, name); } catch (e) { return fail(e); }
      dialog.toast('Renamed');
      load(false);
      return true;
    },
    move: async (list) => {
      const r = await dialog.open((close) => (
        <NoteChoiceDialog tree={tree} close={close} title={list.length === 1 ? `Move “${list[0].filename}”` : `Move ${plural(list.length, 'file')}`} okLabel="Move"
          message="They come out of their notes and go on the end of the note you choose." />
      ));
      if (!r) return false;
      try {
        const { moved } = await api.moveAttachments(list.map((a) => a.id), r.noteId);
        dialog.toast(`Moved ${plural(moved, 'file')}`);
      } catch (e) { return fail(e); }
      setSelected(new Map());
      await changed();
      return true;
    },
    remove: async (list) => {
      const bytes = list.reduce((n, a) => n + a.size, 0);
      const ok = await dialog.confirm({
        title: list.length === 1 ? `Delete “${list[0].filename}”?` : `Delete ${plural(list.length, 'file')}?`,
        message: `${formatSize(bytes)} is freed. ${list.length === 1 ? 'It’s' : 'They’re'} removed from ${list.length === 1 ? 'its note' : 'their notes'}, text included. This can’t be undone.`,
        okLabel: 'Delete', danger: true,
      });
      if (!ok) return false;
      setBusy('Deleting…');
      try {
        await api.deleteAttachments(list.map((a) => a.id));
        dialog.toast(`Deleted ${plural(list.length, 'file')} · ${formatSize(bytes)} freed`);
      } catch (e) {
        setBusy(null);
        return fail(e);
      }
      setBusy(null);
      setSelected(new Map());
      await changed();
      return true;
    },
  };

  const preview = (index) => dialog.open((close) => <PreviewDialog list={data.items} start={index} close={close} onOpenNote={onOpenNote} actions={actions} />);

  const upload = async (files) => {
    if (!files?.length) return;
    const r = await dialog.open((close) => (
      <NoteChoiceDialog tree={tree} close={close} allowNew title={`Add ${plural(files.length, 'file')}`} okLabel="Add"
        message="Files are attached to a note and shown at the end of its text." />
    ));
    if (!r) return;
    try {
      let noteId = r.noteId;
      if (!noteId) {
        noteId = (await api.createNote(r.notebookId)).id;
        await api.updateNote(noteId, { title: r.title });
      }
      for (let n = 0; n < files.length; n++) {
        setBusy(`Uploading ${n + 1} of ${files.length}…`);
        await api.upload(noteId, files[n], (p) => setBusy(`Uploading ${n + 1} of ${files.length}… ${Math.round(p * 100)}%`), { append: true });
      }
      dialog.toast(`Added ${plural(files.length, 'file')}`);
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // ---- selection ----
  const items = data?.items ?? [];
  const toggle = (a, e) => {
    setSelected((s) => {
      const n = new Map(s);
      // Shift-click selects the run from the last one clicked.
      if (e?.shiftKey && lastClicked.current != null) {
        const from = items.findIndex((x) => x.id === lastClicked.current);
        const to = items.findIndex((x) => x.id === a.id);
        if (from >= 0 && to >= 0) {
          for (const x of items.slice(Math.min(from, to), Math.max(from, to) + 1)) n.set(x.id, x);
          return n;
        }
      }
      if (n.has(a.id)) n.delete(a.id); else n.set(a.id, a);
      return n;
    });
    lastClicked.current = a.id;
  };
  const chosen = [...selected.values()];
  const chosenBytes = chosen.reduce((n, a) => n + a.size, 0);
  const allShown = items.length > 0 && items.every((a) => selected.has(a.id));
  const zipHref = `/api/attachments/zip?ids=${chosen.map((a) => a.id).join(',')}`;

  const menu = (e, a, index) => dialog.contextMenu(e, [
    { label: 'Preview', onClick: () => preview(index) },
    a.noteId && { label: 'Open note', onClick: () => onOpenNote(a.noteId) },
    { label: 'Download', onClick: () => { window.location.href = `${fileUrl(a.id)}?download=1`; } },
    'sep',
    { label: 'Move to another note…', onClick: () => actions.move([a]) },
    { label: 'Delete…', danger: true, onClick: () => actions.remove([a]) },
  ]);

  const s = data?.summary;
  const quick = s ? [
    ['trash', 'In trashed notes', s.trash, 'trash'],
    ['unused', 'Not in note text', s.unused, 'eyeOff'],
    ['large', 'Large (10 MB+)', s.large, 'upload'],
  ] : [];

  return (
    <div className={`page att-page ${dragOver ? 'is-drop' : ''}`}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragOver(false); upload([...e.dataTransfer.files]); } }}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Attachments</h1>
          <p className="muted">{s ? `${plural(s.count, 'file')} · ${formatSize(s.bytes)}` : 'Loading…'}{busy ? ` · ${busy}` : ''}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={!!busy}><Icon name="upload" size={15} /> Add files…</button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
        </div>
      </header>

      {s && (
        <section className="att-summary">
          <div className="att-usage">
            <div className="att-usage-top">
              <strong>{formatSize(s.bytes)}</strong>
              <span className="muted">in {plural(s.count, 'file')}</span>
            </div>
            <div className="att-bar" aria-hidden="true">
              {Object.entries(s.byKind).sort((x, y) => y[1].bytes - x[1].bytes).map(([k, v]) => (
                <i key={k} className={`kind-${k}`} style={{ flexGrow: Math.max(v.bytes, 1) }} title={`${KIND_NAME[k]}: ${formatSize(v.bytes)}`} />
              ))}
            </div>
            <div className="att-legend">
              {Object.entries(s.byKind).sort((x, y) => y[1].bytes - x[1].bytes).map(([k, v]) => (
                <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(kind === k ? '' : k)}>
                  <i className={`kind-${k}`} /> {KIND_NAME[k]} <span className="muted">{v.count} · {formatSize(v.bytes)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="att-quick">
            {quick.map(([k, label, v, icon]) => (
              <button key={k} type="button" className={`att-quick-card ${filter === k ? 'is-on' : ''}`} disabled={!v.count && filter !== k}
                onClick={() => setFilter(filter === k ? '' : k)}>
                <Icon name={icon} size={16} />
                <span><strong>{v.count}</strong> {label}</span>
                <small>{formatSize(v.bytes)}</small>
              </button>
            ))}
            <button type="button" className={`att-quick-card ${filter === 'duplicates' ? 'is-on' : ''}`}
              onClick={() => setFilter(filter === 'duplicates' ? '' : 'duplicates')} disabled={!s.duplicates || (!s.duplicates.count && filter !== 'duplicates')}
              title="The same file attached more than once (compared by content)">
              <Icon name="copy" size={16} />
              {s.duplicates
                ? <><span><strong>{s.duplicates.count}</strong> Duplicate copies</span><small>{formatSize(s.duplicates.bytes)} could be freed</small></>
                : <><span>Duplicates</span><small>Checking files…</small></>}
            </button>
          </div>
        </section>
      )}

      <div className="att-toolbar">
        <label className="pr-search">
          <Icon name="search" size={15} />
          <input className="input" type="search" placeholder="Search file names, notes and notebooks" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="home-tabs is-sub att-kinds" role="tablist" aria-label="Kind">
          {KINDS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        {nbOptions.length > 1 && (
          <select className="input input-inline" value={notebook} onChange={(e) => setNotebook(e.target.value)} aria-label="Notebook">
            <option value="">All notebooks</option>
            {nbOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
        <select className="input input-inline" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" disabled={filter === 'duplicates'}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div className="segmented att-views" role="group" aria-label="View">
          <button type="button" className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')} aria-label="Grid" title="Grid"><Icon name="layout" size={15} /></button>
          <button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')} aria-label="List" title="List"><Icon name="list" size={15} /></button>
        </div>
      </div>

      <div className={`att-selbar ${chosen.length ? 'is-on' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={allShown} disabled={!items.length}
            onChange={() => setSelected(allShown ? new Map() : new Map(items.map((a) => [a.id, a])))} />
          {chosen.length ? `${plural(chosen.length, 'file')} selected · ${formatSize(chosenBytes)}` : data ? `${plural(data.total, 'file')} · ${formatSize(data.totalBytes)}` : ''}
        </label>
        {filter && <button type="button" className="att-filter-chip" onClick={() => setFilter('')} title="Show all files">{{ trash: 'In trashed notes', unused: 'Not in note text', large: 'Large files', duplicates: 'Duplicates' }[filter]} <Icon name="x" size={12} /></button>}
        <span className="att-selbar-gap" />
        {chosen.length > 0 && (
          <span className="att-selbar-actions">
            <a className="btn btn-small" href={zipHref} download><Icon name="download" size={14} /> Download zip</a>
            <button className="btn btn-small" onClick={() => actions.move(chosen)} disabled={!!busy}><Icon name="merge" size={14} /> Move…</button>
            <button className="btn btn-small btn-danger" onClick={() => actions.remove(chosen)} disabled={!!busy}><Icon name="trash" size={14} /> Delete…</button>
            <button className="btn btn-small" onClick={() => setSelected(new Map())}>Clear</button>
          </span>
        )}
      </div>

      {filter === 'duplicates' && data && <p className="muted att-hint">Copies of the same file sit next to each other, oldest first. Select the extra copies to delete them; the first stays.</p>}
      {filter === 'unused' && <p className="muted att-hint">These files are listed with their notes but not shown in the note’s text (the block was removed but the file was kept).</p>}
      {error && <p className="form-error">{error}</p>}
      {!data && !error && <div className="att-grid">{Array.from({ length: 12 }, (_, i) => <div key={i} className="att-card is-skeleton" />)}</div>}
      {data && !items.length && (
        <div className="pr-blank"><Icon name="paperclip" size={30} /><p>{query || kind || filter || notebook ? 'No files match.' : 'No attachments yet. Drop files here or use Add files… to attach them to a note.'}</p></div>
      )}

      {view === 'grid' && items.length > 0 && (
        <ul className="att-grid">
          {items.map((a, index) => (
            <li key={a.id} className={`att-card ${selected.has(a.id) ? 'is-selected' : ''} ${a.inTrash ? 'is-trash' : ''}`} onContextMenu={(e) => menu(e, a, index)}>
              <input type="checkbox" className="att-check" checked={selected.has(a.id)} onChange={() => {}} onClick={(e) => toggle(a, e)} aria-label={`Select ${a.filename}`} />
              <button type="button" className="att-card-main" onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey || chosen.length ? toggle(a, e) : preview(index))} title={a.filename}>
                <Thumb a={a} />
                <span className="att-card-name">{a.filename}</span>
                <span className="att-card-meta">{formatSize(a.size)} · {a.noteTitle || 'Untitled'}</span>
              </button>
              <span className="att-card-flags"><Flags a={a} /></span>
            </li>
          ))}
        </ul>
      )}

      {view === 'list' && items.length > 0 && (
        <div className="att-table" role="table">
          <div className="att-tr att-th" role="row">
            <span /><span>Name</span><span>Note</span><span>Size</span><span>Added</span><span />
          </div>
          {items.map((a, index) => (
            <div key={a.id} role="row" className={`att-tr ${selected.has(a.id) ? 'is-selected' : ''} ${a.inTrash ? 'is-trash' : ''}`} onContextMenu={(e) => menu(e, a, index)}>
              <input type="checkbox" checked={selected.has(a.id)} onChange={() => {}} onClick={(e) => toggle(a, e)} aria-label={`Select ${a.filename}`} />
              <button type="button" className="att-tr-name" onClick={() => preview(index)} title={a.filename}>
                <Icon name={KIND_ICON[a.kind]} size={15} /><span>{a.filename}</span><Flags a={a} />
              </button>
              <span className="att-tr-note">
                {a.noteId ? <button type="button" className="link-btn" onClick={() => onOpenNote(a.noteId)}>{a.noteTitle || 'Untitled'}</button> : '—'}
                {a.notebook && <small className="muted"> {a.notebook}</small>}
              </span>
              <span className="att-tr-size">{formatSize(a.size)}</span>
              <span className="att-tr-date">{formatDate(a.createdAt)}</span>
              <button type="button" className="icon-btn" aria-label={`Actions for ${a.filename}`} onClick={(e) => menu(e, a, index)}><Icon name="more" size={16} /></button>
            </div>
          ))}
        </div>
      )}

      {data && items.length < data.total && (
        <button className="btn wp-more" onClick={() => load(true)}>Show more ({(data.total - items.length).toLocaleString()} left)</button>
      )}
      {dragOver && <div className="att-dropzone"><Icon name="upload" size={34} /><p>Drop to attach to a note</p></div>}
    </div>
  );
}
