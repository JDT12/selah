import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import FromStudies from './FromStudies.jsx';
import MarkComplete, { useComplete } from './MarkComplete.jsx';
import OutlineEditor from './OutlineEditor.jsx';
import { presentNote, printHandout } from './PresentMode.jsx';
import { exportManuscript } from './ManuscriptExport.jsx';
import { teachNote } from './PreachMode.jsx';
import SlidesEditor from './SlidesEditor.jsx';
import { Area, TextPane } from './StudyBuilder.jsx';
import {
  PARTS, QTYPES, TIMED, estimate, firstSentence, isLessonNote, lessonHtml, lessonPassage, linesText, parseLesson, questionWarnings, section,
  setBigIdea, setLines, setSection, setText, suggestSplit, typeKey, typeOf,
} from '../lesson.js';
import { boxHtml, editField, uid, words } from '../sermon.js';
import RichBox from './RichBox.jsx';
import { builderKeyAnswers, openBuilderPage, useAutosave } from '../builderPages.js';
import { useStoredState } from '../useStoredState.js';
import { chooseMethod } from './MethodPicker.jsx';
import { AIMS, LEVELS, METHODS, guessLevel, levelAdvice, levelCounts, levelOf, methodText, methodsIn, tookLevel } from '../course.js';

/**
 * The lesson builder: a teaching lesson written step by step through Lawrence Richards's Hook, Book, Look, Took
 * (Creative Bible Teaching), with the passage beside you, your studies of it a click away, a timing plan for the
 * class, and last week's and next week's lessons in view. It writes the ordinary lesson note (the user's Introduction
 * (Hook) / Exposition (Book) / Inquisition (Look) / Application (Took) layout) that present mode and handouts use.
 */
/** "2026-10-25" → "Sun, Oct 25". */
const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const STEPS = [
  { key: 'start', phase: 'Start', label: 'Lesson and Passage' },
  ...PARTS.map((p, i) => ({ key: p.key, n: i + 1, label: p.label, phase: i === 0 ? 'Hook, Book, Look, Took' : undefined })),
  { key: 'finish', phase: 'Finish', label: 'Ready to Teach' },
];
const GUIDANCE = {
  hook: {
    question: 'How will you get their attention and raise the need for this passage?',
    paras: [
      'The hook catches the class’s interest, surfaces a need or question the passage answers, and moves them into the Bible. Start with a question, a story, a problem from everyday life, or where last week left off.',
      'Keep it short: its whole job is to get the class into the text with a reason to listen. End it by reading the passage.',
    ],
  },
  book: {
    question: 'What does the passage say, and what did it mean?',
    paras: [
      'Work through the text so the class understands what God said in it and what it meant to its first readers. Follow the passage’s own flow, verse by verse or thought by thought.',
      'Each main point is a statement about the text; the points under it explain, illustrate and support it. Everything should serve the big idea.',
    ],
  },
  look: {
    question: 'What does it mean for us?',
    paras: [
      'Guide the class from the text to its principle and what it implies for life. Let them discover it: good discussion questions move from what the text says, to what it means, to how we live it.',
      'Ask open questions, not yes-or-no ones, and leave room for silence. A few well-chosen questions are better than many.',
    ],
  },
  took: {
    question: 'What will they take home and do?',
    paras: [
      'Help each person respond to the truth personally: a specific step for this week, not a general resolve. Applying God’s Word is the goal of the lesson.',
      'Tie it back to the big idea, and end with something they can remember.',
    ],
  },
};
const HINTS = {
  title: '',
  bigIdea: 'The one truth the whole lesson teaches, in a sentence.',
  hook: 'A question, story or problem that raises the need. The passage is read at the end of the hook.',
  lead: 'Notes that come before the outline (from your study, say).',
  book: 'A statement about the text on each main point; explanation and support as sub-points. Section headings (Heading 2 in the note) can split the outline into parts.',
  look: 'One question per line, from what the text says, to what it means, to how we live it.',
  took: 'A specific response for this week, tied back to the big idea.',
};

/** A field of the note: a text area, or (when it has lists, pictures…) a preview to edit in the note. */
function TextField({ label, f, onChange, hint, placeholder, rows = 4 }) {
  return (
    <div className="sb-part">
      <div className="sb-part-head">
        <strong>{label}</strong>
        {f.text.trim() && <span className="muted">{words(f.text)} words</span>}
      </div>
      {hint && <p className="sb-hint">{hint}</p>}
      {f.rich ? (
        <div className="sb-rich">
          <div className="sb-rich-body" dangerouslySetInnerHTML={{ __html: f.html }} />
          <p className="muted"><Icon name="note" size={13} /> This part has lists or pictures, so edit it in the note.</p>
        </div>
      ) : f.plain ? <Area value={f.text} onChange={onChange} rows={rows} placeholder={placeholder} aria-label={label} />
        : <RichBox html={boxHtml(f)} onChange={onChange} rows={rows} placeholder={placeholder} label={label} />}
    </div>
  );
}

