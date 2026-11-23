import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';
import RichBox from './RichBox.jsx';
import { canShare } from '../mode.js';
import { openShare } from './SharingDialogs.jsx';
import { loadBrand } from '../slideLook.js';
import { bookSections, FONTS, lessonBookHtml, lessonBookParts, lessonParts, lessonPieces, PAGE_EDITIONS, printLessonBook, SIZES, TEXT_SIZES } from '../lessonBook.js';

const newKey = () => Math.random().toString(36).slice(2, 9);
const PAGE_KINDS = [
  { title: 'Welcome', html: '<p>Welcome to this study.</p>' },
  { title: 'How to use this book', html: '<p>Each lesson has …</p>' },
  { title: 'Prayer requests', html: '', lines: true },
  { title: 'Notes', html: '', lines: true },
  { title: 'Answer key', html: '', edition: 'teacher' },
  { title: '', html: '' },
];

/**
 * 14.5: the lesson book builder. A series' lessons (or sermons) made into a printed resource: cover, contents,
 * introduction, the lessons and pages you add (in any order, with page breaks), in a teacher guide and a student book.
 * The Bank tab gathers the book's lessons' points, questions and parts, plus pieces you write, to insert into a lesson
 * or page. Settings save as you go (server/curricula.js); the teacher guide is kept as the book's note.
 */
