/**
 * Reminders for events and tasks. Each one keeps a list of lead times in minutes before it (server: the
 * `reminders` column), or null for the usual ones: 15 minutes before a timed event, at the due time of a timed
 * task, and none for all-day events and tasks without a time. Those count back from midnight when you pick one.
 */
export const LEADS = [
  { min: 0, label: 'At the time', short: 'At time' },
  { min: 15, label: '15 minutes before', short: '15 min' },
  { min: 60, label: '1 hour before', short: '1 hour' },
  { min: 720, label: '12 hours before', short: '12 hours' },
  { min: 1440, label: '1 day before', short: '1 day' },
  { min: 10080, label: '1 week before', short: '1 week' },
];

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
