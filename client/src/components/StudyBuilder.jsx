import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { needsFullApp } from '../device.js';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { biblePassage } from '../esv.js';
import { Credit, TranslationPicker, useBible } from './TranslationPicker.jsx';
import { useDialog } from './Dialogs.jsx';
import MarkComplete, { useComplete } from './MarkComplete.jsx';
import HandwritingDialog from './HandwritingDialog.jsx';
import { openSermonBuilder } from './SermonBuilder.jsx';
import { openLessonBuilder } from './LessonBuilder.jsx';
import { isLessonNote } from '../lesson.js';
import { splitLogosQuote } from '../editor/LogosPaste.js';
import {
  GUIDANCE, JOURNEY, PRINCIPLE_TESTS, emptyStudy, getField, lessonFromStudy, parseStudy, principleTenseWrong, sermonFromStudy, setField, studyHtml, summaryTenseWrong,
} from '../bibleStudy.js';
import { CONCLUSION_PARTS, appendText, boxHtml, emptySermon, sermonHtml, setPart, words } from '../sermon.js';
import RichBox from './RichBox.jsx';
import { builderKeyAnswers, openBuilderPage, useAutosave } from '../builderPages.js';
import { useStoredState } from '../useStoredState.js';
import { chooseMethod } from './MethodPicker.jsx';
import { confirmNew } from './ExistingWork.jsx';
import { BackgroundCard, newBackground, newWordStudy, openReferenceBuilder } from './ReferenceStudies.jsx';

/**
 * The study builder: a passage studied step by step through Duvall and Hays's Interpretive Journey (Grasping God's
 * Word), with the passage beside you, the method's coaching a click away, and a keeper to finish. It writes an
 * ordinary note (the user's Scripture Study Template layout) that shows on the passage's page, and can start a
 * sermon on the same text.
 */
const STEPS = [
  { key: 'start', phase: 'Start', label: 'Passage and Reading' },
  ...JOURNEY.map((s, i) => ({ ...s, phase: i === 0 ? 'The Interpretive Journey' : s.key === 'keeper' ? 'Finish' : undefined })),
];
const TRANSLATIONS = ['ESV', 'NASB', 'CSB', 'NIV', 'NKJV', 'KJV', 'NET', 'LSB'];
const HINTS = {
  people: 'Who is here, where it happens, the things named. Include the historical and cultural background you find.',
  words: 'Key words and repeated words, with what they meant then (word studies).',
  questions: 'One per line: what you’d want to ask the author.',
  summary: 'One or two sentences: what it meant to them. Past tense, naming the biblical audience.',
  differences: 'Culture, language, situation, time, and where we stand in the covenant.',
  principles: 'One or two sentences in the present or future tense.',
  consistency: 'Other passages that agree with, add to or qualify the principle (Old and New Testament).',
  application: 'Specific: a situation in your life or world that parallels theirs, and what obeying looks like there.',
  keeper: 'The one sentence from this study you’d want to find again in five years.',
};
const PLACEHOLDERS = {
  people: 'Jesus; the disciples and the crowd on the mountain (5:1); Pharisees…',
  words: '“Judge” (krinō): to condemn, not to discern…',
  questions: 'Why does Jesus call the critic a hypocrite?\nWho are the dogs and pigs?',
  summary: 'Jesus warned His disciples not to condemn others harshly…',
  differences: 'They lived under Roman occupation with a scribal culture of…',
  principles: 'God’s people must examine themselves before they correct others.',
  consistency: 'Galatians 6:1; Romans 2:1; James 4:11–12…',
  application: 'Before I talk with my coworker about…',
  keeper: 'The measure I use on others is the measure God will use on me.',
};

