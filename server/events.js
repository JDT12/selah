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

// 14.3: a window's own stream, by its X-Client-Id (sent as ?client= when it connects), for messages meant only for
// it: live co-editing (server/coedit.js) sends the typing of the others in a note this way.
const byClient = new Map();
const goneListeners = new Set();
const CLIENT_ID = /^[\w-]{8,64}$/;
export function sendTo(clientId, data) {
  const set = byClient.get(clientId);
  if (!set) return false;
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(line);
  return true;
}
export const hasStream = (clientId) => byClient.has(clientId);
/** Calls fn(clientId) when a window's last stream closes. */
export function onStreamGone(fn) { goneListeners.add(fn); }

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
    const client = CLIENT_ID.test(String(req.query?.client ?? '')) ? String(req.query.client) : null;
    if (client) {
      if (!byClient.has(client)) byClient.set(client, new Set());
      byClient.get(client).add(res);
    }
    // A stream ends when its session does (signed out elsewhere, password changed, idle too long).
    const sessionId = req.session?.id ?? null;
    const ping = setInterval(() => {
      if (sessionGone(sessionId)) res.end();
      else res.write(': ping\n\n');
    }, PING_EVERY);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      const set = client ? byClient.get(client) : null;
      if (set) {
        set.delete(res);
        if (!set.size) {
          byClient.delete(client);
          for (const fn of goneListeners) { try { fn(client); } catch { /* a listener's own problem */ } }
        }
      }
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || reply.statusCode >= 400) return;
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || QUIET.has(url) || url.startsWith('/api/security') || url.startsWith('/api/coedit/')) return;
    const note = /^\/api\/notes\/(\d+)/.exec(url);
    broadcast({ url, method: req.method, note: note ? Number(note[1]) : null, client: req.headers['x-client-id'] ?? null });
  });
}
