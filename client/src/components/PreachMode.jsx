import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { bibleConnected, biblePassage, creditHtml, passageCardHtml } from '../esv.js';
import { findReferences } from '../../../shared/scripture.js';
import { LogPreachingDialog } from './SermonDialogs.jsx';
import { deliveryHtml, isSermonHtml } from '../sermonBoard.js';
import { SlideStrip } from './SlideShow.jsx';
import { PARTS, firstSentence, parseLesson, section as lessonSection } from '../lesson.js';
import { ReflectionDialog } from './CourseDialogs.jsx';
import { exportManuscript } from './ManuscriptExport.jsx';

/**
 * Preaching mode: a note read-only, in large type, for the pulpit. Headings fold (tap one), Bible references show
 * their text in place (tap one), and the bar keeps a timer against the planned length and the time of day. The
 * screen stays awake. Leaving after the timer ran offers to log the sermon as preached. A sermon whose blocks are
 * numbered on the Arrange board reads in that delivery order, and its elements can be color-coded. A note with slides
 * gets the slide bar along the bottom, which moves the slides window as you move through the note.
 *
 * Teach mode is the same screen for a lesson: the class length is the goal, a bar of the lesson's four steps (Hook,
 * Book, Look, Took) shows the minutes planned for each and the time spent in the one you're in (the one your place
 * in the note is in), and says when a step runs long. Discussion questions can be ticked off as you ask them, with
 * the lines under each marked as your answers. Leaving offers to mark the lesson taught, with after-class notes.
 */

/** A question's own text (not the answers under it). */
const questionText = (li) => {
  const copy = li.cloneNode(true);
  copy.querySelectorAll('.pm-slide-pin, ol, ul, div').forEach((x) => x.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
};
const isEmpty = (el) => !el.textContent.trim() && !el.querySelector('img');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The note's HTML laid out for preaching: folding sections, tappable references, no live links. */
export function preachHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;
  body.querySelectorAll('li').forEach((li) => { if (isEmpty(li)) li.remove(); });
  body.querySelectorAll('ul, ol').forEach((l) => { if (!l.children.length) l.remove(); });
  body.querySelectorAll('p').forEach((p) => { if (isEmpty(p)) p.remove(); });
  // Links that are Bible references become references; other links stay text (nothing leaves the page mid-sermon).
  body.querySelectorAll('a').forEach((a) => {
    const text = a.textContent.trim();
    const found = findReferences(text);
    const span = doc.createElement('span');
    span.append(...a.childNodes);
    if (found.length === 1 && found[0].text.length >= text.length - 2) {
      span.className = 'pm-ref';
      span.dataset.ref = found[0].text;
      span.setAttribute('role', 'button');
      span.tabIndex = 0;
    }
    a.replaceWith(span);
  });
  // References typed as plain text.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('.pm-ref, code, pre')) texts.push(walker.currentNode);
  for (const node of texts) {
    const found = findReferences(node.textContent);
    if (!found.length) continue;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(node.textContent.slice(at, f.from));
      const span = doc.createElement('span');
      span.className = 'pm-ref';
      span.dataset.ref = f.text;
      span.setAttribute('role', 'button');
      span.tabIndex = 0;
      span.textContent = f.text;
      frag.append(span);
      at = f.to;
    }
    frag.append(node.textContent.slice(at));
    node.replaceWith(frag);
  }
  // Each Heading 1 and 2 folds what follows it, up to the next heading at its level or above.
  const out = doc.createElement('div');
  const stack = [{ level: 0, el: out }];
  for (const node of [...body.childNodes]) {
    const m = node.nodeType === 1 && /^H([12])$/.exec(node.tagName);
    if (m) {
      const level = Number(m[1]);
      while (stack[stack.length - 1].level >= level) stack.pop();
      const sec = doc.createElement('section');
      sec.className = `pm-sec pm-l${level}`;
      node.classList.add('pm-head');
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      const inner = doc.createElement('div');
      inner.className = 'pm-sec-body';
      sec.append(node, inner);
      stack[stack.length - 1].el.append(sec);
      stack.push({ level, el: inner });
    } else {
      stack[stack.length - 1].el.append(node);
    }
  }
  return out.innerHTML;
}

