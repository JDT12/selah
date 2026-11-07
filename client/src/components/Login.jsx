import { useState } from 'react';
import { isDesktopApp } from '../desktop.js';
import { api } from '../api.js';
import { serverMode } from '../mode.js';
import { useDialog } from './Dialogs.jsx';
import CertificateHelp from './CertificateHelp.jsx';

// Which app this is, so Settings → Security can name the device.
export const appKind = () => (isDesktopApp() ? 'windows' : window.matchMedia?.('(display-mode: standalone)').matches ? 'installed' : '');

const NO_PASSWORD = {
  single: <>No password has been set yet. On the server, run:<br /><code>npm run set-password</code></>,
  tenant: <>This Selah hasn’t been set up yet. Open the setup link you were sent to choose your password.</>,
  admin: <>No admin password has been set yet. On the server, run:<br /><code>npm run admin -- set-password</code></>,
};

/**
 * Signing in: the username or email (10.0, once chosen) and the password, then (with two-step sign-in on) a code or a
 * recovery code. Selah and the admin console.
 */
export default function Login({ passwordSet, signInName = false, cert, onDone, title = 'Selah', subtitle = null }) {
  const dialog = useDialog();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState(null); // password accepted; waiting for the code
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fail = (err) => {
    setError(err.message);
    setBusy(false);
    if (err.data?.restart) { setTicket(null); setCode(''); setPassword(''); }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (ticket) {
        onDone(await api.loginCode(ticket, code, recovery));
        return;
      }
      const r = await api.login(password, appKind(), signInName ? login.trim() : undefined);
      if (r.twoFactor) {
        setTicket(r.ticket);
        setBusy(false);
        return;
      }
      onDone(r);
    } catch (err) {
      fail(err);
    }
  };
  const codeOk = recovery ? code.replace(/[^a-z0-9]/gi, '').length === 10 : /^\d{6}$/.test(code.replace(/\s/g, ''));
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <img src="/favicon.svg?v=4" alt="" width="56" height="56" />
        <h1 className="wordmark">{title}</h1>
        {subtitle && <p className="login-subtitle muted">{subtitle}</p>}
        {!passwordSet ? (
          <p className="modal-message">{NO_PASSWORD[serverMode()] ?? NO_PASSWORD.single}</p>
        ) : ticket ? (
          <>
            <p className="login-step">{recovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
            <input key={recovery ? 'r' : 'c'} className="input login-code" autoFocus autoComplete="one-time-code"
              inputMode={recovery ? 'text' : 'numeric'} placeholder={recovery ? 'xxxxx-xxxxx' : '123 456'} maxLength={recovery ? 11 : 7}
              aria-label={recovery ? 'Recovery code' : 'Authentication code'}
              value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy || !codeOk}>Verify</button>
            <div className="login-links">
              <button type="button" className="link-btn" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>
                {recovery ? 'Use the authenticator app' : 'Lost your phone? Use a recovery code'}
              </button>
              <button type="button" className="link-btn" onClick={() => { setTicket(null); setCode(''); setPassword(''); setError(null); }}>Start over</button>
            </div>
          </>
        ) : (
          <>
            {signInName && (
              <input className="input" type="text" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false}
                placeholder="Username or email" aria-label="Username or email" value={login} onChange={(e) => setLogin(e.target.value)} />
            )}
            <input className="input" type="password" autoFocus={!signInName} autoComplete="current-password" placeholder="Password" aria-label="Password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy || !password || (signInName && !login.trim())}>Sign in</button>
          </>
        )}
        {cert && (
          <button type="button" className="link-btn cert-link"
            onClick={() => dialog.open((close) => <CertificateHelp cert={cert} close={close} />)}>
            Browser says “Not secure”? Trust this device
          </button>
        )}
        {serverMode() === 'tenant' && passwordSet && !ticket && (
          <p className="muted login-help">Forgot your password, or lost your phone and recovery codes? Ask your Selah host for a reset link.</p>
        )}
      </form>
    </div>
  );
}
