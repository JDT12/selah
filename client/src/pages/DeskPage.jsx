import { useCallback, useEffect, useState } from 'react';
import DeviceReadOnly from '../components/DeviceReadOnly.jsx';
import { device } from '../device.js';
import Icon from '../components/Icon.jsx';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import { api } from '../api.js';
import { useStoredState } from '../useStoredState.js';
import { DESK_TABS, STUDY_KINDS } from '../studyPlans.js';
import { startStudy } from '../components/StudyReview.jsx';
import { ArchiveDialog, StudyDialog } from '../components/StudyDialogs.jsx';
import CourseView from '../components/CourseView.jsx';
import { NewCourseDialog } from '../components/CourseDialogs.jsx';
import { StudyDetail, StudyNotes } from './StudiesPage.jsx';
import { DueThisWeek } from '../components/ClassView.jsx';
import WorkList, { useDeleteWork, useMarkDone } from '../components/WorkList.jsx';
import { rowsOn } from '../work.js';
import { NewSermonDialog } from '../components/SermonDialogs.jsx';
import { openSermonBuilder } from '../components/SermonBuilder.jsx';
import { AllWritingBoard } from '../components/WritingBoard.jsx';

const deskTabOf = (s) => (s.data?.course ? 'teach' : DESK_TABS.find((t) => t.kinds.includes(s.kind))?.key ?? 'study');

let pending = null;
let requestedTab = null;
/** Opens a study (or course) on Desk the next time it mounts, and right away if it's open. */
export function showStudy(id, course = false) {
  pending = { id, course };
  window.dispatchEvent(new CustomEvent('noteapp:open-study', { detail: pending }));
}
export const showCourse = (id) => showStudy(id, true);
/** Switches Desk to a tab (Ctrl+K's "Desk: Teach"); it opens there next time if it isn't open. */
export function showDeskTab(key) {
  try { localStorage.setItem('noteapp.deskTab', JSON.stringify(key)); } catch { /* storage unavailable */ }
  requestedTab = key;
  window.dispatchEvent(new CustomEvent('noteapp:desk-tab', { detail: key }));
}

/**
 * Desk: what you're working through over weeks, by what you're doing with it: Study, Teach, Write, Learn. (Its Home
 * became the app's Home in 7.0.1, and in 7.1 its tabs became Home's: this page is Home on one of them.)
 */
