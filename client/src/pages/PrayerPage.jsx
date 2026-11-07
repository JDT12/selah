import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import WalkTabs from './WalkTabs.jsx';
import Scripture, { openRefClick } from '../components/Scripture.jsx';
import { daysBetween, fmtDay, plural, PrayerDialog, PrayerQuickAdd, PrayerToday, scheduleLabel } from '../components/PrayerDialogs.jsx';
import { todayStr } from '../time.js';
import { useStoredState } from '../useStoredState.js';

const TABS = [['today', 'Today'], ['requests', 'Requests'], ['answered', 'Answered']];
const NO_CATEGORY = 'Other';

function StatTiles({ stats }) {
  return (
    <div className="dw-tiles pr-tiles">
      <div className="dw-tile dw-tile-streak">
        <span className="dw-tile-num">{stats.streak}</span>
        <span className="dw-tile-label">day streak</span>
        <span className="dw-tile-sub">Longest {plural(stats.longest, 'day')}</span>
      </div>
      <div className="dw-tile">
        <span className="dw-tile-num">{stats.yearDays}</span>
        <span className="dw-tile-label">days prayed this year</span>
        <span className="dw-tile-sub">{plural(stats.times, 'prayer')} checked in all</span>
      </div>
      <div className="dw-tile">
        <span className="dw-tile-num">{stats.active}</span>
        <span className="dw-tile-label">on the list</span>
        <span className="dw-tile-sub">{stats.archived ? `${stats.archived} archived` : 'active requests'}</span>
      </div>
      <div className="dw-tile pr-tile-answered">
        <span className="dw-tile-num">{stats.answered}</span>
        <span className="dw-tile-label">answered</span>
        <span className="dw-tile-sub">{stats.answeredThisYear} this year</span>
      </div>
    </div>
  );
}

function RequestRow({ p, onOpen }) {
  const today = todayStr();
  return (
    <li>
      <button type="button" className="pr-row" onClick={() => onOpen(p)}>
        <span className="pr-row-main">
          <span className="pr-row-title">{p.title}</span>
          <span className="pr-row-meta">
            {p.person && <span><Icon name="heart" size={12} /> {p.person}</span>}
            <span><Icon name="repeat" size={12} /> {scheduleLabel(p)}</span>
            {p.refs && <span><Icon name="bible" size={12} /> {p.refs}</span>}
            {p.updates.length > 0 && <span>{plural(p.updates.length, 'update')}</span>}
            {p.note && <span><Icon name="note" size={12} /> {p.note.title || 'Untitled'}</span>}
          </span>
        </span>
        <span className="pr-row-count" title={p.lastPrayed ? `Last prayed ${fmtDay(p.lastPrayed)}` : 'Not prayed yet'}>
          <strong>{p.times}</strong> prayed
          <small>{plural(Math.max(0, daysBetween(p.created_day, today)), 'day')}</small>
        </span>
      </button>
    </li>
  );
}

function Answered({ requests, onOpen }) {
  const answered = requests.filter((p) => p.status === 'answered').sort((a, b) => b.closed_day.localeCompare(a.closed_day) || b.id - a.id);
  if (!answered.length) {
    return (
      <div className="pr-blank">
        <Icon name="checkCircle" size={30} />
        <p>Answered prayers will gather here. When God answers one, open the request and choose <strong>Answered</strong>.</p>
      </div>
    );
  }
  let year = null;
  return (
    <ol className="pr-wall" onClick={openRefClick}>
      {answered.map((p) => {
        const y = p.closed_day.slice(0, 4);
        const head = y !== year ? <li className="pr-wall-year" key={`y${y}`}>{(year = y)}</li> : null;
        return [head, (
          <li key={p.id} className="pr-wall-item">
            <span className="pr-wall-date">{fmtDay(p.closed_day, { month: 'short', day: 'numeric' })}</span>
            <article className="pr-wall-card">
              <button type="button" className="pr-wall-title" onClick={() => onOpen(p)}>{p.title}</button>
              <p className="pr-wall-meta">
                {p.person && <>For {p.person} · </>}
                Prayed {plural(Math.max(1, daysBetween(p.created_day, p.closed_day)), 'day')}, {plural(p.times, 'time')}
                {p.category && <> · <span className="pr-cat">{p.category}</span></>}
              </p>
              {p.answer && <Scripture as="p" className="pr-wall-answer" text={p.answer} />}
              {p.refs && <Scripture as="p" className="pr-wall-refs" text={p.refs} />}
            </article>
          </li>
        )];
      })}
    </ol>
  );
}

