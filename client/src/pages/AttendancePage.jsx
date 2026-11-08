import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../live.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import PlanTabs from './PlanTabs.jsx';
import { formatShortDate, todayStr } from '../time.js';
import { useStoredState } from '../useStoredState.js';

/**
 * Plan → Attendance (11.0): the classes you teach, the services you preach and your small groups. Each group keeps a
 * roster to check off (big rows, easy on a phone) or just a headcount; its meetings come from a recurring calendar
 * event. Anyone who has missed three in a row shows at the top with Make a follow-up task. Visitors are added at the
 * meeting they came to. A group exports as CSV.
 */
const KIND_ICON = { class: 'school', service: 'lectern', group: 'users' };
const KIND_LABEL = { class: 'Class', service: 'Service', group: 'Small group' };
const NAME_EXAMPLE = { class: 'Adult Sunday School', service: 'Sunday morning service', group: 'Tuesday home group' };
const WEEKDAY = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Sundays at 9:30" for a weekly event, else its title alone. */
function eventLabel(ev) {
  if (!ev) return '';
  const weekly = /FREQ=WEEKLY/.test(ev.rrule ?? '');
  const d = new Date(`${ev.start_at.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const time = ev.start_at.length > 10 ? new Date(`2000-01-01T${ev.start_at.slice(11, 16)}:00Z`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) : '';
  return `${ev.title}${weekly ? ` · ${WEEKDAY[d]}${time ? ` at ${time}` : ''}` : ''}`;
}

/** New group, or edit one (`group`). Resolves the id, or null. */
function GroupDialog({ group, kind: startKind = 'class', close }) {
  const dialog = useDialog();
  const [events, setEvents] = useState([]);
  const [name, setName] = useState(group?.name ?? '');
  const [kind, setKind] = useState(group?.kind ?? startKind);
  const [mode, setMode] = useState(group?.mode ?? (startKind === 'service' ? 'headcount' : 'roster'));
  const [eventId, setEventId] = useState(group?.event_id ? String(group.event_id) : '');
  const [people, setPeople] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.attendanceEvents().then(setEvents).catch(() => setEvents([])); }, []);
  const pickEvent = (v) => {
    setEventId(v);
    const ev = events.find((e) => String(e.id) === v);
    if (ev && !name.trim()) setName(ev.title);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), kind, mode, event_id: eventId ? Number(eventId) : null };
      if (group) { await api.updateAttendanceGroup(group.id, body); close(group.id); return; }
      const { id } = await api.createAttendanceGroup({ ...body, people: mode === 'roster' ? people.split(/\n|;/).map((s) => s.trim()).filter(Boolean) : [] });
      close(id);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="atn-dialog" onSubmit={submit}>
      <div className="dialog-header">
        <h2>{group ? 'Edit group' : 'New attendance group'}</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <label className="field">What it is
        <div className="segmented atn-kinds" role="radiogroup" aria-label="Kind">
          {Object.entries(KIND_LABEL).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-active' : ''}
              onClick={() => { setKind(k); if (!group) setMode(k === 'service' ? 'headcount' : 'roster'); }}>
              <Icon name={KIND_ICON[k]} size={14} /> {l}
            </button>
          ))}
        </div>
      </label>
      <label className="field">Meets as
        <select className="input" value={eventId} onChange={(e) => pickEvent(e.target.value)}>
          <option value="">Not on the calendar (add dates by hand)</option>
          {events.map((ev) => <option key={ev.id} value={ev.id}>{eventLabel(ev)}</option>)}
        </select>
        <span className="muted atn-field-hint">Pick its repeating event on the calendar and its meetings show up here on their own.</span>
      </label>
      <label className="field">Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={NAME_EXAMPLE[kind] ?? ''} autoFocus={!group} />
      </label>
      <label className="field">Take attendance by
        <div className="segmented" role="radiogroup" aria-label="Take attendance by">
          {[['roster', 'Checking off names'], ['headcount', 'Headcount only']].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'is-active' : ''} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
      </label>
      {!group && mode === 'roster' && (
        <label className="field">People <span className="muted">(one per line; you can add more later)</span>
          <textarea className="input" rows={5} value={people} onChange={(e) => setPeople(e.target.value)} placeholder={'Walt Brenner\nMargaret Brenner'} />
        </label>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{group ? 'Save' : 'Add group'}</button>
      </div>
    </form>
  );
}

/** Someone to follow up with. */
function Nudge({ n, onDone }) {
  const dialog = useDialog();
  const act = async (task) => {
    try {
      await api.followUp(n.person_id, task);
      dialog.toast(task ? `Task added: Follow up with ${n.name}` : `Dismissed: ${n.name}`);
      onDone(task);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  return (
    <li className="atn-nudge">
      <Icon name="alert" size={16} />
      <span className="atn-nudge-text">
        <strong>{n.name}</strong> has missed {n.missed} in a row at {n.group}
        {n.last_seen ? <span className="muted"> · last here {formatShortDate(n.last_seen)}</span> : <span className="muted"> · not here yet</span>}
      </span>
      <button type="button" className="btn btn-small btn-primary" onClick={() => act(true)}><Icon name="todo" size={13} /> Follow-up task</button>
      <button type="button" className="btn btn-small" onClick={() => act(false)} title="Already in touch: hide this until they come back and miss three again">Dismiss</button>
    </li>
  );
}

/** The meeting you're taking: tap names, add a visitor, or type a headcount. */
function Meeting({ g, meeting, onChanged }) {
  const dialog = useDialog();
  const [present, setPresent] = useState(() => new Set(meeting.present));
  const [headcount, setHeadcount] = useState(meeting.headcount ?? '');
  const [notes, setNotes] = useState(meeting.notes ?? '');
  const [visitor, setVisitor] = useState('');
  useEffect(() => { setPresent(new Set(meeting.present)); setHeadcount(meeting.headcount ?? ''); setNotes(meeting.notes ?? ''); }, [meeting]);
  const fail = (e) => dialog.toast(e.message, 'error');
  const roster = g.roster.filter((p) => p.active && p.since <= meeting.date);
  const members = roster.filter((p) => !p.visitor);
  const visitors = roster.filter((p) => p.visitor);
  const toggle = async (p) => {
    const on = !present.has(p.id);
    setPresent((s) => { const n = new Set(s); if (on) n.add(p.id); else n.delete(p.id); return n; });
    await api.markAttendance(g.id, meeting.date, p.id, on).catch(fail);
    onChanged();
  };
  const everyone = async () => {
    const ids = roster.map((p) => p.id);
    setPresent(new Set(ids));
    await api.saveMeeting(g.id, meeting.date, { present: ids }).catch(fail);
    onChanged();
  };
  const saveCount = async () => {
    if (String(headcount) === String(meeting.headcount ?? '')) return;
    await api.saveMeeting(g.id, meeting.date, { headcount }).catch(fail);
    onChanged();
  };
  const saveNotes = async () => {
    if (notes === (meeting.notes ?? '')) return;
    await api.saveMeeting(g.id, meeting.date, { notes }).catch(fail);
    onChanged();
  };
  const addVisitor = async (e) => {
    e.preventDefault();
    if (!visitor.trim()) return;
    try {
      await api.addAttendancePerson(g.id, { name: visitor.trim(), visitor: true, date: meeting.date });
      dialog.toast(`Welcome, ${visitor.trim()}`);
      setVisitor('');
      onChanged();
    } catch (err) { fail(err); }
  };
  const clear = async () => {
    if (!(await dialog.confirm({ title: `Clear ${dayName(meeting.date)}?`, message: 'Who was there, the headcount and the notes for this meeting go.', okLabel: 'Clear', danger: true }))) return;
    await api.deleteMeeting(g.id, meeting.date).catch(fail);
    onChanged();
  };
  const person = (p) => (
    <li key={p.id}>
      <button type="button" className={`atn-person ${present.has(p.id) ? 'is-here' : ''}`} aria-pressed={present.has(p.id)} onClick={() => toggle(p)}>
        <span className="atn-check"><Icon name={present.has(p.id) ? 'check' : 'plus'} size={15} /></span>
        <span className="atn-person-name">{p.name}</span>
        {p.missed >= 3 && !present.has(p.id) && <span className="atn-tag is-late" title={`Missed ${p.missed} in a row`}>Missed {p.missed}</span>}
        {p.visitor && <span className="atn-tag">Visitor</span>}
      </button>
    </li>
  );
  const here = roster.filter((p) => present.has(p.id)).length;
  const others = Number(headcount) || 0;

  return (
    <section className="atn-meeting">
      <header className="atn-meeting-head">
        <h3>{new Date(`${meeting.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}</h3>
        {g.mode === 'roster'
          ? <span className="atn-total"><strong>{here + others}</strong> here{roster.length ? ` · ${here} of ${roster.length} on the roster` : ''}</span>
          : <span className="atn-total">{meeting.taken ? <><strong>{meeting.count}</strong> here</> : 'Not taken yet'}</span>}
        {meeting.taken && <button type="button" className="link-btn atn-clear" onClick={clear}>Clear</button>}
      </header>
      {g.mode === 'roster' ? (
        <>
          {members.length > 0 && (
            <div className="atn-list-head">
              <span className="muted">Tap who's here</span>
              <button type="button" className="link-btn" onClick={everyone}>Everyone's here</button>
            </div>
          )}
          {!roster.length && <p className="muted">No one on the roster yet. Add people below, or a visitor.</p>}
          <ul className="atn-people">{members.map(person)}</ul>
          {visitors.length > 0 && <><p className="atn-sub">Visitors</p><ul className="atn-people">{visitors.map(person)}</ul></>}
          <form className="atn-visitor" onSubmit={addVisitor}>
            <input className="input" value={visitor} onChange={(e) => setVisitor(e.target.value)} placeholder="A visitor’s name" aria-label="Visitor's name" />
            <button type="submit" className="btn" disabled={!visitor.trim()}><Icon name="plus" size={14} /> Add visitor</button>
          </form>
          <label className="atn-others">Others not on the roster
            <input className="input" type="number" min="0" inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} onBlur={saveCount} placeholder="0" />
          </label>
        </>
      ) : (
        <div className="atn-headcount">
          <label>Headcount
            <input className="input" type="number" min="0" inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} onBlur={saveCount}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="How many?" />
          </label>
        </div>
      )}
      <label className="atn-notes">Notes
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="Anything to remember about this meeting" />
      </label>
    </section>
  );
}

