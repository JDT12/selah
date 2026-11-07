import { addDays, toUTC } from './time.js';
import { BOOKS } from '../../shared/scripture.js';

/** Plans that fill a study's schedule. Each returns items: { kind, title, ref, date }. */

export const STUDY_KINDS = {
  self: { label: 'Self-study', icon: 'book', item: 'reading', hint: 'A book of the Bible, a theology book, a Logos course' },
  teaching: { label: 'Teaching', icon: 'present', item: 'session', hint: 'A class or Bible study you lead, session by session' },
  writing: { label: 'Writing project', icon: 'pen', item: 'milestone', hint: 'A blog series, an article, a long study' },
  class: { label: 'Class', icon: 'school', item: 'assignment', hint: 'A course you take: due dates from Canvas, and grades' },
  preaching: { label: 'Sermon series', icon: 'lectern', item: 'session', hint: 'Sermons you preach in a series, built step by step' },
};
/** Desk's tabs, and the kinds of study each one holds (courses are teaching). */
export const DESK_TABS = [
  { key: 'study', label: 'Study', icon: 'book', kinds: ['self'] },
  { key: 'teach', label: 'Teach', icon: 'present', kinds: ['teaching', 'preaching'] },
  { key: 'write', label: 'Write', icon: 'pen', kinds: ['writing'] },
  { key: 'learn', label: 'Learn', icon: 'school', kinds: ['class'] },
];

export const ITEM_LABELS = { reading: 'Reading', session: 'Session', assignment: 'Assignment', milestone: 'Milestone' };

const weekday = (date) => toUTC(date).getUTCDay();

/** The next `n` dates from `start` (inclusive) that fall on one of `days` (0 = Sunday) and aren't in `skip`. */
export function datesOn(start, days, n, skip = []) {
  const out = [];
  let d = start;
  for (let guard = 0; out.length < n && guard < 3660; guard += 1) {
    if (days.includes(weekday(d)) && !skip.includes(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** "Romans 1–2" style labels for chapter runs. */
const chapterRef = (name, a, b) => (a === b ? `${name} ${a}` : `${name} ${a}–${b}`);

/** Chunks of a book of the Bible or of numbered parts: [{ title, ref }]. */
export function chunks({ source, book, from, to, label = 'Chapter', count, per }) {
  const out = [];
  if (source === 'bible') {
    const b = BOOKS.find((x) => x.order === Number(book));
    if (!b) return out;
    const first = Math.max(1, Number(from) || 1);
    const last = Math.min(b.chapters, Number(to) || b.chapters);
    for (let c = first; c <= last; c += per) {
      const ref = chapterRef(b.name, c, Math.min(last, c + per - 1));
      out.push({ title: ref, ref });
    }
  } else {
    const n = Math.max(1, Math.min(500, Number(count) || 1));
    for (let c = 1; c <= n; c += per) {
      const end = Math.min(n, c + per - 1);
      out.push({ title: c === end ? `${label} ${c}` : `${label}s ${c}–${end}`, ref: '' });
    }
  }
  return out;
}

/** A reading plan: the chunks spread over the chosen weekdays from `start`. */
export function readingPlan({ start, days, ...source }) {
  const parts = chunks(source);
  const dates = datesOn(start, days, parts.length);
  return parts.map((p, i) => ({ kind: 'reading', ...p, date: dates[i] ?? null }));
}

/** A teaching series: weekly (or every `every` days) sessions, optionally walking through a book of the Bible. */
export function seriesPlan({ start, count, every = 7, skip = [], source, book, from, to, per = 1, prefix = 'Session' }) {
  const parts = source === 'bible' ? chunks({ source, book, from, to, per }) : null;
  const n = parts ? parts.length : Math.max(1, Math.min(200, Number(count) || 1));
  const dates = [];
  for (let d = start; dates.length < n && dates.length < 400; d = addDays(d, every)) if (!skip.includes(d)) dates.push(d);
  return Array.from({ length: n }, (_, i) => ({
    kind: 'session',
    title: parts ? `${prefix} ${i + 1}: ${parts[i].ref}` : `${prefix} ${i + 1}`,
    ref: parts ? parts[i].ref : '',
    date: dates[i] ?? null,
  }));
}

/** Writing: research, outline, draft, revise, finish, spread evenly from start to the target date. */
export function writingPlan({ start, target }) {
  const steps = ['Research and gather sources', 'Outline', 'First draft', 'Revise', 'Final read-through and publish'];
  const span = Math.max(steps.length, Math.round((toUTC(target) - toUTC(start)) / 86_400_000));
  return steps.map((title, i) => ({ kind: 'milestone', title, ref: '', date: addDays(start, Math.round((span * (i + 1)) / steps.length)) }));
}
