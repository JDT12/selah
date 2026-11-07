import { useState } from 'react';
import { adminApi } from './adminApi.js';
import { ErrorNote, useLoad, when } from './common.jsx';

/** Every tenant's security log in one place (copied here by the monitor once a minute). */
export const KIND_LABEL = {
  'sign-in': { label: 'Signed in' },
  'sign-in-failed': { label: 'Wrong password', bad: true },
  'code-failed': { label: 'Wrong sign-in code', bad: true },
  'confirm-failed': { label: 'Wrong password or code when confirming', bad: true },
  locked: { label: 'Sign-in paused after too many failures', bad: true },
  'sign-out': { label: 'Signed out' },
  'password-changed': { label: 'Password changed' },
  'two-step-on': { label: 'Two-step sign-in turned on' },
  'two-step-off': { label: 'Two-step sign-in turned off', bad: true },
  'recovery-codes-new': { label: 'New recovery codes made' },
  'session-revoked': { label: 'Signed out a device' },
  'sessions-revoked': { label: 'Signed out devices' },
  'settings-changed': { label: 'Security settings changed' },
  'clipper-paired': { label: 'Edge clipper connected' },
  'clipper-removed': { label: 'Edge clipper disconnected' },
  'blocked-origin': { label: 'Blocked a request from another site', bad: true },
  'rate-limited': { label: 'Slowed down too many requests', bad: true },
  'setup-link': { label: 'Setup link made' },
  'setup-failed': { label: 'Setup link that didn’t work', bad: true },
  'setup-done': { label: 'Set up with the setup link' },
  'setup-reset': { label: 'Sign-in reset with a reset link' },
  'data-export': { label: 'Downloaded all their data' },
  'backup-download': { label: 'Downloaded a backup' },
  'notes-restored': { label: 'Notes restored from a backup' },
  'demo-reset': { label: 'Demo reset to its sample data' },
  'release-prepared': { label: 'Release prepared' },
  'release-promoted': { label: 'Beta promoted to main' },
  'account-deletion': { label: 'Asked to delete their account', bad: true },
};

const FILTERS = [
  { key: '', label: 'Everything' },
  { key: 'sign-in', label: 'Sign-ins' },
  { key: 'sign-in-failed', label: 'Wrong passwords' },
  { key: 'code-failed', label: 'Wrong codes' },
  { key: 'locked', label: 'Lockouts' },
  { key: 'blocked-origin', label: 'Blocked requests' },
];

export default function SecurityLog({ slug: initial }) {
  const [slug, setSlug] = useState(initial ?? '');
  const [kind, setKind] = useState('');
  const tenants = useLoad(() => adminApi.tenants(), []);
  const { data, error } = useLoad(() => adminApi.events({ slug, kind, limit: 300 }), [slug, kind], 30_000);
  return (
    <>
      <p className="muted adm-intro">Sign-ins, failures and security changes from every tenant, with the device and address. Failed sign-ins, lockouts, new devices and blocked requests also raise alerts on the Overview.</p>
      <div className="adm-toolbar">
        <select className="input" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Tenant">
          <option value="">All tenants</option>
          {tenants.data?.tenants.map((t) => <option key={t.slug} value={t.slug}>{t.slug}</option>)}
        </select>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      {data && (data.events.length === 0 ? <p className="card-empty">Nothing to show.</p> : (
        <div className="adm-table-wrap">
          <table className="adm-table adm-log-table">
            <thead><tr><th>When</th><th>Tenant</th><th>What</th><th>Device</th><th>Address</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id} className={KIND_LABEL[e.kind]?.bad ? 'is-bad' : ''}>
                  <td className="muted">{when(e.at)}</td>
                  <td>{e.slug}</td>
                  <td>{KIND_LABEL[e.kind]?.label ?? e.kind}</td>
                  <td className="muted">{e.device ?? ''}</td>
                  <td className="muted">{e.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
