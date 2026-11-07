import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import CertificateHelp, { detectPlatform } from './CertificateHelp.jsx';
import { canPromptInstall, isInstalledApp, onInstallChange, promptInstall } from '../install.js';

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/Edg(A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/CriOS\//.test(ua)) return 'chrome-ios';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/**
 * The browser to install with on each kind of device: Chrome on Android (other Android browsers only add a
 * shortcut, which can't receive shares) and Safari on iPhone, iPad and Mac. Elsewhere, whatever you're using.
 */
const RECOMMENDED = { android: 'chrome', ios: 'safari', mac: 'safari' };
const NAMES = { chrome: 'Chrome', safari: 'Safari' };
const wrongBrowser = (platform, browser) => !!RECOMMENDED[platform] && RECOMMENDED[platform] !== browser;

function manualSteps(platform, browser) {
  if (wrongBrowser(platform, browser)) {
    const want = NAMES[RECOMMENDED[platform]];
    return (
      <>
        <p><strong>Use {want} on this {platform === 'android' ? 'phone' : platform === 'mac' ? 'Mac' : 'iPhone or iPad'}.</strong>{' '}
          {platform === 'android'
            ? 'Other Android browsers only add a shortcut, and a shortcut can’t receive things from the share menu.'
            : `Install Selah from ${want} so it opens as an app of its own.`}</p>
        <p>Open <strong>{location.host}</strong> in {want}, sign in, then:</p>
        {manualSteps(platform, RECOMMENDED[platform])}
      </>
    );
  }
  if (platform === 'ios') return <p>In Safari, tap <strong>Share</strong> → <strong>Add to Home Screen</strong> → <strong>Add</strong>.</p>;
  if (platform === 'android') return <p>In Chrome, tap <strong>⋮</strong> → <strong>Install app</strong> (on some phones, <strong>Add to Home screen</strong> → <strong>Install</strong>). Selah then shows up in your apps and in the share menu.</p>;
  if (platform === 'mac') return <p>In Safari, choose <strong>File</strong> → <strong>Add to Dock</strong>.</p>;
  if (browser === 'edge') return <p>Click <strong>⋯</strong> (top right) → <strong>Apps</strong> → <strong>Install this site as an app</strong>.</p>;
  if (browser === 'chrome') return <p>Click the install icon at the right of the address bar, or <strong>⋮</strong> → <strong>Cast, save and share</strong> → <strong>Install page as app</strong>.</p>;
  return <p>This browser can't install web apps. Open Selah in <strong>Microsoft Edge</strong> or <strong>Google Chrome</strong> and install it from there.</p>;
}

/** How to install by hand, for when the browser doesn't offer its own prompt. */
function InstallAppHelp({ cert, close }) {
  const dialog = useDialog();
  return (
    <div className="cert-help">
      <div className="dialog-header">
        <h2>Install as an app</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <p className="modal-message">
        Selah opens in its own window, with an icon in the Start menu and taskbar (or on the home screen).
        It's the same app and the same notes.
      </p>
      <div className="cert-steps">{manualSteps(detectPlatform(), detectBrowser())}</div>
      <h3>Don't see the option?</h3>
      <ul className="cert-notes">
        {cert && (
          <li>Browsers only offer it when the connection is trusted. If the address bar says “Not secure”,{' '}
            <button type="button" className="link-btn" onClick={() => dialog.open((c) => <CertificateHelp cert={cert} close={c} />)}>trust this device</button> first.</li>
        )}
        <li>If it's already installed, the browser shows <strong>Open in app</strong> instead.</li>
        {detectPlatform() === 'windows' && <li>To keep it on the taskbar, right-click its icon there → <strong>Pin to taskbar</strong>.</li>}
      </ul>
    </div>
  );
}

/** The Settings row: Install button (or instructions), or a note that this already is the app. */
export function InstallAppRow({ cert }) {
  const dialog = useDialog();
  const [, rerender] = useState(0);
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);

  if (isInstalledApp()) {
    return <div className="about-row"><span className="muted">You're using the installed app.</span></div>;
  }
  // In the wrong browser for this device, explain which one to use instead of installing a lesser version.
  const install = () => (canPromptInstall() && !wrongBrowser(detectPlatform(), detectBrowser())
    ? promptInstall()
    : dialog.open((c) => <InstallAppHelp cert={cert} close={c} />));
  return (
    <div className="about-row">
      <span className="muted">Open Selah in its own window, with a taskbar or home-screen icon.</span>
      <button className="btn btn-small" onClick={install}>Install…</button>
    </div>
  );
}
