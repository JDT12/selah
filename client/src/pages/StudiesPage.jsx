import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Ring from '../components/Ring.jsx';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import { useEventCategories } from '../eventCategories.js';
import NotePicker from '../components/NotePicker.jsx';
import { api } from '../api.js';
import { formatShortDate, relativeDay, todayStr } from '../time.js';
import { ITEM_LABELS, STUDY_KINDS } from '../studyPlans.js';
import { PlanDialog, StudyDialog } from '../components/StudyDialogs.jsx';
import { presentNote, printHandout } from '../components/PresentMode.jsx';
import WritingProject from '../components/WritingProject.jsx';
import ClassView from '../components/ClassView.jsx';
import { openSermonBuilder } from '../components/SermonBuilder.jsx';
import { preachNote, teachNote } from '../components/PreachMode.jsx';
import { LogPreachingDialog } from '../components/SermonDialogs.jsx';
import { emptySermon, sermonHtml } from '../sermon.js';
import { newStudy, openStudyBuilder } from '../components/StudyBuilder.jsx';
import { openLessonBuilder, writeLesson } from '../components/LessonBuilder.jsx';
import { chooseMethod } from '../components/MethodPicker.jsx';
import { parse } from '../../../shared/scripture.js';
import { openShare } from '../components/SharingDialogs.jsx';
import { serverMode } from '../mode.js';
import { confirmNew } from '../components/ExistingWork.jsx';

const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

function paceText(p, s) {
  if (!p.total) return 'Nothing scheduled yet';
  if (p.done === p.total) return 'All done';
  const parts = [`${p.done} of ${p.total} done`];
  if (p.behind) parts.push(`${p.behind} behind`);
  else if (p.next?.date) parts.push('on track');
  if (p.perWeek && s.target_date) parts.push(`about ${p.perWeek} a week to finish by ${formatShortDate(s.target_date)}`);
  return parts.join(' · ');
}

function Progress({ p }) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return <div className="study-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>;
}

/** 9.2.1: the kind of Bible study a reading's note is, shown on its row. */
const STUDY_TYPE = { ggw: 'Passage Study', background: 'Background Study', word: 'Word Study' };

/** A study's card on Desk. */
export function StudyCard({ s, onOpen }) {
  return (
    <button type="button" className={`study-card study-c-${s.color ?? 'blue'}`} onClick={onOpen}>
      <span className="study-card-kind"><Icon name={STUDY_KINDS[s.kind]?.icon ?? 'book'} size={14} /> {STUDY_KINDS[s.kind]?.label}</span>
      <strong className="study-card-title">{s.title}</strong>
      {s.description && <span className="study-card-desc">{s.description}</span>}
      {s.progress.total > 0 && <Ring value={s.progress.done} max={s.progress.total} />}
      <span className={`study-card-pace ${s.progress.behind ? 'is-behind' : ''}`}>{s.status === 'archived' && !s.progress.total ? plural(s.notes, 'note') : paceText(s.progress, s)}</span>
      {s.status === 'active' && s.progress.next && (
        <span className="study-card-next"><Icon name="chevronRight" size={13} /> {s.progress.next.title}{s.progress.next.date ? ` · ${relativeDay(s.progress.next.date)}` : ''}</span>
      )}
    </button>
  );
}

