import { useMemo, useState } from 'react';
import { formatDate } from '../api.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { useDropTarget } from '../components/Sidebar.jsx';
import { useNotebookActions } from '../components/useNotebookActions.js';
import { useStoredState } from '../useStoredState.js';

const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) },
  notes: { label: 'Most notes', fn: (a, b) => b.count - a.count },
  updated: { label: 'Recently updated', fn: (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) },
};
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Overview of all stacks and notebooks: rename, re-stack (drag or pick), merge, delete, shortcuts. */
export default function NotebooksPage({ tree, onRefresh, onOpen, onNewNote, onMenu }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useStoredState('noteapp.notebooksSort', 'name');
  const [selected, setSelected] = useState(() => new Set());
  const actions = useNotebookActions({
    tree, onRefresh,
    onDeleted: (id) => setSelected((sel) => { const next = new Set(sel); next.delete(id); return next; }),
  });

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const stackName = (id) => tree.stacks.find((s) => s.id === id)?.name ?? '';
    const match = (nb) => !q || nb.name.toLowerCase().includes(q) || stackName(nb.stack_id).toLowerCase().includes(q);
    const books = tree.notebooks.filter(match).sort(SORTS[sort]?.fn ?? SORTS.name.fn);
    const list = tree.stacks.map((s) => ({ stack: s, books: books.filter((nb) => nb.stack_id === s.id) }))
      .filter((g) => !q || g.books.length || g.stack.name.toLowerCase().includes(q));
    list.push({ stack: null, books: books.filter((nb) => !nb.stack_id) });
    return list;
  }, [tree, q, sort]);

  const selectedBooks = tree.notebooks.filter((nb) => selected.has(nb.id));
  const toggle = (id) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clear = () => setSelected(new Set());
  const total = tree.notebooks.reduce((n, nb) => n + nb.count, 0);

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Notebooks</h1>
          <p className="muted">{plural(tree.notebooks.length, 'notebook')} · {plural(tree.stacks.length, 'shelf', 'shelves')} · {plural(total, 'note')}</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => actions.newStack()}><Icon name="stack" size={16} /> New shelf</button>
          <button className="btn btn-primary" onClick={() => actions.newNotebook()}><Icon name="plus" size={16} /> New notebook</button>
        </div>
      </header>

      <div className="nb-toolbar">
        <label className="nb-search">
          <Icon name="search" size={16} className="muted" />
          <input placeholder="Find a notebook or shelf…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="nb-sort">
          <span className="muted">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>

      {selected.size > 0 && (
        <div className="nb-bulk" role="toolbar" aria-label="Selected notebooks">
          <strong>{selected.size} selected</strong>
          <button className="btn btn-small" onClick={() => actions.moveToStack(selectedBooks)}><Icon name="stack" size={14} /> Move to shelf…</button>
          <button className="btn btn-small" onClick={() => actions.exportNotebooks(selectedBooks)}><Icon name="download" size={14} /> Export…</button>
          <button className="btn btn-small btn-danger-text" onClick={() => actions.deleteNotebooks(selectedBooks)}><Icon name="trash" size={14} /> Delete…</button>
          <button className="btn btn-small" onClick={clear}>Clear</button>
        </div>
      )}

      <div className="nb-groups">
        {groups.map((g) => (
          <StackGroup key={g.stack?.id ?? 'none'} group={g} tree={tree} actions={actions} selected={selected}
            onToggle={toggle} onOpen={onOpen} onNewNote={onNewNote} filtering={!!q} />
        ))}
      </div>
    </div>
  );
}

