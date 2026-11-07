import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { STUDY_KINDS, readingPlan, seriesPlan, writingPlan } from '../studyPlans.js';
import { BOOKS } from '../../../shared/scripture.js';
import { seriesMethod } from '../../../shared/methods.js';
import { SeriesMethodField } from './MethodPicker.jsx';
import { addDays, formatShortDate, todayStr } from '../time.js';

export const STUDY_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'gray'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** New study, or editing one (`study`). Resolves with the study id. */
export function StudyDialog({ study, kind: initialKind = 'self', kinds, tree, close }) {
  const dialog = useDialog();
  const editing = !!study;
  const [kind, setKind] = useState(study?.kind ?? initialKind);
  const [title, setTitle] = useState(study?.title ?? '');
  const [description, setDescription] = useState(study?.description ?? '');
  const [color, setColor] = useState(study?.color ?? 'blue');
  const [start, setStart] = useState(study?.start_date ?? todayStr());
  const [target, setTarget] = useState(study?.target_date ?? '');
  const [notebook] = useState(editing ? String(study.notebook_id ?? '') : 'new'); // 10.1: its own notebook, kept out of sight
  // The method its lessons, sermons or studies follow (null: ask each time).
  const [methods, setMethods] = useState({ lesson: study ? seriesMethod(study.data, 'lesson') : null, sermon: seriesMethod(study?.data, 'sermon'), study: seriesMethod(study?.data, 'study'), writing: seriesMethod(study?.data, 'writing') });
  const [wordGoal, setWordGoal] = useState(study?.data?.wordGoal ? String(study.data.wordGoal) : '');
  const [templates, setTemplates] = useState([]);
  // A class's syllabus (5.15).
  const [syl, setSyl] = useState(() => ({ format: 'online', meetDays: [], meetMinutes: 90, ...(study?.data?.syllabus ?? {}) }));
  const setS = (patch) => setSyl((x) => ({ ...x, ...patch }));
  const [lectureLayout, setLectureLayout] = useState(study?.data?.lectureLayout ?? 'cornell');
  const [busy, setBusy] = useState(false);
  // From a Desk tab, only that tab's kinds (Teach: teaching and sermon series); editing offers them all.
  const shownKinds = Object.entries(STUDY_KINDS).filter(([k]) => editing || !kinds || kinds.includes(k));
  useEffect(() => {
    if (kind === 'teaching') api.listNotes({ templates: 1, sort: 'title' }).then(setTemplates).catch(() => {});
  }, [kind]);

  const save = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const body = { title, kind, description, color, start_date: start || null, target_date: target || null,
      ...(kind === 'teaching' ? { data: { lessonLayout: methods.lesson } } : {}),
      ...(kind === 'preaching' ? { data: { methods: { ...(study?.data?.methods ?? {}), sermon: methods.sermon } } } : {}),
      ...(kind === 'self' ? { data: { methods: { ...(study?.data?.methods ?? {}), study: methods.study } } } : {}),
      ...(kind === 'writing' ? { data: { wordGoal: Number(wordGoal.replace(/[^\d]/g, '')) || null, methods: { ...(study?.data?.methods ?? {}), writing: methods.writing } } } : {}),
      ...(kind === 'class' ? { data: { lectureLayout, syllabus: {
        ...syl, code: (syl.code ?? '').trim() || (/^([A-Z]{2,5} ?\d{3,4}[A-Z]?)\b/.exec(title.trim())?.[1] ?? ''),
        meetMinutes: Number(syl.meetMinutes) || 90,
      } } } : {}) };
    try {
      if (editing) {
        await api.updateStudy(study.id, { ...body, notebook_id: notebook ? Number(notebook) : null });
        close(study.id);
      } else {
        const r = await api.createStudy({ ...body, ...(notebook === 'new' ? { notebook: 'new' } : { notebook_id: notebook ? Number(notebook) : null }) });
        close(r.id);
      }
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="study-dialog" onSubmit={save}>
      <div className="dialog-header">
        <h2>{editing ? 'Edit study' : { self: 'New study plan', teaching: 'New teaching series', writing: 'New writing project', class: 'New class', preaching: 'New sermon series' }[kind]}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      {shownKinds.length > 1 && <div className="study-kinds" role="radiogroup" aria-label="Kind of study">
        {shownKinds.map(([k, v]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`study-kind ${kind === k ? 'is-active' : ''}`} onClick={() => setKind(k)}>
            <Icon name={v.icon} size={18} />
            <strong>{v.label}</strong>
            <span>{v.hint}</span>
          </button>
        ))}
      </div>}
      <label className="field">Title
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={{ self: 'Romans', teaching: 'Wednesday night: Philippians', writing: 'Blog series on the Psalms', class: 'Biblical Hermeneutics', preaching: 'The Sermon on the Mount' }[kind]} />
      </label>
      <label className="field"><span>About it <span className="muted">(optional)</span></span>
        <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {kind === 'class' && (
        <div className="field-row">
          <label className="field narrow">Course code
            <input className="input" value={syl.code ?? ''} onChange={(e) => setS({ code: e.target.value })} placeholder="OBST 520" />
          </label>
          <label className="field">Professor
            <input className="input" value={syl.professor ?? ''} onChange={(e) => setS({ professor: e.target.value })} placeholder="Dr. Smith" />
          </label>
          <label className="field">Term
            <input className="input" value={syl.term ?? ''} onChange={(e) => setS({ term: e.target.value })} placeholder="Fall 2026, B term" />
          </label>
        </div>
      )}
      <div className="field-row">
        <label className="field">{kind === 'class' ? 'First day' : 'Starts'}
          <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field"><span>{kind === 'class' ? 'Last day' : <>Finish by <span className="muted">(optional)</span></>}</span>
          <input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
      </div>
      {kind === 'class' && (
        <>
          <div className="field">How it meets
            <div className="segmented class-format">
              {[['online', 'Online, week by week'], ['in-person', 'In person']].map(([k, l]) => (
                <button key={k} type="button" className={syl.format === k ? 'is-active' : ''} aria-pressed={syl.format === k} onClick={() => setS({ format: k })}>{l}</button>
              ))}
            </div>
          </div>
          {syl.format === 'in-person' && (
            <div className="field-row">
              <div className="field grow">Days
                <div className="day-picks">
                  {DAY_NAMES.map((d, i) => (
                    <button key={d} type="button" aria-pressed={syl.meetDays.includes(i)} className={syl.meetDays.includes(i) ? 'is-active' : ''}
                      onClick={() => setS({ meetDays: syl.meetDays.includes(i) ? syl.meetDays.filter((x) => x !== i) : [...syl.meetDays, i].sort() })}>{d}</button>
                  ))}
                </div>
              </div>
              <label className="field narrow">Time
                <input className="input" type="time" value={syl.meetTime ?? ''} onChange={(e) => setS({ meetTime: e.target.value })} />
              </label>
              <label className="field narrow">Minutes
                <input className="input" type="number" min="5" max="600" value={syl.meetMinutes ?? 90} onChange={(e) => setS({ meetMinutes: e.target.value })} />
              </label>
            </div>
          )}
          {syl.format === 'in-person' && (
            <label className="field">Where <span className="muted">(optional)</span>
              <input className="input" value={syl.location ?? ''} onChange={(e) => setS({ location: e.target.value })} placeholder="Room 204" />
            </label>
          )}
          <div className="field-row">
            <label className="field">Professor’s email <span className="muted">(optional)</span>
              <input className="input" value={syl.contact ?? ''} onChange={(e) => setS({ contact: e.target.value })} />
            </label>
            <label className="field">Office hours <span className="muted">(optional)</span>
              <input className="input" value={syl.officeHours ?? ''} onChange={(e) => setS({ officeHours: e.target.value })} placeholder="Wed 2–4, or by appointment" />
            </label>
          </div>
          <label className="field">Course site <span className="muted">(optional)</span>
            <input className="input" type="url" value={syl.link ?? ''} onChange={(e) => setS({ link: e.target.value })} placeholder="https://canvas…/courses/…" />
          </label>
          <label className="field">Lecture notes are laid out as
            <select className="input" value={lectureLayout} onChange={(e) => setLectureLayout(e.target.value)}>
              <option value="cornell">Cornell notes (cues, notes, summary)</option>
              <option value="plain">Plain notes</option>
            </select>
          </label>
        </>
      )}
      {kind === 'writing' && (
        <label className="field"><span>Word goal <span className="muted">(optional)</span></span>
          <input className="input" inputMode="numeric" value={wordGoal} onChange={(e) => setWordGoal(e.target.value)} placeholder="5,000" />
        </label>
      )}
      {kind === 'teaching' && !editing && (
        <p className="study-course-tip"><Icon name="present" size={14} /> Teaching a book or topic for a quarter or two? <button type="button" className="link-btn" onClick={() => close('course')}>Plan it as a course</button>: a weekly plan with passages, aims, class days on the calendar, and a study before each lesson.</p>
      )}
      {kind === 'teaching' && <SeriesMethodField workflow="lesson" label="Lessons use" templates={templates} value={methods.lesson} onChange={(v) => setMethods((x) => ({ ...x, lesson: v }))} />}
      {kind === 'preaching' && <SeriesMethodField workflow="sermon" label="Sermons use" value={methods.sermon} onChange={(v) => setMethods((x) => ({ ...x, sermon: v }))} />}
      {kind === 'writing' && <SeriesMethodField workflow="writing" label="Project type" value={methods.writing} onChange={(v) => setMethods((x) => ({ ...x, writing: v }))}
        hint="Lays out each new chapter or post, and names them. A book gets front and back matter." />}
      {kind === 'self' && <SeriesMethodField workflow="study" label="Studies use" value={methods.study} onChange={(v) => setMethods((x) => ({ ...x, study: v }))} />}
      <div className="field-row">
        <div className="field">Color
          <div className="swatches">
            {STUDY_COLORS.map((c) => (
              <button key={c} type="button" className={`swatch study-c-${c} ${color === c ? 'is-active' : ''}`} onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c} />
            ))}
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={!title.trim() || busy}>{editing ? 'Save' : 'Create'}</button>
      </div>
    </form>
  );
}

