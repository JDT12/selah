import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';
import RichBox from './RichBox.jsx';
import { canShare } from '../mode.js';
import { openShare } from './SharingDialogs.jsx';
import { loadBrand } from '../slideLook.js';
import { bookLessons, lessonBookHtml, lessonBookParts, printLessonBook, SIZES } from '../lessonBook.js';

/**
 * 14.5: the lesson book builder. A series' lessons (or sermons) made into a printed resource: cover, contents,
 * introduction, a section per lesson, in a teacher guide and a student book. Settings save as you go
 * (server/curricula.js); the teacher guide is kept as the book's note, so it can be shared like a note.
 */
function CurriculumBuilder({ id, close }) {
  const dialog = useDialog();
  const [book, setBook] = useState(null);
  const [brand, setBrand] = useState({});
  const [edition, setEdition] = useState('teacher');
  const [open, setOpen] = useState('cover'); // the section being edited: cover, intro, or a lesson's note id
  const [saved, setSaved] = useState('');
  const timer = useRef(null);
  const latest = useRef(null);

  useEffect(() => {
    api.curriculum(id).then(setBook).catch((e) => { dialog.toast(e.message, 'error'); close(); });
    loadBrand().then(setBrand).catch(() => {});
  }, [id]);

  const save = async () => {
    clearTimeout(timer.current);
    timer.current = null;
    const b = latest.current;
    if (!b) return;
    try {
      await api.saveCurriculum(b.id, { data: b.data, html: lessonBookHtml(b, 'teacher', brand) });
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

  const preview = useMemo(() => (book ? lessonBookHtml(book, edition, brand) : ''), [book, edition, brand]);
  if (!book) return <div className="cb"><p className="muted cb-loading">Opening the lesson book…</p></div>;
  const d = book.data;
  const included = bookLessons(book).length;

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

  return (
    <div className="cb" role="dialog" aria-label="Lesson book">
      <header className="cb-bar">
        <button type="button" className="icon-btn" onClick={finish} aria-label="Close"><Icon name="chevronLeft" /></button>
        <div className="cb-name">
          <strong>{d.title || 'Lesson book'}</strong>
          <span className="muted">{book.study ? `From ${book.study.title}` : ''}{saved ? ` · ${saved}` : ''}</span>
        </div>
        <div className="seg cb-edition" role="tablist" aria-label="Edition">
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
          <button type="button" className={`cb-sec ${open === 'cover' ? 'is-open' : ''}`} onClick={() => setOpen('cover')}>Cover and pages</button>
          {open === 'cover' && (
            <div className="cb-fields">
              <label className="field">Title<input className="input" value={d.title ?? ''} onChange={(e) => set('title', e.target.value)} /></label>
              <label className="field">Subtitle<input className="input" value={d.subtitle ?? ''} onChange={(e) => set('subtitle', e.target.value)} /></label>
              <label className="field">Written by<input className="input" value={d.author ?? ''} placeholder={brand.name ? `(with ${brand.name})` : ''} onChange={(e) => set('author', e.target.value)} /></label>
              <label className="field">Page size
                <select className="input" value={d.size === 'half' ? 'half' : 'letter'} onChange={(e) => set('size', e.target.value)}>
                  {Object.entries(SIZES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                </select>
              </label>
              <label className="check-row"><input type="checkbox" checked={d.contents !== false} onChange={(e) => set('contents', e.target.checked)} /><span>Contents page</span></label>
              <label className="check-row"><input type="checkbox" checked={!!d.copyPages} onChange={(e) => set('copyPages', e.target.checked)} /><span>Student pages to copy, at the back of the teacher guide</span></label>
              <p className="muted cb-hint">Highlighted words in a lesson become blanks in the student book and answers in the teacher guide. Questions ending in “?” get room to write.</p>
            </div>
          )}
          <button type="button" className={`cb-sec ${open === 'intro' ? 'is-open' : ''}`} onClick={() => setOpen('intro')}>Introduction</button>
          {open === 'intro' && (
            <div className="cb-fields">
              <RichBox html={d.intro ?? ''} onChange={(v) => set('intro', v.html)} rows={6} label="Introduction" placeholder="How to use this book, the series' aim, a word to the leader…" />
            </div>
          )}
          <h3 className="cb-group">Lessons <span className="muted">{included} of {book.lessons.length}</span></h3>
          {!book.lessons.length && <p className="muted cb-hint">This series has no lessons with notes yet. Add lessons to the series, then come back.</p>}
          {book.lessons.map((l, i) => {
            const o = d.lessons?.[l.id] ?? {};
            return (
              <div key={l.id} className={`cb-lesson-row ${o.skip ? 'is-skipped' : ''}`}>
                <div className="cb-lesson-head">
                  <input type="checkbox" checked={!o.skip} aria-label={`Include ${l.title}`} onChange={(e) => setLesson(l.id, 'skip', !e.target.checked)} />
                  <button type="button" className={`cb-sec ${open === l.id ? 'is-open' : ''}`} onClick={() => setOpen(open === l.id ? null : l.id)}>{i + 1}. {l.title}</button>
                </div>
                {open === l.id && !o.skip && (
                  <div className="cb-fields">
                    <span className="cb-box-label">For the leader (teacher guide only)</span>
                    <RichBox html={o.leader ?? ''} onChange={(v) => setLesson(l.id, 'leader', v.html)} rows={3} label="For the leader" placeholder="Notes only the teacher guide shows: time, materials, answers to watch for…" />
                    <span className="cb-box-label">Discussion questions (both books)</span>
                    <RichBox html={o.questions ?? ''} onChange={(v) => setLesson(l.id, 'questions', v.html)} rows={3} label="Discussion questions" placeholder="Questions for both books; the student book leaves room to write." />
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="link-btn cb-delete" onClick={remove}>Delete this lesson book…</button>
        </aside>
        <section className="cb-preview" aria-label="Preview">
          <div className={`cb-paper cb-paper-${d.size === 'half' ? 'half' : 'letter'}`} dangerouslySetInnerHTML={{ __html: preview }} />
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
