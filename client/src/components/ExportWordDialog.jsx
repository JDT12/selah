import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';

const FORMATS = [
  ['turabian', 'Turabian paper', 'Double-spaced Times New Roman, footnotes, a bibliography on its own page, page numbers and an optional title page.'],
  ['manuscript', 'Manuscript', 'Clean and single-spaced, with footnotes: for sermons, lessons and articles.'],
  ['plain', 'Plain', 'The note as written, in Word’s usual look.'],
];
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(`noteapp.word.${k}`)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`noteapp.word.${k}`, JSON.stringify(v)); } catch { /* private window */ } };
const today = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * Export to Word: pick a format each time; a Turabian paper can have a title page, whose details start empty.
 * getParts() gives [{ title, html }] (one note, or a project's chapters in order). Resolves true once downloaded.
 * A sermon can go out in its delivery order (the Arrange board's numbers) and with its elements color-coded.
 */
export default function ExportWordDialog({ title, getParts, project = false, heading, intro, defaultFormat = 'turabian', close }) {
  const dialog = useDialog();
  const [format, setFormat] = useState(defaultFormat);
  const [withTitlePage, setWithTitlePage] = useState(true);
  const [page, setPage] = useState({ title: title || '', subtitle: '', name: '', school: '', course: '', professor: '', date: '' });
  const [bibliography, setBibliography] = useState(true);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setPage({ ...page, [k]: e.target.value });
  // What the parts are (fetched once, here and for the export): a sermon, and whether it has delivery numbers.
  const partsRef = useRef(null);
  const parts = () => (partsRef.current ??= getParts());
  const [sermonKind, setSermonKind] = useState(null); // null | { ordered }
  const [ordered, setOrdered] = useState(true);
  const [colors, setColors] = useState(() => pref('colors', false));
  useEffect(() => {
    if (project) return;
    Promise.all([parts(), import('../sermonBoard.js')]).then(([list, { isSermonHtml, hasDeliveryOrder }]) => {
      if (list.some((p) => isSermonHtml(p.html))) setSermonKind({ ordered: list.some((p) => hasDeliveryOrder(p.html)) });
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const [{ wordDocument, fileName, download }, { deliveryHtml }, list] = await Promise.all([import('../docx/word.js'), import('../sermonBoard.js'), parts()]);
      if (sermonKind) setPref('colors', colors);
      const out = sermonKind ? list.map((p) => ({ ...p, html: deliveryHtml(p.html, { order: sermonKind.ordered && ordered, color: colors }) })) : list;
      const blob = await wordDocument(out, {
        format,
        title: page.title.trim() || title,
        chapterTitles: project,
        titlePage: format === 'turabian' && withTitlePage ? { ...page, title: page.title.trim() || title } : null,
        bibliography,
      });
      download(blob, fileName(page.title.trim() || title));
      dialog.toast(`Saved “${fileName(page.title.trim() || title)}” to your downloads`);
      close(true);
    } catch (err) {
      dialog.toast(`Couldn’t make the Word file: ${err.message}`, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="export-dialog" onSubmit={run}>
      <div className="dialog-header">
        <h2>{heading ?? (project ? 'Export the project to Word' : 'Export to Word')}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      {project && <p className="muted">{intro ?? 'All the chapters, in order, each starting on a new page, with footnotes numbered straight through and one bibliography.'}</p>}
      <div className="export-formats" role="radiogroup" aria-label="Format">
        {FORMATS.map(([k, label, hint]) => (
          <label key={k} className={`export-format ${format === k ? 'is-active' : ''}`}>
            <input type="radio" name="format" checked={format === k} onChange={() => setFormat(k)} />
            <span><strong>{label}</strong><span className="muted">{hint}</span></span>
          </label>
        ))}
      </div>
      {format === 'turabian' && (
        <>
          <label className="check-row"><input type="checkbox" checked={withTitlePage} onChange={(e) => setWithTitlePage(e.target.checked)} />
            <span><strong>Title page</strong><span className="muted">Leave out any line you don’t need.</span></span></label>
          {withTitlePage && (
            <div className="export-titlepage">
              <div className="field-row">
                <label className="field">Title<input className="input" value={page.title} onChange={set('title')} /></label>
                <label className="field">Subtitle<input className="input" value={page.subtitle} onChange={set('subtitle')} /></label>
              </div>
              <div className="field-row">
                <label className="field">Your name<input className="input" value={page.name} onChange={set('name')} /></label>
                <label className="field">School<input className="input" value={page.school} onChange={set('school')} /></label>
              </div>
              <div className="field-row">
                <label className="field">Course<input className="input" value={page.course} onChange={set('course')} placeholder="OBST 680: NT Development of OT Themes" /></label>
                <label className="field">Professor<input className="input" value={page.professor} onChange={set('professor')} /></label>
              </div>
              <label className="field"><span>Date <button type="button" className="link-btn" onClick={() => setPage({ ...page, date: today() })}>Today</button></span>
                <input className="input" value={page.date} onChange={set('date')} /></label>
            </div>
          )}
        </>
      )}
      {sermonKind?.ordered && (
        <label className="check-row"><input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
          <span><strong>Delivery order</strong><span className="muted">Each division’s blocks in the order you numbered them, as you’ll preach it. Off: grouped under Explanation, Illustration and the rest.</span></span></label>
      )}
      {sermonKind && (
        <label className="check-row"><input type="checkbox" checked={colors} onChange={(e) => setColors(e.target.checked)} />
          <span><strong>Color-code the elements</strong><span className="muted">A colored stripe beside Explanation, Illustration, Argumentation and Application.</span></span></label>
      )}
      <label className="check-row"><input type="checkbox" checked={bibliography} onChange={(e) => setBibliography(e.target.checked)} />
        <span><strong>Bibliography</strong><span className="muted">The sources you cited, at the end (when there are any).</span></span></label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}><Icon name="download" size={15} /> {busy ? 'Making it…' : 'Export'}</button>
      </div>
    </form>
  );
}
