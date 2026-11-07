import { useEffect, useState } from 'react';
import { api, formatDate } from '../api.js';
import { commentKey } from '../editor/CommentMarks.js';
import { findQuote } from '../sharing.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

/**
 * Margin comments (8.0), beside a shared note: on the owner's own note (side 'out': reply, resolve) and on a note
 * shared with me (side 'in': comment on selected words, reply in my threads). The threads' words are highlighted in
 * the note (CommentMarks); clicking a thread goes to its words, clicking highlighted words opens its thread.
 */

/** Keeps the note's highlights in step with the threads, and opens a thread when its words are clicked. */
export function useCommentMarks(editor, threads, current, setCurrent) {
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentKey, { threads: threads ?? [], current }));
  }, [editor, threads, current]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    editor.storage.commentMarks.onPick = (id) => setCurrent(id);
    return () => { if (!editor.isDestroyed) editor.storage.commentMarks.onPick = null; };
  }, [editor, setCurrent]);
}

export function goToThread(editor, t) {
  if (!editor || editor.isDestroyed) return;
  const r = findQuote(editor.state.doc, t);
  if (!r) return;
  if (editor.isEditable) editor.chain().setTextSelection(r).run();
  requestAnimationFrame(() => {
    const dom = editor.view.domAtPos(r.from)?.node;
    (dom?.nodeType === 3 ? dom.parentElement : dom)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  });
}

function Comment({ c, onDelete }) {
  return (
    <div className={`ct-comment ${c.mine ? 'is-mine' : ''}`}>
      <div className="ct-who">
        <span className="share-avatar is-small" aria-hidden="true">{(c.authorName || c.author).slice(0, 1).toUpperCase()}</span>
        <strong>{c.mine ? 'You' : c.authorName || c.author}</strong>
        <span className="muted">{formatDate(c.createdAt)}</span>
        {!c.seen && <span className="ct-new">New</span>}
        {c.mine && onDelete && (
          <button type="button" className="icon-btn ct-del" title="Delete comment" aria-label="Delete comment" onClick={() => onDelete(c)}><Icon name="trash" size={13} /></button>
        )}
      </div>
      <p className="ct-body">{c.body}</p>
    </div>
  );
}

function Thread({ t, side, open, onOpen, editor, onChanged, canReply, ownerName }) {
  const dialog = useDialog();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const found = editor && !editor.isDestroyed ? !!findQuote(editor.state.doc, t) : true;
  const send = async (e) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await api.replyThread(t.id, reply.trim());
      setReply('');
      onChanged();
    } catch (err) { dialog.toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const resolve = async () => {
    try { await api.resolveThread(t.id, !t.resolvedAt); onChanged(); } catch (err) { dialog.toast(err.message, 'error'); }
  };
  const del = async (c) => {
    if (!(await dialog.confirm({ title: c.id === t.id ? 'Delete this thread?' : 'Delete this reply?', okLabel: 'Delete', danger: true }))) return;
    try { await api.deleteShareComment(c.id); onChanged(); } catch (err) { dialog.toast(err.message, 'error'); }
  };
  return (
    <article className={`ct-thread ${open ? 'is-open' : ''} ${t.resolvedAt ? 'is-resolved' : ''}`}>
      <button type="button" className="ct-quote" onClick={() => { onOpen(t.id); goToThread(editor, t); }} title={found ? 'Show it in the note' : 'These words aren’t in the note any more'}>
        <span className={found ? '' : 'is-gone'}>“{t.quote}”</span>
      </button>
      {t.resolvedAt && !open ? (
        <button type="button" className="link-btn ct-folded" onClick={() => onOpen(t.id)}>Resolved · {t.comments.length} comment{t.comments.length === 1 ? '' : 's'}</button>
      ) : (
        <>
          {t.comments.map((c) => <Comment key={c.id} c={c} onDelete={del} />)}
          {canReply && !t.resolvedAt && (
            <form className="ct-reply" onSubmit={send}>
              <textarea className="input" rows={open ? 2 : 1} value={reply} onChange={(e) => setReply(e.target.value)} onFocus={() => onOpen(t.id)}
                placeholder={side === 'out' ? 'Reply…' : `Reply to ${ownerName}…`} aria-label="Reply"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} />
              {reply.trim() && <button type="submit" className="btn btn-small btn-primary" disabled={busy}>Reply</button>}
            </form>
          )}
          {side === 'out' && (
            <div className="ct-actions">
              <button type="button" className="link-btn" onClick={resolve}>{t.resolvedAt ? 'Open again' : 'Resolve'}</button>
            </div>
          )}
          {side === 'in' && t.resolvedAt && <p className="muted ct-resolved-note">{ownerName} resolved this.</p>}
        </>
      )}
    </article>
  );
}

/**
 * The list of threads. `side` 'out' (my note) or 'in' (shared with me). For 'in', `share` and `noteKey` say where a
 * new comment goes, and `selection` is the words selected in the note ({ quote, prefix, suffix }) or null.
 */
export default function CommentThreads({ threads, side, editor, current, setCurrent, onChanged, share = null, noteKey = null, selection = null, canComment = true, ownerName = '' }) {
  const dialog = useDialog();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);
  const add = async (e) => {
    e.preventDefault();
    if (!draft.trim() || !selection) return;
    setBusy(true);
    try {
      const r = await api.commentShared(share, { noteKey, body: draft.trim(), ...selection });
      setDraft('');
      onChanged(r);
    } catch (err) { dialog.toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="comment-threads">
      {side === 'in' && canComment && (
        <form className={`ct-new-form ${selection ? 'has-selection' : ''}`} onSubmit={add}>
          {selection ? (
            <>
              <p className="ct-quote is-static">“{selection.quote.length > 160 ? `${selection.quote.slice(0, 160)}…` : selection.quote}”</p>
              <textarea className="input" rows={3} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your comment…" aria-label="Your comment"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(e); }} />
              <div className="ct-actions"><button type="submit" className="btn btn-small btn-primary" disabled={busy || !draft.trim()}>Comment</button></div>
            </>
          ) : <p className="muted ct-hint"><Icon name="comment" size={14} /> Select words in the note to comment on them.</p>}
        </form>
      )}
      {side === 'in' && !canComment && <p className="muted ct-hint">{ownerName} turned comments off for this.</p>}
      {!threads.length && side === 'out' && <p className="muted ct-hint">No comments on this note yet.</p>}
      {open.map((t) => (
        <Thread key={t.id} t={t} side={side} open={current === t.id} onOpen={setCurrent} editor={editor} onChanged={onChanged} canReply={side === 'out' || canComment} ownerName={ownerName} />
      ))}
      {resolved.length > 0 && (
        <button type="button" className="link-btn ct-show-resolved" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
        </button>
      )}
      {showResolved && resolved.map((t) => (
        <Thread key={t.id} t={t} side={side} open={current === t.id} onOpen={setCurrent} editor={editor} onChanged={onChanged} canReply={false} ownerName={ownerName} />
      ))}
    </div>
  );
}
