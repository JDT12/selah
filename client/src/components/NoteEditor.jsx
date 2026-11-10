import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { device, workIsReadOnlyHere } from '../device.js';
import { EditorContent, useEditor } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { api, fileUrl, formatSize } from '../api.js';
import PdfReader from './PdfReader.jsx';
import { buildExtensions } from '../editor/extensions.js';
import Toolbar from '../editor/Toolbar.jsx';
import Icon from './Icon.jsx';
import { openExport } from './ExportDialog.jsx';
import { SplitDialog } from './NoteToolsDialogs.jsx';
import SidePanel from './SidePanel.jsx';
import { useStoredState } from '../useStoredState.js';
import FindBar from './FindBar.jsx';
import TagInput from './TagInput.jsx';
import { Menu, useDialog } from './Dialogs.jsx';
import { CameraDialog, RecorderDialog, canCapture } from './MediaCapture.jsx';
import { askDeletePosts, WordPressPostDialog } from './WordPressDialogs.jsx';
import { formatMoment, todayStr } from '../time.js';
import { PrayerDialog } from './PrayerDialogs.jsx';
import TemplatePicker, { PLACEHOLDER_HELP } from './TemplatePicker.jsx';
import CiteDialog from './CiteDialog.jsx';
import CitationNotes from './CitationNotes.jsx';
import { citationStyle } from '../citations/index.js';
import LogosLinkDialog from './LogosDialog.jsx';
import { openLink, openPassage } from '../logos.js';
import { logosUrl } from '../../../shared/scripture.js';
import { bibleConnected, biblePassage, passageInlineText, passageNoteHtml } from '../esv.js';
import { useBible } from './TranslationPicker.jsx';
import EsvInsertDialog from './EsvInsertDialog.jsx';
import NoteConnections from './NoteConnections.jsx';
import VersionHistory from './VersionHistory.jsx';
import { openNoteEvent } from '../editor/NoteLinks.jsx';
import { presentNote, printHandout } from './PresentMode.jsx';
import { preachNote, teachNote } from './PreachMode.jsx';
import { openSlides } from './SlidesEditor.jsx';
import { openSermonBuilder } from './SermonBuilder.jsx';
import { openStudyBuilder } from './StudyBuilder.jsx';
import { openLessonBuilder } from './LessonBuilder.jsx';
import { isLessonNote, parseLesson } from '../lesson.js';
import { workKey, workSections } from '../editor/WorkSections.js';
import { findReferences } from '../../../shared/scripture.js';
import { chooseSwitch } from './MethodPicker.jsx';
import { convertHtml } from '../methods.js';
import { hasChoice, methodById } from '../../../shared/methods.js';
import { BankItemDialog } from './SermonDialogs.jsx';
import { DOMSerializer } from '@tiptap/pm/model';
import HandwritingDialog from './HandwritingDialog.jsx';
import { drawingToPng } from '../editor/Drawing.jsx';
import { pagesFromFile, pagesFromUrl } from '../handwriting.js';
import { pickFilesNative } from '../desktop.js';
import { serverMode } from '../mode.js';
import { openShare } from './SharingDialogs.jsx';
import { useCommentMarks } from './CommentThreads.jsx';

/**
 * Grips for single list items (see DragHandle below). Inside a list every grip is for one item (with its sub-items);
 * Alt+drag on an item takes the whole list (extensions.js). Any other top-level block keeps its grip, and below the top
 * level only list items get one, so callouts, sections and tables still move as one block. These replace the drag
 * handle's default rules, and edge detection is off: it kept handing the grip to the whole list.
 */
const LIST_ITEMS = ['listItem', 'taskItem'];
const LIST_DRAG = {
  defaultRules: false,
  edgeDetection: 'none',
  rules: [{
    id: 'topLevelOrListItem',
    evaluate: ({ node, depth }) => (node.isInline || node.type.name.endsWith('List') || (depth > 1 && !LIST_ITEMS.includes(node.type.name)) ? 1000 : 0),
  }],
};

export default function NoteEditor(props) {
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getNote(props.id)
      .then((n) => alive && setNote(n))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [props.id]);

  if (error) return <div className="editor-empty">{error}</div>;
  if (!note) return <div className="editor-empty" />;
  return <LoadedNote note={note} {...props} />;
}

/** 10.1: the one notebook you file into is My notes (builders keep theirs out of sight; the Inbox is for captures). */
export function notebookOptions(tree) {
  const mine = tree.notebooks.find((nb) => nb.id === tree.myNotes);
  return mine ? [{ id: mine.id, label: 'My notes' }] : tree.notebooks.filter((nb) => !nb.managed).map((nb) => ({ id: nb.id, label: nb.name }));
}

