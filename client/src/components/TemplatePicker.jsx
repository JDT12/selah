import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

export const PLACEHOLDER_HELP = 'Placeholders {{date}}, {{time}}, {{weekday}} and {{year}} are filled in when you use it.';

/**
 * Pick a template and the notebook for the new note. Resolves to { template, notebook } or null.
 * `notebookId` is the notebook to suggest (the one you're in). With `insert`, there's no notebook to pick:
 * the template goes into the note you're editing.
 */
export default function TemplatePicker({ tree, notebookId, insert = false, close }) {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState(null);
  const [notebook] = useState(notebookId ?? tree.myNotes ?? tree.notebooks[0]?.id); // 10.1: My notes unless asked
  const listRef = useRef(null);

  useEffect(() => {
    api.listNotes({ templates: 1, sort: 'title' })
      .then((list) => { setTemplates(list); setChosen(list[0]?.id ?? null); })
      .catch((e) => setError(e.message));
  }, []);

  const shown = (templates ?? []).filter((t) => (`${t.title} ${t.snippet}`).toLowerCase().includes(q.trim().toLowerCase()));
  const submit = (e) => {
    e?.preventDefault();
    if (chosen && (notebook || insert)) close({ template: chosen, notebook });
  };

  // Searching keeps a template chosen: the first match when the chosen one is filtered out.
  useEffect(() => {
    if (shown.length && !shown.some((t) => t.id === chosen)) setChosen(shown[0].id);
  }, [q, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Without a search box, the list takes the focus so the arrow keys work straight away.
  useEffect(() => {
    if (templates?.length && templates.length <= 5) listRef.current?.focus();
  }, [templates]);

  // ↑/↓ move through the templates (from the search box too), Home/End jump to the ends, Enter uses the chosen one.
  const onKeyDown = (e) => {
    if (e.target.tagName === 'SELECT' || !shown.length) return;
    const at = shown.findIndex((t) => t.id === chosen);
    let next = null;
    if (e.key === 'ArrowDown') next = Math.min(at + 1, shown.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(at - 1, 0);
    else if (e.key === 'Home' && e.target.tagName !== 'INPUT') next = 0;
    else if (e.key === 'End' && e.target.tagName !== 'INPUT') next = shown.length - 1;
    else if (e.key === 'Enter' && listRef.current?.contains(e.target)) { submit(e); return; }
    if (next === null) return;
    e.preventDefault();
    setChosen(shown[next].id);
    listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <form className="template-picker" onSubmit={submit} onKeyDown={onKeyDown}>
      <h2>{insert ? 'Insert template' : 'New note from template'}</h2>
      {error && <p className="form-error">{error}</p>}
      {templates && templates.length === 0 && (
        <p className="modal-message">
          You don’t have any templates yet. Open a note, choose <strong>Make into template</strong> from its ⋯ menu
          (or right-click it in the list), and it will show up here. {PLACEHOLDER_HELP}
        </p>
      )}
      {templates && templates.length > 0 && (
        <>
          {templates.length > 5 && (
            <div className="search-box">
              <Icon name="search" size={15} className="muted" />
              <input type="search" autoFocus placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="template-list" role="listbox" aria-label="Templates" tabIndex={-1} ref={listRef}
            aria-activedescendant={chosen ? `template-${chosen}` : undefined}>
            {shown.length === 0 && <p className="muted">No matching templates.</p>}
            {shown.map((t) => (
              <button type="button" key={t.id} id={`template-${t.id}`} role="option" aria-selected={chosen === t.id} tabIndex={-1}
                className={`template-option ${chosen === t.id ? 'is-active' : ''}`}
                onClick={() => setChosen(t.id)} onDoubleClick={() => close({ template: t.id, notebook })}>
                <span className="template-option-title">{t.title || 'Untitled'}</span>
                <span className="template-option-snippet">{t.snippet || 'Empty template'}</span>
              </button>
            ))}
          </div>
          {insert && <p className="muted template-insert-hint">It goes in where the cursor is. Its tags are added to this note.</p>}
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        {templates?.length > 0 && <button type="submit" className="btn btn-primary" disabled={!chosen}>{insert ? 'Insert' : 'Create note'}</button>}
      </div>
    </form>
  );
}
