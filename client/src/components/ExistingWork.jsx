import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { parse } from '../../../shared/scripture.js';
import { WORK_TYPES, openRow, workRow } from '../work.js';
import { formatShortDate } from '../time.js';

/**
 * 11.0: before a new study, lesson or sermon, the work you already have on that passage (or word, or book), so you
 * can open it instead of starting over. `kind`: 'ggw' (a passage study), 'background', 'word', 'lesson' or 'sermon'.
 */
const BUILDER_OF = { ggw: 'study', background: 'background', word: 'word', lesson: 'lesson', sermon: 'sermon' };

const refsOf = (text) => {
  const { refs = [], errors = [] } = parse(String(text ?? '').trim());
  return errors.length ? [] : refs;
};
const overlaps = (a, b) => a.some((x) => b.some((y) => x.start <= y.end && x.end >= y.start));

/** The pieces of `work` (api.work) that match what's about to be started. */
export function matchingWork(work, { kind, text }) {
  const want = BUILDER_OF[kind];
  if (!want || !work || !String(text ?? '').trim()) return [];
  const refs = refsOf(text);
  const same = (work ?? []).filter((w) => w.kind === want);
  if (kind === 'background') {
    const books = new Set(refs.map((r) => r.book));
    return same.filter((w) => refsOf(w.passage).some((r) => books.has(r.book)));
  }
  if (kind === 'word' && !refs.length) {
    const t = String(text).trim().toLowerCase();
    return same.filter((w) => (w.word ?? '').toLowerCase() === t || (w.title ?? '').toLowerCase().includes(`“${t}”`));
  }
  if (!refs.length) return [];
  return same.filter((w) => overlaps(refs, refsOf(w.passage)));
}

/** All your work, fetched once for a dialog. */
export function useAllWork() {
  const [work, setWork] = useState(null);
  useEffect(() => { api.work().then(setWork).catch(() => setWork([])); }, []);
  return work;
}

const isoOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** The notice: what you already have, each with Open it. `onOpen` runs first (to close the dialog). */
export function ExistingWorkNotice({ matches, onOpen }) {
  if (!matches?.length) return null;
  const rows = matches.map(workRow);
  const label = WORK_TYPES[rows[0].type]?.label ?? 'piece of work';
  const what = label.startsWith('Bible') ? label : label.toLowerCase();
  return (
    <div className="existing-work" role="status">
      <p className="existing-work-head">
        <Icon name="alert" size={15} />
        {rows.length === 1 ? `You already have a ${what} on this.` : `You already have ${rows.length} ${what.endsWith('study') ? `${what.slice(0, -1)}ies` : `${what}s`} on this.`} Open it, or start a new one anyway.
      </p>
      <ul>
        {rows.slice(0, 4).map((r) => (
          <li key={r.key}>
            <span className="work-dot" style={{ background: r.color }} />
            <span className="existing-work-text">
              <strong>{r.title}</strong>
              <span className="muted">
                {r.passage}{r.passage ? ' · ' : ''}{r.done ? `Done${r.completed_at ? ` ${formatShortDate(isoOf(r.completed_at))}` : ''}` : `Step ${r.step} of ${r.steps}`}
              </span>
            </span>
            <button type="button" className="btn btn-small" onClick={() => { onOpen?.(); openRow(r); }}>Open it</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** For a dialog: the matches as you type, debounced a little. */
export function useMatchingWork({ kind, text }) {
  const work = useAllWork();
  const [q, setQ] = useState({ kind, text });
  useEffect(() => {
    const t = setTimeout(() => setQ({ kind, text }), 250);
    return () => clearTimeout(t);
  }, [kind, text]);
  return useMemo(() => matchingWork(work, q), [work, q]);
}

/**
 * Before starting something outside a form (a lesson from a study): asks when matching work exists. Resolves true to
 * start a new one, 'opened' when you opened the existing one, false when you cancelled.
 */
export async function confirmNew(dialog, { kind, text }) {
  const work = await api.work().catch(() => []);
  const matches = matchingWork(work, { kind, text });
  if (!matches.length) return true;
  return dialog.open((close) => (
    <div className="existing-work-dialog">
      <div className="dialog-header">
        <h2>Already started</h2>
        <button type="button" className="icon-btn" onClick={() => close(false)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <ExistingWorkNotice matches={matches} onOpen={() => close('opened')} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => close(true)}>Start new anyway</button>
      </div>
    </div>
  ));
}
