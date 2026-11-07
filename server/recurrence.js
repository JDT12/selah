// Date/recurrence helpers.
//
// All event/task times are stored as "floating" wall-clock strings in the app's time zone
// (America/Chicago by default): 'YYYY-MM-DD' for dates, 'YYYY-MM-DDTHH:mm' for times.
// For arithmetic and RRULE expansion they're mapped onto UTC Date objects (the rrule
// library's recommended convention for floating times), so a 9:00 weekly meeting stays
// at 9:00 across daylight-saving changes.
import rrulePkg from 'rrule';
import { config } from './config.js';

const { RRule, Weekday } = rrulePkg;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const TIME_RE = /^\d{2}:\d{2}$/;

export function toDate(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, mi));
}

export const fmtDate = (date) => date.toISOString().slice(0, 10);
export const fmtDateTime = (date) => date.toISOString().slice(0, 16);
export const fmt = (date, allDay) => (allDay ? fmtDate(date) : fmtDateTime(date));
export const addMinutes = (date, n) => new Date(date.getTime() + n * 60_000);
export const addDays = (s, n) => fmtDate(new Date(toDate(s).getTime() + n * 86_400_000));

/** Today's date ('YYYY-MM-DD') in the app time zone. */
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** Normalise an RRULE string: no "RRULE:" prefix, no DTSTART. Throws if invalid. */
export function normaliseRule(rule) {
  if (!rule) return null;
  const opts = RRule.parseString(String(rule).replace(/^RRULE:/i, ''));
  if (opts.freq === undefined) throw new Error('Repeat rule needs a frequency');
  delete opts.dtstart;
  return RRule.optionsToString(opts).replace(/^RRULE:/, '');
}

export function makeRule(rule, dtstart) {
  const opts = RRule.parseString(rule);
  opts.dtstart = dtstart;
  return new RRule(opts);
}

/** Shift a rule's BYDAY weekdays by `days` (so "Fri+Sun" moved a day later becomes "Sat+Mon"). */
export function shiftRuleWeekdays(rule, days) {
  const d = ((days % 7) + 7) % 7;
  const opts = RRule.parseString(rule);
  if (!d || opts.byweekday == null) return rule;
  const list = Array.isArray(opts.byweekday) ? opts.byweekday : [opts.byweekday];
  opts.byweekday = list.map((w) => (typeof w === 'number'
    ? new Weekday((w + d) % 7)
    : new Weekday((w.weekday + d) % 7, w.n)));
  return RRule.optionsToString(opts).replace(/^RRULE:/, '');
}

/** Rule string ending just before `beforeDate`; returns null if that leaves no occurrences. */
export function truncateRule(rule, dtstart, beforeDate) {
  const opts = RRule.parseString(rule);
  delete opts.count;
  opts.until = new Date(beforeDate.getTime() - 1000);
  if (opts.until < dtstart) return null;
  return RRule.optionsToString(opts).replace(/^RRULE:/, '');
}

/** Rule string for the remainder of a series split at `fromDate` (adjusts COUNT). */
export function remainderRule(rule, dtstart, fromDate) {
  const opts = RRule.parseString(rule);
  if (opts.count) {
    const before = makeRule(rule, dtstart).between(dtstart, fromDate, true)
      .filter((d) => d < fromDate).length;
    opts.count = Math.max(1, opts.count - before);
  }
  return RRule.optionsToString(opts).replace(/^RRULE:/, '');
}

/**
 * Expand an event row into occurrences overlapping [from, to) (date strings).
 * Returns [{ start, end }] as floating strings. Handles all-day (inclusive end date).
 */
export function expand(ev, from, to) {
  const allDay = !!ev.all_day;
  const start = toDate(ev.start_at);
  const end = toDate(ev.end_at);
  const durMs = end - start;
  const rangeFrom = toDate(from);
  const rangeTo = toDate(to);
  // For overlap checks treat all-day end as exclusive (end date + 1 day).
  const effEnd = (s) => new Date(s.getTime() + durMs + (allDay ? 86_400_000 : 0));

  if (!ev.rrule) {
    return start < rangeTo && effEnd(start) > rangeFrom ? [{ start: ev.start_at, end: ev.end_at }] : [];
  }
  const exdates = new Set(JSON.parse(ev.exdates || '[]'));
  const lookBack = new Date(rangeFrom.getTime() - durMs - (allDay ? 86_400_000 : 0));
  return makeRule(ev.rrule, start)
    .between(lookBack, rangeTo, true)
    .filter((s) => s < rangeTo && effEnd(s) > rangeFrom)
    .map((s) => ({ start: fmt(s, allDay), end: fmt(new Date(s.getTime() + durMs), allDay) }))
    .filter((o) => !exdates.has(o.start));
}

/** Next occurrence (date string) of a recurring task strictly after `afterDate`. */
export function nextTaskDate(rule, seriesStart, afterDate) {
  const next = makeRule(rule, toDate(seriesStart)).after(toDate(afterDate), false);
  return next ? fmtDate(next) : null;
}
