import { useEffect, useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import WalkTabs from './WalkTabs.jsx';
import { getTimeZone } from '../time.js';
import { JournalDialog, RoutineCards, RoutineDialog, useRoutine } from '../components/Routine.jsx';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: getTimeZone() }).format(new Date());
const asDate = (d) => new Date(`${d}T12:00:00Z`);
const addDays = (d, n) => new Date(asDate(d).getTime() + n * DAY).toISOString().slice(0, 10);
const fmt = (d, opts) => asDate(d).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Daily Walk (13.0): your own routine for the day as cards, checked off as you go (components/Routine.jsx): the prayer
 * list, devotionals, reading plans and your own items. The week strip shows which days you finished it; the streak
 * counts them in a row. Journal is a button at the top.
 */
export default function DailyWalkPage({ onOpenNote, onMenu, onSection }) {
  const dialog = useDialog();
  const [today, setToday] = useState(todayIso);
  const [date, setDate] = useState(today);
  const [data, load] = useRoutine(date, today);
  useEffect(() => { setToday(todayIso()); }, [date]);
  const go = (d) => setDate(d > todayIso() ? todayIso() : d);
  const edit = async () => { await dialog.open((close) => <RoutineDialog close={close} />); load(); };
  const journal = async () => { if (await dialog.open((close) => <JournalDialog date={date} today={today} journalId={shown?.journal} onOpenNote={onOpenNote} close={close} />)) load(); };

  const shown = data && data.date === date ? data : null;
  const days = shown?.stats?.days ?? {};
  const weekStart = addDays(date, -asDate(date).getUTCDay());
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const items = shown?.items ?? [];
  const doneCount = items.filter((x) => x.done).length;

  return (
    <div className="page dw-page">
      <header className="page-header dw-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Daily Walk</h1>
          <p className="muted">
            {fmt(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {shown?.done && <span className="dw-done"><Icon name="checkCircle" size={15} /> All done</span>}
            {shown?.stats?.streak > 0 && <span className="dw-streak-chip"><Icon name="sunrise" size={14} /> {plural(shown.stats.streak, 'day')} in a row</span>}
            {!shown?.done && items.length > 0 && <span className="rt-count">{doneCount} of {items.length} done</span>}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={journal} title="Write about today in your journal note"><Icon name={shown?.journal ? 'checkCircle' : 'pen'} size={15} /> Journal</button>
          <button className="btn" onClick={edit}><Icon name="sliders" size={15} /> Edit routine</button>
        </div>
      </header>
      <WalkTabs tab="dailywalk" onSection={onSection} />

      <nav className="dw-days" aria-label="Choose a day">
        <button className="icon-btn" onClick={() => go(addDays(date, -7))} aria-label="Previous week"><Icon name="chevronLeft" size={18} /></button>
        <div className="dw-week">
          {week.map((d) => (
            <button key={d} type="button" disabled={d > today} className={`dw-day ${d === date ? 'is-selected' : ''} ${d === today ? 'is-today' : ''}`}
              onClick={() => go(d)} aria-current={d === date ? 'date' : undefined}>
              <span className="dw-day-name">{WEEKDAYS[asDate(d).getUTCDay()]}</span>
              <span className="dw-day-num">{asDate(d).getUTCDate()}</span>
              <span className={`dw-day-dot lvl-${days[d] ?? 0}`} />
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => go(addDays(date, 7))} disabled={weekStart >= addDays(today, -asDate(today).getUTCDay())} aria-label="Next week"><Icon name="chevronRight" size={18} /></button>
        <div className="dw-days-actions">
          <button className="btn btn-small" disabled={date === today} onClick={() => setDate(todayIso())}>Today</button>
        </div>
      </nav>

      {shown && items.length > 0 && <RoutineCards data={shown} date={date} today={today} onChange={load} onSection={onSection} onEdit={edit} />}
      {shown && !items.length && (
        <section className="rt-empty">
          <Icon name="sunrise" size={28} />
          <h2>Set up your routine</h2>
          <p className="muted">Pick what you do each day: a reading plan’s passages, your prayer list, a line in your journal, or anything else (a memory verse, quiet time). Nothing is required, and you can change it anytime.</p>
          <button type="button" className="btn btn-primary" onClick={edit}><Icon name="plus" size={15} /> Set up your routine</button>
        </section>
      )}
      {!shown && <p className="muted">Loading…</p>}
      {shown?.stats?.longest > 1 && <p className="muted rt-longest">Longest streak: {plural(shown.stats.longest, 'day')}</p>}
    </div>
  );
}
