import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';

/**
 * Settings → About → Updates, on Selah Cloud in its container (14.1): which version is running, whether a newer
 * release is published, and Update, which hands the move to the updater beside Selah (docker/cloud/updater.sh).
 * Selah restarts during it, so the row keeps asking until the new version answers, then offers Reload.
 */
const STATE = {
  pulling: 'Downloading',
  starting: 'Starting',
};

/** Waits for Selah to answer again after it restarts, then reloads (to the sign-in page). */
async function reloadWhenBack() {
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('/api/session', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  location.reload();
}

/**
 * Settings → Data & backup → Replace the library, on Selah Cloud in its container (14.1): a backup file from Selah
 * Desktop, another Selah Cloud or a Ministry Selah becomes this Selah's library. Selah restarts to put it in place; the
 * library it replaces is kept aside on the server, and the sign-in stays this Selah's own.
 */
export function CloudRestoreRow() {
  const dialog = useDialog();
  const [busy, setBusy] = useState(null);
  const input = useRef(null);

  const chosen = async (file) => {
    if (!file) return;
    if (!await dialog.confirm({
      title: 'Replace your whole library?',
      message: `Every note, notebook, task and attachment here is replaced by what’s in ${file.name}. The library you have now is kept aside on the server, not deleted. Your username, password and two-step sign-in stay as they are. Selah restarts, and you sign in again.`,
      okLabel: 'Choose this backup',
      danger: true,
    })) return;
    try {
      setBusy('Uploading… 0%');
      const up = await api.cloudRestoreUpload(file, (p) => setBusy(`Uploading… ${Math.round(p * 100)}%`));
      let passphrase = null;
      if (up.encrypted) {
        setBusy('Waiting for the passphrase…');
        passphrase = await dialog.prompt({ title: 'This backup is encrypted', message: 'Enter the passphrase it was made with.', placeholder: 'Passphrase', secret: true, okLabel: 'Restore' });
        if (!passphrase) { setBusy(null); return; }
      }
      setBusy('Checking the backup…');
      const r = await api.cloudRestore(passphrase);
      setBusy(`Restoring ${r.notes} notes. Selah is restarting…`);
      reloadWhenBack();
    } catch (e) {
      setBusy(null);
      if (e.status !== 403) dialog.toast(e.message, 'error', 8000);
    }
  };

  return (
    <>
      <h3>Replace the library</h3>
      <div className="about-row">
        <span className="muted">{busy ?? 'Bring a whole library here from a backup file: from Selah Desktop, another Selah server, or a backup you downloaded.'}</span>
        <button className="btn btn-small" disabled={!!busy} onClick={() => input.current?.click()}>From a backup file…</button>
        <input ref={input} type="file" accept=".selahbak,.gz,.tar.gz,application/gzip,application/octet-stream" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; chosen(f); }} />
      </div>
    </>
  );
}

export default function CloudUpdatesRow() {
  const dialog = useDialog();
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [moving, setMoving] = useState(null); // version being moved to
  const timer = useRef(null);

  const load = async (fresh = false) => {
    setChecking(true);
    try { setInfo(await api.cloudUpdates(fresh)); } catch (e) { setInfo((i) => ({ ...(i ?? {}), error: e.message })); }
    setChecking(false);
  };
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);

  // While an update runs Selah itself restarts, so failed requests are expected: keep asking.
  const watch = (version) => {
    const tick = async () => {
      try {
        const r = await api.cloudUpdates();
        setInfo(r);
        const s = r.status;
        if (r.current === version) { setMoving(null); return; }
        if (s && s.version === version && ['rolled-back', 'failed'].includes(s.state)) { setMoving(null); return; }
      } catch { /* restarting */ }
      timer.current = setTimeout(tick, 3000);
    };
    timer.current = setTimeout(tick, 3000);
  };

  const update = async (version) => {
    if (!await dialog.confirm({
      title: `Update Selah to ${version}?`,
      message: 'Selah saves a copy of your library’s database, then restarts on the new version, which takes a minute or two. If the new version doesn’t start, it goes back to this one, with your library as it was.',
      okLabel: 'Update',
    })) return;
    try {
      await api.cloudUpdate(version);
      setMoving(version);
      watch(version);
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
  };

  if (!info) return <div className="about-row"><span className="muted">Checking for updates…</span></div>;
  const s = info.status;
  const running = moving || (s && STATE[s.state] ? s.version : null);
  // "Updated from …" and Reload only for an hour after an update.
  const justMoved = s?.state === 'done' && s.version === info.current && s.from && s.from !== s.version
    && Date.now() - Date.parse(s.at) < 3_600_000;
  return (
    <>
      <h3>Updates</h3>
      <div className="about-row">
        <span className="muted">
          {running
            ? <>Updating to {running}{s && STATE[s.state] ? `: ${STATE[s.state].toLowerCase()}` : ''}… Selah restarts during this.</>
            : info.newer
              ? <>Selah {info.newer} is out. This server runs {info.current}.</>
              : info.error
                ? info.error
                : <>Selah {info.current} is the newest version.</>}
          {!running && s?.state === 'rolled-back' && <> {s.error}</>}
          {!running && s?.state === 'failed' && s.version !== info.current && <> The last update didn’t finish: {s.error}</>}
          {!running && justMoved && <> Updated from {s.from}.</>}
        </span>
        <span className="about-btns">
          {!running && info.newer && <button className="btn btn-small btn-primary" onClick={() => update(info.newer)}>Update to {info.newer}</button>}
          {!running && !info.newer && <button className="btn btn-small" disabled={checking} onClick={() => load(true)}>{checking ? 'Checking…' : 'Check again'}</button>}
          {!running && justMoved && <button className="btn btn-small" onClick={() => location.reload()}>Reload</button>}
        </span>
      </div>
    </>
  );
}
