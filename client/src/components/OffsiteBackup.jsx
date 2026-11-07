import { useCallback, useEffect, useState } from 'react';
import { api, formatSize } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { Command } from './CertificateHelp.jsx';
import Icon from './Icon.jsx';
import { useStoragePicker } from './StoragePicker.jsx';
import { isHosted } from '../mode.js';

const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** "Backing up to Jason’s OneDrive", "Backing up to the Backblaze B2 bucket selah-backup"… */
function destination(s) {
  if (s.provider === 's3') return <>Backing up to the {s.serviceName} bucket <strong>{s.account}</strong></>;
  if (s.provider === 'webdav') return <>Backing up to <strong>{s.account}</strong> (WebDAV)</>;
  return <>Backing up to <strong>{s.account}</strong>’s OneDrive</>;
}

/** Settings row: a one-line summary and the button that opens the dialog. */
export function OffsiteBackupRow() {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const load = useCallback(() => api.offsite().then(setS).catch(() => setS({ error: true })), []);
  useEffect(() => { load(); }, [load]);

  let summary = 'An encrypted copy of your notes every night, in your OneDrive, an S3 bucket or on a WebDAV server.';
  if (s?.configured) {
    if (s.running) summary = `Backing up now: ${s.running.phase}…`;
    else if (s.last && !s.last.ok) summary = `Last backup failed (${when(s.last.finishedAt)}).`;
    else if (s.lastSuccess) summary = `${s.serviceName} · last backup ${when(s.lastSuccess.finishedAt)}.`;
    else summary = `${s.serviceName} · no backup yet.`;
  }
  const failed = s?.configured && s.last && !s.last.ok;
  return (
    <div className="about-row">
      <span className={failed ? 'offsite-failed' : 'muted'}>{summary}</span>
      <button className="btn btn-small" onClick={async () => { await dialog.open((c) => <OffsiteBackupDialog close={c} />); load(); }}>
        {s?.configured ? 'Manage…' : 'Set up…'}
      </button>
    </div>
  );
}

