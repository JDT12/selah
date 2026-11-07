// Smart quick-add: pulls a due date, time, priority, list and repeat out of a typed task, e.g.
// "Call Bob tomorrow 3pm !high #Church" or "Water plants every Monday and Thursday".
// Each recognised piece becomes a token; a token can be ignored (its text stays in the title).
import { addDays, addMonths, toUTC } from './time.js';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const RR_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_RE = 'mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PRIORITY = { l: 1, low: 1, 1: 1, m: 2, med: 2, medium: 2, 2: 2, h: 3, high: 3, 3: 3 };
export const PRIORITY_NAMES = ['', 'Low', 'Medium', 'High'];

const dayIndex = (s) => WEEKDAYS.findIndex((d) => d.startsWith(s.toLowerCase().slice(0, 3)));
const weekdayOf = (date) => (toUTC(date).getUTCDay() + 6) % 7; // 0 = Monday
/** The first `weekday` on or after `from`. */
const onOrAfter = (from, weekday) => addDays(from, (weekday - weekdayOf(from) + 7) % 7);
const num = (s) => NUM_WORDS[s.toLowerCase()] ?? Number(s);

function ymd(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // e.g. Feb 30
  return date.toISOString().slice(0, 10);
}
/** A month/day without a year means its next occurrence (so "Jan 5" in October is next January). */
function upcoming(m, d, y, today) {
  if (y) return ymd(y < 100 ? 2000 + y : y, m, d);
  const yr = Number(today.slice(0, 4));
  const date = ymd(yr, m, d);
  return date && date < today ? ymd(yr + 1, m, d) : date;
}

