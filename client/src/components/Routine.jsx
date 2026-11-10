import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { PrayerToday } from './PrayerDialogs.jsx';
import Scripture, { openRefClick } from './Scripture.jsx';
import { biblePassage, creditHtml, passageCardHtml } from '../esv.js';
import { onLive } from '../live.js';
import { buzz } from '../mobile.js';

/**
 * 13.0: the Daily Walk routine (server/routine.js): the items you set up, checked off each day. Used by the Walk page
 * (`full`) and Home's card. Plan passages open and read in place, the prayer list is ticked as you pray, the journal
 * takes a line or two, and a custom item can carry a link, a note and a timer.
 */
export function useRoutine(date, today) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api.routine(date, today).then((r) => { if (r.date === date) setData(r); }).catch(() => setData((d) => d ?? false)), [date, today]);
  useEffect(() => { load(); return onLive(load, 600); }, [load]);
  return [data, load, setData];
}

const KIND_ICON = { plan: 'book', prayer: 'heart', journal: 'pen', custom: 'checkCircle', devotional: 'sunrise' };
const labelOf = (it) => it.title || (it.kind === 'devotional' ? it.devotional?.book.title ?? 'Devotional' : it.kind === 'plan' ? it.plan?.title ?? 'Reading plan' : it.kind === 'prayer' ? 'Prayer list' : it.kind === 'journal' ? 'Journal' : 'Item');

function Check({ on, onClick, label, disabled }) {
  return (
    <button type="button" className={`rt-check ${on ? 'is-on' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={on} aria-label={label}>
      {on && <Icon name="check" size={14} strokeWidth={3} />}
    </button>
  );
}

/** A passage's text, fetched when opened. */
function PassageText({ refText }) {
  const [p, setP] = useState(null);
  useEffect(() => { biblePassage(refText).then(setP).catch((e) => setP({ error: e.message })); }, [refText]);
  if (!p) return <p className="muted">Loading…</p>;
  if (p.error) return <p className="muted">{p.error}</p>;
  return (
    <div className="rt-passage">
      <div className="esv-card-body" dangerouslySetInnerHTML={{ __html: passageCardHtml(p.text) }} />
      <p className="rt-credit" dangerouslySetInnerHTML={{ __html: creditHtml(p) }} />
    </div>
  );
}

function Timer({ minutes, onDone }) {
  const [end, setEnd] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!end) return undefined;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= end) { clearInterval(t); setEnd(null); buzz('time'); onDone?.(); }
    }, 500);
    return () => clearInterval(t);
  }, [end]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = end ? Math.max(0, end - now) : minutes * 60_000;
  const s = Math.ceil(left / 1000);
  return (
    <button type="button" className={`btn btn-small rt-timer ${end ? 'is-on' : ''}`} onClick={() => setEnd(end ? null : Date.now() + minutes * 60_000)}>
      <Icon name={end ? 'pause' : 'play'} size={12} /> {end ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${minutes} min`}
    </button>
  );
}

