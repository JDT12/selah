import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { newStudy } from './StudyBuilder.jsx';
import { newBackground, newWordStudy } from './ReferenceStudies.jsx';
import { book, parse } from '../../../shared/scripture.js';
import { ExistingWorkNotice, useMatchingWork } from './ExistingWork.jsx';

/**
 * New study (9.2): the one way in to a Bible study, from Home, the Bible page, Desk and Ctrl+K. Type a passage, a
 * book or a word; the kind follows what you type (a verse or chapter: a passage study; a whole book: its background;
 * a Strong's number, Greek, Hebrew or any other word: a word study), and you can pick another. It can be filed under
 * a study plan (a self-study on Desk) as one of its readings; either way the builder opens at once, and a toast says
 * where the study lives.
 */
const KINDS = [
  { key: 'ggw', label: 'Passage', hint: 'The Interpretive Journey', icon: 'bible' },
  { key: 'word', label: 'Word', hint: 'Its Greek or Hebrew', icon: 'search' },
  { key: 'background', label: 'Book', hint: 'Its background', icon: 'book' },
];

/** What a typed passage, book or word most likely asks for. */
export function guessKind(text) {
  const t = text.trim();
  if (!t) return 'ggw';
  if (/^[GH]\d{1,5}[a-z]?$/i.test(t) || /[Ͱ-Ͽἀ-῿֐-׿]/.test(t)) return 'word';
  const r = parse(t).refs[0];
  if (!r) return 'word';
  // A book's name alone (1 John, Song of Songs) is the whole book.
  return /\d/.test(t.replace(/^\s*(?:[1-3]|I{1,3})\s*/i, '')) ? 'ggw' : 'background';
}

function NewStudyForm({ start, planId, close }) {
  const [text, setText] = useState(start);
  const [kind, setKind] = useState(() => guessKind(start));
  const [picked, setPicked] = useState(false); // a kind chosen by hand stays chosen
  const [plans, setPlans] = useState([]);
  const [plan, setPlan] = useState(planId ? String(planId) : '');
  const [error, setError] = useState('');
  useEffect(() => {
    api.studies().then((l) => setPlans(l.filter((s) => s.kind === 'self' && s.status === 'active'))).catch(() => {});
  }, []);
  const ref = useMemo(() => parse(text.trim()).refs[0] ?? null, [text]);
  const bookName = ref ? book(ref.book).name : '';
  const existing = useMatchingWork({ kind, text }); // 11.0: work you already have on it
  const change = (v) => { setText(v); setError(''); if (!picked) setKind(guessKind(v)); };
  const submit = (e) => {
    e.preventDefault();
    if (kind === 'ggw' && !ref) { setError('Type a passage, like James 1:19–27.'); return; }
    if (kind === 'background' && !ref) { setError('Type a book of the Bible, like Ephesians.'); return; }
    close({ kind, text: text.trim(), ref, plan: plans.find((p) => String(p.id) === plan) ?? null });
  };
  const hints = { ggw: ref ? ref.label : 'A passage', word: ref ? `A word in ${ref.label}` : text.trim() ? `“${text.trim()}”` : 'A word', background: bookName ? `Background of ${bookName}` : 'A book' };
  return (
    <form className="ns" onSubmit={submit}>
      <div className="dialog-header">
        <h2>New Study</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <input className="input ns-input" value={text} onChange={(e) => change(e.target.value)} autoFocus
        placeholder="A passage, book or word: James 1:19, Ephesians, G26" aria-label="Passage, book or word" />
      <div className="ns-kinds" role="radiogroup" aria-label="Kind of study">
        {KINDS.map((k) => (
          <button key={k.key} type="button" role="radio" aria-checked={kind === k.key} className={`ns-kind ${kind === k.key ? 'is-on' : ''}`}
            onClick={() => { setKind(k.key); setPicked(true); setError(''); }}>
            <Icon name={k.icon} size={16} />
            <strong>{k.label}</strong>
            <span>{kind === k.key ? hints[k.key] : k.hint}</span>
          </button>
        ))}
      </div>
      <label className="ns-plan">
        <span>File under</span>
        <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="">No plan: just Bible studies</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.title || 'Untitled study'}</option>)}
        </select>
      </label>
      <ExistingWorkNotice matches={existing} onOpen={() => close(null)} />
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary">{existing.length ? 'Start new anyway' : `Start ${KINDS.find((k) => k.key === kind).label.toLowerCase()} study`}</button>
      </div>
    </form>
  );
}

/**
 * Asks what to study, makes it (filed under a plan when one is picked) and opens its builder. `start` fills the box
 * (a passage page's reference); `planId` preselects a plan. Resolves the new note's id, or null.
 */
export async function openNewStudy(dialog, { start = '', planId = null } = {}) {
  const r = await dialog.open((close) => <NewStudyForm start={start} planId={planId} close={close} />);
  if (!r) return null;
  let extra = {};
  try {
    // Filed under a plan: it becomes one of the plan's readings (the one already scheduled for the same passage and
    // not studied yet, or a new one), and the study is that reading's note.
    if (r.plan) {
      const same = (x) => {
        const q = parse(x.ref || x.title || '').refs[0];
        return q && r.ref && r.kind !== 'background' && q.start === r.ref.start && q.end === r.ref.end;
      };
      const plan = await api.study(r.plan.id);
      const found = (plan.items ?? []).find((x) => x.kind === 'reading' && !x.note_id && same(x));
      if (found) extra = { study_item_id: found.id };
      else {
        const title = r.kind === 'background' ? `Background of ${book(r.ref.book).name}` : r.ref?.label ?? r.text;
        const { ids } = await api.addStudyItems(r.plan.id, [{ kind: 'reading', title, ref: r.ref?.label ?? '' }]);
        extra = { study_item_id: ids[0] };
      }
    }
  } catch (e) {
    dialog.toast(e.message, 'error');
    return null;
  }
  const where = `Bible studies${r.plan ? ` › ${r.plan.title || 'Untitled study'}` : ''}`;
  const show = r.plan
    ? { label: 'Show', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: r.plan.id })) }
    : { label: 'Show', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'scripture' })) };
  const isWord = r.kind === 'word';
  const id = isWord
    ? await newWordStudy(dialog, r.ref ? r.ref.label : '', extra, { english: r.ref ? '' : r.text })
    : r.kind === 'background' ? await newBackground(dialog, r.ref.label, extra)
      : await newStudy(dialog, r.ref.label, extra, { method: 'ggw', studyId: r.plan?.id ?? null });
  if (id) {
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    dialog.toast(`Saved in ${where}`, 'info', 6000, show);
  }
  return id;
}
