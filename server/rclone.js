import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { checkPublicHost } from './netguard.js';

/**
 * rclone plumbing shared by the off-site backup (server/offsite.js) and the restore script
 * (scripts/restore.js). Nothing here touches the database, so a restore can use it before one exists.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

/** The folder (in OneDrive, on a WebDAV server or in an S3 bucket) that holds the encrypted backup. */
export const FOLDER = 'Note App Backup';

export function rclonePath() {
  const candidates = [process.env.NOTEAPP_RCLONE, path.join(os.homedir(), '.local', 'bin', 'rclone'), 'rclone'].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/') ? fs.existsSync(c) : spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}

export function rcloneVersion() {
  const bin = rclonePath();
  if (!bin) return null;
  const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
  return r.stdout?.split('\n')[0]?.replace(/^rclone\s+/, '') || null;
}

/**
 * A function that runs rclone with the config file `conf`. JSON log lines go to onLog; with
 * `progress`, rclone's live progress is shown on this terminal. Resolves to stdout; rejects with a
 * readable message.
 */
export function rcloneRunner(conf) {
  return function rclone(args, { input, onLog, log = false, progress = false, env } = {}) {
    const bin = rclonePath();
    if (!bin) return Promise.reject(httpError(500, 'rclone isn’t installed on the server. Run: npm run install-rclone'));
    return new Promise((resolve, reject) => {
      const full = ['--config', conf, ...(log ? ['--use-json-log', '-v'] : []), ...(progress ? ['--progress'] : []), ...args];
      const p = spawn(bin, full, { stdio: ['pipe', progress ? 'inherit' : 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
      let out = '';
      let errBuf = '';
      const errors = [];
      p.stdout?.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => {
        errBuf += d;
        let i;
        while ((i = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, i);
          errBuf = errBuf.slice(i + 1);
          let entry = null;
          try { entry = JSON.parse(line); } catch { /* plain text */ }
          if (entry) {
            if (entry.level === 'error' || entry.level === 'critical') errors.push(entry.msg);
            onLog?.(entry);
          } else if (line.trim() && !/Config file .* not found/.test(line)) {
            errors.push(line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d (ERROR|CRITICAL|NOTICE|INFO)\s*:\s*/, ''));
          }
        }
      });
      p.on('error', (e) => reject(e));
      p.on('close', (code) => {
        if (errBuf.trim()) errors.push(errBuf.trim());
        if (code === 0) resolve(out);
        else reject(new Error(friendly(errors.at(-1) || `rclone exited with code ${code}`)));
      });
      p.stdin.end(input ?? '');
    });
  };
}

export function friendly(msg) {
  const m = String(msg);
  if (/invalid_grant|InvalidAuthenticationToken|unauthenticated|couldn't fetch token|token expired|AADSTS/i.test(m)) {
    return 'OneDrive sign-in has expired or was revoked. Reconnect in Settings → Off-site backup.';
  }
  if (/quotaLimitReached|insufficientStorage|quota|507 Insufficient Storage|cap_exceeded|storage_cap/i.test(m)) return 'The backup storage is full.';
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|bad_auth_token|unauthorized|AccessDenied|\b401\b|403 Forbidden/i.test(m)) {
    return 'The backup storage turned down the key or password. Check it (or make a new one) and reconnect in Settings → Off-site backup.';
  }
  if (/NoSuchBucket|bucket.{0,40}(not found|doesn.t exist)/i.test(m)) return 'That bucket doesn’t exist. Check its name, and the region or endpoint.';
  const diff = m.match(/cryptcheck: (\d+) differences? found/i);
  if (diff) return `${diff[1]} attachment${diff[1] === '1' ? '' : 's'} in the backup ${diff[1] === '1' ? 'doesn’t' : 'don’t'} match this server. The next backup re-sends ${diff[1] === '1' ? 'it' : 'them'}; check again after it.`;
  if (/no such host|dial tcp|i\/o timeout|connection refused|network is unreachable/i.test(m)) return `Couldn’t reach the backup storage (${m.slice(0, 120)}).`;
  // "Failed to copyto: open /very/long/encrypted/path: permission denied" -> "open …: permission denied"
  const short = m.replace(/^Failed to [\w-]+:\s*/, '').replace(/(?:\/[^:/\n]+){3,}\/?/g, '…');
  return short.length > 300 ? `${short.slice(0, 300)}…` : short;
}

/** The token from `rclone authorize "onedrive"`: JSON, or (newer rclone) a base64 blob wrapping it. */
export function parseToken(text) {
  const s = String(text ?? '');
  const candidates = [];
  const json = s.match(/\{[\s\S]*\}/);
  if (json) candidates.push(json[0]);
  for (const w of s.split(/\s+/)) {
    if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(w)) candidates.push(Buffer.from(w, 'base64').toString('utf8'));
  }
  for (const c of candidates) {
    try {
      let o = JSON.parse(c);
      if (typeof o.token === 'string') o = JSON.parse(o.token);
      else if (o.token && typeof o.token === 'object') o = o.token;
      if (o.access_token && o.refresh_token) return o;
    } catch { /* try the next */ }
  }
  throw httpError(400, 'That isn’t what rclone authorize prints. Copy everything between “--->” and “<---End paste”.');
}

