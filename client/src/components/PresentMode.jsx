import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { bibleConnected, biblePassage } from '../esv.js';
import { findReferences } from '../../../shared/scripture.js';
import { deckKind, newDeck } from '../slides.js';
import { lessonPassage, parseLesson } from '../lesson.js';
import { Presenter } from './SlideShow.jsx';
import { deckSaved } from './SlideView.jsx';

/**
 * Present a plain note: one slide per Heading 1 or 2, with list points shown one at a time. → or a click on
 * the right half moves on, ← or the left half goes back, B blanks the screen, + and − change the text size, Esc ends.
 * A paragraph that is only a Bible reference gets a slide of its own with the passage (ESV, when it's connected).
 * Also: handouts, printed from a note, where highlighted words can become fill-in-the-blanks.
 */

const isEmpty = (el) => !el.textContent.trim() && !el.querySelector('img');

/** "Title: Fear God" at the top of a lesson repeats the note's title. */
const isTitleLine = (el, title) => el.tagName === 'P' && el.textContent.replace(/^\s*title\s*:\s*/i, '').trim().toLowerCase() === (title ?? '').trim().toLowerCase()
  && /^\s*title\s*:/i.test(el.textContent);

/** The reference when a paragraph is nothing but one Bible reference (often a Logos link), else null. */
export function passageOf(el) {
  if (el.tagName !== 'P') return null;
  const text = el.textContent.trim();
  const found = findReferences(text);
  if (found.length !== 1 || !/^[\s.,;:()]*$/.test(text.replace(found[0].text, ''))) return null;
  return found[0].text;
}

