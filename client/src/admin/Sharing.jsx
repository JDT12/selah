import { useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import { adminApi } from './adminApi.js';
import { Badge, Card, ErrorNote, plural, useLoad, when } from './common.jsx';

/**
 * Sharing between tenants (server/admin/sharing.js): who is connected to whom, what is shared (titles only), the
 * sharing log, and a switch for each tenant.
 */

const LOG_LABEL = {
  'contact-request': 'asked to connect with',
  'contact-accepted': 'connected with',
  'contact-removed': 'removed the contact',
  shared: 'shared',
  'share-removed': 'stopped sharing with',
  'share-stopped': 'stopped sharing',
  'share-failed': 'couldn’t share',
  comment: 'commented on',
  reply: 'replied on',
  'sharing-off': 'had sharing turned off',
  'sharing-on': 'had sharing turned on',
  'tenant-removed': 'was removed from sharing',
};
const KIND = { note: 'Note', notebook: 'Notebook', study: 'Project' };

function logLine(e) {
  const what = LOG_LABEL[e.kind] ?? e.kind;
  if (e.kind === 'shared' || e.kind === 'share-failed') return `${what} “${e.title ?? ''}” with ${e.other}${e.detail && e.kind === 'share-failed' ? ` (${e.detail})` : ''}`;
  if (e.kind === 'share-removed') return `${what} ${e.other}: “${e.title ?? ''}”`;
  if (e.kind === 'share-stopped') return `${what} “${e.title ?? ''}”`;
  if (e.kind === 'comment' || e.kind === 'reply') return `${what} “${e.title ?? ''}” (to ${e.other})`;
  return e.other ? `${what} ${e.other}` : what;
}

export default function Sharing() {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.sharing(), [], 20_000);
  const [busy, setBusy] = useState(null);
  const toggle = async (t) => {
    if (t.on && !(await dialog.confirm({
      title: `Turn sharing off for ${t.name}?`,
      message: 'Everything they share stops, and everything shared with them goes from their Selah. Their contacts stay, so sharing can start again when it’s back on.',
      okLabel: 'Turn off', danger: true,
    }))) return;
    setBusy(t.slug);
    try { await adminApi.setSharing(t.slug, !t.on); await reload(); } catch (e) { dialog.toast(e.message, 'error'); } finally { setBusy(null); }
  };
  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  return (
    <>
      <p className="muted adm-intro">People share notes, notebooks and projects with their contacts, read-only, and comment on what’s shared with them. Everything passes through this console, which checks it; it sees titles, never the notes.</p>
      <ErrorNote error={error} />
      <Card title="Tenants" icon="users" className="adm-wide">
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>Tenant</th><th>Contacts</th><th>They share</th><th>Shared with them</th><th>Messages</th><th>Switch</th></tr></thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.slug}>
                  <td><strong>{t.name}</strong> <span className="muted">{t.slug}</span></td>
                  <td>{t.contacts}{t.pending ? <span className="muted"> · {t.pending} asked</span> : null}</td>
                  <td>{t.sharing}</td>
                  <td>{t.sharedWith}</td>
                  <td>{t.held ? <Badge kind="warn">{plural(t.held, 'message')}</Badge> : <span className="muted">{t.connected ? 'Connected' : '–'}</span>}</td>
                  <td>
                    <button type="button" className={`btn btn-small ${t.on ? '' : 'btn-primary'}`} disabled={busy === t.slug} onClick={() => toggle(t)}>
                      {t.on ? 'Turn off' : 'Turn on'}
                    </button>
                    {!t.on && <Badge kind="bad">Off</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Shared Now" icon="share" className="adm-wide">
        {data.shares.length === 0 ? <p className="card-empty">Nothing is shared yet.</p> : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead><tr><th>What</th><th>From</th><th>With</th><th>Comments</th><th>Copying</th><th>Updated</th></tr></thead>
              <tbody>
                {data.shares.map((s) => (
                  <tr key={s.id}>
                    <td><span className="muted">{KIND[s.kind] ?? s.kind}</span> {s.title}</td>
                    <td>{s.owner}</td>
                    <td>{s.people.join(', ') || <span className="muted">no one</span>}</td>
                    <td>{s.allowComments ? 'On' : 'Off'}</td>
                    <td>{s.allowCopy ? 'Allowed' : 'No'}</td>
                    <td className="muted">{when(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Contacts" icon="link" className="adm-wide">
        {data.contacts.length === 0 ? <p className="card-empty">No one has connected yet.</p> : (
          <ul className="adm-list">
            {data.contacts.map((c) => (
              <li key={`${c.a}-${c.b}`}>
                <strong>{c.a}</strong> and <strong>{c.b}</strong>{' '}
                {c.status === 'accepted' ? <Badge kind="good">Connected</Badge> : <Badge>{c.requestedBy} asked</Badge>}
                <span className="muted"> {when(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Sharing Log" icon="clock" className="adm-wide">
        {data.log.length === 0 ? <p className="card-empty">Nothing yet.</p> : (
          <div className="adm-table-wrap">
            <table className="adm-table adm-log-table">
              <thead><tr><th>When</th><th>Tenant</th><th>What</th></tr></thead>
              <tbody>
                {data.log.map((e) => (
                  <tr key={e.id} className={e.kind === 'share-failed' || e.kind === 'sharing-off' ? 'is-bad' : ''}>
                    <td className="muted">{when(e.at)}</td>
                    <td>{e.slug}</td>
                    <td>{logLine(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
