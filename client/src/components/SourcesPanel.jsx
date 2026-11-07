import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import CiteDialog, { citationLabel, describeSource } from './CiteDialog.jsx';
import { cacheSources } from '../citations/index.js';

/**
 * Beside a chapter while you write: the Writing project's reading notes (open one to read it here) and the Zotero
 * sources the project cites, plus your recent ones. Click a source to cite it at the cursor, with the page if you
 * give one; "Find in Zotero…" opens the usual cite dialog.
 */
export default function SourcesPanel({ study, noteId, editor, readOnly, onClose }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [recent, setRecent] = useState([]);
  const [open, setOpen] = useState(null); // reading note id shown in the panel
  const [openHtml, setOpenHtml] = useState('');
  const [page, setPage] = useState('');

  useEffect(() => {
    api.studySources(study.id).then((d) => { cacheSources(d.sources); setData(d); }).catch((e) => dialog.toast(e.message, 'error'));
    api.recentSources().then((list) => { cacheSources(list); setRecent(list); }).catch(() => {});
  }, [study.id, dialog]);
  useEffect(() => {
    if (!open) return;
    setOpenHtml('');
    api.getNote(open).then((n) => setOpenHtml(n.html)).catch(() => setOpenHtml('<p>Couldn’t open it.</p>'));
  }, [open]);

  const cite = (source) => {
    const items = [{ id: source.id, locator: page.trim(), label: 'page', prefix: '', suffix: '' }];
    editor.chain().focus().insertCitation({ items, note: '', noteHtml: '', label: citationLabel(items) }).run();
    setPage('');
  };
  const find = async () => {
    const attrs = await dialog.open((close) => <CiteDialog close={close} />);
    if (attrs) editor.chain().focus().insertCitation(attrs).run();
  };

  const cited = new Set((data?.sources ?? []).map((s) => s.id));
  const others = recent.filter((s) => !cited.has(s.id)).slice(0, 8);
  const sourceRow = (s) => {
    const d = describeSource(s);
    return (
      <li key={s.id}>
        <button type="button" className="source-row" disabled={readOnly} onClick={() => cite(s)} title="Cite it at the cursor">
          <span className="source-title">{d.title}</span>
          <span className="muted">{[d.who, d.year].filter(Boolean).join(', ')}{s.cited ? ` · cited ${s.cited}×` : ''}</span>
        </button>
      </li>
    );
  };
  const notes = (data?.notes ?? []).filter((n) => n.id !== noteId);

  return (
    <aside className="sources-panel" aria-label="Sources">
      <div className="sources-head">
        <strong>Sources</strong>
        <span className="muted sources-study">{study.title}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close sources"><Icon name="x" size={15} /></button>
      </div>
      {!data ? <p className="muted">Loading…</p> : (
        <div className="sources-body">
          <h4>Reading notes</h4>
          {!notes.length && <p className="muted">Notes you add to the project (not chapters) show here, to read while you write.</p>}
          <ul className="sources-notes">
            {notes.map((n) => (
              <li key={n.id} className={open === n.id ? 'is-open' : ''}>
                <button type="button" className="source-row" onClick={() => setOpen(open === n.id ? null : n.id)}>
                  <span className="source-title"><Icon name={open === n.id ? 'chevronDown' : 'chevronRight'} size={12} /> {n.title || 'Untitled'}</span>
                  <span className="muted">{formatDate(n.updated_at)}</span>
                </button>
                {open === n.id && (
                  <div className="sources-note">
                    {/* Your own note, shown as it is saved. */}
                    <div className="sources-note-body" dangerouslySetInnerHTML={{ __html: openHtml || '<p class="muted">Loading…</p>' }} />
                    <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: n.id }))}>Open the note</button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h4>Cite</h4>
          <label className="sources-page">Page <input className="input" value={page} onChange={(e) => setPage(e.target.value)} placeholder="optional" disabled={readOnly} /></label>
          {data.sources.length > 0 && <><div className="sources-sub">Cited in this project</div><ul className="sources-list">{data.sources.map(sourceRow)}</ul></>}
          {others.length > 0 && <><div className="sources-sub">Recently cited</div><ul className="sources-list">{others.map(sourceRow)}</ul></>}
          <button type="button" className="btn btn-small" onClick={find} disabled={readOnly}><Icon name="search" size={13} /> Find in Zotero…</button>
        </div>
      )}
    </aside>
  );
}
