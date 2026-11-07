import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatSize } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Settings row: when a backup was last downloaded, and the button that makes one. */
export function BackupDownloadRow() {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const load = useCallback(() => api.backupDownloadInfo().then(setS).catch(() => setS(null)), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="about-row">
      <span className="muted">
        A fresh copy of everything as one file, to keep where you like: iCloud Drive, another cloud, a USB stick.
        {s?.last ? ` Last downloaded ${when(s.last.at)}.` : ''}
      </span>
      <button className="btn btn-small" onClick={async () => { await dialog.open((c) => <BackupDownloadDialog close={c} />); load(); }}>Download…</button>
    </div>
  );
}

/**
 * Download a backup now (server/backupdownload.js): encrypted with a passphrase (recommended) or not. The download is
 * a plain link the server streams; afterwards this waits for the server to say it finished.
 */
export function BackupDownloadDialog({ close }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [encrypt, setEncrypt] = useState(true);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [state, setState] = useState(null); // null | 'starting' | 'making' | 'done'
  const startedAt = useRef(0);

  const load = useCallback(() => api.backupDownloadInfo().then((x) => { setS(x); return x; }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  // While the server streams the file, check now and then for it to finish.
  useEffect(() => {
    if (state !== 'making') return undefined;
    const t = setInterval(async () => {
      const x = await load();
      if (x && !x.making && (x.last?.at ?? 0) >= startedAt.current) setState('done');
    }, 2000);
    return () => clearInterval(t);
  }, [state, load]);

  const problem = encrypt && pass.length < 12 ? 'The passphrase needs at least 12 characters.'
    : encrypt && pass !== pass2 ? 'The passphrases don’t match.' : null;

  const start = async (e) => {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    setError(null);
    setState('starting');
    try {
      startedAt.current = Date.now();
      const { url } = await api.startBackupDownload(encrypt, encrypt ? pass : null);
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      setPass(''); setPass2('');
      setState('making');
    } catch (err) {
      if (err.status !== 403) setError(err.message);
      setState(null);
    }
  };

  const busy = state === 'starting' || state === 'making';
  return (
    <form className="offsite-dialog stack-form" onSubmit={start}>
      <h2>Download a backup</h2>
      <p className="modal-message">
        A snapshot of your notes, notebooks, tasks, settings and every attachment, made now, as one file. Keep it
        somewhere away from Selah. It can be restored into a Selah server with <code>npm run restore -- --file</code>, or by
        your Selah host.
      </p>
      {s && (
        <p className="backup-dl-size">
          <Icon name="file" size={16} />
          <span>{s.notes.toLocaleString()} notes and {s.attachments.toLocaleString()} attachments, about <strong>{formatSize(s.bytes)}</strong> before compression.{s.last ? <span className="muted"> Last downloaded {when(s.last.at)}.</span> : ''}</span>
        </p>
      )}

      <div className="backup-dl-choice">
        <label>
          <input type="radio" name="dl-enc" checked={encrypt} onChange={() => { setEncrypt(true); setError(null); }} disabled={busy} />
          <span><strong>Encrypted with a passphrase <span className="backup-dl-badge">Recommended</span></strong>
            <span className="muted">A .selahbak file. Nobody can read it without the passphrase, so it’s safe in any cloud.</span></span>
        </label>
        <label>
          <input type="radio" name="dl-enc" checked={!encrypt} onChange={() => { setEncrypt(false); setError(null); }} disabled={busy} />
          <span><strong>Not encrypted</strong>
            <span className="muted">A .tar.gz that opens with the Files app, Finder or any zip tool, holding notes.db and your attachments.</span></span>
        </label>
      </div>

      {encrypt ? (
        <>
          <input className="input" type="password" autoComplete="new-password" placeholder="Passphrase (at least 12 characters)" value={pass}
            onChange={(e) => { setPass(e.target.value); setError(null); }} aria-label="Passphrase" disabled={busy} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={pass2}
            onChange={(e) => { setPass2(e.target.value); setError(null); }} aria-label="Passphrase again" disabled={busy} />
          <p className="muted offsite-hint">
            {s?.offsite ? 'Using your off-site backup passphrase means one less thing to keep. ' : ''}
            <strong>Without the passphrase the file can’t be opened, and nobody can recover it.</strong>
          </p>
        </>
      ) : (
        <p className="offsite-warn backup-dl-warn">
          Anyone who gets this file can read every note, and it holds the key to the sign-ins Selah keeps (ESV, WordPress,
          Zotero). Keep it somewhere private, not a shared folder.
        </p>
      )}

      {state === 'starting' && <p className="offsite-running" role="status"><span className="offsite-spinner" aria-hidden="true" /> Getting it ready…</p>}
      {state === 'making' && (
        <p className="offsite-running" role="status">
          <span className="offsite-spinner" aria-hidden="true" />
          Your download has started. Your browser shows its progress; a big Selah takes a few minutes. You can close this.
        </p>
      )}
      {state === 'done' && (
        <p className="offsite-check is-good" role="status">
          <strong>✓ Backup downloaded{s?.last?.bytes ? ` (${formatSize(s.last.bytes)})` : ''}.</strong>
          <span>{s?.last?.encrypted ? 'Keep the passphrase with it, somewhere else (a password manager).' : 'Keep it somewhere private.'}</span>
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>{state ? 'Close' : 'Cancel'}</button>
        {state !== 'done' && (
          <button type="submit" className="btn btn-primary" disabled={busy || !s}>
            <Icon name="download" size={14} /> {busy ? 'Downloading…' : 'Download backup'}
          </button>
        )}
      </div>
    </form>
  );
}