function Guidance({ step }) {
  const [open, setOpen] = useStoredState('noteapp.lb.guide', false);
  const g = GUIDANCE[step];
  if (!g) return null;
  return (
    <div className={`gb-guide ${open ? 'is-open' : ''}`}>
      <button type="button" className="gb-guide-q" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <span>{g.question}</span>
        <span className="muted gb-guide-toggle">{open ? 'Hide guidance' : 'Guidance'}</span>
      </button>
      {open && <div className="gb-guide-body">{g.paras.map((p, i) => <p key={i}>{p}</p>)}</div>}
    </div>
  );
}

/** Minutes planned for a section, beside a rough length for what's written. */
function PlanLine({ k, meta, setMinutes, est }) {
  const v = meta.minutes[k];
  return (
    <p className="lb-plan">
      <Icon name="clock" size={14} />
      <label>Planned <input className="input lb-min" type="number" min="0" max="240" value={v ?? ''} placeholder={String(suggestSplit(meta.classMinutes)[k])}
        onChange={(e) => setMinutes(k, e.target.value)} aria-label="Minutes planned" /> min</label>
      {est[k] > 0 && <span className="muted">· about {est[k]} min from what’s written</span>}
    </p>
  );
}

/** Richards's levels of learning, rote to realization: how many questions, methods and responses work at each. */
function LevelsMeter({ counts, note = true }) {
  const advice = levelAdvice(counts);
  const [shown, setShown] = useState(null);
  const lv = shown && levelOf(shown);
  return (
    <div className="lv-meter">
      <div className="sb-part-head">
        <strong>Levels of Learning</strong>
        <span className="muted">{counts.reached ? `Reaches ${levelOf(counts.reached).label}` : 'Nothing to measure yet'}</span>
      </div>
      <ol className="lv-ladder">
        {LEVELS.map((l) => (
          <li key={l.key} className={`lv-${l.key} ${counts[l.key] ? 'is-on' : ''} ${counts.reached === l.key ? 'is-top' : ''} ${shown === l.key ? 'is-shown' : ''}`}>
            <button type="button" onClick={() => setShown(shown === l.key ? null : l.key)} aria-expanded={shown === l.key} title={`${l.what}. Click for more.`}>
              <span className="lv-bar" />
              <span className="lv-name">{l.label}</span>
              <span className="lv-n">{counts[l.key] || ''}</span>
            </button>
          </li>
        ))}
      </ol>
      {lv && <LevelCard lv={lv} n={counts[lv.key]} onClose={() => setShown(null)} />}
      {advice && <p className="sb-warn"><Icon name="alert" size={14} /> {advice}</p>}
      {note && <p className="sb-hint">Counted from the discussion questions, the teaching methods you’ve added, and the Took. Click a level to see what kind of question works there. The aim is realization: the truth lived out.</p>}
    </div>
  );
}

/** A level of learning in plain words: what it is, how its questions start, and one example. */
function LevelCard({ lv, n, onClose, children }) {
  return (
    <div className={`lv-card lv-${lv.key}`}>
      <div className="lv-card-head">
        <strong>{lv.label}</strong>
        {n != null && <span className="muted">{n ? `${n} in this lesson` : 'Not in this lesson yet'}</span>}
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>}
      </div>
      <p>{lv.explain}</p>
      <p className="lv-card-starts"><span className="muted">Questions start like</span> {lv.starts.map((s) => <em key={s}>{s}</em>)}</p>
      <p className="lv-card-example"><span className="muted">For example</span> “{lv.example}”</p>
      {children}
    </div>
  );
}

/** A question's level: click it to read what the level means and pick another. */
function LevelTag({ level, onPick }) {
  const lv = levelOf(level);
  const [at, setAt] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!at) return;
    const off = (e) => !ref.current?.contains(e.target) && setAt(null);
    // Escape closes just this card, not the lesson builder under it.
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setAt(null); } };
    const close = () => setAt(null);
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);
  const toggle = (e) => {
    if (at) return setAt(null);
    const r = e.currentTarget.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    const below = window.innerHeight - r.bottom > 300;
    setAt({ left: Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)), width: w, ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }) });
  };
  return (
    <span className="lv-tag-wrap" ref={ref}>
      <button type="button" className={`lv-tag lv-${lv.key}`} onClick={toggle} aria-expanded={!!at} title={`Level of learning: ${lv.label}. ${lv.what}.`}>{lv.short}</button>
      {at && (
        <div className="lv-pop" style={{ position: 'fixed', ...at }} role="dialog" aria-label={`Level of learning: ${lv.label}`}>
          <LevelCard lv={lv}>
            <div className="lv-pick" role="group" aria-label="Change the level">
              {LEVELS.map((l) => (
                <button key={l.key} type="button" className={`lv-tag lv-${l.key} ${l.key === lv.key ? 'is-active' : ''}`} title={l.what}
                  onClick={() => { onPick(l.key); if (l.key === lv.key) setAt(null); }}>{l.short}</button>
              ))}
            </div>
          </LevelCard>
        </div>
      )}
    </span>
  );
}

