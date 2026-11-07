import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../live.js';
import { useDialog, Menu } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import WalkTabs from './WalkTabs.jsx';
import Scripture, { openRefClick } from '../components/Scripture.jsx';
import { Credit, TranslationPicker, useBible } from '../components/TranslationPicker.jsx';
import { biblePassage, passageCardHtml } from '../esv.js';
import { dateOf } from '../../../shared/readingPlans.js';
import { todayStr } from '../time.js';
import {
  NewPlanDialog, PlanScheduleDialog, download, downloadTemplate, fileName, fmtDay, plural, weekdaysLabel,
} from '../components/PlanDialogs.jsx';
import { planToCsv } from '../../../shared/readingPlans.js';

/** One passage of the day: a tick, its name, and its text in your translation when opened. */
export function PlanPassage({ item, onToggle, bible }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ data: null, error: null });
  const { connected, tr } = bible;
  useEffect(() => {
    if (!open || !connected) return undefined;
    let live = true;
    setState({ data: null, error: null });
    biblePassage(item.ref, tr).then((data) => live && setState({ data, error: null })).catch((e) => live && setState({ data: null, error: e.message }));
    return () => { live = false; };
  }, [open, connected, tr, item.ref]);
  return (
    <li className={`rplan-passage ${item.read ? 'is-read' : ''} ${open ? 'is-open' : ''}`}>
      <div className="rplan-passage-row">
        <input type="checkbox" checked={item.read} onChange={() => onToggle(!item.read)} aria-label={`${item.ref} read`} />
        <button type="button" className="rplan-passage-ref" onClick={() => setOpen(!open)} aria-expanded={open}>
          {item.ref}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
      </div>
      {open && (
        <div className="rplan-passage-text">
          {connected === false ? <p className="muted">Connect a Bible in Settings → Connections → Bible to read it here.</p>
            : state.error ? <p className="muted">{state.error}</p>
              : !state.data ? <p className="muted">Loading…</p>
                : <div className="esv-card-body" dangerouslySetInnerHTML={{ __html: passageCardHtml(state.data.text) }} />}
          <Credit passage={state.data} />
          {state.data && !item.read && (
            <button type="button" className="btn btn-small" onClick={() => { onToggle(true); setOpen(false); }}><Icon name="check" size={13} /> Mark read</button>
          )}
        </div>
      )}
    </li>
  );
}

