import { useCallback, useEffect, useState } from 'react';
import { api, formatSize } from '../api.js';
import { desktopWords, electron } from '../desktop.js';
import { isDesktopEdition } from '../mode.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

/**
 * Settings for Selah Desktop (12.0, desktop-app/):
 * - DesktopBackups (Data & backup): automatic backups to a folder (server/desktopbackup.js), Restore from one,
 *   Import a library from any backup file. Restoring replaces the whole library; the app restarts its server.
 * - DesktopAppRow (General → App): start at sign-in, the lock, Offline or a Selah server, updates. Those live in
 *   the app (window.selahDesktop), not the library.
 */

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const EVERY = [['daily', 'Every day'], ['weekly', 'Every week'], ['off', 'Off (only when I click Back up now)']];

export function DesktopBackups() {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.desktopBackups().then((x) => { setS(x); setError(null); return x; }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    try { await api.saveDesktopBackups(patch); await load(); return true; } catch (e) { dialog.toast(e.message, 'error', 7000); return false; }
  };

  const chooseFolder = async () => {
    const picked = await electron()?.pickFolder({ title: 'Choose where Selah keeps its backups', defaultPath: s?.folder ?? s?.suggested });
    if (picked) await save({ folder: picked });
  };
  const useSuggested = () => save({ folder: s.suggested });

  const runNow = async () => {
    setBusy(true);
    const t = dialog.toast('Making a backup…', 'info', 60_000);
    try {
      const r = await api.runDesktopBackup();
      t.close();
      dialog.toast(`Backed up (${formatSize(r.bytes)})`);
    } catch (e) {
      t.close();
      dialog.toast(e.message, 'error', 8000);
    } finally {
      setBusy(false);
      load();
    }
  };

  const setPassphrase = async () => {
    if (s.encrypted) {
      const off = await dialog.confirm({
        title: 'Stop encrypting backups?',
        message: 'New backups will be plain .tar.gz files that anyone with the folder can open. Backups already made keep their passphrase.',
        okLabel: 'Stop encrypting',
      });
      if (off) save({ passphrase: null });
      return;
    }
    const p = await dialog.open((c) => <PassphraseDialog close={c} />);
    if (p) save({ passphrase: p });
  };

  const restore = async (target) => {
    // target: { file } (one in the folder) or { path } (any backup file).
    let passphrase = null;
    const name = target.file ?? target.path.split(/[\\/]/).pop();
    const encrypted = /\.selahbak$/i.test(name);
    const ok = await dialog.confirm({
      title: target.file ? 'Restore this backup?' : 'Import this library?',
      message: `Your whole library is replaced by ${name}: every note, study, sermon, setting and attachment. What you have now is kept aside in Selah’s folder (storage-before-restore), until the next restore. Selah restarts to do it.`,
      okLabel: target.file ? 'Restore' : 'Import',
      danger: true,
    });
    if (!ok) return;
    if (encrypted) {
      passphrase = await dialog.open((c) => <PassphraseDialog close={c} ask title="This backup is encrypted" />);
      if (!passphrase) return;
    }
    setBusy(true);
    const t = dialog.toast('Checking the backup…', 'info', 120_000);
    try {
      await api.desktopRestore({ ...target, passphrase });
      t.update('Restarting Selah…');
      await electron()?.restartServer();
    } catch (e) {
      t.close();
      dialog.toast(e.message, 'error', 9000);
      setBusy(false);
    }
  };
  const importLibrary = async () => {
    const p = await electron()?.pickBackupFile();
    if (p) restore({ path: p });
  };

  if (!isDesktopEdition()) return null;
  if (error) return <p className="muted">{error}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  const backups = s.backups ?? [];
  return (
    <>
      {s.restored && (
        <div className="about-row dtb-restored">
          <span className="muted">
            Restored from {s.restored.from} on {when(s.restored.appliedAt)}. Your library from before is in Selah’s folder
            (storage-before-restore) until the next restore.
          </span>
          <button className="btn btn-small" onClick={() => api.dismissDesktopRestored().then(load)}>OK</button>
        </div>
      )}
      <h3>Automatic backups</h3>
      {!s.folder ? (
        <div className="about-row">
          <span className="muted">
            Selah can back up your whole library to a folder by itself. A folder in OneDrive, iCloud Drive or Dropbox
            keeps a copy off this computer. Suggested: <strong>{s.suggested}</strong>
          </span>
          <span className="about-btns">
            <button className="btn btn-small btn-primary" onClick={useSuggested}>Use this folder</button>
            <button className="btn btn-small" onClick={chooseFolder}>Choose…</button>
          </span>
        </div>
      ) : (
        <>
          <div className="about-row">
            <span className="muted">
              Backups go to <strong>{s.folder}</strong>
              {s.syncFolders?.some((f) => s.folder.toLowerCase().startsWith(f.path.toLowerCase())) ? ` (synced by ${s.syncFolders.find((f) => s.folder.toLowerCase().startsWith(f.path.toLowerCase())).name})` : ''}.
              {s.last ? ` Last: ${when(s.last.at)}.` : ' None made yet.'}
            </span>
            <span className="about-btns">
              <button className="btn btn-small" onClick={chooseFolder}>Change…</button>
              <button className="btn btn-small btn-primary" onClick={runNow} disabled={busy || s.running}><Icon name="restore" size={13} /> Back up now</button>
            </span>
          </div>
          {s.error && <p className="form-error">The last automatic backup failed ({when(s.error.at)}): {s.error.message}</p>}
          <div className="about-row">
            <span className="muted">How often</span>
            <select className="input input-small" value={s.every} onChange={(e) => save({ every: e.target.value })}>
              {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="about-row">
            <span className="muted">Keep the newest</span>
            <select className="input input-small" value={s.keep} onChange={(e) => save({ keep: Number(e.target.value) })}>
              {[5, 10, 14, 30, 60].map((n) => <option key={n} value={n}>{n} backups</option>)}
            </select>
          </div>
          <div className="about-row">
            <span className="muted">
              {s.encrypted ? 'Backups are encrypted with your passphrase (.selahbak). Without it they can’t be restored, so keep it somewhere safe.'
                : 'Backups aren’t encrypted. In a cloud folder, a passphrase keeps them private even if the account is broken into.'}
            </span>
            <button className="btn btn-small" onClick={setPassphrase}>{s.encrypted ? 'Stop encrypting…' : 'Encrypt with a passphrase…'}</button>
          </div>
          <h3>Go back to a backup</h3>
          <p className="muted">Replaces the whole library with a backup. To bring back just some notes, use Restore notes below.</p>
          {backups.length === 0 ? <p className="muted">No backups in the folder yet.</p> : (
            <ul className="dtb-list">
              {backups.map((b) => (
                <li key={b.file}>
                  <span>
                    <strong>{when(b.at)}</strong>
                    <span className="muted"> · {formatSize(b.bytes)}{b.encrypted ? ' · encrypted' : ''}</span>
                  </span>
                  <button className="btn btn-small" disabled={busy} onClick={() => restore({ file: b.file })}>Restore…</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h3>Move a library</h3>
      <div className="about-row">
        <span className="muted">
          Import a library from a backup file: one from another computer, or a backup from a Selah server (Settings → Data &amp; backup →
          Download a backup there). It replaces this library. To move this library to a Selah server, use Download a backup
          below and restore it there.
        </span>
        <button className="btn btn-small" onClick={importLibrary} disabled={busy}><Icon name="import" size={13} /> Import a library…</button>
      </div>
    </>
  );
}

const ago = (t) => {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * 14.2 local network mode (server/localnetwork.js): "Use Selah on my phone and tablet". The Selah app on a phone or
 * tablet on the same Wi-Fi opens this library, the whole app, and its changes come straight here. Off until switched
 * on; then each device is paired once by scanning a code, and can be removed here.
 */
export function LocalNetwork() {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [app, setApp] = useState(null);
  const [firewall, setFirewall] = useState(null);
  const refresh = useCallback(() => api.localNetwork().then(setS).catch(() => setS(null)), []);
  useEffect(() => {
    refresh();
    electron()?.appSettings?.().then(setApp).catch(() => {});
    electron()?.firewallStatus?.().then(setFirewall).catch(() => {});
  }, [refresh]);
  if (!s) return null;
  const toggle = async () => {
    setBusy(true);
    try { setS(await api.setLocalNetwork(!s.on)); } catch (e) { dialog.toast(e.message, 'error', 7000); }
    setBusy(false);
  };
  const pair = async () => {
    try {
      const code = await api.pairDevice();
      await dialog.open((c) => <DevicePairDialog code={code} close={c} />);
      refresh();
    } catch (e) { dialog.toast(e.message, 'error', 7000); }
  };
  const remove = async (d) => {
    if (!(await dialog.confirm({ title: `Remove ${d.name}?`, message: 'It can’t open this library any more until you pair it again. Copies it saved to read offline stay on it until you remove the Selah app there.', okLabel: 'Remove', danger: true }))) return;
    try { setS(await api.removeDevice(d.id)); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const keepAwake = async (on) => {
    try { setApp(await electron().setAppSettings({ lanKeepAwake: on })); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const allow = async () => {
    try {
      const ok = await electron().allowFirewall(s.port);
      setFirewall(ok);
      dialog.toast(ok ? 'Windows Firewall now lets phones and tablets in on private networks.' : 'Windows Firewall wasn’t changed.', ok ? undefined : 'error', 7000);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  return (
    <>
      <div className="about-row">
        <span className="muted">
          {!s.on ? <>Open this library in the Selah app on your phone or tablet, over your own Wi-Fi: everything, as on this PC, and what you change there is saved here. Nothing goes through the internet.</>
            : s.error ? <span className="form-error">{s.error}</span>
              : s.listening ? <>On. Paired phones and tablets on the same Wi-Fi can open Selah while it’s running on this PC, even in the {desktopWords().tray}.</>
                : <>Starting…</>}
        </span>
        <span className="about-btns">
          {s.on && <button className="btn btn-small btn-primary" onClick={pair} disabled={!s.listening}><Icon name="plus" size={14} /> Pair a device</button>}
          <button className="btn btn-small" onClick={toggle} disabled={busy}>{s.on ? 'Turn off' : 'Turn on'}</button>
        </span>
      </div>
      {s.on && (
        <>
          {s.devices.length > 0 ? (
            <ul className="companion-devices">
              {s.devices.map((d) => (
                <li key={d.id}>
                  <Icon name="tablet" size={16} />
                  <span className="companion-device-name">{d.name}</span>
                  <span className="muted">{d.last_seen_at ? `Last used ${ago(d.last_seen_at)}` : 'Paired'}</span>
                  <button className="btn btn-small" onClick={() => remove(d)}>Remove</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No devices paired yet. Choose Pair a device, then scan the code with your phone or tablet.</p>}
          {app && (
            <label className="lan-check">
              <input type="checkbox" checked={!!app.lanKeepAwake} onChange={(e) => keepAwake(e.target.checked)} />
              <span>Keep this PC awake while this is on <span className="muted">(the screen can still turn off)</span></span>
            </label>
          )}
          {firewall === false && (
            <div className="about-row">
              <span className="muted">If your phone can’t reach this PC, Windows Firewall may be blocking it.</span>
              <button className="btn btn-small" onClick={allow}>Allow in Windows Firewall</button>
            </div>
          )}
          <p className="muted lan-note">This PC: {s.name}{s.addresses.length ? ` (${s.addresses.join(', ')})` : ''}, port {s.port}. Phones and tablets check this PC’s own certificate, so no other device can stand in for it.</p>
        </>
      )}
    </>
  );
}

function DevicePairDialog({ code, close }) {
  const [left, setLeft] = useState(() => code.expires_at - Date.now());
  const [paired, setPaired] = useState(null);
  useEffect(() => {
    const t = setInterval(() => setLeft(code.expires_at - Date.now()), 1000);
    return () => clearInterval(t);
  }, [code.expires_at]);
  // Waits for the phone to use the code, to say so here.
  useEffect(() => {
    if (paired) return undefined;
    const t = setInterval(() => {
      api.pairStatus(code.id).then((r) => { if (r.paired) setPaired(r.name || 'Your device'); }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [code.id, paired]);
  const mins = Math.max(0, Math.ceil(left / 60_000));
  if (paired) {
    return (
      <div className="stack-form">
        <h2>Paired</h2>
        <p><strong>{paired}</strong> can now open this library while it’s on the same Wi-Fi as this PC.</p>
        <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close()}>Done</button></div>
      </div>
    );
  }
  return (
    <div className="stack-form">
      <h2>Pair a phone or tablet</h2>
      <div className="companion-pair">
        {left > 0 ? <div className="qr-box" role="img" aria-label="Pairing code for the Selah app" dangerouslySetInnerHTML={{ __html: code.qr }} /> : <div className="qr-box qr-loading" />}
        <ol className="companion-steps">
          <li>Put the Selah app on your phone or tablet.</li>
          <li>Point its camera at this code, and open the link in Selah.</li>
          <li>Tap OK to connect. The device and this PC must be on the same Wi-Fi.</li>
        </ol>
      </div>
      <p className="muted">{left > 0 ? `The code works for ${mins} more minute${mins === 1 ? '' : 's'}, for one device.` : 'This code has expired. Close this and pair again.'}</p>
      {window.selahDesktop?.platform === 'win32' && <p className="muted">The first time, Windows may ask whether Selah can use your network. Choose <strong>Private networks</strong>.</p>}
      {window.selahDesktop?.platform === 'darwin' && <p className="muted">The first time, your Mac may ask whether Selah can accept incoming connections. Choose <strong>Allow</strong>.</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => close()}>Close</button>
      </div>
    </div>
  );
}

function PassphraseDialog({ close, ask = false, title = 'Encrypt backups' }) {
  const [p, setP] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    if (ask) { if (p) close(p); return; }
    if (p.length < 12) return setErr('Use at least 12 characters.');
    if (p !== p2) return setErr('The passphrases don’t match.');
    close(p);
  };
  return (
    <form className="stack-form" onSubmit={submit}>
      <h2>{title}</h2>
      <p className="modal-message">
        {ask ? 'Enter the passphrase it was made with.'
          : 'New backups are encrypted with this passphrase. Selah keeps it on this computer to make them; to restore one anywhere else you’ll need it, and nobody can get it back for you.'}
      </p>
      <input className="input" type="password" autoFocus placeholder="Passphrase" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" />
      {!ask && <input className="input" type="password" placeholder="Again" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />}
      {err && <p className="form-error">{err}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!p}>{ask ? 'Continue' : 'Encrypt'}</button>
      </div>
    </form>
  );
}

/** General → App, in Selah Desktop: what the app itself does (kept by the app, not in the library). */
export function DesktopAppRow() {
  const dialog = useDialog();
  const e = electron();
  const [s, setS] = useState(null);
  const load = useCallback(() => e?.appSettings().then(setS).catch(() => setS(null)), [e]);
  useEffect(() => { load(); }, [load]);
  if (!e) return null;
  const set = async (patch) => { try { setS(await e.setAppSettings(patch)); } catch (err) { dialog.toast(err.message, 'error'); } };

  const setLock = async () => {
    if (s.lock) {
      if (await dialog.confirm({ title: 'Turn off the lock?', message: 'Selah will open without a PIN.', okLabel: 'Turn off' })) set({ lock: null });
      return;
    }
    const pin = await dialog.open((c) => <PinDialog close={c} hello={s.helloAvailable} />);
    if (pin) set({ lock: pin });
  };

  const switchServer = async () => {
    await dialog.open((c) => <ServerDialog close={c} current={s.server} connect={(url) => e.setServer(url)} />);
  };

  if (!s) return null;
  const w = desktopWords();
  return (
    <>
      <div className="about-row">
        <span className="muted">You’re using Selah Desktop {s.version}{s.server ? `, connected to ${s.server}` : ', with your library on this computer'}. It updates itself; the {w.tray} icon has Quick capture ({w.capture}).</span>
        <button className="btn btn-small" onClick={() => e.checkForUpdates()}>Check for updates</button>
      </div>
      <div className="about-row">
        <span className="muted">Start Selah when you sign in to {w.system} (in the {w.tray}, so reminders arrive).</span>
        <button className="btn btn-small" onClick={() => set({ startWithWindows: !s.startWithWindows })}>{s.startWithWindows ? 'Turn off' : 'Turn on'}</button>
      </div>
      {!s.server && (
        <div className="about-row">
          <span className="muted">
            {s.lock ? `Selah asks for your PIN${s.lock.hello ? ` or ${w.hello}` : ''} when it opens and after ${s.lock.idleMinutes} minutes away.`
              : `Lock Selah with a PIN${w.hello ? ` (or ${w.hello})` : ''} when it opens and when you’ve been away.`}
          </span>
          <button className="btn btn-small" onClick={setLock}>{s.lock ? 'Turn off the lock…' : 'Set up a lock…'}</button>
        </div>
      )}
      <div className="about-row">
        <span className="muted">{s.server ? 'Use the library on this computer instead (Offline), or another Selah server.' : 'Sign in to your Selah server instead of using the library on this computer (yours stays here).'}</span>
        <button className="btn btn-small" onClick={switchServer}>{s.server ? 'Change…' : 'Sign in to your Selah server…'}</button>
      </div>
    </>
  );
}

function PinDialog({ close, hello }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [useHello, setUseHello] = useState(!!hello);
  const [idle, setIdle] = useState(15);
  const [err, setErr] = useState(null);
  const submit = (ev) => {
    ev.preventDefault();
    if (!/^\d{4,12}$/.test(pin)) return setErr('Use 4 to 12 digits.');
    if (pin !== pin2) return setErr('The PINs don’t match.');
    close({ pin, hello: useHello, idleMinutes: idle });
  };
  return (
    <form className="stack-form" onSubmit={submit}>
      <h2>Lock Selah</h2>
      <p className="modal-message">A PIN for Selah only (not your {desktopWords().system} password or PIN). It keeps someone at your computer out of your notes; it doesn’t encrypt them.</p>
      <input className="input" inputMode="numeric" type="password" autoFocus placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
      <input className="input" inputMode="numeric" type="password" placeholder="Again" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
      {hello && <label className="check-row"><input type="checkbox" checked={useHello} onChange={(e) => setUseHello(e.target.checked)} /> Or unlock with {desktopWords().helloLong}</label>}
      <label className="field-label">Lock after</label>
      <select className="input" value={idle} onChange={(e) => setIdle(Number(e.target.value))}>
        {[5, 15, 30, 60, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`} away</option>)}
      </select>
      {err && <p className="form-error">{err}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary">Turn on</button>
      </div>
    </form>
  );
}

/** Typed address → checked by the app (selahServer in desktop-app/main.cjs), which relaunches signed in to it. */
function ServerDialog({ close, current, connect }) {
  const [url, setUrl] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (value) => {
    setBusy(true); setError('');
    try { await connect(value); close(null); } catch (err) {
      setError(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  };
  return (
    <form className="stack-form" onSubmit={(e) => { e.preventDefault(); go(url.trim()); }}>
      <h2>Sign in to your Selah server</h2>
      <p className="modal-message">
        Your Selah server’s address, like selah.example.org: one you run, or your church’s. You sign in there as
        in a browser, and the phone remote works. The library on this computer stays where it is; choose Offline to go back to it.
      </p>
      <input className="input" autoFocus placeholder="selah.example.org" inputMode="url" autoCapitalize="off" spellCheck={false}
        value={url} onChange={(e) => setUrl(e.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {current && <button type="button" className="btn" disabled={busy} onClick={() => go('')}>Use Offline</button>}
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
      </div>
    </form>
  );
}
