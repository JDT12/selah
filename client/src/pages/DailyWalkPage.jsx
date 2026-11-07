import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import WalkTabs from './WalkTabs.jsx';
import Scripture, { openRefClick } from '../components/Scripture.jsx';
import { PrayerToday } from '../components/PrayerDialogs.jsx';
import { getTimeZone } from '../time.js';
import { useStoredState } from '../useStoredState.js';
import { notebookOptions } from '../components/NoteEditor.jsx';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: getTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso, n) => new Date(asDate(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const fmt = (iso, opts) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(asDate(iso));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// A book's title without its subtitle ("Daily Doctrine: A One-Year Guide…" -> "Daily Doctrine"), for tabs and stats.
const shortName = (name) => name.replace(/\s*[:–—]\s.*$/, '') || name;

function ReadCheck({ source, onToggle, big = false }) {
  return (
    <button type="button" className={`dw-check ${source.read ? 'is-on' : ''} ${big ? 'dw-check-big' : ''}`}
      onClick={() => onToggle(source)} aria-pressed={source.read}>
      <span className="dw-check-box"><Icon name="check" size={big ? 16 : 14} strokeWidth={3} /></span>
      <span>{source.read ? 'Read' : big ? 'Mark as read' : 'Read?'}</span>
    </button>
  );
}

function ReadingCard({ source, onToggle, onRetry, next, onNext }) {
  const byline = [source.author, source.num && `Day ${source.num} of ${source.length}`].filter(Boolean).join(' · ');
  const head = (
    <header className="dw-card-head">
      <div className="dw-card-kicker">
        <span>{source.name}</span>
        {byline && <span className="dw-card-author">{byline}</span>}
      </div>
      {!source.error && !source.missing && <ReadCheck source={source} onToggle={onToggle} />}
    </header>
  );
  if (source.error) {
    return (
      <article className={`dw-card dw-card-${source.kind}`}>
        {head}
        <div className="dw-card-empty">
          <p>Couldn’t load today’s reading. {source.error}</p>
          <div className="dw-card-actions">
            <button className="btn btn-small" onClick={onRetry}>Try again</button>
          </div>
        </div>
      </article>
    );
  }
  if (source.missing) {
    return (
      <article className={`dw-card dw-card-${source.kind}`}>
        {head}
        <div className="dw-card-empty"><p>{source.note ?? 'This book has no reading for this day.'}</p></div>
      </article>
    );
  }
  return (
    <article className={`dw-card dw-card-${source.kind} ${source.read ? 'is-read' : ''}`}>
      {head}
      <h2 className="dw-title dw-title-refs">{source.title}</h2>
      <Scripture className="dw-body" html={source.html} />
      <footer className="dw-card-foot">
        <ReadCheck source={source} onToggle={onToggle} big />
        {source.read && next && (
          <button type="button" className="btn btn-small dw-next" onClick={() => onNext(next)}>
            Next: {next.name} <Icon name="chevronRight" size={14} />
          </button>
        )}
        <span className="dw-credit">{source.author ? `© ${source.author}` : ''}</span>
      </footer>
    </article>
  );
}

function Heatmap({ heat, today, selected, onPick }) {
  // 26 weeks ending with this week, Sunday at the top.
  const end = addDays(today, 6 - asDate(today).getUTCDay());
  const cols = [];
  for (let w = 25; w >= 0; w--) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const iso = addDays(end, -(w * 7) - (6 - d));
      col.push(iso);
    }
    cols.push(col);
  }
  return (
    <div className="dw-heat" role="grid" aria-label="Reading history, last 26 weeks">
      {cols.map((col) => (
        <div key={col[0]} className="dw-heat-col">
          {col.map((iso) => {
            const level = heat[iso] ?? 0;
            const future = iso > today;
            return (
              <button key={iso} type="button" disabled={future}
                className={`dw-heat-cell lvl-${level} ${iso === selected ? 'is-selected' : ''} ${future ? 'is-future' : ''}`}
                title={`${fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' })}: ${['not read', 'partly read', 'all read'][level]}`}
                onClick={() => onPick(iso)} />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Stats({ stats, sources, today, selected, onPick }) {
  if (!stats) return null;
  const names = { ...Object.fromEntries(sources.map((s) => [s.key, shortName(s.name).replace(/^ESV /, '')])), prayer: 'Prayer' };
  return (
    <section className="dw-stats">
      <div className="dw-tiles">
        <div className="dw-tile dw-tile-streak">
          <span className="dw-tile-num">{stats.streak}</span>
          <span className="dw-tile-label">day streak</span>
          <span className="dw-tile-sub">Longest {plural(stats.longest, 'day')}</span>
        </div>
        <div className="dw-tile">
          <span className="dw-tile-num">{stats.monthDays}<small>/{stats.daysThisMonth}</small></span>
          <span className="dw-tile-label">days this month</span>
          <span className="dw-tile-sub">every reading done</span>
        </div>
        <div className="dw-tile">
          <span className="dw-tile-num">{stats.yearDays}<small>/{stats.daysThisYear}</small></span>
          <span className="dw-tile-label">days this year</span>
          <span className="dw-tile-sub">{plural(stats.readings, 'reading')} in all</span>
        </div>
        <div className="dw-tile dw-tile-sources">
          {Object.entries(stats.perSource).map(([key, n]) => (
            <span key={key} className="dw-source-count" title={names[key]}><strong>{n}</strong> {names[key] ?? 'Removed book'}</span>
          ))}
          <span className="dw-tile-sub">days this year</span>
        </div>
      </div>
      <div className="dw-heat-wrap">
        <Heatmap heat={stats.heat} today={today} selected={selected} onPick={onPick} />
        <div className="dw-heat-legend"><span>Less</span><i className="lvl-0" /><i className="lvl-1" /><i className="lvl-2" /><span>All read</span></div>
      </div>
    </section>
  );
}

const isWeekday = (iso) => asDate(iso).getUTCDay() % 6 !== 0;
/** The day a book read from `start` ends: `length` days later, or `length` weekdays later. */
function finishDay(start, length, schedule) {
  if (schedule === 'daily') return addDays(start, length - 1);
  let d = start;
  let n = isWeekday(d) ? 1 : 0;
  while (n < length) { d = addDays(d, 1); if (isWeekday(d)) n++; }
  return d;
}
const longDay = (iso) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' });

/** How a book's days line up with the calendar, for the Books dialog. */
function scheduleLabel(b) {
  switch (b.schedule) {
    case 'year': return `${b.length} days, by the calendar${b.length === 366 ? ' (Feb 29 only in leap years)' : ''}`;
    case 'weekdays-year': return '260 weekdays, from the first weekday of the year';
    case 'daily': return `${plural(b.length, 'day')}, every day from ${longDay(b.start_day)}`;
    case 'weekdays': return `${plural(b.length, 'day')}, weekdays from ${longDay(b.start_day)}`;
    default: return `${plural(b.entries, 'day')}, by date`;
  }
}

/**
 * When a book read by day number (not 365, 366 or 260 days) is read: every day or on weekdays, from a start day.
 * Resolves to { schedule, start_day }, or null if cancelled.
 */
function ScheduleDialog({ book, isNew, close }) {
  const [schedule, setSchedule] = useState(book.schedule === 'weekdays' ? 'weekdays' : 'daily');
  const [start, setStart] = useState(book.start_day ?? todayIso());
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start);
  return (
    <form className="dw-schedule-dialog" onSubmit={(e) => { e.preventDefault(); if (valid) close({ schedule, start_day: start }); }}>
      <h2>{isNew ? 'When Will You Read It?' : 'Reading Schedule'}</h2>
      <p className="muted"><strong>{book.title}</strong> has {plural(book.length, 'day')} of readings, numbered rather than dated.
        Choose how they line up with your days.</p>
      <div className="dw-schedule-options" role="radiogroup" aria-label="Schedule">
        {[['daily', 'Every day', 'One reading a day, weekends included'], ['weekdays', 'Weekdays', 'Monday to Friday; weekends are off']].map(([k, l, hint]) => (
          <button key={k} type="button" role="radio" aria-checked={schedule === k}
            className={`dw-schedule-option ${schedule === k ? 'is-on' : ''}`} onClick={() => setSchedule(k)}>
            <Icon name={k === 'daily' ? 'calendar' : 'briefcase'} size={18} />
            <span><strong>{l}</strong><span className="muted">{hint}</span></span>
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="dw-schedule-start">Day 1</label>
      <input id="dw-schedule-start" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
      {valid && (
        <p className="dw-schedule-summary">
          <Icon name="flag" size={14} />
          {schedule === 'weekdays' && !isWeekday(start) ? `Starts ${longDay(addDays(start, asDate(start).getUTCDay() === 6 ? 2 : 1))}, ` : ''}
          Finishes {longDay(finishDay(start, book.length, schedule))}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>{isNew ? 'Don’t add it' : 'Cancel'}</button>
        <button type="submit" className="btn btn-primary" disabled={!valid}>{isNew ? 'Add book' : 'Save'}</button>
      </div>
    </form>
  );
}

function BooksDialog({ close }) {
  const dialog = useDialog();
  const [lib, setLib] = useState(null); // { max, books }
  const [busy, setBusy] = useState(null);
  const input = useRef(null);
  const load = useCallback(() => api.dailyWalkBooks().then(setLib).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); }, [load]);
  const connected = lib?.books.filter((b) => b.connected).length ?? 0;
  const full = lib && connected >= lib.max;

  const update = async (b, body) => {
    try {
      setLib(await api.updateDailyWalkBook(b.id, body));
      return true;
    } catch (e) {
      dialog.toast(e.message, 'error');
      return false;
    }
  };
  const editSchedule = async (b, isNew = false) => {
    const r = await dialog.open((c) => <ScheduleDialog book={b} isNew={isNew} close={c} />, { dismissable: !isNew });
    if (r) return update(b, r);
    return false;
  };
  const add = async (file) => {
    if (!file) return;
    setBusy('Reading the book…');
    try {
      const b = await api.addDailyWalkBook(file, todayIso());
      setBusy(null);
      if (b.needsChoice && !(await editSchedule(b, true))) {
        await api.deleteDailyWalkBook(b.id);
        load();
        return;
      }
      dialog.toast(b.connected
        ? `Added ${b.title} (${plural(b.entries, 'day')})`
        : `Added ${b.title} to your library. ${lib?.max ?? 3} devotionals are connected; disconnect one to read it.`, 'info', b.connected ? 4000 : 7000);
      load();
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (b) => {
    const ok = await dialog.confirm({ title: `Remove ${b.title}?`, message: 'Its readings and read checks are removed from Daily Walk. Journal notes stay.', okLabel: 'Remove', danger: true });
    if (!ok) return;
    await api.deleteDailyWalkBook(b.id).catch((e) => dialog.toast(e.message, 'error'));
    load();
  };
  return (
    <div className="dw-books-dialog">
      <h2>Devotionals</h2>
      <p className="muted">Connect up to {lib?.max ?? 3} at a time; each gets its own tab on Daily Walk. Add a daily devotional as an
        EPUB whose readings are headed by date (“October 19”) or by day (“Day 1”). Books stay private to this app.</p>
      <p className="dw-books-drm"><Icon name="alert" size={15} />
        <span>Only DRM-free EPUBs can be added. Books bought from Kindle, Apple Books or most other stores are copy-protected
          and can’t be read here; look for “DRM-free” where you buy it, or download it from the publisher.</span></p>
      <div className="dw-books-meter">
        <span>{connected} of {lib?.max ?? 3} connected</span>
        <span className="dw-books-pips">{Array.from({ length: lib?.max ?? 3 }, (_, i) => <i key={i} className={i < connected ? 'is-on' : ''} />)}</span>
      </div>
      <ul className="dw-books">
        {lib?.books.map((b) => (
          <li key={b.key} className={b.connected ? 'is-connected' : ''}>
            <span className="dw-book-name">{b.title}
              <span className="muted">{b.author ? `${b.author} · ` : ''}{scheduleLabel(b)}</span>
            </span>
            <span className="dw-book-actions">
              {(b.schedule === 'daily' || b.schedule === 'weekdays') && (
                <button className="btn btn-small" onClick={() => editSchedule(b)} title="Every day or weekdays, and the start day">Schedule</button>
              )}
              <button className="btn btn-small btn-danger-text" onClick={() => remove(b)}>Remove</button>
              <button type="button" role="switch" aria-checked={b.connected} disabled={!b.connected && full}
                title={!b.connected && full ? `Disconnect one first (${lib.max} at most)` : b.connected ? 'Disconnect: hide it from Daily Walk (read history is kept)' : 'Connect: show it on Daily Walk'}
                className={`dw-connect ${b.connected ? 'is-on' : ''}`} onClick={() => update(b, { connected: !b.connected })}>
                <span className="dw-connect-knob" />
                <span>{b.connected ? 'Connected' : 'Connect'}</span>
              </button>
            </span>
          </li>
        ))}
      </ul>
      {lib && !lib.books.length && <p className="dw-books-empty muted">No devotionals yet. Add one as an EPUB.</p>}
      <input ref={input} type="file" accept=".epub,application/epub+zip" hidden onChange={(e) => { add(e.target.files[0]); e.target.value = ''; }} />
      <div className="modal-actions spread">
        <button className="btn" disabled={!!busy} onClick={() => input.current?.click()}>
          <Icon name="plus" size={15} /> {busy ?? 'Add an EPUB…'}
        </button>
        <button className="btn btn-primary" onClick={() => close(true)}>Done</button>
      </div>
    </div>
  );
}

/** Picks the notebook for a new journal note; resolves to its id, or null if cancelled. */
function JournalDialog({ day, initial, close }) {
  const dialog = useDialog();
  const [options, setOptions] = useState(null);
  const [notebook, setNotebook] = useState(null);
  useEffect(() => {
    api.tree().then((tree) => {
      const opts = notebookOptions(tree);
      setOptions(opts);
      setNotebook(opts.find((o) => o.id === initial)?.id ?? opts[0]?.id ?? null);
    }).catch((e) => dialog.toast(e.message, 'error'));
  }, [dialog, initial]);
  return (
    <form className="dw-journal-dialog" onSubmit={(e) => { e.preventDefault(); if (notebook) close(notebook); }}>
      <h2>New journal note</h2>
      <p className="muted">For {fmt(day, { weekday: 'long', month: 'long', day: 'numeric' })}, with the day’s readings, prayer prompt
        and headings to write under. It’s tagged Devotions.</p>
      {options?.length > 1 && <>
        <label className="field-label" htmlFor="dw-journal-nb">Notebook</label>
        <select id="dw-journal-nb" className="input" autoFocus value={notebook ?? ''} disabled={!options}
          onChange={(e) => setNotebook(Number(e.target.value))}>
          {options?.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </>}
      {options?.length === 0 && <p className="form-error">Create a notebook first.</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!notebook}>Create note</button>
      </div>
    </form>
  );
}

/** Daily Walk: the day's devotional readings, one tab each (up to three), with read checks, stats and a journal note. */
export default function DailyWalkPage({ onOpenNote, onMenu, onSection }) {
  const dialog = useDialog();
  const [today, setToday] = useState(todayIso);
  const [date, setDate] = useState(today);
  const [data, setData] = useState(null); // { date, sources, journal, stats }
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d) => {
    setLoading(true);
    try {
      const t = todayIso();
      setToday(t);
      const r = await api.dailyWalk(d, t);
      setData((old) => (r.date === d ? r : old));
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [dialog]);
  useEffect(() => { load(date); }, [date, load]);

  const go = useCallback((d) => setDate(d > todayIso() ? todayIso() : d), []);
  // ← and → move a day, T jumps to today (not while typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable="true"], .modal') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setDate((d) => addDays(d, -1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setDate((d) => (d < todayIso() ? addDays(d, 1) : d)); }
      if (e.key === 't' || e.key === 'T') setDate(todayIso());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = async (source) => {
    const read = !source.read;
    setData((d) => ({ ...d, sources: d.sources.map((s) => (s.key === source.key ? { ...s, read } : s)) }));
    try {
      const stats = await api.setDailyWalkRead({ source: source.key, date, read, today: todayIso() });
      setData((d) => (d.date === date ? { ...d, stats } : d));
    } catch (e) {
      dialog.toast(e.message, 'error');
      setData((d) => ({ ...d, sources: d.sources.map((s) => (s.key === source.key ? { ...s, read: !read } : s)) }));
    }
  };

  const togglePrayer = async (item) => {
    const flip = (on) => (d) => ({ ...d, prayer: { ...d.prayer, items: d.prayer.items.map((i) => (i.id === item.id ? { ...i, prayed: on } : i)) } });
    setData(flip(!item.prayed));
    try {
      const r = await api.setPrayed({ id: item.id, date, prayed: !item.prayed, today: todayIso() });
      setData((d) => (d.date === date ? { ...d, stats: r.stats, prayer: r.prayer } : d));
    } catch (e) {
      dialog.toast(e.message, 'error');
      setData(flip(item.prayed));
    }
  };

  // The last notebook chosen for a journal note (on this device), offered first next time.
  const [journalNb, setJournalNb] = useStoredState('noteapp.journalNotebook', null);
  const journal = async () => {
    try {
      let nb;
      if (!shown?.journal) {
        nb = await dialog.open((close) => <JournalDialog day={date} initial={journalNb ?? shown?.journalNotebook} close={close} />);
        if (!nb) return;
        setJournalNb(nb);
      }
      const r = await api.dailyWalkJournal(date, nb);
      onOpenNote(r.id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const books = async () => {
    await dialog.open((close) => <BooksDialog close={close} />);
    load(date);
  };

  const shown = data?.date === date ? data : null;
  const sources = shown?.sources ?? [];
  const readable = sources.filter((s) => !s.error && !s.missing);
  const prayer = shown?.prayer;
  const prayersDone = !prayer?.items.length || prayer.items.every((i) => i.prayed);
  const allRead = readable.length > 0 && readable.every((s) => s.read) && prayersDone;
  const weekStart = addDays(date, -asDate(date).getUTCDay());
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const heat = data?.stats?.heat ?? {};
  const isToday = date === today;

  // One devotional at a time, in tabs; the last one picked (on this device) stays picked.
  const [tab, setTab] = useStoredState('noteapp.dailyWalkTab', null);
  const active = sources.find((s) => s.key === tab) ?? sources[0] ?? null;
  const at = sources.indexOf(active);
  const next = [...sources.slice(at + 1), ...sources.slice(0, at)].find((s) => !s.read && !s.error && !s.missing) ?? null;
  // 1, 2, 3 pick a tab (not while typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .modal') || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = /^[1-9]$/.test(e.key) && sources[+e.key - 1];
      if (s) setTab(s.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, setTab]);
  const pick = (s) => {
    setTab(s.key);
    document.querySelector('.dw-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return (
    <div className="page dw-page" onClick={openRefClick}>
      <header className="page-header dw-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Daily Walk</h1>
          <p className="muted">
            {fmt(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {allRead && <span className="dw-done"><Icon name="checkCircle" size={15} /> {prayer?.items.length ? 'All done' : 'All read'}</span>}
            {data?.stats?.streak > 0 && (
              <button type="button" className="dw-streak-chip" title="See your reading stats"
                onClick={() => document.querySelector('.dw-stats')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                <Icon name="sunrise" size={14} /> {plural(data.stats.streak, 'day')} in a row
              </button>
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={journal} title="Write about today’s readings in a note">
            <Icon name="pen" size={15} /> {shown?.journal ? 'Open journal' : 'Journal'}
          </button>
          <button className="btn" onClick={books} title="Connect devotionals and add books">
            <Icon name="book" size={15} /> Devotionals
          </button>
        </div>
      </header>
      <WalkTabs tab="dailywalk" onSection={onSection} />

      <nav className="dw-days" aria-label="Choose a day">
        <button className="icon-btn" onClick={() => go(addDays(date, -7))} aria-label="Previous week" title="Previous week"><Icon name="chevronLeft" size={18} /></button>
        <div className="dw-week">
          {week.map((d) => (
            <button key={d} type="button" disabled={d > today}
              className={`dw-day ${d === date ? 'is-selected' : ''} ${d === today ? 'is-today' : ''}`}
              onClick={() => go(d)} aria-current={d === date ? 'date' : undefined}>
              <span className="dw-day-name">{WEEKDAYS[asDate(d).getUTCDay()]}</span>
              <span className="dw-day-num">{asDate(d).getUTCDate()}</span>
              <span className={`dw-day-dot lvl-${heat[d] ?? 0}`} />
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => go(addDays(date, 7))} disabled={weekStart >= addDays(today, -asDate(today).getUTCDay())}
          aria-label="Next week" title="Next week"><Icon name="chevronRight" size={18} /></button>
        <div className="dw-days-actions">
          <button className="btn btn-small" onClick={() => go(addDays(date, -1))} aria-label="Previous day" title="Previous day (←)"><Icon name="chevronLeft" size={15} /></button>
          <button className="btn btn-small" disabled={isToday} onClick={() => setDate(todayIso())} title="Today (T)">Today</button>
          <button className="btn btn-small" disabled={isToday} onClick={() => go(addDays(date, 1))} aria-label="Next day" title="Next day (→)"><Icon name="chevronRight" size={15} /></button>
          <label className="btn btn-small dw-pick" title="Pick a date">
            <Icon name="calendar" size={15} />
            <input type="date" value={date} max={today} aria-label="Pick a date"
              onChange={(e) => e.target.value && go(e.target.value)} />
          </label>
        </div>
      </nav>

      {prayer && (prayer.any ? (
        <section className={`dw-card dw-card-prayer ${prayer.complete ? 'is-read' : ''}`}>
          <header className="dw-card-head">
            <div className="dw-card-kicker">
              <span>{isToday ? 'Today’s prayers' : 'Prayers'}</span>
              <span className="dw-card-author">
                {prayer.items.length ? `${prayer.items.filter((i) => i.prayed).length} of ${prayer.items.length} prayed` : 'Nothing due this day'}
              </span>
            </div>
            <button type="button" className="btn btn-small" onClick={() => onSection?.('prayer')}>Prayer list <Icon name="chevronRight" size={13} /></button>
          </header>
          <PrayerToday day={prayer} onToggle={togglePrayer} empty="Nothing on your prayer list was due this day." />
        </section>
      ) : (
        <button type="button" className="dw-prayer-invite" onClick={() => onSection?.('prayer')}>
          <Icon name="heart" size={18} />
          <span><strong>Keep a prayer list.</strong> Requests you add come up here each day, and praying them counts toward your streak.</span>
          <Icon name="chevronRight" size={16} />
        </button>
      ))}

      <section className={`dw-readings ${loading && !shown ? 'is-loading' : ''}`}>
        {shown && sources.length > 0 && (
          <div className="home-tabs is-sub dw-tabs" role="tablist" aria-label="Devotionals">
            {sources.map((s, i) => {
              const off = s.missing || s.error;
              return (
                <button key={s.key} type="button" role="tab" aria-selected={s === active} title={`${s.name} (${i + 1})`}
                  aria-label={`${s.name}${s.read ? ', read' : off ? ', no reading' : ''}`}
                  className={`dw-tab dw-tab-${s.kind} ${s === active ? 'is-active' : ''} ${s.read ? 'is-read' : ''} ${off ? 'is-off' : ''}`}
                  onClick={() => setTab(s.key)}>
                  <span className="dw-tab-mark" aria-hidden="true">{s.read ? <Icon name="check" size={12} strokeWidth={3} /> : null}</span>
                  <span className="dw-tab-name">{shortName(s.name)}</span>
                </button>
              );
            })}
            {sources.length < (shown.max ?? 3) && (
              <button type="button" className="dw-tab dw-tab-add" onClick={books} title="Connect another devotional">
                <Icon name="plus" size={14} /> <span className="dw-tab-name">Add</span>
              </button>
            )}
          </div>
        )}
        {!shown && (
          <article className="dw-card dw-card-skeleton" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </article>
        )}
        {active && (
          <div role="tabpanel" aria-label={active.name}>
            <ReadingCard key={`${active.key}:${date}`} source={active} onToggle={toggle} onRetry={() => load(date)} next={next} onNext={pick} />
          </div>
        )}
        {shown && !sources.length && (
          <article className="dw-card dw-card-add">
            <Icon name="book" size={28} />
            <p>No devotionals are connected. Add a daily devotional of your own (a DRM-free EPUB) and connect up to {shown.max ?? 3} at a time.</p>
            <button className="btn" onClick={books}><Icon name="plus" size={15} /> Choose devotionals</button>
          </article>
        )}
      </section>

      <Stats stats={data?.stats} sources={sources} today={today} selected={date} onPick={go} />
    </div>
  );
}
