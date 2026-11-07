import { useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { formatShortDate } from '../time.js';
import { deliveryHtml, hasDeliveryOrder, isSermonHtml } from '../sermonBoard.js';

const FORMATS = [
  ['pdf', 'PDF', 'Ready to print or read on a tablet. Looks the same everywhere.'],
  ['docx', 'Word', 'A .docx to keep editing, with real footnotes.'],
  ['rtf', 'Rich text', 'An .rtf that opens in Word, Pages, LibreOffice and WordPad.'],
];
const SIZES = [[12, 'Regular', '12 pt'], [14, 'Large', '14 pt'], [16, 'Pulpit', '16 pt']];
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(`noteapp.manuscript.${k}`)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`noteapp.manuscript.${k}`, JSON.stringify(v)); } catch { /* private window */ } };

/**
 * Export a lesson's or sermon's teaching manuscript (11.0) as PDF, Word or rich text: the note as teach and preaching
 * mode show it. A sermon can go out as a manuscript or an outline, in delivery order, color-coded; any of them in a
 * larger print for the pulpit. `view` starts it the way you were looking at it ({ outline, colors }).
 */
function ManuscriptExportDialog({ note, subtitle, view, close, dialog }) {
  const sermon = isSermonHtml(note.html);
  const ordered = sermon && hasDeliveryOrder(note.html);
  const [format, setFormat] = useState(() => pref('format', 'pdf'));
  const [size, setSize] = useState(() => pref('size', 12));
  const [outline, setOutline] = useState(view?.outline ?? false);
  const [colors, setColors] = useState(view?.colors ?? pref('colors', false));
  const [order, setOrder] = useState(true);
  const [withSub, setWithSub] = useState(true);
  const [busy, setBusy] = useState(false);
  const title = note.title || 'Untitled';

  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setPref('format', format);
    setPref('size', size);
    if (sermon) setPref('colors', colors);
    const html = sermon ? deliveryHtml(note.html, { order: ordered && order, color: colors, list: ordered && order && outline }) : note.html;
    const opts = { title, subtitle: withSub ? subtitle : '', size };
    try {
      const { download } = await import('../docx/word.js');
      const { fileName } = await import('../manuscript/model.js');
      let blob;
      if (format === 'pdf') blob = await (await import('../manuscript/pdf.js')).pdfDocument(html, opts);
      else if (format === 'rtf') blob = await (await import('../manuscript/rtf.js')).rtfDocument(html, opts);
      else blob = await (await import('../docx/word.js')).wordDocument([{ title, html }], { format: 'manuscript', ...opts });
      const name = fileName(title, format);
      download(blob, name);
      dialog.toast(`Saved “${name}” to your downloads`);
      close(true);
    } catch (err) {
      dialog.toast(`Couldn’t make the file: ${err.message}`, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="export-dialog ms-export" onSubmit={run}>
      <div className="dialog-header">
        <h2>Export the manuscript</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">“{title}”{subtitle ? ` · ${subtitle}` : ''}</p>
      <div className="export-formats" role="radiogroup" aria-label="Format">
        {FORMATS.map(([k, label, hint]) => (
          <label key={k} className={`export-format ${format === k ? 'is-active' : ''}`}>
            <input type="radio" name="ms-format" checked={format === k} onChange={() => setFormat(k)} />
            <span><strong>{label}</strong><span className="muted">{hint}</span></span>
          </label>
        ))}
      </div>
      <div className="ms-row">
        <span className="ms-label">Text size</span>
        <div className="segmented" role="radiogroup" aria-label="Text size">
          {SIZES.map(([v, l, pt]) => (
            <button key={v} type="button" role="radio" aria-checked={size === v} className={size === v ? 'is-active' : ''} onClick={() => setSize(v)} title={pt}>{l}</button>
          ))}
        </div>
      </div>
      {ordered && (
        <div className="ms-row">
          <span className="ms-label">Layout</span>
          <div className="segmented" role="radiogroup" aria-label="Layout">
            <button type="button" role="radio" aria-checked={!outline} className={!outline ? 'is-active' : ''} onClick={() => setOutline(false)}>Manuscript</button>
            <button type="button" role="radio" aria-checked={outline} className={outline ? 'is-active' : ''} onClick={() => { setOutline(true); setOrder(true); }}>Outline</button>
          </div>
        </div>
      )}
      {ordered && !outline && (
        <label className="check-row"><input type="checkbox" checked={order} onChange={(e) => setOrder(e.target.checked)} />
          <span><strong>Delivery order</strong><span className="muted">Each division’s blocks in the order you numbered them. Off: grouped under Explanation, Illustration and the rest.</span></span></label>
      )}
      {sermon && (
        <label className="check-row"><input type="checkbox" checked={colors} onChange={(e) => setColors(e.target.checked)} />
          <span><strong>Color-code the elements</strong><span className="muted">A colored bar beside Explanation, Illustration, Argumentation and Application, with their names.</span></span></label>
      )}
      {subtitle && (
        <label className="check-row"><input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} />
          <span><strong>Passage and date under the title</strong><span className="muted">{subtitle}</span></span></label>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}><Icon name="download" size={15} /> {busy ? 'Making it…' : `Export ${FORMATS.find(([k]) => k === format)[1]}`}</button>
      </div>
    </form>
  );
}

/** The line under the title: a sermon's passage and series, or a lesson's passage, course and date. */
async function subtitleOf(noteId) {
  const [sermon, lesson] = await Promise.all([api.noteSermon(noteId).catch(() => null), api.lesson(noteId).catch(() => null)]);
  if (sermon) return [sermon.passage, sermon.series].filter(Boolean).join(' · ');
  if (lesson?.item || lesson?.study) {
    const it = lesson.item ?? {};
    const week = it.week && lesson.study?.course ? `Week ${it.week}` : null;
    return [it.ref, lesson.study?.title, week, it.date && formatShortDate(it.date)].filter(Boolean).join(' · ');
  }
  return '';
}

/** Opens the export for a note (the saved note, or `note` when the caller has it). */
export async function exportManuscript(dialog, noteId, { note = null, view = null } = {}) {
  try {
    const [n, subtitle] = await Promise.all([note ?? api.getNote(noteId), subtitleOf(noteId)]);
    await dialog.open((close) => <ManuscriptExportDialog note={n} subtitle={subtitle} view={view} close={close} dialog={dialog} />);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}
