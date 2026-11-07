import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { adminApi } from './adminApi.js';
import { MaintenanceCard, NoticeCard } from './Maintenance.jsx';
import {
  Badge, Card, ErrorNote, JobRow, Meter, ago, day, size, when,
} from './common.jsx';

const LEVEL = { danger: 'bad', warning: 'warn', info: 'neutral' };

/** The front page: is everything up, backed up and in date, and what needs looking at. */
export default function Overview({ data, error, reload, go }) {
  const dialog = useDialog();
  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  const { tenants, gateway, certificate: cert, disk, backup, alerts, jobs } = data;
  const certDays = cert ? Math.round((cert.validTo - Date.now()) / 86400_000) : null;
  const lastBackup = backup.last;

  const seen = async (id = null) => {
    try { await adminApi.alertsSeen(id); reload(); } catch (e) { dialog.toast(e.message, 'error'); }
  };

  return (
    <div className="adm-grid">
      <Card title="Tenants" icon="users" actions={<button className="card-link" onClick={() => go('tenants')}>Manage</button>}>
        <p className="adm-big">{tenants.active}<span className="muted"> running</span></p>
        <p className="muted">
          {tenants.total} in all{tenants.total - tenants.active ? `, ${tenants.total - tenants.active} paused` : ''}
          {tenants.active - tenants.healthy > 0 && <> · <span className="is-bad">{tenants.active - tenants.healthy} not answering</span></>}
        </p>
      </Card>

      <Card title="Gateway" icon="globe">
        <p className="adm-status">{gateway.running ? <Badge kind="good">Running</Badge> : <Badge kind="bad">Not running</Badge>}</p>
        <p className="muted">{data.adminUrl.replace(/^https:\/\/admin\./, '*.')}{gateway.error ? ` · ${gateway.error}` : ''}</p>
        <p className="muted">Certificate: {cert ? <span className={certDays < 21 ? 'is-bad' : ''}>until {day(cert.validTo)} ({certDays} days)</span> : 'none'}</p>
      </Card>

      <Card title="Host backup" icon="restore" actions={<button className="card-link" onClick={() => go('backups')}>Backups</button>}>
        {!backup.configured ? (
          <>
            <p className="adm-status"><Badge kind="warn">Not set up</Badge></p>
            <p className="muted">Nobody’s Selah is backed up off this server yet.</p>
          </>
        ) : (
          <>
            <p className="adm-status">
              {backup.running ? <Badge kind="busy">{backup.running.phase}…</Badge>
                : !lastBackup ? <Badge kind="warn">No backup yet</Badge>
                  : lastBackup.ok ? <Badge kind="good">Backed up {ago(lastBackup.finishedAt)}</Badge>
                    : <Badge kind="bad">Failed {ago(lastBackup.finishedAt)}</Badge>}
            </p>
            <p className="muted">{backup.connection?.account} · nightly at {data.cloud.backupTime} UTC</p>
          </>
        )}
      </Card>

      <Card title="Server" icon="monitor">
        {disk && (
          <>
            <p className="adm-row"><span>Disk</span><Meter value={disk.total - disk.free} max={disk.total} label="Disk used" /><span className="muted">{size(disk.free)} free</span></p>
          </>
        )}
        <p className="adm-row"><span>Memory</span><Meter value={data.memory.total - data.memory.free} max={data.memory.total} label="Memory used" /><span className="muted">{size(data.memory.free)} free</span></p>
        <p className="muted">Load {data.load.map((l) => l.toFixed(2)).join(' · ')} · up {Math.round(data.uptime / 86400)} days · {data.runner === 'docker' ? 'Docker' : 'services'} on {data.host}</p>
      </Card>

      <Card title="Alerts" icon="alert" className="adm-wide"
        actions={alerts.length > 0 && <button className="card-link" onClick={() => seen()}>Mark all read</button>}>
        {alerts.length === 0 ? <p className="card-empty"><Icon name="check" size={14} /> Nothing needs looking at.</p> : (
          <ul className="adm-alerts">
            {alerts.map((a) => (
              <li key={a.id} className={`is-${LEVEL[a.level] ?? 'neutral'}`}>
                <Icon name={a.level === 'info' ? 'callout' : 'alert'} size={15} />
                <span className="adm-alert-text">{a.message}<span className="muted"> · {when(a.at)}</span></span>
                {a.slug && <button className="card-link" onClick={() => go('tenants', a.slug)}>{a.slug}</button>}
                <button className="icon-btn" title="Mark read" aria-label="Mark read" onClick={() => seen(a.id)}><Icon name="check" size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.maintenance && <MaintenanceCard overview={data} reload={reload} />}
      <NoticeCard overview={data} />

      {jobs.length > 0 && (
        <Card title="Running now" icon="clock" className="adm-wide">
          <ul className="adm-jobs">{jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>
        </Card>
      )}
    </div>
  );
}
