// What the Tasks page shows: which tasks belong in a view, searching, filtering, sorting and grouping.
import { addDays, formatShortDate, relativeDay } from './time.js';

export const SORTS = [
  { key: 'due', label: 'Due date', hint: 'Grouped by date; drag to reorder' },
  { key: 'priority', label: 'Priority', hint: 'Grouped by priority' },
  { key: 'list', label: 'List', hint: 'Grouped by list' },
  { key: 'title', label: 'Title (A–Z)' },
  { key: 'created', label: 'Newest first' },
];

export const WHEN = [
  ['any', 'Any date'],
  ['overdue', 'Overdue'],
  ['today', 'Due today'],
  ['week', 'Due in the next 7 days'],
  ['dated', 'Has a due date'],
  ['none', 'No due date'],
];

export const DEFAULT_FILTER = { priorities: [], lists: [], when: 'any', repeating: false, steps: false, note: false, hideLater: false };

/** How many filter settings differ from the default. */
export function filterCount(f) {
  return (f.priorities.length ? 1 : 0) + (f.lists.length ? 1 : 0) + (f.when !== 'any' ? 1 : 0)
    + ['repeating', 'steps', 'note', 'hideLater'].filter((k) => f[k]).length;
}

const listIdOf = (view) => (view.startsWith('list:') ? Number(view.slice(5)) : null);
const started = (x, t) => !x.start_date || x.start_date <= t;

/**
 * Whether a task belongs in a view. Today: due today or earlier, or started (start date reached) and not due yet.
 * Upcoming: anything with a due date, or a start date still to come.
 */
export function inView(view, task, t) {
  if (view === 'today') return (!!task.due_date && task.due_date <= t) || (!!task.start_date && task.start_date <= t);
  if (view === 'upcoming') return !!task.due_date || (!!task.start_date && task.start_date > t);
  if (view === 'inbox') return !task.list_id;
  const id = listIdOf(view);
  return id ? task.list_id === id : true;
}

// ---------- search ----------
/** Lower case without accents, so "cafe" finds "Café". */
export const fold = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const searchWords = (q) => fold(q).split(/\s+/).filter(Boolean);

/** Every word appears in the title, details, steps or list name. */
export function matchesSearch(task, words) {
  if (!words.length) return true;
  const hay = fold([task.title, task.description, task.list_name, ...(task.steps ?? []).map((s) => s.title)].join('\n'));
  return words.every((w) => hay.includes(w));
}

// ---------- filters ----------
export function applyFilter(tasks, f, t) {
  const week = addDays(t, 7);
  const when = {
    any: () => true,
    overdue: (x) => !!x.due_date && x.due_date < t,
    today: (x) => x.due_date === t,
    week: (x) => !!x.due_date && x.due_date >= t && x.due_date <= week,
    dated: (x) => !!x.due_date,
    none: (x) => !x.due_date,
  }[f.when] ?? (() => true);
  return tasks.filter((x) => when(x)
    && (!f.priorities.length || f.priorities.includes(x.priority))
    && (!f.lists.length || f.lists.includes(x.list_id ?? 0))
    && (!f.repeating || !!x.rrule)
    && (!f.steps || x.steps?.length > 0)
    && (!f.note || !!x.note_id)
    && (!f.hideLater || x.completed_at || started(x, t)));
}

// ---------- sorting ----------
const nullsLast = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);
/** The server's order: due date, timed before untimed, then your own order. */
export const byDue = (a, b) => nullsLast(a.due_date, b.due_date) || nullsLast(a.due_time, b.due_time)
  || (a.position - b.position) || (a.id - b.id);
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || byDue(a, b);

function comparator(sort, lists) {
  const listPos = new Map(lists.map((l, i) => [l.id, i + 1]));
  return {
    due: byDue,
    priority: (a, b) => (b.priority - a.priority) || byDue(a, b),
    list: (a, b) => ((listPos.get(a.list_id) ?? 0) - (listPos.get(b.list_id) ?? 0)) || byDue(a, b),
    title: byTitle,
    created: (a, b) => (b.created_at - a.created_at) || (b.id - a.id),
  }[sort] ?? byDue;
}

// ---------- grouping ----------
const PRIORITY_GROUPS = [[3, 'High priority'], [2, 'Medium priority'], [1, 'Low priority'], [0, 'No priority']];

