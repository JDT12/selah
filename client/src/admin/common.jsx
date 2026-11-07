import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSize } from '../api.js';
import { adminApi } from './adminApi.js';
import Icon from '../components/Icon.jsx';

/** Small pieces shared by the admin console's pages. */

export const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
export const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–');
export function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
export const plural = (n, word) => `${n ?? 0} ${word}${n === 1 ? '' : 's'}`;
export const size = (b) => (b == null ? '–' : formatSize(b));
export const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} GB` : `${n} MB`);

/** Loads `fn` now, again on `every` ms (if given), and on demand; { data, error, reload }. */
export function useLoad(fn, deps = [], every = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const live = useRef(true);
  const reload = useCallback(() => fn().then((d) => { if (live.current) { setData(d); setError(null); } }, (e) => { if (live.current) setError(e); }), deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    live.current = true;
    reload();
    const t = every ? setInterval(reload, every) : null;
    return () => { live.current = false; if (t) clearInterval(t); };
  }, [reload, every]);
  return { data, error, reload };
}

/** Waits for a background job (backup, restore, update) and resolves with it once it's done. */
export async function waitForJob(id, onPhase) {
  for (;;) {
    const { jobs } = await adminApi.jobs({ limit: 100 });
    const j = jobs.find((x) => x.id === id);
    if (j?.finished_at) return j;
    onPhase?.(j?.phase ?? 'Starting');
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const JOB_NAMES = { backup: 'Backup', verify: 'Backup check', restore: 'Restore', 'test-restore': 'Test restore', 'restore-notes': 'Restore notes', update: 'Update', rollback: 'Roll back', prepare: 'Prepare release', promote: 'Promote to main', 'demo-reset': 'Reset demo' };
export const jobName = (k) => JOB_NAMES[k] ?? k;

export function JobRow({ job }) {
  const d = job.detail ?? {};
  const what = d.error ? d.error
    : job.kind === 'backup' ? `${d.tenants ?? 0} tenant${d.tenants === 1 ? '' : 's'}${d.failed?.length ? `, failed: ${d.failed.join(', ')}` : ''}`
      : job.kind === 'test-restore' || job.kind === 'restore' ? `${plural(d.notes, 'note')}, ${plural(d.files, 'file')}${d.problems?.length ? ` · ${d.problems.join('; ')}` : ''}${d.missing ? ` · ${d.missing} missing` : ''}`
        : job.kind === 'restore-notes' ? `${plural(d.notes, 'note')}${d.notebooks ? ` in ${plural(d.notebooks, 'notebook')}` : ''}${d.missing ? ` · ${d.missing} attachment${d.missing === 1 ? '' : 's'} missing` : ''}`
        : job.kind === 'update' ? `to ${d.release ?? 'this code'}: ${(d.done ?? []).length} done${d.left?.length ? `, ${d.left.length} not started` : ''}`
          : job.kind === 'prepare' ? `${d.release ?? ''}${d.channel ? ` as ${d.channel}` : ''}`
            : job.kind === 'promote' ? `${d.release ?? ''} is main (was ${d.from ?? 'this code'})`
              : job.kind === 'demo-reset' ? `sample data on ${d.version ?? 'this code'}`
                : job.kind === 'rollback' ? (d.done && d.done.length > 1 ? d.done.map((x) => x.slug).join(', ') : `${d.from ?? '?'} → ${d.to ?? 'this code'}`) : '';
  return (
    <li className="adm-job">
      <span className={`adm-dot ${job.finished_at ? (job.ok ? 'is-good' : 'is-bad') : 'is-busy'}`} aria-hidden="true" />
      <strong>{jobName(job.kind)}{job.slug ? ` · ${job.slug}` : ''}</strong>
      <span className="muted">{job.finished_at ? when(job.started_at) : job.phase ?? 'Running…'}</span>
      <span className="adm-job-detail">{what}</span>
    </li>
  );
}

export function Badge({ kind = 'neutral', children }) {
  return <span className={`adm-badge is-${kind}`}>{children}</span>;
}

export function Meter({ value, max, label }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className={`adm-meter ${pct >= 90 ? 'is-full' : pct >= 75 ? 'is-high' : ''}`} title={label}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Card({ title, icon, children, actions = null, className = '' }) {
  return (
    <section className={`adm-card ${className}`}>
      <header>
        <h2>{icon && <Icon name={icon} size={16} />} {title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="form-error">{error.message ?? String(error)}</p>;
}

/** A copyable one-time link, shown once. */
export function LinkBox({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* select it instead */ }
  };
  return (
    <div className="adm-linkbox">
      <code onClick={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}>{url}</code>
      <button type="button" className="btn btn-small" onClick={copy}><Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
