import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useStoredState } from './useStoredState.js';

/**
 * Calendar categories (server/categories.js): loaded once and shared, reloaded after a change anywhere
 * (categoriesChanged). Which ones the Calendar and the Dashboard show is remembered per device; 0 stands for
 * events without a category.
 */
export const CATEGORY_ICONS = [
  ['', 'No icon'], ['cross', 'Church'], ['bible', 'Bible'], ['book', 'Book'], ['school', 'School'], ['users', 'People'],
  ['home', 'Home'], ['heart', 'Heart'], ['briefcase', 'Work'], ['music', 'Music'], ['plane', 'Travel'], ['cake', 'Birthday'],
  ['star', 'Star'], ['flag', 'Flag'], ['trophy', 'Sports'], ['sun', 'Sun'], ['globe', 'Globe'], ['clock', 'Clock'], ['bolt', 'Bolt'],
];
export const NONE = 0;
export const EVENT_COLORS = {
  green: '#1f8a5b', blue: '#3366cc', purple: '#7c4dbd', red: '#c93a32',
  orange: '#d9731a', yellow: '#b8930a', teal: '#13827f', pink: '#c2407e', gray: '#6b716e',
};

let cache = null;
let loading = null;
const EVENT = 'noteapp:event-categories';

function load() {
  loading ??= api.eventCategories().then((r) => { cache = r; loading = null; window.dispatchEvent(new CustomEvent(EVENT)); return r; })
    .catch(() => { loading = null; });
  return loading;
}

/** Reload the categories everywhere (after adding, editing or deleting one). */
export const categoriesChanged = () => { loading = null; return load(); };

// A change on another device (or in another window) shows up here too: Selah's live messages (live.js) say
// something changed, and the categories are read again (once for a burst of changes).
let soon = null;
window.addEventListener('noteapp:live', () => {
  if (!cache) return;
  clearTimeout(soon);
  soon = setTimeout(() => { loading = null; load(); }, 400);
});

/** { categories, defaultId }, kept up to date. */
export function useEventCategories() {
  const [state, setState] = useState(cache);
  useEffect(() => {
    const on = () => setState(cache);
    window.addEventListener(EVENT, on);
    if (!cache) load(); else on();
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return state ?? { categories: [], defaultId: null, loading: true };
}

/** The hidden category ids for one place ('calendar' or 'dashboard'), per device, and a toggle. */
export function useHiddenCategories(place) {
  const [hidden, setHidden] = useStoredState(`noteapp.hiddenCategories.${place}`, []);
  const toggle = (id) => setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  return [hidden, toggle, setHidden];
}

/** Whether an event occurrence or task shows with these categories hidden. Tasks without a category always show. */
export const shownWith = (hidden) => (item) => {
  if (!hidden.length) return true;
  if ('due_date' in item && !item.category_id) return true;
  return !hidden.includes(item.category_id ?? NONE);
};
