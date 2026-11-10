import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { BOOKS } from '../../../shared/scripture.js';
import {
  CSV_TEMPLATE, EVERY_DAY, bookChapters, dateOf, planFromCsv, planToCsv, readingDaysUntil, splitChapters,
} from '../../../shared/readingPlans.js';
import { todayStr } from '../time.js';

/**
 * Reading plans' dialogs (10.2): starting a plan (a built-in one, one you build from books, or a CSV), and the whole
 * schedule of one plan. Helpers for the Plans page and Home are here too.
 */

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const fmtDay = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(asDate(iso));
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Every day", "Mon–Fri", or the days listed. */
export function weekdaysLabel(mask) {
  const m = mask || EVERY_DAY;
  if (m === EVERY_DAY) return 'every day';
  if (m === 0b0111110) return 'Monday to Friday';
  return WEEKDAY_NAMES.filter((_, i) => (m >> i) & 1).join(', ');
}

/** Saves text as a file. */
export function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadTemplate = () => download('reading-plan-template.csv', CSV_TEMPLATE);
export const fileName = (title) => `${String(title || 'reading plan').replace(/[\\/:*?"<>|]+/g, '').trim() || 'reading plan'}.csv`;

/** The days of the week a plan reads on: seven toggles. */
function WeekdayPicker({ value, onChange }) {
  return (
    <div className="rplan-weekdays" role="group" aria-label="Reading days">
      {WEEKDAY_NAMES.map((n, i) => {
        const on = !!((value >> i) & 1);
        return (
          <button key={n} type="button" className={`rplan-weekday ${on ? 'is-on' : ''}`} aria-pressed={on}
            onClick={() => { const next = value ^ (1 << i); if (next) onChange(next); }}>{n}</button>
        );
      })}
    </div>
  );
}

// Quick picks for building a plan from books.
const range = (a, b) => BOOKS.filter((x) => x.order >= a && x.order <= b).map((x) => x.order);
const QUICK = [
  ['Whole Bible', range(1, 66)],
  ['Old Testament', range(1, 39)],
  ['New Testament', range(40, 66)],
  ['Gospels', range(40, 43)],
  ['Psalms & Proverbs', [19, 20]],
  ['Paul’s letters', range(45, 57)],
];
const SECTIONS = [...new Set(BOOKS.map((b) => `${b.testament}|${b.section}`))];