/** A plain list to print: active requests by category, with their days. */
function PrintList({ groups }) {
  return (
    <div className="pr-print" aria-hidden="true">
      <h1>Prayer list</h1>
      <p>{fmtDay(todayStr(), { month: 'long', day: 'numeric', year: 'numeric' })}</p>
      {groups.map(([cat, list]) => (
        <section key={cat}>
          <h2>{cat}</h2>
          <ul>
            {list.map((p) => (
              <li key={p.id}>
                <strong>{p.title}</strong>{p.person ? ` (${p.person})` : ''} <em>· {scheduleLabel(p)}</em>
                {p.refs && <div>{p.refs}</div>}
                {p.details && <div>{p.details}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const groupByCategory = (list) => {
  const m = new Map();
  for (const p of list) {
    const c = p.category || NO_CATEGORY;
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(p);
  }
  return [...m].sort(([a], [b]) => (a === NO_CATEGORY) - (b === NO_CATEGORY) || a.localeCompare(b));
};

/** The prayer list: today's prayers, every request by category, and the answered prayers wall. */
export default function PrayerPage({ onOpenNote, onMenu, onSection }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [tab, setTab] = useStoredState('noteapp.prayerTab', 'today');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => api.prayer(todayStr()).then(setData).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const open = async (p) => {
    const full = data.requests.find((r) => r.id === p.id) ?? p;
    const r = await dialog.open((close) => <PrayerDialog request={full} categories={data.categories} close={close} onOpenNote={onOpenNote} />);
    if (r) load();
  };
  const add = async () => {
    const r = await dialog.open((close) => <PrayerDialog request={{ title: '' }} categories={data?.categories ?? []} close={close} onOpenNote={onOpenNote} />);
    if (r) load();
  };
  const toggle = async (item) => {
    const t = todayStr();
    setData((d) => ({ ...d, today: { ...d.today, items: d.today.items.map((i) => (i.id === item.id ? { ...i, prayed: !item.prayed } : i)) } }));
    try {
      await api.setPrayed({ id: item.id, date: t, prayed: !item.prayed, today: t });
      load();
    } catch (e) {
      dialog.toast(e.message, 'error');
      load();
    }
  };
  const setPerDay = async (n) => {
    try {
      await api.setPrayerPerDay(n, todayStr());
      load();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const requests = data?.requests ?? [];
  const active = requests.filter((p) => p.status === 'active');
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (p) => words.every((w) => [p.title, p.person, p.category, p.refs, p.details, ...p.updates.map((u) => u.text)].join(' ').toLowerCase().includes(w));
  const groups = useMemo(() => groupByCategory(active.filter(matches)), [requests, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const archived = requests.filter((p) => p.status === 'archived' && matches(p));
  const printGroups = useMemo(() => groupByCategory(active), [requests]); // eslint-disable-line react-hooks/exhaustive-deps
  const rotation = active.filter((p) => p.schedule === 'rotation').length;
  const day = data?.today;
  const left = day ? day.items.filter((i) => !i.prayed && !i.extra).length : 0;

  const print = () => {
    document.body.classList.add('printing-prayer');
    const done = () => { document.body.classList.remove('printing-prayer'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };

  return (
    <div className="page pr-page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Prayer</h1>
          <p className="muted">
            {data ? `${plural(active.length, 'request')} on your list` : 'Loading…'}
            {day?.complete && <span className="dw-done"><Icon name="checkCircle" size={15} /> All prayed today</span>}
            {data?.stats.streak > 0 && <span className="dw-streak-chip"><Icon name="heart" size={14} /> {plural(data.stats.streak, 'day')} in a row</span>}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={print} disabled={!active.length} title="Print your prayer list"><Icon name="file" size={15} /> Print</button>
          <button className="btn btn-primary" onClick={add}><Icon name="plus" size={15} /> New request</button>
        </div>
      </header>
      <WalkTabs tab="prayer" onSection={onSection} />

      <div className="home-tabs is-sub pr-tabs" role="tablist" aria-label="Prayer">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
            {l}{k === 'today' && left > 0 ? <span className="pr-tab-count">{left}</span> : null}
          </button>
        ))}
      </div>

      {!data && <div className="dw-card dw-card-skeleton" aria-hidden="true"><span /><span /><span /></div>}

      {data && tab === 'today' && (
        <section className="dw-card pr-card">
          <header className="dw-card-head">
            <div className="dw-card-kicker">
              <span>Today’s prayers</span>
              <span className="dw-card-author">{fmtDay(todayStr(), { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            </div>
          </header>
          <PrayerToday day={day} onToggle={toggle} onOpen={open}
            empty={active.length ? 'Nothing is due today. Rotation and weekday requests come up on their days.' : 'Your prayer list is empty. Add a request on the Requests tab.'} />
          {!active.length && <button className="btn" onClick={() => setTab('requests')}>Add requests</button>}
        </section>
      )}

      {data && tab === 'requests' && (
        <section className="pr-requests">
          <PrayerQuickAdd categories={data.categories} onAdded={() => load()} />
          <div className="pr-toolbar">
            <label className="pr-search">
              <Icon name="search" size={15} />
              <input className="input" type="search" placeholder="Search requests and updates" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="pr-perday" title="How many rotation requests come up each day">
              In rotation: {rotation}, praying
              <select className="input input-inline" value={data.perDay} onChange={(e) => setPerDay(Number(e.target.value))}>
                {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              a day
            </label>
          </div>
          {groups.length === 0 && (
            <div className="pr-blank">
              <Icon name="heart" size={30} />
              <p>{search ? 'No requests match.' : 'No requests yet. Type one above, like “Mom’s surgery @Mom #Family daily”.'}</p>
            </div>
          )}
          {groups.map(([cat, list]) => (
            <section key={cat} className="pr-group">
              <h2><span className="pr-cat">{cat}</span> <span className="muted">{list.length}</span></h2>
              <ul className="pr-list">{list.map((p) => <RequestRow key={p.id} p={p} onOpen={open} />)}</ul>
            </section>
          ))}
          {archived.length > 0 && (
            <section className="pr-group pr-archived">
              <button type="button" className="link-btn" onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
              </button>
              {showArchived && <ul className="pr-list">{archived.map((p) => <RequestRow key={p.id} p={p} onOpen={open} />)}</ul>}
            </section>
          )}
        </section>
      )}

      {data && tab === 'answered' && <Answered requests={requests} onOpen={open} />}

      {data && <StatTiles stats={data.stats} />}
      {data && <PrintList groups={printGroups} />}
    </div>
  );
}
