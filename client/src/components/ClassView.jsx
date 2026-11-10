import { useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import Ring from './Ring.jsx';
import { Menu, useDialog } from './Dialogs.jsx';
import PdfReader from './PdfReader.jsx';
import { api, fileUrl, pdfViewerUrl } from '../api.js';
import { parseSyllabus } from '../syllabus.js';
import { useStoredState } from '../useStoredState.js';
import { addDays, formatShortDate, formatTime, relativeDay, todayStr } from '../time.js';
import { DEFAULT_SCALE, classGrade, isGraded, pageCount, weekOf } from '../../../shared/grades.js';
import { showStudy } from '../pages/DeskPage.jsx';

const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SECTIONS = [['week', 'This week'], ['lectures', 'Lectures'], ['readings', 'Readings'], ['assignments', 'Assignments'], ['grades', 'Grades'], ['syllabus', 'Syllabus']];
const fmtPct = (p) => (p == null ? '—' : `${(Math.round(p * 10) / 10).toFixed(1)}%`);

/**
 * A class you take (Desk → Learn): the syllabus, this week, lectures with their notes, readings by week, assignments
 * with grades and papers, and the grade so far. `actions` comes from the study page: edit, setStatus, remove, plus
 * the shared Notes and Canvas sections.
 */
export default function ClassView({ s, changed, onBack, backLabel, onOpenNote, onMenu, actions, StudyNotes, ClassFeed }) {
  const dialog = useDialog();
  const [section, setSection] = useStoredState('noteapp.classSection', 'week');
  const syl = s.data.syllabus ?? {};
  const t = todayStr();
  const lectures = s.items.filter((i) => i.kind === 'session');
  const readings = s.items.filter((i) => i.kind === 'reading');
  const assignments = s.items.filter((i) => i.kind === 'assignment');
  const grade = useMemo(() => classGrade(s.data.grades ?? [], s.items, s.data.scale), [s]);
  const weeks = s.start_date && s.target_date ? weekOf(s.target_date, s.start_date) : null;
  const thisWeek = s.start_date ? weekOf(t, s.start_date) : null;
  const weekOfItem = (i) => i.data?.week ?? weekOf(i.date, s.start_date);

  const toggle = async (item) => { await api.updateStudyItem(item.id, { done: !item.done }); changed(); };
  const setData = async (item, data) => {
    try { await api.updateStudyItem(item.id, { data }); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const openItemNote = async (item) => {
    const { id } = await api.studyItemNote(item.id);
    onOpenNote(id);
  };
  const paper = async (item) => {
    try {
      const r = await api.startPaper(item.id);
      changed();
      if (!r.existed) dialog.toast('Your paper is ready on Desk → Write, due when the assignment is');
      showStudy(r.id);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const planLectures = async () => {
    try {
      const r = await api.planLectures(s.id);
      dialog.toast(r.added ? `${plural(r.added, 'lecture')} added` : 'The lectures are all there already');
      changed();
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const remove = async (item) => { await api.deleteStudyItem(item.id); changed(); };
  const rename = async (item) => {
    const title = await dialog.prompt({ title: 'Rename', value: item.title, okLabel: 'Save' });
    if (title) { await api.updateStudyItem(item.id, { title }); changed(); }
  };
  const redate = async (item) => {
    const date = await dialog.prompt({ title: 'Date (YYYY-MM-DD)', value: item.date ?? t, okLabel: 'Save' });
    if (date) { try { await api.updateStudyItem(item.id, { date }); changed(); } catch (e) { dialog.toast(e.message, 'error'); } }
  };

  /** One row: tick, title, what it is, when, and its note or paper. */
  const row = (item, { kind = false, extra = null } = {}) => {
    const late = !item.done && item.kind !== 'session' && item.date && item.date < t; // a lecture isn't late
    const hasNote = item.note_id && item.note_title !== null;
    return (
      <li key={item.id} className={`study-item class-item ${item.done ? 'is-done' : ''}`}>
        <button type="button" className={`task-check ${item.done ? 'is-on' : ''}`} onClick={() => toggle(item)}
          aria-label={item.done ? 'Mark not done' : 'Mark done'} aria-pressed={item.done} />
        <div className="study-item-main">
          <span className="study-item-title">{item.title}</span>
          <span className="study-item-meta">
            {kind && <span className="class-kind">{{ session: 'Lecture', reading: 'Reading', assignment: 'Assignment' }[item.kind]}</span>}
            {item.kind === 'reading' && item.data.pages && <span>pp. {item.data.pages}</span>}
            {item.kind === 'assignment' && !extra && isGraded(item) && <span>{item.data.score} / {item.data.points}</span>}
            {item.kind === 'assignment' && !extra && item.data.category && <span>{item.data.category}</span>}
            {item.data.url && <a href={item.data.url} target="_blank" rel="noreferrer">Canvas</a>}
          </span>
        </div>
        {extra}
        {item.date && <span className={`study-item-date ${late ? 'is-late' : ''}`}>{relativeDay(item.date)}</span>}
        {item.kind === 'session' && (
          <button type="button" className="btn btn-small" data-read={hasNote ? '' : undefined} onClick={() => openItemNote(item)}>
            <Icon name={hasNote ? 'note' : (s.data.lectureLayout === 'plain' ? 'plus' : 'cornell')} size={13} /> {hasNote ? 'Notes' : 'Take notes'}
          </button>
        )}
        {item.kind === 'assignment' && (
          <button type="button" className="btn btn-small" onClick={() => paper(item)} title="A Write project for this paper, due when it is">
            <Icon name="pen" size={13} /> {item.data.paper ? 'Paper' : 'Write it'}
          </button>
        )}
        <Menu align="right" trigger={({ toggle: tg }) => <button type="button" className="icon-btn" onClick={tg} aria-label="More"><Icon name="more" size={16} /></button>} items={[
          hasNote && item.kind !== 'session' && { label: 'Open the note', onClick: () => onOpenNote(item.note_id) },
          !hasNote && item.kind !== 'session' && { label: 'Make a note for it', onClick: () => openItemNote(item) },
          { label: 'Rename…', onClick: () => rename(item) },
          { label: item.date ? 'Change date…' : 'Set a date…', onClick: () => redate(item) },
          'sep',
          { label: 'Delete', danger: true, onClick: () => remove(item) },
        ]} />
      </li>
    );
  };

  const meets = syl.format === 'in-person'
    ? [(syl.meetDays ?? []).map((d) => DAY_NAMES[d]).join(', '), syl.meetTime && formatTime(syl.meetTime), syl.meetMinutes && `${syl.meetMinutes} min`, syl.location].filter(Boolean).join(' · ')
    : 'Online, week by week';

  return (
    <div className={`page studies-page study-detail class-view study-c-${s.color ?? 'blue'}`}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <button type="button" className="link-btn study-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> {backLabel}</button>
          <h1>{s.title}</h1>
          <p className="muted">
            <span className="study-kind-chip"><Icon name="school" size={13} /> {syl.code || 'Class'}</span>
            {s.status !== 'active' && <span className="study-kind-chip">{s.status === 'done' ? 'Finished' : 'Archived'}</span>}
            {[syl.professor, syl.term].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="page-actions">
          {grade.percent != null && (
            <span className="class-grade-badge" title="Grade so far">
              <strong>{grade.letter}</strong> {fmtPct(grade.percent)}
            </span>
          )}
          <button className="btn" onClick={actions.edit}>Edit…</button>
          <Menu align="right" trigger={({ toggle: tg }) => <button className="icon-btn" onClick={tg} aria-label="More"><Icon name="more" /></button>} items={[
            s.status !== 'active' && { label: 'Put back under way', onClick: () => actions.setStatus('active') },
            s.status === 'active' && { label: 'Mark finished', onClick: () => actions.setStatus('done') },
            s.status !== 'archived' && { label: 'Move to the archive', onClick: () => actions.setStatus('archived') },
            { label: s.data.inTasks === false ? 'Show due dates in Tasks and Calendar' : 'Keep due dates out of Tasks and Calendar', onClick: async () => { await api.updateStudy(s.id, { data: { inTasks: s.data.inTasks === false } }); changed(); } },
            false && s.notebook?.own && s.notebook.shelf !== 'Seminary' && { /* 10.1: no shelves */ label: 'Put its notebook on the Seminary shelf', onClick: async () => { try { await api.shelveClass(s.id); dialog.toast(`${s.notebook.name} is on the Seminary shelf`); changed(); } catch (e) { dialog.toast(e.message, 'error'); } } },
            'sep',
            { label: 'Delete class…', danger: true, onClick: actions.remove },
          ]} />
        </div>
      </header>

      <div className="home-tabs class-sections" role="tablist" aria-label="Class">
        {SECTIONS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={section === k} className={section === k ? 'is-active' : ''} onClick={() => setSection(k)}>{l}</button>
        ))}
      </div>

      <div className="study-columns">
        <section className="study-schedule class-main">
          {section === 'week' && <ThisWeek {...{ s, row, lectures, thisWeek, weeks, weekOfItem, t }} />}
          {section === 'lectures' && <Lectures {...{ s, row, lectures, syl, planLectures, changed }} />}
          {section === 'readings' && <Readings {...{ s, row, readings, weeks, thisWeek, weekOfItem, changed }} />}
          {section === 'assignments' && <Assignments {...{ s, row, assignments, setData, changed }} />}
          {section === 'grades' && <Grades {...{ s, grade, assignments, changed }} />}
          {section === 'syllabus' && <SyllabusPdf {...{ s, syl, changed }} />}
        </section>

        <aside className="study-side">
          <section className="class-syllabus">
            <div className="study-side-head">
              <h2>Syllabus</h2>
              <button type="button" className="btn btn-small" data-read="" onClick={() => setSection('syllabus')} title={s.data.syllabusPdf ? 'Show the syllabus PDF' : 'Import the syllabus PDF'}>
                <Icon name="pdf" size={13} /> {s.data.syllabusPdf ? 'PDF' : 'Import PDF'}
              </button>
              <button type="button" className="btn btn-small" onClick={actions.edit}>Edit…</button>
            </div>
            <dl className="class-syl">
              {syl.professor && <><dt>Professor</dt><dd>{syl.professor}{syl.contact && <> · <a href={`mailto:${syl.contact}`}>{syl.contact}</a></>}</dd></>}
              {syl.officeHours && <><dt>Office hours</dt><dd>{syl.officeHours}</dd></>}
              {(s.start_date || s.target_date) && <><dt>Term</dt><dd>{[syl.term, s.start_date && s.target_date ? `${formatShortDate(s.start_date)} – ${formatShortDate(s.target_date)}` : null].filter(Boolean).join(' · ')}{weeks ? ` (${plural(weeks, 'week')})` : ''}</dd></>}
              <dt>Meets</dt><dd>{meets}</dd>
              {syl.link && <><dt>Course site</dt><dd><a href={syl.link} target="_blank" rel="noreferrer">Open <Icon name="external" size={12} /></a></dd></>}
            </dl>
            {s.notebook && <p className="muted">Notes in {s.notebook.name}</p>}
          </section>
          <StudyNotes s={s} onOpenNote={onOpenNote} changed={changed} />
          {s.status !== 'archived' && <ClassFeed s={s} changed={changed} />}
        </aside>
      </div>
    </div>
  );
}

function ThisWeek({ s, row, lectures, thisWeek, weeks, weekOfItem, t }) {
  const week = thisWeek && (!weeks || thisWeek <= weeks) ? thisWeek : null;
  const open = s.items.filter((i) => i.kind !== 'session' && !i.done);
  const late = open.filter((i) => i.date && i.date < t);
  const soon = open.filter((i) => i.date && i.date >= t && i.date <= addDays(t, 7));
  // 11.0: lectures scheduled in the next seven days show too, not only the ones numbered for this week.
  const thisWeeks = lectures.filter((i) => (i.date ? i.date >= t && i.date <= addDays(t, 7) : week && weekOfItem(i) === week))
    .sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'));
  const nothing = !late.length && !soon.length && !thisWeeks.length;
  return (
    <>
      <h2>{week ? `Week ${week}${weeks ? ` of ${weeks}` : ''}` : s.start_date && t < s.start_date ? `Starts ${relativeDay(s.start_date)}` : 'This week'}</h2>
      {nothing && <p className="muted study-empty">Nothing in the next week. Lectures, readings and assignments with dates show up here.</p>}
      {late.length > 0 && <><h3 className="study-group is-behind">Overdue</h3><ul className="study-items">{late.map((i) => row(i, { kind: true }))}</ul></>}
      {thisWeeks.length > 0 && <><h3 className="study-group">Lectures this week</h3><ul className="study-items">{thisWeeks.map((i) => row(i))}</ul></>}
      {soon.length > 0 && <><h3 className="study-group">Due in the next 7 days</h3><ul className="study-items">{soon.map((i) => row(i, { kind: true }))}</ul></>}
    </>
  );
}

function AddRow({ placeholder, fields = [], onAdd }) {
  const [v, setV] = useState({ title: '' });
  const submit = async (e) => {
    e.preventDefault();
    if (!v.title.trim()) return;
    await onAdd(v);
    setV({ title: '' });
  };
  return (
    <form className="study-add" onSubmit={submit}>
      <input className="input" placeholder={placeholder} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} aria-label="Title" />
      {fields.map((f) => (f.options
        ? (
          <select key={f.key} className={`input ${f.className ?? ''}`} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} aria-label={f.label}>
            <option value="">{f.label}</option>
            {f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        )
        : <input key={f.key} className={`input ${f.className ?? ''}`} type={f.type ?? 'text'} placeholder={f.label} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} aria-label={f.label} />))}
      <button className="btn btn-primary" disabled={!v.title.trim()}>Add</button>
    </form>
  );
}

function Lectures({ s, row, lectures, syl, planLectures, changed }) {
  const dialog = useDialog();
  const add = async (v) => {
    try { await api.addStudyItems(s.id, [{ kind: 'session', title: v.title, date: v.date || null }]); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const done = lectures.filter((i) => i.done).length;
  return (
    <>
      <div className="class-section-head">
        <h2>Lectures</h2>
        <button type="button" className="btn btn-small" onClick={planLectures}><Icon name="calendar" size={13} /> {lectures.length ? 'Fill in missing lectures' : 'Fill in from the syllabus'}</button>
      </div>
      <p className="muted class-hint">
        {syl.format === 'in-person' ? 'Each class meeting, on your calendar at its time.' : 'One a week for an online class: the week’s videos and lectures.'}
        {' '}{s.data.lectureLayout === 'plain' ? 'Take notes' : 'Take notes opens Cornell notes (cues, notes, summary)'} with the class and professor filled in.
        {lectures.length > 0 && ` ${done} of ${lectures.length} ${syl.format === 'in-person' ? 'attended' : 'watched'}.`}
      </p>
      {!lectures.length && <p className="muted study-empty">No lectures yet. Fill them in from the term’s dates{syl.format === 'in-person' ? ' and meeting days' : ''}, or add one below.</p>}
      <ul className="study-items">{lectures.map((i) => row(i))}</ul>
      <AddRow placeholder="Add a lecture…" fields={[{ key: 'date', label: 'Date', type: 'date', className: 'study-add-date' }]} onAdd={add} />
    </>
  );
}

function Readings({ s, row, readings, weeks, thisWeek, weekOfItem, changed }) {
  const dialog = useDialog();
  const groups = new Map();
  for (const r of readings) {
    const w = weekOfItem(r) || 0;
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(r);
  }
  const ordered = [...groups].sort((a, b) => (a[0] || 999) - (b[0] || 999));
  const done = readings.filter((r) => r.done);
  const pages = readings.reduce((n, r) => n + pageCount(r.data.pages), 0);
  const pagesRead = done.reduce((n, r) => n + pageCount(r.data.pages), 0);
  const weekOptions = Array.from({ length: Math.max(weeks ?? 0, ...readings.map((r) => weekOfItem(r) || 0), 1) }, (_, i) => [String(i + 1), `Week ${i + 1}`]);
  const add = async (v) => {
    const week = Number(v.week) || null;
    // Due at the end of its week unless you give a date.
    const date = v.date || (week && s.start_date ? addDays(s.start_date, week * 7 - 1) : null);
    try {
      await api.addStudyItems(s.id, [{ kind: 'reading', title: v.title, date, data: { pages: (v.pages ?? '').trim(), week } }]);
      changed();
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const pct = readings.length ? Math.round((done.length / readings.length) * 100) : 0;
  return (
    <>
      <h2>Readings</h2>
      {readings.length > 0 && (
        <div className="class-progress">
          <div className="study-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
          <span className="muted">{done.length} of {plural(readings.length, 'reading')} done{pages ? ` · ${pagesRead.toLocaleString()} of ${pages.toLocaleString()} pages` : ''}</span>
        </div>
      )}
      {!readings.length && <p className="muted study-empty">Add the syllabus readings week by week: the book or article and its pages. Each is due at the end of its week and shows in Tasks.</p>}
      {ordered.map(([w, list]) => {
        const left = list.filter((r) => !r.done).length;
        return (
          <details key={w} className="study-week" open={left > 0 && (!thisWeek || !w || w >= thisWeek - 1)}>
            <summary><h3 className="study-group">{w ? `Week ${w}` : 'No week'}</h3><span className="muted">{left ? `${list.length - left} of ${list.length} done` : 'All done'}</span></summary>
            <ul className="study-items">{list.map((r) => row(r))}</ul>
          </details>
        );
      })}
      <AddRow placeholder="Add a reading (Grudem, chapter 3)…" onAdd={add} fields={[
        { key: 'pages', label: 'Pages (45–80)', className: 'class-add-pages' },
        { key: 'week', label: 'Week', options: weekOptions, className: 'class-add-week' },
      ]} />
    </>
  );
}

function Assignments({ s, row, assignments, setData, changed }) {
  const dialog = useDialog();
  const cats = (s.data.grades ?? []).map((c) => c.name).filter(Boolean);
  const t = todayStr();
  const open = assignments.filter((a) => !a.done);
  const done = assignments.filter((a) => a.done);
  const add = async (v) => {
    try {
      await api.addStudyItems(s.id, [{ kind: 'assignment', title: v.title, date: v.date || null, data: { category: v.category ?? '', points: v.points ? Number(v.points) : null } }]);
      changed();
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const scoring = (a) => (
    <span className="class-score">
      {cats.length > 0 && (
        <select className="input" value={a.data.category ?? ''} onChange={(e) => setData(a, { category: e.target.value })} aria-label="Category">
          <option value="">Category</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <ScoreInput value={a.data.score} label="Score" onSave={(v) => setData(a, { score: v })} />
      <span className="muted">/</span>
      <ScoreInput value={a.data.points} label="Points" onSave={(v) => setData(a, { points: v })} />
    </span>
  );
  return (
    <>
      <h2>Assignments</h2>
      <p className="muted class-hint">Tick one when you turn it in. Give it its category and points from the syllabus, and the score when it comes back; the grade adds up by itself. <strong>Write it</strong> starts a paper on Desk → Write.</p>
      {!assignments.length && <p className="muted study-empty">No assignments yet. Add them below, or connect the Canvas calendar on the right to bring in due dates.</p>}
      {open.length > 0 && <ul className="study-items">{open.map((a) => row(a, { extra: scoring(a) }))}</ul>}
      {done.length > 0 && <><h3 className="study-group">Turned in</h3><ul className="study-items">{done.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((a) => row(a, { extra: scoring(a) }))}</ul></>}
      <AddRow placeholder="Add an assignment…" onAdd={add} fields={[
        { key: 'date', label: 'Due', type: 'date', className: 'study-add-date' },
        ...(cats.length ? [{ key: 'category', label: 'Category', options: cats.map((c) => [c, c]), className: 'class-add-cat' }] : []),
        { key: 'points', label: 'Points', type: 'number', className: 'class-add-points' },
      ]} />
      {open.some((a) => a.date && a.date < t) && <p className="muted class-hint is-behind">Past due and not ticked: tick them once they’re turned in.</p>}
    </>
  );
}

function ScoreInput({ value, label, onSave }) {
  const [v, setV] = useState(value ?? '');
  const save = () => {
    const next = v === '' ? null : Number(v);
    if (next !== (value ?? null) && (next === null || Number.isFinite(next))) onSave(next);
  };
  return <input className="input class-score-input" type="number" step="any" min="0" placeholder={label === 'Score' ? '—' : 'pts'} value={v} aria-label={label}
    onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function Grades({ s, grade, assignments, changed }) {
  const dialog = useDialog();
  const [rows, setRows] = useState(s.data.grades ?? []);
  const [scale, setScale] = useState(s.data.scale?.length ? s.data.scale : DEFAULT_SCALE);
  const save = async (data) => {
    try { await api.updateStudy(s.id, { data }); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const saveRows = (next) => { setRows(next); save({ grades: next }); };
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const totalWeight = rows.reduce((n, r) => n + (Number(r.weight) || 0), 0);
  const byName = new Map(grade.categories.map((c) => [c.name, c]));
  const setScaleRow = (i, patch) => setScale(scale.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="class-grade-head">
        <div className="class-grade-big">
          <strong>{grade.letter ?? '—'}</strong>
          <span>{grade.percent != null ? `${fmtPct(grade.percent)} so far` : 'No grades yet'}</span>
        </div>
        <p className="muted">
          Each category counts for its weight; a category’s score comes from its graded assignments{rows.some((r) => !byName.get(r.name)?.fromItems && r.possible) ? ', or the points you typed for it' : ''}. Only categories with a score count so far.
          {grade.ungraded > 0 && ` ${plural(grade.ungraded, 'assignment')} not graded yet.`}
          {grade.uncategorized > 0 && ` ${plural(grade.uncategorized, 'graded assignment')} with no category ${grade.uncategorized === 1 ? 'doesn’t' : 'don’t'} count.`}
        </p>
      </div>
      <h2>Categories</h2>
      {rows.length > 0 && (
        <table className="grades-table">
          <thead><tr><th>Category</th><th>Weight %</th><th>Score</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const g = byName.get(r.name);
              const n = assignments.filter((a) => (a.data.category ?? '').trim().toLowerCase() === (r.name ?? '').trim().toLowerCase()).length;
              return (
                <tr key={i}>
                  <td><input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} onBlur={() => saveRows(rows)} aria-label="Category" /></td>
                  <td><input className="input" type="number" value={r.weight} onChange={(e) => set(i, { weight: e.target.value })} onBlur={() => saveRows(rows)} aria-label="Weight" /></td>
                  <td>
                    {g?.fromItems
                      ? <span className="class-cat-score">{fmtPct(g.percent)} <span className="muted">({g.earned} / {g.possible}, {plural(g.graded, 'graded assignment')})</span></span>
                      : (
                        <span className="class-cat-score">
                          <input className="input class-score-input" type="number" value={r.earned ?? ''} onChange={(e) => set(i, { earned: e.target.value })} onBlur={() => saveRows(rows)} aria-label="Points earned" placeholder="—" />
                          <span className="muted">/</span>
                          <input className="input class-score-input" type="number" value={r.possible ?? ''} onChange={(e) => set(i, { possible: e.target.value })} onBlur={() => saveRows(rows)} aria-label="Points possible" placeholder="pts" />
                          <span className="muted">{n ? `${plural(n, 'assignment')}, none graded` : 'no assignments'}</span>
                        </span>
                      )}
                  </td>
                  <td><button type="button" className="icon-btn" onClick={() => saveRows(rows.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" size={13} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="study-feed-foot">
        <span className={`muted ${totalWeight && totalWeight !== 100 ? 'is-behind' : ''}`}>{rows.length ? `Weights add up to ${totalWeight}%` : 'Add the syllabus categories (papers, quizzes, discussion…) and their weights.'}</span>
        <button type="button" className="btn btn-small" onClick={() => saveRows([...rows, { name: '', weight: '', earned: '', possible: '' }])}><Icon name="plus" size={13} /> Category</button>
      </div>
      <details className="class-scale">
        <summary>Grading scale</summary>
        <table className="grades-table">
          <thead><tr><th>Letter</th><th>From %</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {scale.map((r, i) => (
              <tr key={i}>
                <td><input className="input" value={r.letter} onChange={(e) => setScaleRow(i, { letter: e.target.value })} onBlur={() => save({ scale })} aria-label="Letter" /></td>
                <td><input className="input" type="number" value={r.min} onChange={(e) => setScaleRow(i, { min: e.target.value })} onBlur={() => save({ scale })} aria-label="Lowest percent" /></td>
                <td><button type="button" className="icon-btn" onClick={() => { const next = scale.filter((_, j) => j !== i); setScale(next); save({ scale: next }); }} aria-label="Remove"><Icon name="x" size={13} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="study-feed-foot">
          <button type="button" className="link-btn" onClick={() => { setScale(DEFAULT_SCALE); save({ scale: null }); }}>Use the usual scale (A 93, A− 90…)</button>
          <button type="button" className="btn btn-small" onClick={() => setScale([...scale, { letter: '', min: '' }])}><Icon name="plus" size={13} /> Letter</button>
        </div>
      </details>
    </>
  );
}

/** A class's card on Desk → Learn: code, professor, grade so far and what's due next. */
export function ClassCard({ s, onOpen }) {
  const syl = s.data.syllabus ?? {};
  return (
    <button type="button" className={`study-card study-c-${s.color ?? 'blue'}`} onClick={onOpen}>
      <span className="study-card-kind"><Icon name="school" size={14} /> {[syl.code || 'Class', syl.term].filter(Boolean).join(' · ')}</span>
      <strong className="study-card-title">{s.title}</strong>
      {syl.professor && <span className="study-card-desc">{syl.professor}</span>}
      {s.grade?.percent != null ? <Ring value={s.grade.percent} max={100} label={s.grade.letter} />
        : s.progress.total > 0 && <Ring value={s.progress.done} max={s.progress.total} />}
      <span className="study-card-pace">
        {s.grade?.percent != null ? <><strong className="class-card-grade">{s.grade.letter}</strong> {fmtPct(s.grade.percent)} so far</> : s.status === 'archived' && !s.progress.total ? plural(s.notes, 'note') : `${s.progress.done} of ${s.progress.total} done`}
      </span>
      {s.status === 'active' && s.due && (
        <span className="study-card-next"><Icon name="chevronRight" size={13} /> {s.due.title} · {relativeDay(s.due.date)}</span>
      )}
    </button>
  );
}

/** Desk → Learn: what's due in the next week (and overdue) across your classes. */
export function DueThisWeek({ items, onOpen }) {
  if (!items?.length) return null;
  return (
    <section className="class-due">
      <h2>This week</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" className={`class-due-row ${i.kind === 'session' ? 'is-lecture' : ''}`} onClick={() => onOpen(i.study_id)}>
              <span className={`class-due-date ${i.late ? 'is-late' : ''}`}>{i.late ? 'Overdue' : relativeDay(i.date)}</span>
              <span className="class-due-title">{i.kind === 'session' && <span className="class-due-kind">Lecture</span>}{i.title}{i.kind === 'reading' && i.data.pages ? <span className="muted"> · pp. {i.data.pages}</span> : null}</span>
              <span className={`class-due-code study-c-${i.color ?? 'blue'}`}>{i.code || i.study_title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FILL_FIELDS = [
  ['code', 'Course code'], ['professor', 'Professor'], ['contact', 'Email'], ['term', 'Term'],
  ['officeHours', 'Office hours'], ['link', 'Course site'], ['start_date', 'First day'], ['target_date', 'Last day'],
];

/** What Selah read from the syllabus PDF, beside what the class has now; you tick what to keep. */
function FillDialog({ s, syl, found, close }) {
  const dialog = useDialog();
  const current = (k) => (k === 'start_date' || k === 'target_date' ? s[k] : syl[k]) ?? '';
  const rows = FILL_FIELDS.filter(([k]) => found[k] && found[k] !== current(k));
  const [vals, setVals] = useState(() => Object.fromEntries(rows.map(([k]) => [k, found[k]])));
  // Empty fields are ticked; ones you already filled in are left for you to decide.
  const [pick, setPick] = useState(() => new Set(rows.filter(([k]) => !current(k)).map(([k]) => k)));
  const [busy, setBusy] = useState(false);
  const toggle = (k) => setPick((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const save = async (e) => {
    e.preventDefault();
    const chosen = Object.fromEntries([...pick].map((k) => [k, vals[k].trim()]).filter(([, v]) => v));
    if (!Object.keys(chosen).length) { close(false); return; }
    const { start_date: start, target_date: end, ...rest } = chosen;
    setBusy(true);
    try {
      await api.updateStudy(s.id, {
        ...(Object.keys(rest).length ? { data: { syllabus: { ...syl, ...rest } } } : {}),
        ...(start ? { start_date: start } : {}),
        ...(end ? { target_date: end } : {}),
      });
      close(true);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="syl-fill" onSubmit={save}>
      <div className="dialog-header">
        <h2>Fill in from the syllabus</h2>
        <button type="button" className="icon-btn" onClick={() => close(false)} aria-label="Close"><Icon name="x" /></button>
      </div>
      {rows.length ? (
        <>
          <p className="muted">Here’s what Selah found in the PDF. Tick what to keep; you can fix a line before saving.</p>
          <ul className="syl-fill-rows">
            {rows.map(([k, label]) => (
              <li key={k} className={pick.has(k) ? 'is-on' : ''}>
                <input type="checkbox" checked={pick.has(k)} onChange={() => toggle(k)} aria-label={`Use the ${label.toLowerCase()}`} />
                <label className="syl-fill-field">
                  <span>{label}</span>
                  <input className="input" type={k.endsWith('_date') ? 'date' : 'text'} value={vals[k]}
                    onChange={(e) => { setVals({ ...vals, [k]: e.target.value }); if (!pick.has(k)) toggle(k); }} />
                  {current(k) && <small className="muted">Now: {String(current(k))}</small>}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="muted">Selah didn’t find anything new to fill in (a scanned PDF has no text to read). Fill in the class with Edit….</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>{rows.length ? 'Skip' : 'Close'}</button>
        {rows.length > 0 && <button className="btn btn-primary" disabled={busy || !pick.size}>Fill in {pick.size || ''}</button>}
      </div>
    </form>
  );
}

/**
 * The class's syllabus PDF (11.0), kept with the class rather than in a note: shown right here in the PDF viewer,
 * full screen on a click, with Replace, Download and Remove. Importing one reads its text and offers to fill in
 * the professor, email, term and dates.
 */
function SyllabusPdf({ s, syl, changed }) {
  const dialog = useDialog();
  const pdf = s.data.syllabusPdf;
  const input = useRef(null);
  const [busy, setBusy] = useState(null);
  const [reader, setReader] = useState(false);
  const [over, setOver] = useState(false);

  const offerFill = async (file) => {
    try {
      setBusy('Reading the syllabus…');
      const { pdfText } = await import('../handwriting.js');
      const found = parseSyllabus(await pdfText(file));
      setBusy(null);
      if (await dialog.open((c) => <FillDialog s={s} syl={syl} found={found} close={c} />)) { dialog.toast('Class details filled in'); changed(); }
    } catch (e) {
      setBusy(null);
      dialog.toast(`Couldn’t read the PDF: ${e.message}`, 'error');
    }
  };
  const upload = async (file) => {
    if (!file) return;
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { dialog.toast('Choose the syllabus as a .pdf file', 'error'); return; }
    if (pdf && !(await dialog.confirm({ title: 'Replace the syllabus?', message: `“${pdf.filename}” is replaced by “${file.name}”.`, okLabel: 'Replace' }))) return;
    setBusy('Uploading… 0%');
    try {
      await api.uploadSyllabusPdf(s.id, file, (p) => setBusy(`Uploading… ${Math.round(p * 100)}%`));
      setBusy(null);
      changed();
      await offerFill(file);
    } catch (e) {
      setBusy(null);
      dialog.toast(e.message, 'error');
    }
  };
  const fillAgain = async () => {
    try {
      const res = await fetch(fileUrl(pdf.id));
      if (!res.ok) throw new Error('The PDF is missing; import it again.');
      await offerFill(new File([await res.blob()], pdf.filename, { type: 'application/pdf' }));
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!(await dialog.confirm({ title: 'Remove the syllabus PDF?', message: 'The class keeps everything you filled in; only the PDF goes.', okLabel: 'Remove', danger: true }))) return;
    try { await api.removeSyllabusPdf(s.id); changed(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const drop = {
    onDragOver: (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); },
  };
  const picker = <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />;

  if (!pdf) {
    return (
      <div className={`syl-empty ${over ? 'is-over' : ''}`} {...drop}>
        {picker}
        <Icon name="pdf" size={30} />
        <h2>Import the syllabus</h2>
        <p className="muted">Choose the syllabus PDF, or drop it here. It stays with this class, not in a note, and opens right here whenever you need it. Selah also reads it and offers to fill in the professor, email, term and dates.</p>
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => input.current?.click()}><Icon name="import" size={14} /> {busy ?? 'Choose the PDF…'}</button>
      </div>
    );
  }
  return (
    <div className={`syl-pdf ${over ? 'is-over' : ''}`} {...drop}>
      {picker}
      <div className="class-section-head">
        <h2 className="syl-pdf-name" title={pdf.filename}><Icon name="pdf" size={16} /> <span>{pdf.filename}</span></h2>
        <div className="syl-pdf-actions">
          {busy && <span className="muted">{busy}</span>}
          <button type="button" className="btn btn-small" data-read="" onClick={() => setReader(true)}><Icon name="expand" size={13} /> Full screen</button>
          <button type="button" className="btn btn-small" disabled={!!busy} onClick={fillAgain} title="Read the PDF again and fill in the class’s details"><Icon name="bolt" size={13} /> Fill in details</button>
          <Menu align="right" trigger={({ toggle: tg }) => <button type="button" className="icon-btn" onClick={tg} aria-label="More"><Icon name="more" size={16} /></button>} items={[
            { label: 'Download', onClick: () => { const a = document.createElement('a'); a.href = `${fileUrl(pdf.id)}?download=1`; a.click(); } },
            { label: 'Replace with another PDF…', onClick: () => input.current?.click() },
            'sep',
            { label: 'Remove the PDF…', danger: true, onClick: remove },
          ]} />
        </div>
      </div>
      <iframe className="syl-frame" src={pdfViewerUrl(pdf.id)} title={`Syllabus: ${pdf.filename}`} />
      {reader && <PdfReader id={pdf.id} filename={pdf.filename} onClose={() => setReader(false)} />}
    </div>
  );
}
