import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import CertificateHelp from './CertificateHelp.jsx';
import { isHosted, serverMode } from '../mode.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'active now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};
const IDLE_LABELS = { 1: '1 day', 7: '1 week', 14: '2 weeks', 30: '30 days' };

/** What each security log entry means, in words. */
const KINDS = {
  'sign-in': { label: 'Signed in', icon: 'check' },
  'sign-in-failed': { label: 'Wrong password (or username)', icon: 'x', bad: true },
  'identity-set': { label: 'Username and email chosen', icon: 'users' },
  'identity-changed': { label: 'Username or email changed', icon: 'users' },
  'code-failed': { label: 'Wrong sign-in code', icon: 'x', bad: true },
  'confirm-failed': { label: 'Wrong password or code when confirming', icon: 'x', bad: true },
  locked: { label: 'Sign-in paused after too many failures', icon: 'lock', bad: true },
  'sign-out': { label: 'Signed out', icon: 'logout' },
  'password-changed': { label: 'Password changed', icon: 'key' },
  'two-step-on': { label: 'Two-step sign-in turned on', icon: 'lock' },
  'two-step-off': { label: 'Two-step sign-in turned off', icon: 'lock', bad: true },
  'recovery-codes-new': { label: 'New recovery codes made', icon: 'key' },
  'session-revoked': { label: 'Signed out a device', icon: 'logout' },
  'sessions-revoked': { label: 'Signed out all other devices', icon: 'logout' },
  'settings-changed': { label: 'Security settings changed', icon: 'settings' },
  'clipper-paired': { label: 'Edge clipper connected', icon: 'link' },
  'clipper-removed': { label: 'Edge clipper disconnected', icon: 'link' },
  'blocked-origin': { label: 'Blocked a request from another site', icon: 'x', bad: true },
  'rate-limited': { label: 'Slowed down too many requests', icon: 'x', bad: true },
  'setup-link': { label: 'Setup link made by your Selah host', icon: 'link' },
  'setup-failed': { label: 'Setup link that didn’t work', icon: 'x', bad: true },
  'setup-done': { label: 'Set up with the setup link', icon: 'check' },
  'setup-reset': { label: 'Sign-in reset with a reset link', icon: 'key' },
  'data-export': { label: 'Downloaded all data', icon: 'download' },
  'backup-download': { label: 'Downloaded a backup', icon: 'download' },
  'notes-restored': { label: 'Notes restored from a backup', icon: 'restore' },
  'account-deletion': { label: 'Asked to delete the account', icon: 'x', bad: true },
  'tenant-created': { label: 'Tenant created', icon: 'check' },
  'tenant-suspended': { label: 'Tenant paused', icon: 'lock' },
  'tenant-resumed': { label: 'Tenant resumed', icon: 'check' },
  'tenant-deleted': { label: 'Tenant deleted', icon: 'x' },
  'tenant-restore': { label: 'Tenant restored from backup', icon: 'download' },
  'tenant-restore-notes': { label: 'Notes restored into a tenant', icon: 'restore' },
  'host-backup-connected': { label: 'Host backup set up', icon: 'folder' },
  'host-backup-disconnected': { label: 'Host backup disconnected', icon: 'folder', bad: true },
  'allow-ips-changed': { label: 'Allowed addresses changed', icon: 'settings' },
  'maintenance-done': { label: 'Server maintenance marked done', icon: 'check' },
};
const detailText = (e) => {
  const d = e.detail ?? {};
  if (d.from === 'server') return 'from the server';
  if (d.notes != null && d.from) return `${d.notes} note${d.notes === 1 ? '' : 's'} from ${d.from === 'host' ? 'your Selah host’s backup' : d.from === 'offsite' ? 'the off-site backup' : 'a restore point'}`;
  if (d.notes != null && d.slug) return `${d.slug}: ${d.notes} note${d.notes === 1 ? '' : 's'}, ${d.notebooks} notebook${d.notebooks === 1 ? '' : 's'}`;
  if (d.method === 'recovery') return `with a recovery code (${d.left} left)`;
  if (d.device) return d.device;
  if (d.name) return d.name;
  if (d.count != null) return `${d.count} device${d.count === 1 ? '' : 's'}`;
  if (d.idleDays) return `sign out after ${IDLE_LABELS[d.idleDays]} idle`;
  if (d.origin) return `from ${d.origin}`;
  if (d.slug) return d.kind ? `${d.slug} (${d.kind})` : d.slug;
  if (d.from === 'admin') return 'by your Selah host';
  return '';
};

