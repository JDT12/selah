import { useRef, useState } from 'react';
import Icon from './Icon.jsx';

const newId = () => Math.random().toString(36).slice(2, 10);

/** A task's checklist: tick, rename, drag to reorder, remove and add steps. value: [{ id, title, done }]. */
export default function StepsEditor({ value, onChange }) {
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState(null);
  const addRef = useRef(null);
  const steps = value ?? [];
  const done = steps.filter((s) => s.done).length;

  const set = (id, patch) => onChange(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    onChange([...steps, { id: newId(), title, done: false }]);
    setDraft('');
    addRef.current?.focus();
  };
  const dropOn = (targetId) => {
    if (!dragId || dragId === targetId) return;
    const moving = steps.find((s) => s.id === dragId);
    const rest = steps.filter((s) => s.id !== dragId);
    const i = rest.findIndex((s) => s.id === targetId);
    onChange([...rest.slice(0, i), moving, ...rest.slice(i)]);
  };

  return (
    <div className="steps-editor">
      {steps.length > 0 && (
        <div className="steps-progress" aria-label={`${done} of ${steps.length} steps done`}>
          <div className="steps-bar"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <span className="muted">{done}/{steps.length}</span>
        </div>
      )}
      <ul className="steps-list">
        {steps.map((s) => (
          <li key={s.id} className={`${s.done ? 'is-done' : ''} ${dragId === s.id ? 'is-dragging' : ''}`} draggable
            onDragStart={(e) => { setDragId(s.id); e.dataTransfer.setData('application/x-step', s.id); e.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => { if (dragId) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); dropOn(s.id); setDragId(null); }}>
            <span className="step-grip" aria-hidden="true"><Icon name="grip" size={13} /></span>
            <input type="checkbox" checked={s.done} onChange={() => set(s.id, { done: !s.done })} aria-label="Done" />
            <StepTitle value={s.title} onChange={(title) => (title ? set(s.id, { title }) : onChange(steps.filter((x) => x.id !== s.id)))} />
            <button type="button" className="icon-btn step-remove" aria-label="Remove step"
              onClick={() => onChange(steps.filter((x) => x.id !== s.id))}><Icon name="x" size={13} /></button>
          </li>
        ))}
      </ul>
      <div className="step-add">
        <Icon name="plus" size={14} className="muted" />
        <input ref={addRef} value={draft} placeholder="Add a step" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
      </div>
    </div>
  );
}

/** A step's title, saved when you leave the field or press Enter. Emptying it removes the step. */
function StepTitle({ value, onChange }) {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) { setPrev(value); setV(value); }
  const commit = () => { if (v.trim() !== value) onChange(v.trim()); };
  return (
    <input className="step-title" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} aria-label="Step"
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.stopPropagation(); setV(value); }
      }} />
  );
}