/** A plan's card: where you are, today's passages, and catching up. */
function PlanCard({ plan, bible, onChanged, dialog }) {
  const [catching, setCatching] = useState(false);
  const today = todayStr();
  const run = async (fn, done) => {
    try {
      await fn();
      if (done) dialog.toast(done);
      onChanged();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const tick = (day, item, read) => run(() => api.setPlanRead(plan.id, { day, item, read, today }));
  const pct = plan.progress.total ? Math.round((plan.progress.read / plan.progress.total) * 100) : 0;
  const paused = plan.status === 'paused';
  const rename = async () => {
    const title = await dialog.prompt({ title: 'Rename plan', value: plan.title, okLabel: 'Rename' });
    if (title?.trim()) run(() => api.updatePlan(plan.id, { title: title.trim(), today }));
  };
  const restart = async () => {
    if (await dialog.confirm({ title: `Start “${plan.title}” over?`, message: 'Day 1 becomes today, and the passages you’ve ticked are cleared.', okLabel: 'Start over' })) {
      run(() => api.restartPlan(plan.id, today), 'Started over at day 1');
    }
  };
  const remove = async () => {
    if (await dialog.confirm({ title: `Delete “${plan.title}”?`, message: 'The plan and what you’ve ticked go. Your journal notes stay.', okLabel: 'Delete', danger: true })) {
      run(() => api.deletePlan(plan.id), 'Plan deleted');
    }
  };
  const csv = async () => {
    try {
      const full = await api.plan(plan.id, today);
      download(fileName(plan.title), planToCsv(full.schedule.map((d) => d.map((x) => x.ref))));
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const schedule = () => dialog.open((close) => <PlanScheduleDialog planId={plan.id} close={close} />).then(onChanged);
  const nextDate = plan.next != null ? dateOf(plan, plan.next) : null;

  return (
    <section className={`dw-card rplan-card ${paused ? 'is-paused' : ''}`}>
      <header className="dw-card-head">
        <div className="dw-card-kicker">
          <span>{plan.title}</span>
          <span className="dw-card-author">
            {plan.finished ? 'Finished' : plan.notStarted ? `Starts ${fmtDay(plan.start_date, { weekday: 'long', month: 'long', day: 'numeric' })}`
              : `Day ${Math.min(plan.day, plan.days - 1) + 1} of ${plan.days}`}
            {paused ? ' · paused' : ''}
          </span>
        </div>
        <Menu align="right" trigger={({ toggle }) => (
          <button type="button" className="icon-btn" onClick={toggle} aria-label={`More for ${plan.title}`} title="More"><Icon name="more" size={16} /></button>
        )} items={[
          { label: 'See the whole plan', onClick: schedule },
          { label: 'Rename…', onClick: rename },
          { label: paused ? 'Resume' : 'Pause', onClick: () => run(() => api.updatePlan(plan.id, { status: paused ? 'active' : 'paused', today })) },
          { label: 'Download as CSV', onClick: csv },
          'sep',
          { label: 'Start over…', onClick: restart },
          { label: 'Delete plan…', danger: true, onClick: remove },
        ]} />
      </header>
      <div className="rplan-progress" title={`${plan.progress.read} of ${plan.progress.total} passages read`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="rplan-meta muted">{pct}% read · {weekdaysLabel(plan.weekdays)}</p>

      {!paused && plan.behindCount > 0 && (
        <div className="rplan-behind">
          <Icon name="clock" size={15} />
          <span>You’re {plural(plan.behindCount, 'day')} behind</span>
          <button type="button" className="btn btn-small" onClick={() => setCatching(!catching)} aria-expanded={catching}>{catching ? 'Hide' : 'Catch up'}</button>
          <button type="button" className="btn btn-small" title="Today picks up where you left off; the rest of the plan moves later"
            onClick={() => run(() => api.shiftPlan(plan.id, today), 'Shifted: today picks up where you left off')}>Shift dates</button>
        </div>
      )}
      {!paused && catching && plan.behind.map((d) => (
        <div key={d.day} className="rplan-day is-behind">
          <div className="rplan-day-head">
            <span>Day {d.day + 1} · {fmtDay(dateOf(plan, d.day))}</span>
            <button type="button" className="link-btn" onClick={() => tick(d.day, null, true)}>Mark day read</button>
          </div>
          <ul className="rplan-passages">{d.items.map((x) => <PlanPassage key={x.i} item={x} bible={bible} onToggle={(read) => tick(d.day, x.i, read)} />)}</ul>
        </div>
      ))}
      {!paused && catching && plan.behindCount > plan.behind.length && <p className="muted">And {plural(plan.behindCount - plan.behind.length, 'more day')}: see the whole plan.</p>}

      {!paused && plan.today && (
        <div className="rplan-day">
          <div className="rplan-day-head">
            <span>Today{plan.today.items.every((x) => x.read) ? ' · done' : ''}</span>
            {!plan.today.items.every((x) => x.read) && <button type="button" className="link-btn" onClick={() => tick(plan.today.day, null, true)}>Mark all read</button>}
          </div>
          <ul className="rplan-passages">{plan.today.items.map((x) => <PlanPassage key={x.i} item={x} bible={bible} onToggle={(read) => tick(plan.today.day, x.i, read)} />)}</ul>
        </div>
      )}
      {!paused && !plan.today && !plan.finished && (
        <p className="muted rplan-rest">
          {plan.notStarted ? 'Nothing to read yet.' : 'No reading today.'}
          {nextDate && !plan.notStarted ? ` Next: day ${plan.next + 1}, ${fmtDay(nextDate, { weekday: 'long', month: 'short', day: 'numeric' })}.` : ''}
        </p>
      )}
      {plan.finished && (
        <div className="rplan-finished">
          <Icon name="check" size={16} /> You finished this plan.
          <button type="button" className="btn btn-small" onClick={restart}>Start over</button>
        </div>
      )}
    </section>
  );
}

/**
 * Home's reading plan card (10.2): each active plan's passages for today with a tick apiece (the references open
 * their hover cards), a note when you're behind, and a way to the Plans tab. Nothing shows without a plan.
 */
export function HomePlans({ onOpen }) {
  const dialog = useDialog();
  const [plans, setPlans] = useState(null);
  const load = useCallback(() => api.plans(todayStr()).then(setPlans).catch(() => setPlans([])), []);
  useEffect(() => { load(); return onLive(load); }, [load]);
  const shown = (plans ?? []).filter((p) => p.status === 'active' && (p.today || p.behindCount));
  if (!shown.length) return null;
  const tick = async (p, day, item, read) => {
    try { await api.setPlanRead(p.id, { day, item, read, today: todayStr() }); load(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  return (
    <section className="home-card-panel home-plans" aria-labelledby="home-plans-h" onClick={openRefClick}>
      <div className="home-section-head">
        <h2 id="home-plans-h">Reading plan{shown.length === 1 ? '' : 's'}</h2>
        <button type="button" className="link-btn" onClick={onOpen}>Open Plans</button>
      </div>
      {shown.map((p) => (
        <div key={p.id} className="home-plan">
          <div className="home-plan-head">
            <span className="home-plan-title">{p.title}</span>
            <span className="muted">{p.today ? `Day ${p.today.day + 1} of ${p.days}` : 'No reading today'}{p.behindCount ? ` · ${plural(p.behindCount, 'day')} behind` : ''}</span>
          </div>
          {p.today && (
            <ul className="home-plan-list">
              {p.today.items.map((x) => (
                <li key={x.i} className={x.read ? 'is-read' : ''}>
                  <input type="checkbox" checked={x.read} onChange={() => tick(p, p.today.day, x.i, !x.read)} aria-label={`${x.ref} read`} />
                  <Scripture as="span" text={x.ref} className="home-plan-ref" />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

/** Walk's Plans tab (10.2): your reading plans, today's passages in your translation, and a journal for the day. */
export default function PlansPage({ onOpenNote, onMenu, onSection }) {
  const dialog = useDialog();
  const bible = useBible('plans');
  const [plans, setPlans] = useState(null);
  const load = useCallback(() => api.plans(todayStr()).then(setPlans).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); return onLive(load); }, [load]);
  const add = async (initial = null) => {
    const p = await dialog.open((close) => <NewPlanDialog initial={initial} close={close} />);
    if (p) { dialog.toast(`Started ${p.title}`); load(); }
  };
  const journal = async () => {
    try { onOpenNote((await api.dailyWalkJournal(todayStr())).id); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const active = (plans ?? []).filter((p) => p.status !== 'archived');
  const read = active.flatMap((p) => p.today?.items ?? []);

  return (
    <div className="page dw-page plans-page" onClick={openRefClick}>
      <header className="page-header dw-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Reading Plans</h1>
          <p className="muted">
            {fmtDay(todayStr(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {read.length > 0 && read.every((x) => x.read) && <span className="dw-done"><Icon name="checkCircle" size={15} /> Today’s reading is done</span>}
          </p>
        </div>
        <div className="page-actions">
          {active.length > 0 && <TranslationPicker bible={bible} className="plans-tr" />}
          <button className="btn" onClick={journal} title="Write about today’s reading in a note (the same journal note as Daily Walk)"><Icon name="pen" size={15} /> Journal</button>
          <button className="btn btn-primary" onClick={() => add()}><Icon name="plus" size={15} /> New plan</button>
        </div>
      </header>
      <WalkTabs tab="plans" onSection={onSection} />

      {plans && !active.length && (
        <section className="plans-empty">
          <h2>Read through the Bible with a plan</h2>
          <p className="muted">Pick one of these, build your own from the books you choose, or import one from a spreadsheet. Today’s passages show here and on Home, in your translation.</p>
          <div className="plans-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => add()}>Choose a plan</button>
            <button type="button" className="btn" onClick={() => add('build')}>Build your own</button>
            <button type="button" className="btn" onClick={() => add('import')}>Import a CSV</button>
            <button type="button" className="link-btn" onClick={downloadTemplate}><Icon name="download" size={13} /> CSV template</button>
          </div>
        </section>
      )}
      {active.map((p) => <PlanCard key={p.id} plan={p} bible={bible} dialog={dialog} onChanged={load} />)}
    </div>
  );
}