/** One study: its schedule, notes and (for a class) feed and grades. Desk shows it. */
export function StudyDetail({ id, tree, onBack, backLabel = 'Desk', onCourse, onOpenNote, onOpenScripture, onChanged, onMenu }) {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState({ title: '', date: '', ref: '' });

  const load = useCallback(() => api.study(id).then(setS).catch((e) => { dialog.toast(e.message, 'error'); onBack(); }), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); onChanged(); };
  // Titles and notes may have changed while the note was open.
  const openNote = (noteId, heading) => Promise.resolve(onOpenNote(noteId, heading)).then(() => load());
  // A class's calendar feed refreshes itself when you open it (at most every few hours).
  useEffect(() => {
    if (s?.kind === 'class' && s.status === 'active' && s.data.feedUrl && Date.now() - (s.data.feedSyncedAt ?? 0) > 6 * 3600_000) {
      api.syncStudy(s.id).then(load).catch(() => {});
    }
  }, [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    if (!s) return null;
    const t = todayStr();
    // Items brought in from an old class note's weekly checklists show week by week, ticked or not.
    const weekly = new Map();
    for (const i of s.items.filter((x) => x.data?.week).sort((a, b) => a.data.week - b.data.week || a.position - b.position)) {
      if (!weekly.has(i.data.week)) weekly.set(i.data.week, []);
      weekly.get(i.data.week).push(i);
    }
    const rest = s.items.filter((x) => !x.data?.week);
    const open = rest.filter((i) => !i.done);
    return {
      weeks: [...weekly],
      behind: open.filter((i) => i.date && i.date < t),
      upcoming: open.filter((i) => i.date && i.date >= t),
      undated: open.filter((i) => !i.date),
      done: rest.filter((i) => i.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0)),
    };
  }, [s]);

  if (!s) return <div className="page studies-page"><p className="muted">Loading…</p></div>;
  // A course opened from somewhere that didn't know it was one opens as a course.
  if (s.data.course) return <CourseRedirect id={s.id} onCourse={onCourse} />;
  const kind = STUDY_KINDS[s.kind];

  const edit = async () => { if (await dialog.open((close) => <StudyDialog study={s} tree={tree} close={close} />)) changed(); };
  const plan = async () => { if (await dialog.open((close) => <PlanDialog study={s} close={close} />)) changed(); };
  const setStatus = async (status) => { await api.updateStudy(s.id, { status }); changed(); dialog.toast(status === 'active' ? 'Back under way' : status === 'done' ? 'Marked finished' : 'Moved to the archive'); };
  const remove = async () => {
    const ok = await dialog.confirm({ title: `Delete “${s.title}”?`, message: 'Its schedule and the tasks it made go. Its notes stay where they are.', okLabel: 'Delete study', danger: true });
    if (!ok) return;
    await api.deleteStudy(s.id);
    onChanged();
    onBack();
  };
  const toggle = async (item) => { await api.updateStudyItem(item.id, { done: !item.done }); changed(); };
  const preaching = s.kind === 'preaching';
  const hasNote = (item) => item.note_id && item.note_title !== null;
  /** The passage an item is about: its reference, or a title that is one ("James 1:1-11"). */
  const passageOf = (item) => {
    if (item.ref) return item.ref;
    const { refs, errors } = parse(item.title ?? '');
    return refs.length && !errors.length ? item.title : '';
  };
  /** Asks for an item's passage and saves it; resolves the passage, or '' when cancelled. */
  const askPassage = async (item, title = item.ref ? 'Change the passage' : 'Set the passage') => {
    const q = await dialog.prompt({ title, label: 'Passage', value: item.ref ?? '', placeholder: 'James 1:1–11', okLabel: 'Save' });
    if (!q?.trim()) return '';
    const { refs, errors } = parse(q);
    if (!refs.length || errors.length) {
      dialog.toast('That isn’t a Bible reference. Try one like John 3:16–21.', 'error');
      return '';
    }
    try {
      await api.updateStudyItem(item.id, { ref: q.trim() });
    } catch (e) {
      dialog.toast(e.message, 'error');
      return '';
    }
    changed();
    return q.trim();
  };
  // A reading in a self-study is studied in the study builder (one without a passage asks for it first). Lessons,
  // sermons and writing keep their own workflows: a study feeds them (Take It Further in the builder) but they
  // never become studies.
  const canStudy = (item) => s.kind === 'self' && (!hasNote(item) || item.bible_study);
  const studyFirst = canStudy;
  const studyItem = async (item) => {
    if (hasNote(item)) await openStudyBuilder(dialog, item.note_id);
    else {
      const passage = passageOf(item) || await askPassage(item, 'Which passage?');
      if (!passage) return;
      await newStudy(dialog, passage, { study_item_id: item.id }, { studyId: s.id });
    }
    changed();
  };
  const openItemNote = async (item) => {
    // A sermon series' session starts as a sermon, in the builder.
    if (preaching && item.kind === 'session' && !hasNote(item)) {
      if ((await confirmNew(dialog, { kind: 'sermon', text: passageOf(item) })) !== true) return;
      try {
        const method = await chooseMethod(dialog, 'sermon', { studyId: s.id });
        if (method == null) return;
        const r = await api.createSermon({ study_item_id: item.id, html: sermonHtml(emptySermon(item.ref)), method });
        changed();
        await openSermonBuilder(dialog, r.note_id);
        changed();
      } catch (e) {
        dialog.toast(e.message, 'error');
      }
      return;
    }
    // A teaching lesson starts in the lesson builder (when its layout is Hook, Book, Look, Took).
    if (s.kind === 'teaching' && item.kind === 'session' && !hasNote(item)) {
      if ((await confirmNew(dialog, { kind: 'lesson', text: passageOf(item) })) !== true) return;
      await writeLesson(dialog, item.id, openNote, s.id);
      changed();
      return;
    }
    const { id: noteId } = await api.studyItemNote(item.id);
    openNote(noteId);
  };
  const canBuildLesson = (item) => s.kind === 'teaching' && item.kind === 'session' && hasNote(item) && item.lesson_builder && !item.bible_study;
  const buildLesson = async (item) => { await openLessonBuilder(dialog, item.note_id); changed(); };
  const build = async (item) => { await openSermonBuilder(dialog, item.note_id); changed(); };
  const logPreached = async (item) => {
    if (await dialog.open((close) => <LogPreachingDialog noteId={item.note_id} title={item.note_title} close={close} />)) { dialog.toast('Logged as preached'); changed(); }
  };
  // A lesson you already wrote (or any note) as this item's note; it joins the study's notes too.
  const useNote = async (item) => {
    const noteId = await dialog.open((close) => (
      <div className="study-use-note">
        <div className="dialog-header">
          <h2>{item.kind === 'session' ? 'Use a lesson you’ve written' : 'Use an existing note'}</h2>
          <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
        </div>
        <p className="muted">For “{item.title}”.</p>
        <NotePicker value={null} onChange={(id) => id && close(id)} />
      </div>
    ));
    if (!noteId) return;
    await api.updateStudyItem(item.id, { note_id: noteId });
    await api.addStudyNote(s.id, { note_id: noteId, role: item.kind === 'session' ? 'lesson' : 'note' });
    changed();
  };
  const itemMenu = (item) => [
    { label: 'Rename…', onClick: async () => { const t = await dialog.prompt({ title: 'Rename', value: item.title, okLabel: 'Save' }); if (t) { await api.updateStudyItem(item.id, { title: t }); changed(); } } },
    { label: item.date ? 'Change date…' : 'Set a date…', onClick: async () => { const d = await dialog.prompt({ title: 'Date (YYYY-MM-DD)', value: item.date ?? todayStr(), okLabel: 'Save' }); if (d) { try { await api.updateStudyItem(item.id, { date: d }); changed(); } catch (e) { dialog.toast(e.message, 'error'); } } } },
    item.date && { label: 'Remove the date', onClick: async () => { await api.updateStudyItem(item.id, { date: null }); changed(); } },
    { label: item.ref ? 'Change the passage…' : 'Set the passage…', onClick: () => askPassage(item) },
    item.ref && { label: 'Remove the passage', onClick: async () => { await api.updateStudyItem(item.id, { ref: '' }); changed(); } },
    { label: item.note_id && item.note_title !== null ? 'Use a different note…' : item.kind === 'session' ? 'Use a lesson you’ve written…' : 'Use an existing note…', onClick: () => useNote(item) },
    item.note_id && item.note_title !== null && s.kind === 'teaching' && { label: 'Teach the lesson', onClick: () => teachNote(dialog, item.note_id).then(changed) },
    item.note_id && item.note_title !== null && s.kind === 'teaching' && { label: 'Present the lesson', onClick: () => presentNote(dialog, item.note_id) },
    preaching && hasNote(item) && { label: 'Sermon builder', onClick: () => build(item) },
    canStudy(item) && { label: item.bible_study ? 'Study builder' : 'Study it in the study builder', onClick: () => studyItem(item) },
    canBuildLesson(item) && { label: 'Lesson builder', onClick: () => buildLesson(item) },
    preaching && hasNote(item) && { label: 'Preach', onClick: () => preachNote(dialog, item.note_id).then(changed) },
    preaching && hasNote(item) && { label: 'Log as preached…', onClick: () => logPreached(item) },
    item.note_id && item.note_title !== null && { label: 'Print handout…', onClick: () => printHandout(dialog, item.note_id) },
    'sep',
    { label: 'Delete', danger: true, onClick: async () => { await api.deleteStudyItem(item.id); changed(); } },
  ];
  const addItem = async (e) => {
    e.preventDefault();
    if (!adding.title.trim()) return;
    try {
      await api.addStudyItems(s.id, [{ kind: kind.item, title: adding.title.trim(), date: adding.date || null, ref: adding.ref.trim() }]);
      setAdding({ title: '', date: '', ref: '' });
      changed();
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };

  const row = (item) => (
    <li key={item.id} className={`study-item ${item.done ? 'is-done' : ''}`} onContextMenu={(e) => dialog.contextMenu(e, itemMenu(item))}>
      <button type="button" className={`task-check ${item.done ? 'is-on' : ''}`} onClick={() => toggle(item)} aria-label={item.done ? 'Mark not done' : 'Mark done'} aria-pressed={item.done}>
        {item.done && <Icon name="check" size={13} />}
      </button>
      <div className="study-item-main">
        <span className="study-item-title">{item.title}</span>
        <span className="study-item-meta">
          <span className="study-item-kind">{item.data?.part || (preaching && item.kind === 'session' ? 'Sermon' : ITEM_LABELS[item.kind])}</span>
          {item.bible_study && hasNote(item) && <span className="note-card-kind is-study" title="The kind of study in this reading's note">{STUDY_TYPE[item.study_method] ?? 'Bible Study'}</span>}
          {item.ref && !item.title.includes(item.ref) && <button type="button" className="link-btn" onClick={() => onOpenScripture(item.ref)}>{item.ref}</button>}
          {item.ref && item.title.includes(item.ref) && <button type="button" className="link-btn" onClick={() => onOpenScripture(item.ref)}>Notes on it</button>}
          {item.data?.url && <a href={item.data.url} target="_blank" rel="noopener noreferrer">Open in Canvas</a>}
        </span>
      </div>
      {item.date && <span className={`study-item-date ${!item.done && item.date < todayStr() ? 'is-late' : ''}`}>{relativeDay(item.date)}</span>}
      {/* An archived class's old checklist doesn't need a notes button on every row. */}
      {studyFirst(item) && !hasNote(item) && s.status !== 'archived' && (
        <button type="button" className="btn btn-small study-item-note" onClick={() => studyItem(item)} title="Study this passage in the study builder">
          <Icon name="bible" size={13} /> Study it
        </button>
      )}
      {!(studyFirst(item) && !hasNote(item)) && (s.status !== 'archived' || (item.note_id && item.note_title !== null)) && (
        <button type="button" className="btn btn-small study-item-note" onClick={() => openItemNote(item)}>
          <Icon name={preaching && item.kind === 'session' ? 'lectern' : item.bible_study ? 'bible' : 'note'} size={13} /> {item.note_id && item.note_title !== null
            ? (item.bible_study ? 'Study' : item.kind === 'session' ? (preaching ? 'Sermon' : 'Lesson') : 'Notes')
            : (item.kind === 'session' ? (preaching ? 'Build sermon' : 'Write lesson') : 'Add notes')}
        </button>
      )}
      {preaching && item.kind === 'session' && hasNote(item) && (
        <>
          <button type="button" className="icon-btn" onClick={() => build(item)} title="Sermon builder" aria-label="Sermon builder"><Icon name="steps" size={15} /></button>
          <button type="button" className="icon-btn" onClick={() => preachNote(dialog, item.note_id).then(changed)} title="Preach" aria-label="Preach"><Icon name="play" size={15} /></button>
        </>
      )}
      {item.bible_study && hasNote(item) && (
        <button type="button" className="icon-btn" onClick={() => studyItem(item)} title="Study builder" aria-label="Study builder"><Icon name="steps" size={15} /></button>
      )}
      {canBuildLesson(item) && (
        <button type="button" className="icon-btn" onClick={() => buildLesson(item)} title="Lesson builder" aria-label="Lesson builder"><Icon name="steps" size={15} /></button>
      )}
      {!preaching && item.kind === 'session' && item.note_id && item.note_title !== null && (
        <button type="button" className="icon-btn" onClick={() => teachNote(dialog, item.note_id).then(changed)} title="Teach the lesson" aria-label="Teach the lesson"><Icon name="play" size={15} /></button>
      )}
      <Menu align="right" trigger={({ toggle: t }) => <button type="button" className="icon-btn" onClick={t} aria-label="More"><Icon name="more" size={16} /></button>} items={itemMenu(item)} />
    </li>
  );

  // A class you take has its own view (Desk → Learn).
  if (s.kind === 'class') {
    return <ClassView s={s} changed={changed} onBack={onBack} backLabel={backLabel} onOpenNote={openNote} onMenu={onMenu}
      actions={{ edit, setStatus, remove }} StudyNotes={StudyNotes} ClassFeed={ClassFeed} />;
  }

  return (
    <div className={`page studies-page study-detail study-c-${s.color ?? 'blue'}`}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <button type="button" className="link-btn study-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> {backLabel}</button>
          <h1>{s.title}</h1>
          <p className="muted">
            <span className="study-kind-chip"><Icon name={kind.icon} size={13} /> {kind.label}</span>
            {s.status !== 'active' && <span className="study-kind-chip">{s.status === 'done' ? 'Finished' : 'Archived'}</span>}
            {s.notebook && <span> · notes in {s.notebook.name}</span>}
          </p>
        </div>
        <div className="page-actions">
          {s.kind !== 'class' && <button className="btn" onClick={plan}><Icon name="calendar" size={15} /> {{ self: 'Plan the reading…', teaching: 'Plan a series…', writing: 'Plan the writing…', preaching: 'Plan the series…' }[s.kind]}</button>}
          <button className="btn" onClick={edit}>Edit…</button>
          <Menu align="right" trigger={({ toggle: t }) => <button className="icon-btn" onClick={t} aria-label="More"><Icon name="more" /></button>} items={[
            s.status !== 'active' && { label: 'Put back under way', onClick: () => setStatus('active') },
            s.status === 'active' && { label: 'Mark finished', onClick: () => setStatus('done') },
            s.status !== 'archived' && { label: 'Move to the archive', onClick: () => setStatus('archived') },
            { label: s.data.inTasks === false ? 'Show dated items in Tasks and Calendar' : 'Keep dated items out of Tasks and Calendar', onClick: async () => { await api.updateStudy(s.id, { data: { inTasks: s.data.inTasks === false } }); changed(); } },
            serverMode() === 'tenant' && { label: 'Share…', onClick: () => openShare(dialog, { kind: 'study', id: s.id, title: s.title }) },
            'sep',
            { label: 'Delete study…', danger: true, onClick: remove },
          ]} />
        </div>
      </header>

      {s.description && <p className="study-desc">{s.description}</p>}
      {s.progress.total > 0 && (
        <section className="study-progress">
          <Progress p={s.progress} />
          <span className={s.progress.behind ? 'is-behind' : ''}>{paceText(s.progress, s)}</span>
        </section>
      )}

      <div className="study-columns">
        <section className="study-schedule">
          {s.kind === 'writing' && <WritingProject s={s} wordpress={tree.wordpress} onOpenNote={openNote} changed={changed} />}
          <h2>{s.kind === 'writing' ? 'Milestones' : 'Schedule'}</h2>
          {!s.items.length && (
            <p className="muted study-empty">
              {s.kind === 'class' ? 'Add assignments below, or connect the class calendar on the right.' : 'Nothing scheduled yet. '}
              {s.kind !== 'class' && <button type="button" className="link-btn" onClick={plan}>{{ self: 'Plan the reading', teaching: 'Plan a series', writing: 'Plan the writing', preaching: 'Plan the series' }[s.kind]}</button>}
              {s.kind !== 'class' && ' or add items one at a time below.'}
            </p>
          )}
          {groups.weeks.map(([week, items]) => {
            const left = items.filter((i) => !i.done).length;
            return (
              <details key={week} className="study-week" open={s.status === 'active' && left > 0}>
                <summary><h3 className="study-group">Week {week}</h3><span className="muted">{left ? `${items.length - left} of ${items.length} done` : 'All done'}</span></summary>
                <ul className="study-items">{items.map(row)}</ul>
              </details>
            );
          })}
          {groups.behind.length > 0 && <><h3 className="study-group is-behind">Behind</h3><ul className="study-items">{groups.behind.map(row)}</ul></>}
          {groups.upcoming.length > 0 && <><h3 className="study-group">Coming up</h3><ul className="study-items">{groups.upcoming.map(row)}</ul></>}
          {groups.undated.length > 0 && <><h3 className="study-group">No date</h3><ul className="study-items">{groups.undated.map(row)}</ul></>}
          <form className="study-add" onSubmit={addItem}>
            <input className="input" placeholder={`Add ${preaching ? 'a sermon' : ITEM_LABELS[kind.item].toLowerCase()}…`} value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} aria-label="Title" />
            <input className="input study-add-ref" placeholder="Passage (optional)" value={adding.ref} onChange={(e) => setAdding({ ...adding, ref: e.target.value })} aria-label="Passage" />
            <input className="input study-add-date" type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} aria-label="Date" />
            <button className="btn btn-primary" disabled={!adding.title.trim()}>Add</button>
          </form>
          {groups.done.length > 0 && (
            <>
              <button type="button" className="link-btn study-done-toggle" onClick={() => setShowDone(!showDone)}>
                <Icon name={showDone ? 'chevronDown' : 'chevronRight'} size={13} /> {plural(groups.done.length, 'done item')}
              </button>
              {showDone && <ul className="study-items">{groups.done.map(row)}</ul>}
            </>
          )}
        </section>

        <aside className="study-side">
          <StudyNotes s={s} onOpenNote={openNote} changed={changed} />
        </aside>
      </div>
    </div>
  );
}

