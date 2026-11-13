import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { adminHost, cloud, listTenants, publicTls, tenantHost } from './store.js';
import { paths } from './paths.js';

/**
 * The gateway: Caddy, in front of everything. It holds the certificate and sends each name to the right place:
 *   admin.<domain>   the admin console, only from the allowed addresses
 *   <name>.<domain>  that tenant's Selah (a paused one gets a short "paused" page)
 *   www.<domain>     (13.0.1) the host's own pages, when there are any: each <cloud root>/site/<page>.html is served at
 *                    /<page> (index.html at /), e.g. the privacy policy and support pages the app stores ask for
 *   anything else    "No Selah here"
 * The admin console writes Caddy's whole config (caddy/config.json) and loads it through Caddy's admin API, which
 * listens on a Unix socket in caddy/ (mode 600 folder), not on a network port.
 *
 * The certificate (cloud setting tls):
 *   files  a wildcard certificate in certs/ from the home server's private CA (npm run admin -- cert)
 *   acme   a Let's Encrypt wildcard certificate that Caddy gets and renews itself, proving the domain through DNS
 *          (Cloudflare). Its API token is only in caddy/gateway.env (mode 600), which the gateway service reads; the
 *          config refers to it as {env.CF_API_TOKEN}, so it's never in config.json or the console's database.
 *   acme-host  (12.0, for self-hosters with any DNS provider) a Let's Encrypt certificate for each name (admin.<domain>
 *          and each tenant's), proven over port 443 itself (TLS-ALPN), so only a wildcard DNS record pointing at the
 *          server is needed: no DNS API token and no port 80. A new tenant's name gets its certificate when the
 *          config is next loaded (creating it does that).
 */
export const GATEWAY_ENV = path.join(paths.caddy, 'gateway.env');

export const SOCKET = path.join(paths.caddy, 'admin.sock');
export const CONFIG = path.join(paths.caddy, 'config.json');

// Home and private networks, for the admin console until addresses are listed in Settings.
export const PRIVATE_RANGES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'];
// On a public server private ranges would include the tenants' containers (the Docker bridge), so with none listed
// only the server itself gets in (an SSH tunnel); add your address with npm run admin -- allow-ip add.
export const LOOPBACK_RANGES = ['127.0.0.0/8', '::1/128'];
export const allowedRanges = () => {
  const c = cloud();
  if (c.allowIps.length) return c.allowIps;
  return publicTls(c) ? LOOPBACK_RANGES : PRIVATE_RANGES;
};

const page = (title, text) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`
  + '<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#2b2622}'
  + 'main{max-width:28rem;padding:2rem;text-align:center}h1{font-weight:600;font-size:1.4rem}@media (prefers-color-scheme:dark){body{background:#1d1a17;color:#ece6de}}</style>'
  + `<main><h1>${title}</h1><p>${text}</p></main></html>`;

const staticPage = (status, title, text) => ({
  handler: 'static_response', status_code: status,
  headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'], 'X-Content-Type-Options': ['nosniff'] },
  body: page(title, text),
});

const proxy = (port) => ({
  handler: 'reverse_proxy',
  upstreams: [{ dial: `127.0.0.1:${port}` }],
  // Live updates (server-sent events) go through as they happen.
  flush_interval: -1,
});

/** The host's own pages (<cloud root>/site/*.html), as { path, html }; none when the folder is missing. */
export function sitePages() {
  let files = [];
  try { files = fs.readdirSync(paths.site).filter((f) => /^[a-z0-9-]+\.html$/.test(f)).sort(); } catch { return []; }
  return files.map((f) => ({ path: f === 'index.html' ? '/' : `/${f.slice(0, -5)}`, html: fs.readFileSync(path.join(paths.site, f), 'utf8') }));
}

export const siteHost = () => `www.${cloud().domain}`;

const sitePage = (html) => ({
  handler: 'static_response', status_code: 200,
  headers: {
    'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['max-age=300'], 'X-Content-Type-Options': ['nosniff'],
    'Content-Security-Policy': ["default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"],
    'Referrer-Policy': ['no-referrer'],
  },
  body: html,
});

/** Pictures for those pages: <cloud root>/site/images/* at /images/*, image types only, read from disk. */
const SITE_IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif'].map((x) => `/images/*.${x}`);
const siteImages = () => ({
  match: [{ path: SITE_IMAGES }],
  handle: [
    {
      handler: 'headers',
      response: { set: {
        'Cache-Control': ['max-age=3600'], 'X-Content-Type-Options': ['nosniff'],
        'Content-Security-Policy': ["default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"],
      } },
    },
    { handler: 'file_server', root: paths.site },
  ],
});

export function caddyConfig() {
  const c = cloud();
  if (!c.domain) throw new Error('No domain is set. Run: npm run admin -- init');
  const site = sitePages();
  const routes = [
    {
      match: [{ host: [adminHost()] }],
      handle: [{
        handler: 'subroute',
        routes: [
          { match: [{ remote_ip: { ranges: allowedRanges() } }], handle: [proxy(c.adminPort)] },
          { handle: [staticPage(403, 'Not available', 'The admin console doesn’t answer from this address.')] },
        ],
      }],
      terminal: true,
    },
    ...listTenants().map((t) => ({
      match: [{ host: [tenantHost(t.slug)] }],
      handle: [t.status === 'active' ? proxy(t.port) : staticPage(503, 'Paused', 'This Selah is paused for now. Your notes are safe; ask your Selah host when it will be back.')],
      terminal: true,
    })),
    ...(site.length ? [{
      match: [{ host: [siteHost()] }],
      handle: [{
        handler: 'subroute',
        routes: [
          ...site.map((p) => ({ match: [{ path: p.path === '/' ? ['/'] : [p.path, `${p.path}/`, `${p.path}.html`] }], handle: [sitePage(p.html)] })),
          siteImages(),
          { handle: [staticPage(404, 'Not found', 'There’s no page at this address.')] },
        ],
      }],
      terminal: true,
    }] : []),
    { handle: [staticPage(404, 'No Selah here', 'There’s no Selah at this address. Check the link you were sent.')] },
  ];
  return {
    admin: { listen: `unix/${SOCKET}` },
    apps: {
      http: {
        servers: {
          selah: {
            listen: [`:${c.gatewayPort}`],
            // HTTP/1.1 and 2 over TCP only, so the firewall needs just TCP 443 (no HTTP/3 over UDP).
            protocols: ['h1', 'h2'],
            routes,
            tls_connection_policies: [{}],
            automatic_https: { disable: true },
          },
        },
      },
      tls: c.tls === 'acme' ? acmeTls(c) : c.tls === 'acme-host' ? hostTls(c) : {
        certificates: { load_files: [{ certificate: path.join(paths.certs, 'server.crt'), key: path.join(paths.certs, 'server.key') }] },
      },
    },
  };
}

/** Let's Encrypt: one wildcard certificate for every tenant and the console, through Cloudflare DNS. */
function acmeTls(c) {
  const wildcard = `*.${c.domain}`;
  return {
    certificates: { automate: [wildcard] },
    automation: {
      policies: [{
        subjects: [wildcard],
        issuers: [{
          module: 'acme',
          ...(c.acmeCa ? { ca: c.acmeCa } : {}),
          ...(c.acmeEmail ? { email: c.acmeEmail } : {}),
          challenges: {
            dns: {
              provider: { name: 'cloudflare', api_token: '{env.CF_API_TOKEN}' },
              // Check the new record on public resolvers, not the server's own cache.
              resolvers: ['1.1.1.1', '8.8.8.8'],
            },
          },
        }],
      }],
    },
  };
}

