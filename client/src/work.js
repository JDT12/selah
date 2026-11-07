import { DESK_TABS } from './studyPlans.js';
import { openBuilderPage } from './builderPages.js';

/**
 * 11.0: your work, as Desk and Home list it (server/work.js). Builder work (studies, lessons, sermons) and Desk's plans
 * (study plans, courses, series, writing projects, classes) are rows of one list, sorted into Study, Teach, Write and
 * Learn, each with a type chip.
 */
export const WORK_TYPES = {
  study: { label: 'Bible study', tab: 'study', color: '#2e7d4f' },
  background: { label: 'Background', tab: 'study', color: '#23797a' },
  word: { label: 'Word study', tab: 'study', color: '#6b4fa0' },
  self: { label: 'Study plan', tab: 'study', color: '#2f5d86' },
  lesson: { label: 'Lesson', tab: 'teach', color: '#2f5d86' },
  sermon: { label: 'Sermon', tab: 'teach', color: '#b7700a' },
  course: { label: 'Course', tab: 'teach', color: '#2f5d86' },
  teaching: { label: 'Teaching series', tab: 'teach', color: '#23797a' },
  preaching: { label: 'Sermon series', tab: 'teach', color: '#b7700a' },
  writing: { label: 'Writing', tab: 'write', color: '#6b4fa0' },
  class: { label: 'Class', tab: 'learn', color: '#b7700a' },
};
const STUDY_HEX = { blue: '#2f5d86', green: '#2e7d4f', orange: '#b7700a', purple: '#6b4fa0', red: '#c93a32', teal: '#23797a', gray: '#6b7785' };

/** A Desk plan (api.studies) as a row. */
export function planRow(s) {
  const type = s.data?.course ? 'course' : s.kind;
  const next = s.progress?.next;
  return {
    key: `s${s.id}`, plan: true, id: s.id, course: !!s.data?.course, type, tab: WORK_TYPES[type]?.tab ?? 'study',
    title: s.title, passage: s.data?.passage ?? s.data?.book ?? '', color: STUDY_HEX[s.color] ?? WORK_TYPES[type]?.color,
    date: next?.date ?? s.target_date ?? null, dateLabel: next?.date ? 'Next' : s.target_date ? 'Finish by' : null,
    progress: s.progress, status: s.status, done: s.status !== 'active', archived: s.status === 'archived', updated_at: s.updated_at, study: s,
  };
}

/** A piece of builder work (api.work) as a row. */
export function workRow(w) {
  return {
    ...w, type: w.kind, color: WORK_TYPES[w.kind]?.color, date: w.date ?? null, dateLabel: w.date ? 'On' : null,
    title: w.title || (w.word ? `“${w.word}”` : 'Untitled'),
  };
}

/** Every row on a tab, newest first. */
export function rowsOn(tab, work, plans) {
  return [...(work ?? []).map(workRow), ...(plans ?? []).map(planRow)].filter((r) => r.tab === tab)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/** Opens a row: builder work in its builder (its own tab), a plan on Desk. `newTab` opens a plan in a tab of its own. */
export function openRow(r, { newTab = false } = {}) {
  if (!r.plan) return openBuilderPage(r.note_id, r.builder);
  if (newTab) return window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'study', id: r.id, course: r.course, title: r.title } }));
  return window.dispatchEvent(new CustomEvent(r.course ? 'noteapp:show-course' : 'noteapp:show-study', { detail: r.id }));
}

export const deskTabLabel = (key) => DESK_TABS.find((t) => t.key === key)?.label ?? key;
