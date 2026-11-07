import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatMoment } from '../../time.js';
import { useDialog } from '../Dialogs.jsx';
import Icon from '../Icon.jsx';
import { plural } from './shared.jsx';

const VIEWS = [['hold', 'Waiting'], ['approve', 'Approved'], ['spam', 'Spam'], ['trash', 'Trash']];

function Comment({ c, view, onAction, onOpenNote }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    setBusy(true);
    const ok = await onAction(c, fn);
    if (!ok) setBusy(false);
  };
  const reply = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await onAction(c, () => api.replyWordpressComment({ post: c.post.id, parent: c.id, text }), 'Reply posted');
    setBusy(false);
    if (ok) { setReplying(false); setText(''); }
  };
  return (
    <li className={`wp-comment is-${c.status}`}>
      <header>
        <span className="wp-comment-avatar" aria-hidden="true">{c.author.slice(0, 1).toUpperCase()}</span>
        <div className="wp-comment-who">
          <strong>{c.author}</strong>
          <span className="muted">
            {c.email && <>{c.email} · </>}{c.date ? formatMoment(c.date) : ''}
          </span>
        </div>
      </header>
      <p className="wp-comment-on muted">
        On {c.post.link ? <a href={c.post.link} target="_blank" rel="noopener noreferrer">{c.post.title}</a> : c.post.title}
        {c.noteId && <> · <button type="button" className="link-btn" onClick={() => onOpenNote(c.noteId)}>open note</button></>}
        {c.parent ? ' · a reply' : ''}
      </p>
      <div className="wp-comment-text">{c.text}</div>
      <div className="wp-comment-actions">
        {view !== 'approve' && view !== 'trash' && <button className="btn btn-small btn-primary" disabled={busy} onClick={() => act(() => api.setWordpressComment(c.id, 'approve'))}><Icon name="check" size={14} /> Approve</button>}
        {view === 'approve' && <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.setWordpressComment(c.id, 'hold'))}>Unapprove</button>}
        {view === 'trash' && <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.setWordpressComment(c.id, 'hold'))}>Restore</button>}
        {view !== 'trash' && view !== 'spam' && <button className="btn btn-small" disabled={busy} onClick={() => setReplying(!replying)}>Reply</button>}
        {view !== 'spam' && view !== 'trash' && <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.setWordpressComment(c.id, 'spam'))}>Spam</button>}
        {view === 'spam' && <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.setWordpressComment(c.id, 'hold'))}>Not spam</button>}
        {view !== 'trash' && <button className="btn btn-small btn-danger-text" disabled={busy} onClick={() => act(() => api.deleteWordpressComment(c.id, false))}>Trash</button>}
        {(view === 'trash' || view === 'spam') && <button className="btn btn-small btn-danger-text" disabled={busy} onClick={() => act(() => api.deleteWordpressComment(c.id, true), null, true)}>Delete permanently</button>}
        {c.link && view === 'approve' && <a className="btn btn-small" href={c.link} target="_blank" rel="noopener noreferrer">View <Icon name="external" size={12} /></a>}
      </div>
      {replying && (
        <div className="wp-reply">
          <textarea className="input" rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${c.author}…`} />
          <div className="wp-reply-actions">
            <span className="muted">{view === 'hold' ? 'Replying approves the comment too.' : ''}</span>
            <button className="btn btn-small" onClick={() => setReplying(false)}>Cancel</button>
            <button className="btn btn-small btn-primary" disabled={busy || !text.trim()} onClick={reply}>Post reply</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Comment moderation: waiting, approved, spam and trash, with approve, reply, spam and delete. */
export default function Comments({ onOpenNote, onChanged, version }) {
  const dialog = useDialog();
  const [view, setView] = useState('hold');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  const load = useCallback((p = 1) => api.wordpressComments({ status: view, page: p })
    .then((r) => { setList((l) => (p === 1 ? r : { ...r, comments: [...(l?.comments ?? []), ...r.comments] })); setPage(p); setError(null); })
    .catch((e) => setError(e.message)), [view]);
  useEffect(() => { setList(null); load(1); }, [load, version]);

  const onAction = async (c, fn, msg, confirmFirst) => {
    if (confirmFirst && !(await dialog.confirm({ title: 'Delete this comment permanently?', message: 'It can’t be restored.', okLabel: 'Delete', danger: true }))) return false;
    try {
      await fn();
    } catch (e) {
      dialog.toast(e.message, 'error');
      return false;
    }
    if (msg) dialog.toast(msg);
    // Replies stay put; anything that changes the comment's status takes it out of this list.
    if (!msg) setList((l) => ({ ...l, comments: l.comments.filter((x) => x.id !== c.id), total: Math.max(0, l.total - 1) }));
    onChanged();
    return true;
  };

  return (
    <section className="wp-comments">
      <div className="home-tabs is-sub wp-subtabs" role="tablist">
        {VIEWS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-active' : ''} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <div className="wp-skeleton" />}
      {list && (
        <>
          <p className="muted">{plural(list.total, 'comment')}</p>
          {list.comments.length === 0 && (
            <div className="pr-blank"><Icon name="inbox" size={30} /><p>{view === 'hold' ? 'No comments waiting. You’re all caught up.' : 'Nothing here.'}</p></div>
          )}
          <ul className="wp-comment-list">
            {list.comments.map((c) => <Comment key={c.id} c={c} view={view} onAction={onAction} onOpenNote={onOpenNote} />)}
          </ul>
          {page < list.pages && <button className="btn wp-more" onClick={() => load(page + 1)}>Show more</button>}
        </>
      )}
    </section>
  );
}
