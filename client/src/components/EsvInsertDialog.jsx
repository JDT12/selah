import { useEffect, useRef, useState } from 'react';
import { esvStyle, setEsvStyle } from '../esv.js';
import { TranslationPicker, useBible } from './TranslationPicker.jsx';

/**
 * Asks for a passage, its translation and how to insert it: as a block quote, or inline in the sentence. Resolves
 * { q, style, tr }.
 */
export default function EsvInsertDialog({ close }) {
  const [q, setQ] = useState('');
  const [style, setStyle] = useState(esvStyle);
  const bible = useBible('insert');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setEsvStyle(style);
    close({ q: q.trim(), style, tr: bible.tr });
  };
  return (
    <form onSubmit={submit}>
      <h2>Insert Bible passage</h2>
      <label className="field-label" htmlFor="esv-insert-q">Passage</label>
      <input id="esv-insert-q" ref={ref} className="input" value={q} placeholder="John 3:16-18, Psalm 23, Rom 8:28…"
        onChange={(e) => setQ(e.target.value)} />
      {bible.translations.length > 1 && (
        <>
          <label className="field-label">Translation</label>
          <TranslationPicker bible={bible} />
        </>
      )}
      <label className="field-label">Insert as</label>
      <div className="segmented esv-style" role="radiogroup" aria-label="Insert as">
        {[['quote', 'Quote'], ['inline', 'Inline']].map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={style === v} className={style === v ? 'is-active' : ''}
            onClick={() => setStyle(v)}>{label}</button>
        ))}
      </div>
      <p className="muted esv-style-hint">
        {style === 'quote'
          ? `A block quotation with verse numbers, ending “— John 3:16 (${bible.label === 'Bible' ? 'ESV' : bible.label})”.`
          : `In your sentence: “For God so loved the world…” (John 3:16 ${bible.label === 'Bible' ? 'ESV' : bible.label}).`}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!q.trim()}>Insert</button>
      </div>
    </form>
  );
}