/** The roster: add, rename, make a visitor a member, take someone off. */
function Roster({ g, onChanged }) {
  const dialog = useDialog();
  const [adding, setAdding] = useState('');
  const fail = (e) => dialog.toast(e.message, 'error');
  const add = async (e) => {
    e.preventDefault();
    const names = adding.split(/\n|;/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    try {
      for (const name of names) await api.addAttendancePerson(g.id, { name });
      setAdding('');
      onChanged();
    } catch (err) { fail(err); }
  };
  const rename = async (p) => {
    const name = await dialog.prompt({ title: 'Rename', label: 'Name', value: p.name, okLabel: 'Save' });
    if (name) { await api.updateAttendancePerson(p.id, { name }).catch(fail); onChanged(); }
  };
  const set = async (p, patch) => { await api.updateAttendancePerson(p.id, patch).catch(fail); onChanged(); };
  const remove = async (p) => {
    if (!(await dialog.confirm({ title: `Delete ${p.name}?`, message: 'Their attendance goes too. To keep it, take them off the roster instead.', okLabel: 'Delete', danger: true }))) return;
    await api.deleteAttendancePerson(p.id).catch(fail);
    onChanged();
  };
  const row = (p) => (
    <li key={p.id} className={p.active ? '' : 'is-off'} onContextMenu={(e) => dialog.contextMenu(e, menu(p))}>
      <span className="atn-roster-name">{p.name}{p.visitor && <span className="atn-tag">Visitor</span>}{!p.active && <span className="atn-tag">Off the roster</span>}</span>
      <span className="muted">{p.possible ? `${p.attended} of ${p.possible}` : 'New'}</span>
      <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label={`More for ${p.name}`}><Icon name="more" size={15} /></button>} items={menu(p)} />
    </li>
  );
  const menu = (p) => [
    { label: 'Rename…', onClick: () => rename(p) },
    p.visitor && { label: 'Make a regular', onClick: () => set(p, { visitor: false }) },
    p.active ? { label: 'Take off the roster', onClick: () => set(p, { active: false }) } : { label: 'Put back on the roster', onClick: () => set(p, { active: true }) },
    'sep',
    { label: 'Delete…', danger: true, onClick: () => remove(p) },
  ].filter(Boolean);
  return (
    <section className="atn-roster">
      <h3>People <span className="muted">{g.roster.filter((p) => p.active).length}</span></h3>
      <ul>{g.roster.filter((p) => p.active).map(row)}</ul>
      {g.roster.some((p) => !p.active) && <details><summary className="muted">Off the roster ({g.roster.filter((p) => !p.active).length})</summary><ul>{g.roster.filter((p) => !p.active).map(row)}</ul></details>}
      <form className="atn-add" onSubmit={add}>
        <textarea className="input" rows={1} value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add someone" title="Add someone, or paste a list (one name per line)"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !adding.includes('\n')) { e.preventDefault(); add(e); } }} aria-label="Add people" />
        <button type="submit" className="btn" disabled={!adding.trim()}>Add</button>
      </form>
    </section>
  );
}

