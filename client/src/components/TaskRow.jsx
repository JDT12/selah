import { useEffect, useRef, useState } from 'react';
import { addDays, formatTime, relativeDay, todayStr } from '../time.js';
import { describeRule } from './RecurrenceEditor.jsx';
import { tagColor } from '../tagColors.js';
import { deleteTasks, toggleTask, updateTasks } from '../taskActions.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';

export { toggleTask };
export const PRIORITY_LABEL = ['', 'Low', 'Medium', 'High'];

/** 'is-overdue' / 'is-today' / 'is-soon' for a due date chip. */
export function dueClass(date) {
  if (!date) return '';
  const t = todayStr();
  if (date < t) return 'is-overdue';
  if (date === t) return 'is-today';
  return date === addDays(t, 1) ? 'is-soon' : '';
}

/** Whether a task has a start date that hasn't come yet. */
export const notStarted = (task) => !task.completed_at && !!task.start_date && task.start_date > todayStr();

/** text with each search word wrapped in <mark>. */
export function highlight(text, words) {
  if (!words?.length) return text;
  const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const hay = fold(text);
  const hits = [];
  for (const w of words) {
    for (let i = hay.indexOf(w); i >= 0 && w; i = hay.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a < at) continue;
    out.push(text.slice(at, a), <mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

/** A task's steps progress, '2/5', or '' when it has none. */
const progress = (steps) => (steps?.length ? `${steps.filter((s) => s.done).length}/${steps.length}` : '');

/**
 * One task. Optional extras (the Tasks page uses them all):
 * - onDeleted: adds Delete (with Undo) to the right-click menu; runs after any change made from the menu.
 * - onRename(task, title): double-clicking the title edits it in place.
 * - onStepsChange(task, steps): clicking the steps count ticks steps off in place.
 * - onSelectClick(e, task): return true to take the click (Ctrl/Shift-click selection) instead of opening.
 * - selected / selecting (tick boxes for selection) / active (open in the side panel), dragProps, menuExtra.
 * - search: words to highlight in the title.
 */
export default function TaskRow({
  task, onToggle, onOpen, onDeleted, showDate = true, showList = true,
  onRename, onStepsChange, onSelectClick, selected = false, selecting = false, active = false, dragProps, menuExtra = [], search,
}) {
  const dialog = useDialog();
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const done = !!task.completed_at || pending;
  const listColor = tagColor(task.list_color);
  const steps = task.steps ?? [];

  const toggle = async (e) => {
    e?.stopPropagation();
    if (!task.completed_at) setPending(true);
    try {
      // A moment for the tick to show before the row goes away.
      await Promise.all([onToggle(task), !task.completed_at && new Promise((r) => setTimeout(r, 280))]);
    } finally {
      setPending(false);
    }
  };

  const reschedule = (date, label) => updateTasks([task], { due_date: date }, dialog, onDeleted, label);
  const menuItems = [
    { label: 'Open…', onClick: () => onOpen(task) },
    onRename && { label: 'Rename', onClick: () => setEditing(true) },
    { label: done ? 'Mark not done' : 'Mark done', onClick: () => toggle() },
    onDeleted && !task.completed_at && 'sep',
    onDeleted && !task.completed_at && task.due_date !== todayStr() && { label: 'Due today', onClick: () => reschedule(todayStr(), 'Moved to today') },
    onDeleted && !task.completed_at && { label: 'Due tomorrow', onClick: () => reschedule(addDays(todayStr(), 1), 'Moved to tomorrow') },
    onDeleted && !task.completed_at && task.due_date && { label: 'No date', onClick: () => reschedule(null, 'Date removed') },
    ...menuExtra,
    onDeleted && 'sep',
    onDeleted && { label: 'Delete task', danger: true, onClick: () => deleteTasks([task], dialog, onDeleted) },
  ];

  const click = (e) => {
    if (editing) return;
    if (onSelectClick?.(e, task)) return;
    onOpen(task);
  };

  return (
    <div className={`task-row ${done ? 'is-done' : ''} ${notStarted(task) ? 'is-later' : ''} ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}`}
      onClick={click} role="button" tabIndex={0} data-task={task.id} {...dragProps}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(task); }}
      onContextMenu={(e) => dialog.contextMenu(e, menuItems)}>
      {dragProps && <span className="task-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>}
      {selecting && (
        <span className={`task-select ${selected ? 'is-on' : ''}`} aria-hidden="true">
          {selected && <Icon name="check" size={12} strokeWidth={3} />}
        </span>
      )}
      <button type="button" className={`task-check prio-${task.priority}`} onClick={toggle}
        aria-label={done ? 'Mark not done' : 'Mark done'} aria-pressed={done}>
        <Icon name="check" size={12} strokeWidth={3} />
      </button>
      <div className="task-main">
        {editing
          ? <TitleEditor value={task.title} onDone={(v) => { setEditing(false); if (v && v !== task.title) onRename(task, v); }} />
          : (
            <div className="task-title" onDoubleClick={onRename ? (e) => { e.stopPropagation(); setEditing(true); } : undefined}>
              {highlight(task.title, search)}
            </div>
          )}
        <div className="task-meta">
          {showDate && task.due_date && (
            <span className={`chip chip-date ${task.completed_at ? '' : dueClass(task.due_date)}`}>
              <Icon name="calendar" size={12} />
              {relativeDay(task.due_date)}{task.due_time ? `, ${formatTime(task.due_time)}` : ''}
            </span>
          )}
          {notStarted(task) && (
            <span className="chip chip-start" title="Not started yet: it stays out of Today until then">
              <Icon name="clock" size={12} />Starts {relativeDay(task.start_date)}
            </span>
          )}
          {!showDate && task.due_time && <span className="chip"><Icon name="clock" size={12} />{formatTime(task.due_time)}</span>}
          {task.rrule && <span className="chip" title={describeRule(task.rrule)}><Icon name="repeat" size={12} />{describeRule(task.rrule)}</span>}
          {steps.length > 0 && (
            onStepsChange
              ? (
                <button type="button" className={`chip chip-btn ${expanded ? 'is-open' : ''}`} title="Show steps"
                  onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
                  <Icon name="steps" size={12} />{progress(steps)}
                </button>
              )
              : <span className="chip"><Icon name="steps" size={12} />{progress(steps)}</span>
          )}
          {task.note_id && <span className="chip" title="Linked note"><Icon name="note" size={12} /></span>}
          {task.description && <span className="chip chip-desc" title={task.description}><Icon name="text" size={12} />{task.description.split('\n')[0]}</span>}
          {showList && task.list_name && (
            <span className="chip chip-list"><span className="tag-dot" style={{ '--tag': listColor ?? 'var(--muted)' }} />{task.list_name}</span>
          )}
          {task.priority > 0 && (
            <span className={`chip prio-tag prio-${task.priority}`}><Icon name="flag" size={12} />{PRIORITY_LABEL[task.priority]}</span>
          )}
        </div>
        {expanded && onStepsChange && (
          <ul className="task-steps-inline" onClick={(e) => e.stopPropagation()}>
            {steps.map((s) => (
              <li key={s.id} className={s.done ? 'is-done' : ''}>
                <label>
                  <input type="checkbox" checked={s.done}
                    onChange={() => onStepsChange(task, steps.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)))} />
                  <span>{s.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** In-place title editor: Enter or leaving the field saves, Escape cancels. */
function TitleEditor({ value, onDone }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  const finished = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (val) => {
    if (finished.current) return;
    finished.current = true;
    onDone(val);
  };
  return (
    <input ref={ref} className="task-title-input" value={v} aria-label="Task title"
      onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(v.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v.trim());
        if (e.key === 'Escape') finish(null);
      }} />
  );
}