export function OffsiteBackupDialog({ close }) {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [setup, setSetup] = useState(false);

  const load = useCallback(() => api.offsite().then((x) => { setS(x); setError(null); return x; })
    .catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  // Poll while a run is in progress.
  useEffect(() => {
    if (!s?.running) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [s?.running, load]);

  const start = async (kind) => {
    try {
      await api.runOffsite(kind);
      await load();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const disconnect = async () => {
    const ok = await dialog.confirm({
      title: 'Turn off off-site backup?',
      message: `Nightly backups to ${s.serviceName} stop and the sign-in is removed from this server. Backups already there `
        + 'stay; set it up again with the same passphrase to carry on using them.',
      okLabel: 'Turn off', danger: true,
    });
    if (!ok) return;
    try { await api.disconnectOffsite(); await load(); } catch (e) { dialog.toast(e.message, 'error'); }
  };

  if (!s) {
    return (
      <div className="offsite-dialog">
        <h2>Off-site backup</h2>
        {error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}
        <div className="modal-actions"><button className="btn" onClick={() => close()}>Close</button></div>
      </div>
    );
  }

  if (!s.configured || setup) {
    return (
      <SetupForm status={s} reconnect={s.configured} onCancel={s.configured ? () => setSetup(false) : () => close()}
        onDone={async () => { setSetup(false); await load(); await start('backup'); }} onRecheck={load} />
    );
  }

  const { last, lastSuccess, lastVerify, running } = s;
  return (
    <div className="offsite-dialog">
      <h2>Off-site backup</h2>
      <p className="wp-connected"><Icon name="check" size={16} /><span>{destination(s)}, encrypted.</span></p>
      <p className="muted offsite-sub">Folder “{s.folder}” · nightly after the local backup · {s.rclone ? `rclone ${s.rclone}` : 'rclone missing!'}</p>

      {running && (
        <p className="offsite-running" role="status">
          <span className="offsite-spinner" aria-hidden="true" />
          {running.kind === 'verify' ? 'Checking' : 'Backing up'}: {running.phase}… <span className="muted">started {ago(running.startedAt)}</span>
        </p>
      )}

      <dl className="offsite-facts">
        <dt>Last backup</dt>
        <dd>
          {!lastSuccess && !last && 'None yet'}
          {last && !last.ok && last.kind === 'backup' && <span className="offsite-failed">Failed {when(last.finishedAt)}: {last.error}</span>}
          {lastSuccess && (!last || last.ok || last.kind !== 'backup' ? <>{when(lastSuccess.finishedAt)} <span className="offsite-ok">✓</span></> : <div className="muted">Last good one: {when(lastSuccess.finishedAt)}</div>)}
        </dd>
        {lastSuccess && (<>
          <dt>Contains</dt>
          <dd>
            {lastSuccess.notes.toLocaleString()} notes, {lastSuccess.files.count.toLocaleString()} attachments ({formatSize(lastSuccess.files.bytes)})
            <div className="muted">
              {lastSuccess.sent.count ? `${lastSuccess.sent.count} new attachment${lastSuccess.sent.count === 1 ? '' : 's'} (${formatSize(lastSuccess.sent.bytes)}) sent` : 'No new attachments'}
              {' '}last time · {lastSuccess.snapshots} daily snapshot{lastSuccess.snapshots === 1 ? '' : 's'} kept ({s.keepDays} days, always the latest {s.keepMin})
            </div>
          </dd>
        </>)}
        <dt>Restore check</dt>
        <dd>
          {!lastVerify && 'Not yet (runs weekly)'}
          {lastVerify?.ok && <>{when(lastVerify.at)} <span className="offsite-ok">✓</span> <span className="muted">the latest snapshot opens and every attachment matches</span></>}
          {lastVerify && !lastVerify.ok && <span className="offsite-failed">Failed {when(lastVerify.at)}: {lastVerify.error}</span>}
        </dd>
      </dl>

      {s.history.length > 0 && (
        <details className="offsite-history">
          <summary>Recent runs</summary>
          <ul>
            {s.history.map((r) => (
              <li key={r.startedAt}>
                <span className={r.ok ? 'offsite-ok' : 'offsite-failed'}>{r.ok ? '✓' : '✗'}</span>{' '}
                {when(r.startedAt)} · {r.kind === 'verify' ? 'check' : 'backup'} ({r.trigger}) · {Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} s
                {r.ok && r.kind === 'backup' && ` · ${r.sent.count} new`}
                {!r.ok && <span className="muted"> · {r.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="modal-actions spread">
        <span>
          <button type="button" className="btn btn-danger-text" onClick={disconnect} disabled={!!running}>Turn off</button>
          <button type="button" className="btn" onClick={() => setSetup(true)} disabled={!!running} title="Sign in again, or change where backups go">Change…</button>
        </span>
        <span className="modal-actions-group">
          <button type="button" className="btn" onClick={async () => { await dialog.open((c) => <PassphraseCheckDialog close={c} />); load(); }}>Test passphrase…</button>
          <button type="button" className="btn" onClick={() => start('verify')} disabled={!!running}>Check backup</button>
          <button type="button" className="btn" onClick={() => start('backup')} disabled={!!running}>Back up now</button>
          <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>
        </span>
      </div>
    </div>
  );
}

/**
 * Type the passphrase you've stored and confirm it's the right one: it must match this server's key
 * and decrypt the backup in the storage. Doing this now and then proves the copy you'd need for a restore works.
 */
export function PassphraseCheckDialog({ close }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!pass) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.checkOffsitePassphrase(pass));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const good = result?.matches && result?.readsBackup;
  return (
    <form className="offsite-dialog stack-form" onSubmit={submit}>
      <h2>Test your backup passphrase</h2>
      <p className="modal-message">
        Type the passphrase from where you keep it (password manager, paper). It’s checked against this server’s
        key and used to decrypt the backup in your storage, then forgotten.
      </p>
      <input className="input" type="password" autoComplete="off" autoFocus placeholder="Backup passphrase" value={pass}
        onChange={(e) => { setPass(e.target.value); setResult(null); }} aria-label="Backup passphrase" />
      {result && (
        <div className={`offsite-check ${good ? 'is-good' : 'is-bad'}`} role="status">
          {good && (<>
            <strong>✓ That’s the right passphrase.</strong>
            <span>It matches this server’s key and decrypted the backup in your storage
              (latest: {when(Date.parse(result.manifest.createdAt))}, {result.manifest.notes} notes, {result.manifest.files} attachments).
              Keep it where you found it: it’s what a restore needs.</span>
          </>)}
          {!result.matches && (<>
            <strong>✗ That’s not the backup passphrase.</strong>
            <span>It doesn’t match the key this server encrypts with, so it couldn’t restore the backup. Check for typos,
              capital letters and spaces. If you’ve lost it, set up the backup again with a new passphrase (in a new, empty
              folder or bucket), and store that one carefully.</span>
          </>)}
          {result.matches && !result.readsBackup && (<>
            <strong>✓ It matches this server’s key</strong>
            <span>but the backup in your storage couldn’t be read just now{result.error ? `: ${result.error}` : ''}. Try again, or use Check backup.</span>
          </>)}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(good)}>{result ? 'Done' : 'Cancel'}</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !pass}>{busy ? 'Checking…' : 'Test'}</button>
      </div>
    </form>
  );
}

function SetupForm({ status, reconnect, onCancel, onDone, onRecheck }) {
  const picker = useStoragePicker({
    prev: reconnect ? status : null,
    rcloneReady: status.rclone,
    connect: { start: api.offsiteConnectStart, finish: api.offsiteConnectFinish },
    test: api.testOffsite,
    folder: status.folder?.split('/').pop() || 'Note App Backup',
    rcloneSignIn: !isHosted(),
  });
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { sameStorage } = picker;

  const problem = picker.problem
    ?? (pass.length < 12 ? 'The passphrase needs at least 12 characters.'
      : pass !== pass2 ? 'The passphrases don’t match.'
        : !saved ? 'Confirm you’ve saved the passphrase.' : null);

  const submit = async (e) => {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api.setupOffsite({ ...picker.body(), passphrase: pass });
      setPass(''); setPass2('');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="offsite-dialog stack-form" onSubmit={submit}>
      <h2>{reconnect ? 'Change off-site backup' : 'Set up off-site backup'}</h2>
      <p className="modal-message">
        {isHosted()
          ? 'Every night an encrypted copy of your notes, attachments and settings goes to storage you own, besides your host’s backup. It’s encrypted with your passphrase before it leaves the server, so neither the storage company nor your host can read it.'
          : 'Every night, after the local backup, an encrypted copy of your notes, attachments, settings and the server’s certificates goes to storage you own. It’s encrypted on this server with your passphrase first, so the storage company can’t read it.'}
      </p>

      {!status.rclone && (
        <div className="offsite-warn">
          <p><strong>rclone isn’t installed on the server yet.</strong> In the app’s folder on the server, run:</p>
          <Command text="npm run install-rclone" />
          <button type="button" className="btn btn-small" onClick={onRecheck}>Check again</button>
        </div>
      )}

      <h3>1. Where to back up</h3>
      {picker.ui}

      <h3>2. {sameStorage ? 'Enter your backup passphrase' : 'Choose a backup passphrase'}</h3>
      {sameStorage && <p className="muted offsite-hint">Use the same passphrase as before, so the existing backup can still be read.</p>}
      {reconnect && !sameStorage && <p className="muted offsite-hint">Backups start afresh in the new place. The ones in {status.serviceName} stay there.</p>}
      <input className="input" type="password" autoComplete="new-password" placeholder="At least 12 characters" value={pass}
        onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" />
      <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={pass2}
        onChange={(e) => setPass2(e.target.value)} aria-label="Passphrase again" />
      <label className="wp-check offsite-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I’ve saved this passphrase somewhere other than this server (a password manager, and on paper).
          <strong> Without it the backup can’t be restored, and nobody can recover it.</strong></span>
      </label>

      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !status.rclone}>
          {busy ? 'Connecting…' : reconnect ? 'Save and back up' : 'Connect and back up'}
        </button>
      </div>
    </form>
  );
}
