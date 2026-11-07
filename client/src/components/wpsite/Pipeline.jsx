import { useCallback, useEffect, useState } from 'react';
import { api, formatDate } from '../../api.js';
import { formatMoment } from '../../time.js';
import Icon from '../Icon.jsx';
import { SyncBadges } from './shared.jsx';

function PostCard({ p, when, actions, onMenu, children }) {
  return (
    <li className={`wp-card is-${p.status}`} onContextMenu={(e) => onMenu(e, p)}>
      <button type="button" className="wp-card-title" onClick={(e) => onMenu(e, p)}>{p.title}</button>
      <span className="wp-card-meta">{when}{p.noteId ? ' · from a note' : ''}</span>
      <span className="wp-line-badges"><SyncBadges post={p} onUpdate={() => actions.postFromNote(p.noteId)} /></span>
      {children && <div className="wp-card-actions">{children}</div>}
    </li>
  );
}

/**
 * The writing pipeline: ideas (notes tagged “Blog idea” that aren't posted yet), drafts and pending posts,
 * what's scheduled, and what was published lately.
 */
export default function Pipeline({ actions, onMenu, onOpenNote, version }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.wordpressPipeline().then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load, version]);

  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <div className="wp-board"><div className="wp-skeleton" /><div className="wp-skeleton" /><div className="wp-skeleton" /><div className="wp-skeleton" /></div>;
  const col = (key, title, icon, count, body, hint) => (
    <section className={`wp-col wp-col-${key}`}>
      <h3><Icon name={icon} size={15} /> {title} <span className="wp-col-count">{count}</span></h3>
      {count ? <ul>{body}</ul> : <p className="muted wp-col-empty">{hint}</p>}
    </section>
  );
  return (
    <div className="wp-board">
      {col('ideas', 'Ideas', 'star', data.ideas.length, data.ideas.map((n) => (
        <li key={n.id} className="wp-card is-idea">
          <button type="button" className="wp-card-title" onClick={() => onOpenNote(n.id)}>{n.title || 'Untitled'}</button>
          {n.snippet && <span className="wp-card-snippet">{n.snippet}</span>}
          <span className="wp-card-meta">Edited {formatDate(n.updated_at)}</span>
          <div className="wp-card-actions">
            <button className="btn btn-small" onClick={() => onOpenNote(n.id)}>Write</button>
            <button className="btn btn-small" onClick={() => actions.postFromNote(n.id)}>Post…</button>
          </div>
        </li>
      )), <>Tag a note <strong>{data.ideaTag}</strong> and it waits here until you post it.</>)}
      {col('drafts', 'Drafts', 'pen', data.drafts.length, data.drafts.map((p) => (
        <PostCard key={p.id} p={p} actions={actions} onMenu={onMenu}
          when={<>{p.status === 'pending' ? <span className="wp-badge">Pending review</span> : null} {p.modified ? `Edited ${formatDate(Date.parse(p.modified))}` : ''}</>}>
          {data.canPublish && <button className="btn btn-small" onClick={() => actions.schedule(p)}>Schedule…</button>}
          {p.noteId && <button className="btn btn-small" onClick={() => onOpenNote(p.noteId)}>Open note</button>}
        </PostCard>
      )), 'No drafts on the site.')}
      {col('scheduled', 'Scheduled', 'clock', data.scheduled.length, data.scheduled.map((p) => (
        <PostCard key={p.id} p={p} actions={actions} onMenu={onMenu} when={formatMoment(p.date)} />
      )), 'Nothing scheduled.')}
      {col('published', 'Published', 'globe', data.published.length, data.published.map((p) => (
        <PostCard key={p.id} p={p} actions={actions} onMenu={onMenu} when={p.date ? formatDate(Date.parse(p.date)) : ''} />
      )), 'Nothing published yet.')}
    </div>
  );
}
