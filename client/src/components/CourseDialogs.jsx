import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { useEventCategories } from '../eventCategories.js';
import { STUDY_COLORS } from './StudyDialogs.jsx';
import { AIMS, DAY_NAMES, QUARTER, classDates, planWeeks, weekday } from '../course.js';
import { BOOKS, parse } from '../../../shared/scripture.js';
import { addDays, formatShortDate, todayStr } from '../time.js';
import { seriesMethod } from '../../../shared/methods.js';
import { SeriesMethodField } from './MethodPicker.jsx';

/** The next date on `day` (0 = Sunday) on or after `from`. */
const nextOn = (from, day) => {
  let d = from;
  for (let i = 0; i < 7 && weekday(d) !== day; i += 1) d = addDays(d, 1);
  return d;
};
const STEPS = ['What You’ll Teach', 'When You Meet', 'Course Aims', 'Weekly Plan'];

/** Class day, time and length, the calendar, and holidays: shared by the new-course wizard and Edit course. */
function ClassFields({ v, set, editing = false }) {
  const { categories } = useEventCategories();
  const [skip, setSkip] = useState('');
  return (
    <>
      <div className="field-row">
        <label className="field">First Class
          <input className="input" type="date" value={v.start} onChange={(e) => e.target.value && set({ start: e.target.value, classDay: weekday(e.target.value) })} />
        </label>
        <label className="field course-time"><span>Time <span className="muted">(optional)</span></span>
          <input className="input" type="time" value={v.classTime} onChange={(e) => set({ classTime: e.target.value })} />
        </label>
        <label className="field narrow">Length
          <span className="course-min"><input className="input" type="number" min="5" max="600" value={v.classMinutes} onChange={(e) => set({ classMinutes: e.target.value })} /> min</span>
        </label>
      </div>
      <div className="field">Class Day
        <div className="day-picks" role="radiogroup" aria-label="Class day">
          {DAY_NAMES.map((d, i) => (
            <button key={d} type="button" role="radio" aria-checked={v.classDay === i} className={v.classDay === i ? 'is-active' : ''}
              onClick={() => set({ classDay: i, start: nextOn(v.start, i) })}>{d.slice(0, 3)}</button>
          ))}
        </div>
      </div>
      <div className="field"><span>No Class On <span className="muted">(holidays: the weeks after move back a week)</span></span>
        <div className="course-skips">
          {v.skips.map((d) => (
            <span key={d} className="course-skip-chip">{formatShortDate(d)}
              <button type="button" className="icon-btn" onClick={() => set({ skips: v.skips.filter((x) => x !== d) })} aria-label={`Have class on ${d}`}><Icon name="x" size={12} /></button>
            </span>
          ))}
          <input className="input course-skip-input" type="date" value={skip} onChange={(e) => setSkip(e.target.value)} aria-label="A date with no class" />
          <button type="button" className="btn btn-small" disabled={!skip} onClick={() => { set({ skips: [...new Set([...v.skips, skip])].sort() }); setSkip(''); }}>Add</button>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={v.calendar} onChange={(e) => set({ calendar: e.target.checked })} />
        <span><strong>Put each class on the calendar</strong><span className="muted">On the class day{v.classTime ? ' at the class time' : ' (all day until you set a time)'}, opening that week’s lesson.{editing ? '' : ' Classes move when you skip a date.'}</span></span>
      </label>
      {v.calendar && categories.length > 0 && (
        <label className="field">On the Calendar As
          <select className="input" value={v.category ?? ''} onChange={(e) => set({ category: e.target.value ? Number(e.target.value) : null })}>
            <option value="">The default category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/**
 * A new course: what you'll teach (a book or a topic), when the class meets, the course aims, then the weekly plan
 * (a passage for each week, to adjust). Weeks start empty and are built week by week. Resolves with the new id.
 */
export function NewCourseDialog({ tree, close }) {
  const dialog = useDialog();
  const { defaultId } = useEventCategories();
  const [step, setStep] = useState(0);
  const [v, setV] = useState(() => {
    const start = nextOn(todayStr(), 0);
    return {
      type: 'book', book: 50, from: 1, to: 4, topic: '', title: '', titleSet: false, description: '',
      start, classDay: 0, classTime: '', classMinutes: 45, skips: [], calendar: true, category: null,
      weeks: QUARTER, custom: false, recap: true, notebook: 'new', color: 'green', aims: { know: '', feel: '', do: '' },
    };
  });
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  const b = BOOKS.find((x) => x.order === Number(v.book));
  const title = v.titleSet ? v.title : v.type === 'book' ? (b ? (v.from > 1 || v.to < b.chapters ? `${b.name} ${v.from}–${v.to}` : b.name) : '') : v.topic;
  const n = Math.max(1, Math.min(60, Number(v.weeks) || QUARTER));
  const planKey = JSON.stringify([v.type, v.book, v.from, v.to, n, v.recap]);
  const [plan, setPlan] = useState({ key: '', weeks: [] });
  useEffect(() => {
    if (step === 3 && plan.key !== planKey) setPlan({ key: planKey, weeks: planWeeks({ ...v, weeks: n }) });
  }, [step, planKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dates = useMemo(() => classDates(v.start, v.classDay, plan.weeks.length, v.skips), [v.start, v.classDay, plan.weeks.length, v.skips]);
  const span = useMemo(() => classDates(v.start, v.classDay, n, v.skips), [v.start, v.classDay, n, v.skips]);
  const [busy, setBusy] = useState(false);

  const canNext = [
    !!title.trim() && (v.type === 'topic' || !!b),
    !!v.start && n >= 1,
    true,
    plan.weeks.length > 0,
  ][step];
  const setWeek = (i, patch) => setPlan((p) => ({ ...p, weeks: p.weeks.map((w, j) => (j === i ? { ...w, ...patch } : w)) }));
  const badRef = (r) => r.trim() && (parse(r).errors.length > 0 || !parse(r).refs.length);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createCourse({
        title: title.trim(), description: v.description, color: v.color,
        ...(v.notebook === 'new' ? { notebook: 'new' } : { notebook_id: v.notebook ? Number(v.notebook) : null }),
        start_date: v.start, classMinutes: Number(v.classMinutes) || 45, calendarCategory: v.category ?? defaultId ?? null,
        course: { type: v.type, book: v.type === 'book' ? Number(v.book) : null, from: Number(v.from), to: Number(v.to), topic: v.topic, classDay: v.classDay, classTime: v.classTime || null, calendar: v.calendar, skips: v.skips, aims: v.aims },
        weeks: plan.weeks.map((w) => ({ title: w.title.trim() || w.ref.trim() || (w.recap ? 'Review and Preview' : ''), ref: w.ref.trim(), recap: !!w.recap })),
      });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(r.id);
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };

  const body = [
    (
      <>
        <div className="segmented course-type" role="radiogroup" aria-label="What the course teaches">
          <button type="button" role="radio" aria-checked={v.type === 'book'} className={v.type === 'book' ? 'is-active' : ''} onClick={() => set({ type: 'book' })}><Icon name="bible" size={14} /> A book of the Bible</button>
          <button type="button" role="radio" aria-checked={v.type === 'topic'} className={v.type === 'topic' ? 'is-active' : ''} onClick={() => set({ type: 'topic' })}><Icon name="tag" size={14} /> A topic</button>
        </div>
        {v.type === 'book' ? (
          <div className="field-row">
            <label className="field grow">Book
              <select className="input" value={v.book} onChange={(e) => { const x = BOOKS.find((y) => y.order === Number(e.target.value)); set({ book: Number(e.target.value), from: 1, to: x?.chapters ?? 1 }); }}>
                {BOOKS.map((x) => <option key={x.order} value={x.order}>{x.name}</option>)}
              </select>
            </label>
            <label className="field narrow">From Ch.
              <input className="input" type="number" min="1" max={b?.chapters} value={v.from} onChange={(e) => set({ from: Math.max(1, Math.min(Number(e.target.value) || 1, b?.chapters ?? 1)) })} />
            </label>
            <label className="field narrow">To Ch.
              <input className="input" type="number" min="1" max={b?.chapters} value={v.to} onChange={(e) => set({ to: Math.max(1, Math.min(Number(e.target.value) || 1, b?.chapters ?? 1)) })} />
            </label>
          </div>
        ) : (
          <label className="field">Topic
            <input className="input" autoFocus value={v.topic} onChange={(e) => set({ topic: e.target.value })} placeholder="Prayer, The Attributes of God, Spiritual Disciplines…" />
          </label>
        )}
        <label className="field">Course Title
          <input className="input" value={title} onChange={(e) => set({ title: e.target.value, titleSet: true })} placeholder="Philippians: Joy in Christ" />
        </label>
        <label className="field"><span>About It <span className="muted">(optional)</span></span>
          <textarea className="input" rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="Sunday morning adult class" />
        </label>
        <div className="field-row">
          <div className="field">Color
            <div className="swatches">
              {STUDY_COLORS.map((c) => <button key={c} type="button" className={`swatch study-c-${c} ${v.color === c ? 'is-active' : ''}`} onClick={() => set({ color: c })} aria-label={c} aria-pressed={v.color === c} />)}
            </div>
          </div>
        </div>
      </>
    ),
    (
      <>
        <div className="field">How Long
          <div className="course-length">
            <div className="segmented" role="radiogroup" aria-label="Course length">
              {[[13, 'One quarter (13 weeks)'], [26, 'Two quarters (26 weeks)']].map(([w, l]) => (
                <button key={w} type="button" role="radio" aria-checked={!v.custom && n === w} className={!v.custom && n === w ? 'is-active' : ''} onClick={() => set({ weeks: w, custom: false })}>{l}</button>
              ))}
              <button type="button" role="radio" aria-checked={v.custom} className={v.custom ? 'is-active' : ''} onClick={() => set({ custom: true })}>Other</button>
            </div>
            {v.custom && <span className="course-min"><input className="input" type="number" min="1" max="60" value={v.weeks} onChange={(e) => set({ weeks: e.target.value })} aria-label="Weeks" /> weeks</span>}
          </div>
        </div>
        <ClassFields v={v} set={set} />
        {span.length > 0 && <p className="muted course-span">{n} classes from {formatShortDate(span[0])} to {formatShortDate(span.at(-1))}.</p>}
      </>
    ),
    (
      <>
        <p className="course-intro">Richards and Bredfeldt ask what a course should do in a learner’s head, heart and hands. Aim at all three, and let each week’s Took move toward the last one. You can write or change these later.</p>
        {AIMS.map((a) => (
          <label key={a.key} className="field">{a.label}
            <span className="muted field-hint">{a.hint}</span>
            <textarea className="input" rows={2} value={v.aims[a.key]} onChange={(e) => set({ aims: { ...v.aims, [a.key]: e.target.value } })} placeholder={a.placeholder} />
          </label>
        ))}
      </>
    ),
    (
      <>
        <p className="course-intro">{v.type === 'book'
          ? 'A passage for each week, about the same length. Adjust them to the passage’s own paragraphs; you build each week (study, then lesson) when you get to it.'
          : 'Name each week and give it a passage if you know it. You build each week (study, then lesson) when you get to it.'}</p>
        {n > QUARTER && (
          <label className="check-row">
            <input type="checkbox" checked={v.recap} onChange={(e) => set({ recap: e.target.checked })} />
            <span><strong>Make week 13 a review and preview week</strong><span className="muted">A break between the quarters: what you’ve covered and where you’re going.</span></span>
          </label>
        )}
        <ol className="course-plan">
          {plan.weeks.map((w, i) => (
            <li key={i} className={w.recap ? 'is-recap' : ''}>
              {i === QUARTER && <span className="course-plan-q">Quarter 2</span>}
              <span className="course-plan-n">{i + 1}</span>
              <span className="course-plan-date">{dates[i] ? formatShortDate(dates[i]) : ''}</span>
              {v.type === 'topic' || w.recap ? (
                <input className="input" value={w.title} onChange={(e) => setWeek(i, { title: e.target.value })} placeholder={w.recap ? 'Review and Preview' : `Week ${i + 1} topic`} aria-label={`Week ${i + 1} title`} />
              ) : null}
              {!w.recap && (
                <input className={`input ${badRef(w.ref) ? 'is-invalid' : ''}`} value={w.ref} onChange={(e) => setWeek(i, { ref: e.target.value, ...(v.type === 'book' ? { title: e.target.value } : {}) })}
                  placeholder="Passage" aria-label={`Week ${i + 1} passage`} title={badRef(w.ref) ? 'That doesn’t read as a Bible reference' : undefined} />
              )}
            </li>
          ))}
        </ol>
        <p className="sb-hint">
          <button type="button" className="link-btn" onClick={() => setPlan({ key: planKey, weeks: planWeeks({ ...v, weeks: n }) })}>Suggest again</button>
          {v.skips.length > 0 && ` · No class on ${v.skips.map(formatShortDate).join(', ')}`}
        </p>
      </>
    ),
  ][step];

  return (
    <div className="course-dialog">
      <div className="dialog-header">
        <h2>New Course</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <ol className="course-steps" aria-label="Steps">
        {STEPS.map((l, i) => (
          <li key={l} className={`${i === step ? 'is-active' : ''} ${i < step ? 'is-done' : ''}`}>
            <button type="button" disabled={i > step && !canNext} onClick={() => (i <= step || canNext) && setStep(i)} aria-current={i === step ? 'step' : undefined}>
              <span className="course-step-n">{i < step ? <Icon name="check" size={11} /> : i + 1}</span>{l}
            </button>
          </li>
        ))}
      </ol>
      <div className="course-body">{body}</div>
      <div className="modal-actions spread">
        <button type="button" className="btn" onClick={() => (step ? setStep(step - 1) : close())}>{step ? <><Icon name="chevronLeft" size={14} /> Back</> : 'Cancel'}</button>
        {step < STEPS.length - 1
          ? <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]} <Icon name="chevronRight" size={14} /></button>
          : <button type="button" className="btn btn-primary" disabled={!canNext || busy} onClick={create}>{busy ? 'Making it…' : 'Create course'}</button>}
      </div>
    </div>
  );
}

/** Edit course: its name, the class day, time and length, the start date, holidays and the calendar. Resolves true when saved. */
export function CourseSettingsDialog({ c, tree, close }) {
  const dialog = useDialog();
  const [v, setV] = useState({
    title: c.title, description: c.description ?? '', color: c.color ?? 'green', notebook: String(c.notebook_id ?? ''),
    start: c.start_date ?? todayStr(), classDay: c.course.classDay ?? weekday(c.start_date ?? todayStr()), classTime: c.course.classTime ?? '',
    classMinutes: c.classMinutes ?? 45, skips: c.course.skips ?? [], calendar: c.course.calendar !== false, category: c.calendarCategory ?? null,
    lessonMethod: seriesMethod(c.data, 'lesson'),
  });
  const [templates, setTemplates] = useState([]);
  useEffect(() => { api.listNotes({ templates: 1, sort: 'title' }).then(setTemplates).catch(() => {}); }, []);
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateCourse(c.id, {
        title: v.title, description: v.description, color: v.color, notebook_id: v.notebook ? Number(v.notebook) : null,
        start_date: v.start, classMinutes: Number(v.classMinutes) || 45, calendarCategory: v.category,
        course: { classDay: v.classDay, classTime: v.classTime || null, skips: v.skips, calendar: v.calendar },
      });
      if (v.lessonMethod !== seriesMethod(c.data, 'lesson')) await api.updateStudy(c.id, { data: { lessonLayout: v.lessonMethod } });
      close(true);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="course-dialog" onSubmit={save}>
      <div className="dialog-header">
        <h2>Edit Course</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="course-body">
        <label className="field">Course Title
          <input className="input" value={v.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field"><span>About It <span className="muted">(optional)</span></span>
          <textarea className="input" rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <ClassFields v={v} set={set} editing />
        <SeriesMethodField workflow="lesson" label="Lessons Use" templates={templates} value={v.lessonMethod} onChange={(x) => set({ lessonMethod: x })} />
        <div className="field-row">
          <div className="field">Color
            <div className="swatches">
              {STUDY_COLORS.map((col) => <button key={col} type="button" className={`swatch study-c-${col} ${v.color === col ? 'is-active' : ''}`} onClick={() => set({ color: col })} aria-label={col} aria-pressed={v.color === col} />)}
            </div>
          </div>
        </div>
        <p className="muted course-span">Changing the first class, the class day or the holidays moves every week’s date; each week keeps its passage and lesson.</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={!v.title.trim() || busy}>Save</button>
      </div>
    </form>
  );
}

/** Teach it again: the same course on new dates, lessons copied as drafts with last time's notes beside them. Resolves the new id. */
export function TeachAgainDialog({ c, close }) {
  const dialog = useDialog();
  const last = c.weeks.at(-1)?.date ?? todayStr();
  const day = c.course.classDay ?? 0;
  const [title, setTitle] = useState(c.title);
  const [start, setStart] = useState(nextOn(addDays(last > todayStr() ? last : todayStr(), 7), day));
  const [finishOld, setFinishOld] = useState(c.status === 'active');
  const [busy, setBusy] = useState(false);
  const written = c.weeks.filter((w) => w.lesson).length;
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.teachAgain(c.id, { title, start_date: start, classDay: weekday(start), finishOld });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      close(r.id);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="course-dialog course-dialog-small" onSubmit={go}>
      <div className="dialog-header">
        <h2>Teach It Again</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="course-intro">A new course with the same {c.weeks.length} weeks, aims and class plan. {written ? `The ${written} lesson${written === 1 ? '' : 's'} you wrote are copied as drafts to revise, ` : ''}each week keeps its study, and your after-class notes from this time show beside each week.</p>
      <label className="field">Course Title
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">First Class
        <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="muted field-hint">Classes on {DAY_NAMES[weekday(start)]}s{c.course.classTime ? ` at ${c.course.classTime}` : ''}.</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={finishOld} onChange={(e) => setFinishOld(e.target.checked)} />
        <span><strong>Mark “{c.title}” finished</strong><span className="muted">It moves to Finished in Studies, with its lessons as you taught them.</span></span>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={!title.trim() || !start || busy}><Icon name="repeat" size={14} /> Make the new course</button>
      </div>
    </form>
  );
}

const REACHED = [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'Not really']];
export const reachedLabel = (k) => REACHED.find(([x]) => x === k)?.[1] ?? '';

/** After class: did they reach the Took, what worked, what to change. Resolves true when saved. */
export function ReflectionDialog({ week, close }) {
  const dialog = useDialog();
  const r0 = week.reflection ?? {};
  const [r, setR] = useState({ reached: r0.reached ?? '', worked: r0.worked ?? '', change: r0.change ?? '', notes: r0.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.setWeekReflection(week.id, r);
      close(true);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="course-dialog course-dialog-small" onSubmit={save}>
      <div className="dialog-header">
        <h2>After Class: Week {week.week}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">{week.lesson?.title ?? week.title}{week.ref && !(week.lesson?.title ?? week.title).includes(week.ref) ? ` · ${week.ref}` : ''}</p>
      {week.lesson?.took && <p className="sb-quote"><span className="muted">The Took</span> {week.lesson.took}</p>}
      <div className="field">Did the Class Reach the Took?
        <div className="segmented" role="radiogroup" aria-label="Did the class reach the Took">
          {REACHED.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={r.reached === k} className={r.reached === k ? 'is-active' : ''} onClick={() => setR({ ...r, reached: r.reached === k ? '' : k })}>{l}</button>)}
        </div>
      </div>
      <label className="field">What Worked
        <textarea className="input" rows={2} value={r.worked} onChange={(e) => setR({ ...r, worked: e.target.value })} placeholder="The case study got everyone talking" />
      </label>
      <label className="field">What to Change Next Time
        <textarea className="input" rows={2} value={r.change} onChange={(e) => setR({ ...r, change: e.target.value })} placeholder="Too long in the Book; cut the cross-references" />
      </label>
      <label className="field">Other Notes <span className="muted">(prayer needs, questions to answer next week)</span>
        <textarea className="input" rows={2} value={r.notes} onChange={(e) => setR({ ...r, notes: e.target.value })} />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>Save notes</button>
      </div>
    </form>
  );
}

/** One of your Bible studies for a week (studies of its passage first). Resolves the study's note id. */
export function PickStudyDialog({ week, close }) {
  const [all, setAll] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.bibleStudies().then(setAll).catch(() => setAll([])); }, []);
  const refs = parse(week.ref ?? '').refs;
  const onPassage = (s) => (s.refs ?? []).some((x) => refs.some((y) => x.start <= y.end && x.end >= y.start));
  const shown = (all ?? []).filter((s) => !s.trashed && (!q.trim() || `${s.title} ${s.passage}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, z) => onPassage(z) - onPassage(a));
  return (
    <div className="course-dialog course-dialog-small">
      <div className="dialog-header">
        <h2>Use a Study You’ve Done</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">For week {week.week}{week.ref ? ` (${week.ref})` : ''}. Its lesson is written from the study you pick.</p>
      <label className="nb-search">
        <Icon name="search" size={16} className="muted" />
        <input autoFocus placeholder="Find a study…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ul className="course-pick">
        {shown.slice(0, 50).map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => close(s.note_id)}>
              <Icon name="bible" size={14} />
              <span><strong>{s.title || 'Untitled'}</strong><span className="muted">{s.passage}{s.data?.keeper ? ` · ${s.data.keeper}` : ''}</span></span>
              {onPassage(s) && <span className="course-pick-tag">This passage</span>}
            </button>
          </li>
        ))}
        {all && !shown.length && <li className="muted">No studies match.</li>}
        {!all && <li className="muted">Loading…</li>}
      </ul>
    </div>
  );
}

/** A week's title and passage (and whether it's a review week). Resolves true when saved. */
export function WeekDialog({ week, close }) {
  const dialog = useDialog();
  const [title, setTitle] = useState(week.title);
  const [ref, setRef] = useState(week.ref ?? '');
  const [recap, setRecap] = useState(!!week.recap);
  const bad = ref.trim() && (parse(ref).errors.length > 0 || !parse(ref).refs.length);
  const save = async (e) => {
    e.preventDefault();
    try {
      // A week named after its passage keeps following it.
      const t = title.trim() === (week.ref ?? '').trim() || !title.trim() ? ref.trim() || title.trim() : title.trim();
      await api.updateStudyItem(week.id, { title: t || `Week ${week.week}`, ref: ref.trim(), data: { recap } });
      close(true);
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };
  return (
    <form className="course-dialog course-dialog-small" onSubmit={save}>
      <div className="dialog-header">
        <h2>Week {week.week}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <label className="field">Passage
        <input className={`input ${bad ? 'is-invalid' : ''}`} autoFocus value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Philippians 2:1–11" />
        {bad && <span className="field-hint lb-over">That doesn’t read as a Bible reference.</span>}
      </label>
      <label className="field">Title <span className="muted">(the passage, unless you name it)</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Mind of Christ" />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={recap} onChange={(e) => setRecap(e.target.checked)} />
        <span><strong>A review week</strong><span className="muted">Looking back over the course so far, so it doesn’t need a study first.</span></span>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary">Save</button>
      </div>
    </form>
  );
}
