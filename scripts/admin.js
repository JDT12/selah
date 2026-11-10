// The admin console's command line (6.0). Usage: npm run admin -- <command>
//
//   init --domain selah.example.lan [--port 9443] [--admin-port 9450] [--port-base 9500] [--runner process|docker] [--ca data/certs]
//        [--tls files|acme] [--email you@example.com] [--allow-ip <ip>] [--acme-staging]
//                          set up the admin console, the gateway and the wildcard certificate (files: from the
//                          home server's private CA; acme: Let's Encrypt through Cloudflare DNS, for a cloud server)
//   dns-token              save the Cloudflare API token the gateway uses for Let's Encrypt (asks for it; acme only)
//   push-keys [status | apns <AuthKey.p8> --key-id <id> --team <id> --bundle <app id> [--sandbox] | fcm <service-account.json> | remove apns|fcm]
//                          the keys for pushing to the Selah apps (Apple's .p8 key, Google's Firebase service
//                          account), copied to <cloud root>/push, readable only by this user; the console uses them
//                          at once (no restart). Tenants never see them.
//   install                install and start the selah-admin and selah-gateway services (systemd, this user)
//   status                 the console, the gateway, the certificate and every tenant
//   set-password           set the admin console's password
//   reset-two-step         turn off the admin's two-step sign-in (lost phone and recovery codes)
//   allow-ip [list | add <ip or range> | remove <ip or range> | clear]
//                          the addresses the admin console answers from (none listed: home and private networks)
//   cert [--ca data/certs] issue the wildcard certificate again (from the home server's private CA)
//   gateway                write the gateway's config and load it
//   prepare-release [--main]
//                          copy this code (built) into a release for tenants, and with Docker build its image. It's a
//                          beta: only the tenants you move to it (the demo first) run it, until it's promoted.
//                          --main makes it main straight away (urgent fixes). (Console: Updates → Prepare)
//   promote [<version>]    the beta becomes main: new tenants start on it and update moves tenants to it
//   update [<name> …] [--beta | --release <version>]
//                          move tenants (all, or those named) to the main release (or the beta, or that release), one
//                          at a time, each checked and put back if it doesn't come up (Console: Updates)
//   rollback <name> […]    put tenants back on the release each was on before its last update
//   demo-reset [--yes]     put the demo tenant back to its sample data (Console: Tenants → demo → Reset)
//   demo-session           an hour's sign-in to the demo, as JSON (for the smoke test, scripts/smoke.mjs)
//   beta-review [<name>] [--json]
//                          what was ticked off and noted while trying betas (the Beta button in Selah)
//   tenants                list the tenants
//   create <name> [--display "Full name"]    create a tenant and print its setup link
//   setup-link <name> [--reset]              a new one-time setup link
//   restore-file <name> <file> [--yes]       restore a tenant from a backup file (Download a backup in Selah:
//                          .selahbak, asks for its passphrase, or .tar.gz); its data is moved aside first
//   import <name> --from <folder> [--replace] [--display "Full name"]
//                          a home server's Selah (made with npm run cloud-export) as a tenant; checked file by file
//                          and by counts; --replace swaps an existing tenant's data for it
//   suspend | resume | restart <name>
//   maintenance-stop [--force]   stop Selah everywhere for server maintenance: the console (so nothing starts again),
//                          every tenant (each finishes what it's doing first) and the gateway. Refused while a
//                          backup, restore or update is running (--force stops anyway)
//   maintenance-start      start everything again: the gateway, every active tenant (each checked), the console.
//                          A reboot does the same by itself
//   delete <name>          stop it and move its folder to the trash (asks first)
//
// NOTEAPP_CLOUD_ROOT says where everything lives (default notes-data/cloud).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { adminEnv, paths, repoRoot } from '../server/admin/paths.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const opt = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);
const need = (name, what) => opt(name) ?? fail(`Give ${what}: ${name} <value>`);
const VALUE_FLAGS = new Set(['--release', '--domain', '--port', '--admin-port', '--port-base', '--runner', '--prefix', '--ca', '--display', '--tls', '--email', '--allow-ip', '--from']);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.has(all[i - 1]));
const arg = (n) => positional[n];
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);
// Problems print as one line, not a stack trace.
process.on('uncaughtException', (e) => fail(e.statusCode ? e.message : (e.stack ?? e.message)));

