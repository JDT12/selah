import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDate } from '../api.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { useNotebookActions } from '../components/useNotebookActions.js';
import { useTagActions } from '../components/useTagActions.jsx';
import { useStoredState } from '../useStoredState.js';
import { tagColor } from '../tagColors.js';

const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) },
  count: { label: 'Most used', fn: (a, b) => b.count - a.count },
  recent: { label: 'Recently used', fn: (a, b) => (b.last_used ?? 0) - (a.last_used ?? 0) },
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Every tag, with rename, color, merge, delete, shortcuts and bulk tagging of notes. */
export default function TagsPage({ tree, onRefresh, onOpen, onMenu }) {
  const dialog = useDialog();
  const [tags, setTags] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useStoredState('noteapp.tagsSort', 'name');
  const [selected, setSelected] = useState(() => new Set());

  const load = useCallback(() => api.listTags().then(setTags).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); }, [load, tree]);

  const notebookActions = useNotebookActions({ tree, onRefresh });
  const actions = useTagActions({
    tags: tags ?? [],
    notebookActions,
    onRefresh: () => { load(); onRefresh(); },
    onDeleted: (id) => setSelected((sel) => { const next = new Set(sel); next.delete(id); return next; }),
  });

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (tags ?? []).filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort(SORTS[sort]?.fn ?? SORTS.name.fn), [tags, q, sort]);
  const selectedTags = (tags ?? []).filter((t) => selected.has(t.id));
  const toggle = (id) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allShownSelected = shown.length > 0 && shown.every((t) => selected.has(t.id));
  const open = (t) => onOpen({ type: 'tag', id: t.id });

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Tags</h1>
          <p className="muted">{tags ? plural(tags.length, 'tag') : '…'} · {plural(tree.untagged ?? 0, 'untagged note')}</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => onOpen({ type: 'untagged' })}><Icon name="note" size={16} /> Untagged notes</button>
          <button className="btn btn-primary" onClick={actions.create}><Icon name="plus" size={16} /> New tag</button>
        </div>
      </header>

      <div className="nb-toolbar">
        <label className="nb-search">
          <Icon name="search" size={16} className="muted" />
          <input placeholder="Find a tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="nb-sort">
          <span className="muted">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>

      {selected.size > 0 && (
        <div className="nb-bulk" role="toolbar" aria-label="Selected tags">
          <strong>{selected.size} selected</strong>
          {selectedTags.length === 1 && (
            <button className="btn btn-small" onClick={() => actions.rename(selectedTags[0])}><Icon name="pen" size={14} /> Rename…</button>
          )}
          {selectedTags.length === 1 && (
            <button className="btn btn-small" onClick={() => actions.tagNotes(selectedTags[0])}><Icon name="tag" size={14} /> Tag notes…</button>
          )}
          <button className="btn btn-small" onClick={() => actions.merge(selectedTags)}><Icon name="merge" size={14} /> Merge into…</button>
          <button className="btn btn-small" onClick={() => actions.setColor(selectedTags)}>Color…</button>
          <button className="btn btn-small" onClick={() => actions.setIgnoreScripture(selectedTags, !selectedTags.every((t) => t.ignore_scripture))}>
            {selectedTags.every((t) => t.ignore_scripture) ? 'Include in Scripture index' : 'Ignore Scripture'}
          </button>
          <button className="btn btn-small btn-danger-text" onClick={() => actions.remove(selectedTags)}><Icon name="trash" size={14} /> Delete…</button>
          <button className="btn btn-small" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <section className="nb-group tg-list">
        <div className="tg-head">
          <input type="checkbox" className="nb-check" checked={allShownSelected} aria-label="Select all shown tags"
            onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((t) => t.id)))} />
          <span>Tag</span><span>Notes</span><span>Last used</span>
        </div>
        {tags && shown.length === 0 && (
          <p className="nb-empty">{q ? 'No matching tags.' : 'No tags yet. Add one to a note, or use New tag.'}</p>
        )}
        {shown.map((t) => {
          const items = actions.menuItems(t, { open });
          const starred = notebookActions.shortcutFor('tag', t.id);
          const extra = [t.templates && plural(t.templates, 'template'), t.trashed && `${t.trashed} in trash`].filter(Boolean).join(', ');
          return (
            <div key={t.id} className={`tg-row ${selected.has(t.id) ? 'is-selected' : ''}`} onContextMenu={(e) => dialog.contextMenu(e, items)}>
              <input type="checkbox" className="nb-check" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.name}`} />
              <button className="tg-dot-btn" onClick={() => actions.setColor([t])} title="Change color" aria-label={`Color for ${t.name}`}>
                <span className={`tag-dot ${t.color ? '' : 'is-none'}`} style={{ '--tag': tagColor(t.color) }} />
              </button>
              <button className="nb-name" onClick={() => open(t)}><span>{t.name}</span>
                {!!t.ignore_scripture && <span className="tg-flag" title="Scripture references in these notes are ignored (not in the Scripture index)">No Scripture Indexing</span>}
              </button>
              <span className="nb-count" title={extra || undefined}>{t.count}{extra && <span className="muted"> +{(t.templates ?? 0) + (t.trashed ?? 0)}</span>}</span>
              <span className="nb-updated muted">{t.last_used ? formatDate(t.last_used) : '—'}</span>
              <button className={`icon-btn nb-star ${starred ? 'is-on' : ''}`} onClick={() => notebookActions.toggleShortcut('tag', t.id)}
                title={starred ? 'Remove from shortcuts' : 'Add to shortcuts'} aria-pressed={!!starred}>
                <Icon name="star" size={16} />
              </button>
              <Menu align="right" trigger={({ toggle: openMenu }) => (
                <button className="icon-btn" onClick={openMenu} aria-label={`${t.name} options`}><Icon name="more" size={16} /></button>
              )} items={items} />
            </div>
          );
        })}
      </section>
    </div>
  );
}