export const codeOk = (code, recovery) => (recovery ? code.replace(/[^a-z0-9]/gi, '').length === 10 : /^\d{6}$/.test(code.replace(/\s/g, '')));

/** A 6-digit code box, with a switch to a recovery code. */
export function CodeField({ code, setCode, recovery, setRecovery, autoFocus = false, id }) {
  return (
    <>
      <input key={recovery ? 'r' : 'c'} id={id} className="input login-code" autoFocus={autoFocus} autoComplete="one-time-code"
        inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 11 : 7}
        placeholder={recovery ? 'Recovery code' : '6-digit code from your app'} aria-label={recovery ? 'Recovery code' : 'Authentication code'}
        value={code} onChange={(e) => setCode(e.target.value)} />
      {setRecovery && (
        <button type="button" className="link-btn security-switch" onClick={() => { setRecovery(!recovery); setCode(''); }}>
          {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
        </button>
      )}
    </>
  );
}

/** "Confirm it's you" before a sensitive change. Resolves true when confirmed. */
export function ConfirmIdentityDialog({ close }) {
  const [twoStep, setTwoStep] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.security().then((s) => setTwoStep(s.twoFactor.on)).catch(() => setTwoStep(false)); }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.confirmIdentity(password, code, recovery);
      close(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form security-confirm" onSubmit={submit}>
      <h2>Confirm it’s you</h2>
      <p className="muted">This changes how you sign in, so Selah needs your password{twoStep ? ' and a code' : ''} again.</p>
      <input className="input" type="password" autoFocus autoComplete="current-password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {twoStep && <CodeField code={code} setCode={setCode} recovery={recovery} setRecovery={setRecovery} />}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || twoStep === null || !password || (twoStep && !codeOk(code, recovery))}>Confirm</button>
      </div>
    </form>
  );
}

