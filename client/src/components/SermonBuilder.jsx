import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { biblePassage } from '../esv.js';
import { useBible } from './TranslationPicker.jsx';
import { useDialog } from './Dialogs.jsx';
import MarkComplete, { useComplete } from './MarkComplete.jsx';
import {
  CONCLUSION_PARTS, DIVISION_PARTS, INTRO_PARTS, getPart, joinStatement, newDivision, parseSermon,
  boxHtml, reiterationText, sermonHtml, setPart, words,
} from '../sermon.js';
import { preachNote } from './PreachMode.jsx';
import { presentNote } from './PresentMode.jsx';
import { exportManuscript } from './ManuscriptExport.jsx';
import SlidesEditor from './SlidesEditor.jsx';
import SermonBoard from './SermonBoard.jsx';
import FromStudies from './FromStudies.jsx';
import RichBox from './RichBox.jsx';
import { builderKeyAnswers, openBuilderPage, useAutosave } from '../builderPages.js';
import { afterMove, fitTransition, isStale, moveDivision } from '../sermonBoard.js';

/**
 * The sermon builder: the twelve steps, based on Wayne McDill's 12 Essential Skills for Great Preaching, from studying
 * the text to delivering it. The study steps (1–3) fill a worksheet kept with the sermon; the rest write the sermon
 * note itself (Introduction, the divisions, Conclusion), which stays an ordinary note you can keep editing.
 */
export const STEPS = [
  { key: 'passage', phase: 'Start', label: 'Title and Passage' },
  { key: 'structure', n: 1, phase: 'Study the Text', label: 'Text Structure' },
  { key: 'details', n: 2, label: 'Text Details' },
  { key: 'questions', n: 3, label: 'Research Questions' },
  { key: 'textIdea', n: 4, phase: 'Shape the Message', label: 'The Text Idea' },
  { key: 'bridge', n: 5, label: 'Bridge to the Sermon' },
  { key: 'divisions', n: 6, label: 'Sermon Divisions' },
  { key: 'persuasion', n: 7, phase: 'Develop It', label: 'Persuasive Elements' },
  { key: 'analogies', n: 8, label: 'Natural Analogies' },
  { key: 'stories', n: 9, label: 'Pictures and Stories' },
  { key: 'experience', n: 10, label: 'Human Experience' },
  { key: 'response', n: 11, phase: 'Finish', label: 'Faith Response' },
  { key: 'delivery', n: 12, label: 'Oral Presentation' },
];

const GUIDE = {
  passage: 'Choose a passage that holds one complete thought: a paragraph in the epistles, a scene in a story, a stanza in a psalm.',
  structure: 'Lay the passage out by its grammar. Put main clauses at the left margin and indent what modifies them beneath. Mark connectives (for, therefore, but, so that), commands and repeated words. The text’s own shape is the first clue to its meaning.',
  details: 'Read slowly and write down what stands out: key words, verb tenses, repeated ideas, figures of speech, contrasts, names and places, the setting. Every detail is a lead for a question.',
  questions: 'Turn the details into questions (Why…? What does … mean? How does this connect to…?) and answer them from the context, cross-references, word studies and commentaries. Keep the answers short.',
  textIdea: 'Name what the text is talking about (the subject) and what it says about it (the modifier or complement). Together, in the past tense, they make the text idea: what it meant to its first hearers.',
  bridge: 'Restate the text idea in the present tense for your hearers: the sermon idea. Then ask it a question (why, how, what) that the divisions will answer, and answer it with a transition that names a key word (“for three reasons”).',
  divisions: 'Each division answers the interrogative with one statement drawn from the text, in parallel wording, with the verses it comes from. Write a transition that carries the listener from each division to the next.',
  persuasion: 'Every division needs four things in balance: explanation (what the text says), illustration (what it looks like), argumentation (why it’s true, answering objections) and application (what to do about it). The bars show how much each has.',
  analogies: 'Look for something in everyday life that works the way this truth works: traffic, farming, money, family, sports, weather. A natural analogy lets the listener see the point before you state it.',
  stories: 'Open with a picture or a story that wins attention and leads to the sermon’s need. Close with a picture of the truth lived out (visualization), so the listener sees themselves in it.',
  experience: 'Connect the text with what your hearers actually live through: their fears, habits, work, relationships. Name the need in the introduction, and make each division’s application specific.',
  response: 'Aim at a response of faith. Restate the divisions (reiteration), then call for one clear action: what the listener should believe, decide or do this week.',
  delivery: 'Plan how it will sound, not how it reads. Mark the places to slow down, pause, or tell rather than read. Check the length against your time. When it’s ready, preach it from preaching mode.',
};

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** "for 3 reasons" / "three ways" → 3, to check against the number of divisions. */
function promisedCount(text) {
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+)?(reasons|ways|things|truths|steps|marks|lessons|principles|keys|questions|signs|areas|reminders|characteristics|kinds|results|benefits|commands|promises|warnings)\b/i.exec(text ?? '');
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
}

