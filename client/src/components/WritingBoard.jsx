import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

/**
 * The stages a piece of writing moves through (6.6), each with a short checklist of what that stage asks of you.
 * The checklists are about the work, never its content: they're yours to tick, and the writing stays yours.
 */
export const STAGES = [
  { key: 'idea', label: 'Idea', checks: [['oneline', 'Said what it’s about in one sentence'], ['reader', 'Know who it’s for']] },
  { key: 'research', label: 'Research', checks: [['sources', 'Sources gathered'], ['notes', 'Notes taken on each source']] },
  { key: 'outline', label: 'Outline', checks: [['main', 'Main idea in one sentence'], ['order', 'Sections in order']] },
  { key: 'draft', label: 'Draft', checks: [['pass', 'Every section has a first pass']] },
  { key: 'revised', label: 'Revise', checks: [['through', 'Read it start to finish'], ['aloud', 'Read it aloud'], ['panel', 'Went through the Revise panel']] },
  { key: 'edited', label: 'Edit', checks: [['spelling', 'Spelling and punctuation'], ['quotes', 'Quotations and citations checked'], ['format', 'Formatting']] },
  { key: 'final', label: 'Final', checks: [['out', 'Exported or posted']] },
];
export const stageOf = (key) => STAGES.find((s) => s.key === key) ?? STAGES[2];
/** How many of a piece's checks for its stage are ticked: [done, of]. */
export const checksDone = (piece) => {
  const st = stageOf(piece.status);
  return [st.checks.filter(([k]) => piece.checks?.[`${st.key}.${k}`]).length, st.checks.length];
};

/** The checklist menu items for a piece's stage (ticking one saves at once). */
export const checklistItems = (piece, onToggle) => stageOf(piece.status).checks.map(([k, label]) => {
  const key = `${piece.status}.${k}`;
  return { label: `${piece.checks?.[key] ? '✓' : '○'} ${label}`, onClick: () => onToggle(piece, key) };
});

/**
 * A board of pieces by stage: drag a card to another column to move it on. `projects` (id → { title, color }) labels
 * each card with its project when the board shows more than one.
 */
export default function WritingBoard({ pieces, projects = null, onOpen, onMove, onChecklist }) {
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  return (
    <div className="writing-board" role="list" aria-label="Pieces by stage">
      {STAGES.map((st) => {
        const list = pieces.filter((p) => (p.status ?? 'outline') === st.key);
        return (
          <section key={st.key} role="listitem" className={`wb-col ${over === st.key ? 'is-over' : ''}`}
            onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(st.key); } }}
            onDragLeave={() => setOver((o) => (o === st.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              if (drag && drag.status !== st.key) onMove(drag, st.key);
              setDrag(null);
            }}>
            <h3 className="wb-head"><span>{st.label}</span><span className="wb-count">{list.length}</span></h3>
            <div className="wb-cards">
              {list.map((p) => {
                const [done, of] = checksDone(p);
                const project = projects?.[p.study_id];
                return (
                  <article key={`${p.study_id ?? ''}-${p.id}`} className={`wb-card ${drag === p ? 'is-dragging' : ''}`} draggable
                    onDragStart={(e) => { setDrag(p); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(p.id)); }}
                    onDragEnd={() => { setDrag(null); setOver(null); }}>
                    {project && <span className={`wb-project study-c-${project.color ?? 'blue'}`}>{project.title}</span>}
                    <button type="button" className="wb-title" onClick={() => onOpen(p)}>{p.title || 'Untitled'}</button>
                    <span className="wb-meta">
                      <span>{p.words.toLocaleString()} words</span>
                      {p.matter && <span className="wb-matter">{p.matter === 'front' ? 'Front matter' : 'Back matter'}</span>}
                      <button type="button" className={`wb-checks ${done === of ? 'is-done' : ''}`} onClick={(e) => onChecklist(e, p)}
                        title={`${st.label} checklist`} aria-label={`${st.label} checklist: ${done} of ${of}`}>
                        <Icon name="check" size={11} /> {done}/{of}
                      </button>
                    </span>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Desk → Write's board: every piece of every writing project under way, by stage. */
export function AllWritingBoard({ api, dialog, onOpenNote }) {
  const [data, setData] = useState(null);
  const load = () => api.writingBoard().then(setData).catch((e) => dialog.toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.pieces.length) return <p className="nb-empty">No chapters or posts yet. Open a project to start one.</p>;
  const projects = Object.fromEntries(data.projects.map((p) => [p.id, p]));
  const save = async (p, body) => { try { await api.updateChapter(p.study_id, p.id, body); load(); } catch (e) { dialog.toast(e.message, 'error'); } };
  return (
    <WritingBoard pieces={data.pieces} projects={projects}
      onOpen={(p) => Promise.resolve(onOpenNote(p.id)).then(load)}
      onMove={(p, status) => save(p, { status })}
      onChecklist={(e, p) => dialog.contextMenu(e, checklistItems(p, (x, key) => save(x, { checks: { ...x.checks, [key]: !x.checks?.[key] } })))} />
  );
}
