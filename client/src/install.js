/**
 * Installing Selah as an app (a window of its own, with a Start-menu / taskbar / home-screen icon).
 * Chrome and Edge fire `beforeinstallprompt` once, early, when the page can be installed; it's kept
 * here so Settings can show an Install button later.
 */
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

export const canPromptInstall = () => !!deferred;

export const isInstalledApp = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows the browser's install prompt; resolves true if the user accepted. */
export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome === 'accepted';
}