/** The recovery codes, shown once, with copy and download. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Done' }) {
  const dialog = useDialog();
  const [saved, setSaved] = useState(false);
  const text = `Selah recovery codes (${day(Date.now())})\nEach code works once, in place of a code from your authenticator app.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      dialog.toast('Recovery codes copied');
    } catch {
      dialog.toast('Couldn’t copy; select the codes instead.', 'error');
    }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'Selah recovery codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <>
      <p>If you lose your phone, each of these codes signs you in once. Keep them somewhere safe and separate from your phone, like a password manager or a printed page. They won’t be shown again.</p>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ol>
      <div className="security-actions">
        <button type="button" className="btn btn-small" onClick={copy}><Icon name="copy" size={14} /> Copy</button>
        <button type="button" className="btn btn-small" onClick={download}><Icon name="download" size={14} /> Download</button>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I’ve saved these codes</span>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone}>{doneLabel}</button>
      </div>
    </>
  );
}

export function RecoveryCodesDialog({ codes, close }) {
  return (
    <div className="stack-form security-dialog">
      <h2>Recovery codes</h2>
      <RecoveryCodes codes={codes} onDone={() => close()} />
    </div>
  );
}

/** Turning on two-step sign-in: scan the QR code, type a code, save the recovery codes. */
export function TwoStepSetupDialog({ close, move = false }) {
  const [setup, setSetup] = useState(null); // { secret, qr }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.startTwoStep().then(setSetup).catch((e) => (e.data?.reauth ? close(false) : setError(e.message)));
  }, [close]);
  const enable = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes((await api.enableTwoStep(code)).codes);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  if (codes) {
    return (
      <div className="stack-form security-dialog">
        <h2>{move ? 'Your new phone is set up' : 'Two-step sign-in is on'}</h2>
        <p className="muted">Other devices have been signed out; they’ll ask for a code next time.{move ? ' The old phone’s codes no longer work.' : ''}</p>
        <RecoveryCodes codes={codes} onDone={() => close(true)} />
      </div>
    );
  }
  return (
    <form className="stack-form security-dialog" onSubmit={enable}>
      <h2>{move ? 'Move to a new phone' : 'Turn on two-step sign-in'}</h2>
      <p>{move
        ? 'Set up your authenticator app on the new phone. When it’s done, codes from the old one stop working and you get new recovery codes.'
        : 'After your password, Selah will ask for a 6-digit code from an authenticator app on your phone, so a stolen password alone can’t get in.'}</p>
      <ol className="two-step-steps">
        <li>Install an authenticator app if you don’t have one: Microsoft Authenticator, Google Authenticator, 1Password, Authy and others all work.</li>
        <li>
          In the app, add an account and scan this code:
          <div className="two-step-qr">
            {setup ? <div className="qr-box" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: setup.qr }} /> : <div className="qr-box qr-loading" />}
            {setup && (
              <div className="two-step-key">
                <span className="muted">Can’t scan? Choose “enter a setup key” and type:</span>
                <code className="setup-key">{setup.secret}</code>
                <span className="muted">Time-based, 6 digits.</span>
              </div>
            )}
          </div>
        </li>
        <li>
          Type the 6-digit code the app shows:
          <CodeField code={code} setCode={setCode} recovery={false} />
        </li>
      </ol>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !setup || !codeOk(code, false)}>{move ? 'Use this phone' : 'Turn on'}</button>
      </div>
    </form>
  );
}

function ChangePasswordDialog({ twoStep, minLength, close }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ error: true, text: 'New passwords do not match.' });
    setBusy(true);
    try {
      await api.changePassword(current, next, code);
      setMsg({ text: 'Password changed. Other devices have been signed out.' });
      setDone(true);
    } catch (err) {
      setMsg({ error: true, text: err.message });
    }
    setBusy(false);
  };

  return (
    <form className="stack-form" onSubmit={submit}>
      <h2>Change password</h2>
      {!done && (
        <>
          <input className="input" type="password" autoFocus autoComplete="current-password" placeholder="Current password"
            value={current} onChange={(e) => setCurrent(e.target.value)} />
          {twoStep && <CodeField code={code} setCode={setCode} recovery={false} />}
          <input className="input" type="password" autoComplete="new-password" placeholder={`New password (${minLength}+ characters)`}
            value={next} onChange={(e) => setNext(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Confirm new password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <p className="muted security-hint">A few unrelated words make a strong, memorable password. Selah checks it against passwords known from data breaches, without sending it anywhere.</p>
        </>
      )}
      {msg && <p className={msg.error ? 'form-error' : 'form-ok'}>{msg.text}</p>}
      <div className="modal-actions">
        {done ? (
          <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => close()}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !current || next.length < minLength || (twoStep && !codeOk(code, false))}>Change password</button>
          </>
        )}
      </div>
    </form>
  );
}

