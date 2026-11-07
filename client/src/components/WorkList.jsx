import { useCallback } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { formatShortDate, relativeDay } from '../time.js';
import { useStoredState } from '../useStoredState.js';
import { WORK_TYPES, openRow } from '../work.js';

/**
 * Mark done (or not done): builder work is marked complete (as on its builder's last page), a plan is finished (or put
 * back under way). `after` reloads the list.
 */
export function useMarkDone(after) {
  const dialog = useDialog();
  return useCallback(async (r, done) => {
    try {
      if (r.plan) await api.updateStudy(r.id, { status: done ? 'done' : 'active' });
      else await api.setNoteComplete(r.note_id, done);
      dialog.toast(done ? `Done: ${r.title}` : `${r.title} is active again`, 'info', 6000,
        done ? { label: 'Undo', onClick: async () => { await (r.plan ? api.updateStudy(r.id, { status: 'active' }) : api.setNoteComplete(r.note_id, false)).catch(() => {}); after?.(); } } : undefined);
      window.dispatchEvent(new Event('noteapp:work-changed'));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    after?.();
  }, [dialog, after]);
}

/** The kind of thing a row is, in words ("sermon", "writing project", "class"). */
const kindWord = (r) => (r.type === 'writing' ? 'writing project' : (WORK_TYPES[r.type]?.label ?? 'study').toLowerCase());

/**
 * Delete (11.0): a study, lesson or sermon is its note, so it goes to the trash (Undo, or restore it from Trash). A
 * plan (study plan, course, series, writing project, class) is deleted for good after a confirm; its notes stay.
 */
export function useDeleteWork(after) {
  const dialog = useDialog();
  return useCallback(async (r) => {
    try {
      if (r.plan) {
        const what = kindWord(r);
        const ok = await dialog.confirm({
          title: `Delete “${r.title}”?`,
          message: `This ${what} and its schedule, calendar entries and the tasks it made go for good. Its notes stay where they are (delete them from Notes if you don't want them).`,
          okLabel: `Delete ${what}`, danger: true,
        });
        if (!ok) return;
        await api.deleteStudy(r.id);
        dialog.toast(`Deleted ${what}: ${r.title}`);
      } else {
        await api.trashNote(r.note_id);
        dialog.toast(`Moved to the trash: ${r.title}`, 'info', 8000, {
          label: 'Undo', onClick: async () => { await api.restoreNotes([r.note_id]).catch(() => {}); window.dispatchEvent(new Event('noteapp:work-changed')); after?.(); },
        });
      }
      window.dispatchEvent(new Event('noteapp:work-changed'));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    after?.();
  }, [dialog, after]);
}

const isoOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** Where a row stands: Step N of M, a plan's progress, or done. */
function Standing({ r }) {
  if (r.done) {
    return <span className="work-state is-done"><Icon name="checkCircle" size={13} /> {r.archived ? 'Archived' : r.completed_at ? `Done ${formatShortDate(isoOf(r.completed_at))}` : 'Done'}</span>;
  }
  if (!r.plan) {
    return (
      <span className="work-state" title={`Left on step ${r.step} of ${r.steps}`}>
        <span className="work-steps" aria-hidden="true">{Array.from({ length: r.steps }, (_, i) => <span key={i} className={i < r.step ? 'is-on' : ''} style={i < r.step ? { background: r.color } : undefined} />)}</span>
        Step {r.step} of {r.steps}
      </span>
    );
  }
  const p = r.progress;
  if (!p?.total) return <span className="work-state">Nothing scheduled</span>;
  return <span className={`work-state ${p.behind ? 'is-late' : ''}`}>{p.done} of {p.total} done{p.behind ? ` · ${p.behind} behind` : ''}</span>;
}

/**
 * Work as rows (11.0). On Desk (`mode` 'desk'): everything on the tab, with type chips and Active / Done. On Home
 * ('home'): only what's active, each with Mark done. A click opens it (a builder in its own tab, a plan on Desk);
 * Ctrl-click, a middle click or the right-click menu opens a plan in a new tab.
 */
export default function WorkList({ tab, rows, mode = 'desk', onMarkDone, onDelete, empty }) {
  const dialog = useDialog();
  const [filterBy, setFilterBy] = useStoredState('noteapp.workFilter', {});
  const f = filterBy[tab] ?? {};
  const status = mode === 'home' ? 'active' : f.status ?? 'active';
  const types = [...new Set(rows.map((r) => r.type))].sort((a, b) => Object.keys(WORK_TYPES).indexOf(a) - Object.keys(WORK_TYPES).indexOf(b));
  const type = mode === 'desk' && types.includes(f.type) ? f.type : null;
  const set = (patch) => setFilterBy({ ...filterBy, [tab]: { ...f, ...patch } });
  const byStatus = rows.filter((r) => (status === 'active' ? !r.done : r.done));
  const shown = byStatus.filter((r) => !type || r.type === type);
  const count = (st) => rows.filter((r) => (st === 'active' ? !r.done : r.done) && (!type || r.type === type)).length;

  const open = (r, e) => openRow(r, { newTab: !!(e && (e.ctrlKey || e.metaKey || e.button === 1)) });
  const menu = (r) => [
    { label: r.plan ? 'Open' : 'Open in its builder', onClick: () => open(r) },
    r.plan && { label: 'Open in new tab', onClick: () => openRow(r, { newTab: true }) },
    !r.plan && { label: 'Open the note', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: r.note_id })) },
    !r.plan && { label: 'Open the note in a new tab', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'note', id: r.note_id, title: r.title } })) },
    onMarkDone && 'sep',
    onMarkDone && { label: r.done ? 'Mark not done' : 'Mark done', onClick: () => onMarkDone(r, !r.done) },
    onDelete && 'sep',
    onDelete && { label: r.plan ? `Delete ${kindWord(r)}…` : `Delete ${kindWord(r)}`, danger: true, onClick: () => onDelete(r) },
  ].filter(Boolean);

  return (
    <div className={`work-list is-${mode}`}>
      {mode === 'desk' && rows.length > 0 && (
        <div className="work-bar">
          <div className="work-chips" role="group" aria-label="Type">
            <button type="button" className={`work-chip ${!type ? 'is-on' : ''}`} onClick={() => set({ type: null })}>All</button>
            {types.map((t) => (
              <button key={t} type="button" className={`work-chip ${type === t ? 'is-on' : ''}`} onClick={() => set({ type: type === t ? null : t })}>
                <span className="home-dot" style={{ background: WORK_TYPES[t]?.color }} />{WORK_TYPES[t]?.label ?? t}
              </button>
            ))}
          </div>
          <div className="segmented work-status" role="radiogroup" aria-label="Show">
            {[['active', 'Active'], ['done', 'Done']].map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={status === k} className={status === k ? 'is-active' : ''} onClick={() => set({ status: k })}>
                {l}<span className="work-count">{count(k)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {shown.length ? (
        <ul className="work-rows">
          {shown.map((r) => (
            <li key={r.key} className={`work-row ${r.done ? 'is-done' : ''}`} onContextMenu={(e) => dialog.contextMenu(e, menu(r))}>
              <button type="button" className="work-main" onClick={(e) => open(r, e)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); open(r, e); } }}>
                <span className="work-dot" style={{ background: r.color }} />
                <span className="work-text">
                  <span className="work-title">{r.title}</span>
                  <span className="work-sub">
                    <span className="work-type">{WORK_TYPES[r.type]?.label ?? r.type}</span>
                    {r.passage && <span className="work-passage">{r.passage}</span>}
                    {r.series && <span>{r.series}</span>}
                    {r.date ? <span>{r.dateLabel ? `${r.dateLabel} ` : ''}{relativeDay(r.date)}</span>
                      : r.updated_at ? <span>Edited {formatShortDate(isoOf(r.updated_at))}</span> : null}
                  </span>
                </span>
                <Standing r={r} />
              </button>
              {onMarkDone && mode === 'home' && (
                <button type="button" className="btn btn-small work-done-btn" onClick={() => onMarkDone(r, true)} title="Done with it: it leaves Home and stays on Desk under Done">
                  <Icon name="check" size={13} /> Mark done
                </button>
              )}
              {onDelete && mode === 'desk' && (
                <button type="button" className="icon-btn work-delete" onClick={() => onDelete(r)}
                  title={r.plan ? `Delete this ${kindWord(r)}` : `Delete this ${kindWord(r)} (it goes to the trash)`} aria-label={`Delete ${r.title}`}>
                  <Icon name="trash" size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="work-empty">{empty ?? (status === 'active' ? 'Nothing active here.' : 'Nothing done here yet.')}</p>
      )}
    </div>
  );
}
