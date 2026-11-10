import { useCallback, useEffect, useState } from 'react';
import { device } from '../device.js';
import { api, formatSize } from '../api.js';
import { RoutineList, useRoutine } from '../components/Routine.jsx';
import { getTimeZone } from '../time.js';
import { addDays, formatLongDate, formatShortDate, formatTime, relativeDay } from '../time.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import EventDialog, { EVENT_COLORS } from '../components/EventDialog.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { toggleTask } from '../components/TaskRow.jsx';
import QuickAdd from '../components/QuickAdd.jsx';
import Icon from '../components/Icon.jsx';
import { useNoteActions } from '../components/useNoteActions.jsx';
import { openCategories } from '../components/EventCategories.jsx';
import { NONE, shownWith, useEventCategories, useHiddenCategories } from '../eventCategories.js';
import { showDeskTab, showStudy } from './DeskPage.jsx';
import { isDesktopEdition, isHosted } from '../mode.js';
import HomeTabs from './HomeTabs.jsx';
import WorkList, { useDeleteWork, useMarkDone } from '../components/WorkList.jsx';
import { DueThisWeek } from '../components/ClassView.jsx';
import { rowsOn } from '../work.js';
import { useStoredState } from '../useStoredState.js';
import { DESK_TABS } from '../studyPlans.js';
import { TwoStepNudge } from '../components/IdentityDialogs.jsx';
import { KIND_ICON, useSharing } from '../sharing.js';
import { preachNote, teachNote } from '../components/PreachMode.jsx';
import Scripture, { openRefClick } from '../components/Scripture.jsx';
import { Credit, TranslationPicker, useBible } from '../components/TranslationPicker.jsx';
import { startStudy } from '../components/StudyReview.jsx';
import { biblePassage } from '../esv.js';
import { HomePlans } from './PlansPage.jsx';

/**
 * Home (7.0.1): the Dashboard and Desk's Home as one page, the study desk. Today's Daily Walk reading, what's next on
 * Desk (lessons, sermons, writing, studies, classes), this week (Desk's dates, your events and tasks, with a task
 * box), the notes you were in, pinned notes, and a line on storage and backups. Customize shows or hides each part.
 * 7.1: Desk's tabs (Study, Teach, Write, Learn) sit under Home's header, and Home is two columns: the reading, next up
 * and this week on the left; what to pick up, pinned notes and the status line on the right.
 * 9.0: the verse of the day, read in your own translation, after the reading.
 */
const SECTIONS = [
  ['votd', 'Verse of the day'],
  ['reading', 'Daily Walk'],
  ['plans', 'Reading plans'],
  ['next', 'Next up'],
  ['week', 'This week'],
  ['continue', 'Pick up where you left off'],
  ['pinned', 'Pinned notes'],
  ['shared', 'Shared with you'],
  ['status', 'Storage and backups'],
];
const STEPS = ['hook', 'book', 'look', 'took'];
const STEP_NAMES = { hook: 'Hook', book: 'Book', look: 'Look', took: 'Took' };
const WHAT = { lesson: 'Lesson', sermon: 'Sermon', study: 'Bible study', chapter: 'Chapter', note: 'Note' };
const STUDY_HEX = { blue: '#2f5d86', green: '#2e7d4f', orange: '#b7700a', purple: '#6b4fa0', red: '#c93a32', teal: '#23797a', gray: '#6b7785' };
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  const d = Math.round(m / 1440);
  return d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : formatShortDate(new Date(ms).toISOString().slice(0, 10));
};
const overlaps = (ev, day) => ev.start.slice(0, 10) <= day && ev.end.slice(0, 10) >= day;

/**
 * Which parts are hidden: the 'home' pref, or for someone coming from the Dashboard, its hidden widgets (pinned stays
 * hidden; Storage and Backups both hidden hide the status line; the schedule, week and tasks all hidden hide This week).
 */
function useHomeHidden(dialog) {
  const [hidden, setHidden] = useState(null);
  useEffect(() => {
    api.getPref('home').then(async (v) => {
      if (v && Array.isArray(v.hidden)) return setHidden(v.hidden);
      const old = await api.getPref('dashboard').catch(() => null);
      const off = new Set((Array.isArray(old) ? old : []).filter((w) => w?.hidden).map((w) => w.id));
      setHidden([
        off.has('pinned') && 'pinned',
        off.has('storage') && off.has('backup') && 'status',
        off.has('schedule') && off.has('week') && off.has('tasks') && 'week',
      ].filter(Boolean));
    }).catch(() => setHidden([]));
  }, []);
  const toggle = (key) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setHidden(next);
    api.setPref('home', { hidden: next }).catch((e) => dialog.toast(`Couldn’t save: ${e.message}`, 'error'));
  };
  return [hidden, toggle];
}