/** Building a plan from books: which books, how fast, which days. */
function BuildStep({ start, setStart, weekdays, setWeekdays, onBack, onCreate, busy }) {
  const [title, setTitle] = useState('');
  const [books, setBooks] = useState(() => new Set(range(40, 66)));
  const [pace, setPace] = useState('days'); // days | perDay | until
  const [days, setDays] = useState(90);
  const [perDay, setPerDay] = useState(3);
  const [until, setUntil] = useState('');
  const chapters = useMemo(() => bookChapters([...books]), [books]);
  const count = pace === 'days' ? Math.max(1, Math.min(3000, Number(days) || 1))
    : pace === 'perDay' ? Math.ceil(chapters.length / Math.max(1, Number(perDay) || 1))
      : until && until >= start ? readingDaysUntil(start, until, weekdays) : 0;
  const schedule = useMemo(() => (chapters.length && count ? splitChapters(chapters, Math.min(count, chapters.length)) : []), [chapters, count]);
  const toggle = (o) => setBooks((s) => { const n = new Set(s); if (n.has(o)) n.delete(o); else n.add(o); return n; });
  const quick = (list) => setBooks(new Set(list));
  const same = (list) => list.length === books.size && list.every((o) => books.has(o));
  const last = schedule.length ? dateOf({ start_date: start, weekdays, offset: 0 }, schedule.length - 1) : null;
  const error = !books.size ? 'Pick at least one book.' : pace === 'until' && !count ? 'Pick a finish date after the start.' : '';
  return (
    <>
      <label className="field">Name<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New Testament in 90 days" autoFocus /></label>
      <div className="field">
        <span>Books</span>
        <div className="rplan-quick">
          {QUICK.map(([l, list]) => <button key={l} type="button" className={`tag-bar-chip ${same(list) ? 'is-on' : ''}`} onClick={() => quick(list)}>{l}</button>)}
          <button type="button" className="tag-bar-more" onClick={() => setBooks(new Set())}>Clear</button>
        </div>
        <div className="rplan-books">
          {SECTIONS.map((key) => {
            const [t, section] = key.split('|');
            const list = BOOKS.filter((b) => b.testament === t && b.section === section);
            return (
              <div key={key} className="rplan-book-group">
                <div className="rplan-book-head">{section}</div>
                {list.map((b) => (
                  <label key={b.order} className="rplan-book">
                    <input type="checkbox" checked={books.has(b.order)} onChange={() => toggle(b.order)} />{b.name}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="field">
        <span>Pace</span>
        <div className="rplan-pace">
          <label><input type="radio" checked={pace === 'days'} onChange={() => setPace('days')} /> In <input className="input input-inline rplan-num" type="number" min="1" max="3000" value={days} onChange={(e) => { setPace('days'); setDays(e.target.value); }} /> reading days</label>
          <label><input type="radio" checked={pace === 'perDay'} onChange={() => setPace('perDay')} /> <input className="input input-inline rplan-num" type="number" min="1" max="50" value={perDay} onChange={(e) => { setPace('perDay'); setPerDay(e.target.value); }} /> chapters a day</label>
          <label><input type="radio" checked={pace === 'until'} onChange={() => setPace('until')} /> Finish by <input className="input input-inline" type="date" value={until} min={start} onChange={(e) => { setPace('until'); setUntil(e.target.value); }} /></label>
        </div>
      </div>
      <div className="field-row">
        <label className="field">Start<input className="input" type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
        <div className="field">Reading days<WeekdayPicker value={weekdays} onChange={setWeekdays} /></div>
      </div>
      {!error && schedule.length > 0 && (
        <p className="muted rplan-preview">
          {plural(chapters.length, 'chapter')} over {plural(schedule.length, 'day')}, about {Math.round((chapters.length / schedule.length) * 10) / 10} a day,
          finishing {fmtDay(last, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. Day 1: {schedule[0].join(', ')}.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions spread">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!!error || busy || !schedule.length}
          onClick={() => onCreate({ source: 'custom', title: title.trim() || `${QUICK.find(([, list]) => same(list))?.[0] ?? (books.size === 1 ? BOOKS.find((b) => books.has(b.order)).name : 'My plan')} in ${schedule.length} days`, schedule })}>Start plan</button>
      </div>
    </>
  );
}

/** Importing a plan from a CSV file (the template's shape). */
function ImportStep({ start, setStart, weekdays, setWeekdays, onBack, onCreate, busy }) {
  const [title, setTitle] = useState('');
  const [read, setRead] = useState(null); // { schedule, errors, name }
  const pick = async (file) => {
    if (!file) return;
    const r = planFromCsv(await file.text());
    setRead({ ...r, name: file.name });
    if (!title) setTitle(file.name.replace(/\.csv$/i, ''));
  };
  const ok = read && !read.errors.length && read.schedule.length;
  return (
    <>
      <p className="muted">
        One row per day: the day number, then its passages in the next columns (or several in one, separated by “;”).
        {' '}<button type="button" className="link-btn" onClick={downloadTemplate}><Icon name="download" size={13} /> Download the template</button>
      </p>
      <label className="file-drop">
        <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        {read ? `${read.name}: ${plural(read.schedule.length, 'day')}` : 'Choose a .csv file…'}
      </label>
      {read?.errors.length > 0 && (
        <div className="form-error rplan-errors">
          <strong>{plural(read.errors.length, 'problem')} to fix first:</strong>
          <ul>{read.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {ok && <p className="muted rplan-preview">Day 1: {read.schedule[0].join(', ') || 'nothing'}. Day 2: {read.schedule[1]?.join(', ') || 'nothing'}.</p>}
      <label className="field">Name<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Our church’s plan" /></label>
      <div className="field-row">
        <label className="field">Start<input className="input" type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
        <div className="field">Reading days<WeekdayPicker value={weekdays} onChange={setWeekdays} /></div>
      </div>
      <div className="modal-actions spread">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!ok || !title.trim() || busy}
          onClick={() => onCreate({ source: 'csv', title: title.trim(), schedule: read.schedule })}>Start plan</button>
      </div>
    </>
  );
}

/** Starting a built-in plan: by the calendar, or from day 1 on a date. */
function BuiltInStep({ plan, start, setStart, weekdays, setWeekdays, onBack, onCreate, busy }) {
  const today = todayStr();
  const [calendar, setCalendar] = useState(plan.calendar);
  const dayToday = Math.floor((asDate(today) - asDate(`${today.slice(0, 4)}-01-01`)) / 86_400_000) + 1;
  return (
    <>
      <p className="muted">{plan.about}</p>
      <p className="muted">{plural(plan.days, 'day')}, about {plan.perDay} reading{plan.perDay === 1 ? '' : 's'} a day.</p>
      <div className="choice-list">
        {plan.calendar && (
          <label className={`choice ${calendar ? 'is-active' : ''}`}>
            <input type="radio" checked={calendar} onChange={() => setCalendar(true)} />
            Follow the calendar: today is day {dayToday}, and January 1 starts it again. Earlier days don’t count as missed.
          </label>
        )}
        <label className={`choice ${!calendar ? 'is-active' : ''}`}>
          <input type="radio" checked={!calendar} onChange={() => setCalendar(false)} />
          Start at day 1
        </label>
      </div>
      {!calendar && (
        <div className="field-row">
          <label className="field">Start<input className="input" type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
          <div className="field">Reading days<WeekdayPicker value={weekdays} onChange={setWeekdays} /></div>
        </div>
      )}
      <div className="modal-actions spread">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onCreate({ source: plan.key, calendar })}>Start plan</button>
      </div>
    </>
  );
}

/** New reading plan: pick one of Selah's, build your own, or import a CSV. Resolves to the new plan or null. */
export function NewPlanDialog({ close, initial = null }) {
  const [catalog, setCatalog] = useState(null);
  const [step, setStep] = useState(initial); // null | built-in key | 'build' | 'import'
  const [start, setStart] = useState(todayStr());
  const [weekdays, setWeekdays] = useState(EVERY_DAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.planCatalog().then(setCatalog).catch((e) => setError(e.message)); }, []);
  const create = async (body) => {
    setBusy(true);
    setError('');
    try {
      close(await api.createPlan({ ...body, start_date: start, weekdays, today: todayStr() }));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  const built = catalog?.find((p) => p.key === step);
  const shared = { start, setStart, weekdays, setWeekdays, onBack: () => setStep(null), onCreate: create, busy };
  return (
    <div className="rplan-dialog">
      <div className="dialog-header">
        <h2>{built ? built.title : step === 'build' ? 'Build a Plan' : step === 'import' ? 'Import a Plan' : 'New Reading Plan'}</h2>
        <button className="icon-btn" onClick={() => close(null)} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <ol className="rplan-steps" aria-label="Steps">
        {['Choose', 'Set it up', 'Start'].map((l, i) => <li key={l} className={(step ? 1 : 0) >= i ? 'is-on' : ''}><span>{i + 1}</span>{l}</li>)}
      </ol>
      {!step && <h3 className="rplan-group">Ready-made plans</h3>}
      {!step && (
        <div className="rplan-picks">
          {(catalog ?? []).map((p) => (
            <button key={p.key} type="button" className="rplan-pick" onClick={() => setStep(p.key)}>
              <span className="rplan-pick-title"><Icon name="book" size={16} /> {p.title}</span>
              <span className="rplan-pick-about">{p.about}</span>
              <span className="rplan-pick-meta">{plural(p.days, 'day')} · about {p.perDay} a day</span>
            </button>
          ))}
        </div>
      )}
      {!step && <h3 className="rplan-group">Your own</h3>}
      {!step && (
        <div className="rplan-picks is-own">
          <button type="button" className="rplan-pick" onClick={() => setStep('build')}>
            <span className="rplan-pick-title"><Icon name="plus" size={16} /> Build your own</span>
            <span className="rplan-pick-about">Pick the books, then how fast: a number of days, chapters a day, or a date to finish by.</span>
          </button>
          <button type="button" className="rplan-pick" onClick={() => setStep('import')}>
            <span className="rplan-pick-title"><Icon name="upload" size={16} /> Import a CSV</span>
            <span className="rplan-pick-about">A plan from a spreadsheet: a day number, then its passages. Start from the template.</span>
          </button>
        </div>
      )}
      {built && <BuiltInStep plan={built} {...shared} />}
      {step === 'build' && <BuildStep {...shared} />}
      {step === 'import' && <ImportStep {...shared} />}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** A plan's whole schedule: every day with its date and passages, ticked as read. */
export function PlanScheduleDialog({ planId, close }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.plan(planId, todayStr()).then(setPlan).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!plan) return;
    document.querySelector(`.rplan-sched-day[data-day="${Math.max(0, Math.min(plan.day, plan.days - 1))}"]`)?.scrollIntoView({ block: 'center' });
  }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = async (day, item, read) => {
    try { await api.setPlanRead(planId, { day, item, read, today: todayStr() }); load(); } catch (e) { setError(e.message); }
  };
  return (
    <div className="rplan-dialog rplan-sched">
      <div className="dialog-header">
        <h2>{plan?.title ?? 'Reading plan'}</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      {plan && <p className="muted">{plural(plan.days, 'day')}, read {weekdaysLabel(plan.weekdays)} · {plan.progress.read} of {plan.progress.total} passages read</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="rplan-sched-list">
        {plan?.schedule.map((items, day) => {
          const all = items.length > 0 && items.every((x) => x.read);
          return (
            <div key={day} data-day={day} className={`rplan-sched-day ${day === plan.day ? 'is-today' : ''} ${all ? 'is-read' : ''}`}>
              <label className="rplan-sched-head">
                <input type="checkbox" checked={all} disabled={!items.length} onChange={() => tick(day, null, !all)} aria-label={`Day ${day + 1} read`} />
                <span>Day {day + 1}</span>
                <span className="muted">{fmtDay(dateOf(plan, day))}{day === plan.day ? ' · today' : ''}</span>
              </label>
              <div className="rplan-sched-items">
                {items.map((x, i) => (
                  <label key={i} className={`rplan-sched-item ${x.read ? 'is-read' : ''}`}>
                    <input type="checkbox" checked={x.read} onChange={() => tick(day, i, !x.read)} />{x.ref}
                  </label>
                ))}
                {!items.length && <span className="muted">A day off</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="modal-actions spread">
        <button type="button" className="btn" disabled={!plan} onClick={() => download(fileName(plan.title), planToCsv(plan.schedule.map((d) => d.map((x) => x.ref))))}>
          <Icon name="download" size={14} /> Download as CSV
        </button>
        <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}
