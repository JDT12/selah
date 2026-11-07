import { useState } from 'react';
import { renderMarkdown } from '../markdownLite.js';
import { adminApi } from './adminApi.js';
import { ErrorNote, ago, useLoad } from './common.jsx';

const TABS = [
  { key: 'maintenance', label: 'Maintenance Guide', load: () => adminApi.maintenanceGuide().then((r) => r.html) },
  { key: 'procedure', label: 'Maintenance Procedure', load: () => adminApi.maintenanceProcedure().then((r) => renderMarkdown(r.markdown)) },
  { key: 'dependencies', label: 'Dependencies' },
  { key: 'changelog', label: 'Selah Changelog', load: () => adminApi.changelog().then((r) => renderMarkdown(r.markdown)) },
  { key: 'admin-changelog', label: 'Console Changelog', load: () => adminApi.adminChangelog().then((r) => renderMarkdown(r.markdown)) },
  { key: 'recovery', label: 'Disaster Recovery', load: () => adminApi.disasterRecovery().then((r) => renderMarkdown(r.markdown)) },
];

/** A version that differs from the one Selah's install scripts pin. */
const Version = ({ installed, expected }) => (
  <>
    <code>{installed ?? '—'}</code>
    {expected && installed && !String(installed).includes(expected) && <span className="is-bad"> (scripts pin {expected})</span>}
  </>
);

function DependencyTable({ title, rows, showWhere = false }) {
  if (!rows.length) return null;
  return (
    <>
      <h2>{title}</h2>
      <div className="adm-table-wrap">
        <table className="adm-table adm-deps">
          <thead><tr><th>What</th><th>On this server</th><th>For</th><th>How it’s updated</th><th>Restarts</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><strong>{r.name}</strong>{showWhere && r.where && <div className="muted"><code>{r.where}</code></div>}</td>
                <td><Version installed={r.installed} expected={r.expected} />{r.note && <div className="muted">{r.note}</div>}</td>
                <td>{r.purpose}</td>
                <td>{r.update}</td>
                <td className="muted">{r.restart}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** What Selah needs, with this server's versions (server/admin/dependencies.js). */
function Dependencies() {
  const [fresh, setFresh] = useState(0);
  const { data, error } = useLoad(() => adminApi.dependencies(fresh > 0), [fresh]);
  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  return (
    <article className="adm-doc changelog-body">
      <p className="muted">
        Checked {ago(data.at)} · Selah {data.selah} · <button className="link-btn" onClick={() => setFresh((n) => n + 1)}>Check again</button>.
        When to update each is in the Maintenance Procedure.
      </p>
      <DependencyTable title="The server" rows={data.server} />
      <DependencyTable title="Tools Selah installs (pinned versions)" rows={data.tools} showWhere />
      <DependencyTable title="Each tenant’s container" rows={data.image} />
      <h2>Node packages Selah runs</h2>
      <p className="muted">Installed with <code>npm ci</code> from package-lock.json, and copied into each release. They change only with a Selah release.</p>
      <div className="adm-table-wrap">
        <table className="adm-table adm-deps">
          <thead><tr><th>Package</th><th>Version</th><th>For</th></tr></thead>
          <tbody>{data.packages.map((p) => <tr key={p.name}><td><code>{p.name}</code></td><td><code>{p.installed ?? p.range}</code></td><td>{p.purpose}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="muted">Built into the page (not run on the server): {data.built.map((p) => `${p.name} ${p.installed ?? p.range}`).join(', ')}.</p>
      <h2>Outside services</h2>
      <ul>{data.services.map((s) => <li key={s.name}><strong>{s.name}</strong>: {s.for}</li>)}</ul>
    </article>
  );
}

function Markdownish({ tab }) {
  const { data, error } = useLoad(tab.load, [tab.key]);
  return (
    <>
      <ErrorNote error={error} />
      {/* All of these come from files in this server's own code; the Markdown ones are escaped before formatting. */}
      {data ? <article className="adm-doc changelog-body" dangerouslySetInnerHTML={{ __html: data }} /> : !error && <div className="adm-loading" />}
    </>
  );
}

/** The maintenance guide and procedure, the dependencies, both changelogs and the disaster-recovery runbook. */
export default function Docs({ tab, go }) {
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  return (
    <>
      <div className="segmented adm-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === current.key} className={t.key === current.key ? 'is-active' : ''} onClick={() => go('docs', t.key)}>{t.label}</button>
        ))}
      </div>
      {current.key === 'dependencies' ? <Dependencies /> : <Markdownish key={current.key} tab={current} />}
    </>
  );
}
