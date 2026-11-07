import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { fromWallClock, wallClock, todayStr, addDays, zoneName } from '../../time.js';
import { useDialog } from '../Dialogs.jsx';
import { notebookOptions } from '../NoteEditor.jsx';
import { WordPressPostDialog, askDeletePosts } from '../WordPressDialogs.jsx';

export const STATUS_LABEL = { publish: 'Published', draft: 'Draft', future: 'Scheduled', pending: 'Pending review', private: 'Private' };
export const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

// Lampstand's original scheme, for sites that don't report their own (another theme, or offline).
const DEFAULT_TOKENS = {
  ink: '#1C2B3A', lapis: '#2F5D86', walnut: '#5A3E2B', oak: '#93613A', sand: '#EFE7DB', page: '#FBFAF7',
  line: '#E3D9CA', muted: '#5B6875', paper: '#FFFFFF', 'on-primary': '#FFFFFF',
  'font-display': '"Literata", Charter, Georgia, serif',
  'font-text': '"Literata", Charter, Georgia, serif',
  'font-ui': '"Figtree", system-ui, sans-serif',
};

/** The site's color and font tokens as CSS variables (--s-ink, --s-font-ui, …). */
export function siteVars(style) {
  const tokens = { ...DEFAULT_TOKENS, ...style?.tokens };
  const vars = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--s-${k}`, v]));
  vars['--s-display-weight'] = style?.displayWeight ?? 500;
  return vars;
}

/** The site's web fonts, served through this app (see server/wpstyle.js). */
export function useSiteFonts(style) {
  useEffect(() => {
    if (!style?.fonts) return;
    const href = `/api/wordpress/fonts.css?v=${style.fontsVersion}`;
    let link = document.getElementById('wp-site-fonts');
    if (!link) {
      link = Object.assign(document.createElement('link'), { id: 'wp-site-fonts', rel: 'stylesheet' });
      document.head.append(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }, [style?.fonts, style?.fontsVersion]);
}

/** Picks a notebook; resolves to its id or null. */
export function NotebookDialog({ title, message, okLabel = 'OK', close }) {
  const dialog = useDialog();
  const [options, setOptions] = useState(null);
  const [notebook, setNotebook] = useState(null);
  useEffect(() => {
    api.tree().then((tree) => {
      const opts = notebookOptions(tree);
      setOptions(opts);
      setNotebook(opts[0]?.id ?? null);
    }).catch((e) => dialog.toast(e.message, 'error'));
  }, [dialog]);
  return (
    <form className="dw-journal-dialog" onSubmit={(e) => { e.preventDefault(); if (notebook) close(notebook); }}>
      <h2>{title}</h2>
      {message && <p className="muted">{message}</p>}
      {options?.length > 1 && <>
        <label className="field-label" htmlFor="wp-nb">Notebook</label>
        <select id="wp-nb" className="input" autoFocus value={notebook ?? ''} disabled={!options} onChange={(e) => setNotebook(Number(e.target.value))}>
          {options?.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!notebook}>{okLabel}</button>
      </div>
    </form>
  );
}

/** Choose when a post goes live (wall-clock in the app time zone). Resolves to an ISO moment or null. */
export function ScheduleDialog({ post, close }) {
  const [when, setWhen] = useState(post.status === 'future' && post.date ? wallClock(post.date) : `${addDays(todayStr(), 1)}T09:00`);
  const [error, setError] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    const at = fromWallClock(when);
    if (!(at > Date.now() + 60_000)) { setError('Choose a time in the future.'); return; }
    close(new Date(at).toISOString());
  };
  return (
    <form className="dw-journal-dialog" onSubmit={submit}>
      <h2>{post.status === 'future' ? 'Reschedule post' : 'Schedule post'}</h2>
      <p className="muted">“{post.title}” goes live on the site at this time ({zoneName()}).</p>
      <label className="field-label" htmlFor="wp-when">Publish on</label>
      <input id="wp-when" className="input" type="datetime-local" value={when} min={`${todayStr()}T00:00`} autoFocus
        onChange={(e) => { setWhen(e.target.value); setError(null); }} required />
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary">Schedule</button>
      </div>
    </form>
  );
}

/**
 * Actions on posts shared by the tabs: update (or first post) from a note, schedule, publish, unschedule, delete,
 * and import into a note. Each resolves to true when something changed. onOpenNote opens a note.
 */
export function usePostActions({ onOpenNote, onChanged }) {
  const dialog = useDialog();
  const fail = (e) => { dialog.toast(e.message, 'error'); return false; };
  const done = (msg) => { if (msg) dialog.toast(msg); onChanged?.(); return true; };

  const postFromNote = async (noteId) => {
    let note;
    try { note = await api.getNote(noteId); } catch (e) { return fail(e); }
    const r = await dialog.open((close) => (
      <WordPressPostDialog noteId={noteId} title={note.title} tags={note.tags} attachments={note.attachments}
        getHtml={async () => note.html} close={close} />
    ), { dismissable: false });
    if (!r) return false;
    if (r.tag && !note.tags.some((t) => t.toLowerCase() === r.tag.toLowerCase())) {
      await api.updateNote(noteId, { tags: [...note.tags, r.tag] }).catch(() => {});
    }
    return done();
  };
  const schedule = async (post) => {
    const date = await dialog.open((close) => <ScheduleDialog post={post} close={close} />);
    if (!date) return false;
    try { await api.updateWordpressPost(post.id, { date }); } catch (e) { return fail(e); }
    return done('Scheduled');
  };
  const moveTo = async (post, date) => {
    try { await api.updateWordpressPost(post.id, { date }); } catch (e) { return fail(e); }
    return done(post.status === 'future' ? 'Rescheduled' : 'Scheduled');
  };
  const publish = async (post) => {
    const ok = await dialog.confirm({ title: 'Publish now?', message: `“${post.title}” goes live on the site straight away.`, okLabel: 'Publish' });
    if (!ok) return false;
    try { await api.updateWordpressPost(post.id, { status: 'publish' }); } catch (e) { return fail(e); }
    return done('Published');
  };
  const unschedule = async (post) => {
    try { await api.updateWordpressPost(post.id, { status: 'draft' }); } catch (e) { return fail(e); }
    return done('Moved back to drafts');
  };
  const remove = async (post) => {
    const how = await askDeletePosts(dialog, { title: post.title });
    if (!how) return false;
    try { await api.deleteWordpressPost(post.id, how.permanent); } catch (e) { return fail(e); }
    return done(how.permanent ? 'Post deleted permanently' : 'Post moved to the Trash in WordPress');
  };
  const importPost = async (post) => {
    const nb = await dialog.open((close) => (
      <NotebookDialog title="Import post into a note" okLabel="Import" close={close}
        message={`“${post.title}” becomes a note, with its images, linked to the post so you can update it from the note. Updating replaces the post’s content with the note’s.`} />
    ));
    if (!nb) return false;
    try {
      const r = await api.importWordpressPost(post.id, nb);
      onChanged?.();
      onOpenNote(r.id);
      return true;
    } catch (e) {
      return fail(e);
    }
  };

  /** Menu items for a post (for dialog.contextMenu or <Menu>). */
  const menu = (post, { canPublish = true } = {}) => [
    post.noteId && { label: 'Open note', onClick: () => onOpenNote(post.noteId) },
    post.noteId && { label: post.stale ? 'Update post from note…' : 'Post again from note…', onClick: () => postFromNote(post.noteId) },
    !post.noteId && { label: 'Import into a note…', onClick: () => importPost(post) },
    'sep',
    canPublish && ['draft', 'pending', 'future'].includes(post.status) && { label: post.status === 'future' ? 'Reschedule…' : 'Schedule…', onClick: () => schedule(post) },
    canPublish && ['draft', 'pending', 'future'].includes(post.status) && { label: 'Publish now', onClick: () => publish(post) },
    post.status === 'future' && { label: 'Unschedule (back to drafts)', onClick: () => unschedule(post) },
    'sep',
    { label: post.status === 'publish' ? 'View on site' : 'Preview on site', onClick: () => window.open(post.status === 'publish' ? post.link : `${post.link}${post.link.includes('?') ? '&' : '?'}preview=true`, '_blank', 'noopener,noreferrer') },
    { label: 'Edit in WordPress', onClick: () => window.open(post.editLink, '_blank', 'noopener,noreferrer') },
    'sep',
    { label: 'Delete…', danger: true, onClick: () => remove(post) },
  ];

  return { postFromNote, schedule, moveTo, publish, unschedule, remove, importPost, menu };
}

/** Badges for how a post stands against its note. */
export function SyncBadges({ post, onUpdate }) {
  if (!post.noteId) return null;
  return (
    <>
      {post.stale && (
        <button type="button" className="wp-badge is-stale" onClick={onUpdate} title="The note has changed since it was posted. Click to update the post.">
          Note changed · Update
        </button>
      )}
      {post.editedOnSite && <span className="wp-badge is-edited" title="Changed in WordPress after it was posted. Updating from the note would replace those changes.">Edited on site</span>}
    </>
  );
}
