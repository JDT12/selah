import { useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { adminApi } from './adminApi.js';
import {
  Badge, Card, ErrorNote, ago, day, useLoad, when,
} from './common.jsx';

/**
 * The monthly server maintenance reminder (server/admin/maintenance.js): the banner across the console, the Overview
 * card with the server's patch status, the checklist for marking it done, and the schedule in Settings.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], ['last', 'Last']];
/** "2026-10-27" → "Tuesday, October 27" (a calendar day, so no time zone shift). */
const longDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const scheduleText = ({ week, weekday }) => `${WEEKS.find(([w]) => w === week)?.[1] ?? week} ${WEEKDAYS[weekday]} of every month`;

function inDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** What the reminder says at each stage. */
function headline(m) {
  if (m.stage === 'soon') return `Server maintenance is coming up ${inDays(m.days)}, on ${longDay(m.due)}.`;
  if (m.stage === 'today') return 'Server maintenance is due today.';
  if (m.stage === 'overdue') return `Server maintenance is ${-m.days} day${m.days === -1 ? '' : 's'} overdue (it was due ${longDay(m.due)}).`;
  return `Next server maintenance: ${longDay(m.due)}.`;
}
const STAGE_BADGE = {
  done: ['good', 'Done this month'], soon: ['busy', 'Coming up'], today: ['warn', 'Due today'], overdue: ['bad', 'Overdue'],
};

/** The checklist, an optional note, and Mark done. Resolves with the new maintenance info, or null. */
function MaintenanceDialog({ m, overview, close }) {
  const dialog = useDialog();
  const [checks, setChecks] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const p = m.patch;
  const backup = overview?.backup?.last;
  const t = overview?.tenants;
  const hint = {
    backup: overview && (!overview.backup.configured ? 'The host backup isn’t set up.'
      : backup ? `Last backup ${ago(backup.finishedAt)}${backup.ok ? '' : ' (failed)'}.` : 'No backup yet.'),
    upgrade: p && p.updates != null && (p.updates ? `${p.updates} update${p.updates === 1 ? '' : 's'} waiting, ${p.security} for security.` : 'Nothing waiting when last checked.'),
    reboot: p && (p.rebootRequired ? `The server is asking for a reboot${p.rebootPackages.length ? ` (${p.rebootPackages.slice(0, 3).join(', ')})` : ''}.` : `No reboot needed. Up since ${when(p.bootedAt)}.`),
    tenants: t && `${t.healthy} of ${t.active} running tenants answering.`,
  };
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); dialog.toast('Copied'); } catch { /* select it instead */ }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      close(await adminApi.maintenanceDone(checks, note));
    } catch (err) {
      if (err.status !== 403) setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form adm-dialog adm-mt-dialog" onSubmit={submit}>
      <h2>Server Maintenance</h2>
      <p className="muted">On the server (SSH in, then <code>cd ~/selah</code>), tick each step as you go. Steps you skip are fine; the history shows what was done. Every step, with what to check and what to do if something doesn’t come back: <a href="#docs/procedure" onClick={() => close(false)}>Docs → Maintenance Procedure</a>.</p>
      <ul className="adm-mt-checks">
        {m.checks.map((c) => (
          <li key={c.key}>
            <label>
              <input type="checkbox" checked={!!checks[c.key]} onChange={(e) => setChecks({ ...checks, [c.key]: e.target.checked })} />
              <span>
                {c.label}
                {hint[c.key] && <span className="muted adm-mt-hint">{hint[c.key]}</span>}
              </span>
            </label>
            {c.command && (
              <span className="adm-mt-cmd">
                <code>{c.command}</code>
                <button type="button" className="icon-btn" title="Copy" aria-label={`Copy ${c.command}`} onClick={() => copy(c.command)}><Icon name="copy" size={13} /></button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <label className="field-label" htmlFor="mt-note">Note (optional)</label>
      <textarea id="mt-note" className="input" rows={3} maxLength={2000} placeholder="e.g. Kernel update, rebooted; all tenants back in 40 s" value={note} onChange={(e) => setNote(e.target.value)} />
      <ErrorNote error={error} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Mark done'}</button>
      </div>
    </form>
  );
}

export function useMaintenanceActions(overview, onChange) {
  const dialog = useDialog();
  return {
    start: async (m) => {
      const r = await dialog.open((c) => <MaintenanceDialog m={m} overview={overview} close={c} />);
      if (r) { dialog.toast(`Maintenance marked done. Next: ${shortDay(r.due)}`); onChange(); }
    },
    snooze: async (m, days) => {
      try {
        await adminApi.maintenanceSnooze(addDays(m.today, days));
        onChange();
      } catch (e) { if (e.status !== 403) dialog.toast(e.message, 'error'); }
    },
  };
}

/** Across the top of every page from a week before until it's marked done (unless snoozed). */
export function MaintenanceBanner({ overview, reload }) {
  const m = overview?.maintenance;
  const act = useMaintenanceActions(overview, reload);
  const [snoozing, setSnoozing] = useState(false);
  if (!m || m.stage === 'done' || m.snoozed) return null;
  const kind = { soon: 'is-soon', today: 'is-due', overdue: 'is-overdue' }[m.stage];
  const options = m.stage === 'soon'
    ? [[Math.max(1, m.days), `Until ${shortDay(m.due)}`]]
    : [[1, 'Until tomorrow'], [3, 'For 3 days'], [7, 'For a week']];
  return (
    <div className={`adm-mt-banner ${kind}`} role="status">
      <Icon name={m.stage === 'soon' ? 'calendar' : 'alert'} size={16} />
      <span>{headline(m)}{m.stage !== 'soon' && ' Install updates, reboot if needed, then mark it done.'}</span>
      {snoozing ? (
        <span className="adm-actions">
          {options.map(([d, label]) => <button key={d} className="btn btn-small" onClick={() => { setSnoozing(false); act.snooze(m, d); }}>{label}</button>)}
          <button className="icon-btn" aria-label="Cancel" onClick={() => setSnoozing(false)}><Icon name="x" size={14} /></button>
        </span>
      ) : (
        <span className="adm-actions">
          <button className="btn btn-small btn-primary" onClick={() => act.start(m)}>{m.stage === 'soon' ? 'Do it now' : 'Start'}</button>
          <button className="btn btn-small" onClick={() => setSnoozing(true)}>{m.stage === 'soon' ? 'Hide' : 'Snooze'}</button>
        </span>
      )}
    </div>
  );
}

/** The Overview card: when, the server's patches, and the history. */
export function MaintenanceCard({ overview, reload }) {
  const dialog = useDialog();
  const m = overview.maintenance;
  const act = useMaintenanceActions(overview, reload);
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const p = m.patch;
  const [badge, label] = STAGE_BADGE[m.stage];
  const recheck = async () => {
    setChecking(true);
    try { await adminApi.maintenance(true); reload(); } catch (e) { dialog.toast(e.message, 'error'); }
    setChecking(false);
  };
  const log = showAll ? m.log : m.log.slice(0, 3);
  return (
    <Card title="Server Maintenance" icon="calendar" className="adm-wide"
      actions={<button className={`btn btn-small ${m.stage === 'done' ? '' : 'btn-primary'}`} onClick={() => act.start(m)}>Mark done…</button>}>
      <p className="adm-status"><Badge kind={badge}>{label}</Badge>{m.snoozed && <span className="muted"> · banner snoozed until {shortDay(m.snoozed)}</span>}</p>
      <p>{headline(m)}</p>
      <p className="muted">{scheduleText(m.schedule)} (change it in Settings). {m.lastDone ? `Last done ${shortDay(m.lastDone)}.` : 'Not done here yet.'}</p>

      {p && (
        <>
          <h3>This server</h3>
          <dl className="adm-facts">
            <dt>System</dt><dd>{p.os ?? 'Linux'} · kernel {p.kernel}</dd>
            <dt>Updates</dt>
            <dd>{p.updates == null ? <span className="muted">Can’t tell (no apt-check)</span>
              : p.updates === 0 ? 'None waiting'
                : <span className={p.security ? 'is-bad' : ''}>{p.updates} waiting{p.security ? `, ${p.security} for security` : ''}</span>}</dd>
            <dt>Reboot</dt>
            <dd>{p.rebootRequired ? <span className="is-bad">Needed{p.rebootPackages.length ? ` (${p.rebootPackages.slice(0, 4).join(', ')})` : ''}</span> : 'Not needed'} · up since {when(p.bootedAt)}</dd>
            <dt>Last apt run</dt><dd>{p.lastAptRun ? `${when(p.lastAptRun)} (${ago(p.lastAptRun)})` : '–'}</dd>
            <dt>Automatic</dt><dd>{p.unattended == null ? '–' : p.unattended ? 'Security updates install themselves daily' : <span className="is-bad">Automatic security updates are off</span>}</dd>
          </dl>
          <p className="muted adm-hint">Checked {ago(p.checkedAt)} · <button className="link-btn" disabled={checking} onClick={recheck}>{checking ? 'Checking…' : 'Check now'}</button></p>
        </>
      )}

      {m.log.length > 0 && (
        <>
          <h3>History</h3>
          <ul className="adm-list adm-mt-log">
            {log.map((e) => (
              <li key={e.at}>
                <strong>{day(e.at)}</strong>
                <span className="muted">
                  {m.checks.filter((c) => e.checks[c.key]).map((c) => c.key === 'upgrade' ? 'updates' : c.key).join(', ') || 'no steps ticked'}
                  {e.note && <> · {e.note}</>}
                </span>
              </li>
            ))}
          </ul>
          {m.log.length > 3 && <button className="link-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${m.log.length}`}</button>}
        </>
      )}
    </Card>
  );
}

/** Settings: which day of the month. */
export function MaintenanceSchedule() {
  const dialog = useDialog();
  const { data: m, error, reload } = useLoad(() => adminApi.maintenance(), []);
  if (!m) return <Card title="Server Maintenance" icon="calendar" className="adm-wide">{error ? <ErrorNote error={error} /> : <div className="adm-loading" />}</Card>;
  const save = async (patch) => {
    try {
      const r = await adminApi.maintenanceSchedule({ ...m.schedule, ...patch });
      reload();
      dialog.toast(`Saved. Next: ${longDay(r.due)}`);
    } catch (e) { if (e.status !== 403) dialog.toast(e.message, 'error'); }
  };
  return (
    <Card title="Server Maintenance" icon="calendar" className="adm-wide">
      <p className="muted">A monthly reminder to patch the server: a notice from {m.leadDays} days before, then a banner from the day until it’s marked done.</p>
      <div className="adm-inline">
        <select className="input" aria-label="Week of the month" value={String(m.schedule.week)} onChange={(e) => save({ week: e.target.value === 'last' ? 'last' : Number(e.target.value) })}>
          {WEEKS.map(([w, label]) => <option key={w} value={String(w)}>{label}</option>)}
        </select>
        <select className="input" aria-label="Day of the week" value={m.schedule.weekday} onChange={(e) => save({ weekday: Number(e.target.value) })}>
          {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <span className="muted">of every month</span>
      </div>
      <p className="muted adm-hint">{m.stage === 'done' ? 'Next' : 'This month’s'}: {longDay(m.due)}.</p>
    </Card>
  );
}

// datetime-local values are in this browser's time zone; the notice keeps epoch ms.
const pad = (n) => String(n).padStart(2, '0');
const toLocal = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocal = (s) => (s ? new Date(s).getTime() : null);
const stamp = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The Overview card for the users' banner (server/admin/notice.js): when maintenance starts and ends, when the banner
 * starts showing, a note, and whether it's on. Saving sends it to every tenant.
 */
export function NoticeCard({ overview }) {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.notice(), []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Card title="Notice for Users" icon="alert" className="adm-wide">{error ? <ErrorNote error={error} /> : <div className="adm-loading" />}</Card>;
  // A blank notice starts from this month's maintenance day, 9 PM to 10 PM, shown from now.
  const due = overview?.maintenance?.due;
  const f = form ?? (data.start
    ? { on: data.on, start: toLocal(data.start), end: toLocal(data.end), showFrom: toLocal(data.showFrom), message: data.message }
    : { on: false, start: due ? `${due}T21:00` : '', end: due ? `${due}T22:00` : '', showFrom: toLocal(Date.now()), message: '' });
  const set = (patch) => setForm({ ...f, ...patch });
  const now = Date.now();
  const startMs = fromLocal(f.start);
  const endMs = fromLocal(f.end) ?? (startMs ? startMs + 4 * 3600_000 : null);
  const status = !data.on ? ['neutral', 'Off'] : (data.end ?? data.start + 4 * 3600_000) <= now ? ['neutral', 'Over']
    : data.showFrom && data.showFrom > now ? ['busy', `Shows from ${stamp(data.showFrom)}`] : ['warn', 'Showing to users'];
  const save = async (patch = {}) => {
    const next = { ...f, ...patch };
    setBusy(true);
    try {
      const r = await adminApi.saveNotice({ on: next.on, start: fromLocal(next.start), end: fromLocal(next.end), showFrom: fromLocal(next.showFrom), message: next.message });
      setForm(null);
      reload();
      dialog.toast(`${r.notice.on ? 'Notice on' : 'Notice off'}. Sent to ${r.sent} tenant${r.sent === 1 ? '' : 's'}${r.failed ? ` (${r.failed} not answering; they get it when they’re back)` : ''}.`);
    } catch (e) { if (e.status !== 403) dialog.toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Card title="Notice for Users" icon="alert" className="adm-wide"
      actions={<Badge kind={status[0]}>{status[1]}</Badge>}>
      <p className="muted">A banner across Selah for everyone, saying when it will be down for maintenance. Times are in this browser’s time zone; each person sees them in theirs.</p>
      <div className="adm-notice-grid">
        <label><span className="field-label">Maintenance starts</span>
          <input className="input" type="datetime-local" value={f.start} onChange={(e) => set({ start: e.target.value })} /></label>
        <label><span className="field-label">Ends (optional)</span>
          <input className="input" type="datetime-local" value={f.end} onChange={(e) => set({ end: e.target.value })} /></label>
        <label><span className="field-label">Show the banner from</span>
          <input className="input" type="datetime-local" value={f.showFrom} onChange={(e) => set({ showFrom: e.target.value })} /></label>
      </div>
      <label><span className="field-label">Note (optional)</span>
        <input className="input" maxLength={300} placeholder="Updates to the server; your notes are safe." value={f.message} onChange={(e) => set({ message: e.target.value })} /></label>
      <p className="muted adm-hint">{startMs ? `The banner shows ${f.showFrom ? `from ${stamp(fromLocal(f.showFrom))}` : 'right away'} until ${stamp(endMs)}${f.end ? '' : ' (4 hours after the start)'}.` : 'Choose when maintenance starts.'}</p>
      <div className="adm-inline adm-notice-actions">
        {data.on && <button className="btn" disabled={busy} onClick={() => save({ on: false })}>Turn off</button>}
        <button className="btn btn-primary" disabled={busy || !startMs} onClick={() => save({ on: true })}>{data.on ? 'Save and send' : 'Turn on and send'}</button>
      </div>
    </Card>
  );
}
