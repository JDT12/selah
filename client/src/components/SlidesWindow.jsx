import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { startLive } from '../live.js';
import { stepsOf } from '../slides.js';
import { CHANNEL, SlideView, rememberWindow, usePassages } from './SlideView.jsx';

/**
 * The slides window (/#slides/<note>, or /#slides for whatever is being presented): the audience's view, for the
 * projector or TV. Drag it to that screen and make it full screen. It follows the window you preach, teach or present
 * from two ways: straight from a window in the same browser, and through the server's live updates otherwise (the
 * Windows app, another browser, another computer at the projector), so the phone remote moves it too. A clicker or
 * the keys here move the presentation along. With nothing presenting it, it steps through the deck by itself.
 */
const SAME_BROWSER = 30_000; // a direct message this recent means the controller is in this browser
// 13.0: on a TV from the iPad app (?tv=1): the audience's view only, never the bar.
const ON_TV = new URLSearchParams(location.search).has('tv');

export default function SlidesWindow({ noteId: fixed = null }) {
  const [noteId, setNoteId] = useState(fixed);
  const [deck, setDeck] = useState(null);
  const [error, setError] = useState(null);
  const [at, setAt] = useState({ index: 0, step: 0 });
  const [black, setBlack] = useState(false);
  const [driven, setDriven] = useState(false); // something is presenting this note
  const [chrome, setChrome] = useState(true);
  const ch = useRef(null);
  const direct = useRef(0); // when the last message came straight from a window in this browser
  const passages = usePassages(deck?.slides, deck?.translation);

  const load = useCallback(() => {
    if (!noteId) { setDeck(null); return; }
    api.slides(noteId).then((r) => {
      if (!r.deck) setError('This note has no slides yet.');
      else { setDeck(r.deck); setError(null); }
    }).catch((e) => setError(e.status === 401 ? 'signin' : e.message));
  }, [noteId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { document.title = 'Selah Slides'; }, []);

  const adopt = useCallback((m, viaDirect) => {
    if (viaDirect) direct.current = Date.now();
    setDriven(true);
    setAt({ index: m.index, step: m.step });
    setBlack(!!m.black);
  }, []);

  // Straight from a window in this browser.
  useEffect(() => {
    if (typeof BroadcastChannel !== 'function') return undefined;
    const c = new BroadcastChannel(CHANNEL);
    ch.current = c;
    c.onmessage = (e) => {
      const m = e.data;
      if (!m?.note || (noteId && m.note !== noteId)) return;
      if (m.t === 'state' && m.note === noteId) adopt(m, true);
      else if (m.t === 'controller') c.postMessage({ t: 'hello', note: m.note });
      else if (m.t === 'released') setDriven(false);
      else if (m.t === 'deck' && m.note === noteId) load();
    };
    if (noteId) c.postMessage({ t: 'hello', note: noteId });
    const bye = () => { rememberWindow(); if (noteId) c.postMessage({ t: 'bye', note: noteId }); };
    window.addEventListener('beforeunload', bye);
    return () => { window.removeEventListener('beforeunload', bye); c.close(); ch.current = null; };
  }, [noteId, load, adopt]);

  // Through the server: whatever is presented (anywhere you're signed in), and decks saved.
  useEffect(() => {
    startLive();
    const follow = (live) => {
      if (!live) return;
      if (!fixed && live.note !== noteId) { setNoteId(live.note); setAt({ index: live.index, step: live.step }); setDriven(true); return; }
      if (live.note === noteId) adopt(live, false);
    };
    api.getSlidesLive().then((r) => follow(r.live)).catch(() => {});
    const onSlides = (e) => {
      const m = e.detail;
      if (m.slides === 'state') follow(m.live);
      else if (m.slides === 'ended' && m.note === noteId) setDriven(false);
    };
    const onLive = (e) => { if (noteId && e.detail?.url === `/api/notes/${noteId}/slides`) load(); };
    window.addEventListener('noteapp:slides', onSlides);
    window.addEventListener('noteapp:live', onLive);
    window.addEventListener('noteapp:live-reconnect', load);
    return () => {
      window.removeEventListener('noteapp:slides', onSlides);
      window.removeEventListener('noteapp:live', onLive);
      window.removeEventListener('noteapp:live-reconnect', load);
    };
  }, [noteId, fixed, load, adopt]);

  const slides = deck?.slides ?? [];
  const send = useCallback((cmd) => {
    if (Date.now() - direct.current < SAME_BROWSER) ch.current?.postMessage(cmd === 'black' ? { t: 'black', note: noteId } : { t: 'nav', note: noteId, dir: cmd === 'next' ? 1 : -1 });
    else api.slidesCommand(noteId, cmd).catch(() => setDriven(false));
  }, [noteId]);
  const move = useCallback((dir) => {
    if (driven) { send(dir > 0 ? 'next' : 'prev'); return; }
    setBlack(false);
    setAt(({ index, step }) => {
      if (dir > 0) return step < stepsOf(slides[index], passages, deck) ? { index, step: step + 1 } : index < slides.length - 1 ? { index: index + 1, step: 0 } : { index, step };
      return step > 0 ? { index, step: step - 1 } : index > 0 ? { index: index - 1, step: stepsOf(slides[index - 1], passages, deck) } : { index, step };
    });
  }, [driven, send, slides, passages, deck]);
  const blank = useCallback(() => (driven ? send('black') : setBlack((b) => !b)), [driven, send]);
  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});

  useEffect(() => {
    const onKey = (e) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); move(1); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); move(-1); }
      else if (e.key === 'b' || e.key === 'B' || e.key === '.') blank();
      else if (e.key === 'f' || e.key === 'F') full();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, blank]);

  const timer = useRef(null);
  const wake = () => {
    if (ON_TV) { setChrome(false); return; }
    setChrome(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setChrome(false), 2500);
  };
  useEffect(() => { wake(); return () => clearTimeout(timer.current); }, []);

  if (error === 'signin') {
    return (
      <div className="slides-window is-message">
        <p>Sign in to Selah in this browser to show the slides.</p>
        <a className="btn btn-primary" href="/" onClick={() => { try { sessionStorage.setItem('noteapp.afterSignIn', location.pathname + location.hash); } catch { /* fine */ } }}>Sign in</a>
      </div>
    );
  }
  if (error) return <div className="slides-window is-message"><p>{error}</p></div>;
  if (!noteId) return <div className="slides-window is-message"><p>Waiting for a presentation: preach, teach or present a lesson or sermon with slides in Selah.</p></div>;
  if (!deck) return <div className="slides-window is-message"><p>Loading…</p></div>;
  const s = slides[Math.min(at.index, slides.length - 1)];
  return (
    <div className={`slides-window slides-${deck.theme} ${chrome ? '' : 'is-quiet'}`} onMouseMove={wake}
      onClick={(e) => { if (!e.target.closest('.slides-window-bar')) move(e.clientX > window.innerWidth / 3 ? 1 : -1); }}>
      <SlideView slide={s} step={at.step} deck={deck} passages={passages} fit black={black} className="is-screen" />
      {!ON_TV && <div className="slides-window-bar" role="toolbar" aria-label="Slides">
        <span>{at.index + 1} / {slides.length}</span>
        <span className="slides-window-state">{driven ? 'Following Selah' : 'On its own'}</span>
        <button type="button" onClick={full}>{document.fullscreenElement ? 'Leave full screen' : 'Full screen (F)'}</button>
      </div>}
    </div>
  );
}
