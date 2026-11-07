import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import security, { requestChecks } from './security.js';
import account from './account.js';
import routes, { scheduleTrash } from './routes.js';
import restorePoints, { scheduleRestorePoints, takeRestorePoint } from './restorepoints.js';
import { tidyNotebooks } from './mynotes.js';
import notebookFile from './notebookfile.js';
import exportRoutes from './export.js';
import categoryRoutes from './categories.js';
import noteTools from './notetools.js';
import planner from './planner.js';
import wordpress from './wordpress.js';
import wpSite from './wpsite.js';
import offsite from './offsite.js';
import backupDownload from './backupdownload.js';
import zotero from './zotero.js';
import scripture from './scripture.js';
import dailyWalk from './dailywalk.js';
import esv from './esv.js';
import bible from './bible.js';
import votd from './votd.js';
import verses from './verses.js';
import bibleStudies from './biblestudy.js';
import lang from './lang.js';
import prayer from './prayer.js';
import readingPlans from './readingplans.js';
import attendance from './attendance.js';
import betaReview from './betareview.js';
import attachments from './attachments.js';
import links from './links.js';
import capture from './capture.js';
import studies from './studies.js';
import courses from './courses.js';
import desk from './desk.js';
import classes from './classes.js';
import series from './series.js';
import sermons from './sermons.js';
import methods from './methods.js';
import work from './work.js';
import slides from './slides.js';
import guide from './guide.js';
import ocr from './ocr.js';
import { addCornellTemplate } from './cornell.js';
import { eventRoutes } from './events.js';
import desktopBackups, { scheduleDesktopBackups, seedDesktopDemo } from './desktopbackup.js';
import tenant, { quotaCheck, startTenant } from './tenant.js';
import sharing, { startSharing } from './sharing.js';
import { securityHeaders } from './headers.js';

const keyPath = path.join(config.certDir, 'server.key');
const certPath = path.join(config.certDir, 'server.crt');
if (config.tls && (!fs.existsSync(keyPath) || !fs.existsSync(certPath))) {
  console.error(`TLS certificate not found in ${config.certDir}. Run: npm run gen-certs`);
  process.exit(1);
}

addCornellTemplate();

const app = Fastify({
  logger: { level: process.env.NOTEAPP_LOG_LEVEL || 'info' },
  // Behind Caddy (tenant mode) the certificate is Caddy's, and this listens on plain HTTP on a private address.
  ...(config.tls ? { https: { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } } : {}),
  bodyLimit: 50 * 1024 * 1024,
  // Behind a reverse proxy (Caddy in the cloud), the client's address comes from X-Forwarded-For.
  // NOTEAPP_TRUST_PROXY: "true", a number of hops, or the proxy's addresses.
  trustProxy: ((v) => (!v ? false : v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v))(process.env.NOTEAPP_TRUST_PROXY),
});

await app.register(cookie);
await app.register(multipart);

// Old addresses that forward to a new one, e.g. {"notes.example.lan": "selah.example.lan"} in data/host-redirects.json.
// Only page loads move; the API still answers on the old name, so an app installed from it keeps working until
// it's reinstalled from the new address.
let hostRedirects = {};
try {
  hostRedirects = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'host-redirects.json'), 'utf8'));
} catch { /* none set up */ }

app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  const [hostName, hostPort] = String(req.headers.host ?? '').toLowerCase().split(':');
  const to = Object.hasOwn(hostRedirects, hostName) && hostRedirects[hostName];
  const isPageLoad = req.headers['sec-fetch-mode'] === 'navigate'
    || (!req.headers['sec-fetch-mode'] && String(req.headers.accept ?? '').includes('text/html'));
  if (to && req.method === 'GET' && isPageLoad && !url.startsWith('/api/') && url !== '/ca.crt') {
    return reply.redirect(`https://${to}${hostPort ? `:${hostPort}` : ''}${req.url}`, 302);
  }
});
// Signed in? Same origin? Too many requests? (security.js)
requestChecks(app);
// Room for this upload? (tenant.js; only with a storage quota)
quotaCheck(app);

