import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { loadSharing, KIND_LABEL } from '../sharing.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

/**
 * Sharing (8.0): sharing a note, notebook or project with contacts (ShareDialog), and the contacts themselves
 * (ContactsDialog). Shares are live and read-only; see server/sharing.js.
 */

const NOUN = { note: 'note', notebook: 'notebook', study: 'project' };

/** Opens the Share dialog for something of mine. `kind` is note, notebook or study; `title` names it. */
export const openShare = (dialog, { kind, id, title, alsoIn = [] }) => dialog.open((c) => <ShareDialog kind={kind} id={id} title={title} alsoIn={alsoIn} close={c} />);
export const openContacts = (dialog) => dialog.open((c) => <ContactsDialog close={c} />);

/** `alsoIn`: shared notebooks and projects this note is in ({ kind, title, people }), mentioned so it's clear who sees it already. */
export function ShareDialog({ kind, id, title, alsoIn = [], close }) {
  const dialog = useDialog();
  const [state, setState] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [allowCopy, setAllowCopy] = useState(false);
  const [allowComments, setAllowComments] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([api.sharing(), api.shareOf(kind, id)]).then(([s, { share }]) => {
    setState({ ...s, share });
    if (share) {
      setPicked(new Set(share.people.map((p) => p.slug)));
      setAllowCopy(share.allowCopy);
      setAllowComments(share.allowComments);
    }
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const contacts = state?.contacts.filter((c) => c.status === 'accepted') ?? [];
  const toggle = (slug) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.shareItem({ kind, id, people: [...picked], allowCopy, allowComments });
      loadSharing();
      dialog.toast(picked.size ? `Shared with ${picked.size === 1 ? contacts.find((c) => picked.has(c.slug))?.name || [...picked][0] : `${picked.size} people`}` : 'Not shared any more');
      close(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!(await dialog.confirm({ title: `Stop sharing “${title}”?`, message: 'It goes from everyone’s Selah. Comments they made stay with you.', okLabel: 'Stop sharing', danger: true }))) return;
    try {
      await api.stopShare(state.share.id);
      loadSharing();
      dialog.toast('Not shared any more');
      close(true);
    } catch (err) { setError(err.message); }
  };
  const manage = async () => { await openContacts(dialog); load(); };

  return (
    <form className="share-dialog" onSubmit={save}>
      <h2>Share {NOUN[kind]}</h2>
      <p className="modal-message"><strong>{title || 'Untitled'}</strong> · {kind === 'notebook' ? 'They see every note in it, and new ones as you add them.'
        : kind === 'study' ? 'They see its notes in order, as pages.' : 'They see it as you write it.'} Read-only: they can’t change it.</p>
      {alsoIn.map((s) => (
        <p key={s.id} className="share-also"><Icon name="share" size={14} />
          <span>It’s in “{s.title}”, shared with {s.people.map((p) => p.name).join(', ')}. Sharing the note too lets you share it with others, or set comments and copying for it alone.</span>
        </p>
      ))}
      {!state && !error && <p className="muted">Loading…</p>}
      {state && !state.enabled && <p className="muted">Sharing is for Selah in the cloud, where your contacts have their own Selah.</p>}
      {state?.enabled && !state.on && <p className="form-error">Sharing is turned off for your Selah. Ask your Selah host.</p>}
      {state?.enabled && state.on && (
        <>
          <div className="share-people">
            <div className="share-people-head">
              <span className="field-label">Share with</span>
              <button type="button" className="link-btn" onClick={manage}>Contacts…</button>
            </div>
            {contacts.length === 0 && (
              <div className="share-empty">
                <p>No contacts yet. Add someone by their Selah name, and once they accept you can share with them.</p>
                <button type="button" className="btn btn-small" onClick={manage}><Icon name="plus" size={14} /> Add a contact</button>
              </div>
            )}
            {contacts.map((c) => (
              <label key={c.slug} className={`share-person ${picked.has(c.slug) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={picked.has(c.slug)} onChange={() => toggle(c.slug)} />
                <span className="share-avatar" aria-hidden="true">{(c.name || c.slug).slice(0, 1).toUpperCase()}</span>
                <span className="share-person-name">{c.name || c.slug}<small>{c.slug}</small></span>
              </label>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={allowComments} onChange={(e) => setAllowComments(e.target.checked)} />
            <span><strong>Allow comments</strong><small className="muted">They can comment on words in the margin; you can reply and resolve.</small></span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} />
            <span><strong>Allow copying</strong><small className="muted">They can make their own copy, which stops following yours.</small></span>
          </label>
        </>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        {state?.share && <button type="button" className="btn btn-danger-text" onClick={stop}>Stop sharing</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        {state?.enabled && state.on && (
          <button type="submit" className="btn btn-primary" disabled={busy || (!picked.size && !state.share)}>
            {state.share ? (picked.size ? 'Save' : 'Stop sharing') : 'Share'}
          </button>
        )}
      </div>
    </form>
  );
}

export function ContactsDialog({ close }) {
  const dialog = useDialog();
  const [state, setState] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const load = () => api.sharing().then(setState).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const on = (e) => { if (e.detail?.sharing) load(); };
    window.addEventListener('noteapp:live', on);
    return () => window.removeEventListener('noteapp:live', on);
  }, []);
  const run = async (fn, done) => {
    setError(null);
    try { await fn(); await load(); loadSharing(); if (done) dialog.toast(done); } catch (e) { setError(e.message); }
  };
  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(() => api.addContact(name.trim()), 'Request sent').then(() => setName(''));
  };
  const remove = async (c) => {
    if (!(await dialog.confirm({
      title: `Remove ${c.name || c.slug}?`,
      message: 'Everything you share with each other stops, both ways. You can connect again later.',
      okLabel: 'Remove', danger: true,
    }))) return;
    run(() => api.removeContact(c.slug), 'Contact removed');
  };
  const list = state?.contacts ?? [];
  const incoming = list.filter((c) => c.status === 'incoming');
  const outgoing = list.filter((c) => c.status === 'outgoing');
  const accepted = list.filter((c) => c.status === 'accepted');
  return (
    <div className="contacts-dialog">
      <h2>Contacts</h2>
      {state && !state.enabled ? <p className="muted">Sharing is for Selah in the cloud.</p> : (
        <>
          <p className="modal-message">People you can share with. Your Selah name is <strong>{state?.me?.slug ?? '…'}</strong>: give it to someone so they can add you.</p>
          <form className="contacts-add" onSubmit={add}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their Selah name" aria-label="Their Selah name" autoFocus
              autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Send request</button>
          </form>
          {error && <p className="form-error">{error}</p>}
          {incoming.length > 0 && (
            <section className="contacts-group">
              <h3>Asking to connect</h3>
              {incoming.map((c) => (
                <div key={c.slug} className="contact-row">
                  <span className="share-avatar" aria-hidden="true">{(c.name || c.slug).slice(0, 1).toUpperCase()}</span>
                  <span className="share-person-name">{c.name || c.slug}<small>{c.slug}</small></span>
                  <button type="button" className="btn btn-small btn-primary" onClick={() => run(() => api.acceptContact(c.slug), `${c.name || c.slug} is a contact now`)}>Accept</button>
                  <button type="button" className="btn btn-small" onClick={() => run(() => api.removeContact(c.slug))}>Decline</button>
                </div>
              ))}
            </section>
          )}
          <section className="contacts-group">
            <h3>Contacts</h3>
            {state && !accepted.length && <p className="muted">None yet.</p>}
            {accepted.map((c) => (
              <div key={c.slug} className="contact-row">
                <span className="share-avatar" aria-hidden="true">{(c.name || c.slug).slice(0, 1).toUpperCase()}</span>
                <span className="share-person-name">{c.name || c.slug}<small>{c.slug}</small></span>
                <button type="button" className="btn btn-small btn-danger-text" onClick={() => remove(c)}>Remove</button>
              </div>
            ))}
          </section>
          {outgoing.length > 0 && (
            <section className="contacts-group">
              <h3>Waiting for them</h3>
              {outgoing.map((c) => (
                <div key={c.slug} className="contact-row">
                  <span className="share-avatar is-waiting" aria-hidden="true"><Icon name="clock" size={13} /></span>
                  <span className="share-person-name">{c.name || c.slug}<small>Request sent</small></span>
                  <button type="button" className="btn btn-small" onClick={() => run(() => api.removeContact(c.slug))}>Cancel</button>
                </div>
              ))}
            </section>
          )}
          {state?.myShares?.length > 0 && (
            <section className="contacts-group">
              <h3>You Share</h3>
              {state.myShares.map((s) => (
                <div key={s.id} className="contact-row">
                  <Icon name={s.kind === 'notebook' ? 'notebook' : s.kind === 'study' ? 'desk' : 'note'} size={15} className="muted" />
                  <span className="share-person-name">{s.title || 'Untitled'}<small>{KIND_LABEL[s.kind]} · with {s.people.map((p) => p.name).join(', ')}</small></span>
                  <button type="button" className="btn btn-small" onClick={async () => { await openShare(dialog, { kind: s.kind, id: s.refId, title: s.title }); load(); }}>Change</button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Done</button>
      </div>
    </div>
  );
}