const two = (n) => String(n).padStart(2, '0');
const clockText = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};
const timeOfDay = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const pref = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`noteapp.preach.${key}`)) ?? fallback; } catch { return fallback; } };
const setPref = (key, v) => { try { localStorage.setItem(`noteapp.preach.${key}`, JSON.stringify(v)); } catch { /* private window */ } };

function Preach({ note, sermon, deck, teach, dialog, close }) {
  const isSermon = useMemo(() => isSermonHtml(note.html), [note]);
  // Explanation, Illustration, Argumentation and Application each in their own color, with their names.
  const [colors, setColors] = useState(() => pref('colors', false));
  // Outline also turns each numbered division into a numbered list (Manuscript keeps its paragraphs).
  const [outlineView, setOutlineView] = useState(() => pref('outline', false));
  const html = useMemo(() => preachHtml(isSermon ? deliveryHtml(note.html, { color: colors, list: outlineView }) : note.html), [note, isSermon, colors, outlineView]);
  const passage = sermon?.passage || '';
  // The goal starts from the sermon's planned minutes; setting it here updates them (or is kept per note).
  const [goal, setGoalState] = useState(() => pref(`goal.${note.id}`, null) ?? (teach ? Number(teach.study?.classMinutes) || null : Number(sermon?.data?.minutes) || null));
  const [goalOpen, setGoalOpen] = useState(false);
  const goalOpenRef = useRef(false);
  goalOpenRef.current = goalOpen;
  const setGoal = (m) => {
    const v = Number(m) > 0 ? Math.min(240, Math.round(Number(m))) : null;
    setGoalState(v);
    setGoalOpen(false);
    setPref(`goal.${note.id}`, v);
    if (sermon?.id) api.updateSermon(sermon.id, { data: { minutes: v } }).catch(() => {});
  };
  const [size, setSize] = useState(() => pref('size', 1.25));
  const [dark, setDark] = useState(() => pref('dark', true));
  // Outline: numbered divisions as numbered lists; everything else in full, as in Manuscript.
  // The timer survives closing by accident: kept per note until the sermon is logged or the timer reset.
  const [timer, setTimer] = useState(() => pref(`timer.${note.id}`, { start: null, acc: 0 }));
  const [now, setNow] = useState(Date.now());
  const [outline, setOutline] = useState(false);
  const bodyRef = useRef(null);
  const contentRef = useRef(null);
  const ref = useRef(null);
  const hasSlides = deck?.slides?.length > 0;
  // Teach mode: the step you're in, the time spent in each, the questions asked.
  const plan = teach?.item?.data?.minutes ?? {};
  const [part, setPart] = useState(null);
  const [spent, setSpent] = useState(() => (teach ? pref(`spent.${note.id}`, {}) : {}));
  const [asked, setAsked] = useState(() => new Set(teach ? pref(`asked.${note.id}`, []) : []));
  const [taught, setTaught] = useState(!!teach?.item?.done);
  const tick = useRef(Date.now());

  useEffect(() => { setPref('size', size); }, [size]);
  useEffect(() => { setPref('dark', dark); }, [dark]);
  useEffect(() => { setPref('outline', outlineView); }, [outlineView]);
  useEffect(() => { setPref('colors', colors); }, [colors]);
  useEffect(() => { setPref(`timer.${note.id}`, timer); }, [timer, note.id]);
  useEffect(() => { if (teach) setPref(`spent.${note.id}`, spent); }, [spent, note.id, teach]);
  useEffect(() => { if (teach) setPref(`asked.${note.id}`, [...asked]); }, [asked, note.id, teach]);
  // Each second the timer runs counts toward the step you're in.
  useEffect(() => {
    const t = Date.now();
    const d = t - tick.current;
    tick.current = t;
    if (teach && timer.start && part && d > 0 && d < 5000) setSpent((x) => ({ ...x, [part]: (x[part] ?? 0) + d }));
  }, [now]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the screen on, and take the whole screen where the browser allows it.
  useEffect(() => {
    let lock = null;
    const take = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {}); };
    take();
    document.addEventListener('visibilitychange', take);
    // The whole page, not this element: dialogs opened from here (logging it) must show above it.
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      document.removeEventListener('visibilitychange', take);
      lock?.release().catch(() => {});
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  const elapsed = timer.acc + (timer.start ? now - timer.start : 0);
  const running = !!timer.start;
  const toggleTimer = useCallback(() => setTimer((t) => (t.start ? { start: null, acc: t.acc + Date.now() - t.start } : { start: Date.now(), acc: t.acc })), []);
  const resetTimer = () => { setTimer({ start: null, acc: 0 }); setSpent({}); };
  // With a goal the timer counts down: yellow under 5 minutes, orange under 1, red at 0 (then it counts the time over).
  const left = goal ? goal * 60_000 - elapsed : null;
  const timeState = left == null ? '' : left <= 0 ? 'is-over' : left < 60_000 ? 'is-last' : left < 5 * 60_000 ? 'is-near' : '';

  /** Teach mode: marks the lesson's session taught, and offers after-class notes. False when you went back. */
  const markTaught = useCallback(async (leaving) => {
    const item = teach?.item;
    if (!item || taught) return true;
    const choice = await dialog.choose({
      title: 'Mark the lesson taught?',
      message: `${item.week ? `Week ${item.week}: ` : ''}${note.title || item.title}`,
      options: [{ value: 'notes', label: 'Mark it taught and add after-class notes' }, { value: 'taught', label: 'Mark it taught' }, { value: 'no', label: leaving ? 'Not yet, just leave' : 'Not yet' }],
      okLabel: 'OK',
    });
    if (!choice) return false;
    if (choice === 'no') return true;
    try {
      await api.updateStudyItem(item.id, { done: true });
      setTaught(true);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      if (choice === 'notes') {
        const took = firstSentence(lessonSection(parseLesson(note.html), 'took')?.field?.text ?? '');
        await dialog.open((c) => <ReflectionDialog week={{ id: item.id, week: item.week, title: item.title, ref: item.ref, lesson: { title: note.title, took }, reflection: item.reflection }} close={c} />);
      }
      dialog.toast('Marked taught');
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    return true;
  }, [teach, taught, dialog, note]);

  const finish = useCallback(async () => {
    const ran = timer.acc + (timer.start ? Date.now() - timer.start : 0);
    if (teach) {
      if (!(await markTaught(true))) return;
      try { ['timer', 'spent', 'asked'].forEach((k) => localStorage.removeItem(`noteapp.preach.${k}.${note.id}`)); } catch { /* fine */ }
      close();
      return;
    }
    if (ran >= 60_000) {
      const logged = await dialog.open((c) => <LogPreachingDialog noteId={note.id} title={note.title} minutes={Math.round(ran / 60_000)} close={c} fromPreaching />);
      if (logged === undefined || logged === null) return; // back to preaching
      if (logged) dialog.toast('Logged as preached');
    }
    try { localStorage.removeItem(`noteapp.preach.timer.${note.id}`); } catch { /* fine */ }
    close();
  }, [timer, dialog, note, close, teach, markTaught]);

  // Teach mode: the step your place is in (the last step heading above the top third of the screen).
  useEffect(() => {
    if (!teach) return undefined;
    const keyOf = (h) => PARTS.find((x) => x.match.test(h.textContent.trim()))?.key ?? null;
    const find = () => {
      const heads = [...(bodyRef.current?.querySelectorAll('.pm-l1 > h1') ?? [])];
      const line = window.innerHeight * 0.33;
      let k = null;
      for (const h of heads) {
        const key = keyOf(h);
        if (!key) continue;
        if (!k) k = key; // before the first step: its first step
        if (h.getBoundingClientRect().top <= line) k = key;
      }
      setPart(k);
    };
    find();
    const el = bodyRef.current;
    el?.addEventListener('scroll', find, { passive: true });
    return () => el?.removeEventListener('scroll', find);
  }, [teach, html]);
  // Teach mode: the Look's questions can be ticked off; the lines under each are your answers.
  useEffect(() => {
    if (!teach) return;
    const look = [...(bodyRef.current?.querySelectorAll('.pm-l1') ?? [])].find((sec) => PARTS[2].match.test(sec.querySelector(':scope > h1')?.textContent ?? ''));
    const list = look?.querySelector(':scope > .pm-sec-body > ol, :scope > .pm-sec-body > ul');
    if (!list) return;
    for (const li of list.children) {
      li.classList.add('pm-question');
      li.classList.toggle('is-asked', asked.has(questionText(li)));
      li.querySelectorAll(':scope > ol, :scope > ul').forEach((x) => x.classList.add('pm-answers'));
    }
  }, [teach, html, asked]);

  // Taps: a heading folds its section, a reference shows (or hides) its text under the line it's in.
  const onClick = async (e) => {
    const head = e.target.closest('.pm-head');
    if (head) { head.parentElement.classList.toggle('is-folded'); return; }
    const r = e.target.closest('.pm-ref');
    const q = !r && e.target.closest('.pm-question');
    if (q && !e.target.closest('.pm-answers')) {
      const k = questionText(q);
      setAsked((a) => { const n = new Set(a); if (n.has(k)) n.delete(k); else n.add(k); return n; });
      return;
    }
    if (!r) return;
    const host = r.closest('li') ?? r.closest('p, blockquote, h3, h4, h5, h6') ?? r;
    const open = host.querySelector(`:scope > .pm-verse[data-for="${CSS.escape(r.dataset.ref)}"]`) ?? (host.nextElementSibling?.matches?.(`.pm-verse[data-for="${CSS.escape(r.dataset.ref)}"]`) ? host.nextElementSibling : null);
    if (open) { open.remove(); r.classList.remove('is-open'); return; }
    const box = document.createElement('div');
    box.className = 'pm-verse';
    box.dataset.for = r.dataset.ref;
    box.innerHTML = `<p class="pm-verse-head">${esc(r.dataset.ref)}</p><p class="muted">Loading…</p>`;
    if (host.tagName === 'LI') host.append(box); else host.after(box);
    r.classList.add('is-open');
    if (!(await bibleConnected())) {
      box.innerHTML = `<p class="pm-verse-head">${esc(r.dataset.ref)}</p><p class="muted">Connect a Bible in Settings to see verse text here.</p>`;
      return;
    }
    try {
      const p = await biblePassage(r.dataset.ref);
      box.innerHTML = `<p class="pm-verse-head">${esc(p.reference)} <span>${creditHtml(p)}</span></p>${passageCardHtml(p.text)}`;
    } catch (err) {
      box.innerHTML = `<p class="pm-verse-head">${esc(r.dataset.ref)}</p><p class="muted">${esc(err.message)}</p>`;
    }
  };
  const onKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.pm-head, .pm-ref')) { e.preventDefault(); onClick(e); }
  };

  const foldAll = (fold) => bodyRef.current?.querySelectorAll('.pm-sec').forEach((s) => s.classList.toggle('is-folded', fold));
  const headings = useMemo(() => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.pm-l1 > h1')].map((h) => h.textContent.trim()), [html]);
  const jump = (i) => {
    const h = bodyRef.current?.querySelectorAll('.pm-l1 > h1')[i];
    if (h) { h.parentElement.classList.remove('is-folded'); h.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    setOutline(false);
  };

  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const onKey = (e) => {
      // Only while preaching mode is the top layer (not under the log dialog).
      const all = document.querySelectorAll('.modal-backdrop');
      if (!all[all.length - 1]?.querySelector('.preach')) return;
      if (e.key === 'Escape' && goalOpenRef.current) { e.preventDefault(); setGoalOpen(false); } else if (e.key === 'Escape') { e.preventDefault(); finishRef.current(); } else if (e.target.closest?.('input, textarea')) return;
      else if (e.key === 't' || e.key === 'T') toggleTimer();
      else if (e.key === '+' || e.key === '=') setSize((z) => Math.min(2.4, Math.round((z + 0.1) * 10) / 10));
      else if (e.key === '-') setSize((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleTimer]);

  return (
    <div ref={ref} className={`preach ${dark ? 'is-dark' : ''} ${outlineView ? 'is-outline' : ''} ${hasSlides ? 'has-slides' : ''} ${teach ? 'is-teach' : ''}`} style={{ '--preach-size': size }}>
      <div className="pm-bar" role="toolbar" aria-label={teach ? 'Teaching' : 'Preaching'}>
        <div className="pm-bar-title">
          <strong>{note.title || 'Untitled'}</strong>
          {(passage || teach) && <span>{teach ? [teach.item?.ref, teach.study?.title].filter(Boolean).join(' · ') || 'Teaching' : passage}</span>}
        </div>
        <div className={`pm-timer ${timeState} ${running ? 'is-running' : ''}`}>
          <button type="button" className="pm-timer-btn" onClick={toggleTimer} aria-label={running ? 'Pause the timer (T)' : 'Start the timer (T)'} title={running ? 'Pause (T)' : 'Start (T)'}>
            <Icon name={running ? 'pause' : 'play'} size={16} />
            <span className="pm-time">{left == null ? clockText(elapsed) : left > 0 ? clockText(Math.ceil(left / 1000) * 1000) : `+${clockText(-left)}`}</span>
          </button>
          <div className="pm-goal-wrap">
            <button type="button" className="pm-target" onClick={() => setGoalOpen(!goalOpen)} aria-expanded={goalOpen} title="Set a goal time">
              {goal ? <>Goal {goal} min{elapsed > 0 && <> · {clockText(elapsed)} in</>}</> : 'Set a goal'}
            </button>
            {goalOpen && (
              <form className="pm-goal" onSubmit={(e) => { e.preventDefault(); setGoal(new FormData(e.currentTarget).get('m')); }}>
                <label>Goal time
                  <span><input name="m" className="input" type="number" min="1" max="240" defaultValue={goal ?? ''} placeholder="30" autoFocus aria-label="Goal in minutes" /> min</span>
                </label>
                <div className="pm-goal-presets">
                  {[20, 25, 30, 35, 40, 45].map((m) => <button key={m} type="button" className={m === goal ? 'is-active' : ''} onClick={() => setGoal(m)}>{m}</button>)}
                </div>
                <div className="pm-goal-actions">
                  {goal && <button type="button" className="pm-link" onClick={() => setGoal(null)}>No goal</button>}
                  <button type="submit" className="pm-link pm-link-strong">Set</button>
                </div>
              </form>
            )}
          </div>
          {(elapsed > 0) && !running && <button type="button" className="pm-icon" onClick={resetTimer} aria-label="Reset the timer" title="Reset"><Icon name="restore" size={15} /></button>}
        </div>
        <span className="pm-clock" aria-label="Time of day">{timeOfDay()}</span>
        <div className="pm-tools">
          {headings.length > 1 && (
            <div className="pm-outline-wrap">
              <button type="button" className="pm-icon" onClick={() => setOutline(!outline)} aria-expanded={outline} aria-label="Outline" title="Outline"><Icon name="list" size={17} /></button>
              {outline && (
                <ol className="pm-outline">
                  {headings.map((h, i) => <li key={i}><button type="button" onClick={() => jump(i)}>{h}</button></li>)}
                  <li className="pm-outline-sep"><button type="button" onClick={() => { foldAll(true); setOutline(false); }}>Fold everything</button></li>
                  <li><button type="button" onClick={() => { foldAll(false); setOutline(false); }}>Unfold everything</button></li>
                </ol>
              )}
            </div>
          )}
          <div className="pm-seg" role="group" aria-label="Show">
            <button type="button" className={outlineView ? '' : 'is-active'} aria-pressed={!outlineView} onClick={() => setOutlineView(false)}>Manuscript</button>
            <button type="button" className={outlineView ? 'is-active' : ''} aria-pressed={outlineView} onClick={() => setOutlineView(true)}>Outline</button>
          </div>
          {isSermon && (
            <button type="button" className={`pm-icon ${colors ? 'is-on' : ''}`} onClick={() => setColors(!colors)} aria-pressed={colors}
              aria-label="Color-code the elements" title={colors ? 'Plain text' : 'Color-code Explanation, Illustration, Argumentation, Application'}><Icon name="highlight" size={16} /></button>
          )}
          <button type="button" className="pm-icon" onClick={() => setSize((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10))} aria-label="Smaller text">A−</button>
          <button type="button" className="pm-icon" onClick={() => setSize((z) => Math.min(2.4, Math.round((z + 0.1) * 10) / 10))} aria-label="Larger text">A+</button>
          <button type="button" className="pm-icon" onClick={() => exportManuscript(dialog, note.id, { note, view: { outline: outlineView, colors } })}
            aria-label="Export the manuscript" title="Export the manuscript (PDF, Word, rich text)"><Icon name="download" size={16} /></button>
          <button type="button" className="pm-icon" onClick={() => setDark(!dark)} aria-label={dark ? 'Light page' : 'Dark page'} title={dark ? 'Light page' : 'Dark page'}><Icon name={dark ? 'sun' : 'eye'} size={16} /></button>
          {teach ? (teach.item && (
            <button type="button" className={`pm-icon ${taught ? 'is-on' : ''}`} onClick={() => markTaught(false)} disabled={taught}
              aria-label={taught ? 'Taught' : 'Mark taught'} title={taught ? 'Marked taught' : 'Mark taught'}><Icon name="checkCircle" size={16} /></button>
          )) : (
            <button type="button" className="pm-icon" onClick={async () => {
              const logged = await dialog.open((c) => <LogPreachingDialog noteId={note.id} title={note.title} minutes={elapsed >= 60_000 ? Math.round(elapsed / 60_000) : null} close={c} />);
              if (logged) dialog.toast('Logged as preached');
            }} aria-label="Log as preached" title="Log as preached"><Icon name="checkCircle" size={16} /></button>
          )}
          <button type="button" className="pm-icon" onClick={finish} aria-label={teach ? 'Leave teach mode (Esc)' : 'Leave preaching mode (Esc)'} title="Leave (Esc)"><Icon name="x" size={18} /></button>
        </div>
      </div>
      {teach && (
        <div className="pm-steps" role="group" aria-label="The lesson’s steps">
          {PARTS.map((x) => {
            const ms = spent[x.key] ?? 0;
            const planned = plan[x.key];
            const long = planned != null && ms > planned * 60_000;
            return (
              <button key={x.key} type="button" className={`pm-step ${part === x.key ? 'is-current' : ''} ${long ? 'is-long' : ''}`} style={{ flexGrow: planned || 1 }}
                onClick={() => {
                  const h = [...(bodyRef.current?.querySelectorAll('.pm-l1 > h1') ?? [])].find((el) => x.match.test(el.textContent.trim()));
                  if (h) { h.parentElement.classList.remove('is-folded'); h.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
                }}
                title={long ? `${x.label} is running ${Math.ceil((ms - planned * 60_000) / 60_000)} min long` : `${x.label}${planned != null ? `: ${planned} min planned` : ''}`}>
                <strong>{x.label}</strong>
                <span>{clockText(ms)}{planned != null ? ` / ${planned}′` : ''}</span>
                {planned != null && <i className="pm-step-fill" style={{ width: `${Math.min(100, (ms / (planned * 60_000 || 1)) * 100)}%` }} />}
              </button>
            );
          })}
          {part && plan[part] != null && (spent[part] ?? 0) > plan[part] * 60_000 && (
            <span className="pm-step-warn"><Icon name="alert" size={14} /> {PARTS.find((x) => x.key === part).label} is running {Math.ceil(((spent[part] ?? 0) - plan[part] * 60_000) / 60_000)} min long</span>
          )}
        </div>
      )}
      <article className="pm-page" ref={bodyRef} onClick={onClick} onKeyDown={onKeyDown}>
        <h1 className="pm-title">{note.title || 'Untitled'}</h1>
        {/* The note's own content, laid out for preaching. */}
        <div className="pm-content" ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
      </article>
      {hasSlides && (
        <SlideStrip noteId={note.id} deck={deck} root={contentRef} version={html}
          meta={{ mode: teach ? 'teach' : 'preach', title: note.title || 'Untitled', timer: { start: timer.start, acc: timer.acc, goal }, part: teach && part ? PARTS.find((x) => x.key === part).label : '' }} />
      )}
    </div>
  );
}

/** Opens a lesson in teach mode (preaching mode with the lesson's steps, questions and Mark taught). */
export async function teachNote(dialog, noteId) {
  try {
    const [note, info, slides] = await Promise.all([api.getNote(noteId), api.lesson(noteId).catch(() => null), api.slides(noteId).catch(() => null)]);
    await dialog.open((close) => <Preach note={note} teach={info ?? {}} deck={slides?.deck} dialog={dialog} close={close} />, { dismissable: false });
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

/** Opens a note in preaching mode. */
export async function preachNote(dialog, noteId) {
  try {
    const [note, sermon, slides] = await Promise.all([api.getNote(noteId), api.noteSermon(noteId).catch(() => null), api.slides(noteId).catch(() => null)]);
    await dialog.open((close) => <Preach note={note} sermon={sermon} deck={slides?.deck} dialog={dialog} close={close} />, { dismissable: false });
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}
