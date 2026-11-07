import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import NotePicker from './NotePicker.jsx';
import ExportWordDialog from './ExportWordDialog.jsx';
import WritingBoard, { STAGES, checklistItems, checksDone } from './WritingBoard.jsx';
import { chooseMethod } from './MethodPicker.jsx';
import { useStoredState } from '../useStoredState.js';
import { methodById } from '../../../shared/methods.js';

const WP_STATUS = { publish: 'Published', future: 'Scheduled', draft: 'WordPress draft', pending: 'Pending review', private: 'Private' };
const n = (x) => x.toLocaleString();

/**
 * A Writing project's chapters: notes in order, each with a draft status, words (and an optional goal) and its
 * WordPress status; the project's word goal and words written each day; export to Word; posting as a series.
 * Since 6.6 the project's type (a book, a blog, a paper, a devotional: shared/methods.js) names its pieces and lays
 * new ones out; a book has front and back matter; each piece moves through stages with a checklist, as a list or a
 * board.
 */
export default function WritingProject({ s, wordpress, onOpenNote, changed }) {
  const dialog = useDialog();
  const [adding, setAdding] = useState(false);
  const [order, setOrder] = useState(null); // while dragging
  const [drag, setDrag] = useState(null);
  const chapters = order ?? s.chapters ?? [];
  const p = s.writing ?? { total: 0, today: 0, perDay: [] };
  const goal = Number(s.data.wordGoal) || 0;
  const series = s.data.series ?? {};
  const type = methodById(s.data.methods?.writing);
  const piece = type?.piece ?? 'chapter';
  const pieces = type?.pieces ?? 'chapters';
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const [view, setView] = useStoredState('noteapp.writing.view', 'list');

  // A series' links follow posts going live on their own (scheduled ones): check now and then.
  useEffect(() => {
    if (series.enabled && wordpress && s.chapters?.some((c) => c.wp_status) && Date.now() - (s.data.seriesSyncedAt ?? 0) > 3600_000) {
      api.syncSeries(s.id).then(changed).catch(() => {});
    }
  }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const numbered = chapters.filter((c) => !c.matter);
  const newChapter = async () => {
    // The project's type lays it out; a project without one asks (or uses your default).
    const method = await chooseMethod(dialog, 'writing', { studyId: s.id });
    if (method == null) return;
    const noun = methodById(method)?.piece ?? piece;
    const title = await dialog.prompt({ title: `New ${noun}`, label: 'Title', value: noun === 'chapter' ? `Chapter ${numbered.length + 1}` : '', okLabel: 'Create' });
    if (!title) return;
    const { id } = await api.addChapter(s.id, { title, method });
    changed();
    onOpenNote(id);
  };
  // A book's front matter (preface, introduction…) and back matter (appendix, bibliography…).
  const addMatter = async (matter, title) => {
    const { id } = await api.addChapter(s.id, { title, matter });
    changed();
    onOpenNote(id);
  };
  const setMatter = async (c, matter) => { await api.updateChapter(s.id, c.id, { matter }); changed(); };
  const toggleCheck = async (c, key) => {
    await api.updateChapter(s.id, c.id, { checks: { ...c.checks, [key]: !c.checks?.[key] } });
    changed();
  };
  const checklist = (e, c) => dialog.contextMenu(e, checklistItems(c, toggleCheck));
  const saveOrder = async (list) => {
    setOrder(list);
    await api.orderChapters(s.id, list.map((c) => c.id));
    setOrder(null);
    changed();
  };
  const move = (i, d) => {
    const list = [...chapters];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    saveOrder(list);
  };
  const setStatus = async (c, status) => { await api.updateChapter(s.id, c.id, { status }); changed(); };
  const setGoal = async (c) => {
    const v = await dialog.prompt({ title: `Word goal for “${c.title || 'Untitled'}”`, label: 'Words (leave empty for none)', value: c.goal ? String(c.goal) : '', okLabel: 'Save' });
    if (v === null || v === undefined) return;
    await api.updateChapter(s.id, c.id, { goal: v.trim() ? Number(v.replace(/[^\d]/g, '')) : null });
    changed();
  };
  const remove = async (c) => {
    await api.removeStudyNote(s.id, c.id);
    changed();
    dialog.toast(`“${c.title || 'Untitled'}” is no longer a chapter (the note stays)`, 'info', 6000, {
      label: 'Undo', onClick: async () => { await api.addChapter(s.id, { note_id: c.id }); changed(); },
    });
  };
  const exportProject = () => dialog.open((close) => (
    <ExportWordDialog title={s.title} project close={close}
      getParts={async () => (await api.studyManuscript(s.id)).parts.map((x) => ({ title: x.title || 'Untitled', html: x.html }))} />
  ));
  const setSeries = async (patch) => {
    await api.updateStudy(s.id, { data: { series: { ...series, ...patch } } });
    changed();
  };
  const syncSeries = async () => {
    try {
      const r = await api.syncSeries(s.id);
      dialog.toast(r.posts ? `Series links checked on ${r.posts} post${r.posts === 1 ? '' : 's'}${r.updated ? ` (${r.updated} updated)` : ''}` : 'No chapters are posted yet');
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const max = Math.max(1, ...p.perDay.map((d) => d.words));
  return (
    <section className="writing">
      <div className="writing-head">
        <h2>{cap(pieces)}</h2>
        {type && <span className="writing-type" title={type.bestFor}>{type.name}</span>}
        <span className="writing-total">
          <strong>{n(p.total)}</strong> {goal ? `of ${n(goal)} words` : 'words'}
          {p.today > 0 && <span className="muted"> · {n(p.today)} today</span>}
        </span>
        <span className="spacer" />
        <div className="segmented writing-view" role="radiogroup" aria-label="Show as">
          {[['list', 'List'], ['board', 'Board']].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-active' : ''} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        <button type="button" className="btn btn-small" onClick={exportProject} disabled={!chapters.length}><Icon name="download" size={14} /> Export to Word…</button>
      </div>
      {goal > 0 && <div className="study-bar writing-bar" role="progressbar" aria-valuenow={Math.min(100, Math.round((p.total / goal) * 100))}><span style={{ width: `${Math.min(100, (p.total / goal) * 100)}%` }} /></div>}
      {p.perDay.some((d) => d.words) && (
        <div className="writing-days" title="Words written each day">
          {p.perDay.map((d) => <span key={d.date} style={{ height: `${Math.max(2, (d.words / max) * 28)}px` }} title={`${d.date}: ${n(d.words)} words`} />)}
        </div>
      )}

      {!chapters.length && <p className="muted study-empty">Each {piece} is its own note. Put them in order here, move each through its stages from idea to final, and export the whole thing as one Word document.</p>}
      {view === 'board' && chapters.length > 0 && (
        <WritingBoard pieces={chapters} onOpen={(c) => onOpenNote(c.id)} onMove={setStatus} onChecklist={checklist} />
      )}
      {view !== 'board' && <ol className="chapter-list">
        {chapters.map((c, i) => (
          <li key={c.id} className={`chapter-row ${drag === c.id ? 'is-dragging' : ''}`} draggable
            onDragStart={(e) => { setDrag(c.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c.id)); }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => { if (drag) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (!drag || drag === c.id) return;
              const list = chapters.filter((x) => x.id !== drag);
              list.splice(list.findIndex((x) => x.id === c.id) + (chapters.findIndex((x) => x.id === drag) < i ? 1 : 0), 0, chapters.find((x) => x.id === drag));
              setDrag(null);
              saveOrder(list);
            }}>
            <span className="chapter-grip" title="Drag to reorder"><Icon name="grip" size={14} /></span>
            <span className={`chapter-num ${c.matter ? 'is-matter' : ''}`} title={c.matter ? `${cap(c.matter)} matter` : undefined}>
              {c.matter ? (c.matter === 'front' ? 'F' : 'B') : numbered.indexOf(c) + 1}
            </span>
            <button type="button" className="chapter-title" onClick={() => onOpenNote(c.id)}>{c.title || 'Untitled'}</button>
            {c.wp_status && <a className={`wp-badge is-${c.wp_status}`} href={c.wp_link} target="_blank" rel="noopener noreferrer"><Icon name="globe" size={12} /> {WP_STATUS[c.wp_status] ?? c.wp_status}</a>}
            <span className="chapter-words">
              {n(c.words)}{c.goal ? ` / ${n(c.goal)}` : ''} words
              {c.goal > 0 && <span className="chapter-goal"><span style={{ width: `${Math.min(100, (c.words / c.goal) * 100)}%` }} /></span>}
            </span>
            <select className={`input chapter-status is-${c.status}`} value={c.status} onChange={(e) => setStatus(c, e.target.value)} aria-label={`Stage of ${c.title}`}>
              {STAGES.map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}
            </select>
            <Checks c={c} onClick={(e) => checklist(e, c)} />
            <span className="chapter-move">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="arrowUp" size={13} /></button>
              <button type="button" className="icon-btn" disabled={i === chapters.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="arrowDown" size={13} /></button>
            </span>
            <button type="button" className="icon-btn" onClick={(e) => dialog.contextMenu(e, [
              { label: c.goal ? 'Change word goal…' : 'Set a word goal…', onClick: () => setGoal(c) },
              type?.matter && { label: c.matter === 'front' ? '✓ Front matter' : 'Front matter', onClick: () => setMatter(c, c.matter === 'front' ? null : 'front') },
              type?.matter && { label: c.matter === 'back' ? '✓ Back matter' : 'Back matter', onClick: () => setMatter(c, c.matter === 'back' ? null : 'back') },
              'sep',
              { label: 'Take out of the project', danger: true, onClick: () => remove(c) },
            ])} aria-label="More"><Icon name="more" size={15} /></button>
          </li>
        ))}
      </ol>}
      <div className="chapter-add">
        <button type="button" className="btn btn-small btn-primary" onClick={newChapter}><Icon name="plus" size={13} /> New {piece}</button>
        {type?.matter && ['front', 'back'].map((m) => (
          <button key={m} type="button" className="btn btn-small" onClick={(e) => dialog.contextMenu(e, [
            ...type.matter[m].filter((t) => !chapters.some((c) => c.title === t)).map((t) => ({ label: t, onClick: () => addMatter(m, t) })),
            'sep',
            { label: 'Something else…', onClick: async () => { const t = await dialog.prompt({ title: `${cap(m)} matter`, label: 'Title', okLabel: 'Create' }); if (t) addMatter(m, t); } },
          ])}>{cap(m)} matter <Icon name="chevronDown" size={12} /></button>
        ))}
        <button type="button" className="btn btn-small" onClick={() => setAdding(!adding)}>Add an existing note…</button>
      </div>
      {adding && <NotePicker value={null} onChange={async (id) => { if (id) { await api.addChapter(s.id, { note_id: id }); setAdding(false); changed(); } }} />}

      {wordpress && (
        <div className="writing-series">
          <label className="check-row">
            <input type="checkbox" checked={!!series.enabled} onChange={(e) => setSeries({ enabled: e.target.checked, name: series.name || s.title })} />
            <span><strong>Post the chapters as a series on {wordpress}</strong>
              <span className="muted">Each chapter you post gets a box at the top with the series name, “Part 2 of 5”, and links to the parts before and after that are live.</span></span>
          </label>
          {series.enabled && (
            <div className="writing-series-opts">
              <label className="field">Series name
                <input className="input" defaultValue={series.name || s.title} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== series.name && setSeries({ name: e.target.value.trim() })} />
              </label>
              <label className="check-row"><input type="checkbox" checked={series.tag !== false} onChange={(e) => setSeries({ tag: e.target.checked })} />
                <span>Tag the posts with the series name</span></label>
              <button type="button" className="btn btn-small" onClick={syncSeries}>Update the series links now</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A piece's checklist for its stage, as "2/3". */
function Checks({ c, onClick }) {
  const [done, of] = checksDone(c);
  return (
    <button type="button" className={`wb-checks ${done === of ? 'is-done' : ''}`} onClick={onClick} aria-label={`Checklist: ${done} of ${of}`} title="This stage’s checklist">
      <Icon name="check" size={11} /> {done}/{of}
    </button>
  );
}
