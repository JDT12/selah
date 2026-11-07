import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Menu, useDialog } from './Dialogs.jsx';
import { api } from '../api.js';
import { formatShortDate, relativeDay, todayStr } from '../time.js';
import { CourseSettingsDialog, PickStudyDialog, ReflectionDialog, TeachAgainDialog, WeekDialog, reachedLabel } from './CourseDialogs.jsx';
import ExportWordDialog from './ExportWordDialog.jsx';
import { presentNote, printHandout } from './PresentMode.jsx';
import { teachNote } from './PreachMode.jsx';
import { openShare } from './SharingDialogs.jsx';
import { serverMode } from '../mode.js';
import { newStudy, openStudyBuilder } from './StudyBuilder.jsx';
import { openLessonBuilder, writeLesson } from './LessonBuilder.jsx';
import { chooseMethod } from './MethodPicker.jsx';
import { useEventCategories } from '../eventCategories.js';
import { AIMS, DAY_NAMES, LEVELS, QUARTER, weekSteps } from '../course.js';
import { lessonFromStudy, parseStudy } from '../bibleStudy.js';
import { isLessonNote } from '../lesson.js';
import { BOOKS } from '../../../shared/scripture.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
/** "09:30" → "9:30 AM". */
const timeLabel = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const STEP_LABELS = { study: 'Study', lesson: 'Lesson', teach: 'Teach', notes: 'Notes' };
const STEP_ICONS = { study: 'bible', lesson: 'present', teach: 'play', notes: 'pen' };

/**
 * A course: the weekly plan with where each week stands (study, lesson, teach, after-class notes) and its next step,
 * what's up next, the aims beside every week's Took, the levels of learning the lessons reach, and the class plan.
 */
