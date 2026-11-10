import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { bibleConnected, biblePassage } from '../esv.js';
import { md, passageKey, passagePages, slideTr, stepsOf } from '../slides.js';
import { artSvg, isTexture } from '../slideArt.js';
import { deckLook, lookVars, useBrand } from '../slideLook.js';

/**
 * One slide, drawn at 16:9 in the deck's theme (Lamplight light or dark). Sizes are in container units, so the same
 * slide reads the same as a thumbnail, in the editor and on the projector. On a screen (`fit`), text too long for
 * the slide shrinks to fit; points still to come keep their room, so the text doesn't change size as they come in.
 *
 * Also here: the passages a deck reads (ESV), and the link between the window you present from and the slides
 * window (a BroadcastChannel, so both are in the same browser).
 */

const visiblePoints = (slide, step) => (slide.text?.trim() ? step : step + 1);

/** The art, picture and logo behind and over a slide's text (11.0). */
function Layers({ slide, deck, look, brand }) {
  const artId = slide.type === 'image' || slide.art === 'none' ? null : slide.art || look.art;
  const art = useMemo(() => (artId ? artSvg(artId, look.palette.art) : null), [artId, look.palette.art]);
  const bg = slide.type === 'image' ? null : slide.bg ?? deck.bg ?? null;
  const logo = brand.logo && deck.theme === 'brand' && deck.logo !== false && slide.logo !== false && slide.type !== 'image' ? brand.logo : null;
  return (
    <>
      {bg && <div className="slide-bgimg" style={{ backgroundImage: `url(/api/files/${bg})` }} />}
      {bg && <div className="slide-dim" style={{ opacity: deck.dim ?? 0.45 }} />}
      {art && <div className={`slide-art ${isTexture(artId) ? 'is-texture' : 'is-line'}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: art }} />}
      {logo && <img className={`slide-logo is-${brand.logoPos || 'tr'}`} src={`/api/files/${logo}`} alt="" />}
    </>
  );
}

export function SlideView({ slide, step = 0, deck = null, theme = 'light', passages = {}, fit = false, all = false, black = false, className = '' }) {
  const ref = useRef(null);
  const d = deck ?? { theme };
  const brand = useBrand();
  const look = useMemo(() => deckLook(d, brand), [d.theme, d.colors, d.custom, d.fonts, d.art, brand]); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = useMemo(() => lookVars(look), [look]);
  const p = slide?.type === 'passage' ? passages[passageKey(slide, d)] : null;
  const pages = useMemo(() => passagePages(p?.text), [p]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!fit || !el) return;
    let f = 1;
    el.style.setProperty('--fit', f);
    // Never smaller than readable: a passage is paged so it fits; other text stops at 60%.
    const min = slide?.type === 'passage' ? 0.8 : 0.6;
    while (f > min && el.scrollHeight > el.clientHeight + 1) {
      f = Math.round((f - 0.05) * 100) / 100;
      el.style.setProperty('--fit', f);
    }
  });
  if (!slide) return <div className={`slide slide-${d.theme} ${className}`} style={vars}><div className="slide-inner" /></div>;
  const shown = all ? Infinity : visiblePoints(slide, step);
  let top = 0;
  const points = (slide.points ?? []).filter((x) => x.text.trim()).map((x, i) => {
    if (x.level === 0) top += 1;
    const state = top > shown ? 'is-hidden' : top === shown && !all ? 'is-current' : '';
    return <li key={i} className={`lvl-${Math.min(x.level, 3)} ${state}`} dangerouslySetInnerHTML={{ __html: md(x.text).replace(/^<p>|<\/p>$/g, '') }} />;
  });
  return (
    <div className={`slide slide-${d.theme} slide-t-${slide.type} ${className}`} style={vars}>
      {!black && <Layers slide={slide} deck={d} look={look} brand={brand} />}
      {black ? <div className="slide-black" /> : (
        <div ref={ref} className="slide-inner">
          {slide.type === 'title' && (
            <div className="slide-center">
              <h1 className="slide-big">{slide.title}</h1>
              {slide.text?.trim() && <div className="slide-sub" dangerouslySetInnerHTML={{ __html: md(slide.text) }} />}
            </div>
          )}
          {slide.type === 'point' && (
            <div className={slide.title ? '' : 'slide-center slide-statement'}>
              {slide.title && <h2>{slide.title}</h2>}
              {slide.text?.trim() && <div className="slide-text" dangerouslySetInnerHTML={{ __html: md(slide.text) }} />}
              {points.length > 0 && <ul className="slide-points">{points}</ul>}
            </div>
          )}
          {slide.type === 'passage' && (
            <>
              <h2>{p?.reference || slide.title || slide.ref || 'Passage'}</h2>
              {pages.length ? (() => {
                const pg = pages[all ? 0 : Math.min(step, pages.length - 1)];
                return (
                  <>
                    <div className="slide-passage" dangerouslySetInnerHTML={{ __html: pg.html }} />
                    <p className="slide-credit">{p?.translation ?? 'Bible'}{pg.verse ? ` · verse ${pg.verse}${pg.parts > 1 ? ` (${pg.part} of ${pg.parts})` : ''}` : ''}{pages.length > 1 ? ` · ${(all ? 0 : Math.min(step, pages.length - 1)) + 1}/${pages.length}` : ''}</p>
                  </>
                );
              })() : slide.text?.trim() && <div className="slide-text" dangerouslySetInnerHTML={{ __html: md(slide.text) }} />}
            </>
          )}
          {slide.type === 'image' && (
            <div className="slide-image">
              {slide.image ? <img src={`/api/files/${slide.image}`} alt={slide.title || ''} style={{ objectFit: slide.fit === 'cover' ? 'cover' : 'contain' }} />
                : <p className="slide-empty">No picture yet</p>}
              {slide.title && <p className="slide-caption">{slide.title}</p>}
            </div>
          )}
          {slide.type === 'question' && (
            <div className="slide-center">
              <p className="slide-kicker">Discuss</p>
              <h2 className="slide-question">{slide.title}</h2>
              {slide.text?.trim() && <div className="slide-text" dangerouslySetInnerHTML={{ __html: md(slide.text) }} />}
            </div>
          )}
          {slide.type === 'custom' && (
            <>
              {slide.title && <h2>{slide.title}</h2>}
              <div className="slide-text" dangerouslySetInnerHTML={{ __html: md(slide.text) }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The Bible text of a deck's passage slides (favorite translation): { ref: { reference, text, translation } } (empty when no Bible is connected). */
export function usePassages(slides, translation = '') {
  // 11.0: kept by translation and reference (passageKey): a slide can read in its own translation.
  const deck = useMemo(() => ({ translation }), [translation]);
  const wants = useMemo(() => {
    const m = new Map();
    for (const s of slides ?? []) if (s.type === 'passage' && s.ref?.trim()) m.set(passageKey(s, deck), [s.ref.trim(), slideTr(s, deck)]);
    return m;
  }, [slides, deck]);
  const [found, setFound] = useState({});
  const key = [...wants.keys()].join('§');
  useEffect(() => {
    let live = true;
    (async () => {
      if (!wants.size || !(await bibleConnected())) return;
      for (const [k, [r, tr]] of wants) {
        if (found[k]) continue;
        try {
          const p = await biblePassage(r, tr);
          if (live) setFound((f) => ({ ...f, [k]: p }));
        } catch { /* not a passage the translation has */ }
      }
    })();
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return found;
}

// ---------- the slides window ----------

export const CHANNEL = 'selah-slides';
const channel = () => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null);
const WIN = 'noteapp.slides.window';

/** Tells open slides windows that a note's deck was saved. */
export function deckSaved(noteId) {
  const ch = channel();
  ch?.postMessage({ t: 'deck', note: noteId });
  ch?.close();
}

/**
 * Opens the slides window for a note, where it was last (its place and size are remembered). With `otherScreen`, the
 * browser is asked about the screens and the window opens on one that isn't this one.
 */
export async function openSlidesWindow(noteId, { otherScreen = false } = {}) {
  // Selah Desktop opens it itself: full screen on the second monitor when there is one (controls stay here).
  const e = window.selahDesktop?.kind === 'electron' ? window.selahDesktop : null;
  if (e) return e.openSlides(noteId, { otherScreen });
  let place = null;
  try { place = JSON.parse(localStorage.getItem(WIN)); } catch { /* none yet */ }
  if (otherScreen && typeof window.getScreenDetails === 'function') {
    try {
      const d = await window.getScreenDetails();
      const other = d.screens.find((s) => s !== d.currentScreen);
      if (other) place = { x: other.availLeft, y: other.availTop, w: other.availWidth, h: other.availHeight };
    } catch { /* not allowed: open where it was */ }
  }
  const f = place ? `popup,left=${place.x},top=${place.y},width=${place.w},height=${place.h}` : 'popup,width=1280,height=720';
  return window.open(`/#slides/${noteId}`, `selah-slides-${noteId}`, f);
}
export const rememberWindow = () => {
  try { localStorage.setItem(WIN, JSON.stringify({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })); } catch { /* fine */ }
};
export const canPickScreen = () => (window.selahDesktop?.kind === 'electron' ? window.selahDesktop.screenCount() > 1
  : typeof window.getScreenDetails === 'function' && window.screen?.isExtended !== false);

/**
 * Drives a deck: the slide and step on show, the screen blanked or not. Everything it does goes to the slides
 * window; the window's own keys (a clicker aimed at it) come back here. It also tells the server where it is, for
 * the phone remote (`meta`: { mode, title, timer, part }), and the remote's buttons come back as 'noteapp:slides'.
 */
export function useSlideControl(noteId, deck, passages, meta = {}) {
  const slides = useMemo(() => deck?.slides ?? [], [deck]);
  const [at, setAt] = useState({ index: 0, step: 0 });
  const [black, setBlack] = useState(false);
  const [linked, setLinked] = useState(false); // a slides window answered
  const ch = useRef(null);
  const state = useRef(null);
  state.current = { t: 'state', note: noteId, index: at.index, step: at.step, black };

  const steps = useCallback((i) => stepsOf(slides[i], passages, deck), [slides, passages, deck]);
  const next = useCallback(() => setAt(({ index, step }) => (step < steps(index) ? { index, step: step + 1 }
    : index < slides.length - 1 ? { index: index + 1, step: 0 } : { index, step })), [slides, steps]);
  const prev = useCallback(() => setAt(({ index, step }) => (step > 0 ? { index, step: step - 1 }
    : index > 0 ? { index: index - 1, step: steps(index - 1) } : { index, step })), [steps]);
  const go = useCallback((index, step = 0) => setAt({ index: Math.max(0, Math.min(slides.length - 1, index)), step: Math.max(0, Math.min(step, steps(index))) }), [slides, steps]);

  const nav = useRef({ next, prev });
  nav.current = { next, prev };
  useEffect(() => {
    const c = channel();
    ch.current = c;
    if (!c) return undefined;
    c.onmessage = (e) => {
      const m = e.data;
      if (m?.note !== noteId) return;
      if (m.t === 'hello') { setLinked(true); c.postMessage(state.current); }
      else if (m.t === 'nav') { setBlack(false); (m.dir > 0 ? nav.current.next : nav.current.prev)(); }
      else if (m.t === 'black') setBlack((b) => !b);
      else if (m.t === 'bye') setLinked(false);
    };
    c.postMessage({ t: 'controller', note: noteId });
    return () => { c.postMessage({ t: 'released', note: noteId }); c.close(); ch.current = null; };
  }, [noteId]);
  useEffect(() => { ch.current?.postMessage(state.current); }, [at, black, noteId]);

  // The phone remote: where this is (again every 20 s, so a closed window is soon over), and its buttons.
  const metaKey = JSON.stringify(meta);
  const publish = useRef(null);
  publish.current = () => api.slidesLive({ note: noteId, index: at.index, step: at.step, black, count: slides.length, ...meta }).catch(() => {});
  useEffect(() => {
    const t = setTimeout(() => publish.current(), 120);
    return () => clearTimeout(t);
  }, [at, black, metaKey, slides.length]);
  useEffect(() => {
    const beat = setInterval(() => publish.current(), 20_000);
    const onCmd = (e) => {
      const m = e.detail;
      if (m?.slides !== 'cmd' || m.note !== noteId) return;
      if (m.cmd === 'black') setBlack((b) => !b);
      else if (m.cmd === 'next' || m.cmd === 'prev') { setBlack(false); (m.cmd === 'next' ? nav.current.next : nav.current.prev)(); }
    };
    window.addEventListener('noteapp:slides', onCmd);
    return () => {
      clearInterval(beat);
      window.removeEventListener('noteapp:slides', onCmd);
      api.endSlidesLive(noteId);
    };
  }, [noteId]);

  return { slides, at, black, setBlack, next, prev, go, linked, steps };
}