export default function DeskPage({ tree, onOpenNote, onPeekNote, onOpenScripture, onChanged, onMenu }) {
  const dialog = useDialog();
  const [all, setAll] = useState(null);
  const [tab, setTab] = useStoredState('noteapp.deskTab', 'study');
  const [work, setWork] = useState(null);
  // Write: the projects, or every piece of them on one board by stage (6.6).
  const [writeView, setWriteView] = useStoredState('noteapp.desk.writeView', 'projects');
  const [open, setOpen] = useState(() => pending);
  // Desk opens on the tab used last (7.0.1: its Home became the app's Home), or one something asked for (Ctrl+K's "Desk: Teach").
  useEffect(() => {
    pending = null;
    requestedTab = null;
  }, []);
  const current = DESK_TABS.find((t) => t.key === tab) ?? DESK_TABS[0];

  const [due, setDue] = useState(null);
  const load = useCallback(() => {
    api.classesDue(7).then(setDue).catch(() => setDue([]));
    api.work().then(setWork).catch(() => setWork([]));
    return api.studies().then((list) => { setAll(list); return list; })
      .catch((e) => { dialog.toast(e.message, 'error'); return []; });
  }, [dialog]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onOpen = (e) => { pending = null; setOpen(e.detail); };
    const onTab = (e) => { requestedTab = null; setOpen(null); setTab(e.detail); };
    window.addEventListener('noteapp:desk-tab', onTab);
    // CourseView's links to the course it was taught from (or again as).
    const onOpenCourse = (e) => setOpen({ id: e.detail, course: true });
    window.addEventListener('noteapp:open-study', onOpen);
    window.addEventListener('noteapp:open-course', onOpenCourse);
    return () => {
      window.removeEventListener('noteapp:open-study', onOpen);
      window.removeEventListener('noteapp:open-course', onOpenCourse);
      window.removeEventListener('noteapp:desk-tab', onTab);
    };
  }, [setTab]);

  useEffect(() => {
    const s = open && all?.find((x) => x.id === open.id);
    window.dispatchEvent(new CustomEvent('noteapp:desk-open', { detail: open ? { id: open.id, course: !!open.course, title: s?.title, color: s?.color } : null }));
  }, [open, all]);
  useEffect(() => () => window.dispatchEvent(new CustomEvent('noteapp:desk-open', { detail: null })), []);

  // Back from a study goes to the tab it belongs on (it may have been opened from a link elsewhere).
  const back = async () => {
    const id = open?.id;
    setOpen(null);
    const s = (await load()).find((x) => x.id === id);
    if (s) setTab(deskTabOf(s));
  };
  const opened = async (id, course = false) => {
    if (!id) return;
    onChanged();
    await load();
    setOpen({ id, course });
  };
  const newCourse = async () => opened(await dialog.open((close) => <NewCourseDialog tree={tree} close={close} />), true);
  const create = async (kind) => {
    const kinds = (DESK_TABS.find((t) => t.kinds.includes(kind)) ?? current).kinds;
    const id = await dialog.open((close) => <StudyDialog kind={kind} kinds={kinds} tree={tree} close={close} />);
    // A teaching study can turn into planning a course instead.
    if (id === 'course') return newCourse();
    return opened(id);
  };
  const importClasses = async () => {
    if (await dialog.open((close) => <ArchiveDialog close={close} />)) { setTab('learn'); load(); onChanged(); }
  };
  const newSermon = async () => {
    const r = await dialog.open((close) => <NewSermonDialog tree={tree} close={close} />);
    if (!r) return;
    onChanged();
    await openSermonBuilder(dialog, r.note_id);
  };
  const markDone = useMarkDone(() => { load(); onChanged(); });
  const deleteWork = useDeleteWork(() => { load(); onChanged(); });

  if (open?.course) {
    return <DeviceReadOnly on={!device.full}><CourseView id={open.id} tree={tree} onBack={back} backLabel="Teach" onOpenNote={onPeekNote}
      onChanged={() => { load(); onChanged(); }} onMenu={onMenu} StudyNotes={StudyNotes} /></DeviceReadOnly>;
  }
  if (open) {
    // Notes open in a panel over the study (so you stay in it), and the study refreshes when it closes.
    return <DeviceReadOnly on={!device.full}><StudyDetail id={open.id} tree={tree} onBack={back} onCourse={(id) => setOpen({ id, course: true })} onOpenNote={onPeekNote ?? onOpenNote}
      onOpenScripture={onOpenScripture} onChanged={() => { load(); onChanged(); }} onMenu={onMenu}
      backLabel={DESK_TABS.find((t) => t.key === deskTabOf(all?.find((x) => x.id === open.id) ?? {}))?.label ?? 'Desk'} /></DeviceReadOnly>;
  }

  const rows = rowsOn(current.key, work, all);
  const activeCount = (key) => rowsOn(key, work, all).filter((r) => !r.done).length;
  const writePlans = (all ?? []).filter((x) => deskTabOf(x) === 'write' && x.status === 'active');

  const newButton = {
    study: (
      <>
        <button className="btn" onClick={() => create('self')} title="A reading schedule toward a finish date: a book of the Bible, a theology book, a Logos course"><Icon name="plus" size={15} /> New study plan</button>
        <button className="btn btn-primary" onClick={() => startStudy(dialog)}><Icon name="plus" size={15} /> New study</button>
      </>
    ),
    teach: (
      <Menu align="right" trigger={({ toggle }) => <button className="btn btn-primary" onClick={toggle}><Icon name="plus" size={15} /> New <Icon name="chevronDown" size={13} /></button>} items={[
        { label: 'Sermon', onClick: newSermon },
        { label: 'Course: a book or topic over a quarter or two', onClick: newCourse },
        { label: 'Teaching series: a class you lead, session by session', onClick: () => create('teaching') },
        { label: 'Sermon series', onClick: () => create('preaching') },
      ]} />
    ),
    write: <button className="btn btn-primary" onClick={() => create('writing')}><Icon name="plus" size={15} /> New writing project</button>,
    learn: <button className="btn btn-primary" onClick={() => create('class')}><Icon name="plus" size={15} /> New class</button>,
  }[current.key];

  const starts = {
    study: { title: 'Start studying', text: 'A Bible study of a passage, a book’s background, a word study, or a study plan: a reading schedule toward a finish date.', cards: [['newstudy', { label: 'Bible study', icon: 'book', hint: 'A passage, step by step, from what it meant then to what it means now' }], ['self', STUDY_KINDS.self]] },
    teach: { title: 'Plan your teaching', text: 'Lessons and sermons, courses you teach week by week, classes you lead session by session, and sermon series.', cards: [['sermon', { label: 'Sermon', icon: 'lectern', hint: 'A sermon from its passage to the pulpit, step by step' }], ['course', { label: 'Course', icon: 'present', hint: 'A book or topic over a quarter or two: weekly plan, aims, classes on the calendar' }], ['teaching', STUDY_KINDS.teaching], ['preaching', STUDY_KINDS.preaching]] },
    write: { title: 'Start a writing project', text: 'A blog series, an article or a long study: milestones toward a finish date, chapters and a word goal.', cards: [['writing', STUDY_KINDS.writing]] },
    learn: { title: 'Add a class', text: 'A seminary class you take: the syllabus, lectures with Cornell notes, readings by week, assignments and papers, and your grade so far. Due dates can come from Canvas.', cards: [['class', STUDY_KINDS.class], ['import', { label: 'Past classes', icon: 'import', hint: 'Bring in old class notes, with their weekly checklists' }]] },
  }[current.key];
  const startCard = (k) => (k === 'course' ? newCourse() : k === 'import' ? importClasses() : k === 'newstudy' ? startStudy(dialog) : k === 'sermon' ? newSermon() : create(k));
  const board = current.key === 'write' && writeView === 'board' && writePlans.length > 0;

  return (
    <div className="page studies-page desk-page is-desk">
      <header className="home-head desk-head">
        <div className="home-title">
          <p className="muted">Everything you study, teach, write and learn</p>
          <h1>Desk</h1>
        </div>
        <div className="page-actions">
          {device.full && current.key === 'learn' && <button className="btn" onClick={importClasses}><Icon name="import" size={15} /> Past classes…</button>}
          {device.full && newButton}
        </div>
      </header>
      <div className="home-tabs" role="tablist" aria-label="Desk">
        {DESK_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={current.key === t.key} className={current.key === t.key ? 'is-active' : ''} onClick={() => setTab(t.key)}>
            {t.label}{activeCount(t.key) > 0 && <span className="home-tab-count">{activeCount(t.key)}</span>}
          </button>
        ))}
      </div>

      {current.key === 'learn' && <DueThisWeek items={due} onOpen={(id) => setOpen({ id })} />}

      {current.key === 'write' && writePlans.length > 0 && (
        <div className="desk-bar">
          <div className="segmented desk-write-view" role="radiogroup" aria-label="Show">
            {[['projects', 'List'], ['board', 'Board']].map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={writeView === k} className={writeView === k ? 'is-active' : ''} onClick={() => setWriteView(k)}>{l}</button>
            ))}
          </div>
        </div>
      )}

      {!device.full && all && work && !rows.length && <p className="nb-empty">Nothing here yet. You can start it on the web or in Selah Desktop.</p>}
      {device.full && (all && work) && !rows.length && (
        <section className="studies-start">
          <h2>{starts.title}</h2>
          <p className="muted">{starts.text}</p>
          <div className="studies-start-grid">
            {starts.cards.map(([k, v]) => (
              <button key={k} type="button" className="studies-start-card" onClick={() => startCard(k)}>
                <Icon name={v.icon} size={22} />
                <strong>{v.label}</strong>
                <span>{v.hint}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {!(all && work) && <p className="muted">Loading…</p>}

      {board && <DeviceReadOnly on={!device.full}><AllWritingBoard api={api} dialog={dialog} onOpenNote={onPeekNote ?? onOpenNote} /></DeviceReadOnly>}
      {!board && rows.length > 0 && <WorkList tab={current.key} rows={rows} mode="desk" onMarkDone={device.full ? markDone : undefined} onDelete={device.full ? deleteWork : undefined} />}
    </div>
  );
}
