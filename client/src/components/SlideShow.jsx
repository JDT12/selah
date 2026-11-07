import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { RemoteDialog } from './RemotePage.jsx';
import { isDesktopEdition } from '../mode.js';
import { anchorElements, findAnchor, md } from '../slides.js';
import { SlideView, canPickScreen, openSlidesWindow, usePassages, useSlideControl } from './SlideView.jsx';

/**
 * Presenting a deck from Selah's main window while the slides window shows it to the room.
 *
 * - `Presenter`: Present on a lesson or sermon: the slide on show and the next one, the question's answer and your
 *   notes, every slide along the bottom, a timer. With one screen, Present here shows the slides full screen.
 * - `SlideStrip`: the bar along the bottom of preaching mode. Your place in the note moves the slides (each slide
 *   comes up when its place in the note reaches the reading line), ◀ ▶ move them by hand, and the pins beside the
 *   text put a slide up straight away.
 */

const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${two(Math.floor(s / 60))}:${two(s % 60)}`; };

function useKeys(ctl, { onEscape, enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); ctl.setBlack(false); ctl.next(); }
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); ctl.setBlack(false); ctl.prev(); }
      else if (e.key === 'b' || e.key === 'B' || e.key === '.') ctl.setBlack((b) => !b);
      else if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl, onEscape, enabled]);
}

/** The window buttons: the slides window, and (where the browser can tell) the slides window on the other screen. */
function WindowButtons({ noteId, linked, compact = false }) {
  const dialog = useDialog();
  return (
    <>
      {/* Selah Desktop's own library is only on this PC, so a phone can't reach it. */}
      {!isDesktopEdition() && (
        <button type="button" className="ss-btn" onClick={() => dialog.open((c) => <RemoteDialog close={c} />)} title="Move the slides from your phone">
          <Icon name="phone" size={15} /> {compact ? '' : 'Phone remote'}
        </button>
      )}
      <button type="button" className={`ss-btn ${linked ? 'is-on' : ''}`} onClick={() => openSlidesWindow(noteId)} title={linked ? 'The slides window is open' : 'Open the slides window: drag it to the projector or TV, then make it full screen (F)'}>
        <Icon name="monitor" size={15} /> {compact ? '' : linked ? 'Slides window' : 'Open slides window'}
      </button>
      {canPickScreen() && !linked && (
        <button type="button" className="ss-btn" onClick={() => openSlidesWindow(noteId, { otherScreen: true })} title={window.selahDesktop ? 'Full screen on the other screen; the controls stay here' : 'Open it on the other screen (the browser asks first)'}>
          {compact ? '⇥' : 'On the other screen'}
        </button>
      )}
    </>
  );
}

export function Presenter({ note, deck, close }) {
  const passages = usePassages(deck.slides, deck.translation);
  const [start] = useState(Date.now());
  const ctl = useSlideControl(note.id, deck, passages, { mode: 'present', title: note.title || 'Untitled', timer: { start, acc: 0, goal: null } });
  const [here, setHere] = useState(false);
  const [now, setNow] = useState(Date.now());
  const hereRef = useRef(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const leaveHere = useCallback(() => {
    setHere(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);
  useKeys(ctl, { onEscape: here ? leaveHere : close });
  useEffect(() => {
    if (!here) return undefined;
    hereRef.current?.requestFullscreen?.().catch(() => {});
    const onFs = () => { if (!document.fullscreenElement) setHere(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [here]);

  const { slides, at } = ctl;
  const s = slides[at.index];
  const nextAt = at.step < ctl.steps(at.index) ? { index: at.index, step: at.step + 1 } : { index: at.index + 1, step: 0 };
  const n = slides[nextAt.index];
  const thumbs = useRef(null);
  useEffect(() => { thumbs.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [at.index]);

  if (here) {
    return (
      <div ref={hereRef} className={`slides-window slides-${deck.theme}`} onClick={(e) => { ctl.setBlack(false); (e.clientX > window.innerWidth / 3 ? ctl.next : ctl.prev)(); }}>
        <SlideView slide={s} step={at.step} deck={deck} passages={passages} fit black={ctl.black} className="is-screen" />
      </div>
    );
  }
  return (
    <div className="presenter">
      <div className="presenter-bar">
        <strong className="presenter-title">{note.title || 'Untitled'}</strong>
        <span className="presenter-count">{at.index + 1} / {slides.length}</span>
        <span className="presenter-time" title="Time since you started">{clock(now - start)}</span>
        <span className="presenter-clock">{new Date(now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span className="spacer" />
        <WindowButtons noteId={note.id} linked={ctl.linked} />
        <button type="button" className="ss-btn" onClick={() => setHere(true)} title="Show the slides full screen here (one screen)"><Icon name="play" size={14} /> Present here</button>
        <button type="button" className={`ss-btn ${ctl.black ? 'is-on' : ''}`} onClick={() => ctl.setBlack((b) => !b)} title="Blank the slides (B)">Blank</button>
        <button type="button" className="ss-btn" onClick={close} aria-label="End (Esc)"><Icon name="x" size={16} /></button>
      </div>
      <div className="presenter-main">
        <div className="presenter-now">
          <SlideView slide={s} step={at.step} deck={deck} passages={passages} fit black={ctl.black} className="is-preview" />
          <div className="presenter-nav">
            <button type="button" className="btn" onClick={ctl.prev}><Icon name="chevronLeft" size={16} /> Back</button>
            <button type="button" className="btn btn-primary" onClick={ctl.next}>Next <Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
        <aside className="presenter-side">
          <p className="presenter-label">Next</p>
          {n ? <SlideView slide={n} step={nextAt.step} deck={deck} passages={passages} className="is-thumb" /> : <p className="muted">The end of the slides.</p>}
          {s?.type === 'question' && s.answer?.trim() && (
            <div className="presenter-box"><p className="presenter-label">Answer</p><div dangerouslySetInnerHTML={{ __html: md(s.answer) }} /></div>
          )}
          {s?.notes?.trim() && <div className="presenter-box"><p className="presenter-label">Your notes</p><div dangerouslySetInnerHTML={{ __html: md(s.notes) }} /></div>}
          {!ctl.linked && <p className="muted presenter-help">Open the slides window and drag it to the projector or TV; press F there for full screen. Arrow keys, a clicker or a click on the slides move them on.</p>}
        </aside>
      </div>
      <ol className="presenter-thumbs" ref={thumbs}>
        {slides.map((x, j) => (
          <li key={x.id}>
            <button type="button" className={j === at.index ? 'is-active' : ''} onClick={() => ctl.go(j)} aria-label={`Slide ${j + 1}`}>
              <SlideView slide={x} deck={deck} passages={passages} all className="is-thumb" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Preaching mode's slide bar. `root` is the element the note is drawn in; `version` changes when it's drawn again
 * (a view switched), so the pins go back on.
 */
export function SlideStrip({ noteId, deck, root, version, meta }) {
  const passages = usePassages(deck.slides, deck.translation);
  const ctl = useSlideControl(noteId, deck, passages, meta);
  const [follow, setFollow] = useState(true);
  const last = useRef(null);
  const anchors = useRef([]);

  // Pins beside the places that bring up a slide; a tap puts that slide up.
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const cache = anchorElements(el);
    anchors.current = deck.slides.map((s, i) => ({
      i, el: findAnchor(el, s.anchor, cache), top: s.anchor === '^',
      points: (s.points ?? []).filter((p) => p.text.trim() && p.level === 0).map((p) => findAnchor(el, p.anchor, cache)),
      hasText: !!s.text?.trim(),
    }));
    const pins = [];
    for (const a of anchors.current) {
      if (!a.el) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pm-slide-pin';
      b.dataset.slide = String(a.i);
      b.title = `Show slide ${a.i + 1}`;
      b.setAttribute('aria-label', `Show slide ${a.i + 1}`);
      b.textContent = String(a.i + 1);
      // Inside a list item's first paragraph, so the text stays on the pin's line.
      const first = a.el.tagName === 'LI' && a.el.firstElementChild?.tagName === 'P' ? a.el.firstElementChild : a.el;
      first.prepend(b);
      pins.push(b);
    }
    const onClick = (e) => {
      const pin = e.target.closest?.('.pm-slide-pin');
      if (!pin) return;
      e.stopPropagation();
      e.preventDefault();
      ctl.setBlack(false);
      ctl.go(Number(pin.dataset.slide));
    };
    el.addEventListener('click', onClick, true);
    return () => { el.removeEventListener('click', onClick, true); pins.forEach((b) => b.remove()); };
  }, [root, deck, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Following your place: the last slide whose place is above the reading line (a third of the way down).
  const place = useCallback(() => {
    const line = window.innerHeight * 0.33;
    const shown = (el) => el && el.getClientRects().length > 0;
    let best = null;
    for (const a of anchors.current) {
      if (!shown(a.el)) continue;
      const top = a.el.getBoundingClientRect().top;
      if (top <= line && (!best || top >= best.top)) best = { i: a.i, top, a };
    }
    const scroller = root.current?.closest('.pm-page');
    const atTop = !scroller || scroller.scrollTop < 8;
    if (!best || atTop) {
      const first = anchors.current.find((a) => a.top) ?? anchors.current[0];
      return first ? { index: first.i, step: 0 } : null;
    }
    const passed = best.a.points.filter((el) => shown(el) && el.getBoundingClientRect().top <= line).length;
    return { index: best.i, step: Math.max(0, passed - (best.a.hasText ? 0 : 1)) };
  }, [root]);
  useEffect(() => {
    if (!follow) return undefined;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const p = place();
        if (!p) return;
        const key = `${p.index}:${p.step}`;
        if (last.current === key) return;
        last.current = key;
        ctl.go(p.index, p.step);
      });
    };
    document.addEventListener('scroll', onScroll, true);
    onScroll();
    return () => { document.removeEventListener('scroll', onScroll, true); cancelAnimationFrame(raf); };
  }, [follow, place, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = ctl.slides[ctl.at.index];
  return (
    <div className="pm-slides" role="toolbar" aria-label="Slides">
      <button type="button" className="pm-icon" onClick={() => { ctl.setBlack(false); ctl.prev(); }} aria-label="Previous slide"><Icon name="chevronLeft" size={16} /></button>
      <span className="pm-slides-now" title={s?.title}>
        <SlideView slide={s} step={ctl.at.step} deck={deck} passages={passages} black={ctl.black} className="is-thumb" />
        <span><strong>{ctl.at.index + 1}/{ctl.slides.length}</strong> {s?.title || s?.ref || ''}</span>
      </span>
      <button type="button" className="pm-icon" onClick={() => { ctl.setBlack(false); ctl.next(); }} aria-label="Next slide"><Icon name="chevronRight" size={16} /></button>
      <label className="pm-slides-follow" title="Move the slides as you move through the note">
        <input type="checkbox" checked={follow} onChange={(e) => { setFollow(e.target.checked); last.current = null; }} /> Follow my place
      </label>
      <button type="button" className={`pm-link ${ctl.black ? 'pm-link-strong' : ''}`} onClick={() => ctl.setBlack((b) => !b)}>{ctl.black ? 'Show slides' : 'Blank'}</button>
      <WindowButtons noteId={noteId} linked={ctl.linked} compact={false} />
    </div>
  );
}
