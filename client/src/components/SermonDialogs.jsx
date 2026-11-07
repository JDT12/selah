import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { todayStr } from '../time.js';
import { emptySermon, field, sermonHtml, textHtml } from '../sermon.js';
import { format, parse } from '../../../shared/scripture.js';
import { chooseMethod } from './MethodPicker.jsx';
import { ExistingWorkNotice, useMatchingWork } from './ExistingWork.jsx';

export const OCCASIONS = ['Sunday morning', 'Sunday evening', 'Wednesday night', 'Revival', 'Conference', 'Funeral', 'Wedding', 'Chapel', 'Special service'];

/**
 * Logging a sermon as preached (or editing an entry: `entry`). Resolves true when saved; from preaching mode,
 * false means "leave without logging" and null "keep preaching".
 */
export function LogPreachingDialog({ noteId, title, minutes = null, entry = null, fromPreaching = false, close }) {
  const dialog = useDialog();
  const [date, setDate] = useState(entry?.date ?? todayStr());
  const [place, setPlace] = useState(entry?.place ?? '');
  const [occasion, setOccasion] = useState(entry?.occasion ?? '');
  const [mins, setMins] = useState(entry?.minutes ?? minutes ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [past, setPast] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.preachings().then((all) => {
      setPast(all);
      // A new entry starts with the last place you preached.
      if (!entry && all[0]?.place) setPlace((p) => p || all[0].place);
    }).catch(() => {});
  }, [entry]);
  const places = useMemo(() => [...new Set(past.map((p) => p.place).filter(Boolean))], [past]);
  const occasions = useMemo(() => [...new Set([...OCCASIONS, ...past.map((p) => p.occasion).filter(Boolean)])], [past]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = { date, place, occasion, minutes: mins === '' ? null : Number(mins), notes };
    try {
      if (entry) await api.updatePreaching(entry.id, body);
      else await api.logPreaching(noteId, body);
      close(true);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="log-preach" onSubmit={save}>
      <div className="dialog-header">
        <h2>{entry ? 'Edit preaching' : fromPreaching ? 'Log this sermon as preached?' : 'Log as preached'}</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">“{title || 'Untitled'}”</p>
      <div className="field-row">
        <label className="field">Date
          <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field narrow">Minutes
          <input className="input" type="number" min="1" max="600" value={mins} onChange={(e) => setMins(e.target.value)} />
        </label>
      </div>
      <label className="field">Place
        <input className="input" list="preach-places" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Church or event" />
        <datalist id="preach-places">{places.map((p) => <option key={p} value={p} />)}</datalist>
      </label>
      <label className="field">Occasion
        <input className="input" list="preach-occasions" value={occasion} onChange={(e) => setOccasion(e.target.value)} placeholder="Sunday morning" />
        <datalist id="preach-occasions">{occasions.map((o) => <option key={o} value={o} />)}</datalist>
      </label>
      <label className="field"><span>Notes <span className="muted">(optional: how it went, what to change)</span></span>
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="modal-actions">
        {fromPreaching ? (
          <>
            <button type="button" className="btn" onClick={() => close(null)}>Keep preaching</button>
            <button type="button" className="btn" onClick={() => close(false)}>Leave without logging</button>
          </>
        ) : <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>}
        <button type="submit" className="btn btn-primary" disabled={busy || !date}>{entry ? 'Save' : 'Log it'}</button>
      </div>
    </form>
  );
}