export default function CourseView({ id, tree, onBack, backLabel = 'Teach', onOpenNote, onChanged, onMenu, StudyNotes }) {
  const dialog = useDialog();
  const { categories } = useEventCategories();
  const [c, setC] = useState(null);
  const load = useCallback(() => api.course(id).then(setC).catch((e) => { dialog.toast(e.message, 'error'); onBack(); }), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  // The builders save from dialogs over this page; it follows along.
  useEffect(() => {
    const on = () => load();
    window.addEventListener('noteapp:notes-changed', on);
    return () => window.removeEventListener('noteapp:notes-changed', on);
  }, [load]);
  const changed = () => { load(); onChanged(); };
  const t = todayStr();

  const timeline = useMemo(() => {
    if (!c) return [];
    // The weeks, with the skipped class dates (holidays) between them.
    const rows = c.weeks.map((w) => ({ kind: 'week', w, date: w.date ?? '9999' }));
    const first = c.weeks[0]?.date;
    const last = c.weeks.at(-1)?.date;
    for (const d of c.course.skips ?? []) if (first && last && d >= first && d <= last) rows.push({ kind: 'skip', date: d });
    return rows.sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : a.kind === 'skip' ? -1 : 1));
  }, [c]);

  if (!c) return <div className="page studies-page"><p className="muted">Loading…</p></div>;

  const next = c.weeks.find((w) => w.id === c.next) ?? null;
  const taught = c.weeks.filter((w) => w.done).length;
  const written = c.weeks.filter((w) => w.lesson).length;
  const b = c.course.type === 'book' && BOOKS.find((x) => x.order === c.course.book);
  const category = categories.find((x) => x.id === c.calendarCategory);
  const classLine = `${[c.course.classDay != null && `${DAY_NAMES[c.course.classDay]}s`, c.course.classTime && `at ${timeLabel(c.course.classTime)}`].filter(Boolean).join(' ')} · ${c.classMinutes} min`;

  // ---- what each step does ----
  const openNote = (noteId) => Promise.resolve(onOpenNote(noteId)).then(load);
  const studyIt = async (w) => { await newStudy(dialog, w.ref, { course_item_id: w.id }, { studyId: c.id }); changed(); };
  const openStudy = async (w) => {
    if (w.study.is_study) { await openStudyBuilder(dialog, w.study.note_id); changed(); } else openNote(w.study.note_id);
  };
  const useStudy = async (w, noteId) => {
    const pick = noteId ?? await dialog.open((close) => <PickStudyDialog week={w} close={close} />);
    if (!pick) return;
    try { await api.setWeekStudy(w.id, pick); dialog.toast(`Week ${w.week} uses that study`); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const openLesson = async (noteId) => {
    const note = await api.getNote(noteId).catch(() => null);
    if (note && isLessonNote(note.html)) { await openLessonBuilder(dialog, noteId); changed(); } else openNote(noteId);
  };
  const lessonFromWeekStudy = async (w) => {
    try {
      const [bs, note] = await Promise.all([api.noteBibleStudy(w.study.note_id), api.getNote(w.study.note_id)]);
      if (!bs) throw new Error('That note isn’t a Bible study any more');
      const method = await chooseMethod(dialog, 'lesson', { studyId: c.id });
      if (method == null) return;
      const r = await api.studyToLesson(bs.id, { item_id: w.id, material: lessonFromStudy(parseStudy(note.html)), method });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      await openLesson(r.note_id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const lesson = async (w, { skipStudy = false } = {}) => {
    if (w.lesson) return openLesson(w.lesson.note_id);
    if (w.study?.is_study) return lessonFromWeekStudy(w);
    if (!w.recap && !skipStudy) {
      const choice = await dialog.choose({
        title: `Week ${w.week}: Study First?`,
        message: 'A lesson grows out of your study of the passage: your summary, principle, questions and application carry over into it.',
        options: [
          w.ref && { value: 'study', label: 'Study the passage first' },
          w.suggested?.length > 0 && { value: 'use', label: `Use your study “${w.suggested[0].title}”` },
          { value: 'write', label: 'Write the lesson without a study' },
        ].filter(Boolean),
        value: w.suggested?.length ? 'use' : w.ref ? 'study' : 'write',
        okLabel: 'Go',
      });
      if (!choice) return null;
      if (choice === 'study') return studyIt(w);
      if (choice === 'use') return useStudy(w, w.suggested[0].note_id);
    }
    await writeLesson(dialog, w.id, openNote, c.id);
    return changed();
  };
  const setTaught = async (w, done = !w.done) => {
    await api.updateStudyItem(w.id, { done });
    changed();
    if (done && !w.reflection) {
      dialog.toast(`Week ${w.week} taught`, 'info', 7000, { label: 'Add after-class notes', onClick: () => reflect(w) });
    }
  };
  const reflect = async (w) => { if (await dialog.open((close) => <ReflectionDialog week={w} close={close} />)) changed(); };
  const editWeek = async (w) => { if (await dialog.open((close) => <WeekDialog week={w} close={close} />)) changed(); };
  const run = async (fn, msg) => { try { const r = await fn(); if (msg) dialog.toast(msg); changed(); return r; } catch (e) { dialog.toast(e.message, 'error'); return null; } };
  const move = (w, by) => {
    const ids = c.weeks.map((x) => x.id);
    const i = ids.indexOf(w.id);
    if (i + by < 0 || i + by >= ids.length) return;
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    run(() => api.orderCourseWeeks(c.id, ids));
  };
  const removeWeek = async (w) => {
    const ok = await dialog.confirm({ title: `Delete week ${w.week}?`, message: 'The weeks after it move up a week. Its study and lesson stay in your notes.', okLabel: 'Delete week', danger: true });
    if (ok) run(() => api.deleteCourseWeek(w.id));
  };

  /** The one thing to do next for a week. */
  const action = (w, big = false) => {
    const s = weekSteps(w, t);
    // The week up next gets the one strong button; the rest stay quiet.
    const cls = `btn ${big ? '' : 'btn-small'} ${s.next !== 'done' && (big || w.id === c.next) ? 'btn-primary' : ''}`;
    switch (s.next) {
      case 'passage': return <button type="button" className={cls} onClick={() => editWeek(w)}><Icon name="bible" size={13} /> Set the passage</button>;
      case 'study': return <button type="button" className={cls} onClick={() => studyIt(w)}><Icon name="bible" size={13} /> Study it</button>;
      case 'lesson': return <button type="button" className={cls} onClick={() => lesson(w)}><Icon name="present" size={13} /> Write lesson</button>;
      case 'taught': return <button type="button" className={cls} onClick={() => setTaught(w, true)}><Icon name="check" size={13} /> Mark taught</button>;
      case 'open': return <button type="button" className={`btn ${big ? '' : 'btn-small'}`} onClick={() => lesson(w)}><Icon name="present" size={13} /> {w.lesson?.complete ? 'Lesson' : 'Finish lesson'}</button>;
      case 'notes': return <button type="button" className={cls} onClick={() => reflect(w)}><Icon name="pen" size={13} /> After-class notes</button>;
      default: return <span className="course-done"><Icon name="checkCircle" size={14} /> Done</span>;
    }
  };
  /** The four steps as pips; each opens its step. */
  const pips = (w) => {
    const s = weekSteps(w, t);
    const open = {
      study: () => (w.study ? openStudy(w) : w.ref ? studyIt(w) : editWeek(w)),
      lesson: () => lesson(w),
      teach: async () => { if (!w.lesson) return lesson(w); await teachNote(dialog, w.lesson.note_id); return changed(); },
      notes: () => reflect(w),
    };
    return (
      <span className="course-pips">
        {['study', 'lesson', 'teach', 'notes'].map((k) => (
          <button key={k} type="button" className={`course-pip is-${s[k]}`} onClick={open[k]}
            title={`${STEP_LABELS[k]}: ${{ done: 'done', started: 'started', todo: 'not yet', skip: 'not needed for a review week' }[s[k]]}`} aria-label={`${STEP_LABELS[k]} (${s[k]})`}>
            <Icon name={s[k] === 'done' ? 'check' : STEP_ICONS[k]} size={11} />
          </button>
        ))}
      </span>
    );
  };
  const weekMenu = (w) => [
    { label: 'Edit the week…', onClick: () => editWeek(w) },
    !w.recap && (w.study ? { label: 'Open the study', onClick: () => openStudy(w) } : w.ref && { label: 'Study it in the study builder', onClick: () => studyIt(w) }),
    !w.recap && { label: w.study ? 'Use a different study…' : 'Use a study you’ve done…', onClick: () => useStudy(w) },
    w.study && !w.lesson && { label: 'Take the study off this week', onClick: () => run(() => api.setWeekStudy(w.id, null)) },
    !w.lesson && !w.recap && { label: 'Write the lesson without a study', onClick: () => lesson(w, { skipStudy: true }) },
    w.lesson && { label: 'Lesson builder', onClick: () => lesson(w) },
    w.lesson && { label: 'Teach the lesson', onClick: async () => { await teachNote(dialog, w.lesson.note_id); changed(); } },
    w.lesson && { label: 'Present the lesson', onClick: () => presentNote(dialog, w.lesson.note_id) },
    w.lesson && { label: 'Print a class handout…', onClick: () => printHandout(dialog, w.lesson.note_id, { mainPoints: true }) },
    'sep',
    { label: w.done ? 'Mark not taught' : 'Mark taught', onClick: () => setTaught(w) },
    { label: w.reflection ? 'Edit after-class notes…' : 'After-class notes…', onClick: () => reflect(w) },
    'sep',
    w.date && { label: `No class on ${formatShortDate(w.date)} (holiday)`, onClick: () => run(() => api.skipClass(c.id, w.date), `No class on ${formatShortDate(w.date)}. Week ${w.week} and after moved back a week.`) },
    { label: 'Insert a week before', onClick: () => run(() => api.addCourseWeek(c.id, { before: w.id, title: 'New week' })) },
    w.week > 1 && { label: 'Move up', onClick: () => move(w, -1) },
    w.week < c.weeks.length && { label: 'Move down', onClick: () => move(w, 1) },
    'sep',
    { label: 'Delete week…', danger: true, onClick: () => removeWeek(w) },
  ];

  const setStatus = async (status) => { await api.updateStudy(c.id, { status }); changed(); dialog.toast(status === 'active' ? 'Back under way' : status === 'done' ? 'Marked finished' : 'Moved to the archive'); };
  const remove = async () => {
    const ok = await dialog.confirm({ title: `Delete “${c.title}”?`, message: 'Its weekly plan and its classes on the calendar go. Its studies and lessons stay in your notes.', okLabel: 'Delete course', danger: true });
    if (!ok) return;
    await api.deleteStudy(c.id);
    onChanged();
    onBack();
  };
  const edit = async () => { if (await dialog.open((close) => <CourseSettingsDialog c={c} tree={tree} close={close} />)) changed(); };
  const again = async () => {
    const newId = await dialog.open((close) => <TeachAgainDialog c={c} close={close} />);
    if (newId) { onChanged(); window.dispatchEvent(new CustomEvent('noteapp:open-course', { detail: newId })); dialog.toast('Your new course is ready'); }
  };
  const guide = () => dialog.open((close) => (
    <ExportWordDialog title={`${c.title}: Teacher’s Guide`} project defaultFormat="manuscript" heading="Teacher’s Guide"
      intro="The course overview (aims and the weekly plan), then every week’s lesson, each on a new page, with your after-class notes."
      close={close} getParts={() => guideParts(c.id)} />
  ));

  return (
    <div className={`page studies-page study-detail course-page study-c-${c.color ?? 'green'}`}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <button type="button" className="link-btn study-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> {backLabel}</button>
          <h1>{c.title}</h1>
          <p className="muted">
            <span className="study-kind-chip"><Icon name="present" size={13} /> Course</span>
            {c.status !== 'active' && <span className="study-kind-chip">{c.status === 'done' ? 'Finished' : 'Archived'}</span>}
            <span>{b ? b.name : c.course.topic || 'Topical'} · {plural(c.weeks.length, 'week')} · {classLine}</span>
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={again}><Icon name="repeat" size={15} /> Teach again…</button>
          <button className="btn" onClick={guide}><Icon name="download" size={15} /> Teacher’s guide</button>
          <button className="btn" onClick={edit}>Edit course…</button>
          <Menu align="right" trigger={({ toggle }) => <button className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" /></button>} items={[
            c.status !== 'active' && { label: 'Put back under way', onClick: () => setStatus('active') },
            c.status === 'active' && { label: 'Mark finished', onClick: () => setStatus('done') },
            c.status !== 'archived' && { label: 'Move to the archive', onClick: () => setStatus('archived') },
            { label: c.course.calendar === false ? 'Put the classes on the calendar' : 'Take the classes off the calendar', onClick: () => run(() => api.updateCourse(c.id, { course: { calendar: c.course.calendar === false } })) },
            serverMode() === 'tenant' && { label: 'Share…', onClick: () => openShare(dialog, { kind: 'study', id: c.id, title: c.title }) },
            'sep',
            { label: 'Delete course…', danger: true, onClick: remove },
          ]} />
        </div>
      </header>

      {c.description && <p className="study-desc">{c.description}</p>}

      {next ? <UpNext w={next} t={t} action={action} useStudy={useStudy} openStudy={openStudy} lesson={lesson} reflect={reflect} present={(x) => presentNote(dialog, x.lesson.note_id)} />
        : c.weeks.length > 0 && (
          <section className="course-next is-finished">
            <p className="course-next-kicker">Course taught</p>
            <h2>All {plural(c.weeks.length, 'week')} taught</h2>
            <p className="muted">Teach it again to start a new run with these lessons as drafts and your after-class notes beside each week.</p>
            <div className="course-next-actions"><button type="button" className="btn btn-primary" onClick={again}><Icon name="repeat" size={14} /> Teach it again…</button></div>
          </section>
        )}

      <section className="study-progress">
        <div className="study-bar" role="progressbar" aria-valuenow={taught} aria-valuemin={0} aria-valuemax={c.weeks.length}><span style={{ width: `${c.weeks.length ? (taught / c.weeks.length) * 100 : 0}%` }} /></div>
        <span>{taught} of {plural(c.weeks.length, 'week')} taught · {written} {written === 1 ? 'lesson' : 'lessons'} written · {c.weeks.filter((w) => w.study).length} studied</span>
      </section>

      <div className="study-columns">
        <section className="study-schedule course-plan-list">
          <div className="course-plan-head">
            <h2>Weekly Plan</h2>
            <span className="course-legend muted">{['study', 'lesson', 'teach', 'notes'].map((k) => <span key={k}><Icon name={STEP_ICONS[k]} size={11} /> {STEP_LABELS[k]}</span>)}</span>
          </div>
          <ol className="course-weeks">
            {timeline.map((row) => {
              if (row.kind === 'skip') {
                return (
                  <li key={`skip-${row.date}`} className="course-skip-row">
                    <span>No class · {formatShortDate(row.date)}</span>
                    <button type="button" className="link-btn" onClick={() => run(() => api.skipClass(c.id, row.date, false), `Class is back on ${formatShortDate(row.date)}`)}>Have class</button>
                  </li>
                );
              }
              const { w } = row;
              const late = !w.done && w.date && w.date < t;
              return [
                w.week === QUARTER + 1 && c.weeks.length > QUARTER && <li key="q2" className="course-quarter">Quarter 2</li>,
                <li key={w.id} className={`course-week ${w.done ? 'is-done' : ''} ${w.id === c.next ? 'is-next' : ''} ${w.recap ? 'is-recap' : ''}`} onContextMenu={(e) => dialog.contextMenu(e, weekMenu(w))}>
                  <span className="course-week-n">{w.week}</span>
                  <div className="course-week-main">
                    <button type="button" className="course-week-title" onClick={() => (w.lesson ? lesson(w) : editWeek(w))}>{w.lesson?.title ?? w.title}</button>
                    <span className="course-week-meta">
                      {w.date && <span className={late ? 'is-late' : ''}>{relativeDay(w.date)}</span>}
                      {w.ref && !(w.lesson?.title ?? w.title).includes(w.ref) && <span>{w.ref}</span>}
                      {w.recap && <span>Review week</span>}
                      {w.lesson?.big && <span className="course-week-big" title={w.lesson.big}>{w.lesson.big}</span>}
                      {w.previous?.taught && <span title={`Taught before in “${w.previous.course}”`}>Taught {w.previous.date ? formatShortDate(w.previous.date) : 'before'}</span>}
                    </span>
                  </div>
                  {pips(w)}
                  <span className="course-week-action">{action(w)}</span>
                  <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" size={16} /></button>} items={weekMenu(w)} />
                </li>,
              ];
            })}
          </ol>
          <button type="button" className="link-btn course-add-week" onClick={() => run(() => api.addCourseWeek(c.id, { title: 'New week' }), 'Added a week at the end')}><Icon name="plus" size={13} /> Add a week</button>
        </section>

        <aside className="study-side">
          <Aims c={c} run={run} />
          <Levels c={c} />
          <section className="course-class">
            <div className="study-side-head"><h2>Class</h2><button type="button" className="btn btn-small" onClick={edit}>Edit…</button></div>
            <p>{classLine}</p>
            <p className="muted">{c.weeks[0]?.date ? `${formatShortDate(c.weeks[0].date)} to ${formatShortDate(c.weeks.at(-1).date ?? c.weeks[0].date)}` : 'No dates yet'}{c.course.skips?.length ? ` · ${plural(c.course.skips.length, 'date')} with no class` : ''}</p>
            <p className="muted">{c.course.calendar === false ? 'Not on the calendar' : `On the calendar${category ? ` as ${category.name}` : ''}`}</p>
            {c.from_course && <p className="muted">Taught before as <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent('noteapp:open-course', { detail: c.from_course.id }))}>{c.from_course.title}</button></p>}
            {c.taught_again?.map((x) => <p key={x.id} className="muted">Taught again as <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent('noteapp:open-course', { detail: x.id }))}>{x.title}</button></p>)}
          </section>
          <StudyNotes s={c} onOpenNote={openNote} changed={changed} />
        </aside>
      </div>
    </div>
  );
}