/** Methods for adult classes that suit this step; adding one writes it into the step. */
function Methods({ step, label, text, onAdd }) {
  const [open, setOpen] = useStoredState('noteapp.lb.methods', true);
  const [pick, setPick] = useState(null);
  const list = METHODS.filter((m) => m.step === step);
  const used = methodsIn(text).map((m) => m.key);
  const m = list.find((x) => x.key === pick);
  return (
    <div className={`lb-methods ${open ? 'is-open' : ''}`}>
      <button type="button" className="gb-guide-q" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <span>Teaching Methods</span>
        <span className="muted gb-guide-toggle">{used.length ? `${used.length} in this step` : 'For adult classes'}</span>
      </button>
      {open && (
        <div className="lb-methods-body">
          <div className="lb-method-chips">
            {list.map((x) => (
              <button key={x.key} type="button" className={`lb-method ${pick === x.key ? 'is-open' : ''} ${used.includes(x.key) ? 'is-used' : ''}`} onClick={() => setPick(pick === x.key ? null : x.key)} aria-expanded={pick === x.key}>
                {used.includes(x.key) && <Icon name="check" size={12} />}{x.name}<span className="muted">{x.minutes}′</span>
              </button>
            ))}
          </div>
          {m && (
            <div className="lb-method-card">
              <p className="lb-method-head"><strong>{m.name}</strong><span className="muted">{m.minutes} min</span><span className={`lv-tag lv-${m.level}`} title={levelOf(m.level).what}>{levelOf(m.level).label}</span></p>
              <p>{m.what}</p>
              <button type="button" className="btn btn-small" onClick={() => { onAdd(m); setPick(null); }}><Icon name="plus" size={13} /> Add to the {label}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The course's aims (5.12), for a lesson in a course. */
function CourseAims({ aims, only }) {
  const shown = AIMS.filter((a) => (!only || only.includes(a.key)) && (aims?.[a.key] ?? '').trim());
  if (!shown.length) return null;
  return (
    <div className="lb-week lb-aims">
      <p className="sb-part-head"><strong>Course Aims</strong></p>
      <dl className="course-aim-list">{shown.map((a) => <div key={a.key}><dt>{a.label}</dt><dd>{aims[a.key]}</dd></div>)}</dl>
    </div>
  );
}

const REACHED = { yes: 'yes', partly: 'partly', no: 'not really' };

export default function LessonBuilder({ noteId, close }) {
  const dialog = useDialog();
  const [completeAt, toggleComplete] = useComplete(noteId, (e) => dialog.toast(e.message, 'error'));
  const [info, setInfo] = useState(null); // { item, study, prev, next }
  const [model, setModel] = useState(null);
  const [meta, setMeta] = useState(null); // { title, passage, date, classMinutes, minutes, qtypes }
  const [prevTook, setPrevTook] = useState('');
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useStoredState('noteapp.lb.text', true);
  const [view, setView] = useStoredState('noteapp.lb.view', 'steps');
  const base = useRef(0);
  const orig = useRef({ title: '', passage: '' });
  const addPoint = useRef(null);
  // The levels the lesson reaches, saved with it so the course page can show them.
  const levelsRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const [l, note] = await Promise.all([api.lesson(noteId), api.getNote(noteId)]);
        base.current = note.updated_at;
        const m = parseLesson(note.html);
        orig.current = { title: note.title ?? '', passage: m.passage };
        const lesson = l.item?.data ?? {};
        setInfo(l);
        setModel(m);
        setMeta({
          title: note.title ?? '', passage: lessonPassage({ ref: l.item?.ref, model: m, title: note.title }), date: l.item?.date ?? '',
          classMinutes: l.study?.classMinutes ?? 45, minutes: lesson.minutes ?? {}, qtypes: lesson.qtypes ?? {}, levelOv: lesson.levelOv ?? {},
        });
        setStep(Math.min(STEPS.length - 1, Math.max(0, lesson.step ?? 0)));
        if (l.prev?.note_id) {
          api.getNote(l.prev.note_id).then((p) => setPrevTook(section(parseLesson(p.html), 'took').field.text.trim())).catch(() => {});
        }
      } catch (e) {
        dialog.toast(e.message, 'error');
        close(false);
      }
    })();
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (fn) => { setModel((m) => fn(m)); setDirty(true); };
  const setM = (patch) => { setMeta((m) => ({ ...m, ...patch })); setDirty(true); };
  const setMinutes = (k, v) => setM({ minutes: { ...meta.minutes, [k]: v === '' ? undefined : Math.max(0, Math.min(240, Number(v) || 0)) } });
  const html = useMemo(() => (model && meta ? lessonHtml(model, { title: meta.title, originalTitle: orig.current.title, passage: meta.passage, originalPassage: orig.current.passage }) : ''), [model, meta]);
  // The Slides tab builds from the lesson as it is in the builder, saved or not.
  const slideSource = useMemo(() => ({ title: meta?.title ?? '', html, passage: meta?.passage ?? '' }), [meta?.title, meta?.passage, html]);

  const save = useCallback(async ({ overwrite = false } = {}) => {
    setBusy(true);
    try {
      const body = { html, title: meta.title, base_updated_at: base.current, overwrite, classMinutes: meta.classMinutes };
      if (info.item) Object.assign(body, { ref: meta.passage, date: meta.date || null, lesson: { step, minutes: meta.minutes, qtypes: meta.qtypes, levelOv: meta.levelOv, levels: levelsRef.current } });
      const r = await api.writeLesson(noteId, body);
      base.current = r.updated_at;
      // What was saved is the note now: later saves compare its title and passage against it. (The model isn't read
      // again from the saved note: it saves as you go (10.0), and a box you're typing in mustn't change under you.)
      orig.current = { title: meta.title, passage: parseLesson(html).passage };
      setDirty(false);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      setBusy(false);
      return true;
    } catch (e) {
      setBusy(false);
      if (e.data?.conflict) {
        const ok = await dialog.confirm({ title: 'The lesson changed', message: 'It was edited somewhere else while the builder was open. Save the builder’s version anyway? The other version stays in the note’s version history.', okLabel: 'Save anyway' });
        return ok ? save({ overwrite: true }) : false;
      }
      dialog.toast(e.message, 'error');
      return false;
    }
  }, [noteId, html, meta, step, info, dialog]);

  const leave = async () => {
    if (dirty) {
      // It saves as you go (10.0), so leaving saves what's left.
      if (!(await save())) return false;
    } else if (info?.item) {
      api.writeLesson(noteId, { lesson: { step, levels: levelsRef.current } }).catch(() => {});
    }
    close(true);
    return true;
  };
  const leaveRef = useRef(leave);
  const shellRef = useRef(null);
  leaveRef.current = leave;
  const saveRef = useRef(save);
  saveRef.current = save;
  useAutosave({ dirty, setDirty, saveRef, changes: [model, meta], remember: () => info?.item && api.writeLesson(noteId, { lesson: { step, levels: levelsRef.current } }).catch(() => {}) });
  useEffect(() => {
    const onKey = (e) => {
      if (!builderKeyAnswers(shellRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!model || !meta) return <div className="sb gb lb sb-loading"><p className="muted">Opening the lesson…</p></div>;

  const hook = section(model, 'hook');
  const book = section(model, 'book');
  const look = section(model, 'look');
  const took = section(model, 'took');
  const points = linesText(book.lines);
  const questions = linesText(look.lines);
  const est = estimate(model);
  const planned = TIMED.reduce((n, k) => n + (meta.minutes[k] ?? 0), 0);
  const anyPlanned = TIMED.some((k) => meta.minutes[k] != null);
  const doneOf = {
    start: !!meta.title.trim() && !!meta.passage.trim(),
    hook: !!hook.field.text.trim(),
    book: points.length > 0,
    look: questions.length > 0,
    took: !!took.field.text.trim(),
    finish: !!completeAt,
  };
  const s = STEPS[step];
  const big = model.bigIdea.text.trim();

  // Your study of the passage, carried in.
  const append = (key, text) => edit((m) => setText(m, key, [section(m, key).field.text.trim(), text.trim()].filter(Boolean).join('\n\n')));
  const addLines = (key, text) => edit((m) => {
    const now = section(m, key).lines.filter((l) => l.text.trim());
    const add = text.split('\n').map((q) => q.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((t) => ({ id: uid(), level: 0, text: t }));
    return setLines(m, key, [...now, ...add]);
  });
  const fromStudy = {
    summary: [['Add above the outline', (t) => edit((m) => setSection(m, 'book', { lead: { ...section(m, 'book').lead, text: [section(m, 'book').lead.text.trim(), t.trim()].filter(Boolean).join('\n\n') } }))]],
    principles: [['Use as the big idea', (t) => edit((m) => setBigIdea(m, t.split(/\n{2,}/)[0].trim()))]],
    questions: [['Add to the questions', (t) => addLines('look', t)]],
    application: [['Use in the took', (t) => append('took', t)]],
  };
  const studies = <FromStudies passage={meta.passage} actions={fromStudy} />;
  const bigQuote = big && <p className="sb-quote"><span className="muted">Big idea</span> {big}</p>;
  const qCounts = QTYPES.map(([k, l]) => [l, questions.filter((q) => q.level === 0 && typeOf(q.text, meta.qtypes) === k).length]);
  const cycleType = (q) => {
    const order = QTYPES.map(([k]) => k);
    const next = order[(order.indexOf(typeOf(q, meta.qtypes)) + 1) % order.length];
    setM({ qtypes: { ...meta.qtypes, [typeKey(q)]: next } });
  };
  // Levels of learning: each question's (a guess from its wording and kind, changed with a click), the methods
  // added, and the Took's.
  const levelFor = (q) => meta.levelOv[typeKey(q)] ?? guessLevel(q, typeOf(q, meta.qtypes));
  const pickLevel = (q, key) => setM({ levelOv: { ...meta.levelOv, [typeKey(q)]: key } });
  const stepText = { hook: hook.field.text, book: book.lead.text, look: look.lead.text, took: took.field.text };
  const counts = levelCounts([
    ...questions.filter((q) => q.level === 0).map((q) => levelFor(q.text)),
    ...Object.values(stepText).flatMap((x) => methodsIn(x).map((m) => m.level)),
    ...(took.field.text.trim() ? [tookLevel(took.field.text)] : []),
  ]);
  levelsRef.current = counts;
  const addMethod = (m) => {
    const line = methodText(m);
    if (m.step === 'hook' || m.step === 'took') append(m.step, line);
    else edit((x) => setSection(x, m.step, { lead: { ...section(x, m.step).lead, text: [section(x, m.step).lead.text.trim(), line].filter(Boolean).join('\n\n') } }));
    dialog.toast(`Added “${m.name}” to the ${PARTS.find((p) => p.key === m.step).label}`);
  };
  const methods = (k) => <Methods step={k} label={PARTS.find((p) => p.key === k).label} text={stepText[k]} onAdd={addMethod} />;
  const course = info.study?.course;
  const goWeek = async (id) => { if (await leave()) openLessonBuilder(dialog, id); };
  const prevNotes = info.prev?.reflection;
  const lastTime = info.item?.previous;

  const present = async () => {
    if (dirty && !(await save())) return;
    close(true);
    presentNote(dialog, noteId);
  };
  const teachIt = async () => {
    if (dirty && !(await save())) return;
    close(true);
    teachNote(dialog, noteId);
  };
  const exportIt = async () => {
    if (dirty && !(await save())) return;
    exportManuscript(dialog, noteId);
  };
  const handout = async () => {
    if (dirty && !(await save())) return;
    printHandout(dialog, noteId, { mainPoints: true });
  };

  const timing = (
    <div className="lb-timing">
      <div className="sb-part-head">
        <strong>Timing Plan</strong>
        <span className={`muted ${anyPlanned && planned > meta.classMinutes ? 'lb-over' : ''}`}>{anyPlanned ? `${planned} of ${meta.classMinutes} min planned` : 'Not planned yet'}</span>
      </div>
      <div className="lb-timing-row">
        <label className="field lb-class">Class Length
          <span><input className="input lb-min" type="number" min="5" max="600" value={meta.classMinutes} onChange={(e) => setM({ classMinutes: Math.max(5, Math.min(600, Number(e.target.value) || 45)) })} /> min</span>
        </label>
        {TIMED.map((k) => (
          <label key={k} className="field">{PARTS.find((p) => p.key === k).label}
            <span><input className="input lb-min" type="number" min="0" max="240" value={meta.minutes[k] ?? ''} placeholder={String(suggestSplit(meta.classMinutes)[k])} onChange={(e) => setMinutes(k, e.target.value)} /> min</span>
            {est[k] > 0 && <small className="muted">about {est[k]} written</small>}
          </label>
        ))}
      </div>
      <div className="lb-bar" aria-hidden="true">
        {TIMED.map((k) => <span key={k} className={`lb-bar-${k}`} style={{ flexGrow: meta.minutes[k] ?? suggestSplit(meta.classMinutes)[k] }} title={PARTS.find((p) => p.key === k).label} />)}
        {anyPlanned && planned < meta.classMinutes && <span className="lb-bar-free" style={{ flexGrow: meta.classMinutes - planned }} />}
      </div>
      <p className="sb-hint">
        <button type="button" className="link-btn" onClick={() => setM({ minutes: suggestSplit(meta.classMinutes) })}>Suggest a split</button>
        {' '}· The written estimates are rough: reading pace for paragraphs, about 2 minutes a main point and 3 a question.
      </p>
      {anyPlanned && planned > meta.classMinutes && <p className="sb-warn"><Icon name="alert" size={14} /> That’s {planned - meta.classMinutes} min more than the class has.</p>}
    </div>
  );

  const body = {
    start: (
      <>
        <label className="field">Title
          <input className="input" value={meta.title} onChange={(e) => setM({ title: e.target.value })} placeholder="Fear God" />
        </label>
        <div className="lb-row">
          <label className="field">Passage
            <input className="input" value={meta.passage} onChange={(e) => setM({ passage: e.target.value })} placeholder="Ecclesiastes 5:1–7" />
          </label>
          {info.item && (
            <label className="field lb-date">Teaching On
              <input className="input" type="date" value={meta.date ?? ''} onChange={(e) => setM({ date: e.target.value })} />
            </label>
          )}
        </div>
        <TextField label="Big Idea" f={{ text: model.bigIdea.text, rich: false, plain: true }} onChange={(t) => edit((m) => setBigIdea(m, t))} hint={HINTS.bigIdea} rows={2}
          placeholder="God wants willing servants who fear Him, not grand promises." />
        {lastTime?.reflection && (
          <div className="lb-week">
            <p className="sb-part-head"><strong>Last Time You Taught It</strong><span className="muted">{lastTime.course}{lastTime.date ? ` · ${dayLabel(lastTime.date)}` : ''}</span></p>
            {lastTime.reflection.reached && <p className="lb-week-text">The class reached the Took: {REACHED[lastTime.reflection.reached]}.</p>}
            {lastTime.reflection.worked && <p className="lb-week-text"><span className="muted">Worked:</span> {lastTime.reflection.worked}</p>}
            {lastTime.reflection.change && <p className="lb-week-text"><span className="muted">Change:</span> {lastTime.reflection.change}</p>}
            {lastTime.reflection.notes && <p className="lb-week-text">{lastTime.reflection.notes}</p>}
          </div>
        )}
        {course && <CourseAims aims={course.aims} />}
        {studies}
        {timing}
      </>
    ),
    hook: (
      <>
        {info.prev && (
          <div className="lb-week">
            <p className="sb-part-head"><strong>{info.prev.week ? `Last Week (Week ${info.prev.week})` : 'Last Week'}</strong><span className="muted">{info.prev.title}{info.prev.date ? ` · ${dayLabel(info.prev.date)}` : ''}</span></p>
            {prevTook ? <p className="lb-week-text">{prevTook}</p> : <p className="muted">Its Took is empty.</p>}
            {prevNotes && (prevNotes.reached || prevNotes.notes) && (
              <p className="lb-week-text muted">After class: {prevNotes.reached ? `reached the Took ${REACHED[prevNotes.reached]}` : ''}{prevNotes.reached && prevNotes.notes ? '. ' : ''}{prevNotes.notes}</p>
            )}
            {prevTook && (
              <button type="button" className="link-btn" onClick={() => edit((m) => setText(m, 'hook', [`Last week, in “${info.prev.title}”, we saw: ${firstSentence(prevTook)}`, section(m, 'hook').field.text.trim()].filter(Boolean).join('\n\n')))}>
                <Icon name="plus" size={13} /> Add a recap to the hook
              </button>
            )}
          </div>
        )}
        {bigQuote}
        <TextField label="Introduction (Hook)" f={hook.field} onChange={(t) => edit((m) => setText(m, 'hook', t))} hint={HINTS.hook} rows={5}
          placeholder="Have you ever promised God something you didn’t keep?" />
        {meta.passage.trim() && <p className="muted lb-then"><Icon name="bible" size={13} /> Then read {meta.passage}.</p>}
        {methods('hook')}
        <PlanLine k="hook" meta={meta} setMinutes={setMinutes} est={est} />
      </>
    ),
    book: (
      <>
        {bigQuote}
        {(book.lead.text.trim() || book.lead.rich) && (
          <TextField label="Above the Outline" f={book.lead} onChange={(t) => edit((m) => setSection(m, 'book', { lead: editField(section(m, 'book').lead, t) }))} hint={HINTS.lead} rows={3} />
        )}
        <div className="sb-part">
          <div className="sb-part-head"><strong>Outline</strong><span className="muted">{points.filter((l) => l.level === 0).length} main points{points.some((l) => l.level) ? `, ${points.filter((l) => l.level).length} under them` : ''}</span></div>
          <p className="sb-hint">{HINTS.book}{showText && meta.passage.trim() ? ' Click a verse number in the passage to start a point on it.' : ''}</p>
          <OutlineEditor lines={book.lines} onChange={(lines) => edit((m) => setLines(m, 'book', lines))} placeholder="First, we are told to guard our steps" headings focusRef={addPoint} />
        </div>
        {book.afterText && <p className="muted"><Icon name="note" size={13} /> The Exposition has more after the outline in the note. It stays as it is.</p>}
        {methods('book')}
        <PlanLine k="book" meta={meta} setMinutes={setMinutes} est={est} />
      </>
    ),
    look: (
      <>
        {bigQuote}
        {(look.lead.text.trim() || look.lead.rich) && (
          <TextField label="Before the Questions" f={look.lead} onChange={(t) => edit((m) => setSection(m, 'look', { lead: editField(section(m, 'look').lead, t) }))} hint="Activities that lead into the discussion." rows={3} />
        )}
        <div className="sb-part">
          <div className="sb-part-head"><strong>Discussion Questions</strong><span className="muted">{qCounts.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(' · ')}</span></div>
          <p className="sb-hint">{HINTS.look} The kind and level beside each are guesses from its wording: click the kind to change it, or the level to see what it means and pick another.</p>
          <OutlineEditor lines={look.lines} onChange={(lines) => edit((m) => setLines(m, 'look', lines))} placeholder="What does it mean to not be rash with our speech?" addLabel="Add a question"
            extra={(l) => l.level === 0 && l.text.trim() && (() => {
              const t = typeOf(l.text, meta.qtypes);
              return (
                <span className="lb-chips">
                  <button type="button" className={`lb-qtype is-${t}`} onClick={() => cycleType(l.text)} title={QTYPES.find(([k]) => k === t)[2]}>{QTYPES.find(([k]) => k === t)[1]}</button>
                  <LevelTag level={levelFor(l.text)} onPick={(k) => pickLevel(l.text, k)} />
                </span>
              );
            })()} />
        </div>
        {questionWarnings(look.lines, meta.qtypes).map((w) => <p key={w} className="sb-warn"><Icon name="alert" size={14} /> {w}</p>)}
        {look.afterText && <p className="muted"><Icon name="note" size={13} /> The Inquisition has more after the questions in the note. It stays as it is.</p>}
        <LevelsMeter counts={counts} />
        {methods('look')}
        <PlanLine k="look" meta={meta} setMinutes={setMinutes} est={est} />
      </>
    ),
    took: (
      <>
        {bigQuote}
        {course && <CourseAims aims={course.aims} only={['do', 'feel']} />}
        <TextField label="Application (Took)" f={took.field} onChange={(t) => edit((m) => setText(m, 'took', t))} hint={HINTS.took} rows={6}
          placeholder="This week, before you promise God anything…" />
        {info.next && (
          <div className="lb-week">
            <p className="sb-part-head"><strong>Next Week</strong><span className="muted">{info.next.title}{info.next.date ? ` · ${dayLabel(info.next.date)}` : ''}</span></p>
            <button type="button" className="link-btn" onClick={() => {
              const ref = info.next.ref && !info.next.title.includes(info.next.ref) ? ` (${info.next.ref})` : '';
              append('took', `Next week: ${info.next.title}${ref}.`);
            }}><Icon name="plus" size={13} /> Add a look ahead</button>
          </div>
        )}
        {took.field.text.trim() && tookLevel(took.field.text) !== 'realization' && (
          <p className="sb-warn"><Icon name="alert" size={14} /> Name one specific thing to do (this week, today, write, call, pray…) and the Took reaches realization.</p>
        )}
        {methods('took')}
        <PlanLine k="took" meta={meta} setMinutes={setMinutes} est={est} />
      </>
    ),
    finish: (
      <>
        <ul className="sb-checklist">
          {STEPS.slice(0, -1).map((x, i) => (
            <li key={x.key} className={doneOf[x.key] ? 'is-done' : ''}>
              <button type="button" className="link-btn" onClick={() => setStep(i)}><Icon name={doneOf[x.key] ? 'checkCircle' : 'clock'} size={14} /> {x.n ? `${x.n}. ` : ''}{x.label}</button>
            </li>
          ))}
          <li className={big ? 'is-done' : ''}><button type="button" className="link-btn" onClick={() => setStep(0)}><Icon name={big ? 'checkCircle' : 'clock'} size={14} /> Big idea</button></li>
        </ul>
        <MarkComplete at={completeAt} onToggle={toggleComplete} what="Lesson" open={STEPS.slice(0, -1).filter((x) => !doneOf[x.key]).length + (big ? 0 : 1)} />
        <LevelsMeter counts={counts} note={false} />
        {timing}
        <div className="gb-sermon">
          <p className="sb-part-head"><strong>Teach It</strong></p>
          <p>Teach from the lesson in teach mode (its steps’ timing, the questions to tick off, and its slides), present its slides on a screen, print a class handout (the main points and the questions, with room to write), or export your teaching manuscript as PDF, Word or rich text.</p>
          <div className="gb-forward-btns">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={teachIt}><Icon name="play" size={14} /> Teach the lesson</button>
            <button type="button" className="btn" disabled={busy} onClick={present}><Icon name="monitor" size={14} /> Present the slides</button>
            <button type="button" className="btn" disabled={busy} onClick={handout}><Icon name="file" size={14} /> Print a class handout</button>
            <button type="button" className="btn" disabled={busy} onClick={exportIt}><Icon name="download" size={14} /> Export the manuscript</button>
          </div>
        </div>
      </>
    ),
  }[s.key];

  const heading = s.n ? PARTS[s.n - 1].title : s.label;
  return (
    <div className="sb gb lb" ref={shellRef}>
      <header className="sb-header">
        <Icon name="present" size={20} />
        <div className="sb-title">
          <h2>{meta.title.trim() || 'Untitled Lesson'}</h2>
          <span className="muted">{[info.item?.week && course ? `Week ${info.item.week} of ${course.weeks}` : null, meta.passage, info.study?.title, meta.date && dayLabel(meta.date)].filter(Boolean).join(' · ') || 'No passage yet'}{dirty ? ' · not saved' : ''}</span>
        </div>
        {course && (info.prev?.note_id || info.next?.note_id) && (
          <span className="lb-weeknav">
            <button type="button" className="icon-btn" disabled={!info.prev?.note_id} onClick={() => goWeek(info.prev.note_id)} title={info.prev?.note_id ? `Week ${info.prev.week ?? ''}: ${info.prev.title}` : 'No earlier lesson yet'} aria-label="Previous week’s lesson"><Icon name="chevronLeft" size={16} /></button>
            <button type="button" className="icon-btn" disabled={!info.next?.note_id} onClick={() => goWeek(info.next.note_id)} title={info.next?.note_id ? `Week ${info.next.week ?? ''}: ${info.next.title}` : 'Next week’s lesson isn’t written yet'} aria-label="Next week’s lesson"><Icon name="chevronRight" size={16} /></button>
          </span>
        )}
        {anyPlanned && <span className={`lb-meter ${planned > meta.classMinutes ? 'lb-over' : ''}`} title="Minutes planned of the class length"><Icon name="clock" size={13} /> {planned}/{meta.classMinutes} min</span>}
        <div className="segmented sb-view" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view !== 'slides'} className={view !== 'slides' ? 'is-active' : ''} onClick={() => setView('steps')}><Icon name="steps" size={14} /> Steps</button>
          <button type="button" role="tab" aria-selected={view === 'slides'} className={view === 'slides' ? 'is-active' : ''} onClick={() => setView('slides')}><Icon name="monitor" size={14} /> Slides</button>
        </div>
        {!showText && view !== 'slides' && <button type="button" className="btn" onClick={() => setShowText(true)}><Icon name="bible" size={14} /> <span className="sb-btn-label">Show the passage</span></button>}
        <button type="button" className="btn" disabled={busy} onClick={teachIt} title="Teach mode: the lesson read-only, with its steps’ timing, questions and slides"><Icon name="play" size={14} /> <span className="sb-btn-label">Teach</span></button>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save to note'}</button>
        <button type="button" className="icon-btn" onClick={leave} aria-label="Close the lesson builder"><Icon name="x" /></button>
      </header>
      {view === 'slides' ? <SlidesEditor noteId={noteId} kind="lesson" source={slideSource} onPresent={present} /> : (
      <>
      <div className={`sb-main ${showText ? 'gb-with-text' : ''}`}>
        <nav className="sb-steps" aria-label="Steps">
          {STEPS.map((x, i) => (
            <div key={x.key}>
              {x.phase && <p className="sb-phase">{x.phase}</p>}
              <button type="button" className={`sb-step ${i === step ? 'is-active' : ''} ${doneOf[x.key] ? 'is-done' : ''}`} onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}>
                <span className="sb-step-n">{doneOf[x.key] ? <Icon name="check" size={12} /> : x.n ?? '·'}</span>
                {x.label}
                {x.n && meta.minutes[x.key] != null && <span className="lb-step-min">{meta.minutes[x.key]}′</span>}
              </button>
            </div>
          ))}
        </nav>
        <section className="sb-body">
          <p className="sb-kicker">{s.n ? `Step ${s.n} of 4` : s.key === 'finish' ? 'Finish' : 'Getting Started'}</p>
          <h3>{heading}</h3>
          <Guidance step={s.key} />
          <div className="sb-fields">{body}</div>
          {['book', 'look', 'took'].includes(s.key) && studies}
        </section>
        {showText && <TextPane passage={meta.passage} onHide={() => setShowText(false)} onVerse={s.key === 'book' ? (v) => addPoint.current?.(`Verse ${v} `) : undefined} />}
      </div>
      <footer className="sb-footer">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}><Icon name="chevronLeft" size={14} /> Back</button>
        <span className="muted sb-progress">{PARTS.filter((p) => doneOf[p.key]).length} of 4 written</span>
        {step < STEPS.length - 1
          ? <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].label} <Icon name="chevronRight" size={14} /></button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (!dirty || (await save())) close(true); }}>Save and close</button>}
      </footer>
      </>
      )}
    </div>
  );
}

/** Opens the lesson builder on a lesson note. Resolves when it closes. */
export const openLessonBuilder = (dialog, noteId) => openBuilderPage(noteId, 'lesson');

/**
 * Write lesson on a teaching session: makes its lesson note (in the study's lesson layout) and opens it in the
 * builder, or in the note when the layout isn't Hook, Book, Look, Took. With the teaching study's id, its method
 * for lessons applies, else the picker asks. Resolves the note's id (null when cancelled).
 */
export async function writeLesson(dialog, itemId, openNote, studyId = null) {
  try {
    const method = await chooseMethod(dialog, 'lesson', { studyId });
    if (method == null) return null;
    const { id } = await api.studyItemNote(itemId, { method });
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    const note = await api.getNote(id);
    if (isLessonNote(note.html)) await openLessonBuilder(dialog, id);
    else openNote?.(id);
    return id;
  } catch (e) {
    dialog.toast(e.message, 'error');
    return null;
  }
}
