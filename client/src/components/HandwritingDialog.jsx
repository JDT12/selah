import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { canvasBlob, isPdf, pagesFromFile, textToHtml, unsureWords } from '../handwriting.js';
import { useStoredState } from '../useStoredState.js';

/**
 * Handwriting to text. Starts from a picture you choose here (photo, scan or PDF), or one given as `load`
 * (a drawing, or a picture or PDF already in the note). Each page is read on the server; the text can be fixed up
 * before it goes in. Resolves { action, html, text, file, keepOriginal } or null.
 *
 * actions: [{ key, label }] for the insert buttons (the last one is the main one); none means copy only.
 */
export default function HandwritingDialog({ load, actions = [], canKeepOriginal = false, close }) {
  const dialog = useDialog();
  const [file, setFile] = useState(null);
  const [pages, setPages] = useState(null); // [{ canvas, label, preview }]
  const [shown, setShown] = useState(0);
  const [progress, setProgress] = useState(null); // { page, of }
  const [results, setResults] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [keepLines, setKeepLines] = useStoredState('noteapp.ocr.keepLines', true);
  const [markUnsure, setMarkUnsure] = useStoredState('noteapp.ocr.markUnsure', true);
  const [keepOriginal, setKeepOriginal] = useStoredState('noteapp.ocr.keepOriginal', true);
  const [dragging, setDragging] = useState(false);
  const pickRef = useRef(null);
  const cameraRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const read = async (getPages) => {
    setError(null);
    setResults(null);
    setProgress({ page: 0, of: 0 });
    try {
      const list = await getPages();
      if (!list.length) throw new Error('There’s nothing to read in it.');
      for (const p of list) p.preview = p.canvas.toDataURL('image/jpeg', 0.75);
      if (!alive.current) return;
      setPages(list);
      if (list.truncated) dialog.toast(`Reading the first ${list.length} of ${list.truncated} pages.`);
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (!alive.current) return;
        setShown(i);
        setProgress({ page: i + 1, of: list.length });
        out.push(await api.ocr(await canvasBlob(list[i].canvas)));
      }
      if (!alive.current) return;
      setResults(out);
      setText(out.map((r) => r.text).filter(Boolean).join('\n\n'));
      setShown(0);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setProgress(null);
    }
  };

  useEffect(() => { if (load) read(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (f) => {
    if (!f) return;
    if (!/^image\//.test(f.type) && !isPdf(f.type, f.name)) {
      setError('Choose a photo, a scan or a PDF.');
      return;
    }
    setFile(f);
    read(() => pagesFromFile(f));
  };

  const unsure = useMemo(() => (results ? unsureWords(results) : new Set()), [results]);
  const confidence = results?.length
    ? Math.round(results.reduce((sum, r) => sum + r.confidence, 0) / results.length) : 0;
  const quality = confidence >= 80 ? ['good', 'Read clearly.']
    : confidence >= 60 ? ['fair', 'Mostly read. Check the marked words.']
      : ['poor', 'Hard to read. Expect to fix a fair bit; neat printing reads far better than cursive.'];

  const finish = (action) => close({
    action,
    text: text.trim(),
    html: textToHtml(text, { keepLines, unsure: markUnsure ? unsure : new Set() }),
    file,
    keepOriginal: canKeepOriginal && !!file && keepOriginal,
  });

  const copy = () => navigator.clipboard.writeText(text.trim())
    .then(() => dialog.toast('Text copied'))
    .catch(() => dialog.toast('Could not access clipboard', 'error'));

  const choosing = !load && !file;
  const reading = !!progress;

  return (
    <div className="hw-dialog">
      <div className="dialog-header">
        <h2>Handwriting to text</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>

      {choosing && (
        <div className={`hw-drop ${dragging ? 'is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); }}>
          <Icon name="scan" size={34} />
          <p>A photo or scan of written notes, or a PDF. Drop it here, or:</p>
          <div className="hw-drop-buttons">
            <button type="button" className="btn btn-primary" onClick={() => pickRef.current?.click()}><Icon name="upload" size={15} /> Choose a file</button>
            <button type="button" className="btn" onClick={() => cameraRef.current?.click()}><Icon name="camera" size={15} /> Take a photo</button>
          </div>
          <p className="muted hw-tip">Best results: flat paper, good light, the page filling the photo, and neat printing. Cursive is hard for it.</p>
          {error && <p className="hw-error">{error}</p>}
          <input ref={pickRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
        </div>
      )}

      {!choosing && (
        <div className="hw-body">
          <div className="hw-preview">
            {pages?.[shown] ? <img src={pages[shown].preview} alt={pages[shown].label} /> : <div className="hw-preview-empty"><Icon name="scan" size={30} /></div>}
            {pages?.length > 1 && (
              <div className="hw-pages" role="tablist" aria-label="Pages">
                {pages.map((p, i) => (
                  <button key={p.label} type="button" role="tab" aria-selected={i === shown} className={`hw-page ${i === shown ? 'is-active' : ''}`}
                    disabled={reading} onClick={() => setShown(i)}>{i + 1}</button>
                ))}
              </div>
            )}
          </div>
          <div className="hw-result">
            {reading && (
              <div className="hw-reading" role="status">
                <span className="offsite-spinner" />
                <span>{progress.of ? (progress.of > 1 ? `Reading page ${progress.page} of ${progress.of}…` : 'Reading the writing…') : 'Getting the pages ready…'}</span>
                {progress.of > 1 && <progress max={progress.of} value={progress.page - 1} />}
              </div>
            )}
            {error && !reading && (
              <div className="hw-error">
                <p>{error}</p>
                {!load && <button type="button" className="btn btn-small" onClick={() => { setFile(null); setPages(null); setError(null); }}>Choose another</button>}
              </div>
            )}
            {results && !reading && (
              <>
                {text.trim() ? (
                  <p className={`hw-quality is-${quality[0]}`}>
                    <Icon name={quality[0] === 'good' ? 'checkCircle' : 'alert'} size={15} /> {quality[1]}
                    <span className="muted"> ({confidence}% sure)</span>
                  </p>
                ) : (
                  <p className="hw-quality is-poor"><Icon name="alert" size={15} /> No writing found. Try a closer, brighter photo.</p>
                )}
                <textarea className="input hw-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck
                  aria-label="Typed text" placeholder="The typed text goes here" />
                <label className="check-row compact"><input type="checkbox" checked={keepLines} onChange={(e) => setKeepLines(e.target.checked)} />
                  <span>Keep each written line on its own line<span className="muted">Off: lines run together into paragraphs.</span></span></label>
                {unsure.size > 0 && (
                  <label className="check-row compact"><input type="checkbox" checked={markUnsure} onChange={(e) => setMarkUnsure(e.target.checked)} />
                    <span>Highlight words it wasn’t sure of<span className="muted">{unsure.size} word{unsure.size === 1 ? '' : 's'}, marked so you can check them in the note.</span></span></label>
                )}
                {canKeepOriginal && file && (
                  <label className="check-row compact"><input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />
                    <span>Also add the {isPdf(file.type, file.name) ? 'PDF' : 'photo'} to the note<span className="muted">Above the text, to check against later.</span></span></label>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="modal-actions">
        {results && text.trim() && <button type="button" className="btn hw-copy" onClick={copy}><Icon name="copy" size={15} /> Copy text</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => close(null)}>{actions.length ? 'Cancel' : 'Close'}</button>
        {actions.map((a, i) => (
          <button key={a.key} type="button" className={`btn ${i === actions.length - 1 ? 'btn-primary' : ''}`}
            disabled={!results || reading || !text.trim()} onClick={() => finish(a.key)}>{a.label}</button>
        ))}
      </div>
    </div>
  );
}
