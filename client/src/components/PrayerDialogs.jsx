import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { describeSchedule, parsePrayer, WEEKDAY_NAMES } from '../prayerParse.js';
import { todayStr } from '../time.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';
import NotePicker from './NotePicker.jsx';
import Scripture, { openRefClick } from './Scripture.jsx';

const DAY = 86_400_000;
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const fmtDay = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(asDate(iso));
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / DAY);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Every day", "Mon, Thu", "In rotation". */
export const scheduleLabel = (p) => describeSchedule(p.schedule, p.weekdays);

/** A request's prayed check (the same look as Daily Walk's read checks). */
export function PrayedCheck({ on, onClick, label = true }) {
  return (
    <button type="button" className={`dw-check pr-check ${on ? 'is-on' : ''}`} onClick={onClick} aria-pressed={on}>
      <span className="dw-check-box"><Icon name="check" size={14} strokeWidth={3} /></span>
      {label && <span>{on ? 'Prayed' : 'Pray'}</span>}
    </button>
  );
}

/**
 * One day's prayers with a check each. day: { date, items, complete } from the server. onToggle(item) checks it;
 * onOpen(item), when given, opens the request.
 */
export function PrayerToday({ day, onToggle, onOpen, empty }) {
  if (!day) return null;
  if (!day.items.length) return <p className="pr-empty">{empty ?? 'Nothing on your prayer list for this day.'}</p>;
  return (
    <ul className="pr-today" onClick={openRefClick}>
      {day.items.map((p) => (
        <li key={p.id} className={`pr-today-item ${p.prayed ? 'is-prayed' : ''}`}>
          <PrayedCheck on={p.prayed} onClick={() => onToggle(p)} label={false} />
          <div className="pr-today-text">
            {onOpen
              ? <button type="button" className="pr-today-title" onClick={() => onOpen(p)}>{p.title}</button>
              : <span className="pr-today-title">{p.title}</span>}
            <span className="pr-today-meta">
              {p.person && <span><Icon name="heart" size={12} /> {p.person}</span>}
              {p.category && <span className="pr-cat">{p.category}</span>}
              {p.refs && <Scripture as="span" text={p.refs} />}
              {p.extra && <span className="muted">extra today</span>}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const HELP = [
  ['@Mom  @Aunt_Sue', 'who it’s for'],
  ['#Family  #Missions', 'category'],
  ['daily, mon,thu, every Monday and Friday, weekdays, weekends', 'which days'],
  ['rotate', 'in rotation: a few a day, taking turns'],
  ['Phil 4:6, Ps 46:1-3', 'Bible references'],
];

/** Type a request in plain words; @person, #category, days and references become chips. */
export function PrayerQuickAdd({ categories, onAdded }) {
  const dialog = useDialog();
  const [text, setText] = useState('');
  const [ignore, setIgnore] = useState([]);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const parsed = useMemo(() => parsePrayer(text, { categories, ignore }), [text, categories, ignore]);
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const p = await api.addPrayer({
        title: parsed.title, person: parsed.person, category: parsed.category, refs: parsed.refs,
        schedule: parsed.schedule ?? 'daily', weekdays: parsed.weekdays, today: todayStr(),
      });
      setText('');
      setIgnore([]);
      onAdded?.(p);
    } catch (err) {
      dialog.toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const ICONS = { person: 'heart', category: 'tag', schedule: 'repeat', refs: 'bible' };
  return (
    <form className="quick-add smart-add pr-add" onSubmit={submit}>
      <div className="smart-add-row">
        <Icon name="plus" size={18} className="smart-add-plus" />
        <input value={text} placeholder="Add a prayer request, e.g. Dad’s job search @Dad #Family mon,thu" aria-label="New prayer request"
          enterKeyHint="done" onChange={(e) => { setText(e.target.value); if (!e.target.value) setIgnore([]); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); setIgnore([]); e.currentTarget.blur(); } }} />
        <button type="button" className="icon-btn smart-add-help" onClick={() => setHelp(!help)} aria-expanded={help}
          title="What can I type?" aria-label="What can I type?">?</button>
        {text.trim() && <button type="submit" className="btn btn-primary btn-small" disabled={busy}>Add</button>}
      </div>
      {text.trim() && (
        <div className="smart-chips">
          {parsed.tokens.map((tok) => (
            <span key={tok.key} className={`smart-chip kind-${tok.kind}`} title={`From “${tok.text.trim()}”`}>
              <Icon name={ICONS[tok.kind]} size={12} />
              {tok.kind === 'category' && !categories.some((c) => c.toLowerCase() === tok.label.toLowerCase()) ? `New category: ${tok.label}` : tok.label}
              <button type="button" aria-label={`Keep “${tok.text.trim()}” in the title`} title="Keep this text in the title"
                onClick={() => setIgnore([...ignore, tok.key])}><Icon name="x" size={11} /></button>
            </span>
          ))}
          {!parsed.schedule && <span className="smart-chip is-default"><Icon name="repeat" size={12} />Every day</span>}
        </div>
      )}
      {help && (
        <div className="smart-help">
          <p>Type naturally. These are picked out of the title:</p>
          <dl>{HELP.map(([ex, what]) => <div key={what}><dt>{ex}</dt><dd>{what}</dd></div>)}</dl>
          <p className="muted">Without a day, a request comes up every day. Click × on a chip to keep that text in the title.</p>
        </div>
      )}
    </form>
  );
}

/** Weekday toggles; value is a bitmask (bit 0 = Sunday). */
function WeekdayPicker({ value, onChange }) {
  return (
    <div className="weekday-picker when-row">
      {WEEKDAY_NAMES.map((d, i) => (
        <button key={d} type="button" className={(value >> i) & 1 ? 'is-active' : ''} aria-pressed={!!((value >> i) & 1)}
          title={d} onClick={() => onChange(value ^ (1 << i))}>{d.slice(0, 2)}</button>
      ))}
    </div>
  );
}

/** Marks a request answered: the date and how it was answered. Resolves to { closed_day, answer } or null. */
export function AnswerDialog({ request, close }) {
  const [day, setDay] = useState(request.status === 'answered' && request.closed_day ? request.closed_day : todayStr());
  const [answer, setAnswer] = useState(request.answer ?? '');
  return (
    <form className="pr-dialog" onSubmit={(e) => { e.preventDefault(); close({ closed_day: day, answer }); }}>
      <h2>Answered prayer</h2>
      <p className="muted">{request.title}{request.person ? ` (${request.person})` : ''}</p>
      <label className="field-label" htmlFor="pr-answer-day">Answered on</label>
      <input id="pr-answer-day" className="input input-inline" type="date" value={day} min={request.created_day} max={todayStr()}
        onChange={(e) => setDay(e.target.value || todayStr())} required />
      <label className="field-label" htmlFor="pr-answer">How was it answered?</label>
      <textarea id="pr-answer" className="input" rows={4} value={answer} autoFocus onChange={(e) => setAnswer(e.target.value)}
        placeholder="What happened, and what you saw God do" />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary"><Icon name="checkCircle" size={15} /> Mark answered</button>
      </div>
    </form>
  );
}

/**
 * Add or edit a request, with its updates timeline. request: an existing request, or { title, note_id } to start a
 * new one (e.g. from a note). Resolves to the saved request, { deleted: true }, or null if nothing changed.
 */
export function PrayerDialog({ request, categories = [], close, onOpenNote }) {
  const dialog = useDialog();
  const isNew = request.id == null;
  const [p, setP] = useState(request);
  const [form, setForm] = useState({
    title: request.title ?? '', person: request.person ?? '', category: request.category ?? '', refs: request.refs ?? '',
    details: request.details ?? '', schedule: request.schedule ?? 'daily', weekdays: request.weekdays || 0, note_id: request.note_id ?? null,
  });
  const [update, setUpdate] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));

  const save = async (e) => {
    e?.preventDefault();
    if (form.schedule === 'weekly' && !form.weekdays) return dialog.toast('Choose at least one weekday.', 'error');
    setBusy(true);
    try {
      const body = { ...form, today: todayStr() };
      const saved = isNew ? await api.addPrayer(body) : await api.updatePrayer(p.id, body);
      close(saved);
    } catch (err) {
      dialog.toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn) => {
    try {
      const r = await fn();
      if (r) { setP(r); setChanged(true); }
      return r;
    } catch (err) {
      dialog.toast(err.message, 'error');
      return null;
    }
  };
  const addUpdate = async () => {
    if (!update.trim()) return;
    if (await act(() => api.addPrayerUpdate(p.id, { text: update, day: todayStr() }))) setUpdate('');
  };
  const removeUpdate = (u) => act(async () => {
    await api.deletePrayerUpdate(u.id);
    return { ...p, updates: p.updates.filter((x) => x.id !== u.id) };
  });
  const answer = async () => {
    const r = await dialog.open((c) => <AnswerDialog request={p} close={c} />);
    if (r) close(await act(() => api.updatePrayer(p.id, { ...form, status: 'answered', ...r, today: todayStr() })));
  };
  const setStatus = async (status) => close(await act(() => api.updatePrayer(p.id, { ...form, status, today: todayStr() })));
  const remove = async () => {
    const ok = await dialog.confirm({ title: 'Delete this request?', message: 'Its updates and prayed checks are deleted too. To keep it out of the way instead, archive it.', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deletePrayer(p.id, todayStr());
      close({ deleted: true, id: p.id });
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };

  return (
    <form className="pr-dialog event-dialog" onSubmit={save}>
      <input className="input title-input" value={form.title} onChange={set('title')} placeholder="What are you praying for?"
        aria-label="Request" autoFocus={isNew} required maxLength={300} />
      <div className="form-grid">
        <label className="form-label" htmlFor="pr-person">For</label>
        <input id="pr-person" className="input" value={form.person} onChange={set('person')} placeholder="Who it’s for (optional)" maxLength={120} />
        <label className="form-label" htmlFor="pr-category">Category</label>
        <div>
          <input id="pr-category" className="input" list="pr-categories" value={form.category} onChange={set('category')} placeholder="Family, Church, Missions…" maxLength={60} />
          <datalist id="pr-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <span className="form-label">Pray</span>
        <div className="when">
          <div className="segmented" role="group" aria-label="When to pray">
            {[['daily', 'Every day'], ['weekly', 'On certain days'], ['rotation', 'In rotation']].map(([v, l]) => (
              <button key={v} type="button" className={form.schedule === v ? 'is-active' : ''} aria-pressed={form.schedule === v}
                onClick={() => setForm((f) => ({ ...f, schedule: v, weekdays: v === 'weekly' && !f.weekdays ? 1 << asDate(todayStr()).getUTCDay() : f.weekdays }))}>{l}</button>
            ))}
          </div>
          {form.schedule === 'weekly' && <WeekdayPicker value={form.weekdays} onChange={set('weekdays')} />}
          {form.schedule === 'rotation' && <span className="muted pr-hint">Comes up with the other rotation requests, a few each day (set how many on the Prayer page).</span>}
        </div>
        <label className="form-label" htmlFor="pr-refs">Scripture</label>
        <input id="pr-refs" className="input" value={form.refs} onChange={set('refs')} placeholder="Verses to pray, e.g. Phil 4:6-7" maxLength={500} />
        <label className="form-label" htmlFor="pr-details">Details</label>
        <textarea id="pr-details" className="input" rows={3} value={form.details} onChange={set('details')} placeholder="Background, what to ask for" />
        <span className="form-label">Note</span>
        <NotePicker value={form.note_id} onChange={set('note_id')} onOpen={onOpenNote ? (id) => { close(changed ? p : null); onOpenNote(id); } : undefined} />
      </div>

      {!isNew && (
        <section className="pr-updates">
          <h3>Updates</h3>
          {p.updates.length === 0 && <p className="muted pr-hint">Add news as it comes, so you can see how God has worked.</p>}
          <ol className="pr-timeline" onClick={openRefClick}>
            <li className="pr-timeline-start"><span className="pr-timeline-day">{fmtDay(p.created_day)}</span><span>Added to the list</span></li>
            {p.updates.map((u) => (
              <li key={u.id}>
                <span className="pr-timeline-day">{fmtDay(u.day)}</span>
                <Scripture as="span" text={u.text} />
                <button type="button" className="icon-btn pr-timeline-x" title="Delete this update" aria-label="Delete this update" onClick={() => removeUpdate(u)}><Icon name="x" size={13} /></button>
              </li>
            ))}
            {p.status === 'answered' && (
              <li className="pr-timeline-answer"><span className="pr-timeline-day">{fmtDay(p.closed_day)}</span><span><strong>Answered.</strong> {p.answer}</span></li>
            )}
          </ol>
          <div className="pr-update-add">
            <input className="input" value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="Add an update…" aria-label="New update"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUpdate(); } }} />
            <button type="button" className="btn" disabled={!update.trim()} onClick={addUpdate}>Add</button>
          </div>
          <p className="muted pr-hint">
            Prayed {plural(p.times, 'time')}{p.lastPrayed ? `, last on ${fmtDay(p.lastPrayed, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''} ·
            on the list {plural(Math.max(0, daysBetween(p.created_day, p.closed_day ?? todayStr())), 'day')}
          </p>
        </section>
      )}

      <div className="modal-actions spread">
        <div className="modal-actions-group">
          {!isNew && <button type="button" className="btn btn-danger-text" onClick={remove}>Delete</button>}
          {!isNew && p.status === 'active' && <button type="button" className="btn" onClick={() => setStatus('archived')}>Archive</button>}
          {!isNew && p.status !== 'active' && <button type="button" className="btn" onClick={() => setStatus('active')}>Pray again</button>}
        </div>
        <div className="modal-actions-group">
          {!isNew && p.status !== 'archived' && (
            <button type="button" className="btn" onClick={answer}><Icon name="checkCircle" size={15} /> {p.status === 'answered' ? 'Edit answer' : 'Answered'}</button>
          )}
          <button type="button" className="btn" onClick={() => close(changed ? p : null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim()}>{isNew ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </form>
  );
}
