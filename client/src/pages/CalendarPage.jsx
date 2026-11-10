import { useCallback, useEffect, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { api } from '../api.js';
import { addDays, addMinutes, fmtD, fmtDT, nowParts, relativeDay } from '../time.js';
import { useDialog } from '../components/Dialogs.jsx';
import EventDialog, { askScope, EVENT_COLORS } from '../components/EventDialog.jsx';
import EventList from '../components/EventList.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { toggleTask } from '../components/TaskRow.jsx';
import Icon from '../components/Icon.jsx';
import { useStoredState } from '../useStoredState.js';
import { CategoryFilter, openCategories } from '../components/EventCategories.jsx';
import { shownWith, useHiddenCategories } from '../eventCategories.js';
import PlanTasks from '../components/PlanTasks.jsx';
import PlanTabs from './PlanTabs.jsx';

// FullCalendar runs in "UTC" mode and is fed floating wall-clock strings, so it shows
// exactly the stored America/Chicago times regardless of the device's time zone.
// `now` is overridden to the current Chicago wall-clock time for "today" and the now-line.

function toFc(data, shown) {
  const events = data.events.filter(shown).map((e) => ({
    id: e.key,
    title: e.title || 'Untitled event',
    start: e.start,
    // FullCalendar all-day ends are exclusive; ours are inclusive.
    end: e.all_day ? addDays(e.end, 1) : e.end,
    allDay: e.all_day,
    backgroundColor: EVENT_COLORS[e.color] ?? EVENT_COLORS.green,
    borderColor: EVENT_COLORS[e.color] ?? EVENT_COLORS.green,
    extendedProps: { kind: 'event', data: e },
  }));
  const tasks = data.tasks.filter(shown).map((t) => ({
    id: `task-${t.id}`,
    title: t.title,
    start: t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date,
    allDay: !t.due_time,
    durationEditable: false,
    // A class's assignments take the color of the category the class shows them in.
    backgroundColor: t.category_color ? EVENT_COLORS[t.category_color] : '#8e9ba8',
    borderColor: t.category_color ? EVENT_COLORS[t.category_color] : '#8e9ba8',
    classNames: ['cal-task', t.completed_at ? 'is-done' : ''],
    extendedProps: { kind: 'task', data: t },
  }));
  return [...events, ...tasks];
}

function renderContent(arg) {
  const { kind, data } = arg.event.extendedProps;
  if (kind === 'task') {
    return (
      <div className="fc-task">
        <span className="fc-task-box" style={data.category_color ? { borderColor: EVENT_COLORS[data.category_color], ...(data.completed_at ? { background: EVENT_COLORS[data.category_color] } : {}) } : undefined}>
          {data.completed_at ? '✓' : ''}
        </span>
        {data.category_icon && <span className="fc-ev-icon" style={{ color: EVENT_COLORS[data.category_color] }}><Icon name={data.category_icon} size={12} strokeWidth={2.4} /></span>}
        <span className="fc-task-title">{arg.timeText && <b>{arg.timeText} </b>}{arg.event.title}</span>
      </div>
    );
  }
  const dot = arg.view.type.startsWith('dayGrid') && !arg.event.allDay;
  return (
    <div className="fc-ev">
      {data.icon
        ? <span className="fc-ev-icon"><Icon name={data.icon} size={12} strokeWidth={2.4} /></span>
        : dot && <span className="fc-ev-dot" style={{ background: arg.event.backgroundColor }} />}
      {arg.timeText && <span className="fc-ev-time">{arg.timeText}</span>}
      <span className="fc-ev-title">{arg.event.title}{data.series ? ' ↻' : ''}</span>
    </div>
  );
}

/** Plan (7.1): the calendar, with a task panel beside it whose tasks you drag onto a day. Tasks has its own page still (All tasks). */
export default function CalendarPage({ onOpenNote, onMenu, onTasksChanged, onAllTasks, onSection }) {
  const dialog = useDialog();
  const ref = useRef(null);
  // Phones get their own remembered view (default: agenda list) and no cramped 7-day grid.
  const narrow = window.innerWidth <= 800;
  const [view, setView] = useStoredState(narrow ? 'noteapp.calendarView.mobile' : 'noteapp.calendarView', narrow ? 'listWeek' : 'dayGridMonth');
  const [mode, setMode] = useStoredState('noteapp.calendarMode', 'calendar');
  const [listVersion, setListVersion] = useState(0);
  const [tasksVersion, setTasksVersion] = useState(0);
  const refetch = () => { ref.current?.getApi().refetchEvents(); setListVersion((v) => v + 1); setTasksVersion((v) => v + 1); onTasksChanged(); };
  // From the panel: the calendar shows it; the panel's own list already reloaded.
  const calendarOnly = () => { ref.current?.getApi().refetchEvents(); setListVersion((v) => v + 1); onTasksChanged(); };
  // Categories shown or hidden here (per device).
  const [hidden, toggleHidden] = useHiddenCategories('calendar');
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useEffect(() => { ref.current?.getApi().refetchEvents(); }, [hidden]);
  const manage = async () => { await openCategories(dialog); refetch(); };

  const fetchEvents = useCallback((info, success, failure) => {
    api.calendar(info.startStr.slice(0, 10), info.endStr.slice(0, 10))
      .then((d) => success(toFc(d, shownWith(hiddenRef.current))))
      .catch((e) => { dialog.toast(e.message, 'error'); failure(e); });
  }, [dialog]);

  const openEvent = async (ev) => {
    if (await dialog.open((close) => <EventDialog event={ev} dialog={dialog} close={close} onOpenNote={onOpenNote} />)) refetch();
  };
  const newEvent = async (defaults) => {
    if (await dialog.open((close) => <EventDialog event={null} defaults={defaults} dialog={dialog} close={close} onOpenNote={onOpenNote} />)) refetch();
  };
  const openTask = async (task) => {
    if (await dialog.open((close) => <TaskDialog task={task} dialog={dialog} close={close} onOpenNote={onOpenNote} onChanged={refetch} />)) refetch();
  };
  const newTask = async (due) => {
    if (await dialog.open((close) => <TaskDialog task={null} defaults={{ due_date: due }} dialog={dialog} close={close} onOpenNote={onOpenNote} />)) refetch();
  };

  // Drag/resize of events and tasks.
  const onMove = async (info) => {
    const { kind, data } = info.event.extendedProps;
    const allDay = info.event.allDay;
    const s = info.event.start;
    try {
      if (kind === 'task') {
        await api.updateTask(data.id, { due_date: fmtD(s), due_time: allDay ? null : fmtDT(s).slice(11) });
      } else {
        const start = allDay ? fmtD(s) : fmtDT(s);
        let end;
        if (info.event.end) end = allDay ? addDays(fmtD(info.event.end), -1) : fmtDT(info.event.end);
        else end = allDay ? start : addMinutes(start, 60);
        const changes = { start, end, all_day: allDay };
        let scope = 'all';
        if (data.series) {
          scope = await askScope(dialog, { verb: 'Move' });
          if (!scope) { info.revert(); return; }
        }
        await api.updateEvent(data.id, { scope, occurrence: data.occurrence, changes });
      }
      refetch();
    } catch (e) {
      info.revert();
      dialog.toast(e.message, 'error');
    }
  };

  // A task dragged in from the panel: it's due that day (and at that time, from the week or day view).
  const onDrop = async (info) => {
    const id = Number(info.draggedEl.dataset.id);
    if (!id) return;
    try {
      await api.updateTask(id, { due_date: fmtD(info.date), due_time: info.allDay ? null : fmtDT(info.date).slice(11) });
      dialog.toast(`“${info.draggedEl.dataset.title}” is due ${relativeDay(fmtD(info.date))}`);
      refetch();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const onClick = (info) => {
    const { kind, data } = info.event.extendedProps;
    // Clicking a task's checkbox toggles it; elsewhere opens it.
    if (kind === 'task' && info.jsEvent.target.closest('.fc-task-box')) {
      toggleTask(data, dialog, refetch);
      return;
    }
    if (kind === 'task') openTask(data); else openEvent(data);
  };

  const onSelect = (info) => {
    ref.current?.getApi().unselect();
    if (info.allDay) {
      newEvent({ allDay: true, start: fmtD(info.start), end: addDays(fmtD(info.end), -1) });
    } else {
      newEvent({ allDay: false, start: fmtDT(info.start), end: fmtDT(info.end) });
    }
  };

  return (
    <div className="page page-calendar page-plan">
      <div className="plan-main">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading"><h1>Plan</h1></div>
        <div className="page-actions">
          <div className="segmented" role="group" aria-label="Show as">
            <button className={mode !== 'list' ? 'is-active' : ''} aria-pressed={mode !== 'list'} onClick={() => setMode('calendar')}>Calendar</button>
            <button className={mode === 'list' ? 'is-active' : ''} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>List</button>
          </div>
          <button className="btn" onClick={() => newTask(nowParts().date)}><Icon name="todo" size={16} /> Task</button>
          <button className="btn btn-primary" onClick={() => newEvent()}><Icon name="plus" size={16} /> Event</button>
        </div>
      </header>
      <PlanTabs tab="calendar" onSection={onSection} />
      <CategoryFilter hidden={hidden} onToggle={toggleHidden} onManage={manage} />
      {mode === 'list' ? <EventList onOpenEvent={openEvent} version={listVersion} hidden={hidden} /> : <div className="calendar-wrap">
        <FullCalendar
          ref={ref}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView={view}
          datesSet={(arg) => setView(arg.view.type)}
          headerToolbar={narrow
            ? { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridDay,listWeek' }
            : { left: 'title', center: '', right: 'today prev,next dayGridMonth,timeGridWeek,timeGridDay,listMonth' }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
          timeZone="UTC"
          now={() => nowParts().iso}
          nowIndicator
          height="100%"
          firstDay={0}
          editable
          selectable
          selectMirror
          dayMaxEvents={4}
          scrollTime="07:00:00"
          slotDuration="00:30:00"
          eventMinHeight={24}
          eventShortHeight={32}
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
          events={fetchEvents}
          eventContent={renderContent}
          eventDidMount={(arg) => arg.el.style.setProperty('--ev', arg.backgroundColor)}
          eventClick={onClick}
          eventDrop={onMove}
          eventResize={onMove}
          select={onSelect}
          droppable
          drop={onDrop}
          noEventsContent="Nothing scheduled"
        />
      </div>}
      </div>
      {!narrow && <PlanTasks version={tasksVersion} onChanged={calendarOnly} onOpenNote={onOpenNote} onAllTasks={onAllTasks} />}
    </div>
  );
}
