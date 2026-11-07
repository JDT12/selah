import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { TwoStepSetupDialog } from './SecuritySettings.jsx';

/**
 * 10.0: the username and email you sign in with. Asked once after signing in on a Selah from before 10.0 (`first`),
 * and changed any time in Settings → Account. Saving asks for the password first if it hasn't been typed lately.
 */
export function IdentityDialog({ first = false, initial = {}, close }) {
  const [username, setUsername] = useState(initial.username ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      close(await api.setIdentity({ username: username.trim(), email: email.trim() }));
    } catch (err) {
      if (err.status !== 403) setError(err.message);
      setBusy(false);
    }
  };
  const later = () => { api.identityLater().catch(() => {}); close(null); };
  return (
    <form className="stack-form identity-dialog" onSubmit={save}>
      <h2>{first ? 'Choose how you sign in' : 'Username and email'}</h2>
      <p className="muted">{first
        ? 'Selah now signs you in with a username or email and your password. Choose them once; you can change them in Settings → Account.'
        : 'Sign in with either one and your password. Other devices stay signed in.'}</p>
      <label className="field">Username
        <input className="input" type="text" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false}
          value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. jsmith" />
      </label>
      <label className="field">Email
        <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={first ? later : () => close(null)}>{first ? 'Later' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={busy || !username.trim() || !email.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** After signing in: the question above, once, on a Selah that doesn't have a username and email yet. */
export function useIdentityQuestion() {
  const dialog = useDialog();
  useEffect(() => {
    let gone = false;
    api.identity().then((i) => {
      if (!gone && i.ask) dialog.open((c) => <IdentityDialog first close={c} />, { dismissable: false });
    }).catch(() => {});
    return () => { gone = true; };
  }, [dialog]);
}

/** Settings → Account's sign-in rows. */
export function IdentityRows() {
  const dialog = useDialog();
  const [who, setWho] = useState(null);
  useEffect(() => { api.identity().then(setWho).catch(() => {}); }, []);
  if (!who) return null;
  const edit = async () => {
    const r = await dialog.open((c) => <IdentityDialog initial={who} close={c} />);
    if (r) { setWho({ ...who, ...r }); dialog.toast('Saved. Sign in with your username or email from now on.'); }
  };
  return (
    <>
      <h3>Sign-in</h3>
      <div className="about-row">
        <span className="muted">{who.username
          ? <>Username <strong className="identity-value">{who.username}</strong> · Email <strong className="identity-value">{who.email}</strong></>
          : 'No username or email yet: signing in takes just your password.'}</span>
        <button className="btn btn-small" onClick={edit}>{who.username ? 'Change…' : 'Choose…'}</button>
      </div>
    </>
  );
}

/** Home's reminder to turn on two-step sign-in, until it's on or put away. */
export function TwoStepNudge() {
  const dialog = useDialog();
  const [show, setShow] = useState(false);
  useEffect(() => { api.identity().then((i) => setShow(!!i.twoStepNudge)).catch(() => {}); }, []);
  if (!show) return null;
  const turnOn = async () => {
    if (await dialog.open((c) => <TwoStepSetupDialog close={c} />)) setShow(false);
  };
  const off = () => { setShow(false); api.twoStepNudgeOff().catch(() => {}); };
  return (
    <section className="home-card-panel two-step-nudge" aria-label="Two-step sign-in">
      <Icon name="lock" size={20} />
      <div className="two-step-nudge-text">
        <strong>Turn on two-step sign-in</strong>
        <span className="muted">Recommended. A code from your phone after your password, so a stolen password alone can’t get in.</span>
      </div>
      <button type="button" className="btn btn-small btn-primary" onClick={turnOn}>Turn on…</button>
      <button type="button" className="icon-btn" onClick={off} aria-label="Not now" title="Not now"><Icon name="x" size={15} /></button>
    </section>
  );
}
