import { useEffect, useRef } from 'react';

/**
 * 10.0: the builders (sermon, Bible study, background and word study, lesson) are pages in a tab, like a note, not
 * dialogs. Opening one asks the app (App.jsx) to show it; the promise resolves at once, so a caller that waited for
 * the old dialog to close just carries on (its page reloads anyway when you come back to it).
 *
 * builder: 'sermon' | 'study' (the Interpretive Journey) | 'background' | 'word' | 'lesson'.
 */
export function openBuilderPage(noteId, builder, extra = {}) {
  window.dispatchEvent(new CustomEvent('noteapp:open-builder', { detail: { id: noteId, builder, ...extra } }));
  return Promise.resolve(true);
}

/** Which tab dot and label a builder has (TopBar.jsx). */
export const BUILDER_TYPE = { sermon: 'sermon', study: 'study', background: 'study', word: 'study', lesson: 'lesson' };

/**
 * A builder saves as you go: a second and a half after you stop typing, and when you leave it (another tab, Back,
 * closing its tab). A change made while a save is on its way is saved next. `changes`: the builder's state that each
 * edit replaces (its model and meta), compared by identity. `remember` keeps the step you're on when there's nothing
 * to save.
 */
export function useAutosave({ dirty, setDirty, saveRef, changes, remember }) {
  const state = useRef({ dirty, changes, saving: false });
  state.current.dirty = dirty;
  state.current.changes = changes;
  const run = useRef(null);
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  run.current = async () => {
    const s = state.current;
    if (!s.dirty || s.saving) return;
    s.saving = true;
    const at = s.changes;
    const ok = await saveRef.current?.({ auto: true });
    s.saving = false;
    if (ok && state.current.changes.some((v, i) => v !== at[i])) setDirty(true);
  };
  useEffect(() => {
    if (!dirty) return undefined;
    const t = setTimeout(() => run.current(), 1500);
    return () => clearTimeout(t);
  }, [dirty, ...changes]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving: what's left is saved, or (nothing to save) the step you were on is remembered for next time.
  useEffect(() => () => { if (state.current.dirty) run.current(); else rememberRef.current?.(); }, []);
}

/** Whether a builder's keys (Ctrl+S) are for it: it's on the page and no dialog is over it. */
export function builderKeyAnswers(shell) {
  const all = document.querySelectorAll('.modal-backdrop');
  const top = all[all.length - 1];
  if (!shell) return false;
  return top ? top.contains(shell) : shell.isConnected;
}