/** A new sermon: title, passage, series. Resolves with { id, note_id }. */
export function NewSermonDialog({ tree, studyId = null, close }) {
  const dialog = useDialog();
  const [title, setTitle] = useState('');
  const [passage, setPassage] = useState('');
  const [series, setSeries] = useState([]);
  const [study, setStudy] = useState(studyId ? String(studyId) : '');
  const [notebook] = useState(''); // 10.1: no picker; Sermons or the series' notebook
  const [busy, setBusy] = useState(false);
  const existing = useMatchingWork({ kind: 'sermon', text: passage }); // 11.0: sermons you already have on it
  useEffect(() => { api.studies().then((all) => setSeries(all.filter((s) => s.kind === 'preaching' && s.status !== 'archived'))).catch(() => {}); }, []);
  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const tidy = parse(passage.trim());
      const ref = tidy.refs.length && !tidy.errors.length ? tidy.refs.map((x) => format(x)).join('; ') : passage.trim();
      const method = await chooseMethod(dialog, 'sermon', { studyId: study ? Number(study) : null });
      if (method == null) { setBusy(false); return; }
      const r = await api.createSermon({
        title: title.trim() || 'Untitled sermon', passage: ref, html: sermonHtml(emptySermon(ref)), method,
        study_id: study ? Number(study) : null, notebook_id: notebook ? Number(notebook) : null,
      });
      close(r);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="new-sermon" onSubmit={create}>
      <div className="dialog-header">
        <h2>New sermon</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <label className="field">Title
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="You can name it later" />
      </label>
      <label className="field">Passage
        <input className="input" value={passage} onChange={(e) => setPassage(e.target.value)} placeholder="Matthew 7:1–6" />
      </label>
      <div className="field-row">
        <label className="field grow">Series
          <select className="input" value={study} onChange={(e) => setStudy(e.target.value)}>
            <option value="">Not part of a series</option>
            {series.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      </div>
      <ExistingWorkNotice matches={existing} onOpen={() => close(null)} />
      <p className="muted">The builder opens next and walks you through twelve steps, from the text to the pulpit.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}><Icon name="lectern" size={15} /> {existing.length ? 'Start new anyway' : 'Start building'}</button>
      </div>
    </form>
  );
}

/** RTF as text: Logos writes plain ASCII with escapes, but read stray bytes as Windows-1252 like Word does. */
const readRtf = (file) => file.arrayBuffer().then((b) => new TextDecoder('windows-1252').decode(b));

