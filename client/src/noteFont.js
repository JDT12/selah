/** How note text reads (7.0): 'serif' (the default) or 'sans'. Per device, like the theme. */
const KEY = 'noteapp.noteFont';
export function noteFont() {
  try { return JSON.parse(localStorage.getItem(KEY)) === 'sans' ? 'sans' : 'serif'; } catch { return 'serif'; }
}
export function applyNoteFont(v = noteFont()) {
  document.documentElement.dataset.noteFont = v;
}
export function setNoteFont(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
  applyNoteFont(v);
}