function StackGroup({ group: { stack, books }, tree, actions, selected, onToggle, onOpen, onNewNote, filtering }) {
  const drop = useDropTarget(['application/x-notebook'], (_, nbId) => actions.setStack(nbId, stack?.id ?? null));
  const count = books.reduce((n, nb) => n + nb.count, 0);
  const starred = stack && actions.shortcutFor('stack', stack.id);
  const dialog = useDialog();
  const items = stack && [
    { label: 'New notebook on shelf…', onClick: () => actions.newNotebook(stack.id) },
    { label: 'Rename shelf…', onClick: () => actions.renameStack(stack) },
    { label: 'Export shelf…', onClick: () => actions.exportStack(stack) },
    actions.shortcutItem('stack', stack.id),
    'sep',
    { label: 'Delete shelf…', danger: true, onClick: () => actions.deleteStack(stack) },
  ];
  return (
    <section className={`nb-group ${drop.over ? 'is-drop' : ''}`} {...drop.props}>
      <div className="nb-group-head" onContextMenu={items ? (e) => dialog.contextMenu(e, items) : undefined}>
        <Icon name={stack ? 'stack' : 'notebook'} size={17} className="muted" />
        {stack
          ? <button className="nb-group-title" onClick={() => onOpen({ type: 'stack', id: stack.id })}>{stack.name}</button>
          : <span className="nb-group-title">Not on a shelf</span>}
        <span className="nb-group-meta">{plural(books.length, 'notebook')} · {plural(count, 'note')}</span>
        {stack && (
          <>
            <button className={`icon-btn nb-star ${starred ? 'is-on' : ''}`} onClick={() => actions.toggleShortcut('stack', stack.id)}
              title={starred ? 'Remove from shortcuts' : 'Add to shortcuts'} aria-pressed={!!starred}>
              <Icon name="star" size={16} />
            </button>
            <Menu align="right" trigger={({ toggle }) => (
              <button className="icon-btn" onClick={toggle} aria-label={`${stack.name} options`}><Icon name="more" size={16} /></button>
            )} items={items} />
          </>
        )}
      </div>
      {books.length === 0 && (
        <p className="nb-empty">{filtering ? 'No matching notebooks.' : stack ? 'Empty shelf. Drag notebooks here.' : 'Every notebook is on a shelf.'}</p>
      )}
      {books.map((nb) => (
        <NotebookRow key={nb.id} nb={nb} tree={tree} actions={actions} checked={selected.has(nb.id)}
          onToggle={onToggle} onOpen={onOpen} onNewNote={onNewNote} />
      ))}
    </section>
  );
}

function NotebookRow({ nb, tree, actions, checked, onToggle, onOpen, onNewNote }) {
  const starred = actions.shortcutFor('notebook', nb.id);
  const dialog = useDialog();
  const items = [
    { label: 'Open', onClick: () => onOpen({ type: 'notebook', id: nb.id }) },
    { label: 'New note in notebook', onClick: () => onNewNote(nb.id) },
    { label: 'Rename…', onClick: () => actions.renameNotebook(nb) },
    { label: 'Move to shelf…', onClick: () => actions.moveToStack([nb]) },
    { label: 'Merge into…', onClick: () => actions.mergeNotebook(nb) },
    { label: 'Export…', onClick: () => actions.exportNotebooks([nb]) },
    actions.shareItem(nb),
    actions.shortcutItem('notebook', nb.id),
    'sep',
    { label: 'Delete notebook…', danger: true, onClick: () => actions.deleteNotebooks([nb]) },
  ];
  return (
    <div className={`nb-row ${checked ? 'is-selected' : ''}`} draggable onContextMenu={(e) => dialog.contextMenu(e, items)}
      onDragStart={(e) => { e.dataTransfer.setData('application/x-notebook', String(nb.id)); e.dataTransfer.effectAllowed = 'move'; }}>
      <span className="nb-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
      <input type="checkbox" className="nb-check" checked={checked} onChange={() => onToggle(nb.id)} aria-label={`Select ${nb.name}`} />
      <button className="nb-name" onClick={() => onOpen({ type: 'notebook', id: nb.id })}>
        <Icon name="notebook" size={16} />
        <span>{nb.name}</span>
      </button>
      <span className="nb-count">{plural(nb.count, 'note')}</span>
      <span className="nb-updated muted">{nb.updated_at ? `Updated ${formatDate(nb.updated_at)}` : 'No notes yet'}</span>
      <select className="nb-stack" value={nb.stack_id ?? ''} aria-label={`Shelf for ${nb.name}`}
        onChange={(e) => actions.setStack(nb.id, e.target.value ? Number(e.target.value) : null)}>
        <option value="">No shelf</option>
        {tree.stacks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button className={`icon-btn nb-star ${starred ? 'is-on' : ''}`} onClick={() => actions.toggleShortcut('notebook', nb.id)}
        title={starred ? 'Remove from shortcuts' : 'Add to shortcuts'} aria-pressed={!!starred}>
        <Icon name="star" size={16} />
      </button>
      <Menu align="right" trigger={({ toggle }) => (
        <button className="icon-btn" onClick={toggle} aria-label={`${nb.name} options`}><Icon name="more" size={16} /></button>
      )} items={items} />
    </div>
  );
}