export default function HomePage({ tree, onOpenNote, onTasksChanged, onNotesChanged, onSection, onNewNote, onSettings }) {
  const dialog = useDialog();
  const [hidden, toggleSection] = useHomeHidden(dialog);
  const [hiddenCats, toggleCat] = useHiddenCategories('dashboard');
  const { categories } = useEventCategories();
  const [dash, setDash] = useState(null);
  const sharing = useSharing();
  const [desk, setDesk] = useState(null);
  const [walk, setWalk] = useState(null);
  const [status, setStatus] = useState(null);
  // 11.0: Home's own Study, Teach, Write and Learn tabs: the work still active, with Mark done.
  const [tab, setTab] = useStoredState('noteapp.homeTab', 'home');
  useEffect(() => {
    const home = () => setTab('home');
    window.addEventListener('noteapp:home-tab', home);
    return () => window.removeEventListener('noteapp:home-tab', home);
  }, [setTab]);
  const [work, setWork] = useState(null);
  const [plans, setPlans] = useState(null);
  const [due, setDue] = useState(null);

  const load = useCallback(() => {
    api.dashboard().then((d) => {
      setDash(d);
      api.dailyWalk(d.today, d.today).then(setWalk).catch(() => setWalk(false));
    }).catch((e) => dialog.toast(e.message, 'error'));
    api.deskHome().then(setDesk).catch(() => setDesk(false));
    api.work().then(setWork).catch(() => setWork([]));
    api.studies().then(setPlans).catch(() => setPlans([]));
    api.classesDue(7).then(setDue).catch(() => setDue([]));
    Promise.all([
      api.storage().catch(() => null),
      isDesktopEdition() ? Promise.resolve(null) : api.offsite().catch(() => null),
      isHosted() ? api.account().then((a) => a.hostBackup ?? false).catch(() => null) : Promise.resolve(null),
      isDesktopEdition() ? api.desktopBackups().catch(() => null) : Promise.resolve(null),
    ]).then(([storage, offsite, host, auto]) => setStatus({ storage, offsite, host, auto }));
  }, [dialog]);
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    window.addEventListener('noteapp:notes-changed', onFocus);
    const timer = setInterval(load, 5 * 60_000);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('noteapp:notes-changed', onFocus); clearInterval(timer); };
  }, [load]);

  const markDone = useMarkDone(() => { load(); onNotesChanged?.(); });
  const deleteWork = useDeleteWork(() => { load(); onNotesChanged?.(); });
  const afterChange = (changed) => { if (changed) { load(); onTasksChanged?.(); } };
  const noteActions = useNoteActions({ tree, onChange: () => { load(); onNotesChanged?.(); }, onCreated: (id) => onOpenNote(id) });
  const noteMenu = (n) => noteActions.menuItems(n, {
    open: onOpenNote,
    trash: async (id) => { try { await api.trashNote(id); dialog.toast('Note moved to Trash'); } catch (e) { dialog.toast(e.message, 'error'); } load(); onNotesChanged?.(); },
  });
  const openEvent = async (ev) => afterChange(await dialog.open((close) => <EventDialog event={ev} dialog={dialog} close={close} onOpenNote={onOpenNote} />));
  const newEvent = async () => afterChange(await dialog.open((close) => <EventDialog event={null} dialog={dialog} close={close} onOpenNote={onOpenNote} />));
  const openTask = async (task) => afterChange(await dialog.open((close) => (
    <TaskDialog task={task} dialog={dialog} close={close} onOpenNote={onOpenNote} onChanged={() => afterChange(true)} />)));
  const newTask = async () => afterChange(await dialog.open((close) => (
    <TaskDialog task={null} defaults={{ due_date: dash?.today }} dialog={dialog} close={close} onOpenNote={onOpenNote} />)));
  const toggle = (task) => toggleTask(task, dialog, () => afterChange(true));
  const openStudy = (s) => { showStudy(s.id, s.course); onSection('desk'); };
  // A lesson or sermon opens as its page (the note); Teach or Preach starts it.
  const openItem = (x) => (x.note_id ? onOpenNote(x.note_id) : openStudy(x.study));

  if (!dash || hidden === null) return <div className="page home-page" />;
  const t = dash.today;
  const on = (k) => !hidden.includes(k);
  const shown = shownWith(hiddenCats);
  // A dated Desk item has a task of its own (in its study's list): it shows once, as the Desk item.
  const deskTasks = new Set((desk ? desk.week : []).map((w) => w.task_id).filter(Boolean));
  const tasks = dash.tasks.filter((x) => !deskTasks.has(x.id));

  // This week: Desk's dates, your events and your tasks, day by day (and what's overdue first).
  const days = Array.from({ length: 7 }, (_, i) => addDays(t, i)).map((day) => ({
    day,
    rows: [
      ...dash.events.filter(shown).filter((e) => overlaps(e, day)).sort((a, b) => (b.all_day - a.all_day) || a.start.localeCompare(b.start))
        .map((ev) => ({ key: `e${ev.key}`, kind: 'event', ev })),
      ...(desk ? desk.week.filter((w) => w.date === day).map((w) => ({ key: `d${w.id}`, kind: 'desk', w })) : []),
      ...tasks.filter((x) => x.due_date === day && shown(x)).map((task) => ({ key: `t${task.id}`, kind: 'task', task })),
    ],
  }));
  const overdue = tasks.filter((x) => x.due_date < t);
  const weekEmpty = !overdue.length && days.every((d) => !d.rows.length);

  const customize = (e) => dialog.contextMenu({ clientX: e.currentTarget.getBoundingClientRect().left, clientY: e.currentTarget.getBoundingClientRect().bottom + 6, preventDefault() {}, stopPropagation() {} },
    SECTIONS.filter(([k]) => k !== 'shared' || sharing?.enabled).map(([k, l]) => ({ label: `${on(k) ? '✓' : ' '} ${l}`, onClick: () => toggleSection(k) })));

  const actions = (
    <>
      <button type="button" className="btn home-customize" onClick={customize} title="Show or hide parts of Home">Customize</button>
      <Menu align="right" trigger={({ toggle: open }) => (
        <button type="button" className="btn btn-primary home-new" onClick={open}><Icon name="plus" size={15} /> New</button>
      )} items={[
        { label: 'Note', onClick: () => onNewNote() },
        { label: 'Handwritten note', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:new-handwritten', { detail: { paper: 'lined' } })) },
        { label: 'Task', onClick: newTask },
        { label: 'Event', onClick: newEvent },
        device.full && { label: 'Study…', onClick: () => startStudy(dialog) },
        device.full && { label: 'Something on Desk…', onClick: () => onSection('desk') },
      ]} />
    </>
  );
  const sharedCard = on('shared') && (sharing?.sharedWithMe?.length > 0 || sharing?.newComments?.length > 0);
  const right = on('continue') || (on('pinned') && dash.pinnedNotes.length > 0) || on('status') || sharedCard;

  const counts = Object.fromEntries(DESK_TABS.map((d) => [d.key, rowsOn(d.key, work, plans).filter((r) => !r.done).length]));
  const current = DESK_TABS.find((d) => d.key === tab);
  if (current) {
    const rows = rowsOn(current.key, work, plans).filter((r) => !r.done);
    return (
      <div className="page home-page">
        <HomeTabs tab={current.key} today={t} counts={counts} onPick={setTab} actions={actions} />
        {current.key === 'learn' && <DueThisWeek items={due} onOpen={(id) => { showStudy(id); onSection('desk'); }} />}
        {work && plans ? (
          <WorkList tab={current.key} rows={rows} mode="home" onMarkDone={markDone} onDelete={deleteWork} empty={(
            <>Nothing active on {current.label}. <button type="button" className="link-btn" onClick={() => { showDeskTab(current.key); onSection('desk'); }}>Open Desk</button> to start something or pick up finished work.</>
          )} />
        ) : <p className="muted">Loading…</p>}
        {rows.length > 0 && <p className="home-desk-link"><button type="button" className="link-btn" onClick={() => { showDeskTab(current.key); onSection('desk'); }}>All of it on Desk, done included</button></p>}
      </div>
    );
  }

  return (
    <div className="page home-page">
      <HomeTabs tab="home" today={t} counts={counts} onPick={setTab} actions={actions} />

      <div className={`home-grid ${right ? '' : 'is-single'}`}>
        <div className="home-main">
          <TwoStepNudge />

          {on('reading') && <HomeRoutine onOpenWalk={() => onSection('dailywalk')} onOpenNote={onOpenNote} />}

          {on('plans') && <HomePlans onOpen={() => onSection('plans')} />}

          {on('votd') && <VerseOfDay dialog={dialog} onOpenNote={onOpenNote} onSettings={onSettings} />}

          {on('next') && desk && <NextUp desk={desk} onOpen={openStudy} onOpenItem={openItem} onDesk={() => onSection('desk')} dialog={dialog} />}

          {on('week') && (
            <section className="home-week home-card-panel" aria-labelledby="home-week-h">
              <div className="home-section-head">
                <h2 id="home-week-h">This week</h2>
                {categories.length > 0 && (
                  <button type="button" className={`icon-btn ${hiddenCats.length ? 'is-on' : ''}`} title="Categories to show" aria-label="Categories to show"
                    onClick={(e) => dialog.contextMenu({ clientX: e.currentTarget.getBoundingClientRect().left, clientY: e.currentTarget.getBoundingClientRect().bottom + 6, preventDefault() {}, stopPropagation() {} }, [
                      ...categories.map((c) => ({ label: `${hiddenCats.includes(c.id) ? ' ' : '✓'} ${c.name}`, onClick: () => toggleCat(c.id) })),
                      { label: `${hiddenCats.includes(NONE) ? ' ' : '✓'} No category`, onClick: () => toggleCat(NONE) },
                      'sep',
                      { label: 'Manage categories…', onClick: () => openCategories(dialog).then(() => load()) },
                    ])}><Icon name="filter" size={14} /></button>
                )}
                <button type="button" className="link-btn" onClick={() => onSection('calendar')}>Open Plan</button>
              </div>
              <QuickAdd defaults={{ due_date: t }} placeholder="Add a task for today…" onCreated={(_, body) => {
                afterChange(true);
                if (body.due_date !== t) dialog.toast(`Added: ${body.due_date ? relativeDay(body.due_date) : 'No date'}`);
              }} className="is-compact home-quickadd" />
              {weekEmpty ? <p className="home-empty">Nothing this week. Tasks, events and Desk’s dates show up here.</p> : (
                <ul className="home-week-list">
                  {overdue.length > 0 && overdue.map((task, i) => (
                    <WeekRow key={`o${task.id}`} label={i === 0 ? 'Earlier' : ''} late>
                      <TaskBits task={task} onToggle={toggle} onOpen={openTask} />
                    </WeekRow>
                  ))}
                  {days.filter((d) => d.rows.length).map((d) => d.rows.map((r, i) => (
                    <WeekRow key={r.key} label={i === 0 ? (d.day === t ? 'Today' : `${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })} ${Number(d.day.slice(8))}`) : ''} today={d.day === t}>
                      {r.kind === 'task' && <TaskBits task={r.task} onToggle={toggle} onOpen={openTask} />}
                      {r.kind === 'event' && (
                        <button type="button" className="home-row-main" onClick={() => openEvent(r.ev)}>
                          <span className="home-dot is-square" style={{ background: EVENT_COLORS[r.ev.color] ?? EVENT_COLORS.green }} />
                          <span className="home-row-title">{r.ev.all_day ? '' : `${formatTime(r.ev.start)} · `}{r.ev.title || 'Untitled event'}</span>
                          <span className="home-row-meta">{r.ev.location ?? ''}</span>
                        </button>
                      )}
                      {r.kind === 'desk' && (
                        <button type="button" className="home-row-main" onClick={() => openStudy(r.w.study)}>
                          <span className="home-dot is-square" style={{ background: STUDY_HEX[r.w.study.color] ?? STUDY_HEX.blue }} />
                          <span className="home-row-title">{r.w.kind === 'session' && r.w.study.tab === 'teach' ? `${r.w.study.kind === 'preaching' ? 'Preach' : 'Teach'}: ${r.w.title}` : r.w.title}</span>
                          <span className="home-row-meta">{r.w.study.title}</span>
                        </button>
                      )}
                    </WeekRow>
                  )))}
                </ul>
              )}
            </section>
          )}
        </div>

        {right && (
          <div className="home-side">
            {sharedCard && <SharedCard sharing={sharing} onOpenNote={onOpenNote} />}
            {on('continue') && <Continue desk={desk} dash={dash} onOpenNote={onOpenNote} noteMenu={noteMenu} dialog={dialog} />}
            {on('pinned') && dash.pinnedNotes.length > 0 && (
              <section className="home-card-panel" aria-labelledby="home-pin-h">
                <div className="home-section-head"><h2 id="home-pin-h">Pinned</h2></div>
                <div className="home-notes">
                  {dash.pinnedNotes.map((n) => <NoteRow key={n.id} id={n.id} title={n.title} sub={n.notebook ?? ''} when={n.updated_at} onOpen={() => onOpenNote(n.id)} onMenu={(e) => dialog.contextMenu(e, noteMenu(n))} pinned />)}
                </div>
              </section>
            )}
            {on('status') && status && <StatusLine status={status} onSettings={onSettings} />}
          </div>
        )}
      </div>
    </div>
  );
}

