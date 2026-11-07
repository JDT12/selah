import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { addDays, addMonths, formatLongDate, formatMonthDay, formatTime, todayStr, toUTC } from '../time.js';
import { EVENT_COLORS } from './EventDialog.jsx';
import { useStoredState } from '../useStoredState.js';
import { shownWith } from '../eventCategories.js';
import { CategoryMark } from './EventCategories.jsx';

// The calendar's "List" mode: every event from a start date over a chosen period, one row per
// occurrence, grouped by day. An event that spans several days is listed once, on its first day
// in the range.

const PERIODS = [
  { value: '1w', label: '1 week', end: (from) => addDays(from, 6) },
  { value: '2w', label: '2 weeks', end: (from) => addDays(from, 13) },
  { value: '1m', label: '1 month', end: (from) => addDays(addMonths(from, 1), -1) },
  { value: '3m', label: '3 months', end: (from) => addDays(addMonths(from, 3), -1) },
  { value: '6m', label: '6 months', end: (from) => addDays(addMonths(from, 6), -1) },
  { value: '1y', label: '1 year', end: (from) => addDays(addMonths(from, 12), -1) },
  { value: '2y', label: '2 years', end: (from) => addDays(addMonths(from, 24), -1) },
  { value: 'custom', label: 'Until a date…' },
];
const MAX_DAYS = 740; // the server refuses more than 750

function whenText(ev) {
  const startDay = ev.start.slice(0, 10);
  const endDay = ev.end.slice(0, 10);
  if (ev.all_day) return startDay === endDay ? 'All day' : `${formatMonthDay(startDay)} – ${formatMonthDay(endDay)}`;
  if (startDay === endDay) return `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
  return `${formatTime(ev.start)} – ${formatMonthDay(endDay)}, ${formatTime(ev.end)}`;
}

export default function EventList({ onOpenEvent, version, hidden = [] }) {
  const [from, setFrom] = useState(todayStr);
  const [period, setPeriod] = useStoredState('noteapp.eventListPeriod', '1m');
  const [until, setUntil] = useState(() => addDays(addMonths(todayStr(), 1), -1));
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const preset = PERIODS.find((p) => p.value === period) ?? PERIODS[2];
  const to = preset.end ? preset.end(from) : until;
  const days = from && to ? Math.round((toUTC(to) - toUTC(from)) / 86_400_000) + 1 : 0;
  const problem = !from || !to ? 'Choose the dates to list.'
    : days < 1 ? 'The end date is before the start date.'
      : days > MAX_DAYS ? 'Choose a period of two years or less.' : null;

  useEffect(() => {
    if (problem) return undefined;
    let live = true;
    setEvents(null);
    setError(null);
    api.calendar(from, addDays(to, 1))
      .then((d) => live && setEvents(d.events))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [from, to, problem, version]);

  const shownEvents = useMemo(() => events?.filter(shownWith(hidden)) ?? null, [events, hidden]);
  const groups = useMemo(() => {
    const byDay = new Map();
    for (const ev of shownEvents ?? []) {
      const start = ev.start.slice(0, 10);
      const day = start < from ? from : start;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(ev);
    }
    return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [shownEvents, from]);

  const pickPeriod = (v) => {
    if (v === 'custom') setUntil(to); // start from the range being shown
    setPeriod(v);
  };
  const t = todayStr();

  return (
    <div className="event-list-wrap">
      <div className="event-list-controls">
        <label>
          <span className="muted">From</span>
          <input className="input input-inline" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="muted">for</span>
          <select className="input input-inline" value={preset.value} onChange={(e) => pickPeriod(e.target.value)}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {preset.value === 'custom' && (
          <label>
            <span className="muted">to</span>
            <input className="input input-inline" type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        {from !== t && <button className="btn btn-small" onClick={() => setFrom(t)}>Today</button>}
        <span className="event-list-summary muted">
          {!problem && `${formatMonthDay(from)} – ${formatMonthDay(to)}`}
          {!problem && shownEvents && ` · ${shownEvents.length} event${shownEvents.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="event-list">
        {problem && <p className="card-empty">{problem}</p>}
        {!problem && error && <p className="card-empty">{error}</p>}
        {!problem && !error && !events && <p className="card-empty">Loading…</p>}
        {!problem && shownEvents?.length === 0 && <p className="card-empty">No events in this period{hidden.length ? ' (some categories are hidden)' : ''}.</p>}
        {!problem && groups.map(([day, evs]) => (
          <section key={day} className="event-list-day">
            <h3 className={`agenda-date ${day === t ? 'is-today' : ''}`}>
              {formatLongDate(day)}{day === t && <span className="event-list-today">Today</span>}
            </h3>
            {evs.map((ev) => (
              <button key={ev.key} type="button" className="event-item" onClick={() => onOpenEvent(ev)}>
                <span className="event-bar" style={{ background: EVENT_COLORS[ev.color] ?? EVENT_COLORS.green }} />
                <span className="event-when">{whenText(ev)}</span>
                <span className="event-text">
                  <span className="event-title">{ev.icon && <CategoryMark color={ev.color} icon={ev.icon} size={13} />}{ev.title || 'Untitled event'}{ev.series && <span className="muted" title="Repeats"> ↻</span>}</span>
                  {ev.location && <span className="event-loc">{ev.location}</span>}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
