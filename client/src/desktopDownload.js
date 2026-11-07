import { version } from '../../package.json';
import { DESKTOP_DOWNLOAD_URL, SOURCE_URL } from '../../shared/credits.js';

/**
 * Selah Desktop's Download button (12.1): start the right installer straight from the newest GitHub release instead of
 * opening the release page. Filenames carry the version (desktop-app/package.json artifactName), so the release's file
 * list is read from GitHub's API. A beta Selah (the demo) offers the newest beta, since "latest" skips prereleases.
 * Anything that goes wrong opens the release page, as before.
 */
const API = SOURCE_URL.replace('https://github.com/', 'https://api.github.com/repos/');

/** Windows, Mac or Linux from this browser, or null (phones and tablets; iPads report a Mac but have touch). */
export function desktopSystem() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints < 2) return 'Mac';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'Linux';
  return null;
}

/** 'arm64' or 'x64' for a Mac. Chrome and Edge say; Safari and Firefox don't, so Apple Silicon (every Mac since 2020). */
async function macArch() {
  try {
    const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
    if (architecture === 'x86') return 'x64';
  } catch { /* not offered */ }
  return 'arm64';
}

async function newestRelease() {
  const beta = version.includes('-');
  const r = await fetch(beta ? `${API}/releases?per_page=10` : `${API}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const data = await r.json();
  return beta ? data.find((rel) => !rel.draft) : data;
}

/** The installer for this computer in a release's files: the Setup .exe, the Mac .dmg for its chip, the Linux AppImage. */
export function pickAsset(assets, system, arch = 'arm64') {
  const names = {
    Windows: /^Selah-Setup-.+\.exe$/,
    Mac: new RegExp(`^Selah-.+-mac-${arch}\\.dmg$`),
    Linux: /^Selah-.+-x86_64\.AppImage$/,
  };
  return assets.find((a) => names[system]?.test(a.name)) ?? null;
}

/** Start the download (or open the release page). Called from a click. */
export async function downloadDesktop(system = desktopSystem()) {
  try {
    const release = await newestRelease();
    const asset = release && pickAsset(release.assets ?? [], system, system === 'Mac' ? await macArch() : undefined);
    if (asset) {
      location.href = asset.browser_download_url;
      return;
    }
  } catch { /* offline, rate limited: the page has every file */ }
  window.open(DESKTOP_DOWNLOAD_URL, '_blank', 'noopener');
}
