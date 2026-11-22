import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { device } from '../device.js';
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
import WhoIsHere from '../components/WhoIsHere.jsx';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { joinCoedit, setYText } from '../coedit.js';
import { BuilderEnv, sharedBuilderEnv } from '../builderApi.js';
import SermonBuilder from '../components/SermonBuilder.jsx';
import LessonBuilder from '../components/LessonBuilder.jsx';
import StudyBuilder from '../components/StudyBuilder.jsx';

// 14.3: the builder a shared note opens in, by its method (background and word studies have none here yet).
const BUILDER_OF = { mcdill: SermonBuilder, hblt: LessonBuilder, points: LessonBuilder, ggw: StudyBuilder };
const BUILDER_DEFAULT = { sermon: SermonBuilder, lesson: LessonBuilder };

// 14.3: what each person may do with a share.
const ROLE_BADGE = {
  read: { icon: 'lock', label: 'Read-only', title: 'You can read it; only they can change it' },
  edit: { icon: 'pen', label: 'Can edit', title: 'You can edit its notes with them, live' },
  full: { icon: 'pen', label: 'Full control', title: 'You can edit its notes live, and add or take out notes' },
};

/**
 * Something shared with me (8.0): a note, a notebook or a project from a contact, kept up to date as they write.
 * 14.3: shared with me to edit, its notes open live (the owner's Selah keeps the live room; coedit.js), and with
 * Full control notes can be added and taken out. Notes show as they would in the owner's Selah (a lesson, sermon or Bible study as its page), with the
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

  // Full control (14.3): a new note in their notebook or project, or one taken out (into their Trash).
  const addNote = async () => {
    const title = await dialog.prompt({ title: 'New note', label: 'Title', okLabel: 'Add' });
    if (title == null) return;
    try {
      const r = await api.sharedAdd(shareId, title.trim() || 'Untitled');
      await load();
      if (r?.key) onPick(r.key);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const deleteNote = async (n) => {
    if (!(await dialog.confirm({ title: `Take out “${n.title || 'Untitled'}”?`, message: `It goes to ${share.ownerName}’s Trash, where they can put it back.`, okLabel: 'Take out', danger: true }))) return;
    try { await api.sharedDelete(shareId, n.key); await load(); } catch (e) { dialog.toast(e.message, 'error'); }
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
        {(() => { const b = ROLE_BADGE[share.role] ?? ROLE_BADGE.read; return <span className="shared-badge" title={b.title}><Icon name={b.icon} size={12} /> {b.label}</span>; })()}
        {share.role === 'full' && many && <button type="button" className="btn btn-small" onClick={addNote}><Icon name="plus" size={14} /> New note</button>}
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
                  <div key={n.key} className="shared-item-row">
                  <button type="button" className={`shared-item ${n.key === key ? 'is-active' : ''}`} onClick={() => onPick(n.key)}>
                    <span className="shared-item-title">{n.title || 'Untitled'}</span>
                    <span className="shared-item-meta">
                      {n.work && <span>{WORK_LABEL[n.work.type]}</span>}
                      <span>{formatDate(n.updatedAt)}</span>
                      {n.comments > 0 && <span className="shared-item-comments"><Icon name="comment" size={11} /> {n.comments}</span>}
                    </span>
                  </button>
                  {share.role === 'full' && <button type="button" className="icon-btn shared-item-del" onClick={() => deleteNote(n)} aria-label={`Take out ${n.title || 'Untitled'}`} title="Take out (to their Trash)"><Icon name="trash" size={13} /></button>}
                  </div>
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

function SharedNote(props) {
  const { share, noteKey } = props;
  // 14.3: open in its builder (Can edit or Full control): the builder's room on the owner's Selah instead.
  const [building, setBuilding] = useState(null); // the builder component
  const env = useMemo(() => sharedBuilderEnv({ shareId: share.id, key: noteKey, ownerName: share.ownerName }), [share.id, noteKey, share.ownerName]);
  // 14.3: the note's live room on the owner's Selah, through mine and the share hub; false when it isn't live (read
  // the shared copy, as before). round: the room started again, so it opens again.
  const [live, setLive] = useState(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    let session = null;
    let off = null;
    setLive(null);
    if (building) return () => {};
    joinCoedit(noteKey, 'note', { base: `/api/shared/${share.id}/notes/${noteKey}/coedit`, id: `${share.id}:${noteKey}` }).then((s) => {
      session = s;
      if (!alive) { s?.destroy(); return; }
      if (s) off = s.on('reset', () => setRound((r) => r + 1));
      setLive(s || false);
    });
    return () => { alive = false; off?.(); session?.destroy(); };
  }, [share.id, noteKey, round, share.role, building]); // a new role (Read, Edit): open it again with it
  if (building) {
    const Builder = building;
    return (
      <div className="shared-note shared-building">
        <BuilderEnv.Provider value={env}>
          <Builder noteId={noteKey} close={() => { setBuilding(null); setRound((r) => r + 1); }} />
        </BuilderEnv.Provider>
      </div>
    );
  }
  if (live === null) return <div className="shared-note" />;
  return <SharedNoteView onBuild={share.role !== 'read' && !device.phone ? setBuilding : null} key={`${round}-${share.role}`} {...props} live={live || null} onRestart={() => setRound((r) => r + 1)} />;
}

function SharedNoteView({ share, noteKey, onCopy, live, onRestart, onBuild }) {
  const dialog = useDialog();
  const canEdit = !!live?.canWrite;
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

  const extensions = useMemo(() => buildExtensions({
    onFiles: () => dialog.toast(`Pictures and files can only be added by ${share.ownerName}.`, 'info'), live,
  }), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const fileUrl = useCallback((id) => `/api/shared/${share.id}/files/${id}`, [share.id]);
  const imageSrc = useCallback((src) => String(src ?? '').replace(/^\/api\/files\/(\d+)/, `/api/shared/${share.id}/files/$1`), [share.id]);
  // Live, saves go to the owner's Selah a moment after this window's own typing (theirs is saved by them).
  const saveTimer = useRef(null);
  const editorRef = useRef(null);
  const [saveState, setSaveState] = useState('saved');
  const saveNow = useCallback(async () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const ed = editorRef.current;
    if (!live || !ed || ed.isDestroyed) return;
    setSaveState('saving');
    try {
      await api.sharedSave(share.id, noteKey, { html: ed.getHTML(), title: live.title.toString(), live: live.epoch });
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      if (e.status === 409) onRestart();
      else dialog.toast(`Not saved: ${e.message}`, 'error');
    }
  }, [live, share.id, noteKey, onRestart, dialog]);
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;
  const queueSave = useCallback(() => {
    setSaveState('unsaved');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveRef.current(), 800);
  }, []);
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); saveRef.current(); } }, []);
  const editor = useEditor({
    extensions,
    ...(live ? {} : { content: '<p></p>' }),
    editable: canEdit,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'note-body', ...(canEdit ? { spellcheck: 'true' } : {}) } },
    onCreate: ({ editor: e }) => { Object.assign(e.storage.noteApp, { fileUrl, imageSrc }); },
    onUpdate: ({ transaction }) => { if (canEdit && !transaction?.getMeta(ySyncPluginKey)?.isChangeOrigin) queueSave(); },
  }, [extensions]);
  editorRef.current = editor;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    Object.assign(editor.storage.noteApp, { fileUrl, imageSrc });
  }, [editor, fileUrl, imageSrc]);
  // The first one in builds the live document from the owner's note (their own HTML, from the join).
  const [title, setTitle] = useState(null);
  useEffect(() => {
    if (!live || !editor || editor.isDestroyed) return undefined;
    if (live.seed) {
      const { html: h, title: t } = live.seed;
      editor.commands.setContent(h || '<p></p>', { emitUpdate: false });
      live.doc.transact(() => { if (live.title.length) live.title.delete(0, live.title.length); live.title.insert(0, t ?? ''); });
      live.seedDone();
    }
    setTitle(live.title.toString());
    const onTitle = () => setTitle(live.title.toString());
    live.title.observe(onTitle);
    return () => live.title.unobserve(onTitle);
  }, [live, editor]);
  const [peers, setPeers] = useState(() => live?.peers() ?? []);
  useEffect(() => (live ? live.on('peers', setPeers) : undefined), [live]);
  // New text from the owner replaces the old where you are (not live: the shared copy).
  const html = note?.html;
  useEffect(() => {
    if (live || !editor || editor.isDestroyed || html == null) return;
    const scroller = editor.view.dom.closest('.shared-scroll');
    const top = scroller?.scrollTop;
    editor.commands.setContent(html || '<p></p>', { emitUpdate: false });
    if (scroller && top != null) scroller.scrollTop = top;
  }, [editor, html]);

  // A lesson, sermon or Bible study reads as its page, as it does for the owner.
  const workType = note?.work?.type ?? (note && isLessonNote(note.html) ? 'lesson' : null);
  // A phone reads a sermon, lesson or study it could edit elsewhere (as with its own: device.js).
  const editable = canEdit && !(device.phone && workType);
  useEffect(() => { if (editor && !editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable); }, [editor, editable]);
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
            {peers.length > 0 && <WhoIsHere peers={peers} />}
            {editable ? <span className={`save-status is-${saveState}`}>{{ saved: 'Saved', saving: 'Saving…', unsaved: 'Editing…', error: 'Not saved' }[saveState]}</span>
              : note && <span className="muted shared-updated">Updated {formatDate(note.updatedAt)}</span>}
            {onBuild && editable && workType && (BUILDER_OF[note?.work?.method] ?? (!note?.work?.method ? BUILDER_DEFAULT[workType] : null)) && (
              <button type="button" className="btn btn-small" onClick={() => onBuild(() => BUILDER_OF[note?.work?.method] ?? BUILDER_DEFAULT[workType])}>
                <Icon name="steps" size={13} /> Open in the builder
              </button>
            )}
            {onCopy && <button type="button" className="btn btn-small" onClick={onCopy}><Icon name="copy" size={13} /> Make a copy</button>}
            <button type="button" className={`icon-btn ${showComments ? 'is-on' : ''}`} onClick={() => setShowComments((s) => !s)} aria-pressed={showComments}
              title="Comments" aria-label="Comments"><Icon name="comment" size={16} />{threads.filter((t) => !t.resolvedAt).length > 0 && <span className="shared-count">{threads.filter((t) => !t.resolvedAt).length}</span>}</button>
          </div>
          {editable
            ? <textarea className="note-title" rows={1} value={title ?? ''} placeholder="Untitled" aria-label="Title"
              onChange={(e) => { setTitle(e.target.value); setYText(live.title, e.target.value); queueSave(); }} />
            : <h1 className="note-title is-static">{(live ? title : note?.title) || 'Untitled'}</h1>}
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
            share={share.id} noteKey={noteKey} selection={selection} canComment={share.allowComments && !device.phone} ownerName={share.ownerName} />
        </aside>
      )}
    </div>
  );
}