/** Let's Encrypt, one certificate per name, proven on port 443 (TLS-ALPN); no DNS API needed. */
function hostTls(c) {
  const names = [adminHost(), ...listTenants().map((t) => tenantHost(t.slug)), ...(sitePages().length ? [siteHost()] : [])];
  return {
    certificates: { automate: names },
    automation: {
      policies: [{
        subjects: names,
        issuers: [{
          module: 'acme',
          ...(c.acmeCa ? { ca: c.acmeCa } : {}),
          ...(c.acmeEmail ? { email: c.acmeEmail } : {}),
          // Only port 443 is open: no HTTP challenge on port 80.
          challenges: { http: { disabled: true }, 'tls-alpn': { alternate_port: c.gatewayPort } },
        }],
      }],
    },
  };
}

function caddyApi(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: SOCKET, path: url, method,
      headers: { Host: 'caddy', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      timeout: 15_000,
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => (res.statusCode < 300 ? resolve(out) : reject(new Error(`Caddy: ${out.trim() || res.statusCode}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Caddy didn’t answer.')));
    if (data) req.write(data);
    req.end();
  });
}

/** Writes the config file and, if Caddy is running, loads it. Returns { loaded, error }. */
export async function pushGateway() {
  fs.mkdirSync(paths.caddy, { recursive: true, mode: 0o700 });
  const conf = caddyConfig();
  const text = JSON.stringify(conf, null, 2);
  const tmp = `${CONFIG}.new`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  try {
    await caddyApi('POST', '/load', conf);
    return { loaded: true, error: null, hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) };
  } catch (e) {
    return { loaded: false, error: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Caddy isn’t running.' : e.message };
  }
}

/** Is Caddy answering, and with this config? */
export async function gatewayStatus() {
  try {
    await caddyApi('GET', '/config/apps/http/servers/selah/listen');
    return { running: true };
  } catch (e) {
    return { running: false, error: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Caddy isn’t running.' : e.message };
  }
}

const certSummary = (cert) => ({
  names: (cert.subjectAltName ?? '').split(', ').map((s) => s.replace(/^DNS:/, '')),
  validTo: new Date(cert.validTo).getTime(),
  issuer: cert.issuer.replace(/\n/g, ', '),
});

/** The certificate the gateway is serving, asked for over TLS as a browser would (acme). */
function servedCertificate() {
  const c = cloud();
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port: c.gatewayPort, servername: adminHost(), rejectUnauthorized: false, timeout: 5000 }, () => {
      const cert = sock.getPeerX509Certificate();
      sock.end();
      resolve(cert ? certSummary(cert) : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

/** The certificate: names, expiry and issuer (null when there's none yet). */
export async function certificateInfo() {
  if (publicTls()) return servedCertificate();
  try {
    return certSummary(new crypto.X509Certificate(fs.readFileSync(path.join(paths.certs, 'server.crt'))));
  } catch {
    return null;
  }
}
