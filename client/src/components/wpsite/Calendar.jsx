import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { addDays, formatTime, fromWallClock, todayStr, toUTC, wallClock } from '../../time.js';
import { useDialog } from '../Dialogs.jsx';
import Icon from '../Icon.jsx';
import { STATUS_LABEL } from './shared.jsx';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthTitle = (ym) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUTC(`${ym}-01`));
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Editorial calendar: published and scheduled posts by day. Drag a scheduled post to another day to move it (same
 * time), or drag a draft from the side onto a day to schedule it for 9 AM. Click a post for its actions.
 */
export default function Calendar({ actions, onMenu, version }) {
  const dialog = useDialog();
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [over, setOver] = useState(null);
  const [dragging, setDragging] = useState(null);

  const first = `${month}-01`;
  const start = addDays(first, -toUTC(first).getUTCDay());
  const lastOfMonth = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDays(lastOfMonth, 6 - toUTC(lastOfMonth).getUTCDay());
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);

  const load = useCallback(() => api.wordpressCalendar(start, end).then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), [start, end]);
  useEffect(() => { load(); }, [load, version]);

  const today = todayStr();
  const byDay = new Map();
  for (const p of data?.posts ?? []) {
    if (!p.date) continue;
    const d = wallClock(p.date).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  const find = (id) => data?.posts.find((p) => p.id === id) ?? data?.drafts.find((p) => p.id === id);

  const drop = async (day, e) => {
    e.preventDefault();
    setOver(null);
    setDragging(null);
    const post = find(Number(e.dataTransfer.getData('text/x-wp-post')));
    if (!post) return;
    const time = post.status === 'future' && post.date ? wallClock(post.date).slice(11) : '09:00';
    const at = fromWallClock(`${day}T${time}`);
    if (!(at > Date.now() + 60_000)) return dialog.toast('That’s in the past. Drop it on a later day.', 'error');
    if (post.status === 'future' && post.date && wallClock(post.date).slice(0, 10) === day) return;
    if (await actions.moveTo(post, new Date(at).toISOString())) load();
  };
  const dragProps = (p) => (data?.canPublish && p.status !== 'publish' ? {
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('text/x-wp-post', String(p.id)); e.dataTransfer.effectAllowed = 'move'; setDragging(p.id); },
    onDragEnd: () => { setDragging(null); setOver(null); },
  } : {});

  return (
    <section className="wp-cal-wrap">
      <div className="wp-cal">
        <header className="wp-cal-head">
          <h2>{monthTitle(month)}</h2>
          <div className="wp-cal-nav">
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" title="Previous month"><Icon name="chevronLeft" size={18} /></button>
            <button className="btn btn-small" disabled={month === today.slice(0, 7)} onClick={() => setMonth(today.slice(0, 7))}>Today</button>
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month" title="Next month"><Icon name="chevronRight" size={18} /></button>
          </div>
        </header>
        {error && <p className="form-error">{error}</p>}
        <div className="wp-cal-grid" role="grid" aria-label={monthTitle(month)}>
          {WEEKDAYS.map((w) => <div key={w} className="wp-cal-wd">{w}</div>)}
          {days.map((d) => {
            const posts = byDay.get(d) ?? [];
            const past = d < today;
            return (
              <div key={d} role="gridcell"
                className={`wp-cal-day ${d.slice(0, 7) !== month ? 'is-other' : ''} ${d === today ? 'is-today' : ''} ${past ? 'is-past' : ''} ${over === d ? 'is-over' : ''}`}
                onDragOver={(e) => { if (dragging && !past) { e.preventDefault(); setOver(d); } }}
                onDragLeave={() => setOver((o) => (o === d ? null : o))}
                onDrop={(e) => drop(d, e)}>
                <span className="wp-cal-num">{toUTC(d).getUTCDate()}</span>
                {posts.map((p) => (
                  <button key={p.id} type="button" className={`wp-chip is-${p.status} ${p.stale ? 'is-stale' : ''}`} onClick={(e) => onMenu(e, p)}
                    title={`${p.title}\n${STATUS_LABEL[p.status]} · ${formatTime(wallClock(p.date).slice(11))}${p.stale ? '\nThe note has changed since it was posted' : ''}`} {...dragProps(p)}>
                    <span className="wp-chip-time">{formatTime(wallClock(p.date).slice(11))}</span>
                    <span className="wp-chip-title">{p.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <p className="muted wp-cal-legend">
          <span><i className="wp-dot is-publish" /> Published</span>
          <span><i className="wp-dot is-future" /> Scheduled</span>
          {data?.canPublish ? <span>Drag a scheduled post to move it, or a draft to schedule it.</span> : <span>This account can’t schedule posts.</span>}
        </p>
      </div>

      <aside className="wp-cal-drafts">
        <h3>Drafts <span className="muted">{data?.drafts.length ?? ''}</span></h3>
        {data && !data.drafts.length && <p className="muted">No drafts.</p>}
        <ul>
          {data?.drafts.map((p) => (
            <li key={p.id}>
              <button type="button" className={`wp-chip is-${p.status} is-draft`} onClick={(e) => onMenu(e, p)} {...dragProps(p)}
                title={data.canPublish ? 'Drag onto a day to schedule it, or click for more' : p.title}>
                <Icon name="grip" size={13} />
                <span className="wp-chip-title">{p.title}</span>
                {p.status === 'pending' && <span className="wp-badge">Pending</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