function WeekRow({ label, today, late, children }) {
  return (
    <li className={`home-week-row ${label ? 'is-first' : ''}`}>
      <span className={`home-day ${today ? 'is-today' : ''} ${late ? 'is-late' : ''}`}>{label}</span>
      {children}
    </li>
  );
}

function TaskBits({ task, onToggle, onOpen }) {
  return (
    <span className="home-row-main is-task">
      <button type="button" className={`home-check ${task.completed_at ? 'is-on' : ''}`} onClick={() => onToggle(task)} aria-label={`Done: ${task.title}`}>
        <Icon name="check" size={11} />
      </button>
      <button type="button" className="home-row-title home-task-title" onClick={() => onOpen(task)}>{task.title}</button>
      <span className="home-row-meta">{task.list_name ?? ''}{task.due_time ? `${task.list_name ? ' · ' : ''}${task.due_time}` : ''}</span>
    </span>
  );
}

/** Today's Daily Walk: the reading waiting, or once it's read, a small check. */
/** 13.0: today's Daily Walk routine, to tick from Home (the rest opens Walk). */
function HomeRoutine({ onOpenWalk, onOpenNote }) {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: getTimeZone() }).format(new Date());
  const [data, load] = useRoutine(t, t);
  if (!data || !data.items?.length) return null;
  const done = data.items.filter((x) => x.done).length;
  return (
    <section className="home-routine" aria-label="Daily Walk">
      <div className="home-routine-head">
        <p className="home-eyebrow">Daily Walk{data.stats?.streak > 0 ? ` · ${data.stats.streak} day${data.stats.streak === 1 ? '' : 's'} in a row` : ''}</p>
        <button type="button" className="link-btn" onClick={onOpenWalk}>{data.done ? 'All done' : `${done} of ${data.items.length} done`} <Icon name="chevronRight" size={12} /></button>
      </div>
      <RoutineList data={data} date={t} today={t} onChange={load} onOpenNote={onOpenNote} compact onOpenWalk={onOpenWalk} />
    </section>
  );
}

