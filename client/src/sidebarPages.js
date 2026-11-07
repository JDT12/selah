import { useEffect } from 'react';
import { api } from './api.js';
import { useStoredState } from './useStoredState.js';

/**
 * Every page the rail can show, in rail order; `group` decides where the dividers go. `short` is the rail's label
 * (7.1). Desk is Home's tabs and Tasks is part of Plan, so neither has a place of its own; the notes library is the
 * Shelf, and Templates, Attachments, Tags and the Trash are the Utility panel.
 * 9.2: `band` groups the pages on the rail: your day (Home, Plan, Inbox), then your study and devotion (Walk, Bible,
 * Preach). Prayer is a tab of Walk.
 * 10.1: notes are sorted by tags. My notes replaces the Shelf, the WordPress site is back on the rail just above it,
 * pinned notebooks are gone, and Utility sits at the foot of the rail above Settings.
 */
export const SIDEBAR_PAGES = [
  { key: 'dashboard', label: 'Home', short: 'Home', icon: 'home', group: 'pages', band: 'day', note: 'with what’s active on Desk' },
  { key: 'calendar', label: 'Plan', short: 'Plan', icon: 'plan', group: 'pages', band: 'day', note: 'calendar and tasks' },
  { key: 'inbox', label: 'Inbox', short: 'Inbox', icon: 'inbox', group: 'pages', band: 'day' },
  { key: 'dailywalk', label: 'Walk', short: 'Walk', icon: 'sunrise', group: 'pages', band: 'study', note: 'Daily Walk, Reading Plans and Prayer' },
  { key: 'scripture', label: 'Bible', short: 'Bible', icon: 'bible', group: 'pages', band: 'study', note: 'Scripture' },
  { key: 'desk', label: 'Desk', short: 'Desk', icon: 'desk', group: 'pages', band: 'study', note: 'all your studies, lessons, sermons, writing and classes' },
  { key: 'sermons', label: 'Preach', short: 'Preach', icon: 'lectern', group: 'pages', band: 'study', note: 'sermons' },
  { key: 'wordpress', label: 'WordPress site', short: 'Site', icon: 'globe', group: 'pages', band: 'study', note: 'while a site is connected' },
  { key: 'mynotes', label: 'My notes', short: 'My notes', icon: 'notes', group: 'library', note: 'all your notes, sorted by tag' },
  { key: 'utility', label: 'Utility', short: 'Utility', icon: 'grid', group: 'library', note: 'templates, attachments, tags and the Trash, at the foot of the rail' },
];

/**
 * Studies became Desk in 5.14, with Courses as its Teach tab: a choice that named Studies now names Desk. Sports
 * was removed in 5.17.2. (7.1: 'desk' and 'tasks' can still be named; the rail shows Home for Desk when focus mode
 * hides Home but keeps Desk, and ignores them otherwise.)
 */
const renamed = (keys) => (keys.some((k) => k === 'studies' || k === 'courses' || k === 'sports' || k === 'shelf')
  ? [...new Set(keys.filter((k) => k !== 'courses' && k !== 'sports').map((k) => ({ studies: 'desk', shelf: 'mynotes' })[k] ?? k))]
  : keys);

/**
 * A sidebar choice (a list of page keys). Kept on the server so it follows you to other devices, cached here so
 * the sidebar draws right away, and shared between the sidebar and the Customize dialog through an event.
 */
function useSidebarPref(name, initial = []) {
  const event = `noteapp:${name}`;
  const [stored, setValue] = useStoredState(`noteapp.${name}`, initial);
  const value = renamed(stored);
  useEffect(() => {
    api.getPref(name).then((v) => setValue(Array.isArray(v) ? v : initial)).catch(() => {});
    const onChange = (e) => setValue(e.detail);
    window.addEventListener(event, onChange);
    return () => window.removeEventListener(event, onChange);
  }, [setValue, name, event]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next) => {
    window.dispatchEvent(new CustomEvent(event, { detail: next }));
    return api.setPref(name, next);
  };
  return [value, save];
}

/** Pages hidden from the sidebar. */
export const useHiddenPages = () => useSidebarPref('sidebarHidden');

/** Pages focus mode hides (on top of the hidden ones); the same on every device. */
export const DEFAULT_FOCUS_HIDDEN = ['dashboard', 'inbox', 'calendar', 'tasks', 'utility'];
export const useFocusPages = () => useSidebarPref('focusHidden', DEFAULT_FOCUS_HIDDEN);


/** The order of the top section's pages (keys); pages it doesn't name keep their usual place after them. */
export const usePageOrder = () => useSidebarPref('sidebarOrder');

/**
 * The top section's page keys in your order. A page your order doesn't name yet (one added in an update) goes
 * right after the page it follows in the usual order.
 */
export function orderedPageKeys(order) {
  const keys = SIDEBAR_PAGES.filter((p) => p.group === 'pages').map((p) => p.key);
  const out = (order ?? []).filter((k) => keys.includes(k));
  keys.forEach((k, i) => {
    if (out.includes(k)) return;
    const before = keys.slice(0, i).reverse().find((x) => out.includes(x));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, k);
  });
  // Your day's pages come first, then the rest (each band keeps your order), so the rail's divider falls between them.
  const day = (k) => SIDEBAR_PAGES.find((p) => p.key === k)?.band === 'day';
  return [...out.filter(day), ...out.filter((k) => !day(k))];
}
