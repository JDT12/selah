import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * Signing in to OneDrive from the browser (server/rclone.js oneDriveAuthorizer): Microsoft's sign-in opens in a new
 * tab; afterwards that tab lands on an address starting with http://localhost:53682/ that doesn't load, and that
 * address is pasted back here. `start()` resolves to the Microsoft address, `finish(url)` to { account }.
 */
export default function OneDriveConnect({ start, finish, account, onSignedIn }) {
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const open = async () => {
    setError(null);
    // Open the tab now (while it still counts as a click), then send it to Microsoft.
    const tab = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const { url } = await start();
      if (tab) tab.location.href = url; else window.open(url, '_blank', 'noopener');
      setOpened(true);
    } catch (e) {
      tab?.close();
      if (e.status !== 403) setError(e.message);
    }
    setBusy(false);
  };
  const done = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await finish(pasted.trim());
      setPasted('');
      onSignedIn(r.account);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  if (account) {
    return <p className="onedrive-signed"><Icon name="check" size={16} /> Signed in to OneDrive as <strong>{account}</strong>.</p>;
  }
  return (
    <div className="onedrive-connect">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={open}>
        <Icon name="external" size={14} /> {opened ? 'Open the Microsoft sign-in again' : 'Connect OneDrive'}
      </button>
      {opened && (
        <ol className="offsite-steps">
          <li>In the new tab, sign in with your Microsoft account and accept.</li>
          <li>The tab then says it <strong>can’t reach the page</strong>. That’s expected: its address holds the sign-in.</li>
          <li>Copy the whole address from that tab’s address bar (it starts with <code>http://localhost:53682/</code>) and paste it here:</li>
        </ol>
      )}
      {opened && (
        <div className="onedrive-paste">
          <input className="input" value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false}
            placeholder="http://localhost:53682/?code=…" aria-label="Address after signing in" />
          <button type="button" className="btn" disabled={busy || !/^http:\/\/(localhost|127\.0\.0\.1):53682\//.test(pasted.trim())} onClick={done}>
            {busy ? 'Checking…' : 'Finish sign-in'}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
