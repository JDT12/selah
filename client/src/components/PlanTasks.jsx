import { useCallback, useEffect, useRef, useState } from 'react';
import { Draggable } from '@fullcalendar/interaction';
import { api } from '../api.js';
import { relativeDay, todayStr } from '../time.js';
import { useDialog } from './Dialogs.jsx';
import QuickAdd from './QuickAdd.jsx';
import TaskDialog from './TaskDialog.jsx';
import { toggleTask } from '../taskActions.js';
import Icon from './Icon.jsx';
import { useStoredState } from '../useStoredState.js';

/**
 * Plan's task panel (7.1): what's overdue, today's tasks and the ones with no date, beside the calendar. Drag one
 * onto a day (or a time in the week and day views) to give it a date. `version` reloads it; `onChanged` runs after a
 * change here so the calendar can refetch.
 */
export default function PlanTasks({ version, onChanged, onOpenNote, onAllTasks }) {
  const dialog = useDialog();
  const [tasks, setTasks] = useState(null);
  const [lists, setLists] = useState([]);
  const [list, setList] = useStoredState('noteapp.plan.list', '');
  const box = useRef(null);
  const load = useCallback(() => {
    api.listTasks().then(setTasks).catch((e) => { dialog.toast(e.message, 'error'); setTasks([]); });
    api.listTaskLists().then(setLists).catch(() => {});
  }, [dialog]);
  useEffect(() => { load(); }, [load, version]);
  const changed = () => { load(); onChanged?.(); };

  // Rows can be dragged onto the calendar (FullCalendar takes them as it would its own events).
  useEffect(() => {
    if (!box.current) return undefined;
    const d = new Draggable(box.current, {
      itemSelector: '.plan-task[data-id]',
      eventData: (el) => ({ title: el.dataset.title, duration: '00:30', create: false }),
    });
    return () => d.destroy();
  }, []);

  const t = todayStr();
  const open = (tasks ?? []).filter((x) => !x.completed_at && (!list || String(x.list_id ?? '') === String(list)));
  const groups = [
    { key: 'late', title: 'Overdue', rows: open.filter((x) => x.due_date && x.due_date < t), late: true },
    { key: 'today', title: 'Today', rows: open.filter((x) => x.due_date === t) },
    { key: 'none', title: 'No date', rows: open.filter((x) => !x.due_date) },
  ];
  const openTask = async (task) => { if (await dialog.open((close) => <TaskDialog task={task} dialog={dialog} close={close} onOpenNote={onOpenNote} onChanged={changed} />)) changed(); };

  return (
    <aside className="plan-tasks" aria-label="Tasks">
      <div className="plan-tasks-head">
        <h2>Tasks</h2>
        {lists.length > 0 && (
          <select className="plan-list" value={list} onChange={(e) => setList(e.target.value)} aria-label="Task list">
            <option value="">All lists</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
      <div className="plan-tasks-add">
        <QuickAdd lists={lists} defaults={{ due_date: t, ...(list ? { list_id: Number(list) } : {}) }} placeholder="Add a task, like “Call Tom Friday”"
          onCreated={(_, body) => { changed(); if (body.due_date !== t) dialog.toast(`Added: ${body.due_date ? relativeDay(body.due_date) : 'No date'}`); }} className="is-compact" />
      </div>
      <div className="plan-tasks-scroll" ref={box}>
        {tasks === null ? <p className="plan-empty">Loading…</p> : groups.map((g) => (
          <section key={g.key} className={`plan-group ${g.late ? 'is-late' : ''}`}>
            <h3>{g.title} · {g.rows.length}</h3>
            {!g.rows.length && <p className="plan-empty">{g.key === 'today' ? 'Nothing due today.' : g.key === 'none' ? 'Every task has a date.' : 'Nothing overdue.'}</p>}
            {g.rows.map((task) => (
              <div key={task.id} className="plan-task" data-id={task.id} data-title={task.title}>
                <button type="button" className="plan-check" onClick={() => toggleTask(task, dialog, changed)} aria-label={`Done: ${task.title}`}><Icon name="check" size={11} /></button>
                <button type="button" className="plan-task-text" onClick={() => openTask(task)}>
                  <span className="plan-task-title">{task.title}</span>
                  <span className="plan-task-meta">{[task.list_name, g.late ? `was due ${relativeDay(task.due_date)}` : task.due_time].filter(Boolean).join(' · ')}</span>
                </button>
                <span className="plan-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="plan-tasks-foot">
        <span><Icon name="grip" size={13} /> Drag a task onto a day to give it a date.</span>
        <button type="button" className="link-btn" onClick={onAllTasks}>All tasks</button>
      </div>
    </aside>
  );
}