/** Candidate passages in a note, for looking up their text before presenting. */
export function notePassages(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return [...new Set([...doc.body.children].map(passageOf).filter(Boolean))].slice(0, 8);
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Bible text ("[1] Guard your steps…", poetry lines and paragraphs) as slide HTML with small verse numbers. */
const passageHtml = (text) => text.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\[(\d+)\]\s*/g, '<sup>$1</sup>').replace(/\n/g, '<br>')}</p>`).join('');

/**
 * Slides from a note's HTML: [{ title, html, steps }], the first one the note's title and anything before its first
 * heading. `passages` maps a reference to its text ({ reference, text, translation }).
 */
export function toSlides(title, html, passages = {}) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  // Template placeholders (empty paragraphs and list items) don't belong on a slide.
  doc.querySelectorAll('li').forEach((li) => { if (isEmpty(li)) li.remove(); });
  doc.querySelectorAll('ul, ol').forEach((l) => { if (!l.children.length) l.remove(); });
  doc.querySelectorAll('p').forEach((p) => { if (isEmpty(p)) p.remove(); });
  const slides = [{ title, kicker: true, nodes: [] }];
  for (const node of [...doc.body.children]) {
    const last = slides[slides.length - 1];
    const ref = passageOf(node);
    if (/^H[12]$/.test(node.tagName)) slides.push({ title: node.textContent.trim(), nodes: [] });
    else if (last.kicker && isTitleLine(node, title)) continue;
    else if (ref && passages[ref]) {
      // The passage on its own slide, then the rest of the section (if any) carries on under its heading.
      slides.push({ title: passages[ref].reference, passage: true, nodes: [], html: passageHtml(passages[ref].text) });
      slides.push({ title: last.kicker ? '' : last.title, cont: true, nodes: [] });
    } else last.nodes.push(node);
  }
  return slides
    .filter((s, i) => i === 0 || s.passage || (s.cont ? s.nodes.length : s.title || s.nodes.length))
    .map((s) => {
      if (s.passage) return { title: s.title, passage: true, html: s.html, steps: 0 };
      const box = doc.createElement('div');
      s.nodes.forEach((n) => box.append(n));
      // Each top-level list item is a step.
      let step = 0;
      box.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach((li) => { li.dataset.step = String(++step); });
      return { title: s.title, kicker: !!s.kicker, html: box.innerHTML, steps: step };
    });
}

/** Marks each step past, current or still to come. */
const stepHtml = (html, at) => html.replace(/data-step="(\d+)"/g, (m, n) => `${m} class="${Number(n) > at ? 'is-hidden' : Number(n) === at ? 'is-current' : 'is-past'}"`);

function Present({ note, close }) {
  const [passages, setPassages] = useState({});
  const slides = useMemo(() => toSlides(note.title || 'Untitled', note.html, passages), [note, passages]);
  const [at, setAt] = useState({ slide: 0, step: 0 });
  const [black, setBlack] = useState(false);
  const [size, setSize] = useState(1);
  const [chrome, setChrome] = useState(true);
  const ref = useRef(null);
  const slideRef = useRef(null);
  const timer = useRef(null);
  const fits = useRef({});

  // The text of passages the lesson reads, in the favorite translation when one is connected (otherwise they stay as they are).
  useEffect(() => {
    let live = true;
    (async () => {
      const refs = notePassages(note.html);
      if (!refs.length || !(await bibleConnected())) return;
      const found = {};
      for (const r of refs) {
        try { found[r] = await biblePassage(r); } catch { /* not a passage the translation has */ }
      }
      if (live && Object.keys(found).length) setPassages(found);
    })();
    return () => { live = false; };
  }, [note]);

  const next = useCallback(() => setAt(({ slide, step }) => (step < slides[slide].steps ? { slide, step: step + 1 }
    : slide < slides.length - 1 ? { slide: slide + 1, step: 0 } : { slide, step })), [slides]);
  const prev = useCallback(() => setAt(({ slide, step }) => (step > 0 ? { slide, step: step - 1 }
    : slide > 0 ? { slide: slide - 1, step: slides[slide - 1].steps } : { slide, step })), [slides]);

  // Full screen once, for the whole presentation: leaving it ends the presentation.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    ref.current?.requestFullscreen?.().catch(() => {});
    const onFs = () => { if (!document.fullscreenElement) closeRef.current(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); setBlack(false); next(); }
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); setBlack(false); prev(); }
      else if (e.key === 'b' || e.key === 'B' || e.key === '.') setBlack((b) => !b);
      else if (e.key === '+' || e.key === '=') setSize((z) => Math.min(1.8, z + 0.1));
      else if (e.key === '-') setSize((z) => Math.max(0.6, z - 0.1));
      else if (e.key === 'Home') setAt({ slide: 0, step: 0 });
      else if (e.key === 'End') setAt({ slide: slides.length - 1, step: slides[slides.length - 1].steps });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, slides]);

  // The controls fade out while you present and come back when the pointer moves.
  const wake = () => {
    setChrome(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setChrome(false), 2500);
  };
  useEffect(() => { wake(); return () => clearTimeout(timer.current); }, []);

  const s = slides[at.slide] ?? slides[slides.length - 1];
  // Steps still to come are hidden; the newest one is highlighted; earlier ones fold away their sub-points.
  const html = stepHtml(s.html, at.step);

  // Long slides shrink to fit. One size for the whole slide (the step that needs the most room sets it), so the
  // text doesn't change size as points come in.
  useLayoutEffect(() => {
    const el = slideRef.current;
    if (!el) return;
    const key = `${at.slide}:${size}:${slides.length}`;
    const body = el.querySelector('.present-body');
    if (fits.current[key] == null) {
      let fit = 1;
      const steps = [...body.querySelectorAll('[data-step]')];
      const tryStep = (n) => steps.forEach((li) => { li.className = Number(li.dataset.step) > n ? 'is-hidden' : Number(li.dataset.step) === n ? 'is-current' : 'is-past'; });
      for (let n = 0; n <= s.steps; n += 1) {
        tryStep(n);
        while (fit > 0.5) {
          el.style.setProperty('--present-fit', fit);
          if (el.scrollHeight <= el.clientHeight + 1) break;
          fit = Math.round((fit - 0.05) * 100) / 100;
        }
      }
      tryStep(at.step);
      fits.current[key] = fit;
    }
    el.style.setProperty('--present-fit', fits.current[key]);
    // Still too long at the smallest size: keep the newest point in view.
    body.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  });
  const onClick = (e) => {
    if (e.target.closest('.present-bar')) return;
    setBlack(false);
    if (e.clientX > window.innerWidth / 3) next(); else prev();
  };

  return (
    <div ref={ref} className={`present ${chrome ? '' : 'is-quiet'}`} onClick={onClick} onMouseMove={wake} style={{ '--present-scale': size }}>
      {black ? <div className="present-black" /> : (
        <div ref={slideRef} className={`present-slide ${s.kicker ? 'is-title' : ''} ${s.passage ? 'is-passage' : ''}`} key={at.slide}>
          {s.title && <h1>{s.title}</h1>}
          {/* The note's own content, cleaned for the slide. */}
          <div className="present-body" dangerouslySetInnerHTML={{ __html: html }} />
          {s.passage && <p className="present-credit">{passages[s.passage]?.translation ?? 'ESV'}</p>}
        </div>
      )}
      <div className="present-bar" role="toolbar" aria-label="Presentation">
        <button type="button" onClick={prev} aria-label="Back"><Icon name="chevronLeft" size={18} /></button>
        <span>{at.slide + 1} / {slides.length}</span>
        <button type="button" onClick={next} aria-label="Next"><Icon name="chevronRight" size={18} /></button>
        <span className="present-sep" />
        <button type="button" onClick={() => setSize((z) => Math.max(0.6, z - 0.1))} aria-label="Smaller text">A−</button>
        <button type="button" onClick={() => setSize((z) => Math.min(1.8, z + 0.1))} aria-label="Larger text">A+</button>
        <button type="button" onClick={() => setBlack((b) => !b)} title="Blank the screen (B)">Blank</button>
        <button type="button" onClick={() => close()} aria-label="End the presentation"><Icon name="x" size={18} /></button>
      </div>
    </div>
  );
}

/** What a lesson or sermon's new deck starts from: the note, with the sermon's or the session's passage. */
export async function deckSource(note, sermon) {
  if (sermon) return { title: note.title, html: note.html, passage: sermon.passage ?? '' };
  const l = await api.lesson(note.id).catch(() => null);
  return { title: note.title, html: note.html, passage: lessonPassage({ ref: l?.item?.ref, model: parseLesson(note.html), title: note.title }) };
}

/** A lesson or sermon's deck, made from its outline the first time; null for a plain note. */
export async function ensureDeck(note) {
  const [sermon, found] = await Promise.all([api.noteSermon(note.id).catch(() => null), api.slides(note.id)]);
  if (found.deck) return found.deck;
  const kind = deckKind(note.html, { sermon });
  if (!kind) return null;
  const deck = newDeck(kind, await deckSource(note, sermon));
  await api.saveSlides(note.id, deck);
  deckSaved(note.id);
  return deck;
}

/** Presents a note: a lesson or sermon from its slides (with the presenter view), any other note the old way. */
export async function presentNote(dialog, noteId) {
  try {
    const note = await api.getNote(noteId);
    const deck = await ensureDeck(note);
    if (deck?.slides?.length) await dialog.open((close) => <Presenter note={note} deck={deck} close={close} />, { dismissable: false });
    else await dialog.open((close) => <Present note={note} close={close} />);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

// ---------- handouts ----------

const isQuestion = (li) => !li.querySelector('ul, ol') && /\?\s*$/.test(li.textContent);

/** The note's top-level sections (its Heading 1s, or Heading 2s when it has no Heading 1), for picking what prints. */
export function handoutSections(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const top = doc.body.querySelector(':scope > h1') ? 'H1' : 'H2';
  return [...doc.body.children].filter((el) => el.tagName === top).map((el) => el.textContent.trim());
}

function handoutHtml(note, { blanks, answers, lines, space, mainPoints, skip = [] }) {
  const doc = new DOMParser().parseFromString(`<body>${note.html}</body>`, 'text/html');
  // An outline's main points only: the points under them are for the class to fill in.
  if (mainPoints) doc.querySelectorAll('li > ol, li > ul').forEach((l) => l.remove());
  doc.querySelectorAll('li').forEach((li) => { if (isEmpty(li)) li.remove(); });
  doc.querySelectorAll('p').forEach((p) => { if (isEmpty(p)) p.remove(); });
  doc.querySelectorAll('ul, ol').forEach((l) => { if (!l.children.length) l.remove(); });
  const first = doc.body.firstElementChild;
  if (first && isTitleLine(first, note.title)) first.remove();
  const top = doc.body.querySelector(':scope > h1') ? 'H1' : 'H2';
  // Sections left out, heading and all, up to the next heading at that level.
  let cutting = false;
  for (const el of [...doc.body.children]) {
    if (el.tagName === top) cutting = skip.includes(el.textContent.trim());
    if (cutting) el.remove();
  }
  if (blanks) {
    doc.querySelectorAll('mark').forEach((m) => {
      const span = doc.createElement('span');
      span.className = answers ? 'handout-answer' : 'handout-blank';
      span.textContent = answers ? m.textContent : ' '.repeat(Math.max(8, Math.round(m.textContent.length * 1.6)));
      m.replaceWith(span);
    });
  }
  if (space) {
    doc.querySelectorAll('li').forEach((li) => {
      if (!isQuestion(li)) return;
      const box = doc.createElement('div');
      box.className = 'handout-lines is-answer';
      li.append(box);
    });
  }
  if (lines) {
    doc.querySelectorAll(top.toLowerCase()).forEach((h) => {
      // Lines for notes at the end of each section (before the next heading at the top level).
      let end = h.nextElementSibling;
      while (end && end.tagName !== top) end = end.nextElementSibling;
      const box = doc.createElement('div');
      box.className = 'handout-lines';
      if (end) end.before(box); else doc.body.append(box);
    });
  }
  // The handout's title is the only Heading 1: the note's own headings step down a level.
  if (top === 'H1') {
    doc.querySelectorAll('h1, h2, h3, h4, h5').forEach((h) => {
      const d = doc.createElement(`h${Number(h.tagName[1]) + 1}`);
      d.append(...h.childNodes);
      h.replaceWith(d);
    });
  }
  return `<h1>${esc(note.title || 'Untitled')}</h1>${doc.body.innerHTML}`;
}

function HandoutDialog({ note, close, preset = {} }) {
  const hasMarks = /<mark\b/.test(note.html);
  const sections = useMemo(() => handoutSections(note.html), [note]);
  const hasQuestions = useMemo(() => [...new DOMParser().parseFromString(note.html, 'text/html').querySelectorAll('li')].some(isQuestion), [note]);
  const [blanks, setBlanks] = useState(hasMarks);
  const [answers, setAnswers] = useState(false);
  const [lines, setLines] = useState(true);
  const [space, setSpace] = useState(hasQuestions);
  const [skip, setSkip] = useState([]);
  const hasSubPoints = useMemo(() => /<li\b[^>]*>(?:(?!<\/li>)[\s\S])*?<(ol|ul)\b/i.test(note.html), [note]);
  const [mainPoints, setMainPoints] = useState(!!preset.mainPoints && hasSubPoints);
  const print = () => {
    const box = document.createElement('div');
    box.id = 'handout-print';
    box.className = 'handout';
    box.innerHTML = handoutHtml(note, { blanks, answers, lines, space, mainPoints, skip });
    document.body.append(box);
    document.body.classList.add('printing-handout');
    const done = () => { document.body.classList.remove('printing-handout'); box.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    close();
    setTimeout(() => window.print(), 50);
  };
  return (
    <div className="handout-dialog">
      <div className="dialog-header">
        <h2>Print a handout</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">“{note.title || 'Untitled'}”, printed clean: no empty template lines.</p>
      {sections.length > 1 && (
        <fieldset className="handout-sections">
          <legend>Sections to print</legend>
          {sections.map((t) => (
            <label key={t}><input type="checkbox" checked={!skip.includes(t)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== t) : [...skip, t])} /> {t}</label>
          ))}
        </fieldset>
      )}
      <label className="check-row"><input type="checkbox" checked={blanks} onChange={(e) => setBlanks(e.target.checked)} disabled={!hasMarks} />
        <span><strong>Fill in the blanks</strong><span className="muted">{hasMarks ? 'Highlighted words become blanks to fill in.' : 'Highlight words in the note to turn them into blanks.'}</span></span></label>
      <label className="check-row"><input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} disabled={!blanks} />
        <span><strong>Leader’s copy</strong><span className="muted">Show the answers, underlined, instead of blanks.</span></span></label>
      {hasQuestions && (
        <label className="check-row"><input type="checkbox" checked={space} onChange={(e) => setSpace(e.target.checked)} />
          <span><strong>Room to answer each question</strong><span className="muted">A few lines under every list item that ends in a question mark.</span></span></label>
      )}
      {hasSubPoints && (
        <label className="check-row"><input type="checkbox" checked={mainPoints} onChange={(e) => setMainPoints(e.target.checked)} />
          <span><strong>Main points only</strong><span className="muted">Leave off the points under each one, for the class to fill in.</span></span></label>
      )}
      <label className="check-row"><input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} />
        <span><strong>Room for notes</strong><span className="muted">A few lines after each section.</span></span></label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={print} disabled={skip.length === sections.length && sections.length > 0}><Icon name="file" size={15} /> Print</button>
      </div>
    </div>
  );
}

/** Opens the handout options for a note, then prints it. */
export async function printHandout(dialog, noteId, preset) {
  try {
    const note = await api.getNote(noteId);
    await dialog.open((close) => <HandoutDialog note={note} close={close} preset={preset} />);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}