/** What's next: the week, its four steps and the one to do now, with last time's notes when it was taught before. */
function UpNext({ w, t, action, useStudy, openStudy, lesson, reflect, present }) {
  const s = weekSteps(w, t);
  const say = {
    passage: 'Give this week a passage, then study it.',
    study: 'Start with the passage: study it first, and the lesson grows out of the study.',
    lesson: w.study ? 'Your study is ready. Write the lesson from it: your summary, principle, questions and application carry over.' : 'Write the lesson for this week.',
    open: w.lesson?.complete ? 'The lesson is written. Look it over, present it in class, or print a handout.' : 'The lesson is started. Finish its Hook, Book, Look and Took.',
    taught: 'Class day has come. Mark it taught when you’re done.',
    notes: 'While it’s fresh: did the class reach the Took? What worked, and what would you change?',
  }[s.next];
  return (
    <section className="course-next">
      <p className="course-next-kicker">Up Next · Week {w.week}{w.date ? ` · ${relativeDay(w.date)}` : ''}</p>
      <h2>{w.lesson?.title ?? w.title}</h2>
      {w.ref && !(w.lesson?.title ?? w.title).includes(w.ref) && <p className="muted course-next-ref">{w.ref}</p>}
      <ol className="course-next-steps">
        {['study', 'lesson', 'teach', 'notes'].map((k, i) => (
          <li key={k} className={`is-${s[k]} ${({ study: ['study', 'passage'], lesson: ['lesson', 'open'], teach: ['taught'], notes: ['notes'] })[k].includes(s.next) ? 'is-current' : ''}`}>
            <span className="course-next-n">{s[k] === 'done' ? <Icon name="check" size={12} /> : i + 1}</span>
            {STEP_LABELS[k]}{s[k] === 'skip' ? <small> (review week)</small> : ''}
          </li>
        ))}
      </ol>
      {say && <p className="course-next-say">{say}</p>}
      {w.study && <p className="muted course-next-line"><Icon name="bible" size={13} /> Study: <button type="button" className="link-btn" onClick={() => openStudy(w)}>{w.study.title}</button>{w.study.keeper ? ` · “${w.study.keeper}”` : ''}</p>}
      {s.next === 'study' && w.suggested?.length > 0 && (
        <p className="muted course-next-line"><Icon name="bible" size={13} /> You’ve studied this passage before: <button type="button" className="link-btn" onClick={() => useStudy(w, w.suggested[0].note_id)}>use “{w.suggested[0].title}”</button></p>
      )}
      {w.previous?.reflection && (
        <div className="course-previous">
          <strong>Last time{w.previous.date ? ` (${formatShortDate(w.previous.date)})` : ''}</strong>
          {w.previous.reflection.reached && <span> · Reached the Took: {reachedLabel(w.previous.reflection.reached)}</span>}
          {w.previous.reflection.worked && <p><span className="muted">Worked:</span> {w.previous.reflection.worked}</p>}
          {w.previous.reflection.change && <p><span className="muted">Change:</span> {w.previous.reflection.change}</p>}
        </div>
      )}
      <div className="course-next-actions">
        {action(w, true)}
        {w.lesson && s.next !== 'open' && <button type="button" className="btn" onClick={() => lesson(w)}><Icon name="present" size={14} /> Lesson</button>}
        {w.lesson && <button type="button" className="btn" onClick={() => present(w)}><Icon name="play" size={14} /> Present</button>}
        {w.done && w.reflection && <button type="button" className="btn" onClick={() => reflect(w)}><Icon name="pen" size={14} /> Notes</button>}
      </div>
    </section>
  );
}