/** '3', '30', 'pm' -> '15:30'. Without am/pm, 1–6 o'clock means afternoon. */
function clock(h, m = '0', ap = '') {
  let hour = Number(h);
  const min = Number(m);
  if (hour > 23 || min > 59) return null;
  const a = ap.toLowerCase();
  if (a.startsWith('p') && hour < 12) hour += 12;
  else if (a.startsWith('a') && hour === 12) hour = 0;
  else if (!a && hour >= 1 && hour <= 6) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const days = (list) => list.map((d) => RR_DAYS[dayIndex(d)]);

const DATE_RULES = [
  ['date', `(?:(?:due|by|on)\\s+)?(today|tonight)`, (_, t) => ({ date: t })],
  ['date', `(?:(?:due|by|on)\\s+)?(tomorrow|tmrw|tmr)`, (_, t) => ({ date: addDays(t, 1) })],
  ['date', `(?:(?:due|by|on)\\s+)?next\\s+week`, (_, t) => ({ date: onOrAfter(addDays(t, 1), 0) })],
  ['date', `(?:(?:due|by|on)\\s+)?next\\s+month`, (_, t) => ({ date: `${addMonths(t, 1).slice(0, 8)}01` })],
  ['date', `(?:(?:due|by|on)\\s+)?(?:this\\s+|the\\s+)?weekend`, (_, t) => ({ date: onOrAfter(t, 5) })],
  ['date', `(?:(?:due|by|on)\\s+)?in\\s+(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(day|week|month)s?`, (m, t) => {
    const n = num(m[1]);
    const unit = m[2].toLowerCase();
    return { date: unit === 'month' ? addMonths(t, n) : addDays(t, unit === 'week' ? n * 7 : n) };
  }],
  // "next friday" is the Friday of next week; "friday" / "this friday" is the coming one (today if it's Friday).
  ['date', `(?:(?:due|by|on)\\s+)?next\\s+(${DAY_RE})`, (m, t) => ({ date: addDays(onOrAfter(addDays(t, 7 - weekdayOf(t)), 0), dayIndex(m[1])) })],
  // Short day names ("sun", "sat", "wed") are ordinary words too, so on their own only full names count.
  ['date', `(?:due|by|on|this)\\s+(${DAY_RE})`, (m, t) => ({ date: onOrAfter(t, dayIndex(m[1])) })],
  ['date', `(${WEEKDAYS.join('|')})`, (m, t) => ({ date: onOrAfter(t, dayIndex(m[1])) })],
  ['date', `(?:(?:due|by|on)\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, (m, t) => {
    const date = upcoming(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, Number(m[2]), Number(m[3]) || 0, t);
    return date && { date };
  }],
  ['date', `(?:(?:due|by|on)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})(?:\\s+(\\d{4}))?`, (m, t) => {
    const date = upcoming(MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1, Number(m[1]), Number(m[3]) || 0, t);
    return date && { date };
  }],
  ['date', `(?:(?:due|by|on)\\s+)?(\\d{4})-(\\d{2})-(\\d{2})`, (m) => {
    const date = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    return date && { date };
  }],
  ['date', `(?:(?:due|by|on)\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?`, (m, t) => {
    const date = upcoming(Number(m[1]), Number(m[2]), Number(m[3]) || 0, t);
    return date && { date };
  }],
];
// "start friday", "starts oct 25", "starting next week": when the task becomes available.
const START_RULES = [
  ['start', `start(?:s|ing)?\\s+(?:on\\s+)?(${DAY_RE})`, (m, t) => ({ start: onOrAfter(t, dayIndex(m[1])) })],
  ...DATE_RULES.map(([, src, fn]) => ['start', `start(?:s|ing)?\\s+(?:${src})`, (m, t) => {
    const r = fn(m, t);
    return r && { start: r.date };
  }]),
];

// Each rule: [kind, regex source, handler(match, today) -> { value, label } | null].
// Sources are wrapped so a match starts at a word start and ends at a word end.
const RULES = [
  ['repeat', `every\\s+(other\\s+)?(?:(\\d+)\\s+)?(day|week|month|year)s?`, (m) => {
    const n = m[1] ? 2 : Number(m[2] || 1);
    const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[3].toLowerCase()];
    return { rrule: `FREQ=${freq}${n > 1 ? `;INTERVAL=${n}` : ''}` };
  }],
  ['repeat', `every\\s+(weekday|weekend)s?`, (m) => ({
    rrule: `FREQ=WEEKLY;BYDAY=${m[1].toLowerCase() === 'weekday' ? 'MO,TU,WE,TH,FR' : 'SA,SU'}`,
  })],
  ['repeat', `every\\s+(other\\s+)?((?:${DAY_RE})(?:\\s*(?:,|and|&)\\s*(?:${DAY_RE}))*)`, (m) => {
    const list = m[2].split(/\s*(?:,|and|&)\s*/i).filter(Boolean);
    return { rrule: `FREQ=WEEKLY${m[1] ? ';INTERVAL=2' : ''};BYDAY=${[...new Set(days(list))].join(',')}` };
  }],

  ...START_RULES,
  ...DATE_RULES,

  ['time', `(?:at\\s+|@\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.|a|p)`, (m) => {
    const time = clock(m[1], m[2], m[3]);
    return time && { time };
  }],
  ['time', `(?:at\\s+|@\\s*)?(noon|midday)`, () => ({ time: '12:00' })],
  ['time', `(?:at\\s+|@\\s*)(\\d{1,2})(?::(\\d{2}))?`, (m) => {
    const time = clock(m[1], m[2]);
    return time && { time };
  }],

  ['priority', `!(high|med|medium|low|h|m|l|1|2|3)`, (m) => ({ priority: PRIORITY[m[1].toLowerCase()] })],
  ['priority', `(!{1,3})`, (m) => ({ priority: m[1].length })],

  ['list', `#([\\p{L}\\p{N}][\\p{L}\\p{N}_\\-/&']*)`, (m) => ({ listName: m[1] })],
];
const COMPILED = RULES.map(([kind, src, fn]) => [kind, new RegExp(`(?<=^|[\\s,(])(?:${src})(?=$|[\\s,.;:)!?])`, 'giu'), fn]);

const squash = (s) => s.toLowerCase().replace(/[\s_\-]+/g, '');

/**
 * parseTask('Call Bob tomorrow 3pm !high #Church', { today: '2026-10-19', lists })
 * -> { title: 'Call Bob', due_date, due_time, start_date, priority, rrule, list: { id, name } | { name, isNew }, tokens }
 * tokens: [{ key, kind, text, label }] in the order they appear; `ignore` holds token keys to leave in the title.
 */
export function parseTask(input, { today, lists = [], ignore = [] }) {
  const text = input ?? '';
  const taken = []; // [start, end] ranges used by tokens
  const tokens = [];
  const out = { due_date: null, due_time: null, start_date: null, priority: 0, rrule: null, list: null };
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
  const seen = new Set();

  for (const [kind, re, fn] of COMPILED) {
    // One of each kind (a second date or list stays in the title).
    if (seen.has(kind)) continue;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const key = `${kind}:${m[0].toLowerCase().replace(/\s+/g, ' ')}`;
      if (overlaps(start, end) || ignore.includes(key)) continue;
      const r = fn(m, today);
      if (!r) continue;
      const token = { key, kind, text: m[0], start };
      if (r.rrule) { out.rrule = r.rrule; token.label = describeRepeat(m[0]); }
      if (r.date) { out.due_date = r.date; token.label = r.date; }
      if (r.start) { out.start_date = r.start; token.label = r.start; }
      if (r.time) { out.due_time = r.time; token.label = r.time; }
      if (r.priority) { out.priority = r.priority; token.label = PRIORITY_NAMES[r.priority]; }
      if (r.listName) {
        const found = lists.find((l) => squash(l.name) === squash(r.listName));
        out.list = found ? { id: found.id, name: found.name, color: found.color } : { name: r.listName.replace(/[_-]+/g, ' '), isNew: true };
        token.label = out.list.name;
        token.isNew = !found;
      }
      taken.push([start, end]);
      tokens.push(token);
      seen.add(kind);
      break;
    }
  }

  // A repeat with no date starts today, or on its first weekday ("every Monday" -> the coming Monday).
  if (out.rrule && !out.due_date) {
    const byday = /BYDAY=([A-Z,]+)/.exec(out.rrule)?.[1].split(',').map((d) => RR_DAYS.indexOf(d));
    out.due_date = byday
      ? byday.map((d) => onOrAfter(today, d)).sort()[0]
      : today;
  }
  // A time with no date means today.
  if (out.due_time && !out.due_date) out.due_date = today;

  let title = text;
  for (const [s, e] of [...taken].sort((a, b) => b[0] - a[0])) title = `${title.slice(0, s)} ${title.slice(e)}`;
  title = title.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();
  if (!title) title = text.trim();

  tokens.sort((a, b) => a.start - b.start);
  return { title, ...out, tokens };
}

function describeRepeat(s) {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
