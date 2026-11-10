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

// The rules for which apply live in shared/agenda.js, shared with the server's push reminders (13.0).
export { defaultReminders, remindersFor } from '../../shared/agenda.js';