/** The course aims (know, feel, do), editable here, beside the Tooks the weeks have so far. */
function Aims({ c, run }) {
  const [editing, setEditing] = useState(false);
  const [aims, setAims] = useState(c.course.aims ?? {});
  useEffect(() => { if (!editing) setAims(c.course.aims ?? {}); }, [c, editing]);
  const tooks = c.weeks.filter((w) => w.lesson?.took);
  const empty = AIMS.every((a) => !(c.course.aims?.[a.key] ?? '').trim());
  const save = async () => { await run(() => api.updateCourse(c.id, { course: { aims } }), 'Aims saved'); setEditing(false); };
  return (
    <section className="course-aims">
      <div className="study-side-head">
        <h2>Course Aims</h2>
        {!editing && <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>{empty ? 'Write them…' : 'Edit'}</button>}
      </div>
      {editing ? (
        <>
          {AIMS.map((a) => (
            <label key={a.key} className="field">{a.label}
              <textarea className="input" rows={2} value={aims[a.key] ?? ''} onChange={(e) => setAims({ ...aims, [a.key]: e.target.value })} placeholder={a.placeholder} />
            </label>
          ))}
          <div className="study-feed-foot"><span /><span className="modal-actions-group"><button type="button" className="btn btn-small" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="btn btn-small btn-primary" onClick={save}>Save</button></span></div>
        </>
      ) : empty ? (
        <p className="muted">What they should know, feel and do by the end. Each week’s Took shows here beside them, so you can see the weeks build.</p>
      ) : (
        <dl className="course-aim-list">
          {AIMS.filter((a) => (c.course.aims?.[a.key] ?? '').trim()).map((a) => <div key={a.key}><dt>{a.label}</dt><dd>{c.course.aims[a.key]}</dd></div>)}
        </dl>
      )}
      {tooks.length > 0 && (
        <details className="course-tooks" open={tooks.length <= 4}>
          <summary>Tooks so far ({tooks.length})</summary>
          <ol>{tooks.map((w) => <li key={w.id}><span className="course-tooks-n">{w.week}</span> {w.lesson.took.split(/(?<=[.!?])\s/)[0]}</li>)}</ol>
        </details>
      )}
    </section>
  );
}

