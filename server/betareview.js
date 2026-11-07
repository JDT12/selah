import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from './db.js';
import { config } from './config.js';

/**
 * Trying a beta (11.1): while Selah runs a pre-release (11.1.0-beta.2), the top bar's Beta button lists what's new in
 * it (shared/whatsnew.js, the entry for the coming release) to tick off as you try each thing, with "Something's off"
 * for a note about it. Kept in the setting `beta_review` as { [version]: { checks: { [item]: at }, notes: [...] } },
 * which the demo's Reset keeps (server/admin/demo.js KEEP_SETTINGS) and the admin console reads over the control port
 * (npm run admin -- beta-review).
 */
const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const KEEP_VERSIONS = 6;

function all() {
  try { return JSON.parse(getSetting('beta_review') ?? '{}') ?? {}; } catch { return {}; }
}
function save(map) {
  const keep = Object.keys(map).slice(-KEEP_VERSIONS);
  setSetting('beta_review', JSON.stringify(Object.fromEntries(keep.map((k) => [k, map[k]]))));
}
const forVersion = (map, v) => map[v] ?? { checks: {}, notes: [] };
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Every version's review (for the admin console). */
export const betaReviews = () => all();

export default async function betaReview(app) {
  app.get('/api/beta-review', async () => ({ version: VERSION, beta: VERSION.includes('-'), ...forVersion(all(), VERSION) }));

  // { item, done }: an item is the What's New line itself (its first 300 characters).
  app.put('/api/beta-review/check', async (req) => {
    const item = clean(req.body?.item, 300);
    if (!item) throw httpError(400, 'Which item?');
    const map = all();
    const r = forVersion(map, VERSION);
    if (req.body?.done) r.checks[item] = Date.now();
    else delete r.checks[item];
    map[VERSION] = r;
    save(map);
    return r;
  });

  // { item (optional), text, page }: something that didn't work or look right.
  app.post('/api/beta-review/note', async (req) => {
    const text = clean(req.body?.text, 2000);
    if (!text) throw httpError(400, 'Say what’s off.');
    const map = all();
    const r = forVersion(map, VERSION);
    if (r.notes.length >= 200) throw httpError(409, 'That’s a lot of notes for one beta. Send these first.');
    r.notes.push({ id: Date.now(), at: Date.now(), item: clean(req.body?.item, 300) || null, text, page: clean(req.body?.page, 200) || null });
    map[VERSION] = r;
    save(map);
    return r;
  });

  app.delete('/api/beta-review/note/:id', async (req) => {
    const map = all();
    const r = forVersion(map, VERSION);
    r.notes = r.notes.filter((n) => String(n.id) !== String(req.params.id));
    map[VERSION] = r;
    save(map);
    return r;
  });
}
