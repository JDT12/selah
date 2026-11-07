import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import ExportWordDialog from './ExportWordDialog.jsx';

const FORMATS = [
  ['word', 'Word', 'One document, each note starting on a new page, with footnotes and a bibliography.'],
  ['md', 'Markdown', 'A .md file per note with its tags and dates, attachments alongside. For other Markdown apps, or plain text that lasts.'],
  ['html', 'Web pages', 'A page per note and a contents page, readable in any browser, attachments alongside.'],
  ['enex', '.enex file', 'An .enex file per notebook with attachments inside. Apps that import .enex files, and Selah’s own import, read it back.'],
  ['selahnb', 'Selah notebook', 'One .selahnb file with the notes exactly as they are, tags and attachments. Import it into any Selah (Settings → Data & backup).'],
];
const ORDERS = [['created', 'Oldest first'], ['title', 'Title A–Z'], ['-created', 'Newest first']];
const sizeLabel = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/** The notes' html in an order, for Word: [{ title, html }]. */
async function partsOf(ids, order) {
  const list = typeof ids === 'function' ? await ids() : ids;
  const notes = await Promise.all(list.map((id) => api.getNote(id)));
  if (order === 'title') notes.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  else if (order === 'created') notes.sort((a, b) => a.created_at - b.created_at);
  else if (order === '-created') notes.sort((a, b) => b.created_at - a.created_at);
  return notes.map((n) => ({ title: n.title || 'Untitled', html: n.html }));
}

/**
 * Export notes: scope is { notes: [ids] } | { notebooks: [ids] } | { stack } | { tag } | { all: 1 }; title names it.
 * Word is offered for notes and single notebooks (word: { getParts } for the open note's unsaved text, or
 * { noteIds: [ids] or async () => ids } to fetch them). Markdown, web pages and .enex downloads are made on the server.
 */
export default function ExportDialog({ scope, title, word = null, close, dialog }) {
  const [format, setFormat] = useState(word ? 'word' : 'md');
  const [order, setOrder] = useState('created');
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.exportSummary(scope).then(setSummary).catch((e) => setError(e.message)); }, [scope]);
  const formats = FORMATS.filter(([k]) => k !== 'word' || word);
  // Several notes (a notebook or a selection) rather than one.
  const many = !!word && !word.getParts && (typeof word.noteIds === 'function' || word.noteIds.length > 1);

  const run = async (e) => {
    e.preventDefault();
    if (format === 'word') {
      const getParts = word.getParts ?? (() => partsOf(word.noteIds, order));
      close(true);
      await dialog.open((c) => <ExportWordDialog title={title} project={many} getParts={getParts} close={c} />);
      return;
    }
    // A plain link: the browser downloads it itself (with its own progress), however large.
    const a = document.createElement('a');
    a.href = api.exportUrl(format, scope);
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    dialog.toast(summary?.attachments > 20 || summary?.notes > 200 ? 'Export started; it may take a minute to download' : 'Export downloaded');
    close(true);
  };

  return (
    <form className="export-dialog" onSubmit={run}>
      <div className="dialog-header">
        <h2>{scope.all ? 'Export everything' : `Export “${title}”`}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted export-summary">
        {error ?? (summary
          ? `${plural(summary.notes, 'note')}${summary.notebooks > 1 ? ` in ${plural(summary.notebooks, 'notebook')}` : ''}`
            + (summary.attachments ? ` · ${plural(summary.attachments, 'attachment')} (${sizeLabel(summary.bytes)})` : '')
          : 'Counting…')}
      </p>
      <div className="export-formats" role="radiogroup" aria-label="Format">
        {formats.map(([k, label, hint]) => (
          <label key={k} className={`export-format ${format === k ? 'is-active' : ''}`}>
            <input type="radio" name="export-format" checked={format === k} onChange={() => setFormat(k)} />
            <span><strong>{label}</strong><span className="muted">{hint}</span></span>
          </label>
        ))}
      </div>
      {format === 'word' && many && (
        <label className="field export-order">Order
          <select className="input" value={order} onChange={(e) => setOrder(e.target.value)}>
            {ORDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      )}
      {summary?.tooBig && format !== 'word' && <p className="form-error">That’s more than 3.5 GB of attachments; export fewer notebooks at a time.</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={!!error || !summary || (summary.tooBig && format !== 'word')}>
          <Icon name="download" size={15} /> {format === 'word' ? 'Next…' : 'Export'}
        </button>
      </div>
    </form>
  );
}

/** Opens the export dialog (from any menu). */
export const openExport = (dialog, props) => dialog.open((close) => <ExportDialog {...props} dialog={dialog} close={close} />);