function CurriculumBuilder({ id, close }) {
  const dialog = useDialog();
  const [book, setBook] = useState(null);
  const [brand, setBrand] = useState({});
  const [edition, setEdition] = useState('teacher');
  const [tab, setTab] = useState('book');
  const [open, setOpen] = useState('cover'); // cover, layout, intro, or a section key
  const [target, setTarget] = useState(null); // where Bank inserts: a lesson or page section key
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [draftN, setDraftN] = useState(0);
  const [kind, setKind] = useState('all');
  const [dragging, setDragging] = useState(null);
  const timer = useRef(null);
  const latest = useRef(null);
  const brandRef = useRef({});

  useEffect(() => {
    api.curriculum(id).then(setBook).catch((e) => { dialog.toast(e.message, 'error'); close(); });
    loadBrand().then((b) => { brandRef.current = b; setBrand(b); }).catch(() => {});
  }, [id]);

  const save = async () => {
    clearTimeout(timer.current);
    timer.current = null;
    const b = latest.current;
    if (!b) return;
    try {
      await api.saveCurriculum(b.id, { data: b.data, html: lessonBookHtml(b, 'teacher', brandRef.current) });
      setSaved('Saved');
    } catch (e) { setSaved(''); dialog.toast(`Couldn’t save: ${e.message}`, 'error'); }
  };
  useEffect(() => () => { if (timer.current) save(); }, []);

  const change = (fn) => setBook((b) => {
    const next = { ...b, data: fn(b.data) };
    latest.current = next;
    setSaved('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 900);
    return next;
  });
  const set = (k, v) => change((d) => ({ ...d, [k]: v }));
  const setLesson = (lid, k, v) => change((d) => ({ ...d, lessons: { ...(d.lessons ?? {}), [lid]: { ...(d.lessons?.[lid] ?? {}), [k]: v } } }));
  const setPage = (key, k, v) => change((d) => ({ ...d, pages: { ...(d.pages ?? {}), [key]: { ...(d.pages?.[key] ?? {}), [k]: v } } }));

  const sections = useMemo(() => (book ? bookSections(book) : []), [book]);
  const pieces = useMemo(() => (book ? lessonPieces(book) : []), [book?.lessons]);
  const preview = useMemo(() => (book ? lessonBookHtml(book, edition, brand) : ''), [book, edition, brand]);
  if (!book) return <div className="cb"><p className="muted cb-loading">Opening the lesson book…</p></div>;
  const d = book.data;
  const keys = sections.map((s) => s.key);
  const included = sections.filter((s) => s.type === 'lesson' && !s.skip).length;

  // ---- sections: order, pages, breaks ----
  const setOrder = (list) => set('order', list);
  const move = (key, by) => {
    const list = [...keys];
    const i = list.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setOrder(list);
  };
  const dropOn = (key) => {
    if (!dragging || dragging === key) return;
    const list = keys.filter((k) => k !== dragging);
    list.splice(list.indexOf(key), 0, dragging);
    setOrder(list);
    setDragging(null);
  };
  const insertAfter = (newKeyStr) => {
    const list = [...keys];
    // After the section open now, else the one last opened, else at the end.
    const ref = list.includes(open) ? open : list.includes(target) ? target : null;
    const at = ref ? list.indexOf(ref) + 1 : list.length;
    list.splice(at, 0, newKeyStr);
    return list;
  };
  const addPage = (preset) => {
    const key = newKey();
    change((dd) => ({ ...dd, pages: { ...(dd.pages ?? {}), [key]: { title: preset.title, html: preset.html, edition: preset.edition ?? 'both', lines: !!preset.lines } }, order: insertAfter(`P:${key}`) }));
    setOpen(`P:${key}`);
    setTarget(`P:${key}`);
  };
  const addBreak = () => setOrder(insertAfter(`B:${newKey()}`));
  const removeSection = (key) => change((dd) => {
    const next = { ...dd, order: keys.filter((k) => k !== key) };
    if (key.startsWith('P:')) { const pages = { ...(dd.pages ?? {}) }; delete pages[key.slice(2)]; next.pages = pages; }
    return next;
  });

  // ---- the bank: insert a piece into the chosen lesson or page ----
  const targetSection = sections.find((s) => s.key === target && (s.type === 'page' || (s.type === 'lesson' && !s.skip)));
  const targetName = targetSection ? (targetSection.type === 'lesson' ? `Lesson ${targetSection.lesson.n}: ${targetSection.lesson.title}` : (targetSection.page.title || 'Untitled page')) : null;
  const insert = (html) => {
    if (!targetSection) { dialog.toast('Choose a lesson or page on the Book tab first: pieces go into the one you last opened.'); return; }
    if (targetSection.type === 'lesson') setLesson(targetSection.lesson.id, 'extra', `${targetSection.lesson.opts.extra ?? ''}${html}`);
    else setPage(targetSection.key.slice(2), 'html', `${targetSection.page.html ?? ''}${html}`);
    dialog.toast(`Added to ${targetName}`);
  };
  const addPiece = () => {
    if (!draft.replace(/<[^>]*>/g, '').trim()) return;
    set('bank', [{ key: newKey(), html: draft }, ...(d.bank ?? [])]);
    setDraft('');
    setDraftN((n) => n + 1); // a fresh box
  };
  const openSection = (key) => { setOpen(open === key ? null : key); if (key.startsWith('L:') || key.startsWith('P:')) setTarget(key); };

  // ---- output ----
  const finish = async () => { if (timer.current) await save(); close(); };
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
  const share = async () => {
    if (timer.current) await save();
    openShare(dialog, { kind: 'note', id: book.note_id, title: d.title || 'Lesson book' });
  };
  const remove = async () => {
    if (!(await dialog.confirm({ title: 'Delete this lesson book?', message: 'Its lessons stay as they are. The book’s note goes to the Trash.', okLabel: 'Delete', danger: true }))) return;
    await api.deleteCurriculum(book.id).catch(() => {});
    close();
  };
  const foot = d.footer ?? { number: true };

  const rowTools = (key, i) => (
    <span className="cb-row-tools">
      <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(key, -1)}><Icon name="chevronUp" size={14} /></button>
      <button type="button" className="icon-btn" aria-label="Move down" disabled={i === keys.length - 1} onClick={() => move(key, 1)}><Icon name="chevronDown" size={14} /></button>
    </span>
  );

  const lessonRow = (s, i) => {
    const l = s.lesson;
    const o = l.opts;
    const parts = lessonParts(l);
    const toggleSkipPart = (ed, name, on) => {
      const cur = new Set(o.parts?.[ed] ?? []);
      if (on) cur.delete(name); else cur.add(name);
      setLesson(l.id, 'parts', { ...(o.parts ?? {}), [ed]: [...cur] });
    };
    return (
      <>
        <div className="cb-row-head">
          <input type="checkbox" checked={!s.skip} aria-label={`Include ${l.title}`} onChange={(e) => setLesson(l.id, 'skip', !e.target.checked)} />
          <button type="button" className={`cb-sec ${open === s.key ? 'is-open' : ''}`} onClick={() => openSection(s.key)}>{s.skip ? '' : `${l.n}. `}{l.title}</button>
          {rowTools(s.key, i)}
        </div>
        {open === s.key && !s.skip && (
          <div className="cb-fields">
            {parts.length > 0 && (
              <fieldset className="cb-parts">
                <legend>Parts of the lesson</legend>
                <div className="cb-parts-grid">
                  <span />
                  <span className="muted">Teacher</span>
                  <span className="muted">Student</span>
                  {parts.map((p) => (
                    <PartRow key={p} name={p} teacher={!(o.parts?.teacher ?? []).includes(p)} student={!(o.parts?.student ?? []).includes(p)}
                      onTeacher={(on) => toggleSkipPart('teacher', p, on)} onStudent={(on) => toggleSkipPart('student', p, on)} />
                  ))}
                </div>
              </fieldset>
            )}
            <span className="cb-box-label">For the leader (teacher guide only)</span>
            <RichBox blanks html={o.leader ?? ''} onChange={(v) => setLesson(l.id, 'leader', v.html)} rows={3} label="For the leader" placeholder="Notes only the teacher guide shows: time, materials, answers to watch for…" />
            <span className="cb-box-label">Added material (both books, after the lesson)</span>
            <RichBox blanks headings html={o.extra ?? ''} onChange={(v) => setLesson(l.id, 'extra', v.html)} rows={3} label="Added material" placeholder="Points, readings, an activity… or insert pieces from the Bank tab." />
            <span className="cb-box-label">Discussion questions (both books)</span>
            <RichBox blanks html={o.questions ?? ''} onChange={(v) => setLesson(l.id, 'questions', v.html)} rows={3} label="Discussion questions" placeholder="Questions for both books; the student book leaves room to write." />
          </div>
        )}
      </>
    );
  };

  const pageRow = (s, i) => {
    const p = s.page;
    const pk = s.key.slice(2);
    return (
      <>
        <div className="cb-row-head">
          <span className="cb-row-icon"><Icon name="file" size={14} /></span>
          <button type="button" className={`cb-sec ${open === s.key ? 'is-open' : ''}`} onClick={() => openSection(s.key)}>{p.title || 'Untitled page'} <span className="muted cb-row-sub">{p.edition && p.edition !== 'both' ? PAGE_EDITIONS[p.edition] : 'Page'}</span></button>
          {rowTools(s.key, i)}
        </div>
        {open === s.key && (
          <div className="cb-fields">
            <label className="field">Title<input className="input" value={p.title ?? ''} onChange={(e) => setPage(pk, 'title', e.target.value)} /></label>
            <label className="field">In
              <select className="input" value={p.edition ?? 'both'} onChange={(e) => setPage(pk, 'edition', e.target.value)}>
                {Object.entries(PAGE_EDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <RichBox blanks headings html={p.html ?? ''} onChange={(v) => setPage(pk, 'html', v.html)} rows={5} label="Page" placeholder="Write the page, or insert pieces from the Bank tab." />
            <label className="check-row"><input type="checkbox" checked={!!p.lines} onChange={(e) => setPage(pk, 'lines', e.target.checked)} /><span>Lines to write on at the end</span></label>
            <button type="button" className="link-btn cb-delete" onClick={() => removeSection(s.key)}>Remove this page</button>
          </div>
        )}
      </>
    );
  };

  const breakRow = (s, i) => (
    <div className="cb-row-head cb-break-row">
      <span className="cb-break-line">Page break</span>
      {rowTools(s.key, i)}
      <button type="button" className="icon-btn" aria-label="Remove page break" onClick={() => removeSection(s.key)}><Icon name="x" size={14} /></button>
    </div>
  );

  const shownPieces = pieces.filter((p) => kind === 'all' || p.kind === kind);
  const byLesson = [...new Set(shownPieces.map((p) => p.from))];

  return (
    <div className="cb" role="dialog" aria-label="Lesson book">
      <header className="cb-bar">
        <button type="button" className="icon-btn" onClick={finish} aria-label="Close"><Icon name="chevronLeft" /></button>
        <div className="cb-name">
          <strong>{d.title || 'Lesson book'}</strong>
          <span className="muted">{book.study ? `From ${book.study.title}` : ''}{saved ? ` · ${saved}` : ''}</span>
        </div>
        <div className="cb-edition" role="tablist" aria-label="Edition">
          <button type="button" role="tab" aria-selected={edition === 'teacher'} className={edition === 'teacher' ? 'is-on' : ''} onClick={() => setEdition('teacher')}>Teacher guide</button>
          <button type="button" role="tab" aria-selected={edition === 'student'} className={edition === 'student' ? 'is-on' : ''} onClick={() => setEdition('student')}>Student book</button>
        </div>
        <div className="cb-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={() => printLessonBook(book, edition, brand)}><Icon name="file" size={14} /> Print or PDF</button>
          <button type="button" className="btn btn-small" onClick={word}>Word</button>
          <button type="button" className="btn btn-small" onClick={packageFile} title="A file another church can import into Selah to teach it">Package</button>
          {canShare() && book.note_id && <button type="button" className="btn btn-small" onClick={share}>Share…</button>}
        </div>
      </header>
      <div className="cb-main">
        <aside className="cb-side">
          <div className="cb-tabs" role="tablist" aria-label="Builder">
            <button type="button" role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'is-on' : ''} onClick={() => setTab('book')}>Book</button>
            <button type="button" role="tab" aria-selected={tab === 'bank'} className={tab === 'bank' ? 'is-on' : ''} onClick={() => setTab('bank')}>Bank <span className="muted">{pieces.length + (d.bank?.length ?? 0)}</span></button>
          </div>

          {tab === 'book' && (
            <>
              <button type="button" className={`cb-sec ${open === 'cover' ? 'is-open' : ''}`} onClick={() => setOpen(open === 'cover' ? null : 'cover')}>Cover</button>
              {open === 'cover' && (
                <div className="cb-fields">
                  <label className="field">Title<input className="input" value={d.title ?? ''} onChange={(e) => set('title', e.target.value)} /></label>
                  <label className="field">Subtitle<input className="input" value={d.subtitle ?? ''} onChange={(e) => set('subtitle', e.target.value)} /></label>
                  <label className="field">Written by<input className="input" value={d.author ?? ''} placeholder={brand.name ? `(with ${brand.name})` : ''} onChange={(e) => set('author', e.target.value)} /></label>
                </div>
              )}
              <button type="button" className={`cb-sec ${open === 'layout' ? 'is-open' : ''}`} onClick={() => setOpen(open === 'layout' ? null : 'layout')}>Page layout</button>
              {open === 'layout' && (
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
                  <label className="check-row"><input type="checkbox" checked={d.newPage !== false} onChange={(e) => set('newPage', e.target.checked)} /><span>Each lesson and page starts a new page<span className="muted">Or let them run on, and add page breaks where you want them.</span></span></label>
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
                  <label className="check-row"><input type="checkbox" checked={d.contents !== false} onChange={(e) => set('contents', e.target.checked)} /><span>Contents page</span></label>
                  <label className="check-row"><input type="checkbox" checked={!!d.copyPages} onChange={(e) => set('copyPages', e.target.checked)} /><span>Student pages to copy, at the back of the teacher guide</span></label>
                  <p className="muted cb-hint">Headers and footers show when printed. Marked words (the Blank button, or the highlighter in a lesson) print as blanks in the student book and answers in the teacher guide.</p>
                </div>
              )}
              <button type="button" className={`cb-sec ${open === 'intro' ? 'is-open' : ''}`} onClick={() => setOpen(open === 'intro' ? null : 'intro')}>Introduction</button>
              {open === 'intro' && (
                <div className="cb-fields">
                  <RichBox blanks headings html={d.intro ?? ''} onChange={(v) => set('intro', v.html)} rows={6} label="Introduction" placeholder="How to use this book, the series' aim, a word to the leader…" />
                </div>
              )}
              <h3 className="cb-group">Lessons and pages <span className="muted">{included} of {book.lessons.length} lessons</span></h3>
              {!book.lessons.length && <p className="muted cb-hint">This series has no lessons with notes yet. Add lessons to the series, then come back.</p>}
              <ul className="cb-sections">
                {sections.map((s, i) => (
                  <li key={s.key} className={`cb-row cb-row-${s.type} ${s.skip ? 'is-skipped' : ''} ${target === s.key ? 'is-target' : ''} ${dragging === s.key ? 'is-dragging' : ''}`}
                    draggable onDragStart={() => setDragging(s.key)} onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); dropOn(s.key); }}>
                    {s.type === 'lesson' ? lessonRow(s, i) : s.type === 'page' ? pageRow(s, i) : breakRow(s, i)}
                  </li>
                ))}
              </ul>
              <div className="cb-add">
                <select className="input" value="" aria-label="Add a page" onChange={(e) => { const p = PAGE_KINDS[Number(e.target.value)]; if (p) addPage(p); }}>
                  <option value="">+ Add a page…</option>
                  {PAGE_KINDS.map((p, i) => <option key={i} value={i}>{p.title || 'Blank page'}</option>)}
                </select>
                <button type="button" className="btn btn-small" onClick={addBreak}>+ Page break</button>
              </div>
              <p className="muted cb-hint">New pages and breaks go after the one you have open. Drag rows, or use the arrows, to change the order.</p>
              <button type="button" className="link-btn cb-delete" onClick={remove}>Delete this lesson book…</button>
            </>
          )}

          {tab === 'bank' && (
            <div className="cb-bank">
              <p className={`cb-target ${targetName ? '' : 'is-none'}`}>{targetName ? <>Inserting into <strong>{targetName}</strong></> : 'Open a lesson or page on the Book tab: pieces go into the one you last opened.'}</p>
              <h3 className="cb-group">This book’s pieces</h3>
              <RichBox key={draftN} blanks html="" onChange={(v) => setDraft(v.html)} rows={2} label="New piece" placeholder="Write a point, question, illustration or activity to keep in this book's bank…" />
              <button type="button" className="btn btn-small cb-bank-add" onClick={addPiece}>Add to bank</button>
              {(d.bank ?? []).map((p) => (
                <div key={p.key} className="cb-piece cb-piece-mine">
                  <div className="cb-piece-body" dangerouslySetInnerHTML={{ __html: p.html }} />
                  <div className="cb-piece-tools">
                    <button type="button" className="btn btn-small" onClick={() => insert(p.html)}>Insert</button>
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
              {!shownPieces.length && <p className="muted cb-hint">Nothing of that kind in this book’s lessons.</p>}
              {byLesson.map((from) => (
                <div key={from} className="cb-bank-group">
                  <h4>{from}</h4>
                  {shownPieces.filter((p) => p.from === from).map((p) => (
                    <div key={p.key} className={`cb-piece cb-piece-${p.kind}`}>
                      <span className="cb-piece-kind">{p.kind === 'part' ? 'Part' : p.kind === 'question' ? 'Question' : 'Point'}</span>
                      <span className="cb-piece-label">{p.label}</span>
                      <button type="button" className="btn btn-small" onClick={() => insert(p.html)}>Insert</button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </aside>
        <section className="cb-preview" aria-label="Preview">
          <div className={`cb-paper cb-paper-${d.size === 'half' ? 'half' : 'letter'}`} dangerouslySetInnerHTML={{ __html: preview }} />
        </section>
      </div>
    </div>
  );
}

function PartRow({ name, teacher, student, onTeacher, onStudent }) {
  return (
    <>
      <span className="cb-part-name">{name}</span>
      <input type="checkbox" checked={teacher} aria-label={`${name} in the teacher guide`} onChange={(e) => onTeacher(e.target.checked)} />
      <input type="checkbox" checked={student} aria-label={`${name} in the student book`} onChange={(e) => onStudent(e.target.checked)} />
    </>
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