function CourseRedirect({ id, onCourse }) {
  useEffect(() => {
    onCourse(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function StudyNotes({ s, onOpenNote, changed }) {
  const dialog = useDialog();
  const [adding, setAdding] = useState(false);
  const newNote = async () => {
    const title = await dialog.prompt({ title: 'New note in this study', label: 'Title', okLabel: 'Create' });
    if (!title) return;
    const { id } = await api.addStudyNote(s.id, { title });
    changed();
    onOpenNote(id);
  };
  const openAt = (noteId, heading) => onOpenNote(noteId, heading);
  return (
    <section className="study-notes">
      <div className="study-side-head">
        <h2>Notes</h2>
        <span className="modal-actions-group">
          <button type="button" className="btn btn-small" onClick={() => setAdding(!adding)}>Add existing…</button>
          <button type="button" className="btn btn-small btn-primary" onClick={newNote}><Icon name="plus" size={13} /> New</button>
        </span>
      </div>
      {adding && (
        <NotePicker value={null} onChange={async (noteId) => { if (noteId) { await api.addStudyNote(s.id, { note_id: noteId }); setAdding(false); changed(); } }} />
      )}
      {!s.notes.length && !adding && <p className="muted">Lesson notes, reading notes and anything else for this study gather here.</p>}
      <ul className="study-note-list">
        {s.notes.map((n) => (
          <li key={n.id}>
            <div className="study-note-row">
              <button type="button" className="study-note-title" onClick={() => onOpenNote(n.id)}>
                <Icon name={n.role === 'lesson' ? 'present' : n.role === 'sermon' ? 'lectern' : n.role === 'bible-study' ? 'bible' : n.role === 'archive' ? 'school' : 'note'} size={14} /> {n.title || 'Untitled'}
              </button>
              <button type="button" className="icon-btn" title="Take it out of this study (the note stays)" aria-label="Remove from study"
                onClick={async () => { await api.removeStudyNote(s.id, n.id); changed(); }}><Icon name="x" size={13} /></button>
            </div>
            {n.outline?.length > 0 && (
              <details className="study-outline" open={s.notes.length === 1}>
                <summary>{plural(n.outline.length, 'section')}</summary>
                <ul>
                  {n.outline.map((h, i) => (
                    <li key={i} className={`h${h.level}`}><button type="button" className="link-btn" onClick={() => openAt(n.id, h.text)}>{h.text}</button></li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClassFeed({ s, changed }) {
  const dialog = useDialog();
  const { categories } = useEventCategories();
  const setCategory = async (v) => {
    try { await api.updateStudy(s.id, { data: { calendarCategory: v ? Number(v) : null } }); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const [url, setUrl] = useState(s.data.feedUrl ?? '');
  const [filter, setFilter] = useState(s.data.feedFilter ?? '');
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      await api.updateStudy(s.id, { data: { feedUrl: url.trim(), feedFilter: filter.trim() } });
      const r = await api.syncStudy(s.id);
      dialog.toast(`${plural(r.added, 'new assignment')}${r.updated ? `, ${r.updated} updated` : ''}`);
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    setBusy(false);
  };
  return (
    <section className="study-feed">
      <h2>Due dates from Canvas</h2>
      <p className="muted">In Canvas, open <strong>Calendar</strong> → <strong>Calendar Feed</strong> and paste the link. Assignments come in by themselves and update when the course changes.</p>
      <input className="input" placeholder="https://…canvas…/feeds/calendars/user_….ics" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Calendar feed link" />
      <input className="input" placeholder="Only this course (e.g. OBST 520), optional" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Course filter" />
      {categories.length > 0 && (
        <label className="study-feed-cat"><span className="muted">On the calendar as</span>
          <select className="input" value={s.data.calendarCategory ?? ''} onChange={(e) => setCategory(e.target.value)} aria-label="Calendar category for assignments">
            <option value="">No category (gray)</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="study-feed-foot">
        <span className="muted">{s.data.feedSyncedAt ? `Checked ${new Date(s.data.feedSyncedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
        <button type="button" className="btn btn-small" disabled={!url.trim() || busy} onClick={sync}>{busy ? 'Checking…' : 'Save and check now'}</button>
      </div>
    </section>
  );
}
