import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { startLive } from '../live.js';
import { buzz } from '../mobile.js';
import { SlideView, usePassages } from './SlideView.jsx';
import { stepsOf } from '../slides.js';

/**
 * The phone remote (/#remote): open it on your phone, signed in to Selah, while you preach, teach or present from the
 * computer. It shows the slide on show and the next one, the timer (and the lesson step you're in), with big Back and
 * Next buttons and Blank. Everything goes through the server, so the phone only needs to reach Selah.
 * 13.0: built into the phone app too (More → Remote, `onClose`). It follows a sermon or lesson with no slides (the
 * timer and step, with Start and Pause), buzzes at five minutes left and at time, and says when the connection drops.
 */
const QUIET = 50_000; // the presenting device says where it is every 20 s
const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};
const MODE = { preach: 'Preaching', teach: 'Teaching', present: 'Presenting' };

export default function RemotePage({ onClose = null }) {
  const [live, setLive] = useState(undefined); // undefined: loading; null: nothing presented
  const [down, setDown] = useState(false);
  const [heard, setHeard] = useState(Date.now());
  const cues = useRef({ note: null, warn: false, time: false });
  const [deck, setDeck] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const passages = usePassages(deck?.slides, deck?.translation);

  useEffect(() => { if (!onClose) document.title = 'Selah Remote'; }, [onClose]);
  const load = useCallback(() => api.getSlidesLive().then((r) => { setLive(r.live); setError(null); setDown(false); setHeard(Date.now()); })
    .catch((e) => setError(e.status === 401 ? 'signin' : e.message)), []);
  useEffect(() => {
    load();
    startLive();
    const onSlides = (e) => {
      const m = e.detail;
      if (m.slides === 'state') { setLive(m.live); setHeard(Date.now()); setDown(false); }
      else if (m.slides === 'ended') setLive((l) => (l?.note === m.note ? null : l));
    };
    // A deck saved while presenting: draw it again.
    const onLive = (e) => { if (e.detail?.url?.endsWith('/slides')) setDeck((d) => (d ? { ...d, stale: true } : d)); };
    window.addEventListener('noteapp:slides', onSlides);
    window.addEventListener('noteapp:live', onLive);
    window.addEventListener('noteapp:live-reconnect', load);
    const onDown = () => setDown(true);
    window.addEventListener('noteapp:live-down', onDown);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('noteapp:live-down', onDown);
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
    buzz('tap');
    try { await api.slidesCommand(note, cmd); setDown(false); } catch (e) { if (e.status === 409) setLive(null); else if (!e.status) setDown(true); else setError(e.message); }
  };

  // A buzz at five minutes left and another at time (once each, while the timer runs).
  const tm = live?.timer ?? {};
  const leftNow = tm.goal ? tm.goal * 60_000 - ((tm.acc ?? 0) + (tm.start ? now - tm.start : 0)) : null;
  useEffect(() => {
    const c = cues.current;
    if (c.note !== note) { cues.current = { note, warn: leftNow != null && leftNow <= 5 * 60_000, time: leftNow != null && leftNow <= 0 }; return; }
    if (leftNow == null || !tm.start) return;
    if (!c.warn && leftNow <= 5 * 60_000 && leftNow > 0) { c.warn = true; buzz('warn'); }
    if (!c.time && leftNow <= 0) { c.time = c.warn = true; buzz('time'); }
  }, [leftNow, note, tm.start]);
  const quiet = live && now - heard > QUIET;
  const trouble = down ? 'Connection lost. Reconnecting…' : quiet ? 'Haven’t heard from the presenting screen for a minute. Is it still open?' : null;
  const closeBtn = onClose && <button type="button" className="remote-close" onClick={onClose} aria-label="Close the remote"><Icon name="x" size={20} /></button>;
  const slides = useMemo(() => deck?.slides ?? [], [deck]);

  if (error === 'signin') {
    return <div className="remote is-message"><p>Sign in to Selah on this phone first.</p><a className="btn btn-primary" href="/" onClick={() => { try { sessionStorage.setItem('noteapp.afterSignIn', '/#remote'); } catch { /* fine */ } }}>Sign in</a><p className="muted">The remote opens again once you're in.</p></div>;
  }
  if (live === undefined) return <div className="remote is-message">{closeBtn}<p>Connecting…</p></div>;
  if (!live) {
    return (
      <div className="remote is-message">
        {closeBtn}
        <Icon name="phone" size={28} />
        <h1>Selah Remote</h1>
        <p>Nothing is being preached or taught right now.</p>
        <p className="muted">Start Preach or Teach on your iPad or computer. The remote picks it up by itself.</p>
        {down && <p className="remote-error">Connection lost. Reconnecting…</p>}
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
    <div className={`remote ${live.count ? '' : 'is-no-slides'}`}>
      {trouble && <p className="remote-trouble" role="alert">{trouble}</p>}
      <header className="remote-head">
        {closeBtn}
        <span className="remote-mode">{MODE[live.mode] ?? 'Presenting'}</span>
        <strong className="remote-title">{live.title}</strong>
        <span className={`remote-time ${left != null && left <= 0 ? 'is-over' : left != null && left < 5 * 60_000 ? 'is-near' : ''}`}>
          {left == null ? clock(elapsed) : left > 0 ? clock(left) : `+${clock(-left)}`}{!t.start && <small> paused</small>}
        </span>
        {live.part && <span className="remote-part">{live.part}</span>}
      </header>
      {!live.count && (
        <div className="remote-clock">
          <span className={`remote-big-time ${left != null && left <= 0 ? 'is-over' : left != null && left < 5 * 60_000 ? 'is-near' : ''}`}>{left == null ? clock(elapsed) : left > 0 ? clock(left) : `+${clock(-left)}`}</span>
          {t.goal ? <span className="muted">of {t.goal} minutes</span> : <span className="muted">No goal time</span>}
        </div>
      )}
      {live.count > 0 && <div className="remote-now">
        {deck ? <SlideView slide={s} step={live.step} deck={deck} passages={passages} black={live.black} className="is-preview" /> : <p className="muted">Loading the slides…</p>}
        <p className="remote-count">{live.index + 1} / {live.count}{live.black ? ' · blanked' : ''}</p>
      </div>}
      {deck && slides[nextAt.index] && (
        <div className="remote-next">
          <span className="muted">Next</span>
          <SlideView slide={slides[nextAt.index]} step={nextAt.step} deck={deck} passages={passages} className="is-thumb" />
        </div>
      )}
      {s?.type === 'question' && s.answer?.trim() && <p className="remote-answer"><span className="muted">Answer</span> {s.answer}</p>}
      {s?.notes?.trim() && <p className="remote-answer"><span className="muted">Your notes</span> {s.notes}</p>}
      {live.count > 0 && (
        <div className="remote-buttons">
          <button type="button" className="remote-btn" onClick={() => send('prev')} aria-label="Back"><Icon name="chevronLeft" size={30} /></button>
          <button type="button" className="remote-btn is-next" onClick={() => send('next')} aria-label="Next"><Icon name="chevronRight" size={34} /> Next</button>
        </div>
      )}
      <div className="remote-row">
        <button type="button" className={`remote-blank ${t.start ? '' : 'is-start'}`} onClick={() => send('timer')}>{t.start ? 'Pause the timer' : elapsed > 0 ? 'Start the timer again' : 'Start the timer'}</button>
        {live.count > 0 && <button type="button" className={`remote-blank ${live.black ? 'is-on' : ''}`} onClick={() => send('black')}>{live.black ? 'Show the slides' : 'Blank the screen'}</button>}
      </div>
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
      <p>In the Selah app on your phone, open <strong>More → Remote</strong>. No app? Scan this with your phone’s camera (or open the address on it) and sign in to Selah there if it asks. The remote then follows whatever you present here.</p>
      {qr?.svg && <div className="remote-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />}
      {qr && <p className="remote-url"><code>{qr.url}</code></p>}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}