/** A text area that grows with its text; a Logos quote pastes with its citation, and a photo of your notes reads in. */
export function Area({ value, onChange, rows = 3, onPhoto, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(window.innerHeight * 0.6, el.scrollHeight + 2)}px`;
  }, [value]);
  const paste = (e) => {
    const split = splitLogosQuote(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
    if (!split) return;
    e.preventDefault();
    const el = e.target;
    const before = el.value.slice(0, el.selectionStart);
    const text = `${before && !/\s$/.test(before) ? ' ' : ''}“${split.quote.map((p) => p.text).join(' ')}” (${split.citation.text.replace(/\.\s*$/, '')})`;
    onChange(before + text + el.value.slice(el.selectionEnd));
  };
  return <textarea ref={ref} className="input sb-area" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} onPaste={paste} {...rest} />;
}

/** A field of the note: a text area, or (when it has lists, pictures…) a preview to edit in the note. */
function Field({ label, k, model, set, rows, dialog }) {
  const f = getField(model, k);
  const photo = async () => {
    const r = await dialog.open((close) => <HandwritingDialog actions={[{ key: 'insert', label: `Add to ${label}` }]} close={close} />, { dismissable: false });
    if (r?.text?.trim()) set(k, appendText(f, r.text.trim()));
  };
  return (
    <div className="sb-part">
      <div className="sb-part-head">
        <strong>{label}</strong>
        <span className="gb-part-tools">
          {f.text.trim() && <span className="muted">{words(f.text)} words</span>}
          {!f.rich && <button type="button" className="link-btn" onClick={photo} title="Read your handwritten notes from a photo"><Icon name="camera" size={13} /> Photo</button>}
        </span>
      </div>
      {HINTS[k] && <p className="sb-hint">{HINTS[k]}</p>}
      {f.rich ? (
        <div className="sb-rich">
          <div className="sb-rich-body" dangerouslySetInnerHTML={{ __html: f.html }} />
          <p className="muted"><Icon name="note" size={13} /> This part has lists or pictures, so edit it in the note.</p>
        </div>
      ) : <RichBox html={boxHtml(f)} onChange={(v) => set(k, v)} rows={rows} placeholder={PLACEHOLDERS[k]} label={label} />}
    </div>
  );
}

/** The passage, beside the steps. With onVerse, its verse numbers can be clicked (the lesson builder's outline). */
export function TextPane({ passage, onHide, onVerse }) {
  const [found, setFound] = useState(null);
  const [error, setError] = useState('');
  const bible = useBible('study');
  const text = found?.text ?? null;
  useEffect(() => {
    setFound(null);
    setError('');
    if (!passage.trim() || bible.connected == null) return undefined;
    if (!bible.connected) { setError('Connect a Bible in Settings → Connections → Bible to read the text here.'); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      biblePassage(passage, bible.tr).then((r) => live && setFound(r)).catch((e) => live && setError(
        e.status === 409 ? 'Connect a Bible in Settings → Connections → Bible to read the text here.'
          : e.status === 400 || e.status === 404 ? `The ${bible.label} couldn’t find that passage.` : e.message,
      ));
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [passage, bible.tr, bible.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <aside className={`gb-text ${onVerse ? 'gb-text-verses' : ''}`} aria-label="The passage"
      onClick={(e) => { const v = e.target.closest?.('sup[data-v]'); if (v && onVerse) onVerse(v.dataset.v); }}
      onKeyDown={(e) => { const v = e.target.closest?.('sup[data-v]'); if (v && onVerse && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onVerse(v.dataset.v); } }}>
      <div className="gb-text-head">
        <strong>{passage.trim() || 'No passage yet'}</strong>
        <TranslationPicker bible={bible} />
        <button type="button" className="icon-btn" onClick={onHide} aria-label="Hide the passage" title="Hide the passage"><Icon name="x" size={14} /></button>
      </div>
      {onVerse && text && <p className="muted gb-text-tip">Click a verse number to start a point on it.</p>}
      {!passage.trim() ? <p className="muted">Type the passage in the first step.</p>
        : error ? <p className="muted">{error}</p> : text == null ? <p className="muted">Loading…</p>
          : text.split(/\n{2,}/).map((p, i) => <p key={i} dangerouslySetInnerHTML={{ __html: p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\[(\d+(?::\d+)?)\]\s*/g, onVerse ? '<sup data-v="$1" role="button" tabindex="0" title="Start a point on verse $1">$1</sup>' : '<sup>$1</sup>').replace(/\n/g, '<br>') }} />)}
      {text && <Credit passage={found} />}
    </aside>
  );
}

/** The step's key question, with the method's coaching folded under it. */
function Guidance({ step }) {
  const [open, setOpen] = useStoredState('noteapp.gb.guide', false);
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

export default function StudyBuilder({ noteId, close }) {
  const dialog = useDialog();
  const [completeAt, toggleComplete] = useComplete(noteId, (e) => dialog.toast(e.message, 'error'));
  const [study, setStudy] = useState(null);
  const [model, setModel] = useState(null);
  const [meta, setMeta] = useState(null); // { title, passage, timesRead, translations, checks }
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useStoredState('noteapp.gb.text', true);
  const [other, setOther] = useState('');
  const base = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [s, note] = await Promise.all([api.makeBibleStudy(noteId), api.getNote(noteId)]);
        base.current = note.updated_at;
        let parsed = parseStudy(note.html);
        // A note with none of the steps yet (a blank one, or notes being turned into a study) gets them after what it has.
        if (!parsed.sections.some((x) => x.key)) {
          const blank = emptyStudy();
          parsed = { ...parsed, sections: [...parsed.sections, ...blank.sections] };
        }
        setStudy(s);
        setModel(parsed);
        setMeta({
          title: note.title ?? '', passage: s.passage ?? '',
          timesRead: s.data.timesRead ?? parsed.reading.timesRead ?? 0,
          translations: s.data.translations ?? parsed.reading.translations ?? [],
          checks: s.data.checks ?? {},
        });
        setStep(Math.min(STEPS.length - 1, Math.max(0, s.data.step ?? 0)));
      } catch (e) {
        dialog.toast(e.message, 'error');
        close(false);
      }
    })();
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, text) => { setModel((m) => setField(m, k, text)); setDirty(true); };
  const setM = (patch) => { setMeta((m) => ({ ...m, ...patch })); setDirty(true); };
  const reading = meta && { timesRead: Number(meta.timesRead) || 0, translations: meta.translations };
  const html = useMemo(() => (model && meta ? studyHtml(model, { passage: meta.passage, reading }) : ''), [model, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async ({ overwrite = false } = {}) => {
    setBusy(true);
    try {
      const r = await api.writeBibleStudy(noteId, { html, title: meta.title, base_updated_at: base.current, overwrite });
      base.current = r.updated_at;
      const s = await api.updateBibleStudy(study.id, {
        passage: meta.passage,
        data: {
          timesRead: Number(meta.timesRead) || 0, translations: meta.translations, checks: meta.checks, step, keeper: getField(model, 'keeper').text.trim(),
          // Which of the five steps have something written (for the studies list).
          done: ['summary', 'differences', 'principles', 'consistency', 'application'].map((k) => !!getField(model, k).text.trim()),
        },
      });
      setStudy(s);
      setDirty(false);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      setBusy(false);
      return true;
    } catch (e) {
      setBusy(false);
      if (e.data?.conflict) {
        const ok = await dialog.confirm({ title: 'The study note changed', message: 'It was edited somewhere else while the builder was open. Save the builder’s version anyway? The other version stays in the note’s version history.', okLabel: 'Save anyway' });
        return ok ? save({ overwrite: true }) : false;
      }
      dialog.toast(e.message, 'error');
      return false;
    }
  }, [noteId, html, meta, step, study, model, dialog]);

  const leave = async () => {
    if (dirty) {
      // It saves as you go (10.0), so leaving saves what's left.
      if (!(await save())) return false;
    } else if (study) {
      api.updateBibleStudy(study.id, { data: { step } }).catch(() => {});
    }
    close(true);
    return true;
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const saveRef = useRef(save);
  saveRef.current = save;
  useAutosave({ dirty, setDirty, saveRef, changes: [model, meta], remember: () => study && api.updateBibleStudy(study.id, { data: { step } }).catch(() => {}) });
  const shellRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      // Ctrl+S saves now, when no dialog is over the builder.
      if (!builderKeyAnswers(shellRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** A sermon on the same text, started from this study: its text idea, sermon idea, details, questions and action. */
  const startSermon = async () => {
    if (dirty && !(await save())) return;
    // 11.0: a sermon on this passage already? Open it instead, or start another.
    const go = await confirmNew(dialog, { kind: 'sermon', text: meta.passage });
    if (go === 'opened') close(true);
    if (go !== true) return;
    const from = sermonFromStudy(model);
    const sm = emptySermon(meta.passage);
    sm.intro = { ...sm.intro, bridge: { ...sm.intro.bridge, textIdea: from.textIdea, sermonIdea: from.sermonIdea } };
    if (from.action) sm.conclusion = setPart(sm.conclusion, 'action', CONCLUSION_PARTS, from.action);
    try {
      const title = meta.title.replace(/\s*\bstudy\b\s*$/i, '').trim() || meta.passage || 'Untitled sermon';
      const method = await chooseMethod(dialog, 'sermon');
      if (method == null) return;
      const r = await api.createSermon({ title, passage: meta.passage, html: sermonHtml(sm, { passage: meta.passage }), method });
      await api.updateSermon(r.id, { data: { worksheet: { details: from.details, questions: from.questions }, study_note_id: noteId } });
      await api.updateBibleStudy(study.id, { data: { sermon_note_id: r.note_id } });
      await api.studyForward(study.id, { kind: 'sermon', note_id: r.note_id, title });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(true);
      dialog.toast('Started a sermon from your study');
      openSermonBuilder(dialog, r.note_id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  /** A lesson in a teaching study, or a chapter in a writing project, started from this study. */
  const takeTo = async (kind) => {
    if (dirty && !(await save())) return;
    const wanted = kind === 'lesson' ? 'teaching' : 'writing';
    const list = (await api.studies().catch(() => [])).filter((x) => x.kind === wanted && x.status !== 'archived');
    if (!list.length) {
      dialog.toast(kind === 'lesson' ? 'Make a Teaching study in Studies first, then start the lesson here.' : 'Make a Writing project in Studies first, then start the chapter here.', 'error', 6000);
      return;
    }
    const studyId = await dialog.choose({
      title: kind === 'lesson' ? 'Start a Lesson' : 'Start a Chapter',
      message: kind === 'lesson' ? 'The lesson joins the teaching study’s schedule.' : 'The chapter goes at the end of the writing project.',
      options: list.map((x) => ({ value: x.id, label: x.title })),
      okLabel: 'Start',
    });
    if (!studyId) return;
    // 11.0: a lesson on this passage already? Open it instead, or start another.
    if (kind === 'lesson') {
      const go = await confirmNew(dialog, { kind: 'lesson', text: meta.passage });
      if (go === 'opened') close(true);
      if (go !== true) return;
    }
    const material = lessonFromStudy(model);
    const title = meta.title.replace(/\s*\bstudy\b\s*$/i, '').trim() || meta.passage;
    const method = kind === 'lesson' ? await chooseMethod(dialog, 'lesson', { studyId }) : null;
    if (kind === 'lesson' && method == null) return;
    try {
      const r = await (kind === 'lesson' ? api.studyToLesson : api.studyToWriting)(study.id, { study_id: studyId, title, material, ...(method != null ? { method } : {}) });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(true);
      dialog.toast(kind === 'lesson' ? 'Started a lesson from your study' : 'Started a chapter from your study');
      // A lesson in the Hook, Book, Look, Took layout goes on in the lesson builder.
      const note = kind === 'lesson' ? await api.getNote(r.note_id).catch(() => null) : null;
      if (note && isLessonNote(note.html)) openLessonBuilder(dialog, r.note_id);
      else window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: r.note_id }));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  // A study made for a course week (5.12) goes straight on to that week's lesson.
  const week = study?.course_week;
  const toLessonBuilder = async (noteId) => {
    const note = await api.getNote(noteId).catch(() => null);
    if (note && isLessonNote(note.html)) openLessonBuilder(dialog, noteId);
    else window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: noteId }));
  };
  const writeWeekLesson = async () => {
    if (dirty && !(await save())) return;
    const method = await chooseMethod(dialog, 'lesson', { studyId: week.study_id });
    if (method == null) return;
    try {
      const r = await api.studyToLesson(study.id, { item_id: week.item_id, material: lessonFromStudy(model), method });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(true);
      dialog.toast(`Started the week ${week.week} lesson from your study`);
      toLessonBuilder(r.note_id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const openWeekLesson = async () => {
    if (!(await leave())) return;
    toLessonBuilder(week.lesson_note);
  };

  /**
   * A word from the passage studied on its own (8.5): the word study opens over this builder, and when it closes its
   * word and keeper go under Important Words.
   */
  const studyWord = async () => {
    if (dirty && !(await save())) return;
    const id = await newWordStudy(dialog, meta.passage);
    if (!id) return;
    const w = (await api.wordStudies().catch(() => [])).find((x) => x.note_id === id);
    if (!w) return;
    const line = `${w.english || w.title}${w.translit ? ` (${w.translit}${w.strongs ? `, ${w.strongs}` : ''})` : ''}${w.keeper ? `: ${w.keeper}` : ': see the word study'}`;
    const cur = getField(model, 'words').text.trim();
    if (!cur.includes(line)) set('words', [cur, line].filter(Boolean).join('\n'));
  };

  if (!model || !meta) return <div className="sb gb sb-loading"><p className="muted">Opening the study…</p></div>;

  const text = (k) => getField(model, k).text.trim();
  const doneOf = {
    start: !!meta.passage.trim() && !!meta.title.trim(),
    their: !!text('summary'),
    river: !!text('differences'),
    bridge: !!text('principles'),
    map: !!text('consistency'),
    town: !!text('application'),
    keeper: !!completeAt,
  };
  const s = STEPS[step];
  const checks = meta.checks ?? {};
  const toggleTranslation = (t) => setM({ translations: meta.translations.includes(t) ? meta.translations.filter((x) => x !== t) : [...meta.translations, t] });
  const field = (k, label, rows) => <Field key={k} k={k} label={label} model={model} set={set} rows={rows} dialog={dialog} />;

  const body = {
    start: (
      <>
        <label className="field">Title
          <input className="input" value={meta.title} onChange={(e) => setM({ title: e.target.value })} placeholder="Matthew 7:1–6 Study" />
        </label>
        <label className="field">Passage
          <input className="input" value={meta.passage} onChange={(e) => setM({ passage: e.target.value })} placeholder="Matthew 7:1–6" />
        </label>
        <div className="field">
          <span>Times Read</span>
          <span className="gb-count">
            <strong>{Number(meta.timesRead) || 0}</strong>
            <button type="button" className="btn btn-small" onClick={() => setM({ timesRead: (Number(meta.timesRead) || 0) + 1 })}><Icon name="plus" size={13} /> Read it again</button>
            {Number(meta.timesRead) > 0 && <button type="button" className="link-btn" onClick={() => setM({ timesRead: Number(meta.timesRead) - 1 })}>Undo</button>}
          </span>
          <span className="sb-hint">Read the whole passage several times, in your own Bible and more than one translation, before you study the details.</span>
        </div>
        <div className="field">
          <span>Translations Consulted</span>
          <div className="sb-chips gb-chips">
            {[...new Set([...TRANSLATIONS, ...meta.translations])].map((t) => (
              <button key={t} type="button" className={`chip ${meta.translations.includes(t) ? 'is-on' : ''}`} aria-pressed={meta.translations.includes(t)} onClick={() => toggleTranslation(t)}>{t}</button>
            ))}
            <form className="gb-other" onSubmit={(e) => { e.preventDefault(); const t = other.trim().toUpperCase(); if (t && !meta.translations.includes(t)) setM({ translations: [...meta.translations, t] }); setOther(''); }}>
              <input className="input" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Other" aria-label="Another translation" maxLength={20} />
            </form>
          </div>
        </div>
      </>
    ),
    their: (
      <>
        <BackgroundCard passage={meta.passage} />
        {field('people', 'People, Places, Things', 3)}
        {field('words', 'Important Words', 3)}
        <StudyAWord onStudy={studyWord} />
        {field('questions', 'Questions', 3)}
        {field('summary', 'Text Summary', 2)}
        {summaryTenseWrong(text('summary')) && (
          <p className="sb-warn"><Icon name="alert" size={14} /> The summary should say what it <em>meant</em>: write it in the past tense.</p>
        )}
      </>
    ),
    river: (
      <>
        {text('summary') && <p className="sb-quote"><span className="muted">What it meant then</span> {text('summary')}</p>}
        {field('differences', 'Cultural Differences', 5)}
      </>
    ),
    bridge: (
      <>
        {field('principles', 'Theological Principles', 3)}
        <StudyAWord onStudy={studyWord} />
        {principleTenseWrong(text('principles')) && (
          <p className="sb-warn"><Icon name="alert" size={14} /> A principle is timeless: write it in the present or future tense.</p>
        )}
        <div className="gb-tests">
          <p className="sb-part-head"><strong>Test the Principle</strong><span className="muted">{PRINCIPLE_TESTS.filter(([k]) => checks[k]).length} of {PRINCIPLE_TESTS.length}</span></p>
          {PRINCIPLE_TESTS.map(([k, label]) => (
            <label key={k} className="check-row">
              <input type="checkbox" checked={!!checks[k]} onChange={(e) => setM({ checks: { ...checks, [k]: e.target.checked } })} /> {label}
            </label>
          ))}
        </div>
      </>
    ),
    map: (
      <>
        {field('consistency', 'Biblical Consistency', 5)}
        <StudyAWord onStudy={studyWord} />
        <div className="gb-refine">
          {field('principles', 'Your Principle (Refine It If Needed)', 2)}
        </div>
      </>
    ),
    town: (
      <>
        {text('principles') && <p className="sb-quote"><span className="muted">Principle</span> {text('principles')}</p>}
        {field('application', 'Modern Application', 6)}
      </>
    ),
    keeper: (
      <>
        {field('keeper', 'Keeper', 2)}
        <ul className="sb-checklist">
          {STEPS.slice(0, -1).map((x, i) => (
            <li key={x.key} className={doneOf[x.key] ? 'is-done' : ''}>
              <button type="button" className="link-btn" onClick={() => setStep(i)}><Icon name={doneOf[x.key] ? 'checkCircle' : 'clock'} size={14} /> {x.n ? `${x.n}. ` : ''}{x.label}</button>
            </li>
          ))}
        </ul>
        <MarkComplete at={completeAt} onToggle={toggleComplete} what="Study" open={STEPS.slice(0, -1).filter((x) => !doneOf[x.key]).length} />
        {week && (
          <div className="gb-sermon gb-week">
            <p className="sb-part-head"><strong>Week {week.week ?? ''} of {week.course}</strong></p>
            {week.lesson_note ? (
              <>
                <p>This week’s lesson is written. Open it to keep working on it.</p>
                <div className="gb-forward-btns"><button type="button" className="btn" disabled={busy} onClick={openWeekLesson}><Icon name="present" size={14} /> Open the lesson</button></div>
              </>
            ) : (
              <>
                <p>This study is the first step for week {week.week}. Write its lesson next: your summary, principle, questions and application carry over.</p>
                <div className="gb-forward-btns"><button type="button" className="btn btn-primary" disabled={busy} onClick={writeWeekLesson}><Icon name="present" size={14} /> Write the week {week.week} lesson</button></div>
              </>
            )}
          </div>
        )}
        <div className="gb-sermon">
          <p className="sb-part-head"><strong>Take It Further</strong></p>
          <p>A study is the first step. Start a sermon, a lesson or a chapter from it, and your work carries over: your summary, principle, questions and application.</p>
          <div className="gb-forward-btns">
            <button type="button" className="btn" disabled={busy || !meta.passage.trim()} onClick={startSermon}><Icon name="lectern" size={14} /> Start a sermon</button>
            <button type="button" className="btn" disabled={busy || !meta.passage.trim()} onClick={() => takeTo('lesson')}><Icon name="present" size={14} /> Start a lesson</button>
            <button type="button" className="btn" disabled={busy} onClick={() => takeTo('writing')}><Icon name="note" size={14} /> Start a chapter</button>
          </div>
          {(study.data.forward ?? []).length > 0 && (
            <ul className="gb-forward">
              {study.data.forward.map((f) => (
                <li key={f.note_id}>
                  <Icon name={f.kind === 'sermon' ? 'lectern' : f.kind === 'lesson' ? 'present' : 'note'} size={13} />
                  <button type="button" className="link-btn" onClick={async () => { await leave(); window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: f.note_id })); }}>{f.title || 'Untitled'}</button>
                  <span className="muted">{{ sermon: 'Sermon', lesson: 'Lesson', writing: 'Chapter' }[f.kind]}{f.study ? ` · ${f.study}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </>
    ),
  }[s.key];

  return (
    <div className="sb gb" ref={shellRef}>
      <header className="sb-header">
        <Icon name="bible" size={20} />
        <div className="sb-title">
          <h2>{meta.title.trim() || 'Untitled Study'}</h2>
          <span className="muted">{study?.plan ? `Bible studies › ${study.plan.title || 'Untitled study'} · ` : 'Bible studies · '}{meta.passage || 'No passage yet'}{dirty ? ' · not saved' : ''}</span>
        </div>
        {!showText && <button type="button" className="btn" onClick={() => setShowText(true)}><Icon name="bible" size={14} /> <span className="sb-btn-label">Show the passage</span></button>}
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save to note'}</button>
        <button type="button" className="icon-btn" onClick={leave} aria-label="Close the study builder"><Icon name="x" /></button>
      </header>
      <div className={`sb-main ${showText ? 'gb-with-text' : ''}`}>
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
          <p className="sb-kicker">{s.n ? `Step ${s.n} of 5` : s.key === 'keeper' ? 'Finish' : 'Getting Started'}</p>
          <h3>{s.label}</h3>
          <Guidance step={s.key} />
          <div className="sb-fields">{body}</div>
        </section>
        {showText && <TextPane passage={meta.passage} onHide={() => setShowText(false)} />}
      </div>
      <footer className="sb-footer">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}><Icon name="chevronLeft" size={14} /> Back</button>
        <span className="muted sb-progress">{JOURNEY.filter((x) => x.n && doneOf[x.key]).length} of 5 steps done</span>
        {step < STEPS.length - 1
          ? <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].label} <Icon name="chevronRight" size={14} /></button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (!dirty || (await save())) close(true); }}>Save and close</button>}
      </footer>
    </div>
  );
}