/** A text area that grows with its text. */
function Area({ value, onChange, rows = 3, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(window.innerHeight * 0.6, el.scrollHeight + 2)}px`;
  }, [value]);
  return <textarea ref={ref} className="input sb-area" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

/** A part of the note: a text area, or (when the part has lists, pictures…) a preview to edit in the note. */
function Part({ label, hint, f, onChange, placeholder, rows }) {
  return (
    <div className="sb-part">
      <div className="sb-part-head"><strong>{label}</strong>{f.text.trim() && <span className="muted">{words(f.text)} words</span>}</div>
      {hint && <p className="sb-hint">{hint}</p>}
      {f.rich ? (
        <div className="sb-rich">
          <div className="sb-rich-body" dangerouslySetInnerHTML={{ __html: f.html }} />
          <p className="muted"><Icon name="note" size={13} /> This part has lists or pictures, so edit it in the note.</p>
        </div>
      ) : <RichBox html={boxHtml(f)} onChange={onChange} placeholder={placeholder} rows={rows} label={label} />}
    </div>
  );
}

function PassageBox({ passage }) {
  const [text, setText] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const bible = useBible();
  useEffect(() => { setText(null); setError(''); }, [passage]);
  const show = async () => {
    setOpen(!open);
    if (text || !passage.trim()) return;
    try {
      const r = await biblePassage(passage);
      setText(r.text);
    } catch (e) {
      setError(e.status === 400 || e.status === 404 ? `The ${bible.label} couldn’t find that passage.` : e.message);
    }
  };
  if (!passage.trim()) return null;
  return (
    <div className="sb-passage">
      <button type="button" className="link-btn" onClick={show}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /> {open ? 'Hide' : 'Show'} {passage} ({bible.label})</button>
      {open && (
        <div className="sb-passage-text">
          {error ? <p className="muted">{error}</p> : text == null ? <p className="muted">Loading…</p>
            : text.split(/\n{2,}/).map((p, i) => <p key={i} dangerouslySetInnerHTML={{ __html: p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\[(\d+)\]\s*/g, '<sup>$1</sup>').replace(/\n/g, '<br>') }} />)}
        </div>
      )}
    </div>
  );
}

/** Words in each of the four elements of a division, as a bar. */
function Balance({ d }) {
  // What was written in the note before (an imported division's outline) shows as gray.
  const counts = [['lead', 'Written in the note', words(d.lead.text)], ...DIVISION_PARTS.map(([k, label]) => [k, label, words(getPart(d, k).text)])];
  const total = counts.reduce((n, c) => n + c[2], 0);
  return (
    <div className="sb-balance" title={counts.map(([, l, n]) => `${l}: ${n} words`).join('\n')}>
      {total ? counts.map(([k, , n]) => n > 0 && <span key={k} className={`sb-bal-${k}`} style={{ flexGrow: n }} />) : <span className="sb-bal-empty" />}
    </div>
  );
}

export default function SermonBuilder({ noteId, startAt = null, close }) {
  const dialog = useDialog();
  const [completeAt, toggleComplete] = useComplete(noteId, (e) => dialog.toast(e.message, 'error'));
  const [loaded, setLoaded] = useState(null); // { sermon, note }
  const [model, setModel] = useState(null);
  const [meta, setMeta] = useState(null); // { title, passage, study_id, minutes, worksheet }
  const [series, setSeries] = useState([]);
  const [step, setStep] = useState(0);
  const [div, setDiv] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // Steps, or the Arrange board (with its undo history and the note as last saved, to compare with).
  const [view, setView] = useState(() => { try { return localStorage.getItem('noteapp.sb.view') || 'steps'; } catch { return 'steps'; } });
  const [history, setHistory] = useState([]);
  const [savedHtml, setSavedHtml] = useState('');
  const [reiteration, setReiteration] = useState(false);
  const base = useRef(0);
  useEffect(() => { try { localStorage.setItem('noteapp.sb.view', view); } catch { /* private window */ } }, [view]);

  useEffect(() => {
    (async () => {
      try {
        const [sermon, note] = await Promise.all([api.makeSermon(noteId), api.getNote(noteId)]);
        base.current = note.updated_at;
        setLoaded({ sermon, note });
        const parsed = parseSermon(note.html);
        // Transitions flagged when the board last moved things (and saved without fixing them) stay flagged.
        const stale = new Set(sermon.data.stale ?? []);
        parsed.divisions.forEach((d) => { if (d.transition.trim() && stale.has(d.statement)) d.transTo = 'moved'; });
        setModel(parsed);
        setSavedHtml(note.html);
        setMeta({ title: note.title ?? '', passage: sermon.passage ?? '', study_id: sermon.study_id ?? null, minutes: sermon.data.minutes ?? '', worksheet: sermon.data.worksheet ?? {} });
        const first = startAt ?? sermon.data.step ?? 0;
        setStep(Math.min(STEPS.length - 1, Math.max(0, first)));
      } catch (e) {
        dialog.toast(e.message, 'error');
        close(false);
      }
    })();
    api.studies().then((all) => setSeries(all.filter((s) => s.kind === 'preaching'))).catch(() => {});
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (fn) => { setModel((m) => fn(m)); setDirty(true); };
  const setM = (patch) => { setMeta((m) => ({ ...m, ...patch })); setDirty(true); };
  const setW = (patch) => setM({ worksheet: { ...meta.worksheet, ...patch } });
  const setIntro = (key, text) => change((m) => ({ ...m, intro: setPart(m.intro ?? parseSermon('<h1>Introduction</h1>').intro, key, INTRO_PARTS, text) }));
  const setConcl = (key, text) => change((m) => ({ ...m, conclusion: setPart(m.conclusion ?? { title: 'Conclusion', lead: '', subs: [] }, key, CONCLUSION_PARTS, text) }));
  const setBridge = (key, value) => change((m) => ({ ...m, intro: { ...(m.intro ?? parseSermon('<h1>Introduction</h1>').intro), bridge: { ...(m.intro?.bridge ?? parseSermon('<h1>Introduction</h1>').intro.bridge), [key]: value } } }));
  /** A move on the board (or the divisions step): undoable, and the reiteration follows the new order. */
  const move = (fn) => {
    const next = fn(model);
    if (next === model) return;
    const r = afterMove(model, next);
    setHistory((h) => [...h.slice(-99), model]);
    setModel(r.model);
    setReiteration(r.reiteration);
    setDirty(true);
  };
  const undo = useCallback(() => {
    if (!history.length) return;
    setModel(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setReiteration(false);
    setDirty(true);
  }, [history]);
  const savedModel = useMemo(() => parseSermon(savedHtml), [savedHtml]);
  const setTransition = (uid, text) => change((m) => fitTransition({ ...m, divisions: m.divisions.map((d) => (d.uid === uid ? { ...d, transition: text } : d)) }, uid));
  const setDivision = (i, patch) => change((m) => ({ ...m, divisions: m.divisions.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  const setDivPart = (i, key, text) => change((m) => ({ ...m, divisions: m.divisions.map((d, j) => (j === i ? setPart(d, key, DIVISION_PARTS, text) : d)) }));

  const html = useMemo(() => (model && meta ? sermonHtml(model, { passage: meta.passage }) : ''), [model, meta]);
  // The Slides tab builds from the sermon as it is in the builder, saved or not.
  const slideSource = useMemo(() => ({ title: meta?.title ?? '', html, passage: meta?.passage ?? '' }), [meta?.title, meta?.passage, html]);
  const totalWords = useMemo(() => words(new DOMParser().parseFromString(html, 'text/html').body.textContent), [html]);

  const save = useCallback(async ({ overwrite = false } = {}) => {
    setBusy(true);
    try {
      const r = await api.writeSermon(noteId, { html, title: meta.title, base_updated_at: base.current, overwrite });
      base.current = r.updated_at;
      await api.updateSermon(loaded.sermon.id, {
        passage: meta.passage, study_id: meta.study_id ?? null,
        data: { worksheet: meta.worksheet, minutes: Number(meta.minutes) || null, step, stale: model.divisions.filter((d, i) => isStale(model, i)).map((d) => d.statement) },
      });
      setSavedHtml(html);
      setDirty(false);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      setBusy(false);
      return true;
    } catch (e) {
      setBusy(false);
      if (e.data?.conflict) {
        const ok = await dialog.confirm({ title: 'The sermon note changed', message: 'It was edited somewhere else while the builder was open. Save the builder’s version anyway? The other version stays in the note’s version history.', okLabel: 'Save anyway' });
        return ok ? save({ overwrite: true }) : false;
      }
      dialog.toast(e.message, 'error');
      return false;
    }
  }, [noteId, html, meta, step, loaded, dialog, model]);

  const leave = async () => {
    if (dirty) {
      // It saves as you go (10.0), so leaving saves what's left.
      if (!(await save())) return;
    } else if (loaded) {
      // Remember the step for next time.
      api.updateSermon(loaded.sermon.id, { data: { step } }).catch(() => {});
    }
    close(true);
  };
  const leaveRef = useRef(leave);
  const shellRef = useRef(null);
  leaveRef.current = leave;
  const saveRef = useRef(save);
  saveRef.current = save;
  useAutosave({ dirty, setDirty, saveRef, changes: [model, meta], remember: () => loaded && api.updateSermon(loaded.sermon.id, { data: { step } }).catch(() => {}) });
  useEffect(() => {
    const onKey = (e) => {
      // Ctrl+S saves now, when no dialog is over the builder.
      if (!builderKeyAnswers(shellRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!model || !meta) return <div className="sb sb-loading"><p className="muted">Opening the builder…</p></div>;

  const s = STEPS[step];
  const intro = model.intro ?? parseSermon('<h1>Introduction</h1>').intro;
  const bridge = intro.bridge;
  const concl = model.conclusion ?? { title: 'Conclusion', lead: '', subs: [] };
  const ws = meta.worksheet;
  const divs = model.divisions;
  const d = divs[Math.min(div, divs.length - 1)] ?? null;
  const promised = promisedCount(bridge.transition);
  const est = Math.max(1, Math.round(totalWords / 130));

  const doneOf = {
    passage: !!meta.passage.trim() && !!meta.title.trim(),
    structure: !!ws.structure?.trim(),
    details: !!ws.details?.trim(),
    questions: (ws.questions ?? []).some((q) => q.q?.trim()),
    textIdea: !!bridge.textIdea.trim(),
    bridge: !!bridge.sermonIdea.trim() && !!bridge.interrogative.trim(),
    divisions: divs.filter((x) => x.statement.trim()).length >= 2,
    persuasion: divs.length > 0 && divs.every((x) => getPart(x, 'explanation').text.trim() || x.lead.text.trim()),
    analogies: divs.length > 0 && divs.every((x) => getPart(x, 'illustration').text.trim() || x.lead.text.trim()),
    stories: !!getPart(intro, 'attention').text.trim() && !!getPart(concl, 'visualization').text.trim(),
    experience: !!getPart(intro, 'need').text.trim(),
    response: !!getPart(concl, 'action').text.trim(),
    delivery: !!completeAt,
  };

  const divisionTabs = (
    <div className="sb-div-tabs" role="tablist">
      {divs.map((x, i) => (
        <button key={i} type="button" role="tab" aria-selected={i === div} className={i === div ? 'is-active' : ''} onClick={() => setDiv(i)}>
          <span className="sb-div-n">{i + 1}</span> {x.statement.trim() || 'Untitled Division'}
        </button>
      ))}
    </div>
  );
  const noDivisions = <p className="muted sb-empty">Write the divisions first (step 6), then develop each one here. <button type="button" className="link-btn" onClick={() => setStep(6)}>Go to the divisions</button></p>;
  const writtenInNote = d && d.lead.text.trim() && (
    <div className="sb-rich">
      <p className="sb-part-head"><strong>Already in the note</strong></p>
      <div className="sb-rich-body" dangerouslySetInnerHTML={{ __html: d.lead.html }} />
      <p className="muted"><Icon name="note" size={13} /> Edit this in the note. Parts you add here go after it.</p>
    </div>
  );

  const body = {
    passage: (
      <>
        <label className="field">Title
          <input className="input" value={meta.title} onChange={(e) => setM({ title: e.target.value })} placeholder="Proper Judgment" />
        </label>
        <div className="field-row">
          <label className="field grow">Passage
            <input className="input" value={meta.passage} onChange={(e) => setM({ passage: e.target.value })} placeholder="Matthew 7:1–6" />
          </label>
          <label className="field narrow">Minutes
            <input className="input" type="number" min="1" max="180" value={meta.minutes} onChange={(e) => setM({ minutes: e.target.value })} placeholder="30" />
          </label>
        </div>
        <PassageBox passage={meta.passage} />
        <label className="field">Series
          <select className="input" value={meta.study_id ?? ''} onChange={(e) => setM({ study_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not part of a series</option>
            {series.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
        </label>
        <Part label="Bible text" hint="The passage as you’ll read it in the introduction." f={getPart(intro, 'bibleText')} onChange={(t) => setIntro('bibleText', t)} rows={2} placeholder={meta.passage || 'Matthew 7:1–6'} />
        {!getPart(intro, 'bibleText').text.trim() && meta.passage.trim() && (
          <button type="button" className="btn btn-small" onClick={() => setIntro('bibleText', meta.passage.trim())}>Use {meta.passage.trim()}</button>
        )}
      </>
    ),
    structure: (
      <>
        <PassageBox passage={meta.passage} />
        <Area value={ws.structure ?? ''} onChange={(v) => setW({ structure: v })} rows={14} className="input sb-area sb-mono"
          placeholder={'Do not judge,\n    or you too will be judged.\nFor in the same way you judge others,\n    you will be judged,\n…'} />
      </>
    ),
    details: (
      <>
        <PassageBox passage={meta.passage} />
        <Area value={ws.details ?? ''} onChange={(v) => setW({ details: v })} rows={10} placeholder={'“Judge” (krinō): to condemn, not to discern\nSpeck / plank: hyperbole\nVerse 6: dogs and pigs, unclean animals'} />
      </>
    ),
    questions: (
      <>
        <ol className="sb-questions">
          {(ws.questions ?? []).map((q, i) => (
            <li key={i}>
              <input className="input" value={q.q ?? ''} placeholder="Question" onChange={(e) => setW({ questions: ws.questions.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) })} aria-label="Question" />
              <Area value={q.a ?? ''} rows={2} placeholder="Answer" onChange={(v) => setW({ questions: ws.questions.map((x, j) => (j === i ? { ...x, a: v } : x)) })} aria-label="Answer" />
              <button type="button" className="icon-btn" aria-label="Remove question" onClick={() => setW({ questions: ws.questions.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-small" onClick={() => setW({ questions: [...(ws.questions ?? []), { q: '', a: '' }] })}><Icon name="plus" size={13} /> Question</button>
      </>
    ),
    textIdea: (
      <>
        <div className="field-row">
          <label className="field grow">Subject <span className="muted">What is it talking about?</span>
            <input className="input" value={bridge.subject} onChange={(e) => setBridge('subject', e.target.value)} placeholder="Judging others" />
          </label>
          <label className="field grow">Modifier <span className="muted">What does it say about it?</span>
            <input className="input" value={bridge.modifier} onChange={(e) => setBridge('modifier', e.target.value)} placeholder="Must be proper" />
          </label>
        </div>
        <label className="field">Text idea <span className="muted">Past tense: what it meant then</span>
          <Area value={bridge.textIdea} onChange={(v) => setBridge('textIdea', v)} rows={2} placeholder="Jesus called His followers to proper judgment." />
        </label>
      </>
    ),
    bridge: (
      <>
        {bridge.textIdea.trim() && <p className="sb-quote"><span className="muted">Text idea</span> {bridge.textIdea}</p>}
        <label className="field">Sermon idea <span className="muted">Present tense: what it means now</span>
          <Area value={bridge.sermonIdea} onChange={(v) => setBridge('sermonIdea', v)} rows={2} placeholder="Proper judgment happens in a spirit of humility and love." />
        </label>
        <label className="field">Interrogative <span className="muted">The question the divisions answer</span>
          <Area value={bridge.interrogative} onChange={(v) => setBridge('interrogative', v)} rows={2} placeholder="Why are humility and love needed for proper judgment?" />
        </label>
        {!bridge.interrogative.trim() && (
          <div className="sb-chips">{['Why', 'How', 'What', 'When', 'In what ways'].map((w) => <button key={w} type="button" className="chip" onClick={() => setBridge('interrogative', `${w} `)}>{w}…?</button>)}</div>
        )}
        <label className="field">Transition <span className="muted">Answers it with a key word</span>
          <Area value={bridge.transition} onChange={(v) => setBridge('transition', v)} rows={2} placeholder="Humility and love are needed for three reasons." />
        </label>
      </>
    ),
    divisions: (
      <>
        {(bridge.sermonIdea || bridge.interrogative) && (
          <div className="sb-quote">
            {bridge.sermonIdea && <p><span className="muted">Sermon idea</span> {bridge.sermonIdea}</p>}
            {bridge.interrogative && <p><span className="muted">Interrogative</span> {bridge.interrogative}</p>}
            {bridge.transition && <p><span className="muted">Transition</span> {bridge.transition}</p>}
          </div>
        )}
        {promised && promised !== divs.filter((x) => x.statement.trim()).length && (
          <p className="sb-warn"><Icon name="alert" size={14} /> The transition promises {promised}; there {divs.length === 1 ? 'is' : 'are'} {divs.length} division{divs.length === 1 ? '' : 's'}.</p>
        )}
        <ol className="sb-divisions">
          {divs.map((x, i) => (
            <li key={i} className="sb-division">
              <div className="sb-division-head">
                <span className="sb-div-n">{i + 1}</span>
                <input className="input grow" value={x.statement} onChange={(e) => setDivision(i, { statement: e.target.value })} placeholder="Humility and love avoid harsh judgment." aria-label={`Division ${i + 1}`} />
                <input className="input sb-verses" value={x.verses} onChange={(e) => setDivision(i, { verses: e.target.value })} placeholder="Verses 1–2" aria-label="Verses" />
                <button type="button" className="icon-btn" disabled={i === 0} aria-label="Move up" onClick={() => move((m) => moveDivision(m, i, i - 1))}><Icon name="arrowUp" size={14} /></button>
                <button type="button" className="icon-btn" disabled={i === divs.length - 1} aria-label="Move down" onClick={() => move((m) => moveDivision(m, i, i + 2))}><Icon name="arrowDown" size={14} /></button>
                <button type="button" className="icon-btn" aria-label="Remove division" onClick={async () => {
                  const has = x.lead.text.trim() || x.subs.some((p) => p.field.text.trim());
                  if (has && !(await dialog.confirm({ title: 'Remove this division?', message: 'Its text goes from the sermon note when you save (the note’s version history keeps the old one).', okLabel: 'Remove', danger: true }))) return;
                  change((m) => ({ ...m, divisions: m.divisions.filter((_, j) => j !== i) }));
                }}><Icon name="trash" size={14} /></button>
              </div>
              {i < divs.length - 1 && (
                <input className={`input sb-transition ${isStale(model, i) ? 'is-stale' : ''}`} value={x.transition} onChange={(e) => setTransition(x.uid, e.target.value)}
                  placeholder="Transition to the next: While humility and love avoid harsh judgment, they also…" aria-label="Transition" />
              )}
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-small" onClick={() => change((m) => ({ ...m, divisions: [...m.divisions, newDivision()] }))}><Icon name="plus" size={13} /> Division</button>
      </>
    ),
    persuasion: !divs.length ? noDivisions : (
      <>
        {divisionTabs}
        <div className="sb-balance-all">
          {divs.map((x, i) => <button key={i} type="button" className={`sb-balance-row ${i === div ? 'is-active' : ''}`} onClick={() => setDiv(i)}><span>{i + 1}</span><Balance d={x} /></button>)}
          <p className="sb-legend">{DIVISION_PARTS.map(([k, l]) => <span key={k}><i className={`sb-bal-${k}`} /> {l}</span>)}</p>
        </div>
        {writtenInNote}
        <Part label="Explanation" hint="What the text says and means." f={getPart(d, 'explanation')} onChange={(t) => setDivPart(div, 'explanation', t)} />
        <Part label="Illustration" hint="What it looks like (more in step 8)." f={getPart(d, 'illustration')} onChange={(t) => setDivPart(div, 'illustration', t)} rows={2} />
        <Part label="Argumentation" hint="Why it’s true: reasons, other Scripture, answers to objections." f={getPart(d, 'argumentation')} onChange={(t) => setDivPart(div, 'argumentation', t)} />
        <Part label="Application" hint="What to do about it (more in step 10)." f={getPart(d, 'application')} onChange={(t) => setDivPart(div, 'application', t)} rows={2} />
      </>
    ),
    analogies: !divs.length ? noDivisions : divs.map((x, i) => (
      <div key={i} className="sb-card">
        <p className="sb-card-title"><span className="sb-div-n">{i + 1}</span> {joinStatement(x.statement, x.verses) || 'Untitled Division'}</p>
        <Part label="Illustration" f={getPart(x, 'illustration')} onChange={(t) => setDivPart(i, 'illustration', t)} placeholder="Like scales for grain at the market: the measure you use…" />
      </div>
    )),
    stories: (
      <>
        <Part label="Attention" hint="Introduction: a picture or story that wins the hearer and leads to the need." f={getPart(intro, 'attention')} onChange={(t) => setIntro('attention', t)} rows={5} />
        <Part label="Visualization" hint="Conclusion: the truth lived out, in a picture the hearer can step into." f={getPart(concl, 'visualization')} onChange={(t) => setConcl('visualization', t)} rows={5} />
      </>
    ),
    experience: (
      <>
        <Part label="Need" hint="Introduction: the need in your hearers’ lives this text meets." f={getPart(intro, 'need')} onChange={(t) => setIntro('need', t)} rows={4} />
        {divs.map((x, i) => (
          <div key={i} className="sb-card">
            <p className="sb-card-title"><span className="sb-div-n">{i + 1}</span> {joinStatement(x.statement, x.verses) || 'Untitled Division'}</p>
            <Part label="Application" f={getPart(x, 'application')} onChange={(t) => setDivPart(i, 'application', t)} placeholder="This week, before you correct someone, …" />
          </div>
        ))}
      </>
    ),
    response: (
      <>
        <Part label="Reiteration" hint="The divisions, restated." f={getPart(concl, 'reiteration')} onChange={(t) => setConcl('reiteration', t)} rows={3} />
        {!getPart(concl, 'reiteration').rich && divs.length > 0 && getPart(concl, 'reiteration').text.trim() !== reiterationText(model) && (
          <button type="button" className="btn btn-small" onClick={() => setConcl('reiteration', reiterationText(model))}>Fill in from the divisions</button>
        )}
        <Part label="Action" hint="The one response you’re calling for." f={getPart(concl, 'action')} onChange={(t) => setConcl('action', t)} rows={4} />
      </>
    ),
    delivery: (
      <>
        <div className="sb-length">
          <div><strong>{totalWords.toLocaleString()}</strong><span className="muted">Words</span></div>
          <div><strong>~{est}</strong><span className="muted">Minutes at 130 words a minute</span></div>
          {Number(meta.minutes) > 0 && <div className={est > Number(meta.minutes) ? 'is-over' : ''}><strong>{meta.minutes}</strong><span className="muted">Minutes planned</span></div>}
        </div>
        <label className="field">Delivery notes <span className="muted">Kept with the sermon, not in the note</span>
          <Area value={ws.delivery ?? ''} onChange={(v) => setW({ delivery: v })} rows={6} placeholder={'Slow down on the plank in v. 3; pause after the question.\nTell the traffic story; don’t read it.'} />
        </label>
        <ul className="sb-checklist">
          {STEPS.slice(1, 12).map((x, i) => (
            <li key={x.key} className={doneOf[x.key] ? 'is-done' : ''}>
              <button type="button" className="link-btn" onClick={() => setStep(i + 1)}><Icon name={doneOf[x.key] ? 'checkCircle' : 'clock'} size={14} /> {x.n}. {x.label}</button>
            </li>
          ))}
        </ul>
        <MarkComplete at={completeAt} onToggle={toggleComplete} what="Sermon" open={STEPS.slice(0, 12).filter((x) => !doneOf[x.key]).length} />
        <div className="gb-forward-btns sb-export">
          <button type="button" className="btn" disabled={busy} onClick={async () => { if (!dirty || (await save())) exportManuscript(dialog, noteId); }}><Icon name="download" size={14} /> Export the manuscript</button>
          <span className="muted">PDF, Word or rich text, as a manuscript or an outline.</span>
        </div>
      </>
    ),
  }[s.key];

  return (
    <div className="sb" ref={shellRef}>
      <header className="sb-header">
        <Icon name="lectern" size={20} />
        <div className="sb-title">
          <h2>{meta.title.trim() || 'Untitled Sermon'}</h2>
          <span className="muted">{meta.passage || 'No passage yet'}{dirty ? ' · not saved' : ''}</span>
        </div>
        <div className="segmented sb-view" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === 'steps'} className={view === 'steps' ? 'is-active' : ''} onClick={() => setView('steps')}><Icon name="steps" size={14} /> Steps</button>
          <button type="button" role="tab" aria-selected={view === 'arrange'} className={view === 'arrange' ? 'is-active' : ''} onClick={() => setView('arrange')}><Icon name="grip" size={14} /> Arrange</button>
          <button type="button" role="tab" aria-selected={view === 'slides'} className={view === 'slides' ? 'is-active' : ''} onClick={() => setView('slides')}><Icon name="monitor" size={14} /> Slides</button>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={async () => { if (!dirty || (await save())) { close(true); preachNote(dialog, noteId); } }}><Icon name="play" size={14} /> <span className="sb-btn-label">Preach</span></button>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save to note'}</button>
        <button type="button" className="icon-btn" onClick={leave} aria-label="Close the builder"><Icon name="x" /></button>
      </header>
      {view === 'slides' ? (
        <SlidesEditor noteId={noteId} kind="sermon" source={slideSource}
          onPresent={async () => { if (!dirty || (await save())) { close(true); presentNote(dialog, noteId); } }} />
      ) : view === 'arrange' ? (
        <SermonBoard model={model} move={move} undo={undo} canUndo={history.length > 0} savedModel={savedModel} sermon={loaded.sermon} noteId={noteId}
          passage={meta.passage} reiteration={reiteration} setTransition={setTransition} dialog={dialog}
          onRefreshReiteration={() => { setConcl('reiteration', reiterationText(model)); setReiteration(false); }}
          onDismissReiteration={() => setReiteration(false)} />
      ) : (
      <>
      <div className="sb-main">
        <nav className="sb-steps" aria-label="Steps">
          {STEPS.map((x, i) => (
            <div key={x.key}>
              {x.phase && <p className="sb-phase">{x.phase}</p>}
              <button type="button" className={`sb-step ${i === step ? 'is-active' : ''} ${doneOf[x.key] ? 'is-done' : ''}`} onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}>
                <span className="sb-step-n">{doneOf[x.key] ? <Icon name="check" size={12} /> : x.n ?? '·'}</span>
                {x.label}
              </button>
            </div>
          ))}
        </nav>
        <section className="sb-body">
          <p className="sb-kicker">{s.n ? `Step ${s.n} of 12` : 'Getting Started'}</p>
          <h3>{s.label}</h3>
          <p className="sb-guide">{GUIDE[s.key]}</p>
          <div className="sb-fields">
            {/* Your Bible studies of the passage, while you study it and shape the idea. */}
            {['passage', 'details', 'questions', 'textIdea', 'bridge'].includes(s.key) && (
              <FromStudies passage={meta.passage} onUse={['textIdea', 'bridge'].includes(s.key) ? (k, v) => setBridge(k, v) : null} />
            )}
            {body}
          </div>
        </section>
      </div>
      <footer className="sb-footer">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}><Icon name="chevronLeft" size={14} /> Back</button>
        <span className="muted sb-progress">{STEPS.filter((x) => x.n && doneOf[x.key]).length} of 12 steps done</span>
        {step < STEPS.length - 1
          ? <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].label} <Icon name="chevronRight" size={14} /></button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (!dirty || (await save())) close(true); }}>Save and close</button>}
      </footer>
      </>
      )}
    </div>
  );
}

/** Opens the builder on a note (making it a sermon if it isn't one yet), in its own tab (10.0). */
export const openSermonBuilder = (dialog, noteId, opts = {}) => openBuilderPage(noteId, 'sermon', opts);
