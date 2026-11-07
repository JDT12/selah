import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { biblePassage } from '../esv.js';
import { Credit, useBible } from './TranslationPicker.jsx';
import { useDialog } from './Dialogs.jsx';
import MarkComplete, { useComplete } from './MarkComplete.jsx';
import HandwritingDialog from './HandwritingDialog.jsx';
import { Area, TextPane } from './StudyBuilder.jsx';
import { appendText, boxHtml, words } from '../sermon.js';
import RichBox from './RichBox.jsx';
import { builderKeyAnswers, openBuilderPage, useAutosave } from '../builderPages.js';
import { useStoredState } from '../useStoredState.js';
import { completeLayout, emptyLayout, firstLine, getField, layoutHtml, parseLayout, setField } from '../studyLayout.js';
import {
  BACKGROUND_STEPS, FACT_FIELDS, WORD_STEPS, fallacies, langLabel, originalHtml, partOfSpeech, readScholars, renderingsHtml, scholarsHtml, sensesHtml, strongsLabel, usesHtml,
} from '../wordStudy.js';
import { refreshWordLibrary } from '../wordLibrary.js';
import { book, logosLink, parse } from '../../../shared/scripture.js';

/**
 * 8.5's reference studies, beside the Interpretive Journey: a book's background (one per book, shown beside every
 * study in it) and a word study (one per word: its Hebrew or Greek from STEPBible, how translations render it, its
 * range of meaning, its uses, and what it means in its verse, with a fallacy check). Both write an ordinary note laid
 * out in steps (studyLayout.js) and keep the rest with the study.
 */

// ---------- the shared shell ----------

/** A field of the note: a text area (a Logos quote pastes with its citation), or a preview when only the note can edit it. */
function Field({ ctx, k, label, rows = 3, hint, placeholder }) {
  const { dialog, model, steps, set } = ctx;
  const f = getField(model, steps, k);
  const add = (text) => set(k, appendText(f, text.trim()));
  const photo = async () => {
    const r = await dialog.open((close) => <HandwritingDialog actions={[{ key: 'insert', label: `Add to ${label}` }]} close={close} />, { dismissable: false });
    if (r?.text?.trim()) add(r.text);
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
      {hint && <p className="sb-hint">{hint}</p>}
      {f.rich ? (
        <div className="sb-rich">
          <div className="sb-rich-body" dangerouslySetInnerHTML={{ __html: f.html }} />
          <p className="muted"><Icon name="note" size={13} /> This part has lists or pictures, so edit it in the note.</p>
        </div>
      ) : <RichBox html={boxHtml(f)} onChange={(v) => set(k, v)} rows={rows} placeholder={placeholder} label={label} />}
    </div>
  );
}

