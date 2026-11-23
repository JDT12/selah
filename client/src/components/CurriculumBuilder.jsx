import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { DOMSerializer } from '@tiptap/pm/model';
import { api, fileUrl } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';
import RichBox from './RichBox.jsx';
import Toolbar from '../editor/Toolbar.jsx';
import { buildExtensions } from '../editor/extensions.js';
import { BOOK_NODES } from '../editor/BookNodes.js';
import { canShare } from '../mode.js';
import { openShare } from './SharingDialogs.jsx';
import { loadBrand } from '../slideLook.js';
import { bookStyle, FONTS, lessonBlockHtml, lessonBookHtml, lessonBookParts, lessonPieces, PAGE_TEMPLATES, printLessonBook, SIZES, startingDoc, TEXT_SIZES } from '../lessonBook.js';

const newKey = () => Math.random().toString(36).slice(2, 9);

/**
 * 14.5: the lesson book builder. The book is edited on the page itself, like a note, with the note's toolbar; the
 * sidebar holds the book's own elements (new page, writing lines, Blank, Teacher only / Student only…), ready-made
 * pages, the series' lessons (copied in, with Update from lesson when a lesson has changed), the bank (the lessons'
 * parts, points and questions, and pieces you keep) and the page layout. Teacher guide and Student book show each
 * edition as it prints. Saves as you go (server/curricula.js); the teacher guide is kept as the book's note.
 */
function CurriculumBuilder({ id, close }) {
  const dialog = useDialog();
  const [book, setBook] = useState(null);
  useEffect(() => {
    api.curriculum(id).then(setBook).catch((e) => { dialog.toast(e.message, 'error'); close(); });
  }, [id]);
  if (!book) return <div className="cb"><p className="muted cb-loading">Opening the lesson book…</p></div>;
  return <BookEditor initial={book} close={close} />;
}

