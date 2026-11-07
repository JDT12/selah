import { useEffect, useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { adminApi } from './adminApi.js';
import {
  Badge, ErrorNote, JobRow, LinkBox, Meter, ago, mb, plural, size, useLoad, waitForJob, when,
} from './common.jsx';
import { KIND_LABEL } from './SecurityLog.jsx';
import { RestoreDialog } from './Backups.jsx';

/** What each limit is, in words, with its unit. */
export const LIMITS = [
  { key: 'quotaMb', label: 'Storage', unit: 'MB', hint: 'Notes and attachments' },
  { key: 'uploadMb', label: 'Largest upload', unit: 'MB', hint: 'One attachment or import' },
  { key: 'memoryMb', label: 'Memory', unit: 'MB', hint: 'For the whole Selah, OCR and conversions included' },
  { key: 'cpuPercent', label: 'Processor', unit: '%', hint: '100% is one core' },
  { key: 'jobMinutes', label: 'Longest job', unit: 'min', hint: 'One handwriting, photo or audio conversion' },
  { key: 'tasks', label: 'Processes and threads', unit: '', hint: 'Stops a runaway program' },
];

export function LimitsFields({ limits, ranges, onChange }) {
  return (
    <div className="adm-limits">
      {LIMITS.map((l) => (
        <label key={l.key} className="adm-limit">
          <span>{l.label}<span className="muted">{l.hint}</span></span>
          <span className="adm-limit-input">
            <input className="input" type="number" min={ranges?.[l.key]?.[0]} max={ranges?.[l.key]?.[1]} value={limits[l.key] ?? ''}
              onChange={(e) => onChange({ ...limits, [l.key]: e.target.value === '' ? '' : Number(e.target.value) })} />
            <span className="muted">{l.unit}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function stateBadge(t) {
  if (t.status === 'suspended') return <Badge kind="neutral">Paused</Badge>;
  if (t.state !== 'active') return <Badge kind="bad">{t.state === 'activating' ? 'Starting' : 'Stopped'}</Badge>;
  if (!t.health) return <Badge kind="busy">Starting</Badge>;
  if (!t.health.ok) return <Badge kind="bad">Not answering</Badge>;
  if (!t.health.passwordSet) return <Badge kind="warn">Invited</Badge>;
  return <Badge kind="good">Running</Badge>;
}

function SetupLinkDialog({ link, tenant, close }) {
  return (
    <div className="stack-form adm-dialog">
      <h2>{link.kind === 'reset' ? 'Reset link' : 'Setup link'} for {tenant}</h2>
      <p>Send this to them yourself (a text or an email). It works once, until {when(link.expires)}.
        {link.kind === 'reset' ? ' It lets them choose a new password and set up their authenticator again; their notes aren’t touched.' : ' It lets them choose their password and set up two-step sign-in.'}</p>
      <LinkBox url={link.url} />
      <p className="muted">It won’t be shown again. A new link replaces this one.</p>
      <div className="modal-actions"><button className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}

function NewTenantDialog({ defaults, ranges, timeZone, close }) {
  const dialog = useDialog();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [tz, setTz] = useState(timeZone);
  const [limits, setLimits] = useState(defaults);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const clean = slug.trim().toLowerCase();
  const domain = location.host.replace(/^admin\./, '');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi.createTenant({ slug: clean, name: name.trim(), timeZone: tz, limits });
      close(r.tenant.slug);
      dialog.open((c) => <SetupLinkDialog link={r.link} tenant={r.tenant.slug} close={c} />);
    } catch (err) {
      if (err.status !== 403) setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form adm-dialog" onSubmit={submit}>
      <h2>New Tenant</h2>
      <p className="muted">Their own Selah at their own address. You’ll get a one-time setup link to send them; they choose the password, so you never know it.</p>
      <label className="field-label" htmlFor="nt-name">Name</label>
      <input id="nt-name" className="input" autoFocus placeholder="e.g. Sarah Thomas" value={name} onChange={(e) => {
        setName(e.target.value);
        if (!slug || slug === suggest(name)) setSlug(suggest(e.target.value));
      }} />
      <label className="field-label" htmlFor="nt-slug">Address</label>
      <span className="adm-slug"><input id="nt-slug" className="input" value={slug} onChange={(e) => setSlug(e.target.value)} spellCheck={false} placeholder="sarah" /><span className="muted">.{domain}</span></span>
      <button type="button" className="link-btn" onClick={() => setMore(!more)}>{more ? 'Hide' : 'Show'} limits and time zone</button>
      {more && (
        <>
          <label className="field-label" htmlFor="nt-tz">Time zone</label>
          <input id="nt-tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Chicago" />
          <LimitsFields limits={limits} ranges={ranges} onChange={setLimits} />
        </>
      )}
      <ErrorNote error={error} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || clean.length < 3}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </form>
  );
}
const suggest = (name) => String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().split(/\s+/)[0]?.replace(/[^a-z0-9-]/g, '') ?? '';

function DeleteTenantDialog({ slug, close }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminApi.deleteTenant(slug, typed);
      close(true);
    } catch (err) {
      if (err.status !== 403) setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form adm-dialog" onSubmit={submit}>
      <h2>Delete {slug}?</h2>
      <p>Their Selah stops, its address stops working, and its host backups are removed. The folder is kept in the trash for 7 days, then removed for good.</p>
      <label className="field-label" htmlFor="dt-confirm">Type <code>{slug}</code> to confirm</label>
      <input id="dt-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <ErrorNote error={error} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || typed !== slug}>Delete</button>
      </div>
    </form>
  );
}

function LogDialog({ slug, close }) {
  const { data, error } = useLoad(() => adminApi.tenantLogs(slug), [slug]);
  return (
    <div className="adm-dialog adm-log-dialog">
      <div className="dialog-header">
        <h2>{slug}: Server Log</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <ErrorNote error={error} />
      <pre className="adm-log">{data ? data.text || '(empty)' : 'Loading…'}</pre>
    </div>
  );
}

/** One tenant, in a panel over the list. */
function TenantPanel({ slug, onClose, onChanged, ranges }) {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.tenant(slug), [slug], 15_000);
  const [limits, setLimits] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (data) { setLimits(data.tenant.limits); setName(data.tenant.name); }
  }, [data?.tenant.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label, fn, { done } = {}) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r?.jobId) {
        const j = await waitForJob(r.jobId, (p) => setBusy(p));
        dialog.toast(j.ok ? `${done ?? label}: done` : `${label} failed: ${j.detail?.error ?? 'see Running now'}`, j.ok ? 'info' : 'error', 7000);
      } else if (done) dialog.toast(done);
      reload();
      onChanged();
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
    setBusy(null);
  };
  const link = (kind) => act(kind === 'reset' ? 'Reset link' : 'Setup link', async () => {
    const r = await adminApi.setupLink(slug, kind);
    dialog.open((c) => <SetupLinkDialog link={r} tenant={slug} close={c} />);
  });

  if (!data) {
    return (
      <aside className="adm-panel" aria-label={slug}>
        <div className="adm-panel-head"><h2>{slug}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        {error ? <ErrorNote error={error} /> : <div className="adm-loading" />}
      </aside>
    );
  }
  const t = data.tenant;
  const h = t.health ?? {};
  const changed = limits && JSON.stringify(limits) !== JSON.stringify(t.limits);
  const paused = t.status === 'suspended';
  const hb = data.backup;

  return (
    <aside className="adm-panel" aria-label={t.slug}>
      <div className="adm-panel-head">
        <div>
          <h2>{t.name || t.slug}</h2>
          <a className="muted" href={t.url} target="_blank" rel="noreferrer">{t.url.replace(/^https:\/\//, '')}</a>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="adm-panel-body">
        <p className="adm-status">{stateBadge(t)} <span className="muted">Selah {t.version ?? '–'}{h.version && h.version !== t.version ? ` (running ${h.version})` : ''}</span></p>
        {busy && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {busy}…</p>}

        <dl className="adm-facts">
          <dt>Signed in</dt><dd>{h.passwordSet ? `${ago(h.lastSignIn)} · active ${ago(h.lastActive)} · ${h.sessions ?? 0} device${h.sessions === 1 ? '' : 's'}` : h.setupPending ? `Not yet: setup link until ${when(h.setupPending.expires)}` : 'Not set up'}</dd>
          <dt>Sign-in</dt><dd>{h.signIn ? <>{h.signIn.username} · <a href={`mailto:${h.signIn.email}`}>{h.signIn.email}</a></> : h.passwordSet ? <span className="muted">Password only (no username yet)</span> : '–'}</dd>
          <dt>Two-step</dt><dd>{h.twoFactor ? 'On' : h.passwordSet ? <span className="muted">Off (recommended)</span> : '–'}</dd>
          <dt>Storage</dt><dd><Meter value={h.storage?.bytes ?? 0} max={t.limits.quotaMb * 1048576} label="Storage used" /> {size(h.storage?.bytes)} of {mb(t.limits.quotaMb)} · {plural(h.notes, 'note')} · {plural(h.storage?.fileCount, 'file')}</dd>
          <dt>Host backup</dt><dd>{hb?.lastSuccess ? `${ago(hb.lastSuccess.finishedAt)} · ${plural(hb.lastSuccess.snapshots, 'snapshot')}` : 'Not yet'}{hb?.last && !hb.last.ok ? <span className="is-bad"> · last failed: {hb.last.error}</span> : ''}</dd>
          <dt>Own Backup</dt><dd>{h.offsite?.configured ? `${h.offsite.service ?? 'OneDrive'}: ${h.offsite.account ?? 'Connected'} · ${h.offsite.lastSuccessAt ? ago(h.offsite.lastSuccessAt) : 'not yet'}` : 'Not connected'}{h.offsite?.lastError ? <span className="is-bad"> · {h.offsite.lastError}</span> : ''}</dd>
          <dt>Downloaded</dt><dd>{h.lastDownload ? `A backup, ${ago(h.lastDownload)}` : 'Never'}</dd>
          <dt>Created</dt><dd>{when(t.createdAt)} · ports {t.port}/{t.controlPort}</dd>
        </dl>

        <h3>Sign-in</h3>
        <div className="adm-actions">
          {!h.passwordSet
            ? <button className="btn btn-small btn-primary" disabled={!!busy || paused} onClick={() => link('invite')}>New setup link…</button>
            : <button className="btn btn-small" disabled={!!busy || paused} onClick={() => link('reset')}>Reset link…</button>}
        </div>
        <p className="muted adm-hint">{h.passwordSet ? 'For a forgotten password or a lost phone: they choose a new password and set up their authenticator again.' : 'If the first link expired or was lost.'}</p>

        <h3>Name and Limits</h3>
        <label className="field-label" htmlFor="tp-name">Name</label>
        <input id="tp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        {limits && <LimitsFields limits={limits} ranges={ranges} onChange={setLimits} />}
        <div className="adm-actions">
          <button className="btn btn-small btn-primary" disabled={!!busy || (!changed && name === t.name)}
            onClick={() => act('Saving', () => adminApi.changeTenant(slug, { name, limits }), { done: paused ? 'Saved' : 'Saved; it restarted with the new limits' })}>Save</button>
        </div>

        <h3>Backups</h3>
        <div className="adm-actions">
          <button className="btn btn-small" disabled={!!busy} onClick={() => act('Backing up', () => adminApi.runBackups([slug]), { done: 'Backed up' })}>Back up now</button>
          <button className="btn btn-small" disabled={!!busy} onClick={() => dialog.open((c) => <RestoreDialog slug={slug} close={c} />).then(() => { reload(); onChanged(); })}>Restore…</button>
        </div>

        {slug === 'demo' && (
          <>
            <h3>Demo</h3>
            <div className="adm-actions">
              <button className="btn btn-small" disabled={!!busy || paused} onClick={async () => {
                const typed = await dialog.prompt({
                  title: 'Reset the demo?',
                  label: 'Everything in it is replaced with the sample data, dated around today, so every video starts from the same place. Its sign-in, connected Bible keys and signed-in devices stay. Type demo to confirm.',
                  okLabel: 'Reset', placeholder: 'demo',
                });
                if (typed == null) return;
                act('Resetting the demo', () => adminApi.resetDemo(typed.trim()), { done: 'The demo is back to its sample data' });
              }}>Reset to sample data…</button>
            </div>
            <p className="muted adm-hint">Only when you click it: nothing resets the demo by itself. Its data before the reset is kept in storage-before-reset until the next one.</p>
          </>
        )}

        <h3>Running</h3>
        <div className="adm-actions">
          {paused
            ? <button className="btn btn-small btn-primary" disabled={!!busy} onClick={() => act('Resuming', () => adminApi.resume(slug), { done: 'Running again' })}>Resume</button>
            : <>
              <button className="btn btn-small" disabled={!!busy} onClick={() => act('Restarting', () => adminApi.restart(slug), { done: 'Restarted' })}>Restart</button>
              <button className="btn btn-small" disabled={!!busy} onClick={async () => {
                if (await dialog.confirm({ title: `Pause ${slug}?`, message: 'They’re signed out and their address shows a “paused” page until you resume it. Nothing is deleted.', okLabel: 'Pause' })) act('Pausing', () => adminApi.suspend(slug), { done: 'Paused' });
              }}>Pause…</button>
            </>}
          {(t.previousRelease || t.release) && (
            <button className="btn btn-small" disabled={!!busy} onClick={async () => {
              if (await dialog.confirm({ title: `Roll ${slug} back?`, message: `It goes back to the release it was on before its last update (${t.previousRelease ?? 'this server’s code'}).`, okLabel: 'Roll back' })) act('Rolling back', () => adminApi.rollBack(slug), { done: 'Rolled back' });
            }}>Roll back…</button>
          )}
          <button className="btn btn-small" onClick={() => dialog.open((c) => <LogDialog slug={slug} close={c} />)}>Server log…</button>
          <button className="btn btn-small btn-danger-text" disabled={!!busy} onClick={async () => {
            if (await dialog.open((c) => <DeleteTenantDialog slug={slug} close={c} />)) { onChanged(); onClose(); }
          }}>Delete…</button>
        </div>

        <h3>Recent Activity</h3>
        {data.events.length === 0 ? <p className="card-empty">Nothing yet.</p> : (
          <ul className="adm-events">
            {data.events.slice(0, 15).map((e) => (
              <li key={e.id} className={KIND_LABEL[e.kind]?.bad ? 'is-bad' : ''}>
                <span>{KIND_LABEL[e.kind]?.label ?? e.kind}</span>
                <span className="muted">{when(e.at)}{e.device ? ` · ${e.device}` : ''}{e.ip ? ` · ${e.ip}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {data.jobs.length > 0 && (
          <>
            <h3>Jobs</h3>
            <ul className="adm-jobs">{data.jobs.slice(0, 8).map((j) => <JobRow key={j.id} job={j} />)}</ul>
          </>
        )}
      </div>
    </aside>
  );
}

export default function Tenants({ open, go }) {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.tenants(), [], 15_000);
  const create = async () => {
    const slug = await dialog.open((c) => <NewTenantDialog defaults={data.defaults} ranges={data.ranges} timeZone={data.timeZone} close={c} />);
    if (slug) { reload(); go('tenants', slug); }
  };
  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  const list = data.tenants;
  return (
    <>
      <div className="adm-toolbar">
        <span className="muted">{list.length} tenant{list.length === 1 ? '' : 's'}</span>
        <button className="btn btn-primary" onClick={create}><Icon name="plus" size={15} /> New tenant</button>
      </div>
      {list.length === 0 ? (
        <div className="adm-empty">
          <Icon name="users" size={28} />
          <p>No tenants yet. Each person you invite gets their own Selah at their own address.</p>
          <button className="btn btn-primary" onClick={create}>Create the first one</button>
        </div>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr><th>Tenant</th><th>Status</th><th>Storage</th><th>Last active</th><th>Backups</th><th>Version</th></tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const h = t.health ?? {};
                return (
                  <tr key={t.slug} className={open === t.slug ? 'is-open' : ''} onClick={() => go('tenants', t.slug)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') go('tenants', t.slug); }}>
                    <td><strong>{t.name || t.slug}</strong><span className="muted">{t.host}</span></td>
                    <td>{stateBadge(t)}</td>
                    <td><Meter value={h.storage?.bytes ?? 0} max={t.limits.quotaMb * 1048576} label="Storage" /> <span className="muted">{size(h.storage?.bytes)} / {mb(t.limits.quotaMb)}</span></td>
                    <td className="muted">{ago(h.lastActive)}</td>
                    <td className="muted">{h.hostBackup?.ok ? `Host ${ago(h.hostBackup.at)}` : 'Host: not yet'}{h.offsite?.configured ? ` · own ${h.offsite.service ?? 'OneDrive'}` : ''}</td>
                    <td className="muted">{t.version}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && list.some((t) => t.slug === open) && (
        <>
          <div className="adm-panel-backdrop" onClick={() => go('tenants')} />
          <TenantPanel key={open} slug={open} ranges={data.ranges} onClose={() => go('tenants')} onChanged={reload} />
        </>
      )}
    </>
  );
}