/** The security log: sign-ins, failures and changes, newest first. */
function ActivityDialog({ close }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.securityLog(300).then(setRows).catch((e) => setError(e.message)); }, []);
  return (
    <div className="security-activity">
      <div className="dialog-header">
        <h2>Security activity</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {rows && !rows.length && <p className="muted">Nothing yet. Sign-ins, failed attempts and changes to how you sign in show up here.</p>}
      {rows && rows.length > 0 && (
        <ul className="activity-list">
          {rows.map((r) => {
            const k = KINDS[r.kind] ?? { label: r.kind, icon: 'callout' };
            const extra = detailText(r);
            return (
              <li key={r.id} className={k.bad ? 'is-bad' : ''}>
                <Icon name={k.icon} size={16} />
                <span className="activity-what">
                  <strong>{k.label}</strong>{extra && <span className="muted"> · {extra}</span>}
                  <span className="activity-where muted">{[r.device, r.ip].filter(Boolean).join(' · ') || '—'}</span>
                </span>
                <time className="muted" dateTime={new Date(r.at).toISOString()}>{when(r.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}

/** Settings → Security. */
export function SecurityPane({ cert, onSignOut }) {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const load = useCallback(() => api.security().then(setS).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); }, [load]);
  if (!s) return <p className="muted">Loading…</p>;
  const two = s.twoFactor;

  const act = async (fn, message) => {
    try {
      const r = await fn();
      if (message) dialog.toast(message);
      load();
      return r;
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error');
      return null;
    }
  };
  const turnOn = async () => {
    await dialog.open((c) => <TwoStepSetupDialog close={c} />);
    load();
  };
  const movePhone = async () => {
    await dialog.open((c) => <TwoStepSetupDialog move close={c} />);
    load();
  };
  const turnOff = async () => {
    const ok = await dialog.confirm({
      title: 'Turn off two-step sign-in?', okLabel: 'Turn off', danger: true,
      message: 'Signing in will need only your password again. Your recovery codes stop working.',
    });
    if (ok) act(() => api.disableTwoStep(), 'Two-step sign-in is off');
  };
  const newCodes = async () => {
    const ok = await dialog.confirm({ title: 'Make new recovery codes?', message: 'Your old codes stop working.', okLabel: 'Make new codes' });
    if (!ok) return;
    const r = await act(() => api.newRecoveryCodes());
    if (r?.codes) dialog.open((c) => <RecoveryCodesDialog codes={r.codes} close={c} />);
  };
  const signOutDevice = async (d) => {
    const ok = await dialog.confirm({ title: `Sign out ${d.device}?`, message: 'It will need the password (and a code) to get back in.', okLabel: 'Sign out', danger: true });
    if (ok) act(() => api.signOutDevice(d.id), 'Signed out');
  };
  const signOutOthers = async () => {
    const ok = await dialog.confirm({ title: 'Sign out all other devices?', message: 'Every device but this one will need to sign in again.', okLabel: 'Sign out others', danger: true });
    if (ok) act(() => api.signOutOthers(), 'Other devices signed out');
  };
  const disconnectClipper = async (d) => {
    const ok = await dialog.confirm({ title: `Disconnect ${d.name}?`, message: 'That clipper’s key stops working right away.', okLabel: 'Disconnect', danger: true });
    if (ok) act(() => api.revokeClipDevice(d.id), 'Clipper disconnected');
  };
  const others = s.sessions.filter((d) => !d.current).length;

  return (
    <>
      <div className={`security-summary ${two.on ? 'is-good' : 'is-warn'}`}>
        <Icon name="lock" size={20} />
        <div>
          <strong>{two.on ? 'Two-step sign-in is on' : 'Two-step sign-in is off'}</strong>
          <span className="muted">
            {two.on ? `Since ${day(two.since)} · ${two.recoveryLeft} recovery code${two.recoveryLeft === 1 ? '' : 's'} left` : 'Turn it on so a stolen password alone can’t get in.'}
          </span>
          {s.lastSignIn && <span className="muted">Last sign-in before this one: {when(s.lastSignIn.at)}{s.lastSignIn.device ? ` · ${s.lastSignIn.device}` : ''}{s.lastSignIn.ip ? ` · ${s.lastSignIn.ip}` : ''}</span>}
          {s.failedDay > 0 && <span className="security-alert">{s.failedDay} failed attempt{s.failedDay === 1 ? '' : 's'} in the last 24 hours</span>}
        </div>
      </div>

      <h3>Two-step sign-in</h3>
      {two.on ? (
        <>
          <div className="about-row">
            <span className="muted">A code from your authenticator app after your password. {two.recoveryLeft <= 2 && <strong className="security-alert">Recovery codes are running low.</strong>}</span>
            <span className="actions-right">
              <button className="btn btn-small" onClick={newCodes}>New recovery codes…</button>
              {isHosted() && <button className="btn btn-small" onClick={movePhone}>Move to a new phone…</button>}
              {/* Recommended, not required, since 10.0; the admin console keeps it on. */}
              {serverMode() !== 'admin' && <button className="btn btn-small btn-danger-text" onClick={turnOff}>Turn off</button>}
            </span>
          </div>
        </>
      ) : (
        <div className="about-row">
          <span className="muted"><span className="setup-recommended">Recommended</span> Ask for a 6-digit code from an app on your phone after your password.</span>
          <button className="btn btn-small btn-primary" onClick={turnOn}>Turn on…</button>
        </div>
      )}

      <h3>Password</h3>
      <div className="about-row">
        <span className="muted">Signs out other devices.</span>
        <button className="btn btn-small" onClick={() => dialog.open((c) => <ChangePasswordDialog twoStep={two.on} minLength={s.minPassword} close={c} />)}>Change password…</button>
      </div>

      <h3>Signed-in devices</h3>
      <ul className="device-list">
        {s.sessions.map((d) => (
          <li key={d.id}>
            <Icon name={/iPhone|Android/.test(d.device) ? 'phone' : 'monitor'} size={18} />
            <span className="device-what">
              <strong>{d.device}</strong>{d.current && <span className="device-badge">This device</span>}
              <span className="muted">{d.current ? 'active now' : ago(d.last_seen_at)}{d.ip ? ` · ${d.ip}` : ''} · signed in {when(d.created_at)}{two.on && !d.two_factor ? ' · before two-step sign-in' : ''}</span>
            </span>
            {!d.current && <button className="btn btn-small btn-danger-text" onClick={() => signOutDevice(d)}>Sign out</button>}
          </li>
        ))}
        {s.clippers.map((d) => (
          <li key={`clip-${d.id}`}>
            <Icon name="link" size={18} />
            <span className="device-what">
              <strong>{d.name} clipper</strong><span className="device-badge">Add only</span>
              <span className="muted">Connected {when(d.created_at)} · last used {when(d.last_used_at)}</span>
            </span>
            <button className="btn btn-small btn-danger-text" onClick={() => disconnectClipper(d)}>Disconnect</button>
          </li>
        ))}
      </ul>
      <div className="security-actions">
        {others > 0 && <button className="btn btn-small" onClick={signOutOthers}>Sign out all other devices</button>}
        <button className="btn btn-small btn-danger-text" onClick={onSignOut}>Sign out of this device</button>
      </div>

      <h3>Sign out when idle</h3>
      <div className="security-idle">
        <span className="muted">A device that hasn’t opened Selah for this long has to sign in again. Every sign-in lasts 30 days at most.</span>
        <div className="segmented">
          {s.idleChoices.map((d) => (
            <button key={d} className={s.settings.idleDays === d ? 'is-active' : ''} aria-pressed={s.settings.idleDays === d}
              onClick={() => act(() => api.saveSecuritySettings({ idleDays: d }))}>{IDLE_LABELS[d]}</button>
          ))}
        </div>
      </div>

      <h3>Activity</h3>
      <div className="about-row">
        <span className="muted">Sign-ins, failed attempts, and changes to how you sign in, with the device and address.</span>
        <button className="btn btn-small" onClick={() => dialog.open((c) => <ActivityDialog close={c} />)}>View activity…</button>
      </div>

      {cert && (
        <>
          <h3>Security certificate</h3>
          <div className="about-row">
            <span className="muted">Fix “Not secure” warnings.</span>
            <button className="btn btn-small" onClick={() => dialog.open((c) => <CertificateHelp cert={cert} close={c} />)}>Trust this device</button>
          </div>
        </>
      )}
    </>
  );
}
