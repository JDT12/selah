import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { appKind } from './Login.jsx';
import { CodeField, RecoveryCodes, codeOk } from './SecuritySettings.jsx';

/**
 * The page a setup link opens (/#setup=<token>, made in the admin console): choose a username, email and password,
 * set up an authenticator app (recommended; since 10.0 "Skip for now" leaves it for Settings → Security), save the
 * recovery codes. The token leaves the address bar as soon as the page has read it.
 */
const KEY = 'selah.setupToken';

function readToken() {
  const m = /^#setup=([\w-]+)$/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem(KEY, m[1]); } catch { /* private window: keep it in memory */ }
    history.replaceState(null, '', '/#setup');
    return m[1];
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
const forget = () => { try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ } };

export default function SetupPage() {
  const [token] = useState(readToken);
  const [info, setInfo] = useState(null); // { kind, name, tenant, minPassword }
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [setup, setSetup] = useState(null); // { secret, qr }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This setup link is incomplete. Open the whole link you were sent.'); return; }
    api.setupCheck(token).then((i) => { setInfo(i); setUsername(i.username ?? ''); setEmail(i.email ?? ''); }).catch((e) => setError(e.message));
  }, [token]);

  const min = info?.minPassword ?? 12;
  const nameProblem = !/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(username.trim().toLowerCase())
    ? 'Choose a username of 3 to 32 letters, numbers, dots, dashes or underscores.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'That email address doesn’t look right.' : null;
  const pwProblem = nameProblem ?? (password.length < min ? `Use at least ${min} characters. A few unrelated words make a strong password that’s easy to type.`
    : password !== password2 ? 'The two passwords don’t match.' : null);

  const toStep2 = async (e) => {
    e.preventDefault();
    if (pwProblem) { setError(pwProblem); return; }
    setError(null);
    setBusy(true);
    try {
      setSetup(setup ?? await api.setupTwoStep(token));
      setStep(2);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const finish = async (e, { skip = false } = {}) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.setupFinish(token, { username: username.trim(), email: email.trim(), password, code: skip ? '' : code, skipTwoStep: skip, app: appKind() });
      forget();
      setPassword(''); setPassword2('');
      // Skipped: straight into Selah (Home and Settings → Security suggest turning it on later).
      if (!r.codes) { location.replace('/'); return; }
      setCodes(r.codes);
      setStep(3);
    } catch (err) {
      setError(err.message);
      // A password the server turned down (e.g. found in a data breach): choose another.
      if (/password|characters|breach/i.test(err.message)) { setStep(1); setPassword(''); setPassword2(''); }
      if (/username|email/i.test(err.message)) setStep(1);
      if (err.data?.restart) { setSetup(null); setCode(''); setStep(1); }
    }
    setBusy(false);
  };

  const who = info?.name && info.name !== info.tenant ? info.name : null;
  const reset = info?.kind === 'reset';

  return (
    <div className="login-page">
      <div className="login-card setup-card">
        <img src="/favicon.svg?v=4" alt="" width="56" height="56" />
        <h1 className="wordmark">Selah</h1>
        {!info ? (
          error ? (
            <>
              <p className="form-error">{error}</p>
              <a className="btn btn-block" href="/">Go to sign in</a>
            </>
          ) : <p className="muted">Checking your link…</p>
        ) : (
          <>
            <p className="setup-steps muted" aria-label={`Step ${step} of 3`}>
              {['Account', 'Authenticator', 'Recovery codes'].map((s, i) => (
                <span key={s} className={i + 1 === step ? 'is-current' : i + 1 < step ? 'is-done' : ''}>{s}</span>
              ))}
            </p>

            {step === 1 && (
              <form className="stack-form setup-form" onSubmit={toStep2}>
                <h2>{reset ? 'Choose a new password' : `Welcome${who ? `, ${who}` : ''}`}</h2>
                <p className="muted">{reset
                  ? 'This link resets how you sign in: a new password, and your authenticator app set up again. Your notes aren’t touched.'
                  : 'This is your own Selah. Only you can sign in to it: choose the username and password you’ll sign in with, then (recommended) set up a code app on your phone.'}</p>
                <label className="setup-label" htmlFor="setup-username">Username</label>
                <input id="setup-username" className="input" type="text" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false}
                  placeholder="e.g. jsmith" value={username} onChange={(e) => setUsername(e.target.value)} />
                <label className="setup-label" htmlFor="setup-email">Email</label>
                <input id="setup-email" className="input" type="email" autoComplete="email" placeholder="you@example.com"
                  value={email} onChange={(e) => setEmail(e.target.value)} />
                <p className="muted setup-note">You can sign in with either one. Your host uses the email to reach you about your account.</p>
                <label className="setup-label" htmlFor="setup-password">Password</label>
                <input id="setup-password" className="input" type="password" autoComplete="new-password" placeholder={`Password (at least ${min} characters)`}
                  value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
                <input className="input" type="password" autoComplete="new-password" placeholder="Type it again"
                  value={password2} onChange={(e) => setPassword2(e.target.value)} aria-label="Password again" />
                {error && <p className="form-error">{error}</p>}
                <button className="btn btn-primary btn-block" disabled={busy || !username.trim() || !email.trim() || !password || !password2}>Next</button>
              </form>
            )}

            {step === 2 && setup && (
              <form className="stack-form setup-form" onSubmit={finish}>
                <h2>Set up your authenticator <span className="setup-recommended">Recommended</span></h2>
                <p className="muted">After your password, Selah asks for a 6-digit code from an app on your phone, so a stolen password alone can’t get in. Microsoft Authenticator, Google Authenticator, 1Password and Authy all work.</p>
                <div className="two-step-qr setup-qr">
                  <div className="qr-box" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: setup.qr }} />
                  <div className="two-step-key">
                    <span className="muted">In the app, add an account and scan the code. Can’t scan? Enter this setup key:</span>
                    <code className="setup-key">{setup.secret}</code>
                  </div>
                </div>
                <label className="setup-label" htmlFor="setup-code">Type the code the app shows</label>
                <CodeField code={code} setCode={setCode} recovery={false} setRecovery={null} autoFocus id="setup-code" />
                {error && <p className="form-error">{error}</p>}
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => { setStep(1); setError(null); }}>Back</button>
                  <button type="button" className="btn setup-skip" disabled={busy} onClick={() => finish(null, { skip: true })}>Skip for now</button>
                  <button className="btn btn-primary" disabled={busy || !codeOk(code, false)}>{busy ? 'Setting up…' : 'Finish'}</button>
                </div>
                <p className="muted setup-note">Skipping signs you in with just your password. You can turn this on any time in Settings → Security.</p>
              </form>
            )}

            {step === 3 && codes && (
              <div className="stack-form setup-form">
                <h2>Save your recovery codes</h2>
                <RecoveryCodes codes={codes} onDone={() => location.replace('/')} doneLabel="Open Selah" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