/** Which OneDrive the token belongs to (rclone needs its id). */
export async function onedriveDrive(token) {
  let res;
  try {
    res = await fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,owner', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw httpError(400, `Couldn’t reach OneDrive (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401) throw httpError(400, 'That sign-in has expired (they last about an hour). Run rclone authorize again and paste the new result.');
  if (!res.ok) throw httpError(400, `OneDrive answered with an error (${res.status}).`);
  const d = await res.json();
  return { id: d.id, type: d.driveType, account: d.owner?.user?.displayName || d.owner?.user?.email || 'OneDrive' };
}

const quote = (v) => String(v).replace(/[\r\n]/g, '');

/** A OneDrive remote, [onedrive] unless `name` says: the real one from a token, or (tests) a local folder standing in for it. */
export function onedriveSection({ token, drive, testDir, name = 'onedrive' }) {
  if (testDir) return `[${name}]\ntype = alias\nremote = ${quote(testDir)}\n`;
  return `[${name}]\ntype = onedrive\ntoken = ${quote(JSON.stringify(token))}\ndrive_id = ${quote(drive.id)}\ndrive_type = ${quote(drive.type)}\nregion = global\n`;
}

/** rclone's reversible "obscured" form of a password, as its config files store it. */
export const obscure = async (text) => (await rcloneRunner('')(['obscure', '-'], { input: text })).trim(); // '': no config file

/**
 * Full config: the storage remote plus the encrypted "offsite" remote keyed by the passphrase, kept at `root` (a
 * remote:path; configs made before 6.1 always used the OneDrive folder).
 */
export async function buildConf(storage, passphrase, root = `onedrive:${FOLDER}`) {
  const obscured = await obscure(passphrase);
  return `${storage}\n[offsite]\ntype = crypt\nremote = ${quote(root)}\npassword = ${quote(obscured)}\n`;
}

// ---------- S3-compatible storage and WebDAV ----------

/** What each kind of storage is called on screen. */
export const SERVICE_NAMES = {
  onedrive: 'OneDrive', b2: 'Backblaze B2', wasabi: 'Wasabi', r2: 'Cloudflare R2', aws: 'Amazon S3', s3: 'S3 storage', webdav: 'WebDAV',
};
const S3_PROVIDER = { wasabi: 'Wasabi', r2: 'Cloudflare', aws: 'AWS', s3: 'Other' };

const one = (v, what, { required = true, max = 512 } = {}) => {
  const s = String(v ?? '').trim();
  if (!s && required) throw httpError(400, `Enter the ${what}.`);
  if (/[\r\n\t]/.test(s) || s.length > max) throw httpError(400, `That ${what} doesn’t look right.`);
  return s;
};

/**
 * Checks what someone typed for S3-compatible storage ({ service, bucket, keyId, secret, endpoint, region }) or
 * WebDAV ({ url, user, pass }), and returns { provider, service, account, root, fields, secrets }: `fields` is what
 * can be shown again (no keys or passwords), `secrets` the rest. Endpoints and servers must be on the internet,
 * not on this server's own network.
 */
export async function storageTarget(input) {
  const provider = input?.provider;
  if (provider === 's3') {
    const service = input.service;
    if (!SERVICE_NAMES[service] || service === 'onedrive' || service === 'webdav') throw httpError(400, 'Choose which storage service.');
    const bucket = one(input.bucket, 'bucket name', { max: 63 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) throw httpError(400, 'A bucket name has only letters, digits, dots and dashes.');
    const keyId = one(input.keyId, service === 'b2' ? 'key ID' : 'access key ID', { max: 256 });
    const secret = one(input.secret, service === 'b2' ? 'application key' : 'secret access key', { max: 256 });
    let endpoint = '';
    if (service === 'wasabi' || service === 'r2' || service === 's3') {
      endpoint = one(input.endpoint || (service === 'wasabi' ? 's3.wasabisys.com' : ''), 'endpoint');
      if (!/^https?:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
      try { endpoint = (await checkPublicHost(endpoint)).origin; } catch (e) { throw httpError(400, e.message); }
    }
    const region = one(input.region || (service === 'r2' ? 'auto' : ''), 'region', { required: service === 'aws', max: 64 });
    if (region && !/^[a-z0-9-]+$/i.test(region)) throw httpError(400, 'A region looks like us-east-1.');
    return {
      provider, service, account: bucket, root: `target:${bucket}/${FOLDER}`,
      fields: { bucket, endpoint, region }, secrets: { keyId, secret },
    };
  }
  if (provider === 'webdav') {
    let url;
    try { url = await checkPublicHost(one(input.url, 'server address')); } catch (e) { throw httpError(400, e.message); }
    const user = one(input.user, 'user name', { max: 256 });
    const pass = one(input.pass, 'password', { max: 512 });
    const vendor = /\/remote\.php\/(dav|webdav)/.test(url.pathname) ? 'nextcloud' : 'other';
    const address = url.href.replace(/\/+$/, '');
    return {
      provider, service: 'webdav', account: `${user} on ${url.host}`, root: `target:${FOLDER}`,
      fields: { url: address, user, vendor }, secrets: { pass },
    };
  }
  throw httpError(400, 'Choose where backups go.');
}

/** The [target] remote for a checked storageTarget(). */
export async function storageSection(t, name = 'target') {
  const { service, fields: f, secrets: s } = t;
  if (t.provider === 'webdav') {
    return `[${name}]\ntype = webdav\nurl = ${quote(f.url)}\nvendor = ${f.vendor}\nuser = ${quote(f.user)}\npass = ${quote(await obscure(s.pass))}\n`;
  }
  // B2 hides deleted files by default, which would keep (and bill for) every pruned snapshot.
  if (service === 'b2') return `[${name}]\ntype = b2\naccount = ${quote(s.keyId)}\nkey = ${quote(s.secret)}\nhard_delete = true\n`;
  // A key limited to one bucket can't list or create buckets, so don't try.
  return `[${name}]\ntype = s3\nprovider = ${S3_PROVIDER[service]}\nenv_auth = false\naccess_key_id = ${quote(s.keyId)}\nsecret_access_key = ${quote(s.secret)}\n`
    + `${f.endpoint ? `endpoint = ${quote(f.endpoint)}\n` : ''}${f.region ? `region = ${quote(f.region)}\n` : ''}no_check_bucket = true\n`;
}

/** Proves the storage takes a write: a small file in the backup folder, removed again. */
export async function probeStorage(rclone, root) {
  const probe = `${root}/.selah-write-check`;
  await rclone(['rcat', probe], { input: `Selah checked it can write here, ${new Date().toISOString()}\n` });
  await rclone(['deletefile', probe]).catch(() => {});
}

export function writeConf(conf, text) {
  fs.mkdirSync(path.dirname(conf), { recursive: true, mode: 0o700 });
  const tmp = `${conf}.new`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, conf);
}

// ---------- connecting OneDrive from the browser ----------

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};

/**
 * OneDrive sign-in without running rclone on a PC. `rclone authorize` runs here and waits on 127.0.0.1:53682 (the
 * address its Microsoft app registration redirects to); the browser signs in at Microsoft, which then sends it to
 * http://localhost:53682/ on the person's own computer. Nothing answers there, but the address bar now holds the
 * code: pasted back, it's passed to the waiting rclone, which swaps it for the token. One sign-in at a time per
 * server (the port is fixed); each is good for 15 minutes and belongs to whoever started it.
 */
export function oneDriveAuthorizer(dir) {
  let current = null; // { proc, out, err, closed, owner, state, expires }
  const stop = () => {
    if (current && !current.closed) current.proc.kill();
    current = null;
  };
  return {
    async start(owner) {
      const bin = rclonePath();
      if (!bin) throw httpError(500, 'rclone isn’t installed on the server. Run: npm run install-rclone');
      stop();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const proc = spawn(bin, ['authorize', 'onedrive', '--auth-no-open-browser', '--config', path.join(dir, 'authorize.conf')], { stdio: ['ignore', 'pipe', 'pipe'] });
      const a = { proc, out: '', err: '', closed: false, owner, state: null, expires: Date.now() + 15 * 60_000 };
      proc.stdout.on('data', (d) => { a.out += d; });
      proc.stderr.on('data', (d) => { a.err += d; });
      proc.on('close', () => { a.closed = true; });
      proc.on('error', () => { a.closed = true; });
      current = a;
      const link = await until(() => a.err.match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[\w-]+/)?.[0] || (a.closed ? 'closed' : null), 10_000);
      if (!link || link === 'closed') {
        stop();
        throw httpError(503, /address already in use|bind/i.test(a.err)
          ? 'Another OneDrive sign-in is in progress on this server. Try again in a few minutes.'
          : 'rclone couldn’t start the OneDrive sign-in.');
      }
      const res = await fetch(link, { redirect: 'manual' });
      const to = res.headers.get('location') ?? '';
      if (!to.startsWith('https://login.microsoftonline.com/')) { stop(); throw httpError(502, 'rclone didn’t give a Microsoft sign-in address.'); }
      a.state = new URL(to).searchParams.get('state');
      setTimeout(() => { if (current === a) stop(); }, 15 * 60_000).unref();
      return to;
    },
    /** The token, from the address the browser ended up at after signing in. */
    async finish(owner, pasted) {
      const a = current;
      if (!a || a.owner !== owner || a.expires < Date.now() || a.closed) throw httpError(409, 'That sign-in has ended. Click Connect OneDrive again.');
      let u;
      try { u = new URL(String(pasted ?? '').trim()); } catch {
        throw httpError(400, 'Paste the whole address from the browser’s address bar. It starts with http://localhost:53682/');
      }
      if (u.searchParams.get('error')) {
        throw httpError(400, `Microsoft said: ${(u.searchParams.get('error_description') || u.searchParams.get('error')).slice(0, 200)}`);
      }
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== a.state) throw httpError(400, 'That address isn’t from this sign-in. Click Connect OneDrive again.');
      await fetch(`http://127.0.0.1:53682/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(a.state)}`, { signal: AbortSignal.timeout(30_000) }).catch(() => {});
      const out = await until(() => (a.out.includes('<---End paste') ? a.out : a.closed ? 'closed' : null), 30_000);
      const why = a.err.trim().split('\n').filter((l) => !/NOTICE/.test(l)).at(-1) ?? '';
      stop();
      if (!out || out === 'closed') throw httpError(400, `The OneDrive sign-in didn’t finish${why ? ` (${friendly(why)})` : ''}. Click Connect OneDrive and try again.`);
      return parseToken(out);
    },
    cancel(owner) { if (current?.owner === owner) stop(); },
  };
}
