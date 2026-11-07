import { useState } from 'react';
import { api, formatSize } from '../api.js';

export default function ImportDialog({ tree, close }) {
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState('perFile');
  // 10.1: everything lands in My notes; "per file" tags the notes with the file's name.
  const notebook = tree.myNotes ?? tree.notebooks[0]?.id;
  const stack = '';
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const start = async () => {
    setError(null);
    setProgress(0);
    try {
      const r = await api.importEnex(files, mode === 'into' ? { mode, notebook } : { mode, stack }, setProgress);
      setResults(r.results);
    } catch (e) {
      setError(e.message);
    } finally {
      setProgress(null);
    }
  };

  if (results) {
    const total = results.reduce((n, r) => n + r.notes, 0);
    return (
      <div className="import-dialog">
        <h2>Import complete</h2>
        <p className="modal-message">Imported {total} note{total === 1 ? '' : 's'}.</p>
        <ul className="import-results">
          {results.map((r) => (
            <li key={r.file}>
              <strong>{r.file}</strong>: {r.notes} notes, {r.attachments} attachments
              {r.errors.length > 0 && (
                <details>
                  <summary>{r.errors.length} warning{r.errors.length === 1 ? '' : 's'}</summary>
                  <ul>{r.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>
                </details>
              )}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => close(true)}>Done</button>
        </div>
      </div>
    );
  }

  const busy = progress !== null;
  return (
    <div className="import-dialog">
      <h2>Import .enex files</h2>
      <p className="modal-message">
        In the app you’re coming from, export a notebook (or selected notes) as an <strong>.enex</strong> file.
        Attachments, PDFs, images, tags, to-do lists and dates are preserved.
      </p>

      <label className="file-drop">
        <input type="file" accept=".enex" multiple disabled={busy} onChange={(e) => setFiles([...e.target.files])} />
        {files.length
          ? `${files.length} file${files.length === 1 ? '' : 's'} selected (${formatSize(files.reduce((n, f) => n + f.size, 0))})`
          : 'Choose .enex files…'}
      </label>

      <div className="choice-list">
        <label className={`choice ${mode === 'perFile' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'perFile'} onChange={() => setMode('perFile')} disabled={busy} />
          Tag each file’s notes with the file’s name (a notebook stays together that way)
        </label>
        <label className={`choice ${mode === 'into' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'into'} onChange={() => setMode('into')} disabled={busy} />
          Just add them to My notes
        </label>
      </div>

      {busy && (
        <div className="import-progress">
          <progress max="1" value={progress} />
          <span>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Processing notes…'}</span>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="modal-actions">
        <button className="btn" onClick={() => close(false)} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={start} disabled={busy || !files.length}>Import</button>
      </div>
    </div>
  );
}