export function RoutineList({ data, date, today, onChange, onOpenNote, compact = false, onOpenWalk }) {
  const dialog = useDialog();
  const [open, setOpen] = useState(() => new Set());
  const [reading, setReading] = useState(null); // `${planId}:${i}`
  const [journal, setJournal] = useState('');
  const flip = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = async (fn) => { try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); } onChange(); };

  const markPlan = (it, item, read) => run(() => api.setPlanRead(it.plan_id, { day: it.plan.day, ...(item == null ? {} : { item }), read, today }));
  const markCustom = (it, done) => run(() => api.markRoutine({ date, item: it.id, done, today }));
  const markDevo = (it, read) => run(() => api.markDevotional({ date, item: it.id, read, today }));
  const pray = (p) => run(() => api.setPrayed({ id: p.id, date, prayed: !p.prayed, today }));
  const saveJournal = async () => {
    try {
      const r = await api.routineJournal({ date, text: journal, today });
      setJournal('');
      dialog.toast('Saved to the day’s journal note', 'info', 5000, { label: 'Open', onClick: () => onOpenNote?.(r.note_id) });
    } catch (e) { dialog.toast(e.message, 'error'); }
    onChange();
  };

  const items = data?.items ?? [];
  return (
    <ol className={`rt-list ${compact ? 'is-compact' : ''}`} onClick={openRefClick}>
      {items.map((it) => {
        const isOpen = !compact && open.has(it.id);
        const pd = it.plan;
        const prayDue = it.prayer?.items.filter((p) => !p.extra) ?? [];
        const dv = it.devotional;
        const sub = it.kind === 'devotional' ? (dv?.entry ? dv.entry.title : dv?.note ?? 'No reading this day') : it.kind === 'plan' ? (pd?.refs.length ? pd.refs.join(' · ') : 'Nothing to read this day')
          : it.kind === 'prayer' ? (prayDue.length ? `${prayDue.filter((p) => p.prayed).length} of ${prayDue.length} prayed` : 'Nothing due this day')
            : it.kind === 'journal' ? (it.journal ? 'Written' : 'A line or two about today')
              : [it.minutes ? `${it.minutes} min` : '', it.note].filter(Boolean).join(' · ');
        const tick = it.kind === 'plan' && pd?.refs.length ? () => markPlan(it, null, !it.done)
          : it.kind === 'custom' ? () => markCustom(it, !it.done)
            : it.kind === 'devotional' && dv?.entry ? () => markDevo(it, !it.done)
            : () => (compact ? onOpenWalk?.() : flip(it.id));
        return (
          <li key={it.id} className={`rt-item rt-${it.kind} ${it.done ? 'is-done' : ''} ${isOpen ? 'is-open' : ''}`}>
            <div className="rt-row">
              <Check on={it.done} onClick={tick} label={`${labelOf(it)}: ${it.done ? 'done' : 'not done'}`} />
              <button type="button" className="rt-main" onClick={() => (compact ? onOpenWalk?.() : flip(it.id))} aria-expanded={compact ? undefined : isOpen}>
                <span className="rt-title"><Icon name={KIND_ICON[it.kind]} size={14} /> {labelOf(it)}</span>
                {sub && <span className="rt-sub">{sub}</span>}
              </button>
              {!compact && <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={16} className="rt-caret" />}
            </div>
            {isOpen && it.kind === 'plan' && pd && (
              <ul className="rt-passages">
                {pd.refs.map((ref, i) => {
                  const key = `${it.plan_id}:${i}`;
                  return (
                    <li key={key}>
                      <div className="rt-row is-sub">
                        <Check on={pd.read[i]} onClick={() => markPlan(it, i, !pd.read[i])} label={`${ref}: ${pd.read[i] ? 'read' : 'not read'}`} />
                        <button type="button" className="rt-main" onClick={() => setReading(reading === key ? null : key)}><span className="rt-title">{ref}</span></button>
                        <button type="button" className="btn btn-small" onClick={() => setReading(reading === key ? null : key)}>{reading === key ? 'Close' : 'Read'}</button>
                      </div>
                      {reading === key && (
                        <>
                          <PassageText refText={ref} />
                          {!pd.read[i] && <button type="button" className="btn btn-small btn-primary rt-read-done" onClick={() => { markPlan(it, i, true); const nxt = pd.refs.findIndex((_, j) => j > i && !pd.read[j]); setReading(nxt >= 0 ? `${it.plan_id}:${nxt}` : null); }}>Done reading{pd.refs.some((_, j) => j > i && !pd.read[j]) ? ', next passage' : ''}</button>}
                        </>
                      )}
                    </li>
                  );
                })}
                {!pd.refs.length && <li className="muted">This plan has nothing to read this day.</li>}
              </ul>
            )}
            {isOpen && it.kind === 'devotional' && (
              <div className="rt-body rt-devotional">
                {dv?.entry ? (
                  <>
                    <h3 className="rt-devo-title">{dv.entry.title}</h3>
                    <Scripture className="dw-body rt-devo-body" html={dv.entry.html} />
                    <div className="rt-actions">
                      <span className="rt-devo-credit">{dv.book.author ? `© ${dv.book.author}` : ''}</span>
                      {!dv.read && <button type="button" className="btn btn-small btn-primary" onClick={() => markDevo(it, true)}>Mark read</button>}
                    </div>
                  </>
                ) : <p className="muted">{dv?.note ?? 'This devotional has no reading for this day.'}</p>}
              </div>
            )}
            {isOpen && it.kind === 'prayer' && (
              <div className="rt-body"><PrayerToday day={it.prayer} onToggle={pray} empty="Nothing on your prayer list is due this day." /></div>
            )}
            {isOpen && it.kind === 'journal' && (
              <div className="rt-body">
                <textarea className="input rt-journal" rows={3} value={journal} onChange={(e) => setJournal(e.target.value)} placeholder="What stood out to you today?" />
                <div className="rt-actions">
                  {it.journal && <button type="button" className="btn btn-small" onClick={() => onOpenNote?.(it.journal)}>Open the journal note</button>}
                  <button type="button" className="btn btn-small btn-primary" disabled={!journal.trim() && it.journal} onClick={saveJournal}>{journal.trim() || it.journal ? 'Save' : 'Start today’s note'}</button>
                </div>
              </div>
            )}
            {isOpen && it.kind === 'custom' && (
              <div className="rt-body">
                {it.note && <p className="rt-note">{it.note}</p>}
                <div className="rt-actions">
                  {it.link && <a className="btn btn-small" href={it.link} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> Open the link</a>}
                  {it.minutes && <Timer minutes={it.minutes} onDone={() => { if (!it.done) markCustom(it, true); }} />}
                  {!it.done && <button type="button" className="btn btn-small btn-primary" onClick={() => markCustom(it, true)}>Mark done</button>}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ReadCheck({ on, onClick, big = false, words = ['Read', 'Mark as read', 'Read?'] }) {
  return (
    <button type="button" className={`dw-check ${on ? 'is-on' : ''} ${big ? 'dw-check-big' : ''}`} onClick={onClick} aria-pressed={on}>
      <span className="dw-check-box"><Icon name="check" size={big ? 16 : 14} strokeWidth={3} /></span>
      <span>{on ? words[0] : big ? words[1] : words[2]}</span>
    </button>
  );
}

/**
 * 13.0 (after beta.27): the Walk page shows the routine as cards, as Daily Walk did before it: the prayer list, each
 * devotional in full (a second one is a second card), a reading plan's passages in full, and your own items, each in
 * its own color, in the routine's order. The journal is the page's Journal button, not a card.
 */
/** A card's fold button: the card folds to its header. */
function Fold({ open, onClick, label }) {
  return (
    <button type="button" className="icon-btn rt-fold" onClick={onClick} aria-expanded={open} aria-label={open ? `Fold ${label}` : `Open ${label}`} title={open ? 'Fold' : 'Open'}>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
    </button>
  );
}

export function RoutineCards({ data, date, today, onChange, onSection, onEdit }) {
  const dialog = useDialog();
  // Cards start open until they're done, then fold; a fold or open you pick stays for the visit.
  const [folds, setFolds] = useState(() => new Map());
  const isOpen = (it, done) => (folds.has(it.id) ? folds.get(it.id) : !done);
  const fold = (it, done) => setFolds((m) => new Map(m).set(it.id, !isOpen(it, done)));
  const [shown, setShown] = useState(() => new Set()); // plan passages opened (or hidden) against the item's show_text
  const show = (key) => setShown((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  useEffect(() => { setFolds(new Map()); setShown(new Set()); }, [date]);
  const run = async (fn) => { try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); } onChange(); };
  const markPlan = (it, item, read) => run(() => api.setPlanRead(it.plan_id, { day: it.plan.day, ...(item == null ? {} : { item }), read, today }));
  const markCustom = (it, done) => run(() => api.markRoutine({ date, item: it.id, done, today }));
  const markDevo = (it, read) => run(() => api.markDevotional({ date, item: it.id, read, today }));
  const pray = (p) => run(() => api.setPrayed({ id: p.id, date, prayed: !p.prayed, today }));
  const isToday = date === today;
  const cards = (data?.items ?? []).filter((it) => it.kind !== 'journal');

  return (
    <section className="dw-readings rt-cards" onClick={openRefClick}>
      {cards.map((it) => {
        if (it.kind === 'prayer') {
          const due = it.prayer?.items.filter((p) => !p.extra) ?? [];
          const open = isOpen(it, it.done);
          return (
            <article key={it.id} className={`dw-card dw-card-prayer ${it.done ? 'is-read' : ''} ${open ? '' : 'is-folded'}`}>
              <header className="dw-card-head">
                <Fold open={open} onClick={() => fold(it, it.done)} label="prayers" />
                <div className="dw-card-kicker" onClick={() => fold(it, it.done)}>
                  <span>{it.title || (isToday ? 'Today’s prayers' : 'Prayers')}</span>
                  <span className="dw-card-author">{due.length ? `${due.filter((p) => p.prayed).length} of ${due.length} prayed` : 'Nothing due this day'}</span>
                </div>
                <button type="button" className="btn btn-small" onClick={() => onSection?.('prayer')}>Prayer list <Icon name="chevronRight" size={13} /></button>
              </header>
              {open && <PrayerToday day={it.prayer} onToggle={pray} empty="Nothing on your prayer list was due this day." />}
            </article>
          );
        }
        if (it.kind === 'devotional') {
          const dv = it.devotional;
          const byline = [dv?.book.author, dv?.entry?.num && dv.book.length ? `Day ${dv.entry.num} of ${dv.book.length}` : ''].filter(Boolean).join(' · ');
          const done = it.done && !!dv?.entry;
          const open = isOpen(it, done);
          return (
            <article key={it.id} className={`dw-card dw-card-book ${done ? 'is-read' : ''} ${open ? '' : 'is-folded'}`}>
              <header className="dw-card-head">
                <Fold open={open} onClick={() => fold(it, done)} label="the devotional" />
                <div className="dw-card-kicker" onClick={() => fold(it, done)}>
                  <span>{it.title || dv?.book.title || 'Devotional'}</span>
                  {byline && <span className="dw-card-author">{byline}</span>}
                </div>
                {dv?.entry && <ReadCheck on={dv.read} onClick={() => markDevo(it, !dv.read)} />}
              </header>
              {!open ? null : dv?.entry ? (
                <>
                  <h2 className="dw-title dw-title-refs">{dv.entry.title}</h2>
                  <Scripture className="dw-body" html={dv.entry.html} />
                  <footer className="dw-card-foot">
                    <ReadCheck on={dv.read} onClick={() => markDevo(it, !dv.read)} big />
                    <span className="dw-credit">{dv.book.author ? `© ${dv.book.author}` : ''}</span>
                  </footer>
                </>
              ) : <div className="dw-card-empty"><p>{dv?.note ?? 'This devotional has no reading for this day.'}</p></div>}
            </article>
          );
        }
        if (it.kind === 'plan') {
          const pd = it.plan;
          const all = !!pd?.refs.length && pd.read.every(Boolean);
          const open = isOpen(it, all);
          return (
            <article key={it.id} className={`dw-card rt-card-plan ${all ? 'is-read' : ''} ${open ? '' : 'is-folded'}`}>
              <header className="dw-card-head">
                <Fold open={open} onClick={() => fold(it, all)} label="the reading plan" />
                <div className="dw-card-kicker" onClick={() => fold(it, all)}>
                  <span>{it.title || pd?.title || 'Reading plan'}</span>
                  {pd && pd.day >= 0 && <span className="dw-card-author">Day {pd.day + 1}{pd.refs.length ? ` · ${pd.refs.join(' · ')}` : ''}</span>}
                </div>
                {pd?.refs.length > 0 && <ReadCheck on={all} onClick={() => markPlan(it, null, !all)} />}
              </header>
              {!open ? null : pd?.refs.length ? pd.refs.map((ref, i) => {
                const key = `${it.id}:${i}`;
                const text = !!it.show_text !== shown.has(key);
                return (
                  <div key={ref + i} className={`rt-plan-passage ${text ? 'has-text' : ''}`}>
                    <div className="rt-plan-ref">
                      <h3>{ref}</h3>
                      <span className="rt-plan-ref-acts">
                        <button type="button" className="btn btn-small" onClick={() => show(key)} aria-expanded={text}>{text ? 'Hide text' : 'Read here'}</button>
                        <ReadCheck on={pd.read[i]} onClick={() => markPlan(it, i, !pd.read[i])} />
                      </span>
                    </div>
                    {text && <PassageText refText={ref} />}
                  </div>
                );
              }) : <div className="dw-card-empty"><p>{pd ? 'This plan has nothing to read this day.' : 'This reading plan was removed.'}</p></div>}
              {open && pd?.refs.length > 0 && (
                <footer className="dw-card-foot">
                  <ReadCheck on={all} onClick={() => markPlan(it, null, !all)} big words={['All read', 'Mark all read', 'Read?']} />
                  <label className="rt-show-text" title="Show each passage's text on this card every day">
                    <input type="checkbox" checked={!!it.show_text} onChange={(e) => { setShown(new Set()); run(() => api.updateRoutineItem(it.id, { show_text: e.target.checked })); }} /> Always show the text
                  </label>
                  <button type="button" className="btn btn-small" onClick={() => onSection?.('plans')}>Plans <Icon name="chevronRight" size={13} /></button>
                </footer>
              )}
            </article>
          );
        }
        // Your own item: a memory verse, quiet time, a chapter of a book. It folds only when it has something to fold.
        const body = !!(it.note || it.link || it.minutes);
        const open = body && isOpen(it, it.done);
        return (
          <article key={it.id} className={`dw-card rt-card-custom ${it.done ? 'is-read' : ''} ${open || !body ? '' : 'is-folded'}`}>
            <header className="dw-card-head">
              {body && <Fold open={open} onClick={() => fold(it, it.done)} label={it.title || 'the item'} />}
              <div className="dw-card-kicker" onClick={body ? () => fold(it, it.done) : undefined}>
                <span>{it.title || 'Item'}</span>
                {it.minutes && <span className="dw-card-author">{it.minutes} minutes</span>}
              </div>
              <ReadCheck on={it.done} onClick={() => markCustom(it, !it.done)} words={['Done', 'Mark done', 'Done?']} />
            </header>
            {open && it.note && <p className="rt-card-note">{it.note}</p>}
            {open && (it.link || it.minutes) && (
              <div className="dw-card-actions">
                {it.link && <a className="btn btn-small" href={it.link} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> Open the link</a>}
                {it.minutes && <Timer minutes={it.minutes} onDone={() => { if (!it.done) markCustom(it, true); }} />}
              </div>
            )}
          </article>
        );
      })}
      <button type="button" className="dw-prayer-invite rt-add-card" onClick={onEdit}>
        <Icon name="plus" size={18} />
        <span><strong>Add to your routine.</strong> Your prayer list, a devotional (EPUB), a reading plan, or something of your own.</span>
        <Icon name="chevronRight" size={16} />
      </button>
    </section>
  );
}

/** The Walk page's Journal button: a line or two into the day's journal note, or the note itself. */
export function JournalDialog({ date, today, journalId, onOpenNote, close }) {
  const dialog = useDialog();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (open) => {
    setBusy(true);
    try {
      const r = await api.routineJournal({ date, text: open ? '' : text, today });
      close(true);
      if (open) onOpenNote?.(r.note_id);
      else dialog.toast('Saved to the day’s journal note', 'info', 5000, { label: 'Open', onClick: () => onOpenNote?.(r.note_id) });
    } catch (e) { dialog.toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <form className="rt-journal-dialog" onSubmit={(e) => { e.preventDefault(); if (text.trim()) save(false); }}>
      <div className="dialog-header">
        <h2>Journal</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <textarea className="input rt-journal" rows={5} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What stood out to you today?" />
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>{journalId ? 'Open the journal note' : 'Write in a note instead'}</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>Save</button>
      </div>
    </form>
  );
}

/** Setting up the routine: its items in order, what each is, and the daily reminder. Resolves when closed. */
export function RoutineDialog({ close }) {
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [books, setBooks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const [adding, setAdding] = useState(null); // { kind, title, plan_id, link, note, minutes }
  const today = new Date().toLocaleDateString('en-CA');
  const load = useCallback(() => api.routine(today, today).then(setData).catch((e) => dialog.toast(e.message, 'error')), [dialog, today]);
  const loadBooks = useCallback(() => api.dailyWalkBooks().then((r) => setBooks(r.books ?? [])).catch(() => {}), []);
  useEffect(() => { load(); loadBooks(); api.plans(today).then((l) => setPlans(l.filter((p) => p.status === 'active'))).catch(() => {}); }, [load, loadBooks, today]);
  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const b = await api.addDailyWalkBook(file, today);
      await api.addRoutineItem({ kind: 'devotional', book_id: b.id });
      dialog.toast(`Added ${b.title}`);
      loadBooks();
    } catch (e) { dialog.toast(e.message, 'error'); }
    setUploading(false);
    load();
  };
  const items = data?.items ?? [];
  const has = (kind) => items.some((x) => x.kind === kind);
  const act = async (fn) => { try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); } load(); };
  const move = (i, by) => act(() => { const ids = items.map((x) => x.id); [ids[i], ids[i + by]] = [ids[i + by], ids[i]]; return api.orderRoutine(ids); });
  const add = (kind, extra = {}) => act(() => api.addRoutineItem({ kind, ...extra }));
  const reminderRef = useRef(null);

  return (
    <div className="rt-dialog">
      <div className="dialog-header">
        <h2>Your routine</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">What you do each day, in order. Nothing is required: add what helps and leave out what doesn’t.</p>
      <ol className="rt-edit">
        {items.map((it, i) => (
          <li key={it.id}>
            <Icon name={KIND_ICON[it.kind]} size={15} />
            <input className="input rt-edit-name" defaultValue={it.title} placeholder={labelOf({ ...it, title: '' })} aria-label="Name"
              onBlur={(e) => e.target.value !== it.title && act(() => api.updateRoutineItem(it.id, { title: e.target.value }))} />
            {it.kind === 'plan' && (
              <label className="rt-edit-text" title="Show each passage's text on the Walk card (otherwise the references, each with Read here)">
                <input type="checkbox" checked={!!it.show_text} onChange={(e) => act(() => api.updateRoutineItem(it.id, { show_text: e.target.checked }))} /> Show text
              </label>
            )}
            {it.kind === 'custom' && (
              <input className="input rt-edit-min" type="number" min="1" max="240" defaultValue={it.minutes ?? ''} placeholder="Timer" aria-label="Timer minutes"
                onBlur={(e) => String(it.minutes ?? '') !== e.target.value && act(() => api.updateRoutineItem(it.id, { minutes: e.target.value }))} />
            )}
            <span className="rt-edit-moves">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="arrowUp" size={14} /></button>
              <button type="button" className="icon-btn" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="arrowDown" size={14} /></button>
              <button type="button" className="icon-btn" onClick={() => act(() => api.deleteRoutineItem(it.id))} aria-label={`Remove ${labelOf(it)}`}><Icon name="trash" size={14} /></button>
            </span>
          </li>
        ))}
        {!items.length && data && <li className="muted">Nothing yet. Add something below.</li>}
      </ol>

      <h3 className="rt-h">Add</h3>
      <div className="rt-add">
        {plans.filter((p) => !items.some((x) => x.plan_id === p.id)).map((p) => (
          <button key={p.id} type="button" className="btn btn-small" onClick={() => add('plan', { plan_id: p.id })}><Icon name="book" size={13} /> {p.title}</button>
        ))}
        {books.filter((b) => !items.some((x) => x.book_id === b.id)).map((b) => (
          <button key={b.id} type="button" className="btn btn-small" onClick={() => add('devotional', { book_id: b.id })}><Icon name="sunrise" size={13} /> {b.title}</button>
        ))}
        <button type="button" className="btn btn-small" disabled={uploading} onClick={() => fileRef.current?.click()}><Icon name="upload" size={13} /> {uploading ? 'Adding…' : 'Devotional (EPUB)…'}</button>
        <input ref={fileRef} type="file" accept=".epub,application/epub+zip" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        {!has('prayer') && <button type="button" className="btn btn-small" onClick={() => add('prayer')}><Icon name="heart" size={13} /> Prayer list</button>}
        <button type="button" className="btn btn-small" onClick={() => setAdding({ kind: 'custom', title: '', link: '', note: '', minutes: '' })}><Icon name="plus" size={13} /> Something else…</button>
      </div>
      {!plans.length && <p className="muted rt-hint">Start a reading plan (Walk → Plans) to add its daily passages here.</p>}
      <p className="muted rt-hint">A devotional is a DRM-free EPUB of your own: each day shows that day’s reading in full.</p>
      {adding && (
        <form className="rt-custom" onSubmit={(e) => { e.preventDefault(); add('custom', adding); setAdding(null); }}>
          <input className="input" autoFocus value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} placeholder="What is it? (memory verse, quiet time, a book chapter)" aria-label="Name" />
          <input className="input" value={adding.link} onChange={(e) => setAdding({ ...adding, link: e.target.value })} placeholder="Link (optional)" aria-label="Link" />
          <input className="input" value={adding.note} onChange={(e) => setAdding({ ...adding, note: e.target.value })} placeholder="Note (optional)" aria-label="Note" />
          <input className="input" type="number" min="1" max="240" value={adding.minutes} onChange={(e) => setAdding({ ...adding, minutes: e.target.value })} placeholder="Timer in minutes (optional)" aria-label="Timer" />
          <div className="rt-actions"><button type="button" className="btn btn-small" onClick={() => setAdding(null)}>Cancel</button><button className="btn btn-small btn-primary" disabled={!adding.title.trim()}>Add</button></div>
        </form>
      )}

      <h3 className="rt-h">Daily reminder</h3>
      <div className="rt-reminder">
        <input ref={reminderRef} className="input" type="time" defaultValue={data?.reminder ?? ''} key={data?.reminder ?? 'none'} aria-label="Reminder time" />
        <button type="button" className="btn btn-small" onClick={() => act(async () => { await api.setRoutineReminder(reminderRef.current.value || null); dialog.toast(reminderRef.current.value ? 'Daily reminder set' : 'Daily reminder off'); })}>Save</button>
        {data?.reminder && <button type="button" className="link-btn" onClick={() => act(() => api.setRoutineReminder(null))}>Turn off</button>}
      </div>
      <p className="muted rt-hint">A notification each day at this time while the routine isn’t finished (turn on notifications in Settings → General).</p>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}
