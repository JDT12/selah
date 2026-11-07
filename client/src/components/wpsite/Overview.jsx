import { formatDate } from '../../api.js';
import { formatMoment } from '../../time.js';
import Icon from '../Icon.jsx';
import { plural, STATUS_LABEL, SyncBadges } from './shared.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function PostLine({ p, when, actions, onOpenNote, onMenu }) {
  return (
    <li className="wp-line" onContextMenu={(e) => onMenu(e, p)}>
      <button type="button" className="wp-line-main" onClick={(e) => (p.noteId ? onOpenNote(p.noteId) : onMenu(e, p))}
        title={p.noteId ? 'Open the note' : 'Post actions'}>
        <span className="wp-line-title">{p.title}</span>
        <span className="wp-line-meta">{when}{p.noteId ? ' · from a note' : ''}</span>
      </button>
      <span className="wp-line-badges"><SyncBadges post={p} onUpdate={() => actions.postFromNote(p.noteId)} /></span>
      <button type="button" className="icon-btn" aria-label={`Actions for “${p.title}”`} title="More" onClick={(e) => onMenu(e, p)}><Icon name="more" size={16} /></button>
    </li>
  );
}

/** Posts per month for two years, with the numbers that describe the rhythm. */
function Rhythm({ archive, error, onRetry }) {
  if (error) return <section className="wp-panel"><h2>Posting rhythm</h2><p className="muted">{error}</p><button className="btn btn-small" onClick={onRetry}>Try again</button></section>;
  if (!archive) return <section className="wp-panel"><h2>Posting rhythm</h2><div className="wp-skeleton" /></section>;
  const r = archive.rhythm;
  const entries = Object.entries(r.months);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const wmax = Math.max(1, ...r.weekdays);
  return (
    <section className="wp-panel wp-rhythm">
      <h2>Posting rhythm</h2>
      <div className="wp-rhythm-nums">
        <div><strong>{r.sinceLast ?? '—'}</strong><span>{r.sinceLast === 0 ? 'posted today' : r.sinceLast === 1 ? 'day since the last post' : 'days since the last post'}</span></div>
        <div><strong>{r.perMonth}</strong><span>posts a month (last 12)</span></div>
        <div><strong>{r.monthStreak}</strong><span>{r.monthStreak === 1 ? 'month' : 'months'} in a row with a post</span></div>
        <div><strong>{r.longestGap}</strong><span>days, the longest gap</span></div>
      </div>
      <div className="wp-bars" role="img" aria-label="Posts published each month, last 24 months">
        {entries.map(([k, n]) => {
          const m = Number(k.slice(5)) - 1;
          return (
            <div key={k} className="wp-bar" title={`${MONTHS[m]} ${k.slice(0, 4)}: ${plural(n, 'post')}`}>
              <span className="wp-bar-fill" style={{ height: `${(n / max) * 100}%` }}>{n > 0 && <i>{n}</i>}</span>
              <span className="wp-bar-label">{m === 0 ? `’${k.slice(2, 4)}` : MONTHS[m].slice(0, 1)}</span>
            </div>
          );
        })}
      </div>
      <div className="wp-weekdays">
        {r.weekdays.map((n, i) => (
          <div key={DAYS[i]} title={`${plural(n, 'post')} on ${DAYS[i]}`}>
            <span style={{ opacity: 0.25 + 0.75 * (n / wmax) }} />
            <small>{DAYS[i]}</small>
          </div>
        ))}
        <p className="muted">{plural(r.total, 'post')} published{r.first ? ` since ${formatDate(Date.parse(r.first))}` : ''}.</p>
      </div>
    </section>
  );
}

/** Overview: what needs attention, what's coming up, the latest posts, and the posting rhythm. */
export default function Overview({ stats, archive, archiveError, onArchiveRetry, actions, onOpenNote, onMenu, onTab, commentsTab = true }) {
  const attention = [];
  if (stats.comments > 0) {
    attention.push(
      <li key="comments" className="wp-attn">
        <Icon name="inbox" size={16} />
        <span>{plural(stats.comments, 'comment')} waiting for approval</span>
        {commentsTab
          ? <button className="btn btn-small" onClick={() => onTab('comments')}>Review</button>
          : <a className="btn btn-small" href={`${stats.site}/wp-admin/edit-comments.php?comment_status=moderated`} target="_blank" rel="noopener noreferrer">Review <Icon name="external" size={12} /></a>}
      </li>,
    );
  }
  for (const n of stats.stale) {
    attention.push(
      <li key={`n${n.noteId}`} className="wp-attn">
        <Icon name="pen" size={16} />
        <span><button type="button" className="link-btn" onClick={() => onOpenNote(n.noteId)}>{n.title || 'Untitled'}</button> changed since it was posted
          <small className="muted"> ({STATUS_LABEL[n.status] ?? n.status}, edited {formatDate(n.updatedAt)})</small></span>
        <button className="btn btn-small btn-primary" onClick={() => actions.postFromNote(n.noteId)}>Update post</button>
      </li>,
    );
  }
  if (stats.posts.pending > 0) {
    attention.push(
      <li key="pending" className="wp-attn">
        <Icon name="clock" size={16} />
        <span>{plural(stats.posts.pending, 'post')} pending review</span>
        <button className="btn btn-small" onClick={() => onTab('pipeline')}>See them</button>
      </li>,
    );
  }

  return (
    <div className="wp-overview">
      <section className="wp-panel">
        <h2>Needs attention</h2>
        {attention.length ? <ul className="wp-attn-list">{attention}</ul> : <p className="wp-allclear"><Icon name="checkCircle" size={16} /> All caught up: no comments waiting and every posted note matches its post.</p>}
      </section>

      <div className="wp-overview-cols">
        <section className="wp-panel">
          <h2>Coming up</h2>
          {stats.scheduled.length
            ? <ul className="wp-lines">{stats.scheduled.map((p) => <PostLine key={p.id} p={p} when={formatMoment(p.date)} actions={actions} onOpenNote={onOpenNote} onMenu={onMenu} />)}</ul>
            : <p className="muted">Nothing scheduled. Drag a draft onto the <button type="button" className="link-btn" onClick={() => onTab('calendar')}>calendar</button> to schedule it.</p>}
          {stats.posts.future > stats.scheduled.length && <p className="muted">and {stats.posts.future - stats.scheduled.length} more scheduled</p>}
        </section>
        <section className="wp-panel">
          <h2>Latest</h2>
          {stats.recent.length
            ? <ul className="wp-lines">{stats.recent.map((p) => (
              <PostLine key={p.id} p={p} actions={actions} onOpenNote={onOpenNote} onMenu={onMenu}
                when={<><span className={`wp-dot is-${p.status}`} />{STATUS_LABEL[p.status] ?? p.status}{p.modified && ` · ${formatDate(Date.parse(p.modified))}`}</>} />
            ))}</ul>
            : <p className="muted">No posts yet.</p>}
          <p className="muted wp-fromnotes">
            {stats.fromNotes.total ? `${plural(stats.fromNotes.total, 'post')} from notes · ${stats.fromNotes.published} published` : 'Nothing posted from notes yet.'}
          </p>
        </section>
      </div>

      <Rhythm archive={archive} error={archiveError} onRetry={onArchiveRetry} />
    </div>
  );
}
