import { useEffect, useRef, useState } from 'react';
import { formatDate } from '../api.js';
import { addDays, todayStr } from '../time.js';
import { tagColor } from '../tagColors.js';
import RecurrenceEditor from './RecurrenceEditor.jsx';
import NotePicker from './NotePicker.jsx';
import StepsEditor from './StepsEditor.jsx';
import ReminderPicker from './ReminderPicker.jsx';
import { defaultReminders } from '../reminders.js';
import Icon from './Icon.jsx';
import { PRIORITY_LABEL } from './TaskRow.jsx';

/** The next Monday after today. */
export function nextMonday() {
  const t = todayStr();
  const wd = (new Date(`${t}T00:00Z`).getUTCDay() + 6) % 7;
  return addDays(t, 7 - wd);
}

/**
 * The Tasks page's side panel. Every change saves straight away (text fields when you leave them).
 * onSave(patch) saves and reloads; onToggle, onDelete and onClose act on the task.
 */
export default function TaskDetail({ task, lists, onSave, onToggle, onDelete, onClose, onOpenNote }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [shownId, setShownId] = useState(task.id);
  const titleRef = useRef(null);
  if (task.id !== shownId) {
    setShownId(task.id);
    setTitle(task.title);
    setDescription(task.description);
  }
  // Keep the textarea as tall as its text.
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);

  const saveTitle = () => {
    const v = title.trim();
    if (!v) setTitle(task.title);
    else if (v !== task.title) onSave({ title: v });
  };
  const setDue = (due_date) => {
    if (!due_date) onSave({ due_date: null, due_time: null, rrule: null });
    else onSave({ due_date });
  };
  const t = todayStr();
  const done = !!task.completed_at;

  return (
    <aside className="task-detail" aria-label="Task details">
      <div className="td-top">
        <button type="button" className={`task-check prio-${task.priority} ${done ? 'is-on' : ''}`} onClick={() => onToggle(task)}
          aria-label={done ? 'Mark not done' : 'Mark done'} aria-pressed={done}>
          <Icon name="check" size={12} strokeWidth={3} />
        </button>
        <textarea ref={titleRef} className={`td-title ${done ? 'is-done' : ''}`} rows={1} value={title} aria-label="Title"
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details" title="Close"><Icon name="x" size={18} /></button>
      </div>

      <section className="td-section">
        <h4><Icon name="steps" size={14} /> Steps</h4>
        <StepsEditor value={task.steps} onChange={(steps) => onSave({ steps })} />
      </section>

      <section className="td-section">
        <h4><Icon name="calendar" size={14} /> Due</h4>
        <div className="td-quick">
          {[['Today', t], ['Tomorrow', addDays(t, 1)], ['Next week', nextMonday()]].map(([label, d]) => (
            <button key={label} type="button" className={`btn btn-small ${task.due_date === d ? 'is-active' : ''}`} onClick={() => setDue(d)}>{label}</button>
          ))}
          {task.due_date && <button type="button" className="btn btn-small" onClick={() => setDue(null)}>No date</button>}
        </div>
        <div className="when-row">
          <input className="input input-inline" type="date" value={task.due_date ?? ''} aria-label="Due date"
            onChange={(e) => setDue(e.target.value || null)} />
          {task.due_date && (
            <input className="input input-inline" type="time" value={task.due_time ?? ''} aria-label="Due time"
              onChange={(e) => onSave({ due_time: e.target.value || null })} />
          )}
        </div>
        <div className="td-start">
          <span className="td-label"><Icon name="clock" size={13} /> Start</span>
          <div className="when-row">
            <input className="input input-inline" type="date" value={task.start_date ?? ''} aria-label="Start date"
              max={task.due_date ?? undefined} onChange={(e) => onSave({ start_date: e.target.value || null })} />
            {task.start_date && <button type="button" className="btn btn-small" onClick={() => onSave({ start_date: null })}>Clear</button>}
          </div>
          <p className="td-hint muted">
            {task.start_date && task.start_date > t ? 'Hidden from Today until then.' : 'Optional: keeps it out of Today until you can start on it.'}
          </p>
        </div>
        {task.due_date && (
          <div className="td-repeat">
            <span className="td-label"><Icon name="clock" size={13} /> Remind me</span>
            <ReminderPicker value={task.reminders ?? defaultReminders('task', !!task.due_time)} untimed={!task.due_time}
              onChange={(reminders) => onSave({ reminders })} />
          </div>
        )}
        {task.due_date && (
          <div className="td-repeat">
            <span className="td-label"><Icon name="repeat" size={13} /> Repeat</span>
            <RecurrenceEditor value={task.rrule} onChange={(rrule) => onSave({ rrule })} startDate={task.due_date} />
          </div>
        )}
      </section>

      <section className="td-section td-two">
        <div>
          <h4><Icon name="list" size={14} /> List</h4>
          <div className="td-select">
            <span className="tag-dot" style={{ '--tag': tagColor(task.list_color) ?? 'var(--muted)' }} />
            <select className="input" value={task.list_id ?? ''} aria-label="List"
              onChange={(e) => onSave({ list_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Inbox</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <h4><Icon name="flag" size={14} /> Priority</h4>
          <div className="prio-picker" role="radiogroup" aria-label="Priority">
            {[0, 3, 2, 1].map((p) => (
              <button key={p} type="button" role="radio" aria-checked={task.priority === p} title={PRIORITY_LABEL[p] || 'None'}
                className={`prio-opt prio-${p} ${task.priority === p ? 'is-active' : ''}`} onClick={() => onSave({ priority: p })}>
                {p ? <Icon name="flag" size={14} /> : <Icon name="x" size={13} />}
                <span>{PRIORITY_LABEL[p] || 'None'}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="td-section">
        <h4><Icon name="note" size={14} /> Linked note</h4>
        <NotePicker value={task.note_id} onChange={(note_id) => onSave({ note_id })} onOpen={onOpenNote} />
      </section>

      <section className="td-section">
        <h4><Icon name="text" size={14} /> Details</h4>
        <textarea className="input td-notes" rows={4} value={description} placeholder="Add details"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== task.description && onSave({ description })} />
      </section>

      <footer className="td-foot">
        <span className="muted">{done ? `Completed ${formatDate(task.completed_at)}` : `Created ${formatDate(task.created_at)}`}</span>
        <button type="button" className="btn btn-small btn-danger-text" onClick={() => onDelete(task)}>
          <Icon name="trash" size={14} /> Delete
        </button>
      </footer>
    </aside>
  );
}
