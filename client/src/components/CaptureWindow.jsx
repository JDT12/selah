import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { isDesktopApp } from '../desktop.js';
import { useStoredState } from '../useStoredState.js';

/**
 * Quick capture (/#capture, 9.1): the small window Selah for Windows opens from its tray menu or Ctrl+Alt+N, on top of
 * whatever you're doing. A thought goes into a note (the Inbox, or a notebook you pick), or a quote, illustration or
 * the like into the sermon bank, for a sermon in progress if you like. Saving closes the window (Esc too); it stays
 * ready in the background, so the next capture opens at once.
 */
const KINDS = [['illustration', 'Illustration'], ['quote', 'Quote'], ['scripture', 'Scripture'], ['application', 'Application'], ['other', 'Other']];
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paragraphs = (t) => t.trim().split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

const invoke = (cmd) => {
  const e = window.selahDesktop;
  if (e?.kind === 'electron') return cmd === 'hide_capture' ? e.hideCapture() : e.openMain();
  return (window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke)?.(cmd).catch?.(() => {});
};
/** Puts the window away (the desktop app keeps it for next time), or in a browser just clears it. */
const hide = () => { if (isDesktopApp()) invoke('hide_capture'); };

export default function CaptureWindow() {
  const [theme] = useStoredState('noteapp.theme', 'system');
  const [dest, setDest] = useStoredState('noteapp.capture.dest', 'note');
  const [bankKind, setBankKind] = useStoredState('noteapp.capture.bankKind', 'illustration');
  const [notebook, setNotebook] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [passage, setPassage] = useState('');
  const [topics, setTopics] = useState('');
  const [sermon, setSermon] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const textRef = useRef(null);

  useEffect(() => {
    document.title = 'Quick capture · Selah';
    document.documentElement.classList.add('is-capture');
  }, []);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const load = useCallback(() => api.clipInfo().then((i) => { setInfo(i); setError(null); })
    .catch((e) => setError(e.status === 401 ? 'signin' : e.message)), []);
  // Each time the window comes back: fresh notebooks and sermons, and the cursor in the text.
  useEffect(() => {
    load();
    const onFocus = () => { load(); setSaved(''); setTimeout(() => textRef.current?.focus(), 0); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const clear = () => { setTitle(''); setText(''); setPassage(''); setTopics(''); setSermon(''); };
  const save = async () => {
    if (!text.trim() && !title.trim()) { textRef.current?.focus(); return; }
    setBusy(true);
    try {
      if (dest === 'bank') {
        if (!text.trim()) throw new Error('Type or paste the material first.');
        const r = await api.clipBank({ html: paragraphs(text), kind: bankKind, title: title.trim(), topics, passage: passage.trim(), sermon_id: Number(sermon) || undefined });
        setSaved(r.sermon ? `Added to the bank for “${r.sermon}”` : 'Added to the sermon bank');
      } else {
        const first = text.trim().split('\n')[0].trim();
        const r = await api.capture({ title: title.trim() || (first.length > 80 ? `${first.slice(0, 79)}…` : first), text, notebook_id: notebook ?? info?.inboxId });
        const nb = info?.notebooks.find((n) => n.id === r.notebook_id)?.name;
        setSaved(`Saved${nb ? ` to ${nb}` : ''}`);
      }
      clear();
      setTimeout(() => { hide(); setSaved(''); }, isDesktopApp() ? 700 : 2500);
    } catch (e) {
      setSaved('');
      setError(e.status === 401 ? 'signin' : e.message);
    }
    setBusy(false);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  };

  if (error === 'signin') {
    return (
      <div className="cap cap-signin">
        <Icon name="lock" size={22} />
        <p>Sign in to Selah first, then try again.</p>
        <button type="button" className="btn btn-primary" onClick={() => (isDesktopApp() ? invoke('open_main') : location.assign('/'))}>Open Selah</button>
      </div>
    );
  }
  const bank = dest === 'bank';
  return (
    <form className="cap" onKeyDown={onKey} onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="cap-head">
        <div className="cap-dest" role="radiogroup" aria-label="Save to">
          {[['note', 'Note', 'note'], ['bank', 'Sermon bank', 'lectern']].map(([k, l, icon]) => (
            <button key={k} type="button" role="radio" aria-checked={dest === k} className={dest === k ? 'is-on' : ''} onClick={() => setDest(k)}>
              <Icon name={icon} size={14} /> {l}
            </button>
          ))}
        </div>
        {!isDesktopApp() && <button type="button" className="icon-btn cap-close" onClick={hide} title="Close (Esc)" aria-label="Close"><Icon name="x" size={16} /></button>}
      </div>

      <input className="input cap-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={bank ? 'Title (optional)' : 'Title (optional: the first line otherwise)'} aria-label="Title" />
      <textarea ref={textRef} className="input cap-text" value={text} onChange={(e) => setText(e.target.value)} autoFocus
        placeholder={bank ? 'The quote, story or illustration…' : 'What’s on your mind…'} aria-label="Text" />

      {bank ? (
        <div className="cap-fields">
          <select className="input" value={bankKind} onChange={(e) => setBankKind(e.target.value)} aria-label="Kind">
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="input" value={passage} onChange={(e) => setPassage(e.target.value)} placeholder="Passage (optional)" aria-label="Passage" />
          <input className="input cap-wide" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="Topics" aria-label="Topics" list="cap-topics" />
          <datalist id="cap-topics">{info?.bankTopics?.map((t) => <option key={t} value={t} />)}</datalist>
          <select className="input cap-wide" value={sermon} onChange={(e) => setSermon(e.target.value)} aria-label="For a sermon">
            <option value="">For any sermon</option>
            {info?.sermons?.map((s) => <option key={s.id} value={s.id}>For “{s.title || 'Untitled sermon'}”{s.status === 'ready' ? ' (ready)' : ''}</option>)}
          </select>
        </div>
      ) : (
        <div className="cap-fields">
          <select className="input cap-wide" value={notebook ?? info?.inboxId ?? ''} onChange={(e) => setNotebook(Number(e.target.value))} aria-label="Notebook">
            {info?.notebooks.map((n) => <option key={n.id} value={n.id}>{n.id === info.inboxId && !/^inbox$/i.test(n.name) ? `${n.name} (Inbox)` : n.name}</option>)}
          </select>
        </div>
      )}

      <div className="cap-foot">
        <span className={`cap-status ${saved ? 'is-saved' : ''}`} role="status">
          {saved ? <><Icon name="check" size={14} /> {saved}</> : error ? <span className="form-error">{error}</span> : <span className="muted">Ctrl+Enter saves · Esc closes</span>}
        </span>
        <button type="submit" className="btn btn-primary" disabled={busy || !info}>{bank ? 'Add to bank' : 'Save note'}</button>
      </div>
    </form>
  );
}
