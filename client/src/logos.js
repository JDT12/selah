import { logosUrl } from '../../shared/scripture.js';

/**
 * Where Logos links open, chosen per device (Settings → Logos):
 *   desktop: the installed Logos app, through its logosres: links (computers; phones don't support them)
 *   web:     ref.ly, which opens the Logos website or mobile app
 * Notes and WordPress always store the universal ref.ly form; this only changes what a click does.
 */
const MODE_KEY = 'noteapp.logosOpen';
const BIBLE_KEY = 'noteapp.logosBible';

const isPhone = () => window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

export const logosMode = () => read(MODE_KEY) || (isPhone() ? 'web' : 'desktop');
export const setLogosMode = (mode) => write(MODE_KEY, mode);

/** The Bible passages open in on the desktop: its Logos resource id and reference type (ESV is Logos's own example). */
export const DEFAULT_BIBLE = { id: 'esv', type: 'BibleESV', name: 'ESV' };
export function logosBible() {
  try { return JSON.parse(read(BIBLE_KEY)) || DEFAULT_BIBLE; } catch { return DEFAULT_BIBLE; }
}
export const setLogosBible = (bible) => write(BIBLE_KEY, JSON.stringify(bible));

/**
 * Learns a Bible from a link copied in Logos ("Copy location as → URL" or Share → Copy link while reading it), e.g.
 * https://ref.ly/logosres/nasb95?ref=BibleNASB95.Jn3.16 or logosres:nasb95;ref=BibleNASB95.Jn3.16.
 */
export function bibleFromLink(text) {
  const m = /(?:ref\.ly\/logosres\/|logosres:)([\w.-]+)[?;]ref=(Bible[\w]*)\./i.exec(String(text).trim());
  return m ? { id: m[1], type: m[2], name: m[2].replace(/^Bible/i, '') || m[1].toUpperCase() } : null;
}

/** Logos's form of a passage, e.g. "Jn3.16-18", from a ref.ly link we already build. */
const location = (ref) => logosUrl(ref).replace(/^https:\/\/ref\.ly\//, '');

/** The link a click on a passage should follow. */
export function passageLink(ref) {
  if (logosMode() !== 'desktop') return logosUrl(ref);
  const b = logosBible();
  return `logosres:${b.id};ref=${b.type}.${location(ref)}`;
}

/** For a link in a note: ref.ly links to Logos books/passages become desktop links when opening in the app. */
export function linkTarget(href) {
  if (logosMode() !== 'desktop') return href;
  const res = /^https?:\/\/ref\.ly\/(logosres|logos4)\/([^?;#]+)(?:[?;]([^#]*))?/i.exec(href);
  if (res) {
    // ref.ly writes spaces as "+" and commas as "%2c" ("VolumePage.V+1%2c+p+15"); the desktop app's own links use
    // underscores and plain commas ("VolumePage.V_1,_p_15").
    const raw = /(?:^|[&;])ref=([^&;]*)/.exec(res[3] ?? '')?.[1];
    let ref = raw;
    if (raw) { try { ref = decodeURIComponent(raw.replace(/\+/g, ' ')).replace(/ /g, '_'); } catch { /* keep it as it is */ } }
    return `${res[1].toLowerCase()}:${res[2]}${ref ? `;ref=${ref}` : ''}`;
  }
  // A plain passage link (https://ref.ly/Ro8.28) opens in your Bible.
  const passage = /^https?:\/\/ref\.ly\/([1-3]?[A-Za-z]+\d[\w.:-]*)$/i.exec(href);
  if (passage) { const b = logosBible(); return `logosres:${b.id};ref=${b.type}.${passage[1]}`; }
  return href;
}

/** Opens a link: desktop app links hand over to Logos without leaving the page; web links open in a new tab. */
export function openLink(href) {
  // Selah's own notes (#note/12) open here, not in a new window.
  try {
    const u = new URL(href, location.href);
    if (u.origin === location.origin && /^#note\//.test(u.hash) && u.pathname === '/') { location.hash = u.hash; return; }
  } catch { /* not a URL */ }
  const target = linkTarget(href);
  if (/^(logosres|logos4):/i.test(target)) {
    // The browser hands logosres: links to the Logos app (asking the first time); the page stays where it is.
    // Done just after the click: during a Ctrl+click Chrome treats the link as "open in a background tab", which
    // silently fails for an app link. The click still counts as permission for a few seconds.
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = target;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
    }, 0);
  } else {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
}
export const openPassage = (ref) => openLink(passageLink(ref));
