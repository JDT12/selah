import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { todayStr } from '../time.js';
import { deleteTasks } from '../taskActions.js';
import RecurrenceEditor from './RecurrenceEditor.jsx';
import NotePicker from './NotePicker.jsx';
import StepsEditor from './StepsEditor.jsx';
import ReminderPicker from './ReminderPicker.jsx';
import { defaultReminders } from '../reminders.js';

export const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Low' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'High' },
];

/** task: existing task row (edit) or null (create). defaults: { due_date, list_id }. */
export default function TaskDialog({ task, defaults = {}, dialog, close, onOpenNote, onChanged }) {
  const isNew = !task;
  const [title, setTitle] = useState(task?.title ?? '');
  const [dueDate, setDueDate] = useState(task?.due_date ?? defaults.due_date ?? '');
  const [dueTime, setDueTime] = useState(task?.due_time ?? '');
  const [startDate, setStartDate] = useState(task?.start_date ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 0);
  const [rrule, setRrule] = useState(task?.rrule ?? null);
  const [description, setDescription] = useState(task?.description ?? '');
  const [noteId, setNoteId] = useState(task?.note_id ?? null);
  const [listId, setListId] = useState(task?.list_id ?? defaults.list_id ?? null);
  const [steps, setSteps] = useState(task?.steps ?? []);
  const [reminders, setReminders] = useState(task?.reminders ?? null); // null: the usual ones
  const [lists, setLists] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => { api.listTaskLists().then(setLists).catch(() => {}); }, []);

  const changeRule = (r) => {
    setRrule(r);
    if (r && !dueDate) setDueDate(todayStr()); // repeating tasks need a first due date
  };

  const save = async (e) => {
    e.preventDefault();
    if (!title.trim()) return setError('Give the task a title.');
    const body = {
      title: title.trim(), due_date: dueDate || null, due_time: dueDate && dueTime ? dueTime : null,
      priority: Number(priority), rrule: dueDate ? rrule : null, description, note_id: noteId,
      list_id: listId, steps, start_date: startDate || null, reminders,
    };
    try {
      if (isNew) await api.createTask(body);
      else await api.updateTask(task.id, body);
      close(true);
    } catch (err) {
      setError(err.message);
    }
  };

  // Deleting closes the dialog; the toast's Undo puts the task back (onChanged reloads the caller).
  const remove = async () => {
    await deleteTasks([task], dialog, onChanged);
    close(true);
  };

  return (
    <form className="event-dialog" onSubmit={save}>
      <input className="input title-input" autoFocus placeholder="Task" value={title} onChange={(e) => setTitle(e.target.value)} />

      <div className="form-grid">
        <label className="form-label">Due</label>
        <div className="when-row">
          <input className="input input-inline" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {dueDate && <input className="input input-inline" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />}
          {dueDate && (
            <button type="button" className="btn btn-small" onClick={() => { setDueDate(''); setDueTime(''); setRrule(null); }}>
              No date
            </button>
          )}
        </div>

        {dueDate && (
          <>
            <label className="form-label">Remind me</label>
            <ReminderPicker value={reminders ?? defaultReminders('task', !!dueTime)} onChange={setReminders} untimed={!dueTime} />
          </>
        )}

        <label className="form-label">Start</label>
        <div className="when-row">
          <input className="input input-inline" type="date" value={startDate} max={dueDate || undefined}
            onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
          <span className="muted td-hint">Stays out of Today until then</span>
        </div>

        <label className="form-label">Repeat</label>
        <RecurrenceEditor value={rrule} onChange={changeRule} startDate={dueDate || todayStr()} />

        <label className="form-label">List</label>
        <select className="input input-inline" value={listId ?? ''} onChange={(e) => setListId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Inbox</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>

        <label className="form-label">Priority</label>
        <div className="segmented">
          {PRIORITIES.map((p) => (
            <button key={p.value} type="button" className={Number(priority) === p.value ? 'is-active' : ''}
              onClick={() => setPriority(p.value)}>{p.label}</button>
          ))}
        </div>

        <label className="form-label">Steps</label>
        <StepsEditor value={steps} onChange={setSteps} />

        <label className="form-label">Details</label>
        <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add details" />

        <label className="form-label">Note</label>
        <NotePicker value={noteId} onChange={setNoteId} onOpen={(id) => { close(false); onOpenNote?.(id); }} />
      </div>

      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions spread">
        <div>{!isNew && <button type="button" className="btn btn-danger-text" onClick={remove}>Delete</button>}</div>
        <div className="actions-right">
          <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </div>
    </form>
  );
}
