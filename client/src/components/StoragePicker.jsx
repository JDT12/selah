import { useState } from 'react';
import { Command } from './CertificateHelp.jsx';
import Icon from './Icon.jsx';
import OneDriveConnect from './OneDriveConnect.jsx';

const PROVIDERS = [
  { id: 'onedrive', icon: 'cloud', label: 'OneDrive', hint: 'Sign in with Microsoft' },
  { id: 's3', icon: 'database', label: 'S3-compatible', hint: 'Backblaze B2, Wasabi, R2, Amazon S3' },
  { id: 'webdav', icon: 'server', label: 'WebDAV', hint: 'Nextcloud, Synology, Koofr' },
];
const CUSTOM = { id: 'custom', icon: 'settings', label: 'Other (rclone)', hint: 'Any rclone remote you paste' };

/** S3-compatible services: which boxes each needs, and where its keys come from. */
export const SERVICES = {
  b2: {
    label: 'Backblaze B2', keyId: 'Key ID', secret: 'Application key',
    help: 'In Backblaze: Buckets → Create a Bucket (Private), then Application Keys → Add a New Application Key that can only reach that bucket. Copy its keyID and applicationKey.',
  },
  wasabi: {
    label: 'Wasabi', endpoint: 's3.us-east-2.wasabisys.com', keyId: 'Access key ID', secret: 'Secret access key',
    help: 'The endpoint is your bucket’s region (Wasabi lists them under Buckets). Make an access key for a user whose policy reaches only this bucket.',
  },
  r2: {
    label: 'Cloudflare R2', endpoint: 'https://<account id>.r2.cloudflarestorage.com', keyId: 'Access key ID', secret: 'Secret access key',
    help: 'In Cloudflare: R2 → Manage API tokens → Create API token with Object Read & Write, limited to this bucket. It shows the endpoint and both keys.',
  },
  aws: {
    label: 'Amazon S3', region: 'us-east-1', keyId: 'Access key ID', secret: 'Secret access key',
    help: 'Make an IAM user whose policy reaches only this bucket, and an access key for it.',
  },
  s3: {
    label: 'Other S3-compatible', endpoint: 'https://s3.example.com', region: 'Region (if it needs one)', regionOptional: true, keyId: 'Access key ID', secret: 'Secret access key',
    help: 'Any storage that speaks the S3 protocol: enter its endpoint, a bucket, and a key that can reach it.',
  },
};

/**
 * Choosing storage for an encrypted backup: OneDrive (signed in from the browser, or with rclone on another computer),
 * S3-compatible storage or WebDAV, and with `custom` any rclone remote pasted in. Used by a person's own off-site
 * backup (OffsiteBackup.jsx) and the admin console's host backup.
 *
 * Returns { provider, body(), problem, ui }: body() is what the server's setup and test endpoints take, problem says
 * what's still missing (or null), ui is the form. `prev` is the current connection when changing it; `test(body)`
 * resolves to { account } once the storage takes a write; `connect` is { start, finish } for Connect OneDrive.
 */
