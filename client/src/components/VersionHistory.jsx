import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { wordDiff } from '../wordDiff.js';

const textOf = (html) => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre, tr, summary').forEach((el) => el.append('\n'));
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
};
const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayLabel = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

/**
 * Earlier versions of a note: pick one to read it, see what changed since (words added and removed), and restore
 * it. `current` is the note as it is now ({ title, html }); `onRestore(versionId)` does the restoring.
 */
export default function VersionHistory({ noteId, current, onRestore, close }) {
  const dialog = useDialog();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null); // version id
  const [version, setVersion] = useState(null);
  const [showChanges, setShowChanges] = useState(true);

  useEffect(() => {
    api.noteVersions(noteId).then((l) => { setList(l); if (l.length) setPicked(l[0].id); }).catch((e) => setError(e.message));
  }, [noteId]);
  useEffect(() => {
    if (!picked) return undefined;
    let live = true;
    setVersion(null);
    api.noteVersion(noteId, picked).then((v) => live && setVersion(v)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [noteId, picked]);

  const diff = useMemo(() => (version && showChanges
    ? wordDiff(`${version.title}\n\n${textOf(version.html)}`, `${current.title}\n\n${textOf(current.html)}`) : null), [version, showChanges, current]);
  const changed = diff?.some((d) => d.type !== 'same');

  const restore = async () => {
    const ok = await dialog.confirm({
      title: 'Restore this version?',
      message: `The note goes back to how it was on ${when(version.created_at)}. What it says now is kept in the history, so you can switch back.`,
      okLabel: 'Restore',
    });
    if (!ok) return;
    await onRestore(version.id);
    close(true);
  };

  let lastDay = null;
  return (
    <div className="history-dialog">
      <div className="dialog-header">
        <h2>Version history</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {list && !list.length && (
        <p className="history-empty">
          No earlier versions yet. A copy is saved when you come back to a note after a 10-minute break, and before
          a restore or a template is inserted.
        </p>
      )}
      {list && list.length > 0 && (
        <div className="history-body">
          <div className="history-list" role="listbox" aria-label="Versions">
            {list.map((v) => {
              const day = dayLabel(v.created_at);
              const head = day !== lastDay && <div className="history-day">{day}</div>;
              lastDay = day;
              return (
                <div key={v.id}>
                  {head}
                  <button type="button" role="option" aria-selected={picked === v.id}
                    className={`history-item ${picked === v.id ? 'is-active' : ''}`} onClick={() => setPicked(v.id)}>
                    <span className="history-time">{new Date(v.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                    <span className="history-meta">{v.reason || (v.title !== current.title ? `Titled “${v.title || 'Untitled'}”` : 'Before an edit')}</span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="history-preview">
            {!version ? <p className="muted">Loading…</p> : (
              <>
                <div className="history-toolbar">
                  <span className="muted">{when(version.created_at)}</span>
                  <span className="spacer" />
                  <label className="history-toggle">
                    <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
                    Show changes since
                  </label>
                </div>
                {showChanges ? (
                  <div className="history-diff">
                    {changed ? diff.map((d, i) => (d.type === 'same' ? <span key={i}>{d.text}</span>
                      : d.type === 'add' ? <ins key={i} title="Added since">{d.text}</ins>
                        : <del key={i} title="Removed since">{d.text}</del>))
                      : <p className="muted">The text is the same as now (only formatting changed).</p>}
                  </div>
                ) : (
                  <div className="history-doc">
                    <h1 className="history-title">{version.title || 'Untitled'}</h1>
                    {/* The note's own saved HTML, shown read-only. */}
                    <div className="note-body" dangerouslySetInnerHTML={{ __html: version.html }} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <div className="modal-actions spread">
        <span className="muted history-legend">
          {showChanges && changed && <><ins>added since</ins> <del>removed since</del></>}
        </span>
        <span className="modal-actions-group">
          <button className="btn" onClick={() => close()}>Close</button>
          {version && <button className="btn btn-primary" onClick={restore}><Icon name="restore" size={15} /> Restore this version</button>}
        </span>
      </div>
    </div>
  );
}