/**
 * Fill the schedule: a reading pace (self-study), a series of sessions (teaching) or writing milestones.
 * Shows what it will add before adding it. Resolves true when items were added.
 */
export function PlanDialog({ study, close }) {
  const dialog = useDialog();
  const mode = { self: 'reading', teaching: 'series', writing: 'writing', class: 'reading', preaching: 'series' }[study.kind];
  const [source, setSource] = useState('bible');
  const [book, setBook] = useState(45); // Romans
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(16);
  const [count, setCount] = useState(12);
  const [label, setLabel] = useState('Chapter');
  const [per, setPer] = useState(1);
  const [start, setStart] = useState(study.start_date && study.start_date > todayStr() ? study.start_date : todayStr());
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [every, setEvery] = useState(7);
  const [skip, setSkip] = useState('');
  const [prefix, setPrefix] = useState(study.kind === 'preaching' ? 'Sermon' : 'Session');
  const [target, setTarget] = useState(study.target_date ?? addDays(todayStr(), 42));
  const [busy, setBusy] = useState(false);
  const b = BOOKS.find((x) => x.order === Number(book));
  useEffect(() => { if (b) { setFrom(1); setTo(b.chapters); } }, [book]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    if (!start) return [];
    const src = { source, book, from, to, count, label, per: Math.max(1, Number(per) || 1) };
    if (mode === 'series') {
      const skips = skip.split(/[\s,]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      return seriesPlan({ start, every: Number(every) || 7, skip: skips, prefix: prefix.trim() || 'Session', ...src });
    }
    if (mode === 'writing') return target && target > start ? writingPlan({ start, target }) : [];
    return days.length ? readingPlan({ start, days, ...src }) : [];
  }, [mode, source, book, from, to, count, label, per, start, days, every, skip, prefix, target]);

  const add = async () => {
    setBusy(true);
    try {
      await api.addStudyItems(study.id, items);
      dialog.toast(`Added ${items.length} to the schedule`);
      close(true);
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };

  const sourceFields = (
    <>
      <div className="segmented plan-source">
        <button type="button" className={source === 'bible' ? 'is-active' : ''} onClick={() => setSource('bible')}>A book of the Bible</button>
        <button type="button" className={source === 'parts' ? 'is-active' : ''} onClick={() => setSource('parts')}>{mode === 'series' ? 'A number of sessions' : 'Chapters or parts'}</button>
      </div>
      {source === 'bible' ? (
        <div className="field-row">
          <label className="field grow">Book
            <select className="input" value={book} onChange={(e) => setBook(Number(e.target.value))}>
              {BOOKS.map((x) => <option key={x.order} value={x.order}>{x.name}</option>)}
            </select>
          </label>
          <label className="field narrow">From ch.
            <input className="input" type="number" min="1" max={b?.chapters} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field narrow">To ch.
            <input className="input" type="number" min="1" max={b?.chapters} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      ) : mode === 'series' ? (
        <div className="field-row">
          <label className="field narrow">Sessions
            <input className="input" type="number" min="1" max="200" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="field-row">
          <label className="field grow">Called
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chapter, Lesson, Week…" />
          </label>
          <label className="field narrow">How many
            <input className="input" type="number" min="1" max="500" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
        </div>
      )}
    </>
  );

  return (
    <div className="plan-dialog">
      <div className="dialog-header">
        <h2>{{ reading: 'Plan the reading', series: 'Plan a series', writing: 'Plan the writing' }[mode]}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      {mode !== 'writing' && sourceFields}
      {mode === 'reading' && (
        <>
          <div className="field-row">
            <label className="field narrow">{source === 'bible' ? 'Chapters' : `${label || 'Part'}s`} a day
              <input className="input" type="number" min="1" max="50" value={per} onChange={(e) => setPer(e.target.value)} />
            </label>
            <label className="field">Start
              <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
          </div>
          <div className="field">On
            <div className="day-picks">
              {DAY_NAMES.map((d, i) => (
                <button key={d} type="button" aria-pressed={days.includes(i)} className={days.includes(i) ? 'is-active' : ''}
                  onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>{d}</button>
              ))}
            </div>
          </div>
        </>
      )}
      {mode === 'series' && (
        <>
          <div className="field-row">
            {source === 'bible' && (
              <label className="field narrow">Chapters each
                <input className="input" type="number" min="1" max="50" value={per} onChange={(e) => setPer(e.target.value)} />
              </label>
            )}
            <label className="field">First session
              <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field narrow">Every
              <select className="input" value={every} onChange={(e) => setEvery(e.target.value)}>
                <option value="7">Week</option>
                <option value="14">2 weeks</option>
                <option value="1">Day</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field grow"><span>Skip dates <span className="muted">(holidays; YYYY-MM-DD, commas)</span></span>
              <input className="input" value={skip} onChange={(e) => setSkip(e.target.value)} placeholder="2026-11-25, 2026-12-23" />
            </label>
            <label className="field narrow">Call them
              <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {mode === 'writing' && (
        <div className="field-row">
          <label className="field">Start
            <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">Finish by
            <input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
        </div>
      )}

      <div className="plan-preview">
        <div className="plan-preview-head">
          <strong>{items.length} to add</strong>
          {items.length > 0 && items[items.length - 1].date && <span className="muted">· last one {formatShortDate(items[items.length - 1].date)}</span>}
        </div>
        <ol>
          {items.slice(0, 6).map((it, i) => (
            <li key={i}><span>{it.title}</span><span className="muted">{it.date ? formatShortDate(it.date) : ''}</span></li>
          ))}
          {items.length > 6 && <li className="muted">…and {items.length - 6} more</li>}
        </ol>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!items.length || busy} onClick={add}>Add to schedule</button>
      </div>
    </div>
  );
}

/**
 * Bring in past classes: pick the class notes, see each one's headings, and keep it whole or split it into a note
 * per section. Each becomes an archived Class study. Resolves with the number of classes made.
 */
export function ArchiveDialog({ close }) {
  const dialog = useDialog();
  const [step, setStep] = useState('pick');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]); // [{ id, title }]
  const [plans, setPlans] = useState({}); // id -> { preview, mode, level, title, open }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => api.listNotes({ q: query, sort: 'title' }).then((r) => setResults(r.slice(0, 40))).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [query]);
  const toggle = (n) => setPicked((p) => (p.some((x) => x.id === n.id) ? p.filter((x) => x.id !== n.id) : [...p, { id: n.id, title: n.title }]));

  const next = async () => {
    setBusy(true);
    const out = {};
    for (const n of picked) {
      try {
        const preview = await api.archivePreview(n.id);
        out[n.id] = { preview, mode: 'keep', level: preview.headings.some((h) => h.level === 1 && !h.week) ? 1 : 2, title: preview.title, weeks: true, clean: true };
      } catch (e) {
        dialog.toast(`${n.title}: ${e.message}`, 'error');
      }
    }
    setPlans(out);
    setStep('choose');
    setBusy(false);
  };
  const set = (id, patch) => setPlans((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  // Turning the checklists or the clean-up off changes what a split makes, so look again.
  const setOption = async (id, patch) => {
    const p = { ...plans[id], ...patch };
    set(id, patch);
    try {
      set(id, { preview: await api.archivePreview(Number(id), { weeks: p.weeks, clean: p.clean }) });
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const go = async () => {
    setBusy(true);
    try {
      const classes = Object.entries(plans).map(([id, p]) => ({ note_id: Number(id), title: p.title, mode: p.mode, level: p.level, weeks: p.weeks, clean: p.clean }));
      const r = await api.archiveClasses(classes);
      const split = classes.filter((c) => c.mode === 'split').length;
      dialog.toast(`Archived ${r.made.length} class${r.made.length === 1 ? '' : 'es'}${split ? '. The original notes of the ones you split are in the Trash.' : ''}`, 'info', 7000);
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(r.made.length);
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="archive-dialog">
      <div className="dialog-header">
        <h2>Bring in past classes</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      {step === 'pick' ? (
        <>
          <p className="muted">Pick the note for each class. You’ll see its headings next and choose how to bring it in. Nothing changes until you confirm.</p>
          <label className="nb-search archive-search">
            <Icon name="search" size={16} className="muted" />
            <input autoFocus placeholder="Find class notes (e.g. OBST, BIBL, THEO)…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="archive-results">
            {results.map((n) => (
              <label key={n.id} className="archive-result">
                <input type="checkbox" checked={picked.some((x) => x.id === n.id)} onChange={() => toggle(n)} />
                <span><strong>{n.title || 'Untitled'}</strong><span className="muted">{n.snippet?.slice(0, 90)}</span></span>
              </label>
            ))}
            {!results.length && <p className="muted">No notes match.</p>}
          </div>
          <div className="modal-actions spread">
            <span className="muted">{picked.length} picked</span>
            <span className="modal-actions-group">
              <button type="button" className="btn" onClick={() => close()}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!picked.length || busy} onClick={next}>Next</button>
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="muted"><strong>Keep</strong> leaves the note as it is and shows its headings as an outline you can jump through. <strong>Split</strong> makes a note per section, named with the course code (the original goes to the Trash, so you can get it back).</p>
          <div className="archive-plans">
            {Object.entries(plans).map(([id, p]) => {
              const { preview } = p;
              const levels = [1, 2, 3].filter((l) => preview.headings.some((h) => h.level === l && !h.week));
              const { weeks } = preview;
              return (
                <div key={id} className="archive-plan">
                  <input className="input archive-title" value={p.title} onChange={(e) => set(id, { title: e.target.value })} aria-label="Class name" />
                  <div className="muted archive-stats">{preview.words.toLocaleString()} words · {preview.headings.length} headings</div>
                  {weeks.count > 0 && (
                    <label className="check-row archive-option"><input type="checkbox" checked={p.weeks} onChange={(e) => setOption(id, { weeks: e.target.checked })} />
                      <span><strong>Make the weekly checklists the class schedule</strong>
                        <span className="muted">{weeks.count} weeks, {weeks.items} items ({weeks.done} ticked), grouped by week and ticked as they were.{p.mode === 'split' ? ' A split leaves them out of the notes.' : ' The note keeps them too.'}</span></span></label>
                  )}
                  {preview.stubs > 0 && (
                    <label className="check-row archive-option"><input type="checkbox" checked={p.clean} onChange={(e) => setOption(id, { clean: e.target.checked })} />
                      <span><strong>Remove the “Content not supported” placeholders</strong>
                        <span className="muted">{preview.stubs} paragraph{preview.stubs === 1 ? '' : 's'} the exporting app left where a block it couldn’t export was.</span></span></label>
                  )}
                  <div className="archive-choice">
                    <label><input type="radio" checked={p.mode === 'keep'} onChange={() => set(id, { mode: 'keep' })} /> Keep as one note</label>
                    {levels.map((l) => (
                      <label key={l}><input type="radio" checked={p.mode === 'split' && p.level === l} onChange={() => set(id, { mode: 'split', level: l })} />
                        {' '}Split at Heading {l} ({preview.splitCounts[l]} notes)</label>
                    ))}
                    {!levels.length && <span className="muted">No headings, so it can only be kept whole.</span>}
                  </div>
                  {preview.headings.length > 0 && (
                    <details className="archive-outline">
                      <summary>Headings</summary>
                      <ul>
                        {preview.headings.slice(0, 80).map((h, i) => (
                          <li key={i} className={`h${h.level} ${h.week ? 'is-week' : p.mode === 'split' && h.level <= p.level ? 'is-cut' : ''}`}>{h.text}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
          <div className="modal-actions spread">
            <button type="button" className="btn" onClick={() => setStep('pick')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={busy || !Object.keys(plans).length} onClick={go}>Bring in {Object.keys(plans).length} class{Object.keys(plans).length === 1 ? '' : 'es'}</button>
          </div>
        </>
      )}
    </div>
  );
}