/** The step's key question, with coaching folded under it. */
function Guidance({ g }) {
  const [open, setOpen] = useStoredState('noteapp.gb.guide', false);
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

/**
 * A builder for a study laid out in steps. `cfg`: { steps (the note's), nav ([{ key, label, phase?, n? }]), icon,
 * noun, guidance, init(study, note) → meta, body(key, ctx), done(ctx) → { key: bool }, generated(ctx) → { step: html },
 * data(ctx) → what the study keeps, passage(meta) → the passage pane's text ('' hides it), progress: keys counted }.
 */
function LayoutBuilder({ noteId, close, cfg }) {
  const dialog = useDialog();
  const [completeAt, toggleComplete] = useComplete(noteId, (e) => dialog.toast(e.message, 'error'));
  const [study, setStudy] = useState(null);
  const [model, setModel] = useState(null);
  const [meta, setMeta] = useState(null);
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useStoredState('noteapp.gb.text', true);
  const base = useRef(0);
  const steps = cfg.steps;

  useEffect(() => {
    (async () => {
      try {
        const [s, note] = await Promise.all([api.makeBibleStudy(noteId), api.getNote(noteId)]);
        base.current = note.updated_at;
        setStudy(s);
        setModel(completeLayout(parseLayout(note.html, steps), steps));
        setMeta(cfg.init(s, note));
        setStep(Math.min(cfg.nav.length - 1, Math.max(0, s.data.step ?? 0)));
      } catch (e) {
        dialog.toast(e.message, 'error');
        close(false);
      }
    })();
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, text) => { setModel((m) => setField(m, steps, k, text)); setDirty(true); };
  const setM = (patch) => { setMeta((m) => ({ ...m, ...(typeof patch === 'function' ? patch(m) : patch) })); setDirty(true); };
  const ctx = { dialog, steps, model, meta, set, setM, study, step, setStep, completeAt, toggleComplete, busy, noteId, nav: cfg.nav };
  ctx.text = (k) => (model ? getField(model, steps, k).text.trim() : '');
  ctx.field = (k, label, rows, extra = {}) => <Field key={k} ctx={ctx} k={k} label={label} rows={rows} {...extra} />;
  const html = useMemo(() => (model && meta ? layoutHtml(model, steps, { passage: meta.passage, generated: cfg.generated(ctx) }) : ''), [model, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async ({ overwrite = false } = {}) => {
    setBusy(true);
    try {
      const r = await api.writeBibleStudy(noteId, { html, title: meta.title, base_updated_at: base.current, overwrite });
      base.current = r.updated_at;
      const s = await api.updateBibleStudy(study.id, { passage: meta.passage, data: { ...cfg.data(ctx), step, keeper: ctx.text('keeper') } });
      setStudy(s);
      setDirty(false);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      refreshWordLibrary();
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
  }, [noteId, html, meta, step, study, model, dialog]); // eslint-disable-line react-hooks/exhaustive-deps

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
  ctx.save = save;
  ctx.leave = leave;
  ctx.dirty = dirty;
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const saveRef = useRef(save);
  saveRef.current = save;
  useAutosave({ dirty, setDirty, saveRef, changes: [model, meta], remember: () => study && api.updateBibleStudy(study.id, { data: { step } }).catch(() => {}) });
  const shellRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      // Only the builder on top answers (a word study can open over a background, or over the Interpretive Journey).
      if (!builderKeyAnswers(shellRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!model || !meta) return <div className="sb gb sb-loading"><p className="muted">Opening the study…</p></div>;

  const doneOf = cfg.done(ctx);
  const s = cfg.nav[step];
  const passage = cfg.passage(meta);
  const counted = cfg.nav.filter((x) => x.n);
  return (
    <div className="sb gb rs" ref={shellRef}>
      <header className="sb-header">
        <Icon name={cfg.icon} size={20} />
        <div className="sb-title">
          <h2>{meta.title.trim() || `Untitled ${cfg.noun}`}</h2>
          <span className="muted">{cfg.noun}{cfg.subtitle(meta) ? ` · ${cfg.subtitle(meta)}` : ''}{dirty ? ' · not saved' : ''}</span>
        </div>
        {passage && !showText && <button type="button" className="btn" onClick={() => setShowText(true)}><Icon name="bible" size={14} /> <span className="sb-btn-label">Show the passage</span></button>}
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save to note'}</button>
        <button type="button" className="icon-btn" onClick={leave} aria-label={`Close the ${cfg.noun.toLowerCase()} builder`}><Icon name="x" /></button>
      </header>
      <div className={`sb-main ${passage && showText ? 'gb-with-text' : ''}`}>
        <nav className="sb-steps" aria-label="Steps">
          {cfg.nav.map((x, i) => (
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
          <p className="sb-kicker">{s.n ? `Step ${s.n} of ${counted.length}` : s.key === 'keeper' ? 'Finish' : 'Getting Started'}</p>
          <h3>{s.label}</h3>
          <Guidance g={cfg.guidance[s.key]} />
          <div className="sb-fields">{cfg.body(s.key, ctx)}</div>
        </section>
        {passage && showText && <TextPane passage={passage} onHide={() => setShowText(false)} />}
      </div>
      <footer className="sb-footer">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}><Icon name="chevronLeft" size={14} /> Back</button>
        <span className="muted sb-progress">{counted.filter((x) => doneOf[x.key]).length} of {counted.length} steps done</span>
        {step < cfg.nav.length - 1
          ? <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>Next: {cfg.nav[step + 1].label} <Icon name="chevronRight" size={14} /></button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (!dirty || (await save())) close(true); }}>Save and close</button>}
      </footer>
    </div>
  );
}

/** The last page: what's still open (click to go there), then Mark complete. */
function Finish({ ctx, doneOf, what }) {
  const open = ctx.nav.slice(0, -1).filter((x) => !doneOf[x.key]).length;
  return (
    <>
      <ul className="sb-checklist">
        {ctx.nav.slice(0, -1).map((x, i) => (
          <li key={x.key} className={doneOf[x.key] ? 'is-done' : ''}>
            <button type="button" className="link-btn" onClick={() => ctx.setStep(i)}><Icon name={doneOf[x.key] ? 'checkCircle' : 'clock'} size={14} /> {x.n ? `${x.n}. ` : ''}{x.label}</button>
          </li>
        ))}
      </ul>
      <MarkComplete at={ctx.completeAt} onToggle={ctx.toggleComplete} what={what} open={open} />
    </>
  );
}

// ---------- background study ----------

const BG_HINTS = {
  author: 'Who wrote it. Say so plainly when the book doesn’t name its author.',
  authorEvidence: 'What the book says about its author, what the early church said, and what scholars weigh.',
  date: 'When it was written, as closely as you can tell (a range is fine).',
  place: 'Where the author was, and what was happening in the world and in God’s people.',
  audience: 'Who first read or heard it: where they lived, Jew or Gentile, their faith and situation.',
  occasion: 'What prompted it: a problem, a question, a visit, a crisis.',
  culture: 'What the first readers took for granted that we don’t: customs, politics, religion, money, family.',
  genre: 'Narrative, law, poetry, wisdom, prophecy, gospel, letter, apocalyptic… and what that means for reading it.',
  outline: 'Its main sections, one per line, with their chapters.',
  purpose: 'Why it was written, in a sentence or two. Look for a stated purpose (John 20:31, 1 John 5:13).',
  themes: 'What it keeps coming back to: repeated words and ideas.',
  keyVerses: 'The verses that sum it up.',
  scholarNotes: 'Anything else about where scholars differ, and where you land.',
  keeper: 'The one thing about this book’s background you’d want to remember whenever you study it.',
};
const BG_GUIDE = {
  start: { question: 'Which book are you studying?', paras: ['A background study is done once per book and shows beside every study of a passage in it, in the Interpretive Journey’s first step and on the passage page.', 'Use a Bible dictionary, a study Bible’s introduction, or a New or Old Testament introduction, and read the book itself through, ideally in one sitting.'] },
  author: { question: 'Who wrote it, and how do we know?', paras: ['Start with what the book says about itself, then what early Christian writers said, then what scholars weigh today.'] },
  setting: { question: 'When and where was it written?', paras: ['Place the book in its history: the events around it, and where the author and readers were.'] },
  audience: { question: 'Who first read it, and why was it written to them?', paras: ['The occasion is the situation that called for the book. Many passages make sense only in its light.'] },
  culture: { question: 'What did the first readers take for granted?', paras: ['This is the river in the Interpretive Journey: the distance between their world and ours. Note what will matter when you study its passages.'] },
  genre: { question: 'What kind of writing is it, and how is it put together?', paras: ['Genre tells you how to read it: a letter is read differently from a psalm or an apocalypse. An outline shows where each passage sits.'] },
  purpose: { question: 'Why was it written, and what does it keep coming back to?', paras: ['Look for a stated purpose first. Then trace its themes and repeated words.'] },
  scholars: { question: 'Where do scholars differ?', paras: ['Put the main views side by side: what each says, who holds it, and the reasons. Authorship, date and destination are the usual questions.', 'Say where you land and why in the notes below.'] },
};
const SCHOLAR_QUESTIONS = ['Authorship', 'Date', 'Destination', 'Audience', 'Purpose', 'Unity', 'Genre', 'Place of writing'];

const BG_NAV = [
  { key: 'start', label: 'The Book', phase: 'Start' },
  ...BACKGROUND_STEPS.map((s, i) => ({ key: s.key, label: s.label, n: s.key === 'keeper' ? undefined : i + 1, phase: i === 0 ? 'Background' : s.key === 'keeper' ? 'Finish' : undefined })),
];

function BookCheck({ ctx }) {
  const [other, setOther] = useState(null);
  const passage = ctx.meta.passage;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.backgroundStudy(passage).then((r) => live && setOther(r.study && r.study.note_id !== ctx.noteId ? r : null)).catch(() => {}), 400);
    return () => { live = false; clearTimeout(t); };
  }, [passage]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!other) return null;
  return <p className="sb-warn"><Icon name="alert" size={14} /> {other.book} already has a background study, “{other.study.title}”. Each book keeps one, so finish that one instead.</p>;
}

function ScholarsTable({ ctx }) {
  const rows = ctx.meta.scholars;
  const setRows = (next) => ctx.setM({ scholars: next });
  const update = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="rs-scholars">
      <datalist id="rs-scholar-q">{SCHOLAR_QUESTIONS.map((q) => <option key={q} value={q} />)}</datalist>
      {rows.map((r, i) => (
        <div key={i} className="rs-scholar">
          <div className="rs-scholar-head">
            <input className="input" list="rs-scholar-q" value={r.question} onChange={(e) => update(i, { question: e.target.value })} placeholder="Question (Authorship, Date…)" aria-label="Question" />
            <button type="button" className="icon-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove this view" title="Remove this view"><Icon name="trash" size={14} /></button>
          </div>
          <input className="input" value={r.view} onChange={(e) => update(i, { view: e.target.value })} placeholder="The view (Paul wrote it from Rome, AD 60–62)" aria-label="View" />
          <input className="input" value={r.who} onChange={(e) => update(i, { who: e.target.value })} placeholder="Held by (scholars, commentaries)" aria-label="Held by" />
          <Area value={r.why} onChange={(t) => update(i, { why: t })} rows={2} placeholder="Why: the reasons they give" aria-label="Why" />
        </div>
      ))}
      <button type="button" className="btn btn-small" onClick={() => setRows([...rows, { question: rows[rows.length - 1]?.question ?? '', view: '', who: '', why: '' }])}><Icon name="plus" size={13} /> Add a view</button>
    </div>
  );
}

const BACKGROUND = {
  steps: BACKGROUND_STEPS,
  nav: BG_NAV,
  icon: 'book',
  noun: 'Background Study',
  guidance: BG_GUIDE,
  subtitle: (meta) => meta.passage,
  init: (s, note) => ({
    title: note.title ?? '', passage: s.passage || (s.data.book ? book(s.data.book)?.name : '') || '',
    scholars: s.data.scholars ?? readScholars(note.html),
  }),
  passage: () => '',
  generated: (ctx) => ({ scholars: scholarsHtml(ctx.meta.scholars) }),
  data: (ctx) => {
    const r = parse(ctx.meta.passage).refs[0];
    return {
      book: r?.book ?? null,
      facts: Object.fromEntries(FACT_FIELDS.map(([k]) => [k, firstLine(ctx.text(k))])),
      scholars: ctx.meta.scholars,
      done: ['author', 'date', 'audience', 'culture', 'genre', 'purpose', 'scholars'].map((k) => (k === 'scholars' ? ctx.meta.scholars.some((x) => x.view.trim()) : !!ctx.text(k))),
    };
  },
  done: (ctx) => ({
    start: !!ctx.meta.title.trim() && !!parse(ctx.meta.passage).refs.length,
    author: !!ctx.text('author'),
    setting: !!ctx.text('date'),
    audience: !!ctx.text('audience'),
    culture: !!ctx.text('culture'),
    genre: !!ctx.text('genre') || !!ctx.text('outline'),
    purpose: !!ctx.text('purpose'),
    scholars: ctx.meta.scholars.some((x) => x.view.trim()),
    keeper: !!ctx.completeAt,
  }),
  body: (key, ctx) => {
    const f = (k, label, rows) => ctx.field(k, label, rows, { hint: BG_HINTS[k] });
    const r = parse(ctx.meta.passage).refs[0];
    switch (key) {
      case 'start': return (
        <>
          <label className="field">Title
            <input className="input" value={ctx.meta.title} onChange={(e) => ctx.setM({ title: e.target.value })} placeholder="Ephesians Background" />
          </label>
          <label className="field">Book
            <input className="input" value={ctx.meta.passage} onChange={(e) => ctx.setM({ passage: e.target.value })} placeholder="Ephesians" />
            <span className="sb-hint">{r ? `The background of ${book(r.book).name}.` : 'The book of the Bible this is the background of.'}</span>
          </label>
          <BookCheck ctx={ctx} />
        </>
      );
      case 'author': return <>{f('author', 'Author', 2)}{f('authorEvidence', 'Evidence', 4)}</>;
      case 'setting': return <>{f('date', 'Date', 2)}{f('place', 'Place and Events', 4)}</>;
      case 'audience': return <>{f('audience', 'Audience', 3)}{f('occasion', 'Occasion', 3)}</>;
      case 'culture': return f('culture', 'Customs, Politics and Religion', 6);
      case 'genre': return <>{f('genre', 'Genre', 2)}{f('outline', 'Outline', 6)}</>;
      case 'purpose': return <>{f('purpose', 'Purpose', 2)}{f('themes', 'Themes and Key Words', 3)}{f('keyVerses', 'Key Verses', 2)}</>;
      case 'scholars': return <><ScholarsTable ctx={ctx} />{f('scholarNotes', 'Notes', 3)}</>;
      case 'keeper': {
        const doneOf = BACKGROUND.done(ctx);
        const facts = FACT_FIELDS.map(([k, label]) => [label, firstLine(ctx.text(k))]).filter(([, v]) => v);
        return (
          <>
            {f('keeper', 'Keeper', 2)}
            {facts.length > 0 && (
              <div className="sb-quote rs-facts">
                <span className="muted">Shown beside your studies of {r ? book(r.book).name : 'the book'}</span>
                {facts.map(([label, v]) => <p key={label}><strong>{label}:</strong> {v}</p>)}
              </div>
            )}
            <Finish ctx={ctx} doneOf={doneOf} what="Background study" />
          </>
        );
      }
      default: return null;
    }
  },
};

export const BackgroundBuilder = ({ noteId, close }) => <LayoutBuilder noteId={noteId} close={close} cfg={BACKGROUND} />;

// ---------- word study ----------

const WORD_HINTS = {
  english: 'The English word as your translation has it.',
  why: 'Why this word: it’s repeated, it carries the verse, it’s theologically loaded, or translations differ on it.',
  originalNotes: 'Anything else about the word itself: its form here, related words, what your lexicons say.',
  translationNotes: 'Where translations differ, and what that tells you.',
  rangeNotes: 'What the lexicons say, and senses you’d add or question.',
  usageNotes: 'What its uses show: patterns, the author’s habits, uses that stand out.',
  context: 'Which sense it carries in this verse.',
  reasons: 'What in the verse and its context points to that sense.',
  keeper: 'One sentence: what this word means here, and what difference it makes to the verse.',
};
const WORD_GUIDE = {
  word: { question: 'Which word, and why this one?', paras: ['Pick a word that matters to the passage: repeated, central to the argument, theologically rich, or rendered differently by different translations. Don’t study every word.'] },
  original: { question: 'What’s the Hebrew or Greek behind it?', paras: ['Click the word in its verse to find it. The same English word can translate several Hebrew or Greek words, and one Hebrew or Greek word can come into English several ways.'] },
  translations: { question: 'How do translations render it?', paras: ['Compare a word-for-word translation with a thought-for-thought one. Where they differ, the word may carry more than one possible sense.'] },
  range: { question: 'What can the word mean?', paras: ['List the senses the word can carry (its semantic range), using the lexicon and the uses you look at. Keep each sense short, in your own words.'] },
  usage: { question: 'How is it used elsewhere?', paras: ['Meaning comes from use. Start nearest the verse (the same book, then the same author, then the rest of the Bible) and note the sense each use carries.'] },
  context: { question: 'Which sense fits here?', paras: ['Choose one sense, and say what in the verse and its context points to it. A word usually carries one sense in one place, not all of them at once.'] },
};

const W_NAV = WORD_STEPS.map((s, i) => ({ key: s.key, label: s.label, n: s.key === 'keeper' ? undefined : i + 1, phase: i === 0 ? 'Word Study' : s.key === 'keeper' ? 'Finish' : undefined }));

/** A verse's Hebrew or Greek, word by word: click one to study it. */
function VerseWords({ verse, code, onPick }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    setState(null);
    if (!parse(verse).refs.length) return undefined;
    api.langVerse(verse).then((r) => live && setState(r)).catch((e) => live && setState({ error: e.status === 503 ? 'unavailable' : e.message }));
    return () => { live = false; };
  }, [verse]);
  if (!parse(verse).refs.length) return <p className="muted">Type the verse first.</p>;
  if (!state) return <p className="muted">Reading the Hebrew or Greek…</p>;
  if (state.error === 'unavailable') return <p className="muted">The Greek and Hebrew data isn’t on this server. Type the word below instead.</p>;
  if (state.error) return <p className="muted">{state.error}</p>;
  if (!state.verses.length) return <p className="muted">No Hebrew or Greek for that verse.</p>;
  return (
    <div className="rs-verse">
      {state.verses.map((v) => (
        <div key={v.key} className="rs-verse-row">
          {state.verses.length > 1 && <span className="rs-verse-ref">{v.ref}</span>}
          <div className={`rs-words ${v.key >= 40_000_000 ? 'is-greek' : 'is-hebrew'}`} dir={v.key >= 40_000_000 ? 'ltr' : 'rtl'}>
            {v.words.filter((w) => w.code && !/^[GH]9\d{3}/.test(w.code)).map((w, i) => (
              <button key={i} type="button" className={`rs-word ${w.code === code ? 'is-on' : ''}`} onClick={() => onPick(w)} title={`${w.lemma} · ${w.lex_gloss}`}>
                <span className="rs-word-orig">{w.surface.replace(/[.,;:·׃־]+$/u, '')}</span>
                <span className="rs-word-gloss" dir="ltr">{w.gloss.replace(/[<>[\]]/g, '')}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="rs-credit muted">{state.credit}</p>
    </div>
  );
}

/** Find a word in the lexicons by Strong's number, Hebrew or Greek, transliteration or English. */
function LexiconSearch({ onPick }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return undefined; }
    let live = true;
    const t = setTimeout(() => api.langSearch(q).then((r) => live && setHits(r)).catch(() => live && setHits([])), 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="rs-search">
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or search: G26, agapē, ἀγάπη, love" aria-label="Search the lexicons" />
      {hits && (
        <ul className="rs-hits">
          {hits.map((h) => (
            <li key={h.code}><button type="button" className="link-btn" onClick={() => { onPick(h); setQ(''); }}>
              <strong>{h.lemma}</strong> {h.translit} · {h.strongs} · {h.gloss} <span className="muted">{h.count} use{h.count === 1 ? '' : 's'}</span>
            </button></li>
          ))}
          {!hits.length && <li className="muted">Nothing found.</li>}
        </ul>
      )}
    </div>
  );
}

/** The word's entry and uses from the lexicon (null until a word is chosen; { error } when there's no data). */
function useLexicon(ctx) {
  const { code } = ctx.meta.word;
  const [lex, setLex] = useState(null);
  useEffect(() => {
    let live = true;
    setLex(null);
    if (!code) return undefined;
    api.langWord(code, ctx.meta.passage, ctx.meta.allSenses).then((r) => live && setLex(r)).catch((e) => live && setLex({ error: e.message }));
    return () => { live = false; };
  }, [code, ctx.meta.allSenses]); // eslint-disable-line react-hooks/exhaustive-deps
  // The count goes with the study (the note's line "Used 104 times").
  useEffect(() => { if (lex?.count != null && lex.count !== ctx.meta.count) ctx.setM({ count: lex.count }); }, [lex]); // eslint-disable-line react-hooks/exhaustive-deps
  return lex;
}

const pickWord = (ctx, w) => ctx.setM((m) => ({
  word: {
    ...m.word, code: w.code, strongs: w.strongs ?? `${w.code[0]}${Number(w.code.slice(1, 5))}`, lemma: w.lemma, translit: w.lex_translit ?? w.translit ?? m.word.translit,
    lang: w.lang ?? (w.code[0] === 'G' ? 'greek' : 'hebrew'), gloss: w.gloss ?? w.lex_gloss ?? '', pos: w.pos ?? m.word.pos ?? '',
  },
  // Another word: the uses and senses of the old one don't carry over.
  ...(m.word.code && m.word.code !== w.code ? { uses: [], chosen: null } : {}),
}));

function OriginalStep({ ctx }) {
  const lex = useLexicon(ctx);
  const w = ctx.meta.word;
  const [byHand, setByHand] = useState(false);
  // A word picked from the verse has no lexicon translit or part of speech yet: take them from its entry.
  useEffect(() => {
    if (lex?.entry && (lex.entry.translit !== w.translit || lex.entry.pos !== w.pos || lex.entry.lemma !== w.lemma)) {
      ctx.setM((m) => ({ word: { ...m.word, lemma: lex.entry.lemma, translit: lex.entry.translit, pos: lex.entry.pos, gloss: lex.entry.gloss, strongs: lex.entry.strongs, lang: lex.entry.lang } }));
    }
  }, [lex]); // eslint-disable-line react-hooks/exhaustive-deps
  const setW = (patch) => ctx.setM((m) => ({ word: { ...m.word, ...patch } }));
  const link = logosLink(ctx.meta.logos ?? '');
  return (
    <>
      <div className="sb-part">
        <div className="sb-part-head"><strong>In {ctx.meta.passage || 'the verse'}</strong><span className="muted">Click the word you’re studying</span></div>
        <VerseWords verse={ctx.meta.passage} code={w.code} onPick={(x) => pickWord(ctx, x)} />
        <LexiconSearch onPick={(x) => pickWord(ctx, x)} />
      </div>
      {(w.lemma || w.translit) && (
        <div className="sb-card rs-lemma">
          <p className="sb-card-title"><span className="rs-lemma-word" dir="auto">{w.lemma}</span> <span>{w.translit}</span></p>
          <p className="muted">{[langLabel(w), strongsLabel(w), partOfSpeech(w.pos), lex?.count != null && `${lex.count} use${lex.count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>
          {w.gloss && <p><strong>Basic meaning:</strong> {w.gloss}</p>}
          {lex?.senses?.length > 0 && (
            <label className="check-row"><input type="checkbox" checked={!!ctx.meta.allSenses} onChange={(e) => ctx.setM({ allSenses: e.target.checked })} /> Count every entry under {w.strongs} ({lex.senses.map((x) => x.gloss).join('; ')})</label>
          )}
        </div>
      )}
      <button type="button" className="link-btn" onClick={() => setByHand(!byHand)}><Icon name={byHand ? 'chevronDown' : 'chevronRight'} size={13} /> Type it in yourself (a word from the Septuagint, say)</button>
      {byHand && (
        <div className="rs-byhand">
          <label className="field">Hebrew or Greek<input className="input" dir="auto" value={w.lemma} onChange={(e) => setW({ lemma: e.target.value })} /></label>
          <label className="field">Transliteration<input className="input" value={w.translit} onChange={(e) => setW({ translit: e.target.value })} /></label>
          <label className="field">Strong’s<input className="input" value={w.strongs} onChange={(e) => setW({ strongs: e.target.value.toUpperCase().replace(/\s+/g, ''), code: '' })} placeholder="G26" /></label>
          <label className="field">Basic meaning<input className="input" value={w.gloss} onChange={(e) => setW({ gloss: e.target.value })} /></label>
          <label className="field">Language
            <select className="input" value={w.lang} onChange={(e) => setW({ lang: e.target.value })}><option value="">—</option><option value="greek">Greek</option><option value="hebrew">Hebrew</option></select>
          </label>
        </div>
      )}
      <label className="field">Logos link
        <input className="input" value={ctx.meta.logos ?? ''} onChange={(e) => ctx.setM({ logos: e.target.value })} placeholder="Paste a link from Logos (Copy location as → URL), e.g. your Bible Word Study" />
        {ctx.meta.logos?.trim() && !link && <span className="sb-hint">That isn’t a Logos link.</span>}
        {link && <span className="sb-hint"><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a> goes in the note.</span>}
      </label>
      {ctx.field('originalNotes', 'Notes', 3, { hint: WORD_HINTS.originalNotes })}
    </>
  );
}

/** The verse in each translation you have: click a word to take it as that translation's rendering. */
function TranslationsStep({ ctx }) {
  const bible = useBible();
  const [texts, setTexts] = useState({});
  const [extra, setExtra] = useState('');
  const verse = ctx.meta.passage;
  useEffect(() => {
    let live = true;
    setTexts({});
    if (!parse(verse).refs.length) return undefined;
    for (const t of bible.translations) {
      biblePassage(verse, t.id).then((r) => live && setTexts((x) => ({ ...x, [t.label]: r }))).catch(() => {});
    }
    return () => { live = false; };
  }, [verse, bible.translations.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const renderings = ctx.meta.renderings;
  const setR = (label, v) => ctx.setM((m) => ({ renderings: { ...m.renderings, [label]: v } }));
  const labels = [...new Set([...bible.translations.map((t) => t.label), ...Object.keys(renderings)])];
  const take = (label, word, add) => setR(label, add && renderings[label]?.trim() ? `${renderings[label].trim()} ${word}` : word);
  return (
    <>
      {!bible.connected && bible.connected !== null && <p className="muted">Connect a Bible in Settings → Connections → Bible to see the verse here. You can still type how translations render it.</p>}
      <p className="sb-hint">Click the word in each translation (Shift+click adds the next word, for a phrase).</p>
      {labels.map((label) => {
        const p = texts[label];
        const clean = p?.text?.replace(/\[\d+(?::\d+)?\]\s*/g, '').replace(/\s+/g, ' ').trim();
        return (
          <div key={label} className="rs-tr">
            <div className="rs-tr-head">
              <strong>{label}</strong>
              <input className="input" value={renderings[label] ?? ''} onChange={(e) => setR(label, e.target.value)} placeholder="How it renders the word" aria-label={`${label} rendering`} />
            </div>
            {clean && (
              <p className="rs-tr-text">
                {clean.split(/(\s+)/).map((tok, i) => (/\s/.test(tok) ? tok : (
                  <span key={i} role="button" tabIndex={0} className={`rs-tr-word ${(renderings[label] ?? '').toLowerCase().split(/\s+/).includes(tok.replace(/[^\p{L}’'-]/gu, '').toLowerCase()) ? 'is-on' : ''}`}
                    onClick={(e) => take(label, tok.replace(/[^\p{L}’'-]/gu, ''), e.shiftKey)}
                    onKeyDown={(e) => { if (e.key === 'Enter') take(label, tok.replace(/[^\p{L}’'-]/gu, ''), e.shiftKey); }}>{tok}</span>
                )))}
              </p>
            )}
            {clean && <Credit passage={p} className="rs-credit muted" />}
          </div>
        );
      })}
      <form className="rs-tr-add" onSubmit={(e) => { e.preventDefault(); const t = extra.trim().toUpperCase(); if (t && !(t in renderings)) setR(t, ''); setExtra(''); }}>
        <input className="input" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Another translation (KJV, NASB…)" aria-label="Another translation" maxLength={20} />
        <button type="submit" className="btn btn-small" disabled={!extra.trim()}><Icon name="plus" size={13} /> Add</button>
      </form>
      {ctx.field('translationNotes', 'Notes', 3, { hint: WORD_HINTS.translationNotes })}
    </>
  );
}

function RangeStep({ ctx }) {
  const lex = useLexicon(ctx);
  const senses = ctx.meta.senses;
  const setS = (next) => ctx.setM({ senses: next });
  const [showDef, setShowDef] = useStoredState('noteapp.ws.def', true);
  return (
    <>
      {lex?.entry?.def && (
        <div className="sb-card rs-def">
          <button type="button" className="link-btn sb-card-title" onClick={() => setShowDef(!showDef)}>
            <Icon name={showDef ? 'chevronDown' : 'chevronRight'} size={13} /> The lexicon on {lex.entry.lemma} ({lex.entry.translit})
          </button>
          {showDef && <div className="rs-def-body" dir="auto" dangerouslySetInnerHTML={{ __html: lex.entry.def }} />}
          {showDef && <p className="rs-credit muted">{lex.entry.lang === 'greek' ? 'Abbott-Smith, Manual Greek Lexicon of the New Testament' : 'Brief lexicon based on BDB'} · {lex.credit}</p>}
        </div>
      )}
      {lex?.renderings?.length > 0 && (
        <p className="sb-hint">How it’s translated across its uses: {lex.renderings.map((r) => `${r.text} (${r.n})`).join(', ')}.</p>
      )}
      <div className="sb-part">
        <div className="sb-part-head"><strong>Senses</strong><span className="muted">Short, in your own words</span></div>
        <ol className="rs-senses">
          {senses.map((s, i) => (
            <li key={i}>
              <input className="input" value={s.label} onChange={(e) => setS(senses.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Sense (self-giving love)" aria-label={`Sense ${i + 1}`} />
              <input className="input" value={s.note} onChange={(e) => setS(senses.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} placeholder="Note or example (Rom. 5:8)" aria-label={`Sense ${i + 1} note`} />
              <button type="button" className="icon-btn" onClick={() => setS(senses.filter((_, j) => j !== i))} aria-label="Remove this sense"><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-small" onClick={() => setS([...senses, { label: '', note: '' }])}><Icon name="plus" size={13} /> Add a sense</button>
      </div>
      {ctx.field('rangeNotes', 'Notes', 3, { hint: WORD_HINTS.rangeNotes })}
    </>
  );
}

/** One use: its verse (click to read it), whether you looked at it, the sense it carries, a note. */
function Use({ u, ctx, mine }) {
  const [text, setText] = useState(null);
  const [open, setOpen] = useState(false);
  const senses = ctx.meta.senses.filter((s) => s.label.trim());
  const update = ({ looked, ...patch }) => ctx.setM((m) => {
    const others = m.uses.filter((x) => x.key !== u.key);
    const was = m.uses.find((x) => x.key === u.key);
    const next = { key: u.key, ref: u.ref, sense: was?.sense ?? null, note: was?.note ?? '', ...patch };
    return { uses: looked === false ? others : [...others, next] };
  });
  const read = async () => {
    setOpen(!open);
    if (text == null) setText(await biblePassage(u.ref).then((r) => r.text.replace(/\[\d+(?::\d+)?\]\s*/g, '').trim()).catch(() => ''));
  };
  return (
    <li className={`rs-use ${mine ? 'is-looked' : ''}`}>
      <label className="rs-use-check"><input type="checkbox" checked={!!mine} onChange={(e) => update({ looked: e.target.checked })} aria-label={`Looked at ${u.ref}`} /></label>
      <button type="button" className="link-btn rs-use-ref" onClick={read} title="Read the verse">{u.ref}</button>
      <span className="rs-use-gloss muted">{u.surface} · {u.gloss.replace(/[<>[\]]/g, '')}</span>
      {mine && senses.length > 0 && (
        <select className="input rs-use-sense" value={mine.sense ?? ''} onChange={(e) => update({ sense: e.target.value === '' ? null : Number(e.target.value) })} aria-label="Sense">
          <option value="">Sense…</option>
          {ctx.meta.senses.map((s, i) => (s.label.trim() ? <option key={i} value={i}>{i + 1}. {s.label}</option> : null))}
        </select>
      )}
      {open && <p className="rs-use-text">{text == null ? 'Loading…' : text || 'Connect a Bible to read the verse here.'}</p>}
      {mine && open && <input className="input rs-use-note" value={mine.note ?? ''} onChange={(e) => update({ note: e.target.value })} placeholder="A note on this use" aria-label="Note" />}
    </li>
  );
}

function UsageStep({ ctx }) {
  const lex = useLexicon(ctx);
  const [more, setMore] = useState({});
  const mine = new Map(ctx.meta.uses.map((u) => [u.key, u]));
  if (!ctx.meta.word.code) return <><p className="muted">Choose the Hebrew or Greek word in Original Language first; its uses show here.</p>{ctx.field('usageNotes', 'Notes', 4, { hint: WORD_HINTS.usageNotes })}</>;
  if (!lex) return <p className="muted">Finding its uses…</p>;
  if (lex.error) return <><p className="muted">{lex.error}</p>{ctx.field('usageNotes', 'Notes', 4, { hint: WORD_HINTS.usageNotes })}</>;
  const here = parse(ctx.meta.passage).refs[0];
  return (
    <>
      <p className="sb-hint">{lex.count} use{lex.count === 1 ? '' : 's'}. Tick the ones you look at and give each its sense{ctx.meta.senses.some((s) => s.label.trim()) ? '' : ' (add senses in Range of Meaning)'}. Start nearest the verse.</p>
      {lex.groups.map((g) => {
        const limit = more[g.key] ? g.uses.length : 12;
        return (
          <div key={g.key} className="sb-part">
            <div className="sb-part-head"><strong>{g.label}</strong><span className="muted">{g.uses.filter((u) => mine.has(u.key)).length} of {g.total} looked at</span></div>
            <ul className="rs-uses">
              {g.uses.slice(0, limit).filter((u) => !here || u.key < here.start || u.key > here.end).map((u) => <Use key={u.key} u={u} ctx={ctx} mine={mine.get(u.key)} />)}
            </ul>
            {g.uses.length > limit && <button type="button" className="link-btn" onClick={() => setMore({ ...more, [g.key]: true })}>Show all {g.uses.length}</button>}
            {g.total > g.uses.length && <p className="muted">Showing the first {g.uses.length} of {g.total}.</p>}
          </div>
        );
      })}
      <p className="rs-credit muted">{lex.credit}</p>
      {ctx.field('usageNotes', 'Notes', 4, { hint: WORD_HINTS.usageNotes })}
    </>
  );
}

/** The fallacy check: flags only, each saying what to look at again. */
function FallacyCheck({ ctx }) {
  const found = wordFallacies(ctx);
  if (!ctx.text('context') && !ctx.text('keeper')) return null;
  return (
    <div className={`rs-fallacies ${found.length ? '' : 'is-clear'}`}>
      <p className="sb-part-head"><strong><Icon name={found.length ? 'alert' : 'checkCircle'} size={14} /> Fallacy Check</strong><span className="muted">{found.length ? `${found.length} to look at` : 'Nothing flagged'}</span></p>
      {found.map((f) => <p key={f.key}><strong>{f.title}.</strong> {f.detail}</p>)}
    </div>
  );
}
const wordFallacies = (ctx) => fallacies({
  word: ctx.meta.word, senses: ctx.meta.senses, uses: ctx.meta.uses, count: ctx.meta.count ?? 0, chosen: ctx.meta.chosen,
  text: ['context', 'reasons', 'keeper', 'originalNotes', 'rangeNotes'].map((k) => ctx.text(k)).join('\n'),
});

function ContextStep({ ctx }) {
  const senses = ctx.meta.senses;
  return (
    <>
      {senses.some((s) => s.label.trim()) && (
        <div className="sb-part">
          <div className="sb-part-head"><strong>The sense here</strong></div>
          {senses.map((s, i) => (s.label.trim() ? (
            <label key={i} className="check-row"><input type="radio" name="rs-chosen" checked={ctx.meta.chosen === i} onChange={() => ctx.setM({ chosen: i })} /> {i + 1}. {s.label}{s.note ? <span className="muted"> · {s.note}</span> : null}</label>
          ) : null))}
          {ctx.meta.chosen != null && <button type="button" className="link-btn" onClick={() => ctx.setM({ chosen: null })}>Clear</button>}
        </div>
      )}
      {ctx.field('context', 'Meaning Here', 3, { hint: WORD_HINTS.context })}
      {ctx.field('reasons', 'Why This Sense', 4, { hint: WORD_HINTS.reasons })}
      <FallacyCheck ctx={ctx} />
    </>
  );
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const WORD = {
  steps: WORD_STEPS,
  nav: W_NAV,
  icon: 'text',
  noun: 'Word Study',
  guidance: WORD_GUIDE,
  subtitle: (meta) => [meta.word.translit || meta.word.lemma, meta.passage].filter(Boolean).join(' · '),
  init: (s, note) => {
    const d = s.data;
    return {
      title: note.title ?? '', passage: s.passage ?? '', logos: d.logos ?? '',
      word: { english: '', code: '', strongs: '', lemma: '', translit: '', lang: '', gloss: '', pos: '', mark: false, ...(d.word ?? {}) },
      renderings: d.renderings ?? {}, senses: d.senses ?? [], uses: d.uses ?? [], chosen: d.chosen ?? null, count: d.count ?? 0, allSenses: !!d.allSenses,
    };
  },
  passage: (meta) => meta.passage,
  generated: (ctx) => {
    const m = ctx.meta;
    const link = logosLink(m.logos ?? '');
    return {
      original: originalHtml(m.word, m.count) + (link ? `<p><a target="_blank" rel="noopener noreferrer" href="${link.url.replace(/"/g, '&quot;')}">${link.label.replace(/</g, '&lt;')}</a></p>` : ''),
      translations: renderingsHtml(m.renderings),
      range: sensesHtml(m.senses),
      usage: usesHtml(m.uses, m.senses, m.count),
    };
  },
  data: (ctx) => {
    const m = ctx.meta;
    return {
      word: { ...m.word, english: ctx.text('english').split('\n')[0].slice(0, 80) || m.word.english },
      renderings: m.renderings, senses: m.senses, uses: m.uses, chosen: m.chosen, count: m.count, allSenses: m.allSenses, logos: m.logos,
      done: ['english', 'original', 'translations', 'range', 'usage', 'context'].map((k) => WORD.done(ctx)[k === 'english' ? 'word' : k]),
    };
  },
  done: (ctx) => {
    const m = ctx.meta;
    return {
      word: !!ctx.text('english') && !!parse(m.passage).refs.length,
      original: !!(m.word.lemma || m.word.translit),
      translations: Object.values(m.renderings).filter((v) => v.trim()).length >= 2,
      range: m.senses.some((s) => s.label.trim()),
      usage: m.uses.length >= Math.min(5, m.count || 5),
      context: !!ctx.text('context'),
      keeper: !!ctx.completeAt,
    };
  },
  body: (key, ctx) => {
    switch (key) {
      case 'word': return (
        <>
          <label className="field">Title
            <input className="input" value={ctx.meta.title} onChange={(e) => ctx.setM({ title: e.target.value })} placeholder="Love (agapē)" />
          </label>
          <label className="field">Verse
            <input className="input" value={ctx.meta.passage} onChange={(e) => ctx.setM({ passage: e.target.value })} placeholder="1 John 4:8" />
          </label>
          {ctx.field('english', 'English Word', 1, { hint: WORD_HINTS.english, placeholder: 'love' })}
          {ctx.field('why', 'Why It Matters', 3, { hint: WORD_HINTS.why })}
        </>
      );
      case 'original': return <OriginalStep ctx={ctx} />;
      case 'translations': return <TranslationsStep ctx={ctx} />;
      case 'range': return <RangeStep ctx={ctx} />;
      case 'usage': return <UsageStep ctx={ctx} />;
      case 'context': return <ContextStep ctx={ctx} />;
      case 'keeper': {
        const w = ctx.meta.word;
        const english = ctx.text('english').split('\n')[0] || w.english;
        return (
          <>
            {ctx.field('keeper', 'Keeper', 2, { hint: WORD_HINTS.keeper })}
            <FallacyCheck ctx={ctx} />
            <div className="sb-part">
              <div className="sb-part-head"><strong>Hover Cards</strong></div>
              <p className="sb-hint">Wherever your notes have {[w.lemma, w.translit, w.strongs].filter(Boolean).map((x) => `“${x}”`).join(', ') || 'the word'}, hovering it shows this study.</p>
              {english && (
                <label className="check-row">
                  <input type="checkbox" checked={!!w.mark} onChange={(e) => ctx.setM((m) => ({ word: { ...m.word, mark: e.target.checked } }))} />
                  Also wherever I write “{english}”
                </label>
              )}
            </div>
            <Finish ctx={ctx} doneOf={WORD.done(ctx)} what="Word study" />
          </>
        );
      }
      default: return null;
    }
  },
};

export const WordStudyBuilder = ({ noteId, close }) => <LayoutBuilder noteId={noteId} close={close} cfg={WORD} />;

// ---------- starting one ----------

/** Choosing a new word study's word: its verse and English word, and (optionally) its Hebrew or Greek. */
function WordStart({ passage, english: given = '', close }) {
  const [verse, setVerse] = useState(passage);
  const [english, setEnglish] = useState(given);
  const [word, setWord] = useState(null);
  const [library, setLibrary] = useState([]);
  useEffect(() => { api.wordStudies().then(setLibrary).catch(() => {}); }, []);
  const same = word?.code ? library.find((s) => s.code === word.code) : null;
  const ok = parse(verse).refs.length > 0 && (english.trim() || word);
  const pick = (w) => {
    setWord({ code: w.code, lemma: w.lemma, gloss: w.lex_gloss ?? w.gloss ?? '', strongs: w.strongs ?? `${w.code[0]}${Number(w.code.slice(1, 5))}`, translit: w.lex_translit ?? w.translit ?? '', lang: w.code[0] === 'G' ? 'greek' : 'hebrew', pos: w.pos ?? '' });
    if (!english.trim() && w.gloss) setEnglish(w.gloss.replace(/[<>[\]]/g, '').trim().split(/\s+/).pop());
  };
  return (
    <form className="rs-start" onSubmit={(e) => { e.preventDefault(); if (ok) close({ verse, english: english.trim(), word }); }}>
      <div className="dialog-header">
        <h2>Start a Word Study</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <label className="field">Verse<input className="input" value={verse} onChange={(e) => setVerse(e.target.value)} placeholder="1 John 4:8" autoFocus={!passage} /></label>
      <label className="field">English word<input className="input" value={english} onChange={(e) => setEnglish(e.target.value)} placeholder="love" autoFocus={!!passage} /></label>
      <div className="field"><span>Hebrew or Greek <span className="muted">(you can choose it later)</span></span>
        <VerseWords verse={verse} code={word?.code} onPick={pick} />
      </div>
      {same && (
        <p className="sb-warn"><Icon name="alert" size={14} /> You’ve studied {same.lemma} ({same.translit}) already, in “{same.title}”.
          {' '}<button type="button" className="link-btn" onClick={() => close({ open: same.note_id })}>Open it</button></p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!ok}>{same ? 'Start another' : 'Start'}</button>
      </div>
    </form>
  );
}

/** A new word study (one dialog for its word, then the builder). Resolves the note's id once the builder closes. */
export async function newWordStudy(dialog, passage = '', extra = {}, { english = '' } = {}) {
  const r = await dialog.open((close) => <WordStart passage={passage} english={english} close={close} />);
  if (!r) return null;
  try {
    if (r.open) { await openReferenceBuilder(dialog, r.open, 'word'); return r.open; }
    const word = { english: r.english, ...(r.word ?? {}) };
    const title = [capital(r.english), r.word?.translit && `(${r.word.translit})`].filter(Boolean).join(' ') || capital(r.word?.gloss ?? 'Word Study');
    const model = setField(emptyLayout(WORD_STEPS, r.verse), WORD_STEPS, 'english', r.english);
    const html = layoutHtml(model, WORD_STEPS, { passage: r.verse, generated: { original: originalHtml(word, 0) } });
    const s = await api.createBibleStudy({ title, passage: r.verse, html, method: 'word', data: { word }, ...extra });
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    refreshWordLibrary();
    await openReferenceBuilder(dialog, s.note_id, 'word');
    return s.note_id;
  } catch (e) {
    dialog.toast(e.message, 'error');
    return null;
  }
}

/** A new background study of a passage's book (or the one it has). Resolves the note's id once the builder closes. */
export async function newBackground(dialog, passage = '', extra = {}) {
  let q = passage;
  if (!parse(q).refs.length) {
    q = await dialog.prompt({ title: 'Background of a Book', label: 'Book', placeholder: 'Ephesians', okLabel: 'Start' });
    if (!q) return null;
  }
  const r = parse(q).refs[0];
  if (!r) { dialog.toast('That isn’t a book of the Bible.', 'error'); return null; }
  try {
    const name = book(r.book).name;
    const s = await api.createBibleStudy({ passage: name, html: layoutHtml(emptyLayout(BACKGROUND_STEPS, name), BACKGROUND_STEPS, { passage: name }), method: 'background', ...extra });
    if (s.existing) dialog.toast(`${name} already has a background study: here it is`);
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    await openReferenceBuilder(dialog, s.note_id, 'background');
    return s.note_id;
  } catch (e) {
    dialog.toast(e.message, 'error');
    return null;
  }
}

export const openReferenceBuilder = (dialog, noteId, method) => openBuilderPage(noteId, method === 'word' ? 'word' : 'background');

// ---------- in the Interpretive Journey and on the passage page ----------

/** The background of a passage's book, beside a study of it: its facts and keeper, or a button to start one. */
export function BackgroundCard({ passage, compact = false }) {
  const dialog = useDialog();
  const [bg, setBg] = useState(null);
  const load = useCallback(() => {
    if (!parse(passage).refs.length) { setBg(null); return; }
    api.backgroundStudy(passage).then(setBg).catch(() => setBg(null));
  }, [passage]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]);
  if (!bg?.book) return null;
  const s = bg.study;
  const facts = s ? FACT_FIELDS.map(([k, label]) => [label, s.facts?.[k]]).filter(([, v]) => v) : [];
  return (
    <div className={`sb-card rs-bg ${compact ? 'is-compact' : ''}`}>
      <p className="sb-card-title"><Icon name="book" size={14} /> {s ? `Background of ${bg.book}` : `No background study of ${bg.book} yet`}</p>
      {facts.map(([label, v]) => <p key={label} className="rs-bg-fact"><strong>{label}:</strong> {v}</p>)}
      {s?.keeper && <p className="rail-keeper">“{s.keeper}”</p>}
      <span className="rail-meta">
        {s
          ? <button type="button" className="link-btn" onClick={async () => { await openReferenceBuilder(dialog, s.note_id, 'background'); load(); }}>Open the background study</button>
          : <button type="button" className="link-btn" onClick={async () => { await newBackground(dialog, bg.book); load(); }}>Start one: who wrote it, when, to whom, and why</button>}
      </span>
    </div>
  );
}
