import { useEffect, useState } from 'react';

/** The note's footnotes and bibliography, under the text. Numbers jump back to their place in the note. */
export default function CitationNotes({ editor }) {
  const storage = editor?.storage.citation;
  const [, setVersion] = useState(0);
  useEffect(() => storage?.subscribe(() => setVersion((v) => v + 1)), [storage]);
  if (!storage || (!storage.notes.length && !storage.bibliography.length)) return null;

  const jump = (pos) => {
    editor.chain().focus().setNodeSelection(pos).scrollIntoView().run();
  };
  return (
    <section className="citation-notes" aria-label="Notes and bibliography" contentEditable={false}>
      {storage.notes.length > 0 && (
        <>
          <h2 className="citation-notes-title">Notes</h2>
          <ol className="citation-notes-list">
            {storage.notes.map((n) => (
              <li key={n.number} value={n.number}>
                <button type="button" className="citation-notes-num" onClick={() => jump(n.pos)} title="Go to this note in the text">{n.number}.</button>
                {/* Formatted by citeproc and cleaned to simple formatting (see citations/index.js). */}
                <span dangerouslySetInnerHTML={{ __html: n.html }} />
              </li>
            ))}
          </ol>
        </>
      )}
      {storage.bibliography.length > 0 && (
        <>
          <h2 className="citation-notes-title">Bibliography</h2>
          <div className="citation-bibliography">
            {storage.bibliography.map((b, i) => <p key={i} dangerouslySetInnerHTML={{ __html: b }} />)}
          </div>
        </>
      )}
    </section>
  );
}
