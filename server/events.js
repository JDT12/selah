// Live updates. Every open Selah window keeps one /api/events stream (server-sent events). After any change made
// through the API (an edit, a clip from the Edge clipper, a task ticked on the phone), the server sends a short
// message saying what changed; each window then fetches what it shows. The message carries the X-Client-Id of the
// window that made the change, so that window can tell its own saves apart.
import { db } from './db.js';

const clients = new Set();
const PING_EVERY = 25_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// The phone remote's traffic goes out as its own messages (server/slides.js), not as changes for windows to fetch.
const QUIET = new Set(['/api/login', '/api/login/code', '/api/logout', '/api/events', '/api/password', '/api/slides/live', '/api/slides/live/command']);

export function broadcast(data) {
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}

const sessionGone = (id) => id != null && !db.prepare('SELECT 1 FROM sessions WHERE rowid = ?').get(id);

export function eventRoutes(app) {
  // Closing: end the open streams, or the server waits for them (windows reconnect to whatever starts next).
  app.addHook('preClose', async () => { for (const res of clients) res.end(); clients.clear(); });
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    // A stream ends when its session does (signed out elsewhere, password changed, idle too long).
    const sessionId = req.session?.id ?? null;
    const ping = setInterval(() => {
      if (sessionGone(sessionId)) res.end();
      else res.write(': ping\n\n');
    }, PING_EVERY);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || reply.statusCode >= 400) return;
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || QUIET.has(url) || url.startsWith('/api/security')) return;
    const note = /^\/api\/notes\/(\d+)/.exec(url);
    broadcast({ url, method: req.method, note: note ? Number(note[1]) : null, client: req.headers['x-client-id'] ?? null });
  });
}
