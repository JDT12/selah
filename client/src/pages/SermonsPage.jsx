import { useCallback, useEffect, useMemo, useState } from 'react';
import { device } from '../device.js';
import Icon from '../components/Icon.jsx';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import { api } from '../api.js';
import { formatShortDate } from '../time.js';
import { onLive } from '../live.js';
import { BOOKS, parse } from '../../../shared/scripture.js';
import { openSermonBuilder } from '../components/SermonBuilder.jsx';
import { preachNote } from '../components/PreachMode.jsx';
import { ImportSermonsDialog, LogPreachingDialog, NewSermonDialog } from '../components/SermonDialogs.jsx';
import { StudyDialog } from '../components/StudyDialogs.jsx';
import { showStudy } from './DeskPage.jsx';

const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const bookOf = (passage) => parse(passage ?? '').refs[0]?.book ?? null;
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Sermons: every sermon (built here or brought in from Logos), the log of where and when each was preached, and the
 * sermon series (which live in Studies). Sermons open in the panel over the page, in the builder, or in preaching mode.
 */
export default function SermonsPage({ tree, onPeekNote, onOpenScripture, onChanged, onMenu }) {
  const dialog = useDialog();
  const [tab, setTab] = useState('library');
  const [sermons, setSermons] = useState(null);
  const [log, setLog] = useState([]);
  const [studies, setStudies] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [book, setBook] = useState('');

  const load = useCallback(() => Promise.all([api.sermons(), api.preachings(), api.studies()]).then(([s, l, st]) => {
    setSermons(s);
    setLog(l);
    setStudies(st.filter((x) => x.kind === 'preaching'));
  }).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); return onLive(load); }, [load]);

  const peek = (noteId) => Promise.resolve(onPeekNote(noteId)).then(load);
  const build = async (noteId) => { await openSermonBuilder(dialog, noteId); load(); onChanged?.(); };
  const preach = async (noteId) => { await preachNote(dialog, noteId); load(); };
  const create = async () => {
    const r = await dialog.open((close) => <NewSermonDialog tree={tree} close={close} />);
    if (!r) return;
    onChanged?.();
    await build(r.note_id);
  };
  const importLogos = async () => {
    const n = await dialog.open((close) => <ImportSermonsDialog tree={tree} close={close} />);
    if (n) { dialog.toast(`Imported ${plural(n, 'sermon')}`); load(); onChanged?.(); }
  };
  const logIt = async (s) => {
    if (await dialog.open((close) => <LogPreachingDialog noteId={s.note_id} title={s.title} close={close} />)) load();
  };
  const newSeries = async () => {
    const id = await dialog.open((close) => <StudyDialog kind="preaching" tree={tree} close={close} />);
    if (id) { onChanged?.(); showStudy(id); window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'desk' })); }
  };
  const sermonMenu = (s) => [
    { label: 'Open the note', onClick: () => peek(s.note_id) },
    device.full && { label: 'Sermon builder', onClick: () => build(s.note_id) },
    { label: 'Preach', onClick: () => preach(s.note_id) },
    { label: 'Log as preached…', onClick: () => logIt(s) },
    s.passage && { label: `Notes on ${s.passage}`, onClick: () => onOpenScripture(s.passage) },
    { label: s.status === 'ready' ? 'Mark as still building' : 'Mark ready to preach', onClick: async () => { await api.updateSermon(s.id, { status: s.status === 'ready' ? 'building' : 'ready' }); load(); } },
    s.study_id && { label: `Open the series “${s.series}”`, onClick: () => { showStudy(s.study_id); window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'desk' })); } },
    'sep',
    device.full && { label: 'Take off the Sermons page…', danger: true, onClick: async () => {
      if (!(await dialog.confirm({ title: `Take “${s.title}” off the Sermons page?`, message: 'The note stays where it is. Its preached log and builder worksheet go.', okLabel: 'Take it off', danger: true }))) return;
      await api.removeSermon(s.id);
      load();
    } },
  ];

  const books = useMemo(() => [...new Set((sermons ?? []).map((s) => bookOf(s.passage)).filter(Boolean))].sort((a, b) => a - b), [sermons]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (sermons ?? []).filter((s) => {
      if (status === 'building' && (s.status !== 'building' || s.preached)) return false;
      if (status === 'ready' && (s.status !== 'ready' || s.preached)) return false;
      if (status === 'preached' && !s.preached) return false;
      if (status === 'never' && s.preached) return false;
      if (book && bookOf(s.passage) !== Number(book)) return false;
      return !needle || `${s.title} ${s.passage} ${s.series ?? ''}`.toLowerCase().includes(needle);
    });
  }, [sermons, q, status, book]);
  const thisYear = String(new Date().getFullYear());
  const yearCount = log.filter((p) => p.date.startsWith(thisYear)).length;

  return (
    <div className="page sermons-page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Sermons</h1>
          <p className="muted">{sermons ? `${plural(sermons.length, 'sermon')} · preached ${plural(yearCount, 'time')} in ${thisYear}` : 'Loading…'}</p>
        </div>
        <div className="page-actions">
          {device.full && (<button className="btn" onClick={importLogos}><Icon name="import" size={15} /> Import from Logos…</button>)}
          {device.full && (<button className="btn btn-primary" onClick={create}><Icon name="plus" size={15} /> New sermon</button>)}
        </div>
      </header>

      <div className="home-tabs studies-tabs" role="tablist" aria-label="Preach">
        {[['library', 'Library', sermons?.length], ['log', 'Preached', log.length], ['series', 'Series', studies.length]].map(([k, l, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
            {l}{n > 0 && <span className="pr-tab-count">{n}</span>}
          </button>
        ))}
      </div>

      {device.full && tab === 'library' && sermons && !sermons.length && (
        <section className="studies-start">
          <h2>Start your sermon library</h2>
          <p className="muted">Build a sermon in twelve steps, from the text to the pulpit, or bring in the ones you wrote in Logos.</p>
          <div className="studies-start-grid">
            <button type="button" className="studies-start-card" onClick={create}><Icon name="lectern" size={22} /><strong>Build a sermon</strong><span>From the text’s structure to the pulpit, one step at a time</span></button>
            <button type="button" className="studies-start-card" onClick={importLogos}><Icon name="import" size={22} /><strong>Import from Logos</strong><span>Sermon Builder exports (.rtf), with series, topics and passage</span></button>
          </div>
        </section>
      )}

      {tab === 'library' && sermons?.length > 0 && (
        <>
          <div className="sermons-filters">
            <label className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, passages, series" aria-label="Search sermons" /></label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="all">All sermons</option>
              <option value="building">Still building</option>
              <option value="ready">Ready, not preached</option>
              <option value="preached">Preached</option>
              <option value="never">Never preached</option>
            </select>
            {books.length > 1 && (
              <select className="input" value={book} onChange={(e) => setBook(e.target.value)} aria-label="Book">
                <option value="">Every book</option>
                {books.map((b) => <option key={b} value={b}>{BOOKS[b - 1].name}</option>)}
              </select>
            )}
          </div>
          {!shown.length && <p className="nb-empty">No sermons match.</p>}
          <ul className="sermon-list">
            {shown.map((s) => (
              <li key={s.id} className="sermon-row" onContextMenu={(e) => dialog.contextMenu(e, sermonMenu(s))}>
                <button type="button" className="sermon-main" onClick={() => peek(s.note_id)}>
                  <strong>{s.title || 'Untitled sermon'}</strong>
                  <span className="sermon-meta">
                    {s.passage && <span className="sermon-passage"><Icon name="bible" size={13} /> {s.passage}</span>}
                    {s.series && <span className={`study-chip study-c-${s.series_color ?? 'purple'}`}>{s.series}</span>}
                    <span className={`sermon-status is-${s.preached ? 'preached' : s.status}`}>{s.preached ? `Preached ${s.preached > 1 ? `${s.preached}×` : ''}`.trim() : s.status === 'ready' ? 'Ready' : 'Building'}</span>
                    {s.source === 'logos' && <span className="muted">from Logos</span>}
                  </span>
                  {s.last_preached && <span className="muted sermon-last">Last preached {longDate(s.last_preached)}{s.last_place ? ` at ${s.last_place}` : ''}</span>}
                </button>
                <span className="muted sermon-length" title="Length when preached at about 130 words a minute">~{s.minutes_est} min</span>
                {device.full && (<button type="button" className="btn btn-small" onClick={() => build(s.note_id)} title="Open in the sermon builder"><Icon name="steps" size={14} /> Builder</button>)}
                <button type="button" className="icon-btn" onClick={() => preach(s.note_id)} title="Preach" aria-label="Preach"><Icon name="play" size={16} /></button>
                <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" size={16} /></button>} items={sermonMenu(s)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'log' && <PreachedLog log={log} onPeek={peek} reload={load} />}

      {tab === 'series' && (
        <>
          <div className="sermons-series-head">
            <p className="muted">A sermon series is a study: its sermons in order, with dates, in Tasks and on the Calendar.</p>
            {device.full && (<button type="button" className="btn btn-small btn-primary" onClick={newSeries}><Icon name="plus" size={13} /> New series</button>)}
          </div>
          {!studies.length && <p className="nb-empty">No series yet.</p>}
          <div className="studies-grid">
            {studies.map((s) => {
              const inSeries = (sermons ?? []).filter((x) => x.study_id === s.id);
              return (
                <button key={s.id} type="button" className={`study-card study-c-${s.color ?? 'purple'}`}
                  onClick={() => { showStudy(s.id); window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'desk' })); }}>
                  <span className="study-card-kind"><Icon name="lectern" size={14} /> Sermon series{s.status !== 'active' ? ` · ${s.status === 'done' ? 'finished' : 'archived'}` : ''}</span>
                  <strong className="study-card-title">{s.title}</strong>
                  {s.description && <span className="study-card-desc">{s.description}</span>}
                  <span className="study-card-pace">{plural(inSeries.length, 'sermon')}{inSeries.some((x) => x.preached) ? ` · ${inSeries.filter((x) => x.preached).length} preached` : ''}</span>
                  {s.progress.next && <span className="study-card-next"><Icon name="chevronRight" size={13} /> {s.progress.next.title}{s.progress.next.date ? ` · ${formatShortDate(s.progress.next.date)}` : ''}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function PreachedLog({ log, onPeek, reload }) {
  const dialog = useDialog();
  const [place, setPlace] = useState('');
  const places = useMemo(() => [...new Set(log.map((p) => p.place).filter(Boolean))].sort(), [log]);
  const shown = place ? log.filter((p) => p.place === place) : log;
  const years = useMemo(() => {
    const m = new Map();
    for (const p of shown) {
      const y = p.date.slice(0, 4);
      if (!m.has(y)) m.set(y, []);
      m.get(y).push(p);
    }
    return [...m];
  }, [shown]);
  if (!log.length) return <p className="nb-empty">Sermons you log as preached show up here: when you leave preaching mode, or from a sermon’s menu.</p>;
  const edit = async (p) => { if (await dialog.open((close) => <LogPreachingDialog noteId={p.note_id} title={p.title} entry={p} close={close} />)) reload(); };
  const remove = async (p) => {
    if (!(await dialog.confirm({ title: 'Delete this entry?', message: `“${p.title}” on ${longDate(p.date)}.`, okLabel: 'Delete', danger: true }))) return;
    await api.deletePreaching(p.id);
    reload();
  };
  return (
    <section className="preached-log">
      {places.length > 1 && (
        <div className="sermons-filters">
          <select className="input" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Place">
            <option value="">Everywhere</option>
            {places.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}
      {years.map(([year, rows]) => (
        <div key={year}>
          <h3 className="study-group">{year} <span className="muted">· {plural(rows.length, 'time')}</span></h3>
          <table className="preached-table">
            <thead><tr><th>Date</th><th>Sermon</th><th>Place</th><th>Occasion</th><th className="num">Min</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onContextMenu={(e) => dialog.contextMenu(e, [{ label: 'Edit…', onClick: () => edit(p) }, { label: 'Delete', danger: true, onClick: () => remove(p) }])}>
                  <td className="nowrap">{longDate(p.date)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => onPeek(p.note_id)}>{p.title || 'Untitled'}</button>
                    {p.passage && <span className="muted"> · {p.passage}</span>}
                    {p.notes && <span className="preached-notes">{p.notes}</span>}
                  </td>
                  <td>{p.place}</td>
                  <td>{p.occasion}</td>
                  <td className="num">{p.minutes ?? ''}</td>
                  <td>
                    <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" size={15} /></button>}
                      items={[{ label: 'Edit…', onClick: () => edit(p) }, { label: 'Delete', danger: true, onClick: () => remove(p) }]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