/** One group: its meetings as a strip of dates, the one you're taking, and its people. */
function GroupView({ id, onBack, onChanged }) {
  const dialog = useDialog();
  const [g, setG] = useState(null);
  const [date, setDate] = useState(null);
  const load = useCallback(() => api.attendanceGroup(id).then(setG).catch((e) => dialog.toast(e.message, 'error')), [id, dialog]);
  useEffect(() => { setG(null); setDate(null); load(); }, [load]);
  // Opens on today's meeting, or the latest one before today.
  const shown = useMemo(() => {
    if (!g) return null;
    if (date) return g.dates.find((d) => d.date === date) ?? { date, taken: false, present: [], count: null };
    return g.dates.find((d) => d.date === g.today) ?? g.dates.find((d) => d.date < g.today) ?? (g.dates.length ? null : { date: g.today, taken: false, present: [], count: null });
  }, [g, date]);
  const changed = () => { load(); onChanged(); };
  if (!g) return <div className="atn-group"><p className="muted">Loading…</p></div>;

  const edit = async () => { if (await dialog.open((close) => <GroupDialog group={g} close={close} />)) changed(); };
  const archive = async () => { await api.updateAttendanceGroup(g.id, { archived: !g.archived }); dialog.toast(g.archived ? 'Back in your groups' : 'Archived'); changed(); };
  const remove = async () => {
    if (!(await dialog.confirm({ title: `Delete “${g.name}”?`, message: 'Its people and every meeting’s attendance go for good. Export it as CSV first to keep a copy.', okLabel: 'Delete group', danger: true }))) return;
    await api.deleteAttendanceGroup(g.id);
    onChanged();
    onBack();
  };
  const otherDate = async () => {
    const d = await dialog.prompt({ title: 'Take attendance for another day', label: 'Date (YYYY-MM-DD)', value: g.today, okLabel: 'Open' });
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
  };
  const csv = `/api/attendance/groups/${g.id}/export.csv`;

  return (
    <div className="atn-group">
      <header className="atn-group-head">
        <button type="button" className="icon-btn atn-back" onClick={onBack} aria-label="All groups"><Icon name="arrowLeft" size={16} /></button>
        <span className="atn-kind-icon"><Icon name={KIND_ICON[g.kind] ?? 'users'} size={18} /></span>
        <div className="atn-group-title">
          <h2>{g.name}</h2>
          <p className="muted">{g.kind_label}{g.event ? ` · ${eventLabel(g.event)}` : ' · not on the calendar'}{g.average != null ? ` · about ${g.average} a week` : ''}</p>
        </div>
        <a className="btn btn-small" href={csv} download><Icon name="download" size={13} /> CSV</a>
        <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" size={16} /></button>} items={[
          { label: 'Edit…', onClick: edit },
          { label: 'Take attendance for another day…', onClick: otherDate },
          { label: g.archived ? 'Unarchive' : 'Archive', onClick: archive },
          'sep',
          { label: 'Delete group…', danger: true, onClick: remove },
        ]} />
      </header>
      {g.dates.length > 0 && (
        <div className="atn-dates" role="tablist" aria-label="Meetings">
          {g.dates.map((d) => (
            <button key={d.date} type="button" role="tab" aria-selected={shown?.date === d.date}
              className={`atn-date ${shown?.date === d.date ? 'is-on' : ''} ${d.taken ? 'is-taken' : ''} ${d.future ? 'is-future' : ''}`} onClick={() => setDate(d.date)}>
              <span>{d.date === g.today ? 'Today' : dayName(d.date)}</span>
              <strong>{d.taken ? d.count : d.future ? '' : '–'}</strong>
            </button>
          ))}
          <button type="button" className="atn-date is-other" onClick={otherDate} title="Another day"><span>Other</span><strong>+</strong></button>
        </div>
      )}
      {!g.event && !g.dates.length && <p className="muted">Not on the calendar, so pick the day: <button type="button" className="link-btn" onClick={otherDate}>take attendance for a day</button>, or Edit to follow a repeating event.</p>}
      <div className="atn-cols">
        {shown ? <Meeting g={g} meeting={shown} onChanged={changed} /> : <p className="muted">Pick a meeting above.</p>}
        {g.mode === 'roster' && <Roster g={g} onChanged={changed} />}
      </div>
    </div>
  );
}