/**
 * A view's groups: { key, title, tasks, drop?, dropLabel?, oneDay?, keep?, compact?, sub?, tone? }.
 * `drop` makes a group a drop target: the changes made to tasks dropped on it (e.g. { due_date }).
 * `oneDay` is the date every task in it is on (rows then leave their date out). `keep` shows it even when empty.
 * In Today and Upcoming the days are fixed and `sort` orders tasks within each day; elsewhere it picks the grouping.
 */
export function groupTasks(view, tasks, t, sort = 'due', lists = []) {
  const cmp = comparator(sort, lists);
  const sorted = (list) => [...list].sort(cmp);
  const tomorrow = addDays(t, 1);
  const week = addDays(t, 7);
  const onDay = (d, label) => ({ drop: { due_date: d }, dropLabel: `Moved to ${label ?? relativeDay(d)}`, oneDay: d });
  const overdue = { key: 'overdue', title: 'Overdue', tone: 'overdue', tasks: sorted(tasks.filter((x) => x.due_date && x.due_date < t)) };

  if (view === 'today') {
    return [
      overdue,
      { key: 'today', title: 'Today', keep: true, ...onDay(t), tasks: sorted(tasks.filter((x) => x.due_date === t)) },
      { key: 'started', title: 'Started', sub: 'Not due yet', tasks: sorted(tasks.filter((x) => (!x.due_date || x.due_date > t) && x.start_date && x.start_date <= t)) },
    ].filter((g) => g.keep || g.tasks.length);
  }

  if (view === 'upcoming') {
    // Each task sits on its due day; one due later (or never) but starting this week sits on its start day.
    const dayOf = (x) => {
      if (x.due_date && x.due_date < week) return x.due_date;
      if (x.start_date && x.start_date > t && x.start_date < week) return x.start_date;
      return 'later';
    };
    const days = Array.from({ length: 7 }, (_, i) => addDays(t, i)).map((d, i) => ({
      key: d, keep: true, compact: true, ...onDay(d),
      title: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatShortDate(d).split(',')[0],
      sub: formatShortDate(d).split(', ').slice(1).join(', '),
      tasks: sorted(tasks.filter((x) => dayOf(x) === d && !(x.due_date && x.due_date < t))),
    }));
    return [overdue, ...days, { key: 'later', title: 'Later', tasks: sorted(tasks.filter((x) => dayOf(x) === 'later')) }]
      .filter((g) => g.keep || g.tasks.length);
  }

  if (sort === 'priority') {
    return PRIORITY_GROUPS.map(([p, title]) => ({
      key: `p${p}`, title, drop: { priority: p }, dropLabel: `Priority: ${title.split(' ')[0]}`,
      tasks: sorted(tasks.filter((x) => x.priority === p)),
    })).filter((g) => g.tasks.length);
  }
  if (sort === 'list' && !view.startsWith('list:')) {
    return [{ id: null, name: 'Inbox' }, ...lists].map((l) => ({
      key: `l${l.id ?? 0}`, title: l.name, color: l.color, drop: { list_id: l.id }, dropLabel: `Moved to ${l.name}`,
      tasks: sorted(tasks.filter((x) => (x.list_id ?? null) === l.id)),
    })).filter((g) => g.tasks.length);
  }
  if (sort === 'title' || sort === 'created') {
    return tasks.length ? [{ key: 'flat', title: sort === 'title' ? 'A–Z' : 'Newest first', tasks: sorted(tasks) }] : [];
  }
  return [
    overdue,
    { key: 'today', title: 'Today', ...onDay(t), tasks: sorted(tasks.filter((x) => x.due_date === t)) },
    { key: 'tomorrow', title: 'Tomorrow', ...onDay(tomorrow), tasks: sorted(tasks.filter((x) => x.due_date === tomorrow)) },
    { key: 'week', title: 'Next 7 days', tasks: sorted(tasks.filter((x) => x.due_date > tomorrow && x.due_date <= week)) },
    { key: 'later', title: 'Later', tasks: sorted(tasks.filter((x) => x.due_date > week)) },
    { key: 'none', title: 'No date', drop: { due_date: null }, dropLabel: 'Date removed', tasks: sorted(tasks.filter((x) => !x.due_date)) },
  ].filter((g) => g.tasks.length);
}