export function useStoragePicker({
  prev = null, rcloneReady = true, connect, test, folder = 'Note App Backup', rcloneSignIn = true, custom = false, idPrefix = 'os',
}) {
  const [provider, setProvider] = useState(prev?.provider && prev.provider !== 'test' ? prev.provider : 'onedrive');
  // OneDrive: sign in from the browser (Connect OneDrive), or the older way: rclone authorize on a computer, pasted here.
  const [method, setMethod] = useState('browser');
  const [account, setAccount] = useState(null);
  const [token, setToken] = useState('');
  const [s3, setS3] = useState({
    service: prev?.provider === 's3' ? prev.service : 'b2', bucket: '', endpoint: '', region: '', keyId: '', secret: '',
    ...(prev?.provider === 's3' ? prev.fields : {}),
  });
  const [dav, setDav] = useState({ url: '', user: '', pass: '', ...(prev?.provider === 'webdav' ? { url: prev.fields?.url ?? '', user: prev.fields?.user ?? '' } : {}) });
  const [remote, setRemote] = useState('');
  const [path, setPath] = useState('');
  const [tested, setTested] = useState(null); // { ok, text }
  const [testing, setTesting] = useState(false);
  const svc = SERVICES[s3.service];
  const sameStorage = !!prev && provider === prev.provider;
  const id = (k) => `${idPrefix}-${k}`;

  const editS3 = (k) => (e) => { setS3({ ...s3, [k]: e.target.value }); setTested(null); };
  const editDav = (k) => (e) => { setDav({ ...dav, [k]: e.target.value }); setTested(null); };

  const body = () => (provider === 'onedrive'
    ? { provider, connected: method === 'browser', token: method === 'rclone' ? token : null }
    : provider === 's3' ? { provider, ...s3 }
      : provider === 'webdav' ? { provider, ...dav }
        : { provider, remote, folder: path });

  const problem = provider === 'onedrive'
    ? (method === 'browser' && !account ? 'Sign in to OneDrive first.' : method === 'rclone' && !token.trim() ? 'Paste the sign-in from rclone.' : null)
    : provider === 's3'
      ? (!s3.bucket.trim() ? 'Enter the bucket name.'
        : svc.endpoint && !s3.endpoint.trim() && s3.service !== 'wasabi' ? 'Enter the endpoint.'
          : svc.region && !svc.regionOptional && !s3.region.trim() ? 'Enter the region.'
            : !s3.keyId.trim() || !s3.secret.trim() ? `Enter the ${svc.keyId.toLowerCase()} and ${svc.secret.toLowerCase()}.` : null)
      : provider === 'webdav'
        ? (!/^https?:\/\//i.test(dav.url.trim()) ? 'Enter the server address, starting with https://.'
          : !dav.user.trim() || !dav.pass ? 'Enter the user name and password.' : null)
        : (!/^type\s*=/m.test(remote) ? 'Paste the rclone remote (with its type = line).' : null);

  const runTest = async () => {
    if (problem) { setTested({ ok: false, text: problem }); return; }
    setTesting(true);
    setTested(null);
    try {
      const r = await test(body());
      setTested({ ok: true, text: `Connected: Selah can write to ${r.account}.` });
    } catch (err) {
      setTested({ ok: false, text: err.message });
    }
    setTesting(false);
  };

  const ui = (
    <>
      <div className="offsite-providers" role="radiogroup" aria-label="Where to back up">
        {[...PROVIDERS, ...(custom ? [CUSTOM] : [])].map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={provider === p.id}
            className={`offsite-provider${provider === p.id ? ' is-active' : ''}`}
            onClick={() => { setProvider(p.id); setTested(null); }}>
            <Icon name={p.icon} size={20} />
            <span><strong>{p.label}</strong><span className="muted">{p.hint}</span></span>
          </button>
        ))}
      </div>

      {provider === 's3' && (
        <div className="offsite-fields">
          <label className="field-label" htmlFor={id('service')}>Service</label>
          <select id={id('service')} className="input" value={s3.service} onChange={(e) => { setS3({ ...s3, service: e.target.value }); setTested(null); }}>
            {Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <p className="muted offsite-hint">{svc.help}</p>
          <label className="field-label" htmlFor={id('bucket')}>Bucket</label>
          <input id={id('bucket')} className="input" value={s3.bucket} onChange={editS3('bucket')} placeholder="selah-backup" autoComplete="off" spellCheck={false} />
          {svc.endpoint && (<>
            <label className="field-label" htmlFor={id('endpoint')}>Endpoint</label>
            <input id={id('endpoint')} className="input" value={s3.endpoint} onChange={editS3('endpoint')} placeholder={svc.endpoint} autoComplete="off" spellCheck={false} />
          </>)}
          {svc.region && (<>
            <label className="field-label" htmlFor={id('region')}>Region</label>
            <input id={id('region')} className="input" value={s3.region} onChange={editS3('region')} placeholder={svc.region} autoComplete="off" spellCheck={false} />
          </>)}
          <div className="offsite-pair">
            <div>
              <label className="field-label" htmlFor={id('key')}>{svc.keyId}</label>
              <input id={id('key')} className="input" value={s3.keyId} onChange={editS3('keyId')} autoComplete="off" spellCheck={false}
                placeholder={sameStorage && prev.service === s3.service ? 'Enter it again' : ''} />
            </div>
            <div>
              <label className="field-label" htmlFor={id('secret')}>{svc.secret}</label>
              <input id={id('secret')} className="input" type="password" value={s3.secret} onChange={editS3('secret')} autoComplete="new-password"
                placeholder={sameStorage && prev.service === s3.service ? 'Enter it again' : ''} />
            </div>
          </div>
          <p className="muted offsite-hint">Backups go in a “{folder}” folder in the bucket. Use a key that can reach only this bucket: it stays on this server, and never expires.</p>
        </div>
      )}

      {provider === 'webdav' && (
        <div className="offsite-fields">
          <label className="field-label" htmlFor={id('url')}>Server address</label>
          <input id={id('url')} className="input" value={dav.url} onChange={editDav('url')} placeholder="https://cloud.example.com/remote.php/dav/files/you" autoComplete="off" spellCheck={false} />
          <p className="muted offsite-hint">Nextcloud: Files → Settings (bottom left) shows the WebDAV address. Synology: enable WebDAV Server and use https://your-nas:5006.</p>
          <div className="offsite-pair">
            <div>
              <label className="field-label" htmlFor={id('user')}>User name</label>
              <input id={id('user')} className="input" value={dav.user} onChange={editDav('user')} autoComplete="off" spellCheck={false} />
            </div>
            <div>
              <label className="field-label" htmlFor={id('pass')}>App password</label>
              <input id={id('pass')} className="input" type="password" value={dav.pass} onChange={editDav('pass')} autoComplete="new-password" />
            </div>
          </div>
          <p className="muted offsite-hint">Use an app password (Nextcloud: Settings → Security → Create new app password) rather than your main one.</p>
        </div>
      )}

      {provider === 'custom' && (
        <div className="offsite-fields">
          <p className="muted offsite-hint">Any storage rclone supports (Google Drive, SFTP, Box…). Make the remote with <code>rclone config</code> on any computer, then paste its section from rclone.conf:</p>
          <textarea className="input offsite-token" rows={5} value={remote} onChange={(e) => { setRemote(e.target.value); setTested(null); }} spellCheck={false}
            placeholder={'[gdrive]\ntype = drive\n…'} aria-label="rclone remote" />
          <label className="field-label" htmlFor={id('folder')}>Folder (and bucket, if it has them)</label>
          <input id={id('folder')} className="input" value={path} onChange={(e) => { setPath(e.target.value); setTested(null); }} placeholder={folder} />
        </div>
      )}

      {provider !== 'onedrive' && (
        <div className="offsite-test">
          <button type="button" className="btn btn-small" onClick={runTest} disabled={testing || !rcloneReady}>{testing ? 'Testing…' : 'Test connection'}</button>
          {tested && <span className={tested.ok ? 'offsite-ok-text' : 'offsite-failed'} role="status">{tested.ok ? '✓ ' : ''}{tested.text}</span>}
        </div>
      )}

      {provider === 'onedrive' && (method === 'browser' ? (
        <>
          <OneDriveConnect start={connect.start} finish={connect.finish} account={account} onSignedIn={setAccount} />
          {!account && rcloneSignIn && (
            <button type="button" className="link-btn offsite-hint" onClick={() => setMethod('rclone')}>Or sign in with rclone on another computer</button>
          )}
        </>
      ) : (
        <>
          <ol className="offsite-steps">
            <li>On a computer with a web browser, download rclone from{' '}
              <a href="https://rclone.org/downloads/" target="_blank" rel="noopener noreferrer">rclone.org/downloads</a> and unzip it.</li>
            <li>Open a terminal in that folder (Windows: type <code>cmd</code> in the folder’s address bar) and run:
              <Command text='rclone authorize "onedrive"' />
            </li>
            <li>Sign in with your Microsoft account in the browser that opens, and accept.</li>
            <li>In the terminal, copy everything between <code>---&gt;</code> and <code>&lt;---End paste</code>, and paste it here:</li>
          </ol>
          <textarea className="input offsite-token" rows={3} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder='{"access_token":"…","token_type":"Bearer","refresh_token":"…","expiry":"…"}' spellCheck={false}
            aria-label="Sign-in from rclone authorize" />
          <p className="muted offsite-hint">It’s only valid for about an hour, so paste it soon after signing in.</p>
          <button type="button" className="link-btn offsite-hint" onClick={() => setMethod('browser')}>Sign in from this browser instead</button>
        </>
      ))}
    </>
  );

  return { provider, sameStorage, body, problem, ui };
}