let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
function ask(q, { secret = false } = {}) {
  if (!process.stdin.isTTY) fail(`${q.trim()} needs an interactive terminal.`);
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(q);
    muted = secret;
    rl.question('', (a) => { if (secret) process.stdout.write('\n'); muted = false; rl.close(); resolve(a); });
  });
}

const marker = path.join(paths.adminStorage, '.note-app-storage');
if (cmd !== 'help' && cmd !== 'init' && !fs.existsSync(marker)) fail(`The admin console isn't set up in ${paths.root}. Run: npm run admin -- init --domain <domain>`);

function issueCert(domain, caDir) {
  const ca = path.resolve(repoRoot, caDir);
  if (!fs.existsSync(path.join(ca, 'ca.key'))) fail(`No private CA in ${ca} (ca.crt and ca.key). Run npm run gen-certs first, or pass --ca.`);
  fs.mkdirSync(paths.certs, { recursive: true, mode: 0o700 });
  const key = path.join(paths.certs, 'server.key');
  const csr = path.join(paths.certs, 'server.csr');
  const ext = path.join(paths.certs, 'ext.cnf');
  fs.writeFileSync(ext, [`subjectAltName=DNS:*.${domain},DNS:${domain}`, 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth'].join('\n'));
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=*.${domain}`], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(ca, 'ca.crt'), '-CAkey', path.join(ca, 'ca.key'), '-CAcreateserial',
    '-out', path.join(paths.certs, 'server.crt'), '-days', '825', '-sha256', '-extfile', ext], { stdio: 'ignore' });
  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  fs.copyFileSync(path.join(ca, 'ca.crt'), path.join(paths.certs, 'ca.crt'));
  fs.chmodSync(key, 0o600);
  ok(`Certificate for *.${domain} and ${domain} (from the CA in ${ca}), valid 825 days`);
}

// ---------- init (before the database is opened) ----------
if (cmd === 'init') {
  const domain = String(opt('--domain') ?? '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) fail('Give the domain tenants live under: --domain selah.example.lan');
  for (const d of [paths.adminData, paths.adminStorage, paths.tenants, paths.releases, paths.caddy, paths.trash]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.root, 0o700);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Selah admin console storage. Do not delete.\n');
  adminEnv();
  const { cloud, saveCloud } = await import('../server/admin/store.js');
  const runner = opt('--runner', cloud().runner);
  if (!['process', 'docker'].includes(runner)) fail('--runner is process or docker');
  const tlsMode = opt('--tls', cloud().tls);
  if (!['files', 'acme', 'acme-host'].includes(tlsMode)) fail('--tls is files, acme (Cloudflare wildcard) or acme-host (any DNS provider)');
  const email = opt('--email', cloud().acmeEmail ?? null);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('--email doesn’t look like an email address');
  let allowIps = cloud().allowIps;
  if (opt('--allow-ip')) {
    const { cleanRange } = await import('../server/admin/routes.js');
    allowIps = [...new Set([...allowIps, cleanRange(opt('--allow-ip'))])];
  }
  saveCloud({
    domain,
    // A home server's ports 80 and 443 usually aren't free (or need root), so 9443 unless told otherwise; a cloud
    // server (acme) uses 443.
    gatewayPort: Number(opt('--port', cloud().domain ? cloud().gatewayPort : tlsMode.startsWith('acme') ? 443 : 9443)),
    adminPort: Number(opt('--admin-port', cloud().adminPort)),
    portBase: Number(opt('--port-base', cloud().portBase)),
    unitPrefix: opt('--prefix', cloud().unitPrefix),
    runner,
    tls: tlsMode,
    acmeEmail: email,
    // Let's Encrypt's test service (certificates browsers don't trust), for trying the setup without its limits.
    acmeCa: flag('--acme-staging') ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : null,
    allowIps,
  });
  ok(`Admin console set up in ${paths.root}`);
  if (tlsMode === 'files' && (!fs.existsSync(path.join(paths.certs, 'server.crt')) || flag('--new-cert'))) issueCert(domain, opt('--ca', 'data/certs'));
  const c = cloud();
  const { pushGateway } = await import('../server/admin/gateway.js');
  await pushGateway();
  ok(`Gateway config written (port ${c.gatewayPort}; admin.${domain} and <name>.${domain})`);
  if (tlsMode === 'acme-host') {
    console.log(`Certificates: Let’s Encrypt for admin.${domain} and each tenant’s name${c.acmeCa ? ' (test service)' : ''}, checked on port 443`);
    console.log(`Admin console answers from: ${c.allowIps.length ? c.allowIps.join(', ') : 'this server only (add yours: npm run admin -- allow-ip add <ip>)'}`);
  }
  if (tlsMode === 'acme') {
    console.log(`Certificate: Let’s Encrypt for *.${domain}${c.acmeCa ? ' (test service)' : ''}, through Cloudflare DNS`);
    const { GATEWAY_ENV } = await import('../server/admin/gateway.js');
    if (!fs.existsSync(GATEWAY_ENV)) console.log('  It needs the Cloudflare API token: npm run admin -- dns-token');
    console.log(`Admin console answers from: ${c.allowIps.length ? c.allowIps.join(', ') : 'this server only (add yours: npm run admin -- allow-ip add <ip>)'}`);
  }
  const auth = await import('../server/auth.js');
  if (!auth.passwordIsSet()) console.log('\nNext: npm run admin -- set-password, then npm run admin -- install');
  else console.log('\nNext: npm run admin -- install (if the services aren\'t installed yet)');
  process.exit(0);
}

if (cmd === 'help' || cmd === '--help') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

adminEnv();
const store = await import('../server/admin/store.js');
const auth = await import('../server/auth.js');
const c = store.cloud();

switch (cmd) {
  case 'set-password': {
    const pw = await ask('New admin password: ', { secret: true });
    const problem = await auth.passwordProblem(pw);
    if (problem) fail(problem);
    if ((await ask('Confirm password: ', { secret: true })) !== pw) fail('Passwords do not match.');
    await auth.setPassword(pw);
    auth.logEvent('password-changed', null, { from: 'server' });
    ok('Admin password set. Sign in at the admin console, then turn on two-step sign-in (it is required).');
    break;
  }
  case 'reset-two-step': {
    const { setSetting } = await import('../server/db.js');
    setSetting('totp', 'null');
    setSetting('recovery_codes', '[]');
    auth.logEvent('two-step-off', null, { from: 'server' });
    ok('Two-step sign-in is off for the admin. Sign in with the password and set it up again (Security).');
    break;
  }
  case 'allow-ip': {
    const { cleanRange } = await import('../server/admin/routes.js');
    const sub = argv[1] ?? 'list';
    let list = [...c.allowIps];
    if (sub === 'add') list = [...new Set([...list, cleanRange(argv[2])])];
    else if (sub === 'remove') { const r = cleanRange(argv[2]); list = list.filter((x) => x !== r); }
    else if (sub === 'clear') list = [];
    else if (sub !== 'list') fail('allow-ip list | add <ip> | remove <ip> | clear');
    if (sub !== 'list') {
      store.saveCloud({ allowIps: list });
      const { pushGateway } = await import('../server/admin/gateway.js');
      const g = await pushGateway();
      ok(`Saved${g.loaded ? ' and loaded into the gateway' : ` (gateway: ${g.error})`}`);
    }
    console.log(list.length ? list.map((x) => `  ${x}`).join('\n') : '  (none listed: the console answers from home and private networks only)');
    break;
  }
  case 'push-keys': {
    const { PUSH_DIR, pushKeys } = await import('../server/admin/push.js');
    const crypto = await import('node:crypto');
    const what = argv[1] ?? 'status';
    const save = (name, data) => {
      fs.mkdirSync(PUSH_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(PUSH_DIR, `${name}.new`), data, { mode: 0o600 });
      fs.renameSync(path.join(PUSH_DIR, `${name}.new`), path.join(PUSH_DIR, name));
    };
    if (what === 'apns') {
      const file = argv[2];
      const keyId = opt('--key-id');
      if (!file || !fs.existsSync(file)) fail('Give the .p8 file Apple made: push-keys apns <AuthKey_XXXXXXXXXX.p8> --key-id <id>');
      const pem = fs.readFileSync(file, 'utf8');
      try { crypto.createPrivateKey(pem); } catch { fail('That file isn’t a private key (use the .p8 file Apple made, unchanged).'); }
      const id = keyId ?? /AuthKey_([A-Z0-9]{10})\.p8$/.exec(file)?.[1];
      if (!/^[A-Z0-9]{10}$/.test(id ?? '')) fail('Give the key’s 10-character Key ID: --key-id <id> (it’s in the file name and in Apple’s Keys list).');
      const meta = JSON.stringify({ keyId: id, teamId: need('--team', 'the Apple Team ID'), bundleId: need('--bundle', 'the app’s bundle ID'), production: !flag('--sandbox') }, null, 2);
      save('apns.p8', pem);
      save('apns.json', meta);
      ok(`Apple push key ${id} saved (${PUSH_DIR}). You can delete the copy you gave here.`);
    } else if (what === 'fcm') {
      const file = argv[2];
      if (!file || !fs.existsSync(file)) fail('Give the service account file from Firebase: push-keys fcm <file.json> (Project settings → Service accounts → Generate new private key)');
      let sa;
      try { sa = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('That file isn’t JSON.'); }
      if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key || !sa.project_id) fail('That isn’t a Firebase service account file.');
      try { crypto.createPrivateKey(sa.private_key); } catch { fail('The service account’s private key can’t be read.'); }
      save('fcm.json', JSON.stringify({ type: sa.type, project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key }));
      ok(`Firebase key for ${sa.project_id} saved (${PUSH_DIR}). You can delete the copy you gave here.`);
    } else if (what === 'remove') {
      const which = argv[2];
      if (which === 'apns') { fs.rmSync(path.join(PUSH_DIR, 'apns.p8'), { force: true }); fs.rmSync(path.join(PUSH_DIR, 'apns.json'), { force: true }); }
      else if (which === 'fcm') fs.rmSync(path.join(PUSH_DIR, 'fcm.json'), { force: true });
      else fail('push-keys remove apns | fcm');
      ok(`Removed the ${which === 'apns' ? 'Apple' : 'Firebase'} push key.`);
    }
    const k = pushKeys();
    console.log(`iPhone and iPad (Apple): ${k.apns ? `ready, key ${k.apns.keyId}, ${k.apns.production === false ? 'sandbox' : 'production'}` : 'no key'}`);
    console.log(`Android (Firebase): ${k.fcm ? `ready, project ${k.fcm.projectId}` : 'no key'}`);
    break;
  }
  case 'dns-token': {
    if (c.tls !== 'acme') fail('The DNS token is only for Let’s Encrypt certificates (init --tls acme).');
    // Asked for, not taken from the command line, so it never lands in the shell's history. Piped input works too.
    let token;
    if (process.stdin.isTTY) token = await ask('Cloudflare API token (Edit zone DNS, for this domain only): ', { secret: true });
    else token = fs.readFileSync(0, 'utf8');
    token = token.trim();
    if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) fail('That doesn’t look like a Cloudflare API token.');
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${token}` } }).catch((e) => fail(`Couldn’t reach Cloudflare: ${e.message}`));
    const body = await res.json().catch(() => ({}));
    if (!body.success || body.result?.status !== 'active') fail(`Cloudflare says the token isn’t valid: ${body.errors?.[0]?.message ?? res.status}`);
    const zone = c.domain.split('.').slice(-2).join('.');
    const zres = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zone)}`, { headers: { Authorization: `Bearer ${token}` } });
    const zbody = await zres.json().catch(() => ({}));
    if (!zbody.result?.length) fail(`The token can’t see the ${zone} zone. Give it Zone → DNS → Edit for ${zone}.`);
    const { GATEWAY_ENV } = await import('../server/admin/gateway.js');
    fs.mkdirSync(path.dirname(GATEWAY_ENV), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${GATEWAY_ENV}.new`, `CF_API_TOKEN=${token}\n`, { mode: 0o600 });
    fs.renameSync(`${GATEWAY_ENV}.new`, GATEWAY_ENV);
    ok(`Token saved for ${zone} (${GATEWAY_ENV}, readable only by this user)`);
    if (spawnSync('systemctl', ['--user', 'is-active', 'selah-gateway.service']).stdout.toString().trim() === 'active') {
      spawnSync('systemctl', ['--user', 'restart', 'selah-gateway.service'], { stdio: 'inherit' });
      ok('The gateway restarted with it.');
    }
    break;
  }
  case 'cert': {
    if (store.publicTls(c)) {
      const { certificateInfo } = await import('../server/admin/gateway.js');
      const cert = await certificateInfo();
      console.log(cert ? `The gateway serves ${cert.names.join(', ')} from ${cert.issuer}, until ${new Date(cert.validTo).toDateString()}.` : 'The gateway isn’t serving a certificate yet.');
      console.log('Let’s Encrypt certificates are renewed by the gateway itself. To make it try again now: systemctl --user restart selah-gateway');
      break;
    }
    issueCert(c.domain, opt('--ca', 'data/certs'));
    const { pushGateway } = await import('../server/admin/gateway.js');
    const g = await pushGateway();
    console.log(g.loaded ? '✓ The gateway is using it now.' : `The gateway will use it when it starts (${g.error}).`);
    break;
  }
  case 'gateway': {
    const { pushGateway, CONFIG } = await import('../server/admin/gateway.js');
    const g = await pushGateway();
    ok(`Wrote ${CONFIG}`);
    console.log(g.loaded ? '✓ Loaded into the gateway.' : `Not loaded: ${g.error}`);
    break;
  }
  case 'install': {
    const caddy = [process.env.NOTEAPP_CADDY, path.join(os.homedir(), '.local', 'bin', 'caddy')].find((p) => p && fs.existsSync(p));
    if (!caddy) fail('Caddy isn’t installed. Run: npm run install-caddy');
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    const { CONFIG, GATEWAY_ENV } = await import('../server/admin/gateway.js');
    if (c.tls === 'acme' && !fs.existsSync(GATEWAY_ENV)) fail('The gateway needs the Cloudflare API token first: npm run admin -- dns-token');
    fs.writeFileSync(path.join(unitDir, 'selah-admin.service'), `[Unit]
Description=Selah admin console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${process.execPath} server/admin/main.js
Environment=NODE_ENV=production
Environment=NOTEAPP_CLOUD_ROOT=${paths.root}
${store.publicTls(c) ? 'Environment=NOTEAPP_HSTS=1\n' : ''}Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`);
    fs.writeFileSync(path.join(unitDir, 'selah-gateway.service'), `[Unit]
Description=Selah gateway (Caddy) for the admin console and tenants
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${caddy} run --config ${CONFIG}
Environment=XDG_DATA_HOME=${path.join(paths.caddy, 'data')}
Environment=XDG_CONFIG_HOME=${path.join(paths.caddy, 'config')}
${c.tls === 'acme' ? `EnvironmentFile=${GATEWAY_ENV}\n` : ''}Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`);
    const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
    sc('daemon-reload');
    sc('enable', '--now', 'selah-gateway.service');
    sc('enable', '--now', 'selah-admin.service');
    ok('Installed selah-admin and selah-gateway (they start at boot, with linger on)');
    console.log(`Admin console: ${store.publicUrl(store.adminHost())}`);
    break;
  }
  case 'status': {
    const { gatewayStatus, certificateInfo } = await import('../server/admin/gateway.js');
    const { runner } = await import('../server/admin/runner.js');
    const { releaseVersion } = await import('../server/admin/releases.js');
    const g = await gatewayStatus();
    const cert = await certificateInfo();
    console.log(`Selah admin console at ${store.publicUrl(store.adminHost())} (${c.runner} runner)`);
    console.log(`  ${spawnSync('systemctl', ['--user', 'is-active', 'selah-admin.service']).stdout.toString().trim() === 'active' ? '✓' : '✗'} admin console service`);
    console.log(`  ${g.running ? '✓' : '✗'} gateway${g.running ? '' : `: ${g.error}`}`);
    console.log(`  ${cert && cert.validTo > Date.now() + 21 * 86400_000 ? '✓' : '✗'} certificate${cert ? ` (until ${new Date(cert.validTo).toDateString()})` : ': none'}`);
    console.log(`  ${auth.passwordIsSet() ? '✓' : '✗'} admin password${auth.passwordIsSet() ? '' : ': npm run admin -- set-password'}`);
    console.log(`  · allowed addresses: ${c.allowIps.length ? c.allowIps.join(', ') : 'home and private networks'}`);
    for (const t of store.listTenants()) {
      console.log(`  ${t.status === 'active' ? (await runner().status(t)) === 'active' ? '✓' : '✗' : '·'} ${t.slug.padEnd(20)} ${t.status.padEnd(9)} ${releaseVersion(t.release) ?? ''}  ${t.url}`);
    }
    break;
  }
  case 'prepare-release': {
    const rel = await import('../server/admin/releases.js');
    const channel = flag('--main') ? 'main' : 'beta';
    const { jobId, release } = rel.prepareRelease({ channel });
    rel.holdCliLock(`Preparing ${release}`, jobId);
    console.log(`Preparing release ${release}${c.runner === 'docker' ? ' and building its image (a few minutes)' : ''}…`);
    let last = '';
    while (rel.runningHere()) {
      const ph = rel.runningHere()?.phase ?? '';
      if (ph && ph !== last) { console.log(`  ${ph}`); last = ph; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    rel.releaseCliLock();
    const job = store.listJobs({ limit: 20 }).find((j) => j.id === jobId);
    if (!job?.ok) fail(`Release ${release} wasn’t prepared: ${job?.detail?.error ?? 'unknown error'}`);
    ok(channel === 'main'
      ? `Release ${release} is ready as main; new tenants start on it. Update existing ones in the console (Updates) or: npm run admin -- update`
      : `Release ${release} is ready as beta. Move the demo to it (npm run admin -- update demo --beta), then promote it when it's approved.`);
    break;
  }
  case 'promote': {
    const rel = await import('../server/admin/releases.js');
    const r = rel.promoteRelease(arg(0) || undefined);
    ok(`${r.release} is main now (was ${r.from ?? 'this code'}). New tenants start on it; update the others with: npm run admin -- update`);
    break;
  }
  case 'rollback': {
    const rel = await import('../server/admin/releases.js');
    if (!positional.length) fail('Name the tenants to roll back.');
    const { jobId, tenants } = rel.rollBack(positional.map((n) => store.mustTenant(n).slug));
    rel.holdCliLock('Rolling back', jobId);
    console.log(`Rolling back ${tenants.join(', ')}…`);
    while (rel.runningHere()) await new Promise((r) => setTimeout(r, 1000));
    rel.releaseCliLock();
    const job = store.listJobs({ limit: 20 }).find((j) => j.id === jobId);
    if (!job?.ok) fail(job?.detail?.error ?? 'Rolling back stopped.');
    ok(`Rolled back: ${job.detail.done.map((d) => `${d.slug} (${rel.releaseVersion(d.to) ?? 'this code'})`).join(', ')}`);
    break;
  }
  case 'demo-reset': {
    const demo = await import('../server/admin/demo.js');
    store.mustTenant(demo.DEMO_SLUG);
    if (!flag('--yes')) {
      const a = await ask(`Reset the demo tenant to its sample data? Everything in it now is replaced. Type ${demo.DEMO_SLUG}: `);
      if (a.trim() !== demo.DEMO_SLUG) fail('Not reset.');
    }
    const rel = await import('../server/admin/releases.js');
    const { jobId } = demo.resetDemo();
    // So the console's monitor doesn't start the demo again while it's stopped for the reset.
    rel.holdCliLock('Resetting the demo', jobId);
    console.log('Resetting the demo…');
    while (demo.demoResetRunning()) await new Promise((r) => setTimeout(r, 1000));
    rel.releaseCliLock();
    const job = store.listJobs({ limit: 20 }).find((j) => j.id === jobId);
    if (!job?.ok) fail(job?.detail?.error ?? 'The reset stopped.');
    ok(`The demo is back to its sample data${job.detail?.counts ? ` (${Object.entries(job.detail.counts).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}.`);
    break;
  }
  case 'demo-session': {
    // For scripts/smoke.mjs: one line of JSON with an hour's sign-in to the demo. Nothing else is printed.
    const demo = await import('../server/admin/demo.js');
    const { control } = await import('../server/admin/control.js');
    const { releaseVersion } = await import('../server/admin/releases.js');
    const t = store.mustTenant(demo.DEMO_SLUG);
    const r = await control(t, 'POST', '/control/demo-session');
    console.log(JSON.stringify({ url: t.url, version: releaseVersion(t.release), token: r.token, expires: r.expires }));
    break;
  }
  case 'beta-review': {
    // What was ticked off and noted on the demo while trying betas (newest beta first). --json for scripts.
    const demo = await import('../server/admin/demo.js');
    const { control } = await import('../server/admin/control.js');
    const t = store.mustTenant(arg(0) ?? demo.DEMO_SLUG);
    const { reviews } = await control(t, 'GET', '/control/beta-review');
    if (flag('--json')) { console.log(JSON.stringify(reviews)); break; }
    const versions = Object.keys(reviews).reverse();
    if (!versions.length) console.log(`Nothing ticked off or noted on ${t.slug} yet.`);
    for (const v of versions) {
      const r = reviews[v];
      console.log(`${v}: ${Object.keys(r.checks).length} tried, ${r.notes.length} note${r.notes.length === 1 ? '' : 's'}`);
      for (const n of r.notes) console.log(`  ✎ ${new Date(n.at).toLocaleString()}${n.page ? ` (${n.page})` : ''}${n.item ? `\n    on: ${n.item.slice(0, 90)}` : ''}\n    ${n.text}`);
    }
    break;
  }
  case 'update': {
    const rel = await import('../server/admin/releases.js');
    const names = positional.length ? positional.map((n) => store.mustTenant(n).slug) : null;
    const release = opt('--release') ?? (flag('--beta') ? rel.betaRelease() : rel.currentRelease());
    if (flag('--beta') && !release) fail('There’s no beta release. Prepare one first: npm run admin -- prepare-release');
    const { jobId, tenants } = rel.rollingUpdate({ release, slugs: names });
    rel.holdCliLock('Updating tenants', jobId);
    console.log(`Updating ${tenants.join(', ')} to ${rel.releaseVersion(release)}…`);
    let last = '';
    while (rel.runningHere()) {
      const ph = rel.runningHere()?.phase ?? '';
      if (ph && ph !== last) { console.log(`  ${ph}`); last = ph; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    rel.releaseCliLock();
    const job = store.listJobs({ limit: 20 }).find((j) => j.id === jobId);
    if (!job?.ok) fail(job?.detail?.error ?? 'The update stopped.');
    ok(`Updated: ${job.detail.done.map((d) => d.slug).join(', ')}`);
    break;
  }
  case 'tenants': {
    const list = store.listTenants();
    if (!list.length) console.log('No tenants yet: npm run admin -- create <name>');
    for (const t of list) console.log(`${t.slug.padEnd(20)} ${t.status.padEnd(9)} ${t.url}  ${t.name}`);
    break;
  }
  case 'create': {
    const { createTenant } = await import('../server/admin/lifecycle.js');
    const r = await createTenant({ slug: arg(0), name: opt('--display', arg(0)) });
    ok(`Created ${r.tenant.slug} at ${r.tenant.url}`);
    console.log(`\nSetup link (one use, until ${new Date(r.link.expires).toLocaleString()}):\n  ${r.link.url}`);
    break;
  }
  case 'import': {
    if (!opt('--from')) fail('Give the exported folder: import <name> --from <folder>');
    const { importTenant } = await import('../server/admin/lifecycle.js');
    const r = await importTenant({ slug: arg(0), name: opt('--display', arg(0)), from: opt('--from'), replace: flag('--replace'), log: (m) => console.log(`  ${m}`) });
    const c2 = r.counts;
    ok(`${r.tenant.slug} is running at ${r.tenant.url}, imported from ${r.from} (${r.version})`);
    console.log(`  ${c2.notes} notes (${c2.notesInTrash} in the trash), ${c2.notebooks} notebooks, ${c2.attachments} attachments, ${c2.tags} tags, ${c2.tasks} tasks, ${c2.events} events: all match`);
    console.log(`  ${r.files} files, ${(r.bytes / 1e6).toFixed(0)} MB, each checked against the export`);
    console.log('  Sign in with the same password and authenticator as on the home server.');
    if (!r.withOffsite) console.log('  The OneDrive backup connection wasn’t included (a trial copy).');
    break;
  }
  case 'restore-file': {
    const t = store.mustTenant(arg(0));
    if (!arg(1)) fail('Give the backup file: restore-file <name> <file>');
    const file = path.resolve(arg(1));
    if (!fs.existsSync(file)) fail(`No such file: ${file}`);
    const { backupKind, passphraseFits } = await import('../server/backupfile.js');
    const kind = backupKind(file);
    if (kind !== 'encrypted' && kind !== 'plain') fail('That isn’t a Selah backup file (.selahbak or .tar.gz from Download a backup).');
    let passphrase = null;
    if (kind === 'encrypted') {
      passphrase = process.env.NOTEAPP_RESTORE_PASSPHRASE ?? await ask('Backup passphrase: ', { secret: true });
      if (!await passphraseFits(file, passphrase)) fail('That’s not the passphrase this backup was made with.');
    }
    if (!flag('--yes') && (await ask(`Restore ${t.slug} from ${path.basename(file)}? Its current data is moved aside (kept in its folder) and everyone signs in again. Type its name to confirm: `)) !== t.slug) fail('Not restored.');
    const backups = await import('../server/admin/backups.js');
    console.log('  Unpacking and checking the file, then restoring…');
    const r = await backups.restoreFromFile(t.slug, file, passphrase).done.catch((e) => fail(e.message));
    ok(`${t.slug} restored${r.at ? ` from the backup made ${new Date(r.at).toLocaleString()}` : ''}: ${r.notes} notes, ${r.files} files${r.missing ? ` (${r.missing} attachment(s) the database mentions weren’t in the file)` : ''}`);
    console.log(`  The data it replaced is in ${r.aside}`);
    break;
  }
  case 'setup-link': {
    const { setupLink } = await import('../server/admin/lifecycle.js');
    const r = await setupLink(arg(0), flag('--reset') ? 'reset' : 'invite');
    console.log(`Setup link (${r.kind}, one use, until ${new Date(r.expires).toLocaleString()}):\n  ${r.url}`);
    break;
  }
  case 'suspend': case 'resume': case 'restart': {
    const lc = await import('../server/admin/lifecycle.js');
    const t = await lc[`${cmd}Tenant`](arg(0));
    ok(`${t.slug}: ${cmd === 'suspend' ? 'paused' : cmd === 'resume' ? 'running again' : 'restarted'}`);
    break;
  }
  case 'maintenance-stop': {
    const mm = await import('../server/admin/maintenancemode.js');
    const { runner } = await import('../server/admin/runner.js');
    const busy = store.listJobs({ limit: 50 }).filter((j) => !j.finished_at && Date.now() - j.started_at < 6 * 3_600_000);
    if (busy.length && !flag('--force')) fail(`Not now: ${busy.map((j) => `${j.kind}${j.slug ? ` (${j.slug})` : ''}`).join(', ')} is running. Wait for it, or add --force.`);
    const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
    mm.enterMaintenance();
    console.log('Stopping Selah for maintenance…');
    sc('stop', 'selah-admin.service');
    ok('Admin console stopped (it can’t start tenants again while it’s stopped)');
    for (const t of store.listTenants().filter((x) => x.status === 'active')) {
      await runner().stop(t);
      ok(`${t.slug} stopped`);
    }
    sc('stop', 'selah-gateway.service');
    ok('Gateway stopped: nobody can reach Selah now');
    console.log(`
Selah is stopped. Update the server:
  sudo apt update && sudo apt full-upgrade
Then either reboot (everything starts by itself):
  sudo reboot
or, without a reboot:
  npm run admin -- maintenance-start`);
    break;
  }
  case 'maintenance-start': {
    const mm = await import('../server/admin/maintenancemode.js');
    const { runner } = await import('../server/admin/runner.js');
    const { waitHealthy } = await import('../server/admin/control.js');
    const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
    if (c.runner === 'docker' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) fail('Docker isn’t running. Start it: sudo systemctl start docker');
    console.log('Starting Selah…');
    sc('start', 'selah-gateway.service');
    ok('Gateway started');
    let failed = 0;
    for (const t of store.listTenants().filter((x) => x.status === 'active')) {
      try {
        await runner().start(t);
        const h = await waitHealthy(t, { timeout: 90_000 });
        ok(`${t.slug} running ${h.version}`);
      } catch (e) {
        failed++;
        console.error(`✗ ${t.slug}: ${e.message}`);
      }
    }
    mm.leaveMaintenance();
    sc('start', 'selah-admin.service');
    ok('Admin console started');
    if (failed) fail(`${failed} tenant${failed === 1 ? '' : 's'} didn’t come up; the console keeps trying. See: docker logs ${c.unitPrefix}-<name>`);
    ok('Selah is running everywhere');
    break;
  }
  case 'delete': {
    const t = store.mustTenant(arg(0));
    if ((await ask(`Delete ${t.slug} (${t.url})? Its folder goes to the trash for 7 days and its host backup is removed. Type its name to confirm: `)) !== t.slug) fail('Not deleted.');
    const { deleteTenant } = await import('../server/admin/lifecycle.js');
    await deleteTenant(t.slug, 'admin');
    ok(`${t.slug} deleted`);
    break;
  }
  default:
    fail(`Unknown command: ${cmd}. Try: npm run admin -- help`);
}
process.exit(0);