/**
 * Opens a study's builder on a note (making it a study if it isn't one yet): the Interpretive Journey's, or a
 * background or word study's (8.5), in its own tab (10.0).
 */
export async function openStudyBuilder(dialog, noteId) {
  const m = await api.noteMethod(noteId).catch(() => null);
  if (m?.method === 'background' || m?.method === 'word') return openReferenceBuilder(dialog, noteId, m.method);
  return openBuilderPage(noteId, 'study');
}

/** “Study a word from the passage”: a word study on top of this builder. */
function StudyAWord({ onStudy }) {
  return (
    <p className="sb-hint rs-study-word">
      <button type="button" className="link-btn" onClick={onStudy}><Icon name="text" size={13} /> Study a word from the passage</button>
      {' '}its Hebrew or Greek, how it’s used, and what it means here.
    </p>
  );
}

/** A new study's note in each study method (shared/methods.js), laid out for its builder. */
const STUDY_STARTERS = { ggw: (passage) => studyHtml(emptyStudy(passage), { passage }) };

/**
 * A new study on a passage: a note laid out with the five steps in the Bible Study notebook (or, with
 * study_item_id, as that Studies schedule item's note), opened in the builder. Resolves the new note's id once the
 * builder closes (null when it couldn't be made).
 */
export async function newStudy(dialog, passage = '', extra = {}, { studyId = null, method: forced = null } = {}) {
  if (needsFullApp(dialog)) return null;
  try {
    const method = forced ?? await chooseMethod(dialog, 'study', { studyId });
    if (method == null) return null;
    if (method === 'background') return newBackground(dialog, passage, extra);
    if (method === 'word') return newWordStudy(dialog, passage, extra);
    const s = await api.createBibleStudy({ passage, html: STUDY_STARTERS[method](passage), method, ...extra });
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    await openStudyBuilder(dialog, s.note_id);
    return s.note_id;
  } catch (e) {
    dialog.toast(e.message, 'error');
    return null;
  }
}
