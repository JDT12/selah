import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { serverMode } from '../mode.js';
import { useDialog } from './Dialogs.jsx';
import StorageMeter from './StorageMeter.jsx';
import { BackupDownloadDialog } from './BackupDownload.jsx';
import { IdentityRows } from './IdentityDialogs.jsx';

const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Deleting a hosted account: type its name, then confirm it's you. */
function DeleteAccountDialog({ tenant, close }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(typed);
      close(true);
    } catch (err) {
      if (err.status !== 403) setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form" onSubmit={submit}>
      <h2>Delete your account?</h2>
      <p>Every note, notebook, attachment, task and setting in this Selah is deleted, along with your host’s backups of it. You’ll be signed out everywhere and this address will stop working.</p>
      <p><strong>This can’t be undone.</strong> Download your data first if you might want it.</p>
      <label className="field-label" htmlFor="delete-confirm">Type <code>{tenant}</code> to confirm</label>
      <input id="delete-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== tenant}>Delete my account</button>
      </div>
    </form>
  );
}

/** Settings → Account: the username and email you sign in with (10.0), storage, downloading everything, the host's backup and (hosted) deleting the account. */
export default function AccountPane({ onDeleted }) {
  const dialog = useDialog();
  const [a, setA] = useState(null);
  useEffect(() => { api.account().then(setA).catch((e) => dialog.toast(e.message, 'error')); }, [dialog]);
  const hosted = serverMode() === 'tenant';

  const download = () => dialog.open((c) => <BackupDownloadDialog close={c} />);
  const remove = async () => {
    if (await dialog.open((c) => <DeleteAccountDialog tenant={a.tenant} close={c} />)) onDeleted();
  };

  return (
    <>
      <IdentityRows />

      <h3>Storage</h3>
      <StorageMeter />

      {hosted && a && (
        <>
          <h3>Backups</h3>
          <div className="about-row">
            <span className="muted">
              {a.hostBackup?.ok ? `Your Selah host backs up everything every night. Last backup: ${when(a.hostBackup.at)}.`
                : a.hostBackup ? `Your host’s last backup didn’t finish (${when(a.hostBackup.at)}). They’ve been told.`
                  : 'Your Selah host backs up everything every night; the first backup hasn’t run yet.'}
              {' '}You can also keep your own encrypted copy, every night in your OneDrive, an S3 bucket or on a WebDAV server, or downloaded whenever you like (Data &amp; backup).
            </span>
          </div>
        </>
      )}

      <h3>Your data</h3>
      <div className="about-row">
        <span className="muted">Everything in one file you can keep or restore from: your notes database and every attachment, encrypted if you like. To use notes in other apps, use Export everything on Data &amp; backup instead.</span>
        <button className="btn btn-small" onClick={download}>Download all my data</button>
      </div>

      {hosted && a && (
        <>
          <h3>Delete account</h3>
          <div className="about-row">
            <span className="muted">Deletes this Selah, everything in it and your host’s backups of it.</span>
            <button className="btn btn-small btn-danger-text" onClick={remove}>Delete account…</button>
          </div>
        </>
      )}
    </>
  );
}
