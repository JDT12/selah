import { useState } from 'react';
import Icon from './Icon.jsx';

export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'linux';
}

const PLATFORMS = { windows: 'Windows', mac: 'macOS', ios: 'iPhone / iPad', android: 'Android', linux: 'Linux' };

const WINDOWS_PS = 'Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\Selah-CA.crt" -CertStoreLocation Cert:\\CurrentUser\\Root';
const MAC_CMD = 'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/Selah-CA.crt';
const LINUX_CMD = 'certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Note App Local CA" -i ~/Downloads/Selah-CA.crt';

export function Command({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable (e.g. page not yet trusted) */ }
  };
  return (
    <div className="cert-command">
      <code>{text}</code>
      <button type="button" className="btn btn-small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

const STEPS = {
  windows: (
    <>
      <p>After downloading, open <strong>PowerShell</strong> (no admin needed) and run:</p>
      <Command text={WINDOWS_PS} />
      <p className="muted">Click <strong>Yes</strong> on the security warning. Or by hand: double-click the file → Install
        Certificate → Current User → <strong>Place all certificates in the following store</strong> → Browse →
        <strong> Trusted Root Certification Authorities</strong>. (The default “automatically select” puts it in the
        wrong store and the warning stays.)</p>
    </>
  ),
  mac: (
    <>
      <p>After downloading, run in Terminal:</p>
      <Command text={MAC_CMD} />
      <p className="muted">Or open the file in Keychain Access → System keychain → double-click it → Trust →
        <strong> When using this certificate: Always Trust</strong>.</p>
    </>
  ),
  ios: (
    <p>Tap the download, then <strong>Settings → Profile Downloaded → Install</strong>. Then turn it on in
      <strong> Settings → General → About → Certificate Trust Settings</strong>.</p>
  ),
  android: (
    <p>Download, then <strong>Settings → Security → Encryption &amp; credentials → Install a certificate →
      CA certificate</strong> and pick <em>Selah-CA.crt</em>.</p>
  ),
  linux: (
    <>
      <p>For Chrome / Chromium (needs <code>libnss3-tools</code>):</p>
      <Command text={LINUX_CMD} />
    </>
  ),
};

/** How to make this device trust the server's private certificate authority. */
export default function CertificateHelp({ cert, close }) {
  const [platform, setPlatform] = useState(detectPlatform);
  return (
    <div className="cert-help">
      <div className="dialog-header">
        <h2>Trust this device</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <p className="modal-message">
        Selah uses its own certificate authority. Install it once on each device and the browser's
        “Not secure” warning goes away.
      </p>

      <a className="btn btn-primary" href="/ca.crt" download="Selah-CA.crt">
        <Icon name="download" size={16} /> Download certificate
      </a>

      <div className="segmented cert-platforms">
        {Object.entries(PLATFORMS).map(([k, label]) => (
          <button key={k} type="button" className={platform === k ? 'is-active' : ''} onClick={() => setPlatform(k)}>{label}</button>
        ))}
      </div>
      <div className="cert-steps">{STEPS[platform]}</div>

      <h3>Then</h3>
      <ul className="cert-notes">
        <li><strong>Fully quit and reopen the browser</strong>. Browsers remember a certificate error until they restart.</li>
        <li><strong>Firefox</strong> keeps its own list: Settings → Privacy &amp; Security → View Certificates → Authorities → Import, and tick “Trust this CA to identify websites”.</li>
        {cert?.hosts?.length > 0 && (
          <li>Open the app by one of the names the certificate covers:{' '}
            {cert.hosts.map((h, i) => <span key={h}>{i > 0 && ', '}<code>{h}</code></span>)}.
            {!cert.hosts.includes(location.hostname) && <strong> You're using {location.hostname}, which isn't one of them.</strong>}
          </li>
        )}
        <li>Can't install it? Choose <strong>Advanced → Proceed</strong> on the browser's warning page. The connection is still encrypted, but the warning will stay.</li>
      </ul>

      {cert?.fingerprint && (
        <p className="cert-fingerprint">
          SHA-256 fingerprint (check it matches the installed certificate):<br /><code>{cert.fingerprint}</code>
        </p>
      )}
    </div>
  );
}