function BookEditor({ initial, close }) {
  const dialog = useDialog();
  const [book, setBook] = useState(() => ({ ...initial, data: { ...initial.data, doc: initial.data.doc ?? startingDoc(initial) } }));
  const [brand, setBrand] = useState({});
  const [view, setView] = useState('edit'); // edit, teacher, student
  const [tab, setTab] = useState('insert');
  const [saved, setSaved] = useState('');
  const [lines, setLines] = useState(4);
  const [kind, setKind] = useState('all');
  const [draft, setDraft] = useState('');
  const [draftN, setDraftN] = useState(0);
  const [, setTick] = useState(0); // the sidebar follows the cursor (Teacher only on/off…)
  const timer = useRef(null);
  const latest = useRef(book);
  const brandRef = useRef({});

  useEffect(() => { loadBrand().then((b) => { brandRef.current = b; setBrand(b); }).catch(() => {}); }, []);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    const b = latest.current;
    try {
      await api.saveCurriculum(b.id, { data: b.data, html: lessonBookHtml(b, 'teacher', brandRef.current) });
      setSaved('Saved');
    } catch (e) { setSaved(''); dialog.toast(`Couldn’t save: ${e.message}`, 'error'); }
  }, [dialog]);
  useEffect(() => () => { if (timer.current) save(); }, [save]);
  const change = useCallback((fn) => setBook((b) => {
    const next = { ...b, data: fn(b.data) };
    latest.current = next;
    setSaved('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 900);
    return next;
  }), [save]);
  const set = (k, v) => change((d) => ({ ...d, [k]: v }));

  // Pictures go to the book's note, as in any note.
  const editorRef = useRef(null);
  const upload = useCallback(async (files, pos) => {
    const editor = editorRef.current;
    if (!editor || !initial.note_id) return;
    for (const file of files) {
      try {
        const a = await api.upload(initial.note_id, file, () => {});
        const node = a.mime.startsWith('image/') && a.mime !== 'image/svg+xml'
          ? { type: 'image', attrs: { src: fileUrl(a.id), alt: a.filename } }
          : { type: 'attachment', attrs: { id: a.id, filename: a.filename, mime: a.mime, size: a.size } };
        if (pos != null) { editor.chain().focus().insertContentAt(pos, node).run(); pos = null; } else editor.chain().focus().insertContent(node).run();
      } catch (e) { dialog.toast(`${file.name}: ${e.message}`, 'error'); }
    }
  }, [initial.note_id, dialog]);
  const extensions = useMemo(() => [...buildExtensions({ onFiles: (f, p) => upload(f, p) }), ...BOOK_NODES], [upload]);
  const editor = useEditor({
    extensions,
    content: book.data.doc,
    editorProps: { attributes: { class: 'note-body lb-edit', 'aria-label': 'The lesson book' } },
    onUpdate: ({ editor: e }) => change((d) => ({ ...d, doc: e.getHTML() })),
    onSelectionUpdate: () => setTick((t) => t + 1),
  });
  useEffect(() => { editorRef.current = editor; }, [editor]);

  const d = book.data;
  const pieces = useMemo(() => lessonPieces(book), [book.lessons]);
  const preview = useMemo(() => (view === 'edit' ? '' : lessonBookHtml(book, view, brand)), [book, view, brand]);
  const headings = useMemo(() => {
    const doc = new DOMParser().parseFromString(`<body>${d.doc}</body>`, 'text/html');
    return [...doc.querySelectorAll('h1')].map((h) => h.textContent.trim()).filter(Boolean);
  }, [d.doc]);
  const inBook = useMemo(() => {
    const m = new Map();
    const doc = new DOMParser().parseFromString(`<body>${d.doc}</body>`, 'text/html');
    for (const s of doc.querySelectorAll('section[data-lesson]')) m.set(Number(s.getAttribute('data-lesson')), Number(s.getAttribute('data-synced')) || 0);
    return m;
  }, [d.doc]);

  // ---- inserting ----
  const run = (fn) => { if (!editor) return; fn(editor.chain().focus()).run(); };
  const insertHtml = (html) => run((c) => c.insertContent(html));
  // A block to type in (a leader note, questions): the cursor goes into its empty last paragraph, `depth` closing
  // tags back from the end of what went in.
  const insertInto = (html, depth) => {
    if (!editor) return;
    const start = editor.state.selection.from;
    editor.chain().focus().insertContent(html).run();
    const end = editor.state.selection.from;
    const doc = editor.state.doc;
    let at = null;
    doc.nodesBetween(Math.min(start, end), Math.min(doc.content.size, Math.max(start, end) + depth), (node, pos) => { if (node.isTextblock && node.content.size === 0) at = pos + 1; });
    if (at != null) editor.commands.setTextSelection(at);
  };
  // Pages, page breaks and lessons go between the book's top blocks, after the one the cursor is in (not inside a box
  // or a list); the cursor then follows what went in.
  const insertTop = (content) => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    const pos = $from.depth > 0 ? $from.after(1) : editor.state.selection.to;
    editor.chain().focus().insertContentAt(pos, content).run();
  };
  // A writing-lines block or page break selected after it goes in would be replaced by the next insert: an empty
  // paragraph after it takes the cursor.
  const insertAtom = (node, top = false) => (top ? insertTop([node, { type: 'paragraph' }]) : run((c) => c.insertContent([node, { type: 'paragraph' }])));
  const inEdition = (ed) => editor?.isActive('editionBlock', { edition: ed });
  const toggleEdition = (ed) => {
    if (!editor) return;
    if (inEdition(ed)) run((c) => c.lift('editionBlock'));
    else if (editor.isActive('editionBlock')) run((c) => c.updateAttributes('editionBlock', { edition: ed }));
    else run((c) => c.wrapIn('editionBlock', { edition: ed }));
  };
  const insertLesson = (l) => {
    const n = inBook.size + 1;
    insertTop(`<div data-page-break></div>${lessonBlockHtml(l, n)}`);
    setView('edit');
  };
  const updateLesson = async (l) => {
    if (!editor) return;
    if (!(await dialog.confirm({ title: `Update “${l.title}” from the lesson?`, message: 'The lesson’s text in the book is replaced with the lesson as it is now. What you changed or added inside it in the book is replaced too (Undo brings it back).', okLabel: 'Update' }))) return;
    let at = null;
    editor.state.doc.descendants((node, pos) => {
      if (at == null && node.type.name === 'lessonBlock' && node.attrs.lesson === l.id) { at = { from: pos, to: pos + node.nodeSize, n: (/^Lesson (\d+):/.exec(node.firstChild?.textContent ?? '') ?? [])[1] }; return false; }
      return at == null;
    });
    if (!at) return;
    editor.chain().focus().insertContentAt({ from: at.from, to: at.to }, lessonBlockHtml(l, Number(at.n) || null)).run();
    dialog.toast(`Updated “${l.title}”`);
  };
  const goTo = (lessonId) => {
    const el = document.querySelector(`.lb-edit section[data-lesson="${lessonId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const addToBank = (html) => {
    if (!html || !html.replace(/<[^>]*>/g, '').trim()) return;
    set('bank', [{ key: newKey(), html }, ...(d.bank ?? [])]);
  };
  const selectionHtml = () => {
    if (!editor || editor.state.selection.empty) return '';
    const div = document.createElement('div');
    div.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.selection.content().content));
    return div.innerHTML;
  };
  const drag = (html) => (e) => { e.dataTransfer.setData('text/html', html); e.dataTransfer.setData('text/plain', html.replace(/<[^>]*>/g, ' ')); e.dataTransfer.effectAllowed = 'copy'; };

  // ---- output ----
  const finish = async () => { if (timer.current) await save(); close(); };
  const edition = view === 'student' ? 'student' : 'teacher';
  const word = async () => {
    try {
      const { wordDocument, download, fileName } = await import('../docx/word.js');
      const blob = await wordDocument(lessonBookParts(book, edition), { format: 'plain', title: d.title || 'Lesson book', subtitle: [d.subtitle, edition === 'student' ? 'Student book' : 'Teacher guide'].filter(Boolean).join(' · '), chapterTitles: true, bibliography: false });
      download(blob, fileName(`${d.title || 'Lesson book'} (${edition === 'student' ? 'student book' : 'teacher guide'})`));
    } catch (e) { dialog.toast(`Couldn’t make the Word file: ${e.message}`, 'error'); }
  };
  const packageFile = async () => {
    if (timer.current) await save();
    const a = document.createElement('a');
    a.href = `/api/curricula/${book.id}/package`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  };
  const share = async () => { if (timer.current) await save(); openShare(dialog, { kind: 'note', id: book.note_id, title: d.title || 'Lesson book' }); };
  const remove = async () => {
    if (!(await dialog.confirm({ title: 'Delete this lesson book?', message: 'Its lessons stay as they are. The book’s note goes to the Trash.', okLabel: 'Delete', danger: true }))) return;
    clearTimeout(timer.current);
    timer.current = null;
    await api.deleteCurriculum(book.id).catch(() => {});
    close();
  };
  const foot = d.footer ?? { number: true };
  const shownPieces = pieces.filter((p) => kind === 'all' || p.kind === kind);
  const tool = (label, icon, onClick, opts = {}) => (
    <button type="button" className={`cb-tool ${opts.active ? 'is-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={opts.title ?? label} aria-pressed={opts.active ?? undefined}>
      <Icon name={icon} size={15} /><span>{label}</span>
    </button>
  );

  return (
    <div className="cb" role="dialog" aria-label="Lesson book">
      <header className="cb-bar">
        <button type="button" className="icon-btn" onClick={finish} aria-label="Close"><Icon name="chevronLeft" /></button>
        <div className="cb-name">
          <strong>{d.title || 'Lesson book'}</strong>
          <span className="muted">{book.study ? `From ${book.study.title}` : ''}{saved ? ` · ${saved}` : ''}</span>
        </div>
        <div className="cb-edition" role="tablist" aria-label="View">
          {[['edit', 'Edit'], ['teacher', 'Teacher guide'], ['student', 'Student book']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-on' : ''} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        <div className="cb-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={() => printLessonBook(book, edition, brand)} title={`Prints the ${edition === 'student' ? 'student book' : 'teacher guide'}`}><Icon name="file" size={14} /> Print or PDF</button>
          <button type="button" className="btn btn-small" onClick={word}>Word</button>
          <button type="button" className="btn btn-small" onClick={packageFile} title="A file another church can import into Selah to teach it">Package</button>
          {canShare() && book.note_id && <button type="button" className="btn btn-small" onClick={share}>Share…</button>}
        </div>
      </header>
      <div className="cb-main">
        <aside className="cb-side">
          <div className="cb-tabs" role="tablist" aria-label="Builder">
            {[['insert', 'Insert'], ['lessons', 'Lessons'], ['bank', 'Bank'], ['layout', 'Layout']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === 'insert' && (
            <div className="cb-panel">
              <p className="muted cb-hint">Elements go where the cursor is in the book.</p>
              <h3 className="cb-group">Book</h3>
              <div className="cb-tools">
                {tool('New page', 'file', () => insertAtom({ type: 'pageBreak' }, true))}
                {tool('Blank', 'highlight', () => run((c) => c.toggleHighlight()), { active: editor?.isActive('highlight'), title: 'Marked words are blanks in the student book and answers in the teacher guide' })}
                {tool('Teacher only', 'lectern', () => toggleEdition('teacher'), { active: inEdition('teacher'), title: 'The selected blocks print only in the teacher guide' })}
                {tool('Student only', 'users', () => toggleEdition('student'), { active: inEdition('student'), title: 'The selected blocks print only in the student book' })}
                {tool('Leader note', 'comment', () => insertInto('<div data-edition="teacher"><h3>For the leader</h3><p></p></div>', 2))}
                {tool('Discussion questions', 'list', () => insertInto('<h3>Discussion questions</h3><ol><li><p></p></li></ol>', 3))}
                {tool('Answer box', 'todo', () => insertAtom({ type: 'writingLines', attrs: { count: 3, kind: 'box' } }))}
              </div>
              <div className="cb-lines">
                <button type="button" className="cb-tool" onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtom({ type: 'writingLines', attrs: { count: lines, kind: 'lines' } })}><Icon name="hr" size={15} /><span>Writing lines</span></button>
                <label className="cb-lines-n"><input className="input" type="number" min="1" max="30" value={lines} onChange={(e) => setLines(Math.min(30, Math.max(1, Number(e.target.value) || 1)))} aria-label="How many lines" /> lines</label>
              </div>
              <h3 className="cb-group">Ready-made pages</h3>
              <div className="cb-tools">
                {PAGE_TEMPLATES.map((p) => <button key={p.label} type="button" className="cb-tool" onMouseDown={(e) => e.preventDefault()} onClick={() => insertTop(`<div data-page-break></div>${p.html}`)} draggable onDragStart={drag(`<div data-page-break></div>${p.html}`)}><Icon name="note" size={15} /><span>{p.label}</span></button>)}
              </div>
              <p className="muted cb-hint">Headings, lists, tables, callouts, pictures, quotes and Scripture are on the toolbar above the book (and / in the book).</p>
            </div>
          )}

          {tab === 'lessons' && (
            <div className="cb-panel">
              <p className="muted cb-hint">A lesson is copied into the book, where you can change it. When the lesson changes, Update brings the book up to date.</p>
              {!book.lessons.length && <p className="muted cb-hint">This series has no lessons with notes yet.</p>}
              {book.lessons.map((l) => {
                const synced = inBook.get(l.id);
                const here = synced != null;
                const changed = here && Number(l.updated_at) > synced;
                return (
                  <div key={l.id} className={`cb-lesson-item ${here ? 'is-in' : ''}`}>
                    <div className="cb-lesson-title"><strong>{l.title}</strong><span className="muted">{here ? (changed ? 'Changed since it was copied' : 'In the book') : 'Not in the book'}</span></div>
                    <div className="cb-lesson-tools">
                      {here && <button type="button" className="btn btn-small" onClick={() => goTo(l.id)}>Go to</button>}
                      {changed && <button type="button" className="btn btn-small btn-primary" onClick={() => updateLesson(l)}>Update from lesson</button>}
                      {!here && <button type="button" className="btn btn-small" onClick={() => insertLesson(l)} draggable onDragStart={drag(`<div data-page-break></div>${lessonBlockHtml(l, inBook.size + 1)}`)}>Insert</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'bank' && (
            <div className="cb-panel cb-bank">
              <p className="muted cb-hint">Insert puts a piece at the cursor; you can also drag one into the book.</p>
              <h3 className="cb-group">This book’s pieces</h3>
              <RichBox key={draftN} blanks html="" onChange={(v) => setDraft(v.html)} rows={2} label="New piece" placeholder="Write a point, question, illustration or activity to keep…" />
              <div className="cb-bank-buttons">
                <button type="button" className="btn btn-small" onClick={() => { addToBank(draft); setDraft(''); setDraftN((n) => n + 1); }}>Add to bank</button>
                <button type="button" className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => { const h = selectionHtml(); if (h) addToBank(h); else dialog.toast('Select something in the book first.'); }}>Keep the selection</button>
              </div>
              {(d.bank ?? []).map((p) => (
                <div key={p.key} className="cb-piece cb-piece-mine" draggable onDragStart={drag(p.html)}>
                  <div className="cb-piece-body" dangerouslySetInnerHTML={{ __html: p.html }} />
                  <div className="cb-piece-tools">
                    <button type="button" className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => insertHtml(p.html)}>Insert</button>
                    <button type="button" className="icon-btn" aria-label="Remove from the bank" onClick={() => set('bank', d.bank.filter((x) => x.key !== p.key))}><Icon name="x" size={14} /></button>
                  </div>
                </div>
              ))}
              <h3 className="cb-group">From the lessons
                <select className="input cb-kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Show">
                  <option value="all">All</option>
                  <option value="point">Points</option>
                  <option value="question">Questions</option>
                  <option value="part">Whole parts</option>
                </select>
              </h3>
              {[...new Set(shownPieces.map((p) => p.from))].map((from) => (
                <div key={from} className="cb-bank-group">
                  <h4>{from}</h4>
                  {shownPieces.filter((p) => p.from === from).map((p) => (
                    <div key={p.key} className={`cb-piece cb-piece-${p.kind}`} draggable onDragStart={drag(p.html)}>
                      <span className="cb-piece-kind">{p.kind === 'part' ? 'Part' : p.kind === 'question' ? 'Question' : 'Point'}</span>
                      <span className="cb-piece-label">{p.label}</span>
                      <button type="button" className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => insertHtml(p.html)}>Insert</button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === 'layout' && (
            <div className="cb-panel">
              <div className="cb-fields">
                <label className="field">Page size
                  <select className="input" value={d.size === 'half' ? 'half' : 'letter'} onChange={(e) => set('size', e.target.value)}>
                    {Object.entries(SIZES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                  </select>
                </label>
                <div className="cb-two">
                  <label className="field">Font
                    <select className="input" value={FONTS[d.font] ? d.font : 'serif'} onChange={(e) => set('font', e.target.value)}>
                      {Object.entries(FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
                    </select>
                  </label>
                  <label className="field">Text size
                    <select className="input" value={TEXT_SIZES.includes(Number(d.textSize)) ? d.textSize : ''} onChange={(e) => set('textSize', e.target.value ? Number(e.target.value) : null)}>
                      <option value="">Usual</option>
                      {TEXT_SIZES.map((n) => <option key={n} value={n}>{n} pt</option>)}
                    </select>
                  </label>
                </div>
                <label className="field">Header
                  <select className="input" value={d.header === 'title' ? 'title' : 'none'} onChange={(e) => set('header', e.target.value)}>
                    <option value="none">None</option>
                    <option value="title">The book’s title</option>
                  </select>
                </label>
                <fieldset className="cb-foot">
                  <legend>Footer</legend>
                  <label className="check-row"><input type="checkbox" checked={foot.number !== false} onChange={(e) => set('footer', { ...foot, number: e.target.checked })} /><span>Page numbers</span></label>
                  <label className="check-row"><input type="checkbox" checked={!!foot.church} onChange={(e) => set('footer', { ...foot, church: e.target.checked })} /><span>Church name{brand.name ? ` (${brand.name})` : ''}</span></label>
                  <label className="check-row"><input type="checkbox" checked={!!foot.edition} onChange={(e) => set('footer', { ...foot, edition: e.target.checked })} /><span>Which book (Teacher guide, Student book)</span></label>
                </fieldset>
                <label className="check-row"><input type="checkbox" checked={d.contents !== false} onChange={(e) => set('contents', e.target.checked)} /><span>Contents page<span className="muted">Lists each Heading 1 in the book.</span></span></label>
                <label className="check-row"><input type="checkbox" checked={!!d.copyPages} onChange={(e) => set('copyPages', e.target.checked)} /><span>Student pages to copy, at the back of the teacher guide</span></label>
                <p className="muted cb-hint">The header and footer show when printed.</p>
              </div>
              <button type="button" className="link-btn cb-delete" onClick={remove}>Delete this lesson book…</button>
            </div>
          )}
        </aside>

        <section className="cb-preview" aria-label={view === 'edit' ? 'The book' : 'Preview'}>
          {view === 'edit' ? (
            <>
              {editor && <div className="cb-toolbar"><Toolbar editor={editor} /></div>}
              <div className={`cb-paper cb-paper-${d.size === 'half' ? 'half' : 'letter'}`}>
                <div className="lesson-book lb-editing" style={Object.fromEntries(bookStyle(book, brand).split(';').map((p) => [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)]))}>
                  <section className="lb-cover lb-cover-edit">
                    {brand.logo ? <img className="lb-logo" src={`/api/files/${Number(brand.logo)}`} alt="" /> : null}
                    <input className="lb-title lb-cover-input" value={d.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="Title" aria-label="Title" />
                    <input className="lb-subtitle lb-cover-input" value={d.subtitle ?? ''} onChange={(e) => set('subtitle', e.target.value)} placeholder="Subtitle" aria-label="Subtitle" />
                    <p className="lb-edition">Teacher guide · Student book</p>
                    <input className="lb-by lb-cover-input" value={d.author ?? ''} onChange={(e) => set('author', e.target.value)} placeholder={brand.name ? `Written by (shown with ${brand.name})` : 'Written by'} aria-label="Written by" />
                  </section>
                  {d.contents !== false && (
                    <section className="lb-contents lb-contents-auto">
                      <h2>Contents <span className="muted">made from the book’s headings</span></h2>
                      <ol>{headings.map((h, i) => <li key={i}>{h}</li>)}</ol>
                    </section>
                  )}
                  <EditorContent editor={editor} />
                </div>
              </div>
            </>
          ) : (
            <div className={`cb-paper cb-paper-${d.size === 'half' ? 'half' : 'letter'}`} dangerouslySetInnerHTML={{ __html: preview }} />
          )}
        </section>
      </div>
    </div>
  );
}

/** Opens a series' lesson book: its latest, or a new one. */
export async function openLessonBook(dialog, study) {
  try {
    const have = await api.curricula(study.id);
    const id = have[0]?.id ?? (await api.createCurriculum({ study_id: study.id, title: study.title })).id;
    await dialog.open((close) => <CurriculumBuilder id={id} close={close} />, { dismissable: false });
  } catch (e) { dialog.toast(e.message, 'error'); }
}

/** Imports a .selahbook file: a new series with its lessons, and the book, which then opens. */
export async function importLessonBook(dialog, onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.selahbook,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const pkg = JSON.parse(await file.text());
      const made = await api.importCurriculum(pkg);
      onDone?.(made.study_id);
      dialog.toast(`Imported “${made.data.title || 'Lesson book'}” as a new series with ${made.lessons.length} ${made.lessons.length === 1 ? 'lesson' : 'lessons'}.`);
      await dialog.open((close) => <CurriculumBuilder id={made.id} close={close} />, { dismissable: false });
    } catch (e) { dialog.toast(e instanceof SyntaxError ? 'That file isn’t a Selah lesson book.' : e.message, 'error'); }
  };
  input.click();
}

export default CurriculumBuilder;
