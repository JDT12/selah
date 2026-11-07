import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { addDays, formatLongDate, relativeDay, todayStr, wallClock } from '../time.js';
import { useStoredState } from '../useStoredState.js';
import { TAG_COLORS, tagColor } from '../tagColors.js';
import { completeTasks, deleteTasks, toggleTask, updateTasks } from '../taskActions.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import TaskRow, { PRIORITY_LABEL } from '../components/TaskRow.jsx';
import {
  DEFAULT_FILTER, SORTS, WHEN, applyFilter, filterCount, groupTasks, inView, matchesSearch, searchWords,
} from '../taskViews.js';
import TaskDetail, { nextMonday } from '../components/TaskDetail.jsx';
import QuickAdd from '../components/QuickAdd.jsx';
import Icon from '../components/Icon.jsx';

const VIEWS = [
  { key: 'today', title: 'Today', icon: 'sun', color: '#f97316' },
  { key: 'upcoming', title: 'Upcoming', icon: 'upcoming', color: '#8b5cf6' },
  { key: 'all', title: 'All tasks', icon: 'list', color: '#3b82f6' },
  { key: 'inbox', title: 'Inbox', icon: 'inbox', color: '#64748b' },
  { key: 'done', title: 'Completed', icon: 'checkCircle', color: '#22c55e' },
];
const TASK_TYPE = 'application/x-task';
const LIST_TYPE = 'application/x-tasklist';
const listIdOf = (view) => (view.startsWith('list:') ? Number(view.slice(5)) : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hasType = (e, type) => e.dataTransfer.types.includes(type);

const EMPTY = {
  today: ['sun', 'Nothing due today', 'Add a task above, or plan ahead in Upcoming.'],
  upcoming: ['upcoming', 'Nothing scheduled', 'Tasks with a due date show up here.'],
  all: ['checkCircle', 'All clear', 'Add your first task above. Try “Call Bob tomorrow 3pm #Church”.'],
  inbox: ['inbox', 'Inbox is empty', 'Tasks without a list land here.'],
  list: ['list', 'No tasks in this list', 'Add one above.'],
  done: ['checkCircle', 'No completed tasks yet', 'Tasks you finish show up here.'],
};

export default function TasksPage({ onOpenNote, onMenu, onTasksChanged, onPlan }) {
  const dialog = useDialog();
  const [view, setView] = useStoredState('noteapp.tasksView', 'today');
  const [tasks, setTasks] = useState(null);
  const [lists, setLists] = useState([]);
  const [done, setDone] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null); // task id or group/rail key under the pointer
  const [query, setQuery] = useState('');
  const [storedFilter, setFilter] = useStoredState('noteapp.tasksFilter', DEFAULT_FILTER);
  const [sort, setSort] = useStoredState('noteapp.tasksSort', 'due');
  const filter = { ...DEFAULT_FILTER, ...storedFilter };
  const quickRef = useRef(null);
  const searchRef = useRef(null);
  const t = todayStr();

  const load = useCallback(async () => {
    try {
      const [open, ls, finished] = await Promise.all([
        api.listTasks(), api.listTaskLists(), view === 'done' ? api.listTasks('done') : null,
      ]);
      setTasks(open);
      setLists(ls);
      setDone(finished);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  }, [view, dialog]);
  useEffect(() => { load(); }, [load]);
  // Reload when coming back to the tab (another device may have changed things).
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const changed = useCallback(() => { load(); onTasksChanged(); }, [load, onTasksChanged]);

  // A list that was deleted elsewhere falls back to All.
  const currentList = lists.find((l) => l.id === listIdOf(view));
  useEffect(() => {
    if (tasks && view.startsWith('list:') && !currentList) setView('all');
  }, [tasks, view, currentList, setView]);

  const switchView = (v) => {
    if (v === view) return;
    setView(v);
    setSelected(new Set());
    setSelecting(false);
    if (v === 'done') setDone(null);
  };

  const words = useMemo(() => searchWords(query), [query]);
  const inThisView = useMemo(() => (view === 'done' ? done ?? [] : (tasks ?? []).filter((x) => inView(view, x, t))), [view, tasks, done, t]);
  const shown = useMemo(
    () => applyFilter(inThisView.filter((x) => matchesSearch(x, words)), filter, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inThisView, words, JSON.stringify(filter), t],
  );
  const groups = useMemo(() => (view === 'done' ? doneGroups(shown) : groupTasks(view, shown, t, sort, lists)), [view, shown, t, sort, lists]);
  const narrowed = words.length > 0 || filterCount(filter) > 0;
  // Dragging a task onto another reorders them only when sorted by date (your own order within a day).
  const reorderable = sort === 'due' && view !== 'done';
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const detail = detailId ? [...(tasks ?? []), ...(done ?? [])].find((x) => x.id === detailId) ?? null : null;
  const selectedTasks = flat.filter((x) => selected.has(x.id));

  const counts = useMemo(() => {
    const open = tasks ?? [];
    return {
      today: open.filter((x) => inView('today', x, t)).length,
      overdue: open.filter((x) => x.due_date && x.due_date < t).length,
      upcoming: open.filter((x) => (x.due_date && x.due_date > t && x.due_date < addDays(t, 7))
        || (!x.due_date && x.start_date > t && x.start_date < addDays(t, 7))).length,
      all: open.length,
      inbox: open.filter((x) => !x.list_id).length,
    };
  }, [tasks, t]);

  // ---------- saving ----------
  const save = async (task, patch) => {
    // Show the change at once; the reload brings back anything the server works out (list name, repeat anchor).
    setTasks((all) => all?.map((x) => (x.id === task.id ? { ...x, ...patch } : x)));
    try {
      await api.updateTask(task.id, patch);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    changed();
  };

  const toggle = (task) => toggleTask(task, dialog, changed);

  const onCreated = (id, body) => {
    changed();
    if (view !== 'done' && !inView(view, body, t)) {
      const where = body.due_date ? relativeDay(body.due_date) : 'No date';
      dialog.toast(`Added: ${where}`, 'info', 5000, { label: 'Show', onClick: () => { switchView('all'); setDetailId(id); } });
    }
  };

  // ---------- selection ----------
  const clearSelection = () => { setSelected(new Set()); setSelecting(false); };
  const onSelectClick = (e, task) => {
    if (e.shiftKey && anchor) {
      const a = flat.findIndex((x) => x.id === anchor);
      const b = flat.findIndex((x) => x.id === task.id);
      if (a >= 0 && b >= 0) {
        const range = flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
        setSelected(new Set([...selected, ...range]));
        return true;
      }
    }
    setAnchor(task.id);
    if (e.ctrlKey || e.metaKey || selecting || selected.size) {
      const next = new Set(selected);
      if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
      setSelected(next);
      return true;
    }
    return false;
  };
  const bulkDone = () => { completeTasks(selectedTasks, dialog, changed); clearSelection(); };
  const bulkDelete = () => {
    if (selectedTasks.some((x) => x.id === detailId)) setDetailId(null);
    deleteTasks(selectedTasks, dialog, changed);
    clearSelection();
  };
  const bulkUpdate = (changes, message) => { updateTasks(selectedTasks, changes, dialog, changed, message); clearSelection(); };
  const pickDate = async (tasksToMove) => {
    const date = await dialog.open((close) => <DatePrompt close={close} />);
    if (date !== null && date !== undefined) updateTasks(tasksToMove, { due_date: date || null }, dialog, changed, date ? `Moved to ${relativeDay(date)}` : 'Date removed');
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('.modal-backdrop, .context-menu')) return;
      const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (typing) return;
        if (selected.size || selecting) clearSelection();
        else if (detailId) setDetailId(null);
        return;
      }
      if (typing || e.altKey) return;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.key === 'n' || e.key === 'q') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        quickRef.current?.focus();
      } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && view !== 'done') {
        e.preventDefault();
        setSelected(new Set(flat.map((x) => x.id)));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        bulkDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- drag and drop ----------
  // Dragging one of several selected tasks onto a day or list moves them all.
  const dragged = () => {
    const task = (tasks ?? []).find((x) => x.id === dragId);
    if (!task) return [];
    return selected.has(task.id) ? selectedTasks : [task];
  };
  const endDrag = () => { setDragId(null); setDropAt(null); };

  // Dropping a task on another: sorted by date, it goes just above that one (and on that task's day);
  // in other sorts it takes that task's group (priority or list).
  const dropOnRow = (target, g) => {
    const moving = (tasks ?? []).find((x) => x.id === dragId);
    if (!reorderable) {
      endDrag();
      if (g.drop && moving) dropOnGroup(g);
      return;
    }
    endDrag();
    if (!moving || moving.id === target.id) return;
    if (moving.due_date !== target.due_date && target.due_date && target.due_date < t) return; // not into Overdue
    const siblings = flat.filter((x) => x.due_date === target.due_date && x.id !== moving.id);
    const i = siblings.findIndex((x) => x.id === target.id);
    const prev = siblings[i - 1];
    const patch = { position: prev ? (prev.position + target.position) / 2 : target.position - 1 };
    if (moving.due_date !== target.due_date) patch.due_date = target.due_date;
    save(moving, patch);
  };

  const rowDrag = (task, g) => (view === 'done' ? undefined : {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(TASK_TYPE, String(task.id));
      e.dataTransfer.effectAllowed = 'move';
      setDragId(task.id);
    },
    onDragEnd: endDrag,
    onDragOver: (e) => {
      if (!hasType(e, TASK_TYPE) || !dragId) return;
      e.preventDefault();
      e.stopPropagation();
      const at = reorderable ? task.id : `g:${g.key}`;
      if (dropAt !== at) setDropAt(at);
    },
    onDrop: (e) => {
      if (!hasType(e, TASK_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      dropOnRow(task, g);
    },
  });

  const dropZone = (key, accepts, onDrop) => ({
    onDragOver: (e) => {
      if (!accepts.some((type) => hasType(e, type))) return;
      e.preventDefault();
      if (dropAt !== key) setDropAt(key);
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget) && dropAt === key) setDropAt(null); },
    onDrop: (e) => {
      const type = accepts.find((x) => hasType(e, x));
      if (!type) return;
      e.preventDefault();
      const id = Number(e.dataTransfer.getData(type));
      endDrag();
      onDrop(type, id);
    },
  });

  // Dropping on a group gives the dragged tasks what the group stands for: its day, priority or list.
  const dropOnGroup = (g) => {
    const [[key, value]] = Object.entries(g.drop);
    const moving = dragged().filter((x) => (x[key] ?? null) !== value);
    if (moving.length) updateTasks(moving, g.drop, dialog, changed, g.dropLabel);
  };
  const groupDrop = (g) => (!g.drop || view === 'done' ? {} : dropZone(`g:${g.key}`, [TASK_TYPE], () => dropOnGroup(g)));

  // ---------- lists ----------
  const editList = async (list) => {
    const r = await dialog.open((close) => <ListDialog list={list} close={close} />);
    if (!r) return;
    try {
      if (list) await api.updateTaskList(list.id, r);
      else {
        const { id } = await api.createTaskList(r);
        switchView(`list:${id}`);
      }
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const deleteList = async (list) => {
    const n = (tasks ?? []).filter((x) => x.list_id === list.id).length;
    let deleteItsTasks = false;
    if (n) {
      const choice = await dialog.choose({
        title: `Delete “${list.name}”?`,
        message: `It has ${plural(n, 'task')} still to do.`,
        options: [
          { value: 'keep', label: 'Move its tasks to the Inbox' },
          { value: 'delete', label: 'Delete its tasks too' },
        ],
        okLabel: 'Delete list',
      });
      if (!choice) return;
      deleteItsTasks = choice === 'delete';
    } else if (!await dialog.confirm({ title: `Delete “${list.name}”?`, okLabel: 'Delete', danger: true })) {
      return;
    }
    try {
      await api.deleteTaskList(list.id, deleteItsTasks);
      if (view === `list:${list.id}`) switchView('all');
      dialog.toast(`Deleted “${list.name}”`);
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const listMenu = (list) => [
    { label: 'Rename or recolor…', onClick: () => editList(list) },
    'sep',
    { label: 'Delete list…', danger: true, onClick: () => deleteList(list) },
  ];
  const moveListBefore = async (movingId, target) => {
    const others = lists.filter((l) => l.id !== movingId);
    const i = others.findIndex((l) => l.id === target.id);
    const prev = others[i - 1];
    try {
      await api.updateTaskList(movingId, { position: prev ? (prev.position + target.position) / 2 : target.position - 1 });
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const rowMenu = (task) => (task.completed_at ? [] : [
    'sep',
    ...[{ id: null, name: 'Inbox' }, ...lists].filter((l) => (l.id ?? null) !== (task.list_id ?? null)).slice(0, 8)
      .map((l) => ({ label: `Move to ${l.name}`, onClick: () => updateTasks([task], { list_id: l.id }, dialog, changed, `Moved to ${l.name}`) })),
  ]);

  // ---------- rendering ----------
  const viewInfo = VIEWS.find((v) => v.key === view)
    ?? (currentList ? { key: view, title: currentList.name, icon: 'list', color: tagColor(currentList.color) ?? '#64748b' } : VIEWS[2]);
  const quickDefaults = view === 'today' || view === 'upcoming' ? { due_date: t } : { list_id: listIdOf(view) };
  const subtitle = view === 'today' ? formatLongDate(t)
    : view === 'done' ? (done ? (done.length < 300 ? plural(done.length, 'completed task') : 'The latest 300') : '')
      : narrowed ? `${shown.length} of ${plural(inThisView.length, 'task')}`
      : [plural(shown.length, 'task'), shown.filter((x) => x.due_date && x.due_date < t).length && `${shown.filter((x) => x.due_date && x.due_date < t).length} overdue`]
        .filter(Boolean).join(' · ');
  const empty = EMPTY[view.startsWith('list:') ? 'list' : view];
  const loading = tasks === null || (view === 'done' && done === null);

  const railItem = (v, count, drop) => (
    <button key={v.key} type="button" className={`rail-item ${view === v.key ? 'is-active' : ''} ${dropAt === `r:${v.key}` ? 'is-drop' : ''}`}
      onClick={() => switchView(v.key)} {...(drop ? dropZone(`r:${v.key}`, [TASK_TYPE], drop) : {})}>
      <span className="rail-icon" style={{ '--c': v.color }}><Icon name={v.icon} size={15} /></span>
      <span className="rail-label">{v.title}</span>
      {count > 0 && <span className={`rail-count ${v.key === 'today' && counts.overdue ? 'is-overdue' : ''}`}>{count}</span>}
    </button>
  );

  return (
    <div className="page page-tasks">
      <div className={`tasks-layout ${detail ? 'has-detail' : ''}`}>
        <nav className="tasks-rail" aria-label="Task views">
          <div className="rail-head mobile-only">
            <button className="icon-btn" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
          </div>
          {railItem(VIEWS[0], counts.today, () => updateTasks(dragged(), { due_date: t }, dialog, changed, 'Moved to today'))}
          {railItem(VIEWS[1], counts.upcoming)}
          {railItem(VIEWS[2], counts.all)}
          {railItem(VIEWS[3], counts.inbox, () => updateTasks(dragged(), { list_id: null }, dialog, changed, 'Moved to the Inbox'))}
          {railItem(VIEWS[4], 0)}
          <div className="rail-section">
            <span>Lists</span>
            <button type="button" className="icon-btn" onClick={() => editList(null)} title="New list" aria-label="New list">
              <Icon name="plus" size={15} />
            </button>
          </div>
          {lists.map((l) => (
            <button key={l.id} type="button" draggable
              className={`rail-item ${view === `list:${l.id}` ? 'is-active' : ''} ${dropAt === `r:list:${l.id}` ? 'is-drop' : ''}`}
              onClick={() => switchView(`list:${l.id}`)} onContextMenu={(e) => dialog.contextMenu(e, listMenu(l))}
              onDragStart={(e) => { e.dataTransfer.setData(LIST_TYPE, String(l.id)); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={endDrag}
              {...dropZone(`r:list:${l.id}`, [TASK_TYPE, LIST_TYPE], (type, id) => {
                if (type === LIST_TYPE) { if (id !== l.id) moveListBefore(id, l); return; }
                const moving = dragged().filter((x) => x.list_id !== l.id);
                if (moving.length) updateTasks(moving, { list_id: l.id }, dialog, changed, `Moved to ${l.name}`);
              })}>
              <span className="rail-dot" style={{ '--tag': tagColor(l.color) ?? 'var(--muted)' }} />
              <span className="rail-label">{l.name}</span>
              {l.open > 0 && <span className="rail-count">{l.open}</span>}
            </button>
          ))}
          {lists.length === 0 && <button type="button" className="rail-hint" onClick={() => editList(null)}>Make lists like Church, Home or School</button>}
        </nav>

        <section className="tasks-main">
          <header className="tasks-head">
            <span className="tasks-head-icon" style={{ '--c': viewInfo.color }}>
              {currentList ? <span className="rail-dot big" style={{ '--tag': viewInfo.color }} /> : <Icon name={viewInfo.icon} size={20} />}
            </span>
            <div className="tasks-head-text">
              <h1>{viewInfo.title}</h1>
              {subtitle && <p className="muted">{subtitle}</p>}
            </div>
            <div className="page-actions">
              {onPlan && <button className="btn btn-small" onClick={onPlan} title="Back to Plan: the calendar and today’s tasks"><Icon name="plan" size={14} /> Plan</button>}
              {view === 'done' && done?.length > 0 && (
                <button className="btn btn-small btn-danger-text" onClick={() => deleteCompleted(dialog, done.length, changed)}>
                  <Icon name="trash" size={14} /> Delete all completed
                </button>
              )}
              {view !== 'done' && flat.length > 0 && (
                <button className={`btn btn-small ${selecting ? 'is-active' : ''}`} onClick={() => (selecting ? clearSelection() : setSelecting(true))}>
                  <Icon name="check" size={14} /> {selecting ? 'Done' : 'Select'}
                </button>
              )}
              {currentList && (
                <Menu align="right" trigger={({ toggle: open }) => (
                  <button className="icon-btn" onClick={open} aria-label="List options" title="List options"><Icon name="more" /></button>
                )} items={listMenu(currentList)} />
              )}
            </div>
          </header>

          <div className="tasks-toolbar">
            <label className="task-search">
              <Icon name="search" size={15} />
              <input ref={searchRef} value={query} placeholder="Search tasks" aria-label="Search tasks"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
              {query && <button type="button" className="icon-btn" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="x" size={14} /></button>}
              {!query && <kbd className="search-kbd">/</kbd>}
            </label>
            <FilterButton filter={filter} setFilter={setFilter} lists={lists} showLists={!currentList && view !== 'inbox'} />
            {view !== 'done' && (
              <Menu align="right" trigger={({ toggle: open }) => (
                <button className="btn btn-small tool-btn" onClick={open} aria-label="Sort">
                  <Icon name="sort" size={14} /><span className="tool-label">{SORTS.find((x) => x.key === sort)?.label ?? 'Due date'}</span>
                </button>
              )} items={SORTS.filter((x) => !(x.key === 'list' && currentList)).map((x) => ({
                label: `${x.key === sort ? '✓ ' : '\u2003'}${x.label}`, onClick: () => setSort(x.key),
              }))} />
            )}
          </div>
          {filterCount(filter) > 0 && (
            <div className="filter-chips">
              {filterChips(filter, lists).map((c) => (
                <span key={c.key} className="smart-chip is-filter">
                  {c.label}
                  <button type="button" aria-label={`Remove filter: ${c.label}`} onClick={() => setFilter({ ...filter, ...c.clear })}><Icon name="x" size={11} /></button>
                </span>
              ))}
              <button type="button" className="link-btn" onClick={() => setFilter(DEFAULT_FILTER)}>Clear filters</button>
            </div>
          )}

          {view !== 'done' && (
            <QuickAdd ref={quickRef} lists={lists} defaults={quickDefaults} onCreated={onCreated} onListsChanged={load}
              placeholder={currentList ? `Add a task to ${currentList.name}` : view === 'today' ? 'Add a task for today' : 'Add a task'} />
          )}

          {selected.size > 0 && (
            <div className="bulk-bar" role="toolbar" aria-label="Selected tasks">
              <span className="bulk-count">{selected.size} selected</span>
              <button className="btn btn-small" onClick={bulkDone}><Icon name="check" size={14} /> Complete</button>
              <Menu trigger={({ toggle: open }) => <button className="btn btn-small" onClick={open}><Icon name="calendar" size={14} /> Date</button>} items={[
                { label: 'Today', onClick: () => bulkUpdate({ due_date: t }, 'Moved to today') },
                { label: 'Tomorrow', onClick: () => bulkUpdate({ due_date: addDays(t, 1) }, 'Moved to tomorrow') },
                { label: 'Next week', onClick: () => bulkUpdate({ due_date: nextMonday() }, 'Moved to next week') },
                { label: 'Pick a date…', onClick: () => { pickDate(selectedTasks); clearSelection(); } },
                'sep',
                { label: 'No date', onClick: () => bulkUpdate({ due_date: null }, 'Dates removed') },
              ]} />
              <Menu trigger={({ toggle: open }) => <button className="btn btn-small" onClick={open}><Icon name="list" size={14} /> List</button>} items={[
                { label: 'Inbox', onClick: () => bulkUpdate({ list_id: null }, 'Moved to the Inbox') },
                ...lists.map((l) => ({ label: l.name, onClick: () => bulkUpdate({ list_id: l.id }, `Moved to ${l.name}`) })),
              ]} />
              <Menu trigger={({ toggle: open }) => <button className="btn btn-small" onClick={open}><Icon name="flag" size={14} /> Priority</button>} items={
                [3, 2, 1, 0].map((p) => ({ label: PRIORITY_LABEL[p] || 'None', onClick: () => bulkUpdate({ priority: p }, 'Priority changed') }))
              } />
              <button className="btn btn-small btn-danger-text" onClick={bulkDelete}><Icon name="trash" size={14} /> Delete</button>
              <span className="bulk-spacer" />
              <button className="btn btn-small" onClick={() => setSelected(new Set(flat.map((x) => x.id)))}>All</button>
              <button className="icon-btn" onClick={clearSelection} aria-label="Clear selection" title="Clear selection (Esc)"><Icon name="x" size={16} /></button>
            </div>
          )}

          {loading && <p className="card-empty">Loading…</p>}
          {!loading && flat.length === 0 && narrowed && (
            <div className="tasks-empty">
              <span className="tasks-empty-icon" style={{ '--c': viewInfo.color }}><Icon name="search" size={28} /></span>
              <h3>No tasks match</h3>
              <p className="muted">
                {inThisView.length ? `None of the ${plural(inThisView.length, 'task')} here match.` : 'There are no tasks here.'}
              </p>
              <div className="tasks-empty-actions">
                {words.length > 0 && !['all', 'done'].includes(view) && (
                  <button className="btn btn-small" onClick={() => switchView('all')}>Search all tasks</button>
                )}
                <button className="btn btn-small" onClick={() => { setQuery(''); setFilter(DEFAULT_FILTER); }}>Clear search and filters</button>
              </div>
            </div>
          )}
          {!loading && flat.length === 0 && !narrowed && !groups.some((g) => g.keep) && (
            <div className="tasks-empty">
              <span className="tasks-empty-icon" style={{ '--c': viewInfo.color }}><Icon name={empty[0]} size={28} /></span>
              <h3>{empty[1]}</h3>
              <p className="muted">{empty[2]}</p>
            </div>
          )}

          {!loading && groups.map((g) => (
            <section key={g.key} className={`task-group ${g.compact ? 'is-compact' : ''} ${g.tone === 'overdue' ? 'is-overdue' : ''} ${dropAt === `g:${g.key}` ? 'is-drop' : ''}`}
              {...groupDrop(g)}>
              <h3 className="group-head">
                {g.color !== undefined && <span className="tag-dot" style={{ '--tag': tagColor(g.color) ?? 'var(--muted)' }} />}
                <span className="group-name">{g.title}</span>
                {g.sub && <span className="group-sub">{g.sub}</span>}
                {g.tasks.length > 0 && <span className="group-count">{g.tasks.length}</span>}
                {g.tone === 'overdue' && g.tasks.length > 0 && view !== 'done' && (
                  <button type="button" className="link-btn group-action"
                    onClick={() => updateTasks(g.tasks, { due_date: t }, dialog, changed, `Moved ${plural(g.tasks.length, 'task')} to today`)}>
                    Move all to today
                  </button>
                )}
              </h3>
              {g.tasks.length === 0 && g.keep && <div className="group-empty">{g.key === 'today' && view === 'today' ? 'Nothing due today' : 'Nothing planned'}</div>}
              {g.tasks.map((x) => (
                <div key={x.id} className={`task-slot ${dropAt === x.id && dragId !== x.id ? 'is-drop-before' : ''} ${dragId === x.id ? 'is-dragging' : ''}`}>
                  <TaskRow task={x} onToggle={toggle} onOpen={(task) => setDetailId(task.id === detailId ? null : task.id)}
                    onDeleted={changed} showDate={!g.oneDay || x.due_date !== g.oneDay} showList={!currentList} search={words}
                    onRename={(task, title) => save(task, { title })} onStepsChange={(task, steps) => save(task, { steps })}
                    onSelectClick={view === 'done' ? undefined : onSelectClick} selected={selected.has(x.id)}
                    selecting={selecting || selected.size > 0} active={detailId === x.id}
                    dragProps={rowDrag(x, g)} menuExtra={rowMenu(x)} />
                </div>
              ))}
            </section>
          ))}
          {!loading && view !== 'done' && flat.length > 0 && (
            <p className="tasks-tip muted">
              Tip: drag tasks {reorderable ? 'to reorder them, or ' : ''}onto a {sort === 'priority' ? 'priority' : 'day'} or list.
              Ctrl-click or Shift-click to select several. Press N to add a task, / to search.
            </p>
          )}
        </section>

        {detail && (
          <TaskDetail key={detail.id} task={detail} lists={lists} onSave={(patch) => save(detail, patch)}
            onToggle={(task) => { toggle(task); if (!task.completed_at) setDetailId(null); }}
            onDelete={(task) => { setDetailId(null); deleteTasks([task], dialog, changed); }}
            onClose={() => setDetailId(null)} onOpenNote={onOpenNote} />
        )}
      </div>
    </div>
  );
}

/** Completed tasks by the day they were done. */
function doneGroups(tasks) {
  const byDay = new Map();
  for (const x of tasks) {
    const day = wallClock(x.completed_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(x);
  }
  return [...byDay].map(([day, list]) => ({ key: day, title: relativeDay(day), oneDay: false, tasks: list }));
}

async function deleteCompleted(dialog, shown, onChanged) {
  // The view shows at most 300; past that, say "all" rather than a number that's too small.
  const n = shown < 300 ? shown : null;
  const ok = await dialog.confirm({
    title: n === 1 ? 'Delete the completed task?' : `Delete ${n ? `all ${n}` : 'all'} completed tasks?`,
    message: 'They’ll be permanently deleted. Tasks still to do aren’t affected.',
    okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    const { deleted } = await api.deleteCompletedTasks();
    dialog.toast(`Deleted ${plural(deleted, 'completed task')}`);
    onChanged();
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

/** Name and color for a new or existing list. Resolves to { name, color } or null. */
function ListDialog({ list, close }) {
  const [name, setName] = useState(list?.name ?? '');
  const [color, setColor] = useState(list?.color ?? 'blue');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) close({ name: name.trim(), color: color || null }); }}>
      <h2>{list ? 'Edit list' : 'New list'}</h2>
      <label className="field-label" htmlFor="list-name">Name</label>
      <input id="list-name" className="input" autoFocus value={name} placeholder="e.g. Church, Home, School" onChange={(e) => setName(e.target.value)} />
      <label className="field-label">Color</label>
      <div className="swatches" role="radiogroup" aria-label="Color">
        {Object.entries(TAG_COLORS).map(([key, hex]) => (
          <button key={key} type="button" role="radio" aria-checked={color === key} aria-label={key} title={key}
            className={`swatch ${color === key ? 'is-active' : ''}`} style={{ '--swatch': hex }} onClick={() => setColor(key)} />
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>{list ? 'Save' : 'Create list'}</button>
      </div>
    </form>
  );
}

/** Pick a due date. Resolves to 'YYYY-MM-DD', '' for no date, or null when cancelled. */
function DatePrompt({ close }) {
  const [date, setDate] = useState(todayStr());
  return (
    <form onSubmit={(e) => { e.preventDefault(); close(date); }}>
      <h2>Move to date</h2>
      <input className="input" type="date" autoFocus value={date} onChange={(e) => setDate(e.target.value)} aria-label="Due date" />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary">Move</button>
      </div>
    </form>
  );
}

/** Readable chips for the active filters; `clear` is what removing one sets back. */
function filterChips(f, lists) {
  const chips = [];
  if (f.when !== 'any') chips.push({ key: 'when', label: WHEN.find(([k]) => k === f.when)?.[1], clear: { when: 'any' } });
  if (f.priorities.length) {
    chips.push({ key: 'prio', label: `Priority: ${f.priorities.map((p) => PRIORITY_LABEL[p] || 'None').join(', ')}`, clear: { priorities: [] } });
  }
  if (f.lists.length) {
    const names = f.lists.map((id) => (id === 0 ? 'Inbox' : lists.find((l) => l.id === id)?.name)).filter(Boolean);
    chips.push({ key: 'lists', label: `List: ${names.join(', ') || '(deleted)'}`, clear: { lists: [] } });
  }
  if (f.repeating) chips.push({ key: 'rep', label: 'Repeating', clear: { repeating: false } });
  if (f.steps) chips.push({ key: 'steps', label: 'Has steps', clear: { steps: false } });
  if (f.note) chips.push({ key: 'note', label: 'Linked to a note', clear: { note: false } });
  if (f.hideLater) chips.push({ key: 'later', label: 'Started only', clear: { hideLater: false } });
  return chips;
}

/** The Filter button and its panel. Changes apply as you click. */
function FilterButton({ filter, setFilter, lists, showLists }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const n = filterCount(filter);
  const set = (patch) => setFilter({ ...filter, ...patch });
  const toggleIn = (key, v) => set({ [key]: filter[key].includes(v) ? filter[key].filter((x) => x !== v) : [...filter[key], v] });

  return (
    <div className="menu-wrap filter-wrap" ref={ref}>
      <button type="button" className={`btn btn-small tool-btn ${n ? 'is-active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="filter" size={14} /><span className="tool-label">Filter</span>{n > 0 && <span className="tool-count">{n}</span>}
      </button>
      {open && (
        <div className="menu menu-right filter-panel" role="dialog" aria-label="Filter tasks">
          <h5>Due</h5>
          <div className="filter-options">
            {WHEN.map(([k, label]) => (
              <button key={k} type="button" className={`filter-pill ${filter.when === k ? 'is-on' : ''}`} onClick={() => set({ when: k })}>{label}</button>
            ))}
          </div>
          <h5>Priority</h5>
          <div className="filter-options">
            {[3, 2, 1, 0].map((p) => (
              <button key={p} type="button" className={`filter-pill prio-pill prio-${p} ${filter.priorities.includes(p) ? 'is-on' : ''}`}
                onClick={() => toggleIn('priorities', p)}>
                {p > 0 && <Icon name="flag" size={12} />}{PRIORITY_LABEL[p] || 'None'}
              </button>
            ))}
          </div>
          {showLists && (
            <>
              <h5>List</h5>
              <div className="filter-options">
                {[{ id: 0, name: 'Inbox' }, ...lists].map((l) => (
                  <button key={l.id} type="button" className={`filter-pill ${filter.lists.includes(l.id) ? 'is-on' : ''}`} onClick={() => toggleIn('lists', l.id)}>
                    {l.id !== 0 && <span className="tag-dot" style={{ '--tag': tagColor(l.color) ?? 'var(--muted)' }} />}{l.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <h5>Only tasks that</h5>
          <div className="filter-checks">
            {[['repeating', 'Repeat'], ['steps', 'Have steps'], ['note', 'Are linked to a note'], ['hideLater', 'Have started (hide ones with a later start date)']].map(([k, label]) => (
              <label key={k} className="check"><input type="checkbox" checked={filter[k]} onChange={() => set({ [k]: !filter[k] })} />{label}</label>
            ))}
          </div>
          <div className="filter-foot">
            <button type="button" className="btn btn-small" disabled={!n} onClick={() => setFilter(DEFAULT_FILTER)}>Reset</button>
            <button type="button" className="btn btn-small btn-primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
