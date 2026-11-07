import { useState } from 'react';
import { api, formatSize } from '../api.js';

const isMd = (name) => /\.(md|markdown|mdown|mkd)$/i.test(name);
// Folders from note apps carry their own housekeeping; none of it belongs in a note.
const skip = (p) => p.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');

export default function MarkdownImportDialog({ tree, close }) {
  const [files, setFiles] = useState([]); // [{ file, path }]
  const [folderName, setFolderName] = useState('');
  const [mode, setMode] = useState('new');
  const [name, setName] = useState('');
  // 10.1: the notes land in My notes; "Tag them all" tags them with the name (the server folds the notebook it makes).
  const stack = '';
  const notebook = tree.myNotes ?? tree.notebooks[0]?.id;
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const pickFiles = (list) => {
    setFolderName('');
    setFiles([...list].map((file) => ({ file, path: file.name })));
  };
  const pickFolder = (list) => {
    const all = [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name })).filter((f) => !skip(f.path));
    const folder = all[0]?.path.split('/')[0] ?? '';
    setFolderName(folder);
    if (folder && !name) setName(folder);
    setFiles(all);
  };

  const notes = files.filter((f) => isMd(f.path));
  const others = files.length - notes.length;

  const start = async () => {
    setError(null);
    setProgress(0);
    try {
      const params = mode === 'new' ? { mode, name: name.trim() || 'Imported notes', stack } : { mode, notebook };
      setResult(await api.importMarkdown(files, params, setProgress));
    } catch (e) {
      setError(e.message);
    } finally {
      setProgress(null);
    }
  };

  if (result) {
    return (
      <div className="import-dialog">
        <h2>Import complete</h2>
        <p className="modal-message">
          Imported {result.notes} note{result.notes === 1 ? '' : 's'} and {result.attachments} attachment{result.attachments === 1 ? '' : 's'}.
        </p>
        {result.errors.length > 0 && (
          <details className="import-results">
            <summary>{result.errors.length} warning{result.errors.length === 1 ? '' : 's'}</summary>
            <ul>{result.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>
          </details>
        )}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => close(result.notebook_id)}>Done</button>
        </div>
      </div>
    );
  }

  const busy = progress !== null;
  return (
    <div className="import-dialog">
      <h2>Import Markdown</h2>
      <p className="modal-message">
        Each <strong>.md</strong> file becomes a note. Choose a folder to bring
        in the images and files the notes link to as well. Front-matter titles, tags and dates are kept.
      </p>

      <div className="file-drop-pair">
        <label className="file-drop">
          <input type="file" accept=".md,.markdown,.mdown,.mkd,text/markdown" multiple disabled={busy}
            onChange={(e) => pickFiles(e.target.files)} />
          Choose .md files…
        </label>
        <label className="file-drop">
          <input type="file" webkitdirectory="" multiple disabled={busy} onChange={(e) => pickFolder(e.target.files)} />
          Choose a folder…
        </label>
      </div>
      {files.length > 0 && (
        <p className="import-summary">
          {folderName && <><strong>{folderName}</strong>: </>}
          {notes.length} note{notes.length === 1 ? '' : 's'}
          {others > 0 && `, ${others} other file${others === 1 ? '' : 's'} (only the ones notes link to are kept)`}
          {' '}· {formatSize(files.reduce((n, f) => n + f.file.size, 0))}
        </p>
      )}

      <div className="choice-list">
        <label className={`choice ${mode === 'new' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} disabled={busy} />
          Tag them all
        </label>
        {mode === 'new' && (
          <div className="indent indent-fields">
            <label>Tag <input className="input input-inline" value={name} placeholder="Imported notes"
              onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
          </div>
        )}
        <label className={`choice ${mode === 'into' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'into'} onChange={() => setMode('into')} disabled={busy} />
          Just add them to My notes
        </label>
      </div>

      {busy && (
        <div className="import-progress">
          <progress max="1" value={progress} />
          <span>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Converting notes…'}</span>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="modal-actions">
        <button className="btn" onClick={() => close(null)} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={start} disabled={busy || !notes.length}>Import</button>
      </div>
    </div>
  );
}
