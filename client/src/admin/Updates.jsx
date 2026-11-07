import { useEffect, useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import { adminApi } from './adminApi.js';
import {
  Badge, Card, ErrorNote, JobRow, day, useLoad, waitForJob,
} from './common.jsx';

/**
 * Releases and rolling updates (Admin 3.2: beta first). The server's code is updated with `selah update` (or git pull
 * and a build); Prepare makes a beta release of it. Move the demo to the beta and try it; once it's approved, Promote
 * makes it main (new tenants start on it), then pick tenants and Update them, one at a time, each checked.
 */
const CHANNEL = {
  main: { label: 'Main', kind: 'good', hint: 'New tenants start here' },
  beta: { label: 'Beta', kind: 'busy', hint: 'Being tried on the demo' },
  old: { label: 'Old', kind: 'neutral', hint: 'Kept for rolling back' },
};
const plural = (n) => `${n} tenant${n === 1 ? '' : 's'}`;

export default function Updates({ go }) {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.releases(), [], 10_000);
  const jobs = useLoad(() => adminApi.jobs({ limit: 40 }), [], 10_000);
  const [busy, setBusy] = useState(null);
  const [picked, setPicked] = useState([]);
  const [target, setTarget] = useState('');
  // The picker starts on the beta when there is one (that's what you'd try first), else main.
  useEffect(() => {
    if (!data) return;
    const names = data.releases.map((r) => r.release);
    if (!target || !names.includes(target)) setTarget(data.beta ?? data.current ?? names[0] ?? '');
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;

  const track = async (label, fn) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r?.jobId) {
        const j = await waitForJob(r.jobId, setBusy);
        dialog.toast(j.ok ? `${label}: done` : `${label} stopped: ${j.detail?.error ?? 'see the history'}`, j.ok ? 'info' : 'error', 9000);
      } else dialog.toast(`${label}: done`);
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
    setBusy(null);
    reload(); jobs.reload();
  };

  const prepared = data.releases.some((r) => r.version === data.repoVersion);
  const byName = Object.fromEntries(data.releases.map((r) => [r.release, r]));
  const beta = data.beta ? byName[data.beta] : null;
  const chosen = byName[target] ?? null;
  const live = data.tenants.filter((t) => picked.includes(t.slug));
  const toMove = live.filter((t) => chosen && t.release !== chosen.release);
  const toRollBack = live.filter((t) => t.previousRelease || t.release);
  const off = !!busy || !!data.running;
  const toggle = (slug) => setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));
  const allPicked = data.tenants.length > 0 && picked.length === data.tenants.length;

  const prepare = async (channel) => {
    if (channel === 'main' && !await dialog.confirm({
      title: `Prepare ${data.repoVersion} as main?`,
      message: 'New tenants start on it straight away, without trying it on the demo first. Use this for urgent fixes.',
      okLabel: 'Prepare as main',
    })) return;
    track(`Prepare ${data.repoVersion}`, () => adminApi.prepareRelease(channel));
  };
  const promote = async () => {
    if (!await dialog.confirm({
      title: `Promote ${beta.version} to main?`,
      message: 'New tenants start on it. Tenants already running stay where they are until you update them.',
      okLabel: 'Promote',
    })) return;
    track(`Promote ${beta.version}`, () => adminApi.promoteRelease(beta.release));
  };
  const update = async () => {
    const others = toMove.filter((t) => t.slug !== 'demo');
    if (!await dialog.confirm({
      title: `Update ${plural(toMove.length)} to ${chosen.version}?`,
      message: `${toMove.map((t) => t.slug).join(', ')}. One at a time: each is backed up, restarted on ${chosen.version} and checked. If one doesn’t come up, it goes back to the release it was on and the update stops there.${chosen.channel === 'beta' && others.length ? ' This is a beta: only the demo usually runs it.' : ''}`,
      okLabel: 'Update',
    })) return;
    await track('Update', () => adminApi.update(chosen.release, toMove.map((t) => t.slug)));
    setPicked([]);
  };
  const rollBack = async () => {
    if (!await dialog.confirm({
      title: `Roll ${plural(toRollBack.length)} back?`,
      message: toRollBack.map((t) => `${t.slug}: back to ${t.previousRelease ? byName[t.previousRelease]?.version ?? t.previousRelease : 'this server’s code'}`).join(' · '),
      okLabel: 'Roll back',
    })) return;
    await track('Roll back', () => adminApi.rollBackMany(toRollBack.map((t) => t.slug)));
    setPicked([]);
  };
  const history = (jobs.data?.jobs ?? []).filter((j) => ['update', 'rollback', 'prepare', 'promote', 'demo-reset'].includes(j.kind));
  const labelOf = (release) => (release ? byName[release]?.channel : null);

  return (
    <div className="adm-grid">
      <Card title="This Server’s Code" icon="refresh" className="adm-wide"
        actions={!prepared && (
          <span className="adm-actions">
            <button className="btn btn-small btn-primary" disabled={off} onClick={() => prepare('beta')}>Prepare beta {data.repoVersion}</button>
            <button className="btn btn-small" disabled={off} onClick={() => prepare('main')}>As main…</button>
          </span>
        )}>
        <p className="adm-status">Selah {data.repoVersion} {prepared ? <Badge kind="good">Prepared</Badge> : <Badge kind="warn">Not prepared yet</Badge>}</p>
        <p className="muted">To get a new version: on the server, <code>selah update</code> (or <code>git pull</code> and <code>npm run build</code>), then prepare it here as a beta. Move the demo to it and try it; when it’s approved, promote it to main and update the other tenants.</p>
        {beta && (
          <div className="adm-result is-busy">
            <span><strong>{beta.version}</strong> is the beta{beta.tenants.length ? `, on ${beta.tenants.join(', ')}` : ', not on any tenant yet'}.</span>
            <button className="btn btn-small btn-primary" disabled={off} onClick={promote}>Promote to main…</button>
          </div>
        )}
        {busy && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {busy}…</p>}
        {!busy && data.running?.phase && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {data.running.phase}…</p>}
      </Card>

      <Card title="Tenants" icon="users" className="adm-wide">
        <div className="adm-update-bar">
          <label className="field-label" htmlFor="upd-release">Release</label>
          <select id="upd-release" className="input" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!data.releases.length}>
            {data.releases.map((r) => <option key={r.release} value={r.release}>{r.version} · {CHANNEL[r.channel]?.label ?? r.channel}</option>)}
          </select>
          <button className="btn btn-small btn-primary" disabled={off || !toMove.length} onClick={update}>
            Update{toMove.length ? ` ${plural(toMove.length)}` : ''}
          </button>
          <button className="btn btn-small" disabled={off || !toRollBack.length} onClick={rollBack}>
            Roll back{toRollBack.length ? ` ${plural(toRollBack.length)}` : ''}
          </button>
          <span className="muted">{picked.length ? `${picked.length} chosen` : 'Choose tenants below'}</span>
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th className="adm-check"><input type="checkbox" aria-label="Choose every tenant" checked={allPicked} onChange={() => setPicked(allPicked ? [] : data.tenants.map((t) => t.slug))} /></th>
                <th>Tenant</th><th>Release</th><th>Running</th><th>Before</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => {
                const ch = labelOf(t.release);
                return (
                  <tr key={t.slug} className={picked.includes(t.slug) ? 'is-picked' : ''}>
                    <td className="adm-check"><input type="checkbox" aria-label={`Choose ${t.slug}`} checked={picked.includes(t.slug)} onChange={() => toggle(t.slug)} /></td>
                    <td><button className="link-btn" onClick={() => go('tenants', t.slug)}>{t.slug}</button>{t.status === 'suspended' && <span className="muted"> (paused)</span>}</td>
                    <td>{t.version ?? '–'} {ch && <Badge kind={CHANNEL[ch].kind}>{CHANNEL[ch].label}</Badge>}</td>
                    <td className={t.running && t.running !== t.version ? 'is-bad' : 'muted'}>{t.running ?? '–'}</td>
                    <td className="muted">{t.previousRelease ? byName[t.previousRelease]?.version ?? t.previousRelease : (t.release ? 'this code' : '–')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted adm-hint">Update moves the chosen tenants to the release picked above; Roll back puts each back on the release it ran before its last update.</p>
      </Card>

      <Card title="Releases" icon="stack">
        {data.releases.length === 0 ? <p className="card-empty">None yet. Tenants run this server’s code until a release is prepared.</p> : (
          <ul className="adm-list">
            {data.releases.map((r) => (
              <li key={r.release}>
                <strong>{r.version}</strong>
                <span className="muted">{day(r.preparedAt)} · {r.tenants.length ? r.tenants.join(', ') : 'no tenants'}</span>
                <Badge kind={CHANNEL[r.channel]?.kind ?? 'neutral'}>{CHANNEL[r.channel]?.label ?? r.channel}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="muted adm-hint">Main: new tenants start here. Beta: being tried on the demo. The newest three are kept, and main, the beta and any release a tenant runs or could roll back to.</p>
      </Card>

      <Card title="History" icon="clock">
        {history.length === 0 ? <p className="card-empty">No updates yet.</p> : <ul className="adm-jobs">{history.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
      </Card>
    </div>
  );
}
