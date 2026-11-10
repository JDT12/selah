import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { formatShortDate } from '../time.js';

/**
 * 13.0: taking attendance without leaving Preach or Teach, for a sermon or lesson linked to an event that an attendance
 * group meets at (GET /api/notes/:id/attendance). The roster to tap through, a headcount for everyone else, and
 * visitors added on the spot, saved as you go (as Plan → Attendance does).
 */
export function useNoteAttendance(noteId) {
  const [info, setInfo] = useState(null);
  useEffect(() => { api.noteAttendance(noteId).then((r) => setInfo(r.group ? r : null)).catch(() => setInfo(null)); }, [noteId]);
  return info;
}

export default function PreachAttendance({ info, close, dialog }) {
  const { group, date } = info;
  const [g, setG] = useState(null);
  const [present, setPresent] = useState(new Set());
  const [headcount, setHeadcount] = useState('');
  const [visitor, setVisitor] = useState('');
  const load = () => api.attendanceGroup(group.id).then((d) => {
    setG(d);
    const m = d.dates.find((x) => x.date === date);
    setPresent(new Set(m?.present ?? []));
    setHeadcount(m?.headcount ?? '');
  }).catch((e) => dialog.toast(e.message, 'error'));
  useEffect(() => { load(); }, [group.id, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (p) => {
    const on = !present.has(p.id);
    setPresent((s) => { const n = new Set(s); if (on) n.add(p.id); else n.delete(p.id); return n; });
    try { await api.markAttendance(group.id, date, p.id, on); } catch (e) { dialog.toast(e.message, 'error'); load(); }
  };
  const saveCount = async (v) => {
    setHeadcount(v);
    try { await api.saveMeeting(group.id, date, { headcount: v === '' ? null : Number(v) }); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const addVisitor = async (e) => {
    e.preventDefault();
    const name = visitor.trim();
    if (!name) return;
    try {
      await api.addAttendancePerson(group.id, { name, visitor: true, date });
      setVisitor('');
      load();
    } catch (err) { dialog.toast(err.message, 'error'); }
  };

  const roster = (g?.roster ?? []).filter((p) => p.active);
  const count = (group.mode === 'headcount' ? 0 : present.size) + (Number(headcount) || 0);
  return (
    <div className="pm-att">
      <div className="dialog-header">
        <h2><Icon name="users" size={18} /> {group.name}</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">{formatShortDate(date)} · {count} here</p>
      {!g && <p className="muted">Loading…</p>}
      {g && group.mode !== 'headcount' && (
        <ul className="pm-att-people">
          {roster.map((p) => (
            <li key={p.id}>
              <button type="button" className={`pm-att-person ${present.has(p.id) ? 'is-here' : ''}`} aria-pressed={present.has(p.id)} onClick={() => toggle(p)}>
                <span className="pm-att-check">{present.has(p.id) && <Icon name="check" size={14} />}</span>
                {p.name}{p.visitor && <span className="muted"> · visitor</span>}
              </button>
            </li>
          ))}
          {!roster.length && <li className="muted">No one on the roster yet. Add them in Plan → Attendance.</li>}
        </ul>
      )}
      {g && (
        <label className="pm-att-count">{group.mode === 'headcount' ? 'Headcount' : 'Others (headcount)'}
          <input className="input" type="number" min="0" inputMode="numeric" value={headcount} onChange={(e) => saveCount(e.target.value)} />
        </label>
      )}
      {g && group.mode !== 'headcount' && (
        <form className="pm-att-visitor" onSubmit={addVisitor}>
          <input className="input" value={visitor} onChange={(e) => setVisitor(e.target.value)} placeholder="Add a visitor" aria-label="Visitor's name" />
          <button className="btn btn-small" disabled={!visitor.trim()}>Add</button>
        </form>
      )}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}