function Reading({ walk, onOpen }) {
  const sources = walk.sources ?? [];
  if (!sources.length) return null;
  const unread = sources.filter((s) => !s.read);
  const streak = walk.stats?.streak ?? 0;
  if (!unread.length) {
    return (
      <button type="button" className="home-read-done" onClick={onOpen}>
        <span className="home-read-check"><Icon name="check" size={13} /></span>
        <span>Today’s reading is done{streak > 1 ? ` · ${streak} days in a row` : ''}</span>
      </button>
    );
  }
  return (
    <section className="home-reading" aria-label="Daily Walk">
      <div className="home-reading-text">
        <p className="home-eyebrow">Daily Walk{walk.stats?.daysThisYear ? ` · Day ${walk.stats.daysThisYear}` : ''}</p>
        <p className="home-reading-title">Today’s reading is ready</p>
        <p className="home-reading-sub">{unread.map((s) => s.name).join(' · ')}{streak > 0 ? ` · read ${streak} day${streak === 1 ? '' : 's'} in a row` : ''}{sources.length > unread.length ? ` · ${sources.length - unread.length} of ${sources.length} read` : ''}</p>
      </div>
      <button type="button" className="btn home-reading-btn" onClick={onOpen}>Read</button>
      <button type="button" className="btn home-journal-btn" onClick={onOpen}>Journal</button>
    </section>
  );
}

