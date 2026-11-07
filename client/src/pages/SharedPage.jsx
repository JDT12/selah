import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { api, formatDate, formatSize } from '../api.js';
import { buildExtensions } from '../editor/extensions.js';
import { workKey, workSections } from '../editor/WorkSections.js';
import { methodById } from '../../../shared/methods.js';
import { isLessonNote } from '../lesson.js';
import { quoteOfSelection, loadSharing, KIND_LABEL, KIND_ICON } from '../sharing.js';
import { WORK_DEFAULT, WORK_LABEL, WorkMeta, workPrompt } from '../components/NoteEditor.jsx';
import CommentThreads, { useCommentMarks } from '../components/CommentThreads.jsx';
import PdfReader from '../components/PdfReader.jsx';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';

/**
 * Something shared with me (8.0): a note, a notebook or a project from a contact, read-only and kept up to date as
 * they write. Notes show as they would in the owner's Selah (a lesson, sermon or Bible study as its page), with the
 * comment margin beside them. A notebook or project lists its notes on the left.
 */
export default function SharedPage({ shareId, noteKey, onPick, onOpenNote, onMenu }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.shared(shareId).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), [shareId]);
  useEffect(() => {
    setData(null);
    if (!shareId) { setError('Open something shared with you from the Shelf.'); return; }
    load();
    api.sharedSeen(shareId).then(() => loadSharing()).catch(() => {});
  }, [shareId, load]);
  // The owner saved (a new snapshot), or stopped sharing.
  useEffect(() => {
    const on = (e) => {
      const d = e.detail ?? {};
      if (d.sharing === 'revoked' && d.share === shareId) { setData(null); setError('This isn’t shared with you any more.'); }
      else if (d.sharing && (!d.share || d.share === shareId)) load();
    };
    window.addEventListener('noteapp:live', on);
    return () => window.removeEventListener('noteapp:live', on);
  }, [shareId, load]);

  const share = data?.share;
  const notes = data?.notes ?? [];
  const key = noteKey && notes.some((n) => n.key === noteKey) ? noteKey : notes[0]?.key ?? null;
  const groups = useMemo(() => {
    const out = [];
    for (const n of notes) {
      if (!out.length || out.at(-1).grp !== n.grp) out.push({ grp: n.grp, notes: [] });
      out.at(-1).notes.push(n);
    }
    return out;
  }, [notes]);

  const copy = async (what) => {
    try {
      const r = await api.copyShared(shareId, what);
      dialog.toast(what != null ? 'Copied into your notes' : `Copied ${r.notes} note${r.notes === 1 ? '' : 's'} into a notebook of your own`, 'info', 6000,
        r.noteId ? { label: 'Open', onClick: () => onOpenNote(r.noteId) } : null);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };

  if (error && !data) {
    return (
      <div className="shared-page is-empty">
        <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="Menu"><Icon name="menu" /></button>
        <Icon name="share" size={40} strokeWidth={1.3} />
        <p>{error}</p>
      </div>
    );
  }
  if (!data) return <div className="shared-page" />;
  const many = share.kind !== 'note';

  return (
    <div className={`shared-page ${many ? 'has-list' : ''}`}>
      <header className="shared-head">
        <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="Menu"><Icon name="menu" /></button>
        <span className="share-avatar" aria-hidden="true">{share.ownerName.slice(0, 1).toUpperCase()}</span>
        <div className="shared-head-text">
          <span className="shared-eyebrow"><Icon name={KIND_ICON[share.kind]} size={12} /> {KIND_LABEL[share.kind]} shared by {share.ownerName}</span>
          <h1>{share.title || 'Untitled'}</h1>
        </div>
        <span className="spacer" />
        <span className="shared-badge" title="You can read it; only they can change it"><Icon name="lock" size={12} /> Read-only</span>
        {share.allowCopy && many && <button type="button" className="btn btn-small" onClick={() => copy(null)}><Icon name="copy" size={14} /> Copy all</button>}
      </header>
      {share.project?.description && <p className="shared-desc">{share.project.description}</p>}
      <div className="shared-body">
        {many && (
          <nav className="shared-list" aria-label="Notes in it">
            {!notes.length && <p className="muted">Nothing in it yet.</p>}
            {groups.map((g, i) => (
              <section key={`${g.grp}-${i}`}>
                {g.grp && <h3>{g.grp}</h3>}
                {g.notes.map((n) => (
                  <button key={n.key} type="button" className={`shared-item ${n.key === key ? 'is-active' : ''}`} onClick={() => onPick(n.key)}>
                    <span className="shared-item-title">{n.title || 'Untitled'}</span>
                    <span className="shared-item-meta">
                      {n.work && <span>{WORK_LABEL[n.work.type]}</span>}
                      <span>{formatDate(n.updatedAt)}</span>
                      {n.comments > 0 && <span className="shared-item-comments"><Icon name="comment" size={11} /> {n.comments}</span>}
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </nav>
        )}
        {key != null
          ? <SharedNote key={`${shareId}-${key}`} share={share} noteKey={key} onCopy={share.allowCopy ? () => copy(key) : null} />
          : <div className="shared-note is-empty"><p className="muted">Nothing shared in it yet.</p></div>}
      </div>
    </div>
  );
}

function SharedNote({ share, noteKey, onCopy }) {
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(null);
  const [selection, setSelection] = useState(null);
  const [reading, setReading] = useState(null);
  const [showComments, setShowComments] = useState(true);
  const load = useCallback(() => api.sharedNote(share.id, noteKey).then(setNote).catch((e) => setError(e.message)), [share.id, noteKey]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = (e) => { const d = e.detail ?? {}; if (d.sharing && (!d.share || d.share === share.id)) load(); };
    window.addEventListener('noteapp:live', on);
    return () => window.removeEventListener('noteapp:live', on);
  }, [share.id, load]);

  const extensions = useMemo(() => buildExtensions({ onFiles: () => {} }), []);
  const fileUrl = useCallback((id) => `/api/shared/${share.id}/files/${id}`, [share.id]);
  const editor = useEditor({
    extensions,
    content: '<p></p>',
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'note-body' } },
  }, [extensions]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    Object.assign(editor.storage.noteApp, { fileUrl });
  }, [editor, fileUrl]);
  // New text from the owner replaces the old where you are.
  const html = note?.html;
  useEffect(() => {
    if (!editor || editor.isDestroyed || html == null) return;
    const scroller = editor.view.dom.closest('.shared-scroll');
    const top = scroller?.scrollTop;
    editor.commands.setContent(html || '<p></p>', { emitUpdate: false });
    if (scroller && top != null) scroller.scrollTop = top;
  }, [editor, html]);

  // A lesson, sermon or Bible study reads as its page, as it does for the owner.
  const workType = note?.work?.type ?? (note && isLessonNote(note.html) ? 'lesson' : null);
  const workMethod = workType ? methodById(note.work?.method) ?? methodById(WORK_DEFAULT[workType]) : null;
  const workCfg = useMemo(() => (workType && workMethod ? {
    on: true, level: workMethod.level, parts: workMethod.rest ? workMethod.sections.map((x) => x.match) : null,
    prompt: (heading, part) => workPrompt(workMethod, heading, part),
  } : { on: false }), [workType, workMethod]);
  const [parts, setParts] = useState([]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(workKey, workCfg));
    setParts(workCfg.on ? workSections(editor.state.doc, workCfg) : []);
  }, [editor, workCfg, html]);
  const words = useMemo(() => (editor && html != null ? editor.getText().split(/\s+/).filter(Boolean).length : 0), [editor, html]);

  // Words selected with the mouse or keyboard, for a new comment. The note isn't editable, so the selection is the
  // page's, read when it settles.
  const bodyRef = useRef(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    const dom = editor.view.dom;
    const on = () => setTimeout(() => {
      if (editor.isDestroyed) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !dom.contains(sel.anchorNode) || !dom.contains(sel.focusNode)) return;
      try {
        const q = quoteOfSelection(editor, { from: editor.view.posAtDOM(sel.anchorNode, sel.anchorOffset), to: editor.view.posAtDOM(sel.focusNode, sel.focusOffset) });
        if (q) setSelection(q);
      } catch { /* outside the text */ }
    }, 0);
    dom.addEventListener('mouseup', on);
    dom.addEventListener('keyup', on);
    dom.addEventListener('touchend', on);
    return () => { dom.removeEventListener('mouseup', on); dom.removeEventListener('keyup', on); dom.removeEventListener('touchend', on); };
  }, [editor]);
  useCommentMarks(editor, note?.threads, current, setCurrent);

  if (error && !note) return <div className="shared-note is-empty"><p className="muted">{error}</p></div>;
  const threads = note?.threads ?? [];

  return (
    <div className={`shared-note ${showComments ? 'has-comments' : ''}`}>
      <div className="shared-scroll" ref={bodyRef}>
        <div className={`editor-doc ${workType ? `is-work is-${workType}` : ''}`}>
          <div className="shared-note-top">
            {workType && <span className="work-eyebrow">{WORK_LABEL[workType]}{workMethod ? ` · ${workMethod.name}` : ''}</span>}
            <span className="spacer" />
            {note && <span className="muted shared-updated">Updated {formatDate(note.updatedAt)}</span>}
            {onCopy && <button type="button" className="btn btn-small" onClick={onCopy}><Icon name="copy" size={13} /> Make a copy</button>}
            <button type="button" className={`icon-btn ${showComments ? 'is-on' : ''}`} onClick={() => setShowComments((s) => !s)} aria-pressed={showComments}
              title="Comments" aria-label="Comments"><Icon name="comment" size={16} />{threads.filter((t) => !t.resolvedAt).length > 0 && <span className="shared-count">{threads.filter((t) => !t.resolvedAt).length}</span>}</button>
          </div>
          <h1 className="note-title is-static">{note?.title || 'Untitled'}</h1>
          {workType && <WorkMeta parts={parts} type={workType} passage={note?.work?.passage ?? ''} words={words} onPassage={null} />}
          <EditorContent editor={editor} />
          {note?.attachments?.length > 0 && (
            <ul className="files-list shared-files">
              {note.attachments.map((a) => (
                <li key={a.id}>
                  {a.mime === 'application/pdf'
                    ? <button type="button" className="link-btn" onClick={() => setReading(a)}>{a.filename}</button>
                    : <a href={fileUrl(a.id)} target="_blank" rel="noopener noreferrer">{a.filename}</a>}
                  <span className="muted">{formatSize(a.size)}</span>
                  <a className="icon-btn" href={`${fileUrl(a.id)}?download=1`} title="Download"><Icon name="download" size={14} /></a>
                </li>
              ))}
            </ul>
          )}
          {reading && <PdfReader id={reading.id} src={fileUrl(reading.id)} filename={reading.filename} onClose={() => setReading(null)} />}
        </div>
      </div>
      {showComments && (
        <aside className="shared-comments" aria-label="Comments">
          <div className="shared-comments-head">
            <h2>Comments</h2>
            <button type="button" className="icon-btn" onClick={() => setShowComments(false)} aria-label="Close comments"><Icon name="x" size={15} /></button>
          </div>
          <CommentThreads threads={threads} side="in" editor={editor} current={current} setCurrent={setCurrent}
            onChanged={(r) => { if (r?.threads) { setNote((n) => ({ ...n, threads: r.threads })); setSelection(null); window.getSelection()?.removeAllRanges(); } else load(); }}
            share={share.id} noteKey={noteKey} selection={selection} canComment={share.allowComments} ownerName={share.ownerName} />
        </aside>
      )}
    </div>
  );
}