/** Which level of learning each written lesson reaches (Richards: rote up to realization). */
function Levels({ c }) {
  const lessons = c.weeks.filter((w) => w.lesson?.levels?.reached);
  const by = Object.fromEntries(LEVELS.map((l) => [l.key, lessons.filter((w) => w.lesson.levels.reached === l.key)]));
  const top = by.realization.length;
  return (
    <section className="course-levels">
      <div className="study-side-head"><h2>Levels of Learning</h2></div>
      {!lessons.length ? (
        <p className="muted">As you write lessons in the lesson builder, each shows the highest level of learning it reaches here, from rote to realization (the truth lived out).</p>
      ) : (
        <>
          <p className="muted">{top} of {plural(lessons.length, 'lesson')} reach{lessons.length === 1 ? 'es' : ''} realization.</p>
          <ul className="course-level-bars">
            {[...LEVELS].reverse().map((l) => (
              <li key={l.key} title={l.what}>
                <span className="course-level-name">{l.label}</span>
                <span className="course-level-bar"><span className={`lv-${l.key}`} style={{ width: `${(by[l.key].length / lessons.length) * 100}%` }} /></span>
                <span className="course-level-weeks">{by[l.key].map((w) => w.week).join(', ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {lessons.length > 0 && lessons.length < c.weeks.filter((w) => w.lesson).length && <p className="muted">Lessons not yet opened in the lesson builder aren’t counted.</p>}
    </section>
  );
}

/** The teacher's guide: an overview (aims, class plan, the weeks) then each week's lesson. */
async function guideParts(id) {
  const g = await api.courseGuide(id);
  const date = (d) => (d ? formatShortDate(d) : '');
  const aims = AIMS.filter((a) => (g.course.aims?.[a.key] ?? '').trim()).map((a) => `<p><strong>${a.label}:</strong> ${esc(g.course.aims[a.key])}</p>`).join('');
  const classLine = [g.course.classDay != null && `${DAY_NAMES[g.course.classDay]}s`, g.course.classTime && `at ${timeLabel(g.course.classTime)}`, `${g.classMinutes} minutes`].filter(Boolean).join(' ');
  const rows = g.weeks.map((w) => `<tr><td><p>${w.week}</p></td><td><p>${esc(date(w.date))}</p></td><td><p>${esc(w.ref || (w.recap ? 'Review' : ''))}</p></td><td><p>${esc(w.lesson?.title ?? w.title)}</p></td><td><p>${esc(w.lesson?.big ?? '')}</p></td></tr>`).join('');
  const overview = [
    g.description ? `<p>${esc(g.description)}</p>` : '',
    `<p><em>${esc(classLine)}${g.weeks[0]?.date ? `, ${esc(date(g.weeks[0].date))} to ${esc(date(g.weeks.at(-1).date))}` : ''}</em></p>`,
    aims ? `<h2>Course Aims</h2>${aims}` : '',
    `<h2>Weekly Plan</h2><table><tbody><tr><th><p>Week</p></th><th><p>Date</p></th><th><p>Passage</p></th><th><p>Lesson</p></th><th><p>Big Idea</p></th></tr>${rows}</tbody></table>`,
  ].join('');
  const reflection = (r) => (r ? `<h2>After-Class Notes</h2>${r.reached ? `<p><strong>Reached the Took:</strong> ${esc(reachedLabel(r.reached))}</p>` : ''}${r.worked ? `<p><strong>What worked:</strong> ${esc(r.worked)}</p>` : ''}${r.change ? `<p><strong>Change next time:</strong> ${esc(r.change)}</p>` : ''}${r.notes ? `<p>${esc(r.notes)}</p>` : ''}` : '');
  return [
    { title: 'Course Overview', html: overview },
    ...g.weeks.map((w) => ({
      title: `Week ${w.week}: ${w.lesson?.title ?? w.title}`,
      html: `<p><em>${esc([date(w.date), w.ref].filter(Boolean).join(' · '))}</em></p>${w.html ?? '<p>Not written yet.</p>'}${reflection(w.reflection)}`,
    })),
  ];
}
