import { useEffect, useState } from 'react';
import { WHATS_NEW } from '../../../shared/whatsnew.js';
import { version } from '../../../package.json';
import { request } from '../api.js';
import Icon from './Icon.jsx';

/**
 * Trying a beta (11.1). While Selah runs a pre-release (11.1.0-beta.2) the top bar has a Beta button. It opens a panel
 * that stays open while you use Selah: what's new in this beta (the What's New entry for the coming release, or its
 * `try` list when it has one) to tick off as you try each thing, "Something's off" under any of them, and a box for
 * anything else. Kept on the server (server/betareview.js), so it survives the demo's Reset and the admin console can
 * read it (npm run admin -- beta-review).
 */
export const isBeta = version.includes('-');
const core = (v) => String(v).split('-')[0];

/** What to try: the entry for the release this beta leads up to. */
export function betaItems() {
  const entry = WHATS_NEW.find((e) => core(e.version) === core(version));
  return entry ? (entry.try ?? entry.items) : [];
}

const key = (item) => item.slice(0, 300);

export default function BetaReview() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);
  const [noteFor, setNoteFor] = useState(null); // the item a note is being written about, or '' for anything else
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const items = betaItems();

  useEffect(() => { request('GET', '/api/beta-review').then(setState).catch(() => {}); }, []);
  if (!isBeta) return null;
  const checks = state?.checks ?? {};
  const notes = state?.notes ?? [];
  const tried = items.filter((i) => checks[key(i)]).length;

  const tick = (item, done) => {
    setState((s) => ({ ...s, checks: { ...(s?.checks ?? {}), [key(item)]: done ? Date.now() : undefined } }));
    request('PUT', '/api/beta-review/check', { item: key(item), done }).then(setState).catch(() => {});
  };
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setState(await request('POST', '/api/beta-review/note', { item: noteFor || null, text, page: location.hash.slice(1) || 'home' }));
      setText('');
      setNoteFor(null);
    } finally { setBusy(false); }
  };
  const drop = (id) => request('DELETE', `/api/beta-review/note/${id}`).then(setState).catch(() => {});
  const notesOn = (item) => notes.filter((n) => n.item === key(item));

  const writer = (
    <div className="beta-note-form">
      <textarea className="input" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)}
        placeholder="What happened, and what did you expect? The page you’re on is noted with it." />
      <div className="beta-note-actions">
        <button type="button" className="btn btn-small" onClick={() => { setNoteFor(null); setText(''); }}>Cancel</button>
        <button type="button" className="btn btn-small btn-primary" disabled={busy || !text.trim()} onClick={send}>Save note</button>
      </div>
    </div>
  );
  const noteList = (list) => list.map((n) => (
    <div key={n.id} className="beta-note">
      <span>{n.text}{n.page && <span className="muted"> · {n.page}</span>}</span>
      <button type="button" className="icon-btn" onClick={() => drop(n.id)} aria-label="Delete note" title="Delete note"><Icon name="x" size={12} /></button>
    </div>
  ));

  return (
    <>
      <button type="button" className={`top-beta ${open ? 'is-on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={`You’re trying ${version}. What’s in it, to tick off as you try it`}>
        Beta{items.length ? ` · ${tried}/${items.length}` : ''}
      </button>
      {open && (
        <aside className="beta-panel" aria-label="Trying this beta">
          <div className="whatsnew-card-head">
            <Icon name="flag" size={18} />
            <strong>Try {version}</strong>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close" title="Close"><Icon name="x" size={16} /></button>
          </div>
          <div className="beta-body">
            <p className="muted beta-lead">Tick each one once you’ve tried it and it works. If something’s off, say so under it.</p>
            {!items.length && <p className="muted">There’s no list for this beta yet.</p>}
            <ul className="beta-items">
              {items.map((item) => (
                <li key={item} className={checks[key(item)] ? 'is-done' : ''}>
                  <label>
                    <input type="checkbox" checked={!!checks[key(item)]} onChange={(e) => tick(item, e.target.checked)} />
                    <span>{item}</span>
                  </label>
                  {noteList(notesOn(item))}
                  {noteFor === item ? writer : (
                    <button type="button" className="link-btn beta-off" onClick={() => { setNoteFor(item); setText(''); }}>Something’s off</button>
                  )}
                </li>
              ))}
            </ul>
            <h4>Anything else</h4>
            {noteList(notes.filter((n) => !n.item || !items.some((i) => key(i) === n.item)))}
            {noteFor === '' ? writer : <button type="button" className="btn btn-small" onClick={() => { setNoteFor(''); setText(''); }}>Add a note</button>}
          </div>
        </aside>
      )}
    </>
  );
}
