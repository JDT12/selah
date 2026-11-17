import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { loadSharing, KIND_LABEL } from '../sharing.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

/**
 * Sharing (8.0): sharing a note, notebook or project with others on the server (ShareDialog), and People (14.1)
 * (ContactsDialog). Shares are live and read-only; see server/sharing.js.
 */

const NOUN = { note: 'note', notebook: 'notebook', study: 'project' };

/** Opens the Share dialog for something of mine. `kind` is note, notebook or study; `title` names it. */
export const openShare = (dialog, { kind, id, title, alsoIn = [] }) => dialog.open((c) => <ShareDialog kind={kind} id={id} title={title} alsoIn={alsoIn} close={c} />);
export const openContacts = (dialog) => dialog.open((c) => <ContactsDialog close={c} />);

/**
 * "Share…" on Selah Desktop and Selah Cloud (14.0): sharing between people is part of Selah Ministry, so this points to
 * exporting or printing instead. `onExport` and `onPrint` are optional; whichever is given gets a button.
 */
export const openShareInstead = (dialog, { noun, onExport, onPrint }) => dialog.open((close) => (
  <div>
    <h2>Share this {noun}</h2>
    <p className="modal-message">
      Sharing with other people is part of Selah Ministry, where a church runs one Selah for its people.
      To share this {noun}, export it or print it and send that.
    </p>
    <div className="modal-actions">
      <button type="button" className="btn" onClick={() => close(null)}>Close</button>
      {onPrint && <button type="button" className="btn" onClick={() => { close(null); onPrint(); }}>Print…</button>}
      {onExport && <button type="button" className="btn btn-primary" autoFocus onClick={() => { close(null); onExport(); }}>Export…</button>}
    </div>
  </div>
));

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

  const contacts = state?.contacts ?? [];
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
      {state && !state.enabled && <p className="muted">Sharing is part of Selah Ministry, where everyone you share with has their own Selah.</p>}
      {state?.enabled && !state.on && <p className="form-error">Sharing is turned off for your Selah. Ask your Selah admin.</p>}
      {state?.enabled && state.on && (
        <>
          <div className="share-people">
            <div className="share-people-head">
              <span className="field-label">Share with</span>
              <button type="button" className="link-btn" onClick={manage}>People…</button>
            </div>
            {contacts.length === 0 && (
              <div className="share-empty">
                {state.me?.listed === false ? (
                  <>
                    <p>You’re hidden from others, so you can’t share. Turn on Show me to others to share again.</p>
                    <button type="button" className="btn btn-small" onClick={manage}>People…</button>
                  </>
                ) : <p>No one else on this server shares yet. When others turn sharing on, they show here.</p>}
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

/**
 * People (14.1): everyone on this server who shares, which is who you can share with (no contact requests on a
 * Ministry server: it's one church). "Show me to others" takes you off everyone's list, and Hide keeps one person's
 * shares out of your Shared with me without telling them.
 */
export function ContactsDialog({ close }) {
  const dialog = useDialog();
  const [state, setState] = useState(null);
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
  const shown = state?.me?.listed !== false;
  const toggleShown = async () => {
    if (shown && !(await dialog.confirm({
      title: 'Hide yourself from others?',
      message: 'Nobody can share with you, and what you share stops. Turn it back on at any time.',
      okLabel: 'Hide me', danger: true,
    }))) return;
    run(() => api.setShownToOthers(!shown), shown ? 'You’re hidden from others' : 'Others can share with you again');
  };
  const list = state?.contacts ?? [];
  return (
    <div className="contacts-dialog">
      <h2>People</h2>
      {state && !state.enabled ? <p className="muted">Sharing is part of Selah Ministry.</p> : (
        <>
          <p className="modal-message">Everyone on this server who shares. You can share with any of them, and they with you.</p>
          <label className="contact-row contacts-shown">
            <input type="checkbox" checked={shown} disabled={!state} onChange={toggleShown} />
            <span className="share-person-name">Show me to others<small>{shown ? 'Others can share with you, and you with them.' : 'Hidden: nobody can share with you, and you can’t share.'}</small></span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <section className="contacts-group">
            <h3>People</h3>
            {state && !list.length && <p className="muted">{shown ? 'No one else on this server shares yet.' : 'Show yourself to others to see who shares.'}</p>}
            {list.map((c) => (
              <div key={c.slug} className="contact-row">
                <span className={`share-avatar${c.hidden ? ' is-waiting' : ''}`} aria-hidden="true">{(c.name || c.slug).slice(0, 1).toUpperCase()}</span>
                <span className="share-person-name">{c.name || c.slug}<small>{c.hidden ? 'Their shares are hidden from you' : c.slug}</small></span>
                <button type="button" className="btn btn-small" onClick={() => run(() => api.hidePerson(c.slug, !c.hidden), c.hidden ? `${c.name}’s shares show again` : `${c.name}’s shares are hidden`)}>
                  {c.hidden ? 'Show their shares' : 'Hide their shares'}
                </button>
              </div>
            ))}
          </section>
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