export default function AttendancePage({ onMenu, onSection, onTasksChanged }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [open, setOpen] = useStoredState('noteapp.attendance.open', null);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(() => api.attendance().then(setData).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); return onLive(load, 800); }, [load]);
  // A new group, of the kind picked on the start screen (Class from New group).
  const create = async (kind = 'class') => {
    const id = await dialog.open((close) => <GroupDialog kind={kind} close={close} />);
    if (id) { await load(); setOpen(id); }
  };
  const groups = data?.groups ?? [];
  const active = groups.filter((x) => !x.archived);
  const archived = groups.filter((x) => x.archived);
  const current = open && groups.some((x) => x.id === open) ? open : null;

  const card = (x) => (
    <li key={x.id}>
      <button type="button" className={`atn-card ${current === x.id ? 'is-on' : ''}`} onClick={() => setOpen(x.id)}>
        <span className="atn-kind-icon"><Icon name={KIND_ICON[x.kind] ?? 'users'} size={17} /></span>
        <span className="atn-card-text">
          <strong>{x.name}</strong>
          <span className="muted">
            {x.kind_label}{x.mode === 'roster' ? ` · ${plural(x.people, 'person', 'people')}` : ' · headcount'}
            {x.next ? ` · next ${x.next === todayStr() ? 'today' : formatShortDate(x.next)}` : ''}
          </span>
        </span>
        <span className="atn-card-count">
          {x.last_count != null ? <><strong>{x.last_count}</strong><span className="muted">{formatShortDate(x.last)}</span></> : <span className="muted">No meetings yet</span>}
        </span>
        {x.nudges.length > 0 && <span className="atn-card-badge" title={`${plural(x.nudges.length, 'person')} to follow up with`}>{x.nudges.length}</span>}
      </button>
    </li>
  );

  return (
    <div className={`page atn-page ${current ? 'has-group' : ''}`}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading"><h1>Plan</h1></div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => create()}><Icon name="plus" size={16} /> New group</button>
        </div>
      </header>
      <PlanTabs tab="attendance" onSection={onSection} />
      {data?.nudges?.length > 0 && (
        <section className="atn-nudges" aria-label="Follow up">
          <h2>Follow up</h2>
          <ul>{data.nudges.map((n) => <Nudge key={`${n.group_id}-${n.person_id}`} n={n} onDone={(task) => { load(); if (task) onTasksChanged?.(); }} />)}</ul>
        </section>
      )}
      {data && !groups.length && (
        <section className="studies-start">
          <h2>Take attendance</h2>
          <p className="muted">The classes you teach, the services you preach and your small groups: check off a roster (easy on a phone) or count heads, with meetings from your calendar. When someone misses three weeks in a row, you'll see it here.</p>
          <div className="studies-start-grid">
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <button key={k} type="button" className="studies-start-card" onClick={() => create(k)}>
                <Icon name={KIND_ICON[k]} size={22} /><strong>{l}</strong>
                <span>{k === 'class' ? 'A class or Sunday school you teach' : k === 'service' ? 'A service you preach: a headcount' : 'A home group or Bible study'}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {groups.length > 0 && (
        <div className="atn-layout">
          <aside className="atn-groups">
            <ul>{active.map(card)}</ul>
            {archived.length > 0 && (
              <>
                <button type="button" className="link-btn atn-archived" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide' : 'Show'} archived ({archived.length})</button>
                {showArchived && <ul>{archived.map(card)}</ul>}
              </>
            )}
          </aside>
          {current ? <GroupView id={current} onBack={() => setOpen(null)} onChanged={load} />
            : <div className="atn-group atn-pick"><p className="muted">Pick a group to take attendance.</p></div>}
        </div>
      )}
    </div>
  );
}
