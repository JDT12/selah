import { useEffect, useState } from 'react';

/**
 * Focus mode (per device): the sidebar leaves out the pages chosen in Settings (sidebarPages.js, useFocusPages),
 * its counts and badges go, reminders are skipped, and a note's toolbar stays out of sight until you select text.
 * Ctrl+Shift+F or the sidebar's focus button turns it on and off.
 */
const KEY = 'noteapp.focus';
const EVENT = 'noteapp:focus';

export function focusOn() {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

export function setFocus(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  document.documentElement.classList.toggle('is-focus', on);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export const toggleFocus = () => setFocus(!focusOn());

/** Whether focus mode is on, following changes from anywhere in the app (and other tabs). */
export function useFocusMode() {
  const [on, setOn] = useState(focusOn);
  useEffect(() => {
    const onChange = () => {
      setOn(focusOn());
      document.documentElement.classList.toggle('is-focus', focusOn());
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return on;
}

document.documentElement.classList.toggle('is-focus', focusOn());