function LoadedNote({
  note, tree, listNote, noteActions, onOpenScripture, onChanged, onSaved, onTrash, onRestore, onDeleteForever, onBack, fullScreen, onFullScreen,
  onReload, scrollTo, peek,
}) {
  const dialog = useDialog();
  const readOnly = !!note.deleted_at;
  // Read-only: a note can open locked (read_only), and the lock button switches it for this visit.
  const [locked, setLocked] = useState(!!note.read_only);
  const [lockDefault, setLockDefault] = useState(!!note.read_only);
  // 13.0: a sermon, lesson, study or piece of writing this device only reads (set once we know what the note is).
  const [deviceLocked, setDeviceLocked] = useState(false);
  const viewOnly = readOnly || locked || deviceLocked;
  const lockedRef = useRef(viewOnly);
  lockedRef.current = viewOnly;
  const [title, setTitle] = useState(note.title);
  const [tags, setTags] = useState(note.tags);
  const [notebookId, setNotebookId] = useState(note.notebook_id);
  const [pinned, setPinned] = useState(!!note.pinned);
  const [onDashboard, setOnDashboard] = useState(!!note.dash_pinned);
  const [isTemplate, setIsTemplate] = useState(!!note.is_template);
  // A right-click on the note in the list can pin it too; the list entry then has the current state.
  useEffect(() => {
    if (!listNote) return;
    setPinned(!!listNote.pinned);
    setOnDashboard(!!listNote.dash_pinned);
    setIsTemplate(!!listNote.is_template);
  }, [listNote?.pinned, listNote?.dash_pinned, listNote?.is_template]); // eslint-disable-line react-hooks/exhaustive-deps
  const [attachments, setAttachments] = useState(note.attachments);
  const [status, setStatus] = useState('saved');
  const [uploading, setUploading] = useState([]);
  const [showFiles, setShowFiles] = useState(false);
  const [readingPdf, setReadingPdf] = useState(null); // attachment open in the full-screen reader
  const [wpPost, setWpPost] = useState(note.wordpress);

  // A scheduled post may have gone live (or been changed in WordPress) since: ask the site.
  useEffect(() => {
    if (note.wordpress?.status !== 'future') return undefined;
    let alive = true;
    api.notePost(note.id).then(({ post }) => {
      if (alive) setWpPost(post ? { post_id: post.id, link: post.link, status: post.status, date: post.date } : null);
    }).catch(() => {});
    return () => { alive = false; };
  }, [note.id, note.wordpress?.status]);

  const pending = useRef({});
  const timer = useRef(null);
  const editorRef = useRef(null);
  const insertTemplateRef = useRef(null);
  const citeRef = useRef(null);
  const handwritingRef = useRef(null);
  const fileInput = useRef(null);
  const cameraInput = useRef(null);
  const titleRef = useRef(null);

  // ---- autosave ----
  // known: the version of the note this editor has (its updated_at). Text saves send it, and the server refuses a
  // save if the note changed somewhere else since; the conflict bar then asks which text to keep.
  const known = useRef(note.updated_at);
  const [conflict, setConflict] = useState(null);
  const conflictRef = useRef(null);
  conflictRef.current = conflict;
  const saving = useRef(false); // a save of this window's is on its way (its own change isn't someone else's)
  const flush = useCallback(async (keepalive = false) => {
    clearTimeout(timer.current);
    const patch = pending.current;
    if (!Object.keys(patch).length || (conflictRef.current && !keepalive)) return;
    pending.current = {};
    setStatus('saving');
    const content = 'html' in patch || 'title' in patch;
    try {
      if (keepalive) { await api.updateNote(note.id, patch, true); return; }
      saving.current = true;
      const r = await api.updateNote(note.id, content ? { ...patch, base_updated_at: known.current } : patch).finally(() => { saving.current = false; });
      if (r.updated_at) known.current = r.updated_at;
      if (!Object.keys(pending.current).length) setStatus('saved');
      onSaved(note.id, { ...patch, updated_at: r.updated_at });
    } catch (e) {
      pending.current = { ...patch, ...pending.current };
      if (e.status === 409 && e.data?.conflict) {
        setConflict(e.data.note);
        setStatus('conflict');
        return;
      }
      setStatus('error');
      dialog.toast(`Save failed: ${e.message}`, 'error');
    }
  }, [note.id, onSaved, dialog]);

  const queue = useCallback((patch, delay = 700) => {
    Object.assign(pending.current, patch);
    setStatus('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), delay);
  }, [flush]);

  useEffect(() => {
    const onUnload = () => flush(true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      flush();
    };
  }, [flush]);

  // ---- uploads ----
  const uploadFiles = useCallback(async (files, pos, { recording = false } = {}) => {
    const editor = editorRef.current;
    if (!editor || readOnly || lockedRef.current) return;
    for (const file of files) {
      const key = `${file.name}-${Math.random()}`;
      setUploading((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const a = await api.upload(note.id, file, (p) =>
          setUploading((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))), { recording });
        setAttachments((list) => [...list, a]);
        const isImage = a.mime.startsWith('image/') && a.mime !== 'image/svg+xml';
        const node = isImage
          ? { type: 'image', attrs: { src: fileUrl(a.id), alt: a.filename } }
          : { type: 'attachment', attrs: { id: a.id, filename: a.filename, mime: a.mime, size: a.size } };
        if (pos != null) {
          editor.chain().focus().insertContentAt(pos, node).run();
          pos = null;
        } else {
          editor.chain().focus().insertContent(node).run();
        }
      } catch (e) {
        dialog.toast(`${file.name}: ${e.message}`, 'error', 6000);
      } finally {
        setUploading((u) => u.filter((x) => x.key !== key));
      }
    }
  }, [note.id, readOnly, dialog]);

  // Attach a file: the Windows app's own picker (in front of the window), else the page's file input.
  const pickFile = useCallback(async () => {
    try {
      const files = await pickFilesNative();
      if (files === null) fileInput.current?.click();
      else if (files.length) uploadFiles(files, null);
    } catch (e) {
      dialog.toast(e.message ?? String(e), 'error');
    }
  }, [uploadFiles, dialog]);

  const extensions = useMemo(() => buildExtensions({ onFiles: (f, p) => uploadFiles(f, p) }), [uploadFiles]);

  const editor = useEditor({
    extensions,
    content: note.html || '<p></p>',
    editable: !viewOnly,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'note-body', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => {
      queue({ html: e.getHTML() });
      onChanged(note.id, { snippet: e.getText({ blockSeparator: ' ' }).slice(0, 220) });
    },
  }, [extensions]);

  // ---- live updates: this note changed in another window or device ----
  // With nothing unsaved here, the new text replaces it in place (the cursor and scroll position stay); with
  // unsaved typing, the conflict bar asks which to keep.
  const applyNote = useCallback((n, notice) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const scroller = ed.view.dom.closest('.editor-scroll');
    const top = scroller?.scrollTop;
    const { from, to } = ed.state.selection;
    ed.commands.setContent(n.html || '<p></p>', { emitUpdate: false });
    const size = ed.state.doc.content.size;
    try { ed.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) }); } catch { /* past the end */ }
    if (scroller && top != null) scroller.scrollTop = top;
    setTitle(n.title);
    if (n.tags) setTags(n.tags);
    if (n.attachments) setAttachments(n.attachments);
    known.current = n.updated_at;
    onSaved(note.id, { title: n.title, updated_at: n.updated_at });
    if (notice) dialog.toast(notice);
  }, [note.id, onSaved, dialog]);

  const checkRemote = useCallback(async () => {
    if (saving.current) { setTimeout(() => checkRemote(), 400); return; }
    let n;
    try { n = await api.getNote(note.id); } catch { return; }
    if (saving.current) { setTimeout(() => checkRemote(), 400); return; }
    const ed = editorRef.current;
    if (n.updated_at > known.current && ed && n.html === ed.getHTML() && n.title === titleRef.current?.value) {
      known.current = n.updated_at; // the same text (this window's own save, or nothing new)
      return;
    }
    if (n.deleted_at || !(n.updated_at > known.current)) {
      // Not newer text, but tags or files may have changed (and aren't being edited here).
      if (!('tags' in pending.current) && n.tags) setTags(n.tags);
      if (n.attachments) setAttachments(n.attachments);
      return;
    }
    const unsaved = 'html' in pending.current || 'title' in pending.current;
    if (unsaved || conflictRef.current) {
      setConflict(n);
      setStatus('conflict');
    } else {
      applyNote(n, 'This note was updated in another window; showing the latest.');
    }
  }, [note.id, applyNote]);

  // Through a ref, so the listener isn't set up again (dropping a check it had scheduled) on every render.
  const checkRemoteRef = useRef(checkRemote);
  checkRemoteRef.current = checkRemote;
  useEffect(() => {
    if (readOnly) return undefined;
    let t = null;
    const later = () => { clearTimeout(t); t = setTimeout(() => checkRemoteRef.current(), 250); };
    // Its own saves come back as live messages too. checkRemote waits for a save on its way and then finds the same
    // text, so they change nothing; other parts of this window (renaming, moving) are picked up like any change.
    const onLiveMsg = (e) => {
      if (e.detail?.note === note.id) later();
    };
    window.addEventListener('noteapp:live', onLiveMsg);
    window.addEventListener('noteapp:live-reconnect', later);
    window.addEventListener('focus', later);
    return () => {
      clearTimeout(t);
      window.removeEventListener('noteapp:live', onLiveMsg);
      window.removeEventListener('noteapp:live-reconnect', later);
      window.removeEventListener('focus', later);
    };
  }, [note.id, readOnly]);

  const loadTheirs = useCallback(async () => {
    clearTimeout(timer.current);
    pending.current = {};
    let n = conflictRef.current;
    try { n = await api.getNote(note.id); } catch { /* use what the conflict carried */ }
    setConflict(null);
    applyNote(n, 'Loaded the other version. Your text is in Version history if you need it.');
    setStatus('saved');
  }, [note.id, applyNote]);

  const keepMine = useCallback(async () => {
    const ed = editorRef.current;
    clearTimeout(timer.current);
    const patch = { ...pending.current, html: ed?.getHTML() ?? pending.current.html, title: titleRef.current?.value ?? title };
    pending.current = {};
    setStatus('saving');
    try {
      const r = await api.updateNote(note.id, { ...patch, overwrite: true });
      known.current = r.updated_at;
      setConflict(null);
      setStatus('saved');
      onSaved(note.id, { ...patch, updated_at: r.updated_at });
      dialog.toast('Kept your version. The other one is in Version history.');
    } catch (e) {
      pending.current = { ...patch, ...pending.current };
      setStatus('error');
      dialog.toast(`Save failed: ${e.message}`, 'error');
    }
  }, [note.id, title, onSaved, dialog]);

  // ---- camera / microphone ----
  // Phones and tablets open their own camera app (better photos); desktops get a live preview.
  const takePhoto = useCallback(async () => {
    if (window.matchMedia('(pointer: coarse)').matches || !canCapture()) {
      cameraInput.current?.click();
      return;
    }
    const file = await dialog.open((close) => <CameraDialog close={close} />);
    if (file) uploadFiles([file], null);
  }, [dialog, uploadFiles]);

  const recordAudio = useCallback(async () => {
    if (!canCapture() || !window.MediaRecorder) {
      dialog.toast('This browser cannot record audio.', 'error');
      return;
    }
    const file = await dialog.open((close) => <RecorderDialog close={close} />, { dismissable: false });
    if (file) uploadFiles([file], null, { recording: true });
  }, [dialog, uploadFiles]);

  // The citation style is app-wide; notes re-format when it changes in Settings.
  useEffect(() => {
    if (!editor) return undefined;
    const apply = (id) => { editor.storage.citation.style = id; editor.storage.citation.refresh?.(); };
    citationStyle().then(apply);
    const onStyle = (e) => apply(e.detail);
    window.addEventListener('noteapp:citation-style', onStyle);
    return () => window.removeEventListener('noteapp:citation-style', onStyle);
  }, [editor]);

  useEffect(() => {
    editorRef.current = editor;
    if (editor) {
      Object.assign(editor.storage.noteApp, {
        pickFile, takePhoto, recordAudio, insertTemplate: () => insertTemplateRef.current?.(),
        cite: () => citeRef.current?.insert('source'),
        footnote: () => citeRef.current?.insert('note'),
        editCitation: (pos) => citeRef.current?.edit(pos),
        bibleMenu: (event, ref) => citeRef.current?.bibleMenu(event, ref),
        linkMenu: (event, link) => citeRef.current?.linkMenu(event, link),
        selectionMenu: (event) => citeRef.current?.selectionMenu(event),
        noteId: note.id,
        notebookName: (id) => tree.notebooks.find((n) => n.id === id)?.name,
        createLinkedNote: (t) => citeRef.current?.createLinkedNote(t),
        logosLink: () => citeRef.current?.logosLink(),
        esvPassage: () => citeRef.current?.esvPassage(),
        notify: (message) => dialog.toast(message),
        handwriting: () => handwritingRef.current?.fromFile(),
        drawingToText: (pos) => handwritingRef.current?.fromNode(pos),
        attachmentToText: (pos) => handwritingRef.current?.fromNode(pos),
        imageMenu: (event, pos) => handwritingRef.current?.imageMenu(event, pos),
      });
    }
  }, [editor, pickFile, takePhoto, recordAudio]);

  // Opened at a heading (from a study's outline): scroll there and put the cursor in it.
  useEffect(() => {
    if (!editor || !scrollTo?.heading) return;
    let at = null;
    editor.state.doc.descendants((node, pos) => {
      if (at === null && node.type.name === 'heading' && node.textContent.trim() === scrollTo.heading) at = pos;
      return at === null;
    });
    if (at === null) return;
    editor.chain().focus().setTextSelection(at + 1).run();
    requestAnimationFrame(() => editor.view.nodeDOM(at)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  }, [editor, scrollTo?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The studies this note is part of, shown as chips that open the study.
  const [studies, setStudies] = useState([]);
  useEffect(() => { api.noteStudies(note.id).then(setStudies).catch(() => {}); }, [note.id]);
  // A sermon note shows a chip that opens the sermon builder.
  const [sermon, setSermon] = useState(null);
  useEffect(() => { api.noteSermon(note.id).then(setSermon).catch(() => {}); }, [note.id]);
  // The favorite Bible translation, named in the reference menu.
  const favBible = useBible();
  const openBuilder = async () => {
    await flush();
    await openSermonBuilder(dialog, note.id);
    api.noteSermon(note.id).then(setSermon).catch(() => {});
  };
  // A Bible study note shows a chip that opens the study builder.
  const [bibleStudy, setBibleStudy] = useState(null);
  useEffect(() => { api.noteBibleStudy(note.id).then(setBibleStudy).catch(() => {}); }, [note.id]);
  // A lesson, sermon or chapter: it keeps its own workflow (it can't become a study) and links to the studies behind it.
  const [fromStudies, setFromStudies] = useState({ workflow: null, studies: [] });
  useEffect(() => { api.noteFromStudies(note.id).then(setFromStudies).catch(() => {}); }, [note.id, sermon]);
  const openStudy = async () => {
    await flush();
    await openStudyBuilder(dialog, note.id);
    api.noteBibleStudy(note.id).then(setBibleStudy).catch(() => {});
  };
  // A teaching lesson in the Hook, Book, Look, Took layout opens in the lesson builder.
  // After a method switch the note's layout is the new one before the note comes back from the server.
  const [switched, setSwitched] = useState(null);
  useEffect(() => setSwitched(null), [note.id, note.html]);
  const lessonLayout = useMemo(() => isLessonNote((switched?.id === note.id ? switched.html : null) ?? note.html ?? ''), [note.html, note.id, switched]);
  const lessonBuilder = fromStudies.workflow === 'lesson' && !sermon && !bibleStudy && lessonLayout;
  // A sermon, Bible study or lesson (or a note in a teaching, preaching or writing study): one a builder works on.
  const builderNote = !!(sermon || bibleStudy || lessonLayout || fromStudies.workflow);
  useEffect(() => setDeviceLocked(workIsReadOnlyHere({ sermon, bibleStudy, lesson: lessonLayout, workflow: fromStudies.workflow })), [sermon, bibleStudy, lessonLayout, fromStudies.workflow]);
  const openLesson = async () => {
    await flush();
    await openLessonBuilder(dialog, note.id);
  };
  // The method a study, lesson or sermon follows; one with others to pick from can switch (shared/methods.js).
  const [method, setMethod] = useState(null);
  useEffect(() => { api.noteMethod(note.id).then(setMethod).catch(() => {}); }, [note.id, sermon, bibleStudy, fromStudies.workflow]);
  // A piece of writing from a project without a type reads as a book's chapter (its headings are its own).
  const fromMethod = method?.method ?? (method?.workflow === 'writing' ? 'book' : null);
  const canSwitch = !!(fromMethod && hasChoice(method.workflow));
  const switchMethod = async () => {
    const to = await chooseSwitch(dialog, method.workflow, method.method);
    if (!to || !editor) return;
    try {
      const html = convertHtml(editor.getHTML(), fromMethod, to);
      editor.commands.setContent(html, { emitUpdate: true });
      setSwitched({ id: note.id, html });
      await flush();
      setMethod(await api.setNoteMethod(note.id, to));
      dialog.toast(`Now laid out as ${methodById(to).name}`);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  // ---- 7.1: a lesson, sermon or Bible study reads as a page: what it is and its builder above the title, its passage
  // and how much is written below it, and its sections marked in the text (editor/WorkSections.js). ----
  const workType = sermon ? 'sermon' : bibleStudy ? 'study' : (lessonLayout || fromStudies.workflow === 'lesson') ? 'lesson' : null;
  const workMethod = methodById(method?.method) ?? methodById(WORK_DEFAULT[workType]);
  useEffect(() => {
    if (workType) window.dispatchEvent(new CustomEvent('noteapp:note-kind', { detail: { id: note.id, type: workType } }));
  }, [note.id, workType]);
  const workCfg = useMemo(() => (workType && workMethod ? {
    on: true, level: workMethod.level, parts: workMethod.rest ? workMethod.sections.map((x) => x.match) : null,
    prompt: (heading, part) => workPrompt(workMethod, heading, part),
  } : { on: false }), [workType, workMethod]);
  const [workTick, setWorkTick] = useState(0);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    editor.view.dispatch(editor.state.tr.setMeta(workKey, workCfg));
    if (!workCfg.on) return undefined;
    let t = null;
    const onUpdate = () => { clearTimeout(t); t = setTimeout(() => setWorkTick((n) => n + 1), 250); };
    editor.on('update', onUpdate);
    return () => { clearTimeout(t); editor.off('update', onUpdate); };
  }, [editor, workCfg]);
  const workParts = useMemo(() => (editor && !editor.isDestroyed && workCfg.on ? workSections(editor.state.doc, workCfg) : []),
    [editor, workCfg, workTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const workPassage = useMemo(() => {
    if (!workType) return '';
    if (sermon?.passage) return sermon.passage;
    if (bibleStudy?.passage) return bibleStudy.passage;
    try { if (parseLesson(note.html ?? '').passage) return parseLesson(note.html ?? '').passage; } catch { /* not a lesson layout */ }
    return findReferences(String(note.title ?? ''))[0]?.text ?? '';
  }, [workType, sermon, bibleStudy, note.html, note.title]);

  useEffect(() => { if (editor && editor.isEditable === viewOnly) editor.setEditable(!viewOnly); }, [editor, viewOnly]);
  const toggleLock = () => {
    setLocked((l) => !l);
    if (locked) requestAnimationFrame(() => { if (editorRef.current && !editorRef.current.isDestroyed) editorRef.current.commands.focus(); });
  };
  const toggleLockDefault = async () => {
    const next = !lockDefault;
    try {
      await api.updateNote(note.id, { read_only: next });
      setLockDefault(next);
      if (next) setLocked(true);
      onSaved(note.id, { read_only: next ? 1 : 0 });
      dialog.toast(next ? 'This note will open read-only. The lock button unlocks it when you want to edit.' : 'This note will open ready to edit.');
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  // ---- writing: focus mode, the sources panel, and the chapter's words and goal ----
  const writingStudy = studies.find((st) => st.kind === 'writing') ?? null;
  const [focus, setFocus] = useState(false);
  // The side panel (7.0): Outline, Passage, Sources and Revise as tabs of one panel beside the text.
  const [panel, setPanel] = useState(null);
  const [lastPanel, setLastPanel] = useStoredState('noteapp.sidePanel', 'outline');
  const openPanel = (t) => { setPanel(t); setLastPanel(t); };

  // ---- 8.0: sharing. Who this note is shared with (on its own, or in a shared notebook or project) and the
  // comments people made on it, highlighted in the text and listed in the side panel's Comments tab. ----
  const hosted = serverMode() === 'tenant';
  const phoneBar = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 800px)').matches;
  const [sharing, setSharing] = useState({ shares: [], threads: [] });
  const [thread, setThread] = useState(null);
  const loadSharing = useCallback(() => (hosted ? api.noteShareComments(note.id).then(setSharing).catch(() => {}) : null), [hosted, note.id]);
  useEffect(() => {
    loadSharing();
    if (!hosted) return undefined;
    const on = (e) => { if (e.detail?.sharing || e.detail?.url?.startsWith('/api/sharing')) loadSharing(); };
    window.addEventListener('noteapp:live', on);
    return () => window.removeEventListener('noteapp:live', on);
  }, [hosted, loadSharing]);
  const sharedWith = [...new Map(sharing.shares.flatMap((s) => s.people).map((p) => [p.slug, p])).values()];
  const openThread = useCallback((id) => { setThread(id); setPanel('comments'); }, []);
  useCommentMarks(editor, sharing.threads, thread, openThread);
  const unseenComments = sharing.threads.reduce((n, t) => n + t.comments.filter((c) => !c.seen).length, 0);
  useEffect(() => {
    if (panel === 'comments' && unseenComments) api.noteShareCommentsSeen(note.id).then(loadSharing).catch(() => {});
  }, [panel, unseenComments, note.id, loadSharing]);
  const shareNote = async () => {
    await flush();
    await openShare(dialog, { kind: 'note', id: note.id, title, alsoIn: sharing.shares.filter((s) => s.kind !== 'note') });
    loadSharing();
  };
  // The chip opens the share it's in: the note's own, or else its notebook's or project's.
  const openNoteShare = async () => {
    const s = sharing.shares.find((x) => x.kind === 'note') ?? sharing.shares[0];
    if (!s || s.kind === 'note') return shareNote();
    await openShare(dialog, { kind: s.kind, id: s.refId, title: s.title });
    loadSharing();
  };
  const showSources = panel === 'sources';
  const showRevise = panel === 'revise';
  const toggleSources = () => (showSources ? setPanel(null) : openPanel('sources'));
  const toggleRevise = () => (showRevise ? setPanel(null) : openPanel('revise'));
  useEffect(() => { setPanel((p) => (p === 'revise' ? null : p)); }, [note.id]);
  const [words, setWords] = useState(0);
  const [chapterGoal, setChapterGoal] = useState(null);
  useEffect(() => {
    if (!editor) return undefined;
    const count = () => setWords(editor.getText({ blockSeparator: ' ' }).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length);
    count();
    let t = null;
    const onUpdate = () => { clearTimeout(t); t = setTimeout(count, 400); };
    editor.on('update', onUpdate);
    return () => { clearTimeout(t); editor.off('update', onUpdate); };
  }, [editor]);
  useEffect(() => {
    if (!writingStudy) return;
    api.study(writingStudy.id).then((st) => setChapterGoal(st.chapters?.find((c) => c.id === note.id)?.goal ?? null)).catch(() => {});
  }, [writingStudy?.id, note.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focus) return undefined;
    document.body.classList.add('focus-writing');
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if ([...document.querySelectorAll('.modal-backdrop, .menu, .context-menu, .slash-popup, .esv-card, .find-bar')].some((el) => el.getClientRects().length > 0)) return;
      setFocus(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { document.body.classList.remove('focus-writing'); window.removeEventListener('keydown', onKey, true); };
  }, [focus]);

  // ---- find in note (Ctrl+F) ----
  // The open note takes Ctrl+F when the key is for it: typed in it, or nowhere else in particular (not in another
  // field, a dialog or a peek over this page). A peek takes it only when you're in the peek.
  const paneRef = useRef(null);
  const [find, setFind] = useState(null); // { seed, n } while the find bar is open
  const openFind = () => {
    const { from, to, empty } = editor?.state.selection ?? {};
    const picked = !empty && editor ? editor.state.doc.textBetween(from, to, ' ').trim() : '';
    setFind((f) => ({ seed: picked && !picked.includes('\n') && picked.length <= 100 ? picked : '', n: (f?.n ?? 0) + 1 }));
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  useEffect(() => {
    if (!editor) return undefined;
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'f' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const pane = paneRef.current;
      const at = document.activeElement;
      const mine = pane?.contains(at);
      if (!mine) {
        if (peek || document.querySelector('.modal-backdrop, .note-peek')) return;
        if (at && at !== document.body && (at.closest('input, textarea, select, [contenteditable="true"], .editor-pane'))) return;
      }
      e.preventDefault();
      e.stopPropagation();
      openFindRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editor, peek]);

  // New, empty notes start with the cursor in the title.
  useEffect(() => {
    if (!viewOnly && !note.title && editor?.isEmpty) titleRef.current?.focus();
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grow the title textarea with its content (for browsers without field-sizing).
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Ctrl/Cmd+S saves immediately.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); flush(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  // ---- metadata ----
  const changeTitle = (v) => {
    setTitle(v);
    queue({ title: v });
    onChanged(note.id, { title: v });
  };
  const changeTags = (t) => {
    setTags(t);
    queue({ tags: t }, 0);
  };
  const changeNotebook = async (id) => {
    const prev = notebookId;
    setNotebookId(id);
    try {
      await api.updateNote(note.id, { notebook_id: id });
      onSaved(note.id, { notebook_id: id });
    } catch (e) {
      setNotebookId(prev);
      dialog.toast(e.message, 'error');
    }
  };
  const togglePin = async () => { if (await noteActions.setPinned(note, !pinned)) setPinned(!pinned); };
  const toggleDashboard = async () => { if (await noteActions.setOnDashboard(note, !onDashboard)) setOnDashboard(!onDashboard); };
  const toggleTemplate = async () => {
    if (await noteActions.setTemplate({ ...note, notebook_id: notebookId }, !isTemplate)) setIsTemplate(!isTemplate);
  };
  /** Puts a template's content at the cursor; its attachments are copied to this note and its tags added. */
  const insertTemplate = async () => {
    const r = await dialog.open((close) => <TemplatePicker tree={tree} insert close={close} />);
    if (!r) return;
    try {
      await flush();
      await api.snapshotNote(note.id, 'Before inserting a template').catch(() => {});
      const copy = await api.copyNote(r.template, { into: note.id });
      editorRef.current?.chain().focus().insertContent(copy.html).run();
      if (copy.attachments.length) setAttachments((list) => [...list, ...copy.attachments]);
      const extra = copy.tags.filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()));
      if (extra.length) changeTags([...tags, ...extra]);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  insertTemplateRef.current = insertTemplate;

  // ---- citations & footnotes ----
  const cite = {
    insert: async (initialTab) => {
      const attrs = await dialog.open((close) => <CiteDialog initialTab={initialTab} close={close} />);
      if (attrs) editorRef.current?.chain().focus().insertCitation(attrs).run();
    },
    edit: async (pos) => {
      if (lockedRef.current) return; // read-only: citations show their notes but don't change
      const node = editorRef.current?.state.doc.nodeAt(pos);
      if (!node) return;
      const r = await dialog.open((close) => <CiteDialog value={node.attrs} close={close} />);
      if (!r) return;
      const chain = editorRef.current.chain().focus();
      if (r.remove) chain.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
      else chain.updateCitation(pos, r).run();
    },
  };
  // Bible references and Logos links.
  // Bible text (the favorite translation, or `tr`), at the cursor or for a reference in the note ({ pos, end } of the
  // reference). A quotation goes after the paragraph holding the reference; inline text goes right after the
  // reference, which already names it.
  const insertEsv = async (refs, { at = null, style = 'quote', tr = '' } = {}) => {
    if (!(await bibleConnected())) return dialog.toast('Connect a Bible first: Settings → Connections → Bible', 'error');
    let p;
    try { p = await biblePassage(refs, tr); } catch (e) { return dialog.toast(e.message, 'error'); }
    const ed = editorRef.current;
    if (!ed) return;
    if (style === 'inline') {
      // As a text node, so it isn't read as HTML (which would drop the leading space).
      if (!at) return ed.chain().focus().insertContent({ type: 'text', text: passageInlineText(p) }).run();
      return ed.chain().focus().insertContentAt(at.end, { type: 'text', text: ` ${passageInlineText(p, { withRef: false })}` }).run();
    }
    const html = passageNoteHtml(p);
    if (!at) return ed.chain().focus().insertContent(html).run();
    const $pos = ed.state.doc.resolve(at.pos);
    ed.chain().focus().insertContentAt($pos.after($pos.depth), html).run();
  };
  cite.esvPassage = async () => {
    const r = await dialog.open((close) => <EsvInsertDialog close={close} />);
    if (r) insertEsv(r.q, { style: r.style, tr: r.tr });
  };
  // A prayer request from the selected text (or blank), linked to this note.
  const addToPrayer = async () => {
    const ed = editorRef.current;
    const { from, to } = ed?.state.selection ?? {};
    const selected = ed && from !== to ? ed.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const categories = await api.prayer(todayStr()).then((r) => r.categories).catch(() => []);
    const r = await dialog.open((close) => <PrayerDialog request={{ title: selected, note_id: note.id }} categories={categories} close={close} />);
    if (r && !r.deleted) dialog.toast('Added to your prayer list');
  };
  // Reusable sermon material from the selected text (or blank), with a link back to this note.
  const selectionHtml = () => {
    const ed = editorRef.current;
    if (!ed || ed.state.selection.empty) return '';
    const div = document.createElement('div');
    div.appendChild(DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.selection.content().content));
    return div.innerHTML;
  };
  const addToBank = async () => {
    const html = selectionHtml();
    const passage = sermon?.passage ?? '';
    const r = await dialog.open((close) => <BankItemDialog start={{ html, passage, source_note_id: note.id }} close={close} />);
    if (r) dialog.toast('Added to the sermon bank');
  };
  // Right-click on selected text (Shift+right-click keeps the browser's own menu).
  cite.selectionMenu = (event) => dialog.contextMenu(event, [
    { label: 'Copy', onClick: () => {
      const html = selectionHtml();
      const text = new DOMParser().parseFromString(html, 'text/html').body.innerText;
      const done = navigator.clipboard.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
        : navigator.clipboard.writeText(text);
      done.catch(() => dialog.toast('Could not access clipboard', 'error'));
    } },
    'sep',
    !isTemplate && { label: 'Add to sermon bank…', onClick: addToBank },
    !isTemplate && { label: 'Add to prayer list…', onClick: addToPrayer },
  ]);
  cite.bibleMenu = (event, { refs, ref, pos, end }) => dialog.contextMenu(event, [
    { label: `Open ${refs} in Logos`, onClick: () => openPassage(ref) },
    !viewOnly && { label: `Insert ${favBible.label === 'Bible' ? 'Bible' : favBible.label} text of ${refs} as a quote`, onClick: () => insertEsv(refs, { at: { pos, end }, style: 'quote' }) },
    !viewOnly && { label: `Insert ${favBible.label === 'Bible' ? 'Bible' : favBible.label} text of ${refs} inline`, onClick: () => insertEsv(refs, { at: { pos, end }, style: 'inline' }) },
    onOpenScripture && { label: `Find notes on ${refs}`, onClick: () => onOpenScripture(refs) },
    // The ref.ly form works for anyone, with or without Logos installed.
    { label: 'Copy Logos link', onClick: () => navigator.clipboard.writeText(logosUrl(ref)).then(() => dialog.toast('Logos link copied')).catch(() => dialog.toast('Could not access clipboard', 'error')) },
  ]);
  // Any other link: open it (Logos links in the app, see logos.js), copy it, or take the link off the text.
  cite.linkMenu = (event, { href, pos }) => {
    const toNote = /^#note\/(\d+)$/.exec(href);
    if (toNote) {
      dialog.contextMenu(event, [
        { label: 'Open note', onClick: () => openNoteEvent(Number(toNote[1])) },
        { label: 'Copy link', onClick: () => navigator.clipboard.writeText(`${location.origin}/${href}`).then(() => dialog.toast('Link copied')).catch(() => dialog.toast('Could not access clipboard', 'error')) },
        !viewOnly && 'sep',
        !viewOnly && { label: 'Remove link', onClick: () => editorRef.current?.chain().focus().setTextSelection(pos).extendMarkRange('noteLink').unsetMark('noteLink').run() },
      ]);
      return;
    }
    const logos = /^https?:\/\/ref\.ly\//i.test(href);
    dialog.contextMenu(event, [
      { label: logos ? 'Open in Logos' : 'Open link', onClick: () => openLink(href) },
      { label: 'Copy link', onClick: () => navigator.clipboard.writeText(href).then(() => dialog.toast('Link copied')).catch(() => dialog.toast('Could not access clipboard', 'error')) },
      !viewOnly && 'sep',
      !viewOnly && { label: 'Remove link', onClick: () => editorRef.current?.chain().focus().setTextSelection(pos).extendMarkRange('link').unsetLink().run() },
    ]);
  };
  cite.logosLink = async () => {
    const r = await dialog.open((close) => <LogosLinkDialog close={close} />);
    if (r) editorRef.current?.chain().focus().insertContent({ type: 'text', text: r.text, marks: [{ type: 'link', attrs: { href: r.url } }] }).insertContent(' ').run();
  };
  // [[ → "Create …": a new note in this note's notebook, then linked here.
  cite.createLinkedNote = async (t) => {
    try {
      const nb = notebookId ?? tree.notebooks[0]?.id;
      const { id } = await api.createNote(nb);
      await api.updateNote(id, { title: t });
      window.dispatchEvent(new Event('noteapp:notes-changed'));
      dialog.toast(`Created “${t}”`);
      return id;
    } catch (e) {
      dialog.toast(e.message, 'error');
      return null;
    }
  };
  citeRef.current = cite;

  // ---- handwriting to text ----
  const handwriting = {
    // A photo, scan or PDF chosen in the dialog: the text goes in at the cursor, with the original above it if wanted.
    fromFile: async () => {
      const ed = editorRef.current;
      if (!ed || lockedRef.current) return;
      const at = ed.state.selection.from;
      const r = await dialog.open((close) => (
        <HandwritingDialog canKeepOriginal actions={[{ key: 'insert', label: 'Insert into note' }]} close={close} />
      ), { dismissable: false });
      if (!r || !editorRef.current) return;
      const pos = Math.min(at, editorRef.current.state.doc.content.size);
      editorRef.current.chain().focus().insertContentAt(pos, r.html).run();
      if (r.keepOriginal) uploadFiles([r.file], pos);
    },
    // A drawing, picture or attachment in the note: the text goes right below it (or replaces a drawing).
    fromNode: async (pos) => {
      const ed = editorRef.current;
      const node = typeof pos === 'number' ? ed?.state.doc.nodeAt(pos) : null;
      if (!node) return;
      const kind = node.type.name;
      const editable = !lockedRef.current;
      const load = kind === 'drawing'
        ? async () => pagesFromFile(new File([await drawingToPng(node.attrs, 1600, { forText: true })], 'drawing.png', { type: 'image/png' }))
        : kind === 'image' ? () => pagesFromUrl(node.attrs.src, node.attrs.alt)
          : () => pagesFromUrl(fileUrl(node.attrs.id), node.attrs.filename);
      const actions = !editable ? []
        : kind === 'drawing' ? [{ key: 'replace', label: 'Replace the drawing' }, { key: 'below', label: 'Insert below' }]
          : [{ key: 'below', label: 'Insert below' }];
      const r = await dialog.open((close) => <HandwritingDialog load={load} actions={actions} close={close} />, { dismissable: false });
      const now = editorRef.current;
      if (!r || !now) return;
      // The note may have changed while the dialog was open; find the block again.
      const at = now.state.doc.nodeAt(pos) === node ? pos : (() => {
        let found = null;
        now.state.doc.descendants((n, p) => { if (found === null && n === node) found = p; return found === null; });
        return found;
      })();
      if (at === null) return dialog.toast('The block was removed, so the text wasn’t added. Use Copy text instead.', 'error');
      if (r.action === 'replace') now.chain().focus().insertContentAt({ from: at, to: at + node.nodeSize }, r.html).run();
      else now.chain().focus().insertContentAt(at + node.nodeSize, r.html).run();
    },
    imageMenu: (event, pos) => {
      const node = editorRef.current?.state.doc.nodeAt(pos);
      if (!node) return;
      const src = node.attrs.src;
      const id = /^\/api\/files\/(\d+)/.exec(src ?? '')?.[1];
      dialog.contextMenu(event, [
        { label: lockedRef.current ? 'Read handwriting as text…' : 'Handwriting to text…', onClick: () => handwriting.fromNode(pos) },
        'sep',
        { label: 'Open picture', onClick: () => window.open(src, '_blank', 'noopener,noreferrer') },
        id && { label: 'Download', onClick: () => { window.location.href = `${fileUrl(Number(id))}?download=1`; } },
      ]);
    },
  };
  handwritingRef.current = handwriting;

  const showHistory = async () => {
    await flush();
    await dialog.open((close) => (
      <VersionHistory noteId={note.id} current={{ title, html: editorRef.current?.getHTML() ?? note.html }} close={close}
        onRestore={async (vid) => {
          try {
            await api.restoreVersion(note.id, vid);
            dialog.toast('Earlier version restored');
            onReload?.();
          } catch (e) {
            dialog.toast(e.message, 'error');
          }
        }} />
    ));
  };

  // Copies need the latest title and content saved first.
  const copyNote = async (fn) => { await flush(); fn({ ...note, title, notebook_id: notebookId, is_template: isTemplate ? 1 : 0 }); };

  const postToWordPress = async () => {
    const r = await dialog.open((close) => (
      <WordPressPostDialog noteId={note.id} title={title} tags={tags} attachments={attachments}
        getHtml={async () => { await flush(); return editorRef.current?.getHTML() ?? ''; }} close={close} />
    ), { dismissable: false });
    if (!r) return;
    setWpPost({ post_id: r.id, link: r.link, status: r.status, date: r.date });
    if (r.tag && !tags.some((t) => t.toLowerCase() === r.tag.toLowerCase())) changeTags([...tags, r.tag]);
  };

  const exportNote = async () => {
    await flush();
    await openExport(dialog, {
      scope: { notes: [note.id] }, title: title || 'Untitled',
      word: { getParts: async () => [{ title: title || 'Untitled', html: editorRef.current?.getHTML() ?? note.html }] },
    });
  };
  const splitNote = async () => {
    await flush();
    const r = await dialog.open((close) => <SplitDialog note={{ ...note, title, html: editorRef.current?.getHTML() ?? note.html }} tree={tree} close={close} />);
    if (!r) return;
    dialog.toast(`Split into ${r.ids.length} notes${r.contentsId ? ', with a contents note' : ''}`);
    window.dispatchEvent(new CustomEvent('noteapp:notes-changed'));
    window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: r.contentsId ?? r.ids[0] }));
  };

  const deleteWordPressPost = async () => {
    const how = await askDeletePosts(dialog, { title: title || undefined });
    if (!how) return;
    try {
      await api.deleteWordpressPost(wpPost.post_id, how.permanent);
      setWpPost(null);
      dialog.toast(how.permanent ? 'WordPress post deleted permanently' : 'WordPress post moved to the Trash');
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const removeAttachment = async (a) => {
    const ok = await dialog.confirm({
      title: 'Delete attachment?',
      message: `"${a.filename}" will be permanently deleted and removed from this note.`,
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    await api.deleteAttachment(a.id);
    setAttachments((list) => list.filter((x) => x.id !== a.id));
    // Remove any blocks that reference it.
    const ranges = [];
    editor.state.doc.descendants((node, pos) => {
      if ((node.type.name === 'attachment' && node.attrs.id === a.id)
        || (node.type.name === 'image' && node.attrs.src === fileUrl(a.id))) {
        ranges.push({ from: pos, to: pos + node.nodeSize });
      }
    });
    if (ranges.length) {
      const tr = editor.state.tr;
      ranges.reverse().forEach((r) => tr.delete(r.from, r.to));
      editor.view.dispatch(tr);
    }
  };

  const nbOptions = notebookOptions(tree);
  const statusText = { saved: 'Saved', saving: 'Saving…', unsaved: 'Editing…', error: 'Not saved', conflict: 'Not saved' }[status];

  return (
    <div ref={paneRef} className={`editor-pane ${focus ? 'is-focus' : ''} ${panel && (panel !== 'sources' || writingStudy) ? 'has-sources' : ''}`}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === 'f' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setFocus((f) => !f); }
        // Esc in the note closes the find bar (the bar's own Esc also puts the cursor on the match).
        else if (e.key === 'Escape' && find && !e.defaultPrevented && !e.target.closest?.('.find-bar')) setFind(null);
      }}>
      {readOnly && (
        <div className="trash-banner">
          <span>This note is in the Trash.</span>
          <button className="btn btn-small" onClick={() => onRestore(note.id)}><Icon name="restore" size={14} /> Restore</button>
          {device.full && <button className="btn btn-small btn-danger" onClick={() => onDeleteForever(note.id)}>Delete forever</button>}
        </div>
      )}

      {isTemplate && !readOnly && (
        <div className="template-banner">
          <Icon name="copy" size={15} />
          <span title={PLACEHOLDER_HELP}><strong>Template.</strong> New notes made from it start with this content; {'{{date}}'} and other placeholders get filled in.</span>
          <button className="btn btn-small" onClick={() => copyNote((n) => noteActions.newFromTemplate(n))}>New note from template</button>
          <button className="btn btn-small" onClick={toggleTemplate}>Stop using as template</button>
        </div>
      )}

      <div className="note-meta">
        {!peek && <button className="icon-btn mobile-only" onClick={onBack} aria-label="Back to list"><Icon name="chevronLeft" /></button>}
        {isTemplate ? (
          <span className="template-chip" title="Templates live in their own list"><Icon name="copy" size={14} /> Template</span>
        ) : (
          // 10.1: no notebook picker. A note still in the Inbox says so until it has a tag.
          notebookId != null && notebookId === tree.inbox?.id && !tags.length
            ? <span className="template-chip is-inbox" title="Add a tag to move it to My notes"><Icon name="inbox" size={14} /> Inbox</span>
            : null
        )}
        {/* Tags and the chips after them: inline on a wide screen; on a phone, a second row that scrolls sideways (8.0). */}
        <div className="note-meta-strip">
        <TagInput tags={tags} allTags={tree.tags} onChange={changeTags} disabled={readOnly || deviceLocked} />
        {studies.map((st) => (
          <button key={st.id} type="button" className={`study-chip study-c-${st.color ?? 'blue'}`} title="Open the study"
            onClick={() => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: st.id }))}>
            <Icon name="book" size={12} /> {st.title}
          </button>
        ))}
        {device.full && sermon && !workType && (
          <button type="button" className="study-chip sermon-chip" title="Open the sermon builder" onClick={openBuilder}>
            <Icon name="lectern" size={12} /> Sermon{sermon.preached ? ` · preached ${sermon.preached}×` : ''}
          </button>
        )}
        {device.full && lessonBuilder && !workType && (
          <button type="button" className="study-chip lesson-chip" title="Open the lesson builder" onClick={openLesson}>
            <Icon name="present" size={12} /> Lesson builder
          </button>
        )}
        {device.full && bibleStudy && !workType && (
          <button type="button" className="study-chip bible-study-chip" title="Open the study builder" onClick={openStudy}>
            <Icon name="bible" size={12} /> Bible study{bibleStudy.passage ? ` · ${bibleStudy.passage}` : ''}
          </button>
        )}
        {fromStudies.studies.map((st) => (
          <button key={st.note_id} type="button" className="study-chip bible-study-chip" title={st.keeper ? `Keeper: “${st.keeper}”` : 'Open the study'}
            onClick={() => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: st.note_id }))}>
            <Icon name="bible" size={12} /> {st.linked ? 'From your study' : 'Your study'}: {st.title}
          </button>
        ))}
        {sharedWith.length > 0 && (
          <button type="button" className="study-chip share-chip" onClick={openNoteShare}
            title={`Shared with ${sharedWith.map((p) => p.name).join(', ')}${sharing.shares.some((s) => s.kind !== 'note') ? ` (in “${sharing.shares.find((s) => s.kind !== 'note').title}”)` : ''}`}>
            <Icon name="share" size={12} /> Shared · {sharedWith.length === 1 ? sharedWith[0].name : `${sharedWith.length} people`}
          </button>
        )}
        {sharing.threads.some((t) => !t.resolvedAt) && (
          <button type="button" className={`study-chip comment-chip ${unseenComments ? 'is-new' : ''}`} onClick={() => openPanel('comments')} title="Comments from the people you share it with">
            <Icon name="comment" size={12} /> {sharing.threads.filter((t) => !t.resolvedAt).length}{unseenComments ? ' new' : ''}
          </button>
        )}
        </div>
        <span className="spacer" />
        {device.full && wpPost && (
          <a className={`wp-badge is-${wpPost.status}`} href={wpPost.link} target="_blank" rel="noopener noreferrer"
            title={{
              publish: 'Published on WordPress',
              future: `Scheduled on WordPress${wpPost.date ? `: goes live ${formatMoment(wpPost.date)}` : ''}`,
            }[wpPost.status] ?? 'Draft on WordPress'}>
            <Icon name="globe" size={13} /> {{ publish: 'Published', future: 'Scheduled' }[wpPost.status] ?? 'Draft'}
          </a>
        )}
        {deviceLocked && !readOnly && <span className="lock-btn is-on is-device" title="Open this on the web or in Selah Desktop to edit it"><Icon name="lock" size={15} /><span>Read-only here</span></span>}
        {!readOnly && !deviceLocked && (
          <button type="button" className={`lock-btn ${locked ? 'is-on' : ''}`} onClick={toggleLock} aria-pressed={locked}
            title={locked ? 'Read-only: click to edit' : 'Make read-only (just for reading)'}>
            <Icon name={locked ? 'lock' : 'unlock'} size={15} />{locked && <span>Read-only</span>}
          </button>
        )}
        {!readOnly && !deviceLocked && <span className={`save-status is-${status}`}>{statusText}</span>}
        {writingStudy && (
          <button className={`icon-btn ${showSources ? 'is-on' : ''}`} onClick={toggleSources} aria-pressed={showSources}
            aria-label="Sources" title={`Sources for “${writingStudy.title}”: your reading notes and the sources it cites`}>
            <Icon name="cite" size={17} />
          </button>
        )}
        {writingStudy && (
          <button className={`icon-btn ${showRevise ? 'is-on' : ''}`} onClick={toggleRevise} aria-pressed={showRevise}
            aria-label="Revise" title="Revise: reading level, long sentences, filler and more, marked in the text">
            <Icon name="marker" size={17} />
          </button>
        )}
        <button className={`icon-btn wide-only ${panel ? 'is-on' : ''}`} onClick={() => (panel ? setPanel(null) : openPanel(lastPanel))} aria-pressed={!!panel}
          aria-label="Side panel" title="Side panel: outline, passage, sources and revise">
          <Icon name="layout" size={17} />
        </button>
        {!readOnly && (
          <button className="icon-btn wide-only" onClick={() => setFocus(true)} aria-label="Focus mode" title="Focus mode: just the text (Ctrl+Shift+F)">
            <Icon name="pen" size={16} />
          </button>
        )}
        {/* In a peek (the panel over a study), "open full page" replaces the full-screen toggle. */}
        {peek ? (
          <button className="icon-btn" onClick={peek.onOpenFull} aria-label="Open as a full page" title="Open as a full page">
            <Icon name="expand" size={17} />
          </button>
        ) : (
          <button className={`icon-btn full-note-btn ${fullScreen ? 'is-on' : ''}`} onClick={onFullScreen} aria-pressed={!!fullScreen}
            aria-label={fullScreen ? 'Exit full screen' : 'Full screen'} title={fullScreen ? 'Exit full screen (show the note list)' : 'Full screen (hide the note list)'}>
            <Icon name={fullScreen ? 'shrink' : 'expand'} size={17} />
          </button>
        )}
        {!readOnly && (
          <Menu align="right" trigger={({ toggle }) => (
            <button className="icon-btn" onClick={toggle} aria-label="Note actions"><Icon name="more" /></button>
          )} items={[
            isTemplate && { label: 'New note from this template', onClick: () => copyNote((n) => noteActions.newFromTemplate(n)) },
            !isTemplate && { label: pinned ? 'Unpin from top of the list' : 'Pin to top of the list', onClick: togglePin },
            !isTemplate && { label: onDashboard ? 'Remove from Home' : 'Pin to Home', onClick: toggleDashboard },
            { label: isTemplate ? 'Duplicate template' : 'Duplicate', onClick: () => copyNote(noteActions.duplicate) },
            device.full && { label: isTemplate ? 'Stop using as template' : 'Make into template', onClick: toggleTemplate },
            !isTemplate && { label: 'Insert template…', onClick: insertTemplate },
            { label: 'Copy link to note', onClick: () => noteActions.copyLink(note) },
            hosted && !isTemplate && { label: sharedWith.length ? 'Sharing…' : 'Share…', onClick: shareNote },
            { label: 'Find in note… (Ctrl+F)', onClick: openFind },
            // On a phone the side panel's button is in here, to keep the bar to one row.
            phoneBar && { label: panel ? 'Close the side panel' : 'Side panel: outline, passage…', onClick: () => (panel ? setPanel(null) : openPanel(lastPanel)) },
            { label: 'Version history…', onClick: showHistory },
            !isTemplate && { label: showRevise ? 'Close Revise' : 'Revise…', onClick: toggleRevise },
            // Present, Preach/Teach and the builders are for sermons, lessons and studies; an ordinary note doesn't list them.
            !device.phone && builderNote && { label: 'Present', onClick: async () => { await flush(); presentNote(dialog, note.id); } },
            builderNote && (lessonLayout && !sermon ? { label: 'Teach', onClick: async () => { await flush(); await teachNote(dialog, note.id); } }
              : { label: 'Preach', onClick: async () => { await flush(); await preachNote(dialog, note.id); api.noteSermon(note.id).then(setSermon).catch(() => {}); } }),
            !device.phone && !isTemplate && (sermon || lessonLayout) && { label: 'Slides…', onClick: async () => { await flush(); openSlides(dialog, note.id); } },
            device.full && !isTemplate && sermon && { label: 'Sermon builder…', onClick: openBuilder },
            device.full && !isTemplate && bibleStudy && { label: 'Study builder…', onClick: openStudy },
            device.full && lessonBuilder && { label: 'Lesson builder…', onClick: openLesson },
            device.full && !isTemplate && !viewOnly && canSwitch && { label: 'Switch method…', onClick: switchMethod },
            device.full && { label: 'Print handout…', onClick: async () => { await flush(); printHandout(dialog, note.id); } },
            device.full && { label: 'Export…', onClick: exportNote },
            device.full && !isTemplate && { label: 'Split into notes…', onClick: splitNote },
            { label: 'Focus mode', onClick: () => setFocus(true) },
            { label: lockDefault ? '✓ Always open read-only' : 'Always open read-only', onClick: toggleLockDefault },
            !isTemplate && { label: 'Add to prayer list…', onClick: addToPrayer },
            !isTemplate && { label: 'Add to sermon bank…', onClick: addToBank },
            !deviceLocked && { label: 'Attach file…', onClick: pickFile },
            'sep',
            device.full && { label: wpPost ? 'Update WordPress post…' : 'Post to WordPress…', onClick: postToWordPress },
            device.full && wpPost && { label: 'Open WordPress post', onClick: () => window.open(wpPost.link, '_blank', 'noopener,noreferrer') },
            device.full && wpPost && { label: 'Delete WordPress post…', danger: true, onClick: deleteWordPressPost },
            'sep',
            !deviceLocked && { label: 'Move to Trash', danger: true, onClick: () => onTrash(note.id) },
          ]} />
        )}
        {peek && <button className="icon-btn" onClick={peek.onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" /></button>}
      </div>

      {!viewOnly && editor && (
        <Toolbar editor={editor} onPickFile={pickFile} onTakePhoto={takePhoto} onRecord={recordAudio}
              onInsertTemplate={isTemplate ? undefined : insertTemplate} onCite={() => cite.insert('source')} />
      )}

      {conflict && (
        <div className="conflict-bar" role="alert">
          <Icon name="restore" size={16} />
          <span><strong>This note changed in another window or device.</strong> Your latest typing isn't saved yet.</span>
          <button className="btn btn-small" onClick={loadTheirs}>Load theirs</button>
          <button className="btn btn-small btn-primary" onClick={keepMine}>Keep mine</button>
        </div>
      )}

      <div className="editor-body">
      <div className="editor-scroll">
        {find && editor && <FindBar editor={editor} seed={find.seed} n={find.n} onClose={() => setFind(null)} />}
        <div className={`editor-doc ${workType ? `is-work is-${workType}` : ''}`}>
          {workType === 'study' && bibleStudy && !peek && (
            <nav className="work-path" aria-label="Where this study lives">
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'scripture' }))}>Bible studies</button>
              {bibleStudy.plan && <><Icon name="chevronRight" size={12} />
                <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: bibleStudy.plan.id }))}>{bibleStudy.plan.title || 'Untitled study'}</button></>}
              <Icon name="chevronRight" size={12} /><span>{title || 'Untitled Study'}</span>
            </nav>
          )}
          {workType && (
            <div className="work-top">
              <span className="work-eyebrow">{WORK_LABEL[workType]}{workMethod ? ` · ${workMethod.name}` : ''}</span>
              <span className="spacer" />
              {device.full && (workType === 'sermon' || bibleStudy || lessonBuilder) && !isTemplate && (
                <button type="button" className={`btn work-builder ${workType === 'study' ? 'is-main' : ''}`}
                  onClick={workType === 'sermon' ? openBuilder : workType === 'study' ? openStudy : openLesson}>
                  {{ sermon: 'Sermon builder', study: 'Study builder', lesson: 'Lesson builder' }[workType]}
                </button>
              )}
              {device.tablet && workType !== 'study' && !isTemplate && (
                <button type="button" className="btn" onClick={async () => { await flush(); openSlides(dialog, note.id); }}>
                  <Icon name="present" size={12} /> Slides
                </button>
              )}
              {!device.phone && workType !== 'study' && !isTemplate && (
                <button type="button" className="btn work-go" onClick={async () => {
                  await flush();
                  if (workType === 'sermon') { await preachNote(dialog, note.id); api.noteSermon(note.id).then(setSermon).catch(() => {}); } else await teachNote(dialog, note.id);
                }}>
                  <Icon name="play" size={11} /> {workType === 'sermon' ? 'Preach' : 'Teach'}
                </button>
              )}
            </div>
          )}
          <textarea
            ref={titleRef}
            className="note-title"
            rows={1}
            value={title}
            readOnly={viewOnly}
            placeholder="Title"
            onChange={(e) => changeTitle(e.target.value.replace(/\n/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.target.selectionStart === title.length)) {
                e.preventDefault();
                // commands.focus() defers the DOM focus to the next frame; focus the view
                // synchronously too so fast typing doesn't land in the title.
                editor?.commands.focus('start');
                editor?.view.focus();
              }
            }}
          />
          {workType && (
            <WorkMeta parts={workParts} type={workType} passage={workPassage} words={words}
              onPassage={workPassage ? () => openPanel('passage') : null} />
          )}
          {editor && !viewOnly && (
            // Inside a list, each item has its own grip (it carries its sub-items); near the list's left edge it's the whole list.
            <DragHandle editor={editor} nested={LIST_DRAG}>
              <div className="drag-grip" title="Drag to move"><Icon name="grip" size={16} /></div>
            </DragHandle>
          )}
          <EditorContent editor={editor} />
          <CitationNotes editor={editor} />

          {attachments.length > 0 && (
            <div className="files-panel">
              <button className="files-toggle" onClick={() => setShowFiles(!showFiles)}>
                <Icon name={showFiles ? 'chevronDown' : 'chevronRight'} size={14} />
                <Icon name="paperclip" size={14} /> {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
              </button>
              {showFiles && (
                <ul className="files-list">
                  {attachments.map((a) => (
                    <li key={a.id}>
                      {a.mime === 'application/pdf' ? (
                        <button type="button" className="link-btn" onClick={() => setReadingPdf(a)}>{a.filename}</button>
                      ) : (
                        <a href={fileUrl(a.id)} target="_blank" rel="noopener noreferrer">{a.filename}</a>
                      )}
                      <span className="muted">{formatSize(a.size)}</span>
                      <a className="icon-btn" href={`${fileUrl(a.id)}?download=1`} title="Download"><Icon name="download" size={14} /></a>
                      {!readOnly && (
                        <button className="icon-btn" title="Delete attachment" onClick={() => removeAttachment(a)}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {readingPdf && <PdfReader id={readingPdf.id} filename={readingPdf.filename} onClose={() => setReadingPdf(null)} />}
            </div>
          )}
          {!isTemplate && <NoteConnections noteId={note.id} title={title} />}
        </div>
      </div>
      {/* Beside the text (under the toolbar) while writing a chapter. */}
      {panel && editor && (
        <SidePanel tab={panel} onTab={openPanel} onClose={() => setPanel(null)} editor={editor} note={note} title={title} method={method}
          writingStudy={writingStudy} flush={flush} readOnly={viewOnly} onOpenScripture={onOpenScripture}
          comments={sharing.threads.length || sharedWith.length ? { threads: sharing.threads, current: thread, setCurrent: setThread, reload: loadSharing } : null} />
      )}
      </div>

      {focus && (
        <div className="focus-bar">
          <span>{words.toLocaleString()}{chapterGoal ? ` of ${chapterGoal.toLocaleString()}` : ''} words</span>
          {chapterGoal > 0 && <span className="chapter-goal"><span style={{ width: `${Math.min(100, (words / chapterGoal) * 100)}%` }} /></span>}
          <span className="spacer" />
          {writingStudy && <button type="button" className="link-btn" onClick={toggleSources}>{showSources ? 'Hide sources' : 'Sources'}</button>}
          <button type="button" className="link-btn" onClick={toggleRevise}>{showRevise ? 'Hide Revise' : 'Revise'}</button>
          <button type="button" className="link-btn" onClick={() => setFocus(false)}>Leave focus (Esc)</button>
        </div>
      )}

      {uploading.length > 0 && (
        <div className="upload-status">
          {uploading.map((u) => (
            <div key={u.key} className="upload-row">
              <span>Uploading {u.name}</span>
              <progress max="1" value={u.progress} />
            </div>
          ))}
        </div>
      )}

      <input ref={fileInput} type="file" multiple hidden
        onChange={(e) => { uploadFiles([...e.target.files], null); e.target.value = ''; }} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { uploadFiles([...e.target.files], null); e.target.value = ''; }} />
    </div>
  );
}

// ---------- 7.1: lessons, sermons and Bible studies as pages ----------

export const WORK_LABEL = { lesson: 'Lesson', sermon: 'Sermon', study: 'Bible study' };
export const WORK_DEFAULT = { lesson: 'hblt', sermon: 'mcdill', study: 'ggw' };
/** What goes in each of a method's sections, shown in an empty one (in the method's section order). */
const WORK_PROMPTS = {
  hblt: ['How will you catch the class’s interest and lead them into the passage?', 'What does the passage say? The big idea and its points.',
    'Questions that help the class see what it means for them.', 'How will the class live this out this week?'],
  points: ['The one idea the lesson teaches.', 'The passage.', 'How you’ll open.', 'Your first point.', 'Your second point.', 'Your third point.',
    'How it applies this week.', 'Questions for the class.'],
  ggw: ['What did the text mean to its first readers?', 'What differs between their situation and ours?', 'What’s the timeless principle?',
    'Does the rest of Scripture teach the same principle?', 'How do Christians today live out the principle?', 'One line to remember.'],
  mcdill: ['Catch their attention and bring them to the text.', 'Bring the divisions together and call for a response.'],
  background: ['Who wrote it, and how do we know?', 'When and where was it written, and what was happening?', 'Who first read it, and why was it written to them then?',
    'Customs, politics and religion the first readers took for granted.', 'What kind of writing is it, and how is it put together?',
    'Why was it written, and what does it keep coming back to?', 'Where scholars differ: each view, who holds it, and why.', 'One line to remember.'],
  word: ['The English word, its verse, and why it matters.', 'The Hebrew or Greek behind it.', 'How translations render it here.',
    'The senses the word can carry.', 'How it’s used elsewhere, nearest first.', 'Which sense fits here, and why.', 'One line to remember.'],
};
export function workPrompt(method, heading, part) {
  if (!part) return 'Explain, illustrate, argue and apply this division.';
  const i = method.sections.findIndex((x) => x.match.test(heading));
  return (i >= 0 && WORK_PROMPTS[method.id]?.[i]) || 'Write this part.';
}

/** Under the title: the passage, a sermon's length, and how many sections are written, with a bar for each. */
export function WorkMeta({ parts, type, passage, words, onPassage }) {
  const done = parts.filter((p) => !p.empty).length;
  const n = parts.length;
  const noun = type === 'lesson' ? 'steps' : 'sections';
  const circ = 2 * Math.PI * 15;
  return (
    <div className="work-meta-wrap">
      <div className="work-meta">
        {passage && (onPassage
          ? <button type="button" className="link-btn work-passage" onClick={onPassage} title="Read it in the side panel">{passage}</button>
          : <span className="work-passage">{passage}</span>)}
        {type === 'sermon' && words > 0 && <span>About {Math.max(1, Math.round(words / 130))} minute{Math.round(words / 130) > 1 ? 's' : ''}</span>}
        {n > 0 && (
          <span className={`work-ready ${done === n ? 'is-done' : ''}`}>
            <svg width="16" height="16" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border)" strokeWidth="4" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={`${(done / n) * circ} ${circ}`} transform="rotate(-90 18 18)" strokeLinecap="round" />
            </svg>
            {done} of {n} {noun} written
          </span>
        )}
      </div>
      {n > 0 && (
        <div className="work-bars" style={{ gridTemplateColumns: `repeat(${Math.min(n, 12)}, minmax(0, 1fr))` }} aria-hidden="true">
          {parts.slice(0, 12).map((p, i) => <span key={i} className={p.empty ? '' : 'is-on'} title={p.title} />)}
        </div>
      )}
    </div>
  );
}