/** A passage's text for reading: verse numbers as superscripts, or none for a single verse. */
function verseHtml(text, single) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.trim().split(/\n{2,}/).map((para) => `<p>${esc(para.trim())
    .replace(/\s*\[(\d+)\]\s*/g, (_, n, at) => (single ? (at ? ' ' : '') : `${at ? ' ' : ''}<sup>${n}</sup>`))
    .replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * The verse of the day (9.0): today's pick (Selah's own list, or Bible Gateway's in 11.0 when chosen), read in your translation (with its switcher), with a
 * hover card on the reference, and Study it, a new note with it, or a copy to paste anywhere.
 */
function VerseOfDay({ dialog, onOpenNote, onSettings }) {
  const bible = useBible('votd');
  const [votd, setVotd] = useState(null);
  const [passage, setPassage] = useState(null);
  useEffect(() => { api.verseOfTheDay().then(setVotd).catch(() => setVotd(false)); }, []);
  useEffect(() => {
    if (!votd?.reference || !bible.connected) return;
    let live = true;
    biblePassage(votd.reference, bible.tr).then((p) => live && setPassage(p)).catch(() => live && setPassage(false));
    return () => { live = false; };
  }, [votd, bible.connected, bible.tr]);
  if (!votd) return null;
  const ref = passage?.reference ?? votd.reference;
  const label = passage?.translation ?? bible.label;
  const plain = passage ? passage.text.replace(/\s*\[\d+\]\s*/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const html = passage ? verseHtml(passage.text, passage.verses === 1) : '';

  const toNote = async () => {
    try {
      const { id } = await api.capture({ title: `Verse of the Day: ${ref}`, text: `“${plain}”\n\n${ref} (${label})` });
      onOpenNote(id);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const copy = async () => {
    const text = `“${plain}” ${ref} (${label})`;
    try {
      if (window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([`<blockquote>${html}<p>${ref} (${label})</p></blockquote>`], { type: 'text/html' }),
        })]);
      } else await navigator.clipboard.writeText(text);
      dialog.toast('Copied. Paste it into any note.');
    } catch { dialog.toast('Couldn’t copy.', 'error'); }
  };

  return (
    <section className="home-votd" aria-labelledby="home-votd-h" onClick={openRefClick}>
      <span className="home-votd-mark" aria-hidden="true">“</span>
      <div className="home-votd-head">
        <h2 id="home-votd-h" className="home-votd-eyebrow">Verse of the Day</h2>
        <TranslationPicker bible={bible} className="home-votd-tr" />
      </div>
      {!votd.reference ? (
        <p className="home-votd-empty">Today’s verse isn’t available. Bible Gateway couldn’t be reached; Selah tries again in an hour.</p>
      ) : bible.connected === false ? (
        <p className="home-votd-empty">
          <Scripture as="span" text={votd.reference} className="home-votd-ref" />
          {' · '}<button type="button" className="link-btn" onClick={onSettings}>Connect a Bible</button> in Settings to read it here.
        </p>
      ) : passage === false ? (
        <p className="home-votd-empty"><Scripture as="span" text={votd.reference} className="home-votd-ref" /> · The text couldn’t be loaded just now.</p>
      ) : (
        <>
          <blockquote className={`home-votd-text ${passage ? '' : 'is-loading'}`} dangerouslySetInnerHTML={{ __html: html || '<p>&nbsp;</p>' }} />
          <div className="home-votd-foot">
            <div className="home-votd-cite"><Scripture as="span" text={ref} className="home-votd-ref" /><Credit passage={passage || null} className="home-votd-tl" /></div>
            <span className="home-votd-actions">
              {device.full && (<button type="button" className="btn btn-small" onClick={() => startStudy(dialog, ref)} title="A Bible study of this passage"><Icon name="book" size={13} /> Study it</button>)}
              <button type="button" className="btn btn-small" onClick={toNote} disabled={!passage} title="A new note in your Inbox with this verse"><Icon name="note" size={13} /> New note</button>
              <button type="button" className="icon-btn" onClick={copy} disabled={!passage} title="Copy the verse to paste into a note" aria-label="Copy the verse"><Icon name="copy" size={15} /></button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/** Desk's next things, as rows: lessons and sermons with how ready they are, writing toward its goal, studies' pace, classes. */
function NextUp({ desk, onOpen, onOpenItem, onDesk, dialog }) {
  const learnDue = desk.week.filter((w) => w.study.tab === 'learn' && w.kind !== 'session');
  const row = (key, color, title, sub, meter, note, buttons) => (
    <div key={key} className="next-row">
      <div className="next-text">
        <span className="next-title"><span className="home-dot" style={{ background: color }} />{title}</span>
        {sub && <span className="next-sub">{sub}</span>}
        {(meter || note) && <span className="next-meter">{meter}{note}</span>}
      </div>
      {buttons}
    </div>
  );
  const steps = (n, done, color) => (
    <span className="next-steps" aria-hidden="true">{Array.from({ length: n }, (_, i) => <span key={i} style={{ background: i < done ? color : undefined }} />)}</span>
  );
  const open = (fn, label = 'Open') => <button type="button" className="btn btn-small" onClick={fn}>{label}</button>;
  const rows = [
    ...desk.teach.map((x) => {
      const color = STUDY_HEX[x.study.color] ?? STUDY_HEX.blue;
      const preach = x.study.kind === 'preaching';
      const done = x.ready === 'ready' ? 4 : x.ready === 'none' ? 0 : 4 - x.missing.length;
      const when = x.item.date ? relativeDay(x.item.date) : '';
      return row(`t${x.item.id}`, color, x.note_title || x.item.title,
        [preach ? 'Sermon' : 'Lesson', x.study.title, x.item.ref, when].filter(Boolean).join(' · '),
        preach ? null : steps(4, done, color),
        <span className={`next-note ${x.ready === 'ready' ? 'is-ready' : ''}`}>{x.ready === 'ready' ? 'Ready' : x.ready === 'none' ? 'Not started' : preach ? 'Started' : `${done} of 4 steps written`}</span>,
        <>
          {open(() => onOpenItem(x))}
          {!device.phone && x.note_id && (
            <button type="button" className={`btn btn-small next-go ${preach ? 'is-preach' : ''}`} onClick={() => (preach ? preachNote : teachNote)(dialog, x.note_id)}>
              <Icon name="play" size={11} /> {preach ? 'Preach' : 'Teach'}
            </button>
          )}
        </>);
    }),
    ...desk.writing.slice(0, 2).map((w) => {
      const color = STUDY_HEX[w.study.color] ?? STUDY_HEX.purple;
      return row(`w${w.study.id}`, color, w.study.title,
        ['Writing', w.next ? `Next: ${w.next.title}` : null, w.target ? `by ${formatShortDate(w.target)}` : null].filter(Boolean).join(' · '),
        w.goal > 0 ? <span className="next-bar"><span style={{ width: `${Math.min(100, (w.words / w.goal) * 100)}%`, background: color }} /></span> : null,
        <span className="next-note">{w.goal ? `${w.words.toLocaleString()} of ${w.goal.toLocaleString()} words` : `${w.words.toLocaleString()} words`}</span>,
        open(() => onOpen(w.study)));
    }),
    ...desk.pace.slice(0, 2).map((p) => {
      const color = STUDY_HEX[p.study.color] ?? STUDY_HEX.green;
      return row(`s${p.study.id}`, color, p.study.title,
        ['Study', p.next ? `Next: ${p.next.title}${p.next.date ? ` · ${relativeDay(p.next.date)}` : ''}` : p.total ? 'All done' : 'Nothing scheduled'].join(' · '),
        p.total > 0 ? <span className="next-bar"><span style={{ width: `${Math.min(100, (p.done / p.total) * 100)}%`, background: color }} /></span> : null,
        <span className={`next-note ${p.behind ? 'is-late' : ''}`}>{p.total ? `${p.done} of ${p.total} done${p.behind ? ` · ${p.behind} behind` : ''}` : ''}</span>,
        open(() => onOpen(p.study)));
    }),
    desk.counts.learn > 0 && row('learn', '#b7700a', learnDue.length ? `${learnDue.length} due this week` : 'Nothing due this week',
      ['Learn', learnDue[0] ? `First: ${learnDue[0].title} · ${relativeDay(learnDue[0].date)}` : null].filter(Boolean).join(' · '),
      null, desk.late.learn > 0 ? <span className="next-note is-late">{desk.late.learn} overdue</span> : null, open(onDesk)),
  ].filter(Boolean);
  return (
    <section className="home-card-panel" aria-labelledby="home-next-h">
      <div className="home-section-head"><h2 id="home-next-h">Next up</h2></div>
      {rows.length ? <div className="next-rows">{rows}</div> : (
        <button type="button" className="next-empty" onClick={onDesk}>
          <strong>Start something on Desk</strong>
          <span>A study, a teaching series, a sermon series, a writing project or a class: what’s next shows up here.</span>
        </button>
      )}
    </section>
  );
}

function NoteRow({ id, title, sub, when, onOpen, onMenu, pinned }) {
  return (
    <button type="button" className="home-note" onClick={onOpen} onContextMenu={onMenu}
      onAuxClick={(e) => { if (e.button === 1 && id) { e.preventDefault(); window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'note', id, title } })); } }}>
      <span className="home-note-text">
        <span className="home-note-title">{pinned && <Icon name="pin" size={12} />}{title || 'Untitled'}</span>
        {sub && <span className="home-note-sub">{sub}</span>}
      </span>
      {when && <span className="home-note-when">{ago(when)}</span>}
    </button>
  );
}

/** The notes you were last in: Desk's (with what each is) first, then your other recent notes. */
function Continue({ desk, dash, onOpenNote, noteMenu, dialog }) {
  const fromDesk = (desk ? desk.continue : []).map((n) => ({ id: n.note_id, title: n.title, sub: `${WHAT[n.what]} · ${n.study.title}`, when: n.updated_at }));
  const ids = new Set(fromDesk.map((n) => n.id));
  const rest = dash.recentNotes.filter((n) => !ids.has(n.id)).map((n) => ({ id: n.id, title: n.title, sub: n.notebook ?? '', when: n.updated_at, note: n }));
  const list = [...fromDesk, ...rest].sort((a, b) => b.when - a.when).slice(0, 5);
  return (
    <section className="home-card-panel" aria-labelledby="home-cont-h">
      <div className="home-section-head"><h2 id="home-cont-h">Pick up</h2></div>
      {list.length ? (
        <div className="home-notes">
          {list.map((n) => <NoteRow key={n.id} id={n.id} title={n.title} sub={n.sub} when={n.when} onOpen={() => onOpenNote(n.id)}
            onMenu={n.note ? (e) => dialog.contextMenu(e, noteMenu(n.note)) : undefined} />)}
        </div>
      ) : <p className="home-empty">The notes you write in show up here.</p>}
    </section>
  );
}

/**
 * Shared with you (8.0): new and updated shares from contacts, and comments waiting on notes you share. Only in the
 * cloud, and only once something has been shared.
 */
function SharedCard({ sharing, onOpenNote }) {
  const open = (id) => window.dispatchEvent(new CustomEvent('noteapp:open-shared', { detail: { id } }));
  const shares = sharing.sharedWithMe.slice(0, 5);
  return (
    <section className="home-card-panel home-shared" aria-labelledby="home-shared-h">
      <div className="home-section-head"><h2 id="home-shared-h">Shared with you</h2></div>
      <div className="home-notes">
        {sharing.newComments.map((c) => (
          <button key={`c${c.noteId}`} type="button" className="home-note is-comment" onClick={() => onOpenNote(c.noteId)}>
            <Icon name="comment" size={15} />
            <span className="home-note-text">
              <span className="home-note-title">{c.title || 'Untitled'}</span>
              <span className="home-note-sub">{c.count} new comment{c.count === 1 ? '' : 's'}{c.fromName ? ` from ${c.fromName}` : ''}</span>
            </span>
            <span className="home-note-when">{ago(c.at)}</span>
          </button>
        ))}
        {shares.map((s) => (
          <button key={s.id} type="button" className="home-note" onClick={() => open(s.id)}>
            <Icon name={KIND_ICON[s.kind]} size={15} />
            <span className="home-note-text">
              <span className="home-note-title">{s.title || 'Untitled'}</span>
              <span className="home-note-sub">{s.ownerName}{s.unseen ? (s.isNew ? ' · new' : ' · updated') : ''}{s.replies ? ` · ${s.replies} repl${s.replies === 1 ? 'y' : 'ies'}` : ''}</span>
            </span>
            {s.unseen && <span className="rp-new is-new" aria-label="New" />}
            <span className="home-note-when">{ago(s.updatedAt)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** One quiet line: space used and the last backup, in color when something needs a look. */
function StatusLine({ status, onSettings }) {
  const { storage, offsite, host, auto } = status;
  const parts = [];
  let warn = false;
  // 13.0: space used is in Settings; Home only warns when it's nearly full.
  if (storage?.capacity && storage.used / storage.capacity >= 0.9) {
    warn = true;
    parts.push(`Storage ${Math.round((storage.used / storage.capacity) * 100)}% full`);
  }
  if (host) {
    if (!host.ok) warn = true;
    parts.push(host.ok ? `Backed up ${ago(host.at)}` : `The last backup didn’t finish (${ago(host.at)})`);
  }
  if (offsite?.configured) {
    const last = offsite.last;
    const failed = last && !last.ok;
    const stale = offsite.lastSuccess && Date.now() - offsite.lastSuccess.finishedAt > 48 * 3_600_000;
    if (failed || stale) warn = true;
    parts.push(offsite.running ? 'Off-site backup running…' : failed ? 'Off-site backup failed' : offsite.lastSuccess ? `Off-site backup ${ago(offsite.lastSuccess.finishedAt)}` : 'Off-site backup not run yet');
  } else if (auto) {
    // Selah Desktop's automatic backups (Settings → Data & backup).
    const failed = auto.error && (!auto.last || auto.error.at > auto.last.at);
    const stale = auto.last && auto.every !== 'off' && Date.now() - auto.last.at > (auto.every === 'weekly' ? 9 : 3) * 86_400_000;
    if (!auto.folder || failed || stale) warn = true;
    parts.push(!auto.folder ? 'Automatic backups aren’t set up' : failed ? 'The last backup failed' : auto.last ? `Backed up ${ago(auto.last.at)}` : 'No backup yet');
  } else if (offsite && !isHosted()) {
    warn = true;
    parts.push('No off-site backup');
  }
  if (!parts.length) return null;
  return (
    <button type="button" className={`home-status ${warn ? 'is-warn' : ''}`} onClick={onSettings} title="Storage and backups in Settings">
      <Icon name={warn ? 'alert' : 'database'} size={14} />
      <span>{parts.join(' · ')}</span>
    </button>
  );
}
