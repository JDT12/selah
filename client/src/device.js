import { isMobileApp } from './mobile.js';

/**
 * What each device is for (13.0). A phone captures, tracks and plans; a tablet delivers (Preach, Teach, slides) and is
 * good for devotions and planning; the web and Selah Desktop have everything. Only the phone and tablet apps are
 * limited: Safari or Chrome on the same device stays full featured. It goes by the device, not the window, so an iPad
 * in Split View is still a tablet.
 */
const role = !isMobileApp() ? 'full' : Math.min(window.screen.width, window.screen.height) >= 600 ? 'tablet' : 'phone';

export const device = { role, full: role === 'full', phone: role === 'phone', tablet: role === 'tablet' };

if (!device.full) document.documentElement.classList.add(`is-${role}-app`);

const HIDDEN_PAGES = { full: [], tablet: ['wordpress', 'media'], phone: ['wordpress', 'media', 'sermons'] };

/** The pages this device leaves out, wherever a link to them comes from. */
export const deviceHiddenPages = () => HIDDEN_PAGES[role];
export const canOpenSection = (section) => !HIDDEN_PAGES[role].includes(section);

/**
 * Whether this device only reads a sermon, lesson, study or piece of writing. A tablet edits sermons and lessons as
 * plain pages; a phone reads them all. Builders stay on the web and Desktop.
 */
export function workIsReadOnlyHere({ sermon, bibleStudy, lesson, workflow }) {
  if (device.full) return false;
  if (device.phone) return !!(sermon || bibleStudy || lesson || workflow);
  return !!bibleStudy || workflow === 'writing';
}

export const USE_FULL_APP = 'You can start this on the web or in Selah Desktop.';

/** For a way in to new work that this device doesn't do. Returns true when the caller should stop. */
export function needsFullApp(dialog) {
  if (device.full) return false;
  dialog.toast(USE_FULL_APP);
  return true;
}
