import { useEffect, useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import { SecurityPane } from '../components/SecuritySettings.jsx';
import Icon from '../components/Icon.jsx';
import { adminApi } from './adminApi.js';
import { Card, ErrorNote, useLoad } from './common.jsx';
import { LimitsFields } from './Tenants.jsx';
import { MaintenanceSchedule } from './Maintenance.jsx';

function AllowedAddresses({ s, reload }) {
  const dialog = useDialog();
  const [list, setList] = useState(s.cloud.allowIps);
  const [adding, setAdding] = useState('');
  const me = useLoad(() => adminApi.whoami(), []);
  useEffect(() => setList(s.cloud.allowIps), [s.cloud.allowIps]);
  const save = async (next) => {
    try {
      const r = await adminApi.saveAllowIps(next);
      setList(r.allowIps);
      dialog.toast(r.gateway?.loaded ? 'Saved; the gateway is using it' : `Saved (gateway: ${r.gateway?.error})`);
      reload();
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
  };
  const ip = me.data?.ip?.replace(/^::ffff:/, '');
  return (
    <Card title="Allowed Addresses" icon="lock" className="adm-wide">
      <p className="muted">The admin console only answers from these addresses (checked by the gateway and again by the console). {list.length ? '' : s.cloud.tls?.startsWith('acme')
        ? 'None are listed, so it answers only from the server itself (an SSH tunnel). Add your home address.'
        : 'None are listed, so it answers from home and private networks only, which is right while it’s on your home network. Add your home address before it goes on the internet.'}</p>
      {list.length > 0 && (
        <ul className="adm-list">
          {list.map((r) => (
            <li key={r}><code>{r}</code>{ip && r.startsWith(`${ip}/`) && <span className="muted">your address now</span>}
              <button className="icon-btn" aria-label={`Remove ${r}`} onClick={() => save(list.filter((x) => x !== r))}><Icon name="x" size={14} /></button></li>
          ))}
        </ul>
      )}
      <div className="adm-inline">
        <input className="input" placeholder="203.0.113.7 or 203.0.113.0/24" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Address to allow" />
        <button className="btn btn-small" disabled={!adding.trim()} onClick={() => { save([...list, adding.trim()]); setAdding(''); }}>Add</button>
        {ip && !list.some((r) => r.startsWith(`${ip}/`)) && <button className="btn btn-small" onClick={() => save([...list, ip])}>Add my address ({ip})</button>}
      </div>
      <p className="muted adm-hint">Locked out after your address changed? On the server: <code>npm run admin -- allow-ip add &lt;address&gt;</code></p>
    </Card>
  );
}

function DefaultLimits({ s, reload }) {
  const dialog = useDialog();
  const [limits, setLimits] = useState(s.cloud.limits);
  const [tz, setTz] = useState(s.cloud.timeZone);
  const changed = JSON.stringify(limits) !== JSON.stringify(s.cloud.limits);
  return (
    <Card title="New Tenants" icon="users" className="adm-wide">
      <p className="muted">What a new tenant starts with; each tenant’s own limits are on its page.</p>
      <label className="field-label" htmlFor="st-tz">Time zone</label>
      <div className="adm-inline">
        <input id="st-tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)} />
        {tz !== s.cloud.timeZone && <button className="btn btn-small btn-primary" onClick={async () => {
          try { await adminApi.saveTimeZone(tz); reload(); dialog.toast('Saved'); } catch (e) { dialog.toast(e.message, 'error'); }
        }}>Save</button>}
      </div>
      <LimitsFields limits={limits} ranges={s.ranges} onChange={setLimits} />
      <div className="adm-actions">
        <button className="btn btn-small btn-primary" disabled={!changed} onClick={async () => {
          try { await adminApi.saveDefaultLimits(limits); reload(); dialog.toast('Saved'); } catch (e) { dialog.toast(e.message, 'error'); }
        }}>Save limits</button>
      </div>
    </Card>
  );
}

export default function Settings({ onSignOut }) {
  const dialog = useDialog();
  const { data: s, error, reload } = useLoad(() => adminApi.settings(), []);
  if (!s) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  const c = s.cloud;
  return (
    <div className="adm-grid">
      <AllowedAddresses s={s} reload={reload} />
      <DefaultLimits s={s} reload={reload} />
      <MaintenanceSchedule />
      <Card title="Gateway" icon="globe" className="adm-wide"
        actions={<button className="btn btn-small" onClick={async () => {
          const r = await adminApi.reloadGateway().catch((e) => ({ error: e.message }));
          dialog.toast(r.loaded ? 'The gateway reloaded its settings' : `Couldn’t reload: ${r.error}`, r.loaded ? 'info' : 'error');
        }}>Reload</button>}>
        <dl className="adm-facts">
          <dt>Addresses</dt><dd>admin.{c.domain} and &lt;name&gt;.{c.domain}, port {c.gatewayPort}</dd>
          <dt>Certificate</dt><dd>{c.tls === 'files' ? 'From the private CA (renew with npm run admin -- cert)' : c.tls === 'acme-host' ? 'Let’s Encrypt, one per name, checked on port 443 (the gateway renews them itself)' : 'Let’s Encrypt wildcard, proven through Cloudflare DNS (the gateway renews it itself)'}</dd>
          <dt>Tenants run as</dt><dd>{c.runner === 'docker' ? 'Docker containers' : 'background services on this server'}, ports from {c.portBase}</dd>
          <dt>Folders</dt><dd><code>{s.paths.root}</code> (data) · <code>{s.paths.code}</code> (code)</dd>
        </dl>
      </Card>
      <Card title="Your Sign-in" icon="key" className="adm-wide">
        <SecurityPane cert={null} onSignOut={onSignOut} />
      </Card>
    </div>
  );
}