/** Sermons exported from Logos (Sermon Builder → Export → Rich Text). Resolves with the number brought in. */
export function ImportSermonsDialog({ tree, close }) {
  const dialog = useDialog();
  const [files, setFiles] = useState(null); // [{ name, rtf }]
  const [preview, setPreview] = useState(null);
  const [skip, setSkip] = useState(new Set());
  const [notebook] = useState(''); // 10.1: no picker; Sermons or the series' notebook
  const [tags, setTags] = useState(true);
  const [series, setSeries] = useState(true);
  const [busy, setBusy] = useState(false);

  const choose = async (list) => {
    const picked = [...list].filter((f) => /\.rtf$/i.test(f.name));
    if (!picked.length) { dialog.toast('Choose .rtf files exported from Logos', 'error'); return; }
    setBusy(true);
    try {
      const read = await Promise.all(picked.map(async (f) => ({ name: f.name, rtf: await readRtf(f) })));
      const p = await api.importSermons({ files: read });
      setFiles(read);
      setPreview(p);
      setSkip(new Set(p.filter((r) => r.error || r.duplicate).map((r) => r.name)));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    setBusy(false);
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.importSermons({ files, commit: true, skip: [...skip], notebook_id: notebook ? Number(notebook) : null, tags, series });
      close(r.made.length);
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };
  const count = preview ? preview.filter((r) => !skip.has(r.name)).length : 0;
  const hasTopics = preview?.some((r) => r.topics?.length);
  const hasSeries = preview?.some((r) => r.series);

  return (
    <div className="sermon-import">
      <div className="dialog-header">
        <h2>Import sermons from Logos</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      {!preview ? (
        <>
          <p className="muted">In Logos, open a sermon in Sermon Builder, then <strong>⋯ → Export → Rich Text (.rtf)</strong>. Choose one or more of those files here.</p>
          <label className={`drop-zone ${busy ? 'is-busy' : ''}`}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files); }}>
            <Icon name="upload" size={22} />
            <span>{busy ? 'Reading…' : 'Choose RTF files, or drop them here'}</span>
            <input type="file" accept=".rtf,application/rtf,text/rtf" multiple hidden onChange={(e) => choose(e.target.files)} />
          </label>
        </>
      ) : (
        <>
          <ul className="sermon-import-list">
            {preview.map((r) => (
              <li key={r.name} className={r.error ? 'is-error' : ''}>
                <label>
                  <input type="checkbox" disabled={!!r.error} checked={!skip.has(r.name)}
                    onChange={(e) => { const next = new Set(skip); if (e.target.checked) next.delete(r.name); else next.add(r.name); setSkip(next); }} />
                  <span className="sermon-import-main">
                    <strong>{r.error ? r.name : r.title}</strong>
                    {r.error ? <span className="is-behind">{r.error}</span> : (
                      <span className="muted">
                        {[r.passage, r.series && `Series: ${r.series}`, r.date && `Preached ${r.date}`, `${r.words.toLocaleString()} words`].filter(Boolean).join(' · ')}
                        {r.topics.length > 0 && <> · {r.topics.map((t) => <span key={t} className="tag-pill">#{t}</span>)}</>}
                      </span>
                    )}
                    {r.duplicate && <span className="muted"><Icon name="alert" size={12} /> Already in Selah (same title and passage)</span>}
                    {r.images > 0 && <span className="muted">{r.images} picture{r.images === 1 ? '' : 's'} won’t come across</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {hasTopics && <label className="check-row"><input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} /><span><strong>Topics become tags</strong><span className="muted">Logos’s topics (Judging; Love…) tag the note.</span></span></label>}
          {hasSeries && <label className="check-row"><input type="checkbox" checked={series} onChange={(e) => setSeries(e.target.checked)} /><span><strong>Series become sermon series</strong><span className="muted">In Studies, made when there isn’t one by that name.</span></span></label>}
        </>
      )}
      <div className="modal-actions">
        {preview && <button type="button" className="btn" onClick={() => { setPreview(null); setFiles(null); }}>Choose other files</button>}
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        {preview && <button type="button" className="btn btn-primary" disabled={busy || !count} onClick={run}>{busy ? 'Importing…' : `Import ${count} sermon${count === 1 ? '' : 's'}`}</button>}
      </div>
    </div>
  );
}

export const BANK_KINDS = [['illustration', 'Illustration'], ['quote', 'Quote'], ['scripture', 'Scripture'], ['application', 'Application'], ['other', 'Other']];

/**
 * A bank item: reusable material for any sermon. `item` edits one; otherwise `start` prefills a new one (from text
 * selected in a note, or a block on the Arrange board). Resolves with the saved item.
 */
export function BankItemDialog({ item = null, start = {}, close }) {
  const dialog = useDialog();
  const from = item ?? start;
  const original = useMemo(() => field(from.html ?? ''), [from.html]);
  const [kind, setKind] = useState(from.kind ?? 'illustration');
  const [title, setTitle] = useState(from.title ?? '');
  const [text, setText] = useState(original.text);
  const [topics, setTopics] = useState(from.topics ?? '');
  const [passage, setPassage] = useState(from.passage ?? '');
  const [busy, setBusy] = useState(false);
  // Lists and pictures stay as they are unless the text is changed here.
  const html = text === original.text ? (from.html ?? '') : textHtml(text);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = { kind, title: title.trim() || text.trim().split(/\n/)[0].slice(0, 80), html, topics, passage };
    try {
      const saved = item ? await api.updateBankItem(item.id, body) : await api.addToBank({ ...body, source_note_id: start.source_note_id ?? null, ...(start.source_url ? { source_url: start.source_url, source_page: start.source_page ?? '' } : {}) });
      close(saved);
    } catch (err) {
      dialog.toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="bank-dialog" onSubmit={save}>
      <div className="dialog-header">
        <h2>{item ? 'Edit bank item' : 'Add to the sermon bank'}</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">Reusable material for any sermon. Drag it in from the bank on the builder’s Arrange board.</p>
      {from.source_url && <p className="muted bank-source">From <a href={from.source_url} {...(from.source_url.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}>{from.source_page || from.source_url}</a></p>}
      <div className="field-row">
        <label className="field">Kind
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {BANK_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="field grow">Title <span className="muted">Optional</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scales at the market" />
        </label>
      </div>
      <label className="field">Text
        <textarea className="input" rows={7} required value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {original.rich && text === original.text && <p className="muted bank-rich-note"><Icon name="note" size={13} /> Its lists and formatting are kept unless you change the text.</p>}
      <div className="field-row">
        <label className="field grow">Topics <span className="muted">Separated by commas</span>
          <input className="input" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="Humility, judging" />
        </label>
        <label className="field grow">Passage <span className="muted">Optional</span>
          <input className="input" value={passage} onChange={(e) => setPassage(e.target.value)} placeholder="Matthew 7:1–6" />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>{item ? 'Save' : 'Add to bank'}</button>
      </div>
    </form>
  );
}
