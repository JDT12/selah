import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { addMinutes, diffMinutes, nextHalfHour } from '../time.js';
import RecurrenceEditor from './RecurrenceEditor.jsx';
import NotePicker from './NotePicker.jsx';
import ReminderPicker from './ReminderPicker.jsx';
import { defaultReminders } from '../reminders.js';
import { CategoryPicker } from './EventCategories.jsx';
import { useEventCategories } from '../eventCategories.js';

export { EVENT_COLORS } from '../eventCategories.js';

/** Ask which occurrences a change to a repeating event applies to. */
export function askScope(dialog, { verb = 'Save', allowThis = true } = {}) {
  return dialog.choose({
    title: `${verb} recurring event`,
    value: allowThis ? 'this' : 'future',
    okLabel: verb,
    options: [
      allowThis && { value: 'this', label: 'This event' },
      { value: 'future', label: 'This and following events' },
      { value: 'all', label: 'All events' },
    ].filter(Boolean),
  });
}

/**
 * event: an occurrence from /api/calendar (edit) or null (create).
 * defaults (create): { start, end, allDay }.
 */
export default function EventDialog({ event, defaults = {}, dialog, close, onOpenNote }) {
  const isNew = !event;
  const init = () => {
    if (event) return { allDay: event.all_day, start: event.start, end: event.end };
    if (defaults.start) return { allDay: !!defaults.allDay, start: defaults.start, end: defaults.end ?? defaults.start };
    const s = nextHalfHour();
    return { allDay: false, start: s, end: addMinutes(s, 60) };
  };
  const i0 = init();
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(i0.allDay);
  const [startDate, setStartDate] = useState(i0.start.slice(0, 10));
  const [startTime, setStartTime] = useState(i0.allDay ? '09:00' : i0.start.slice(11, 16));
  const [endDate, setEndDate] = useState(i0.end.slice(0, 10));
  const [endTime, setEndTime] = useState(i0.allDay ? '10:00' : i0.end.slice(11, 16));
  const [rrule, setRrule] = useState(event?.rrule ?? null);
  const { categories, defaultId } = useEventCategories();
  // A new event starts in the default category (the server does the same when none is sent).
  const [category, setCategory] = useState(event ? (event.category_id ?? null) : (defaults.category_id ?? defaultId ?? null));
  const catOf = (id) => categories.find((c) => c.id === id);
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [noteId, setNoteId] = useState(event?.note_id ?? null);
  // null: the usual reminders (which follow All day) until some are picked.
  const [reminders, setReminders] = useState(event?.reminders ?? null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const start = allDay ? startDate : `${startDate}T${startTime}`;
  const end = allDay ? endDate : `${endDate}T${endTime}`;

  // Moving the start keeps the duration.
  const changeStart = (date, time) => {
    const before = allDay ? startDate : `${startDate}T${startTime}`;
    const after = allDay ? date : `${date}T${time}`;
    const delta = diffMinutes(before.length === 10 ? `${before}T00:00` : before, after.length === 10 ? `${after}T00:00` : after);
    const newEnd = addMinutes(allDay ? `${endDate}T00:00` : `${endDate}T${endTime}`, delta);
    setStartDate(date); setStartTime(time);
    setEndDate(newEnd.slice(0, 10)); if (!allDay) setEndTime(newEnd.slice(11, 16));
  };

  const save = async (e) => {
    e.preventDefault();
    if (end < start) return setError('End must be after start.');
    const body = {
      title: title.trim() || 'Untitled event', all_day: allDay, start, end, rrule,
      category_id: category, location, description, note_id: noteId, reminders,
    };
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api.createEvent(body);
      } else if (!event.series) {
        await api.updateEvent(event.id, { scope: 'all', changes: body });
      } else {
        // Editing a single occurrence can't change the repeat rule.
        const ruleChanged = (rrule ?? null) !== (event.rrule ?? null);
        const scope = await askScope(dialog, { allowThis: !ruleChanged });
        if (!scope) { setBusy(false); return; }
        const changes = { ...body };
        if (scope === 'this') delete changes.rrule;
        await api.updateEvent(event.id, { scope, occurrence: event.occurrence, changes });
      }
      close(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    let scope = 'all';
    if (event.series) {
      scope = await askScope(dialog, { verb: 'Delete' });
      if (!scope) return;
    } else if (!(await dialog.confirm({ title: 'Delete event?', message: `"${event.title}" will be deleted.`, okLabel: 'Delete', danger: true }))) {
      return;
    }
    await api.deleteEvent(event.id, scope, event.occurrence);
    close(true);
  };

  return (
    <form className="event-dialog" onSubmit={save}>
      {event?.course_study_id && (
        <div className="event-course">
          <Icon name="present" size={15} />
          <span>A class in one of your courses. The course moves it when you change the class plan or skip a date.</span>
          <button type="button" className="btn btn-small" onClick={() => { close(false); window.dispatchEvent(new CustomEvent('noteapp:show-course', { detail: event.course_study_id })); }}>Open the course</button>
        </div>
      )}
      <input className="input title-input" autoFocus placeholder="Event title" value={title} onChange={(e) => setTitle(e.target.value)} />

      <div className="form-grid">
        <label className="form-label">When</label>
        <div className="when">
          <div className="when-row">
            <input className="input input-inline" type="date" value={startDate} required
              onChange={(e) => e.target.value && changeStart(e.target.value, startTime)} />
            {!allDay && <input className="input input-inline" type="time" value={startTime} required
              onChange={(e) => e.target.value && changeStart(startDate, e.target.value)} />}
            <span className="muted">to</span>
            {!allDay && <input className="input input-inline" type="time" value={endTime} required onChange={(e) => setEndTime(e.target.value)} />}
            <input className="input input-inline" type="date" value={endDate} min={startDate} required onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>
        </div>

        <label className="form-label">Repeat</label>
        <RecurrenceEditor value={rrule} onChange={setRrule} startDate={startDate} />

        <label className="form-label">Remind me</label>
        <div>
          <ReminderPicker value={reminders ?? catOf(category)?.reminders ?? defaultReminders('event', !allDay)} onChange={setReminders} untimed={allDay} />
          {reminders === null && catOf(category)?.reminders && <p className="muted reminder-hint">From the {catOf(category).name} category.</p>}
        </div>

        <label className="form-label">Category</label>
        <CategoryPicker value={category} onChange={setCategory} />

        <label className="form-label">Location</label>
        <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" />

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
          <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </div>
    </form>
  );
}