// Security headers on every response (headers.js).
securityHeaders(app);

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({
    error: status >= 500 ? 'Internal server error' : err.message,
    ...(err.reauth ? { reauth: true } : {}), ...(err.restart ? { restart: true } : {}),
  });
});

// The private CA certificate, public so a new device can download and trust it before signing in (home servers only).
if (config.mode === 'single') app.get('/ca.crt', async (req, reply) => {
  const ca = fs.readFileSync(path.join(config.certDir, 'ca.crt'));
  return reply
    .header('Content-Type', 'application/x-x509-ca-cert')
    .header('Content-Disposition', 'attachment; filename="Selah-CA.crt"')
    .header('Cache-Control', 'no-cache')
    .send(ca);
});

// Provides reply.sendFile (with Range support) for attachments; serves nothing by itself.
await app.register(fastifyStatic, { root: config.filesDir, serve: false });
// Live updates: added on the app itself (not as a plugin) so its onResponse hook sees every route.
eventRoutes(app);
await app.register(security);
await app.register(account);
await app.register(routes);
await app.register(exportRoutes);
await app.register(categoryRoutes);
await app.register(noteTools);
await app.register(planner);
await app.register(wordpress);
await app.register(wpSite);
await app.register(zotero);
await app.register(scripture);
await app.register(dailyWalk);
await app.register(esv);
await app.register(bible);
await app.register(votd);
await app.register(verses);
await app.register(bibleStudies);
await app.register(lang);
await app.register(prayer);
await app.register(readingPlans);
await app.register(attendance);
await app.register(betaReview);
await app.register(attachments);
await app.register(links);
await app.register(capture);
await app.register(studies);
await app.register(courses);
await app.register(desk);
await app.register(classes);
await app.register(series);
await app.register(sermons);
await app.register(methods);
await app.register(work);
await app.register(slides);
await app.register(guide);
await app.register(ocr);
await app.register(desktopBackups);
await app.register(offsite);
await app.register(backupDownload);
await app.register(restorePoints);
await app.register(notebookFile);
await app.register(tenant);
await app.register(sharing);

if (fs.existsSync(config.clientDir)) {
  await app.register(fastifyStatic, {
    root: config.clientDir,
    index: ['index.html'],
    decorateReply: false,
    cacheControl: false,
    setHeaders(reply, filePath) {
      // Vite's hashed bundles never change; everything else (index.html, pdf.js) revalidates.
      reply.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    },
  });
  // Unknown non-API paths get the SPA shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html', config.clientDir);
    }
    reply.code(404).send({ error: 'Not found' });
  });
} else {
  app.log.warn('client/dist not found - run "npm run build"');
}

// 10.1: notes sorted by tags: fold other notebooks into My notes (a restore point first, the first time).
try { await tidyNotebooks(app.log, takeRestorePoint); } catch (e) { app.log.error(`Tidying notebooks failed: ${e.message}`); }

await app.listen({ host: config.host, port: config.port });
// Stopped by systemd or Docker: finish the requests under way (up to 10 seconds), then close the database cleanly.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 10_000).unref();
  app.close().catch(() => {}).finally(async () => {
    try { (await import('./db.js')).db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
};
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, shutdown);
// Selah Desktop asks over its IPC channel (Windows has no SIGTERM for a child process).
if (process.send) {
  process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
  // The app went away without asking (it crashed): don't stay running on our own.
  process.on('disconnect', shutdown);
}
await startTenant(app.log, app);
startSharing();
scheduleRestorePoints(app.log);
scheduleDesktopBackups(app.log);
seedDesktopDemo(app, app.log).catch((e) => app.log.error(`Desktop demo: ${e.message}`));
scheduleTrash(app.log);
