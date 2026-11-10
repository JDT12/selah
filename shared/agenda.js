/**
 * Reminders for events, tasks and the Daily Walk routine, worked out the same way in the browser and on the server
 * (13.0): the apps schedule them on the device (client/src/desktop.js), and the server pushes the ones a device
 * doesn't have (server/push.js), so each key and moment has to match exactly.
 *
 * Times are floating wall-clock strings in Selah's time zone ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm'); `at` is that wall
 * clock in minutes, mapped onto UTC, so two computations of the same reminder agree wherever they run.
 *
 * Each event and task keeps a list of lead times in minutes before it (the `reminders` column), or null for the usual
 * ones: 15 minutes before a timed event, at the due time of a timed task, and none for all-day events and tasks
 * without a time. Those count back from midnight when you pick one.
 */
export const WINDOW = 8; // days ahead to look: the longest lead time is a week

/** The usual reminders: `kind` 'event' or 'task'; `timed` false for all-day events and tasks without a time. */
export function defaultReminders(kind, timed) {
  if (!timed) return [];
  return kind === 'event' ? [15] : [0];
}

/** The lead times that apply to an event occurrence or task from the API. */
export function remindersFor(kind, item) {
  if (Array.isArray(item.reminders)) return item.reminders;
  // An event without its own takes its calendar category's, when the category has some.
  if (kind === 'event' && Array.isArray(item.category_reminders)) return item.category_reminders;
  return defaultReminders(kind, kind === 'event' ? !item.all_day : !!item.due_time);
}

const toUTC = (s) => {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, mi));
};
export const wallMin = (s) => toUTC(s).getTime() / 60_000;
const addDays = (s, n) => new Date(toUTC(s).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Reminders due from `date` for the next week: [{ key, at, title, body, open }].
 * cal: GET /api/calendar for date .. date + WINDOW; routine: GET /api/routine for date (or null).
 * app: in the phone or tablet app, where an event's start has its own note; role: 'phone' | 'tablet' | 'full'.
 * fmt: { formatTime('09:30') -> '9:30 AM', relativeDay('YYYY-MM-DD') -> 'Today' | 'Tomorrow' | 'Friday' | ... }.
 */
export function agendaItems({ cal, routine, date, app = false, role = 'full', fmt }) {
  const when = (day, time) => {
    const d = fmt.relativeDay(day);
    const lower = d === 'Today' || d === 'Tomorrow' || d === 'Yesterday' ? d.toLowerCase() : d;
    return time ? `${lower} at ${fmt.formatTime(time)}` : lower;
  };
  const items = [];
  // The Daily Walk routine's daily reminder (not today's once it's finished).
  if (routine?.reminder && routine.items?.length) {
    const left = routine.items.filter((x) => !x.done).length;
    for (let i = 0; i < WINDOW; i++) {
      const day = addDays(date, i);
      if (i === 0 && !left) continue;
      items.push({ key: `rt@${day}`, at: wallMin(`${day}T${routine.reminder}`), title: 'Daily Walk',
        body: i === 0 ? `${left} of ${routine.items.length} left in your routine` : 'Time for your routine', open: 'dailywalk' });
    }
  }
  for (const t of cal?.tasks ?? []) {
    if (t.completed_at || !t.due_date) continue;
    // A task without a time counts back from midnight at the start of its day.
    const due = `${t.due_date}T${t.due_time ?? '00:00'}`;
    for (const lead of remindersFor('task', t)) {
      const body = lead === 0 && t.due_time ? `Due now (${fmt.formatTime(t.due_time)})` : `Due ${when(t.due_date, t.due_time)}`;
      items.push({ key: `t${t.id}@${due}-${lead}`, at: wallMin(due) - lead, title: t.title || 'Task', body, open: 'tasks' });
    }
  }
  for (const e of cal?.events ?? []) {
    const day = e.start.slice(0, 10);
    const time = e.all_day ? null : e.start.slice(11, 16);
    const start = `${day}T${time ?? '00:00'}`;
    // In the apps, an event a group meets at (or with a lesson or sermon linked) has its own note at its start.
    const startNote = time && app ? eventStart(e, time, role, fmt) : null;
    if (startNote) items.push({ key: `e${e.id}@${e.start}-start`, at: wallMin(start), ...startNote });
    for (const lead of remindersFor('event', e)) {
      if (startNote && lead === 0) continue;
      const body = lead === 0 && time ? `Starts now (${fmt.formatTime(time)})` : `Starts ${when(day, time)}`;
      items.push({ key: `e${e.id}@${e.start}-${lead}`, at: wallMin(start) - lead, title: e.title || 'Event', body, open: 'calendar' });
    }
  }
  return items;
}

/** What an event's start says in the app: the phone takes attendance; the tablet opens the lesson, else attendance. */
function eventStart(e, time, role, fmt) {
  const att = e.attendance;
  const note = e.note_id ? { id: e.note_id, title: e.note_title || 'the lesson' } : null;
  if (role === 'tablet' && note) return { title: `Time to teach: ${note.title}`, body: `${e.title || 'Event'} starts now (${fmt.formatTime(time)}). Tap to open it.`, open: { note: note.id } };
  if (att) return { title: `Take attendance: ${att.name}`, body: `${e.title || 'Event'} starts now (${fmt.formatTime(time)}).`, open: { attendance: att.id } };
  return null;
}
