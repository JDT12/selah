import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { startLive } from '../live.js';
import { SlideView, usePassages } from './SlideView.jsx';
import { stepsOf } from '../slides.js';

/**
 * The phone remote (/#remote): open it on your phone, signed in to Selah, while you preach, teach or present from the
 * computer. It shows the slide on show and the next one, the timer (and the lesson step you're in), with big Back and
 * Next buttons and Blank. Everything goes through the server, so the phone only needs to reach Selah.
 */
const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};
const MODE = { preach: 'Preaching', teach: 'Teaching', present: 'Presenting' };

export default function RemotePage() {
  const [live, setLive] = useState(undefined); // undefined: loading; null: nothing presented
  const [deck, setDeck] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const passages = usePassages(deck?.slides, deck?.translation);

  useEffect(() => { document.title = 'Selah Remote'; }, []);
  const load = useCallback(() => api.getSlidesLive().then((r) => { setLive(r.live); setError(null); })
    .catch((e) => setError(e.status === 401 ? 'signin' : e.message)), []);
  useEffect(() => {
    load();
    startLive();
    const onSlides = (e) => {
      const m = e.detail;
      if (m.slides === 'state') setLive(m.live);
      else if (m.slides === 'ended') setLive((l) => (l?.note === m.note ? null : l));
    };
    // A deck saved while presenting: draw it again.
    const onLive = (e) => { if (e.detail?.url?.endsWith('/slides')) setDeck((d) => (d ? { ...d, stale: true } : d)); };
    window.addEventListener('noteapp:slides', onSlides);
    window.addEventListener('noteapp:live', onLive);
    window.addEventListener('noteapp:live-reconnect', load);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('noteapp:slides', onSlides);
      window.removeEventListener('noteapp:live', onLive);
      window.removeEventListener('noteapp:live-reconnect', load);
      clearInterval(t);
    };
  }, [load]);
  const note = live?.note;
  useEffect(() => {
    if (!note) { setDeck(null); return; }
    api.slides(note).then((r) => setDeck(r.deck ? { ...r.deck, note } : null)).catch(() => setDeck(null));
  }, [note, deck?.stale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the phone awake while it's the remote.
  useEffect(() => {
    let lock = null;
    const take = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {}); else load(); };
    take();
    document.addEventListener('visibilitychange', take);
    return () => { document.removeEventListener('visibilitychange', take); lock?.release().catch(() => {}); };
  }, [load]);

  const send = async (cmd) => {
    navigator.vibrate?.(12);
    try { await api.slidesCommand(note, cmd); } catch (e) { if (e.status === 409) setLive(null); else setError(e.message); }
  };
  const slides = useMemo(() => deck?.slides ?? [], [deck]);

  if (error === 'signin') {
    return <div className="remote is-message"><p>Sign in to Selah on this phone first.</p><a className="btn btn-primary" href="/" onClick={() => { try { sessionStorage.setItem('noteapp.afterSignIn', '/#remote'); } catch { /* fine */ } }}>Sign in</a><p className="muted">The remote opens again once you're in.</p></div>;
  }
  if (live === undefined) return <div className="remote is-message"><p>Connecting…</p></div>;
  if (!live) {
    return (
      <div className="remote is-message">
        <Icon name="phone" size={28} />
        <h1>Selah Remote</h1>
        <p>Nothing is being presented right now.</p>
        <p className="muted">On the computer, preach, teach or present a lesson or sermon that has slides. This page picks it up by itself.</p>
        {error && <p className="remote-error">{error}</p>}
      </div>
    );
  }
  const t = live.timer ?? {};
  const elapsed = (t.acc ?? 0) + (t.start ? now - t.start : 0);
  const left = t.goal ? t.goal * 60_000 - elapsed : null;
  const s = slides[live.index];
  const nextAt = s && live.step < stepsOf(s, passages, deck) ? { index: live.index, step: live.step + 1 } : { index: live.index + 1, step: 0 };
  return (
    <div className="remote">
      <header className="remote-head">
        <span className="remote-mode">{MODE[live.mode] ?? 'Presenting'}</span>
        <strong className="remote-title">{live.title}</strong>
        <span className={`remote-time ${left != null && left <= 0 ? 'is-over' : left != null && left < 5 * 60_000 ? 'is-near' : ''}`}>
          {left == null ? clock(elapsed) : left > 0 ? clock(left) : `+${clock(-left)}`}{!t.start && <small> paused</small>}
        </span>
        {live.part && <span className="remote-part">{live.part}</span>}
      </header>
      <div className="remote-now">
        {deck ? <SlideView slide={s} step={live.step} deck={deck} passages={passages} black={live.black} className="is-preview" /> : <p className="muted">Loading the slides…</p>}
        <p className="remote-count">{live.index + 1} / {live.count}{live.black ? ' · blanked' : ''}</p>
      </div>
      {deck && slides[nextAt.index] && (
        <div className="remote-next">
          <span className="muted">Next</span>
          <SlideView slide={slides[nextAt.index]} step={nextAt.step} deck={deck} passages={passages} className="is-thumb" />
        </div>
      )}
      {s?.type === 'question' && s.answer?.trim() && <p className="remote-answer"><span className="muted">Answer</span> {s.answer}</p>}
      {s?.notes?.trim() && <p className="remote-answer"><span className="muted">Your notes</span> {s.notes}</p>}
      <div className="remote-buttons">
        <button type="button" className="remote-btn" onClick={() => send('prev')} aria-label="Back"><Icon name="chevronLeft" size={30} /></button>
        <button type="button" className="remote-btn is-next" onClick={() => send('next')} aria-label="Next"><Icon name="chevronRight" size={34} /> Next</button>
      </div>
      <button type="button" className={`remote-blank ${live.black ? 'is-on' : ''}`} onClick={() => send('black')}>{live.black ? 'Show the slides' : 'Blank the screen'}</button>
    </div>
  );
}

/** How to open the remote on a phone: a QR code to scan, and the address. */
export function RemoteDialog({ close }) {
  const [qr, setQr] = useState(null);
  useEffect(() => { api.remoteQr().then(setQr).catch(() => setQr({ url: `${location.origin}/#remote`, svg: '' })); }, []);
  return (
    <div className="remote-dialog">
      <div className="dialog-header">
        <h2>Phone Remote</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p>Scan this with your phone’s camera (or open the address on it). Sign in to Selah there if it asks; the remote then follows whatever you present here.</p>
      {qr?.svg && <div className="remote-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />}
      {qr && <p className="remote-url"><code>{qr.url}</code></p>}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}
