import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from '../config.js';
import security, { requestChecks } from '../security.js';
import { securityHeaders } from '../headers.js';
import adminRoutes from './routes.js';
import { startMonitor } from './monitor.js';
import { startSharingRelay } from './sharing.js';
import { closeStaleJobs, cloud } from './store.js';
import { allowedRanges } from './gateway.js';

/**
 * The admin console's server (started by main.js). It listens on 127.0.0.1 only; Caddy sends admin.<domain> here,
 * and only from the allowed addresses, which are checked again here. Signing in is Selah's own (security.js):
 * password, two-step sign-in, recovery codes, devices and the activity log, in the console's own database.
 */

const app = Fastify({
  logger: { level: process.env.NOTEAPP_LOG_LEVEL || 'info' },
  bodyLimit: 1024 * 1024,
  trustProxy: 'loopback',
});
await app.register(cookie);

// The allowed addresses (Settings → Allowed addresses; home and private networks until some are listed).
let allowCache = { key: null, list: null };
function allowed(ip) {
  const ranges = allowedRanges();
  const key = ranges.join(',');
  if (allowCache.key !== key) {
    const bl = new net.BlockList();
    for (const r of ranges) {
      const [a, bits] = r.split('/');
      bl.addSubnet(a, Number(bits ?? (net.isIPv6(a) ? 128 : 32)), net.isIPv6(a) ? 'ipv6' : 'ipv4');
    }
    allowCache = { key, list: bl };
  }
  const plain = String(ip ?? '').replace(/^::ffff:/, '');
  return net.isIP(plain) ? allowCache.list.check(plain, net.isIPv6(plain) ? 'ipv6' : 'ipv4') : false;
}
app.addHook('onRequest', async (req, reply) => {
  if (!allowed(req.ip)) return reply.code(403).send({ error: 'The admin console doesn’t answer from this address.' });
});

requestChecks(app);
securityHeaders(app);

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({
    error: status >= 500 ? 'Internal server error' : err.message,
    ...(err.reauth ? { reauth: true } : {}), ...(err.restart ? { restart: true } : {}), ...(err.needTwoStep ? { needTwoStep: true } : {}),
  });
});

await app.register(security);
await app.register(adminRoutes);

// The console's page (client/admin.html and its bundle); Selah's own page isn't served here.
if (fs.existsSync(path.join(config.clientDir, 'admin.html'))) {
  await app.register(fastifyStatic, {
    root: config.clientDir,
    index: ['admin.html'],
    cacheControl: false,
    allowedPath: (p) => p !== '/index.html',
    setHeaders(reply, filePath) {
      reply.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.header('Cache-Control', 'no-cache').sendFile('admin.html', config.clientDir);
    reply.code(404).send({ error: 'Not found' });
  });
} else {
  app.log.warn('client/dist/admin.html not found - run "npm run build"');
}

closeStaleJobs();
await app.listen({ host: '127.0.0.1', port: Number(process.env.NOTEAPP_PORT || cloud().adminPort) });
// Stopped by systemd: finish the requests under way (up to 10 seconds), then close the database cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    app.close().catch(() => {}).finally(async () => {
      try { (await import('../db.js')).db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  });
}
startMonitor(app.log);
startSharingRelay(app.log);
