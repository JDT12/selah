import { db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './secrets.js';

/**
 * Zotero, through the Zotero Web API (the library has to sync to zotero.org). Only a read-only API key is stored
 * (encrypted); the user ID and the readable group libraries come from the key itself.
 *
 * Sources cited in notes are kept in the `sources` table as CSL-JSON, so notes format their citations without
 * Zotero (offline, after a restore) and are part of the backup. Their ids are "zotero:<library>/<item key>",
 * e.g. "zotero:users/123/ABCD2345" or "zotero:groups/456/EFGH6789".
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const SETTING = 'zotero';
const API = 'https://api.zotero.org';
const TIMEOUT = 20_000;
// Tests only: with this set, the key "zoterotestkeyzoterotestkey" connects to that public group library instead.
const TEST_GROUP = process.env.NOTEAPP_ZOTERO_TEST_GROUP;
const TEST_KEY = 'zoterotestkeyzoterotestkey';

db.exec(`CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  csl TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

function connection() {
  const raw = getSetting(SETTING);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return { ...c, apiKey: decrypt(c.secret) };
  } catch {
    return null;
  }
}
const requireConnection = () => {
  const c = connection();
  if (!c) throw httpError(409, 'Zotero isn’t connected. Connect it in Settings → Zotero.');
  return c;
};

async function zotero(pathAndQuery, apiKey) {
  let res;
  try {
    res = await fetch(`${API}${pathAndQuery}`, {
      headers: { 'Zotero-API-Version': '3', ...(apiKey ? { 'Zotero-API-Key': apiKey } : {}) },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw httpError(502, `Couldn’t reach Zotero (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  if (res.status === 403) throw httpError(403, 'Zotero refused the API key. Check it at zotero.org/settings/keys.');
  if (res.status === 429 || res.status === 503) throw httpError(503, 'Zotero is busy; try again in a minute.');
  if (!res.ok) throw httpError(502, `Zotero answered ${res.status}.`);
  return res.json();
}

/** The libraries the key can read: the user's own and any groups. */
async function libraries(c) {
  if (c.testGroup) return [{ id: `groups/${c.testGroup}`, name: 'Test group' }];
  const list = [{ id: `users/${c.userId}`, name: 'My Library' }];
  if (c.groups) {
    const groups = await zotero(`/users/${c.userId}/groups?limit=100`, c.apiKey).catch(() => []);
    for (const g of groups) list.push({ id: `groups/${g.id}`, name: g.data?.name ?? `Group ${g.id}` });
  }
  return list;
}

/** CSL-JSON for an item, with our source id. */
const toSource = (lib, item) => ({ ...(item.csljson ?? {}), id: `zotero:${lib}/${item.key}` });

/** A short line for search results: "Wright, Paul and the Faithfulness of God (2013)". */
function summary(lib, libName, item) {
  const d = item.data ?? {};
  const creators = (d.creators ?? []).filter((x) => x.creatorType === 'author' || x.creatorType === 'editor');
  const first = creators[0];
  const name = first ? (first.lastName ?? first.name ?? '') : '';
  return {
    id: `zotero:${lib}/${item.key}`,
    title: d.title || '(untitled)',
    creator: name + (creators.length > 2 ? ' et al.' : creators.length === 2 ? ` and ${creators[1].lastName ?? creators[1].name ?? ''}` : ''),
    year: (item.meta?.parsedDate ?? '').slice(0, 4),
    type: d.itemType,
    library: libName,
    csl: toSource(lib, item),
  };
}

export function saveSources(list) {
  const up = db.prepare(`INSERT INTO sources (id, csl, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET csl = excluded.csl, updated_at = excluded.updated_at`);
  const now = Date.now();
  for (const s of list) up.run(s.id, JSON.stringify(s), now);
}

export default async function zoteroRoutes(app) {
  app.get('/api/zotero', async () => {
    const c = connection();
    if (!c) return { connected: false };
    return { connected: true, userId: c.userId, username: c.username, groups: !!c.groups, connectedAt: c.connectedAt };
  });

  // Body: { apiKey }. The key is checked with Zotero, which also tells us whose it is.
  app.put('/api/zotero', async (req) => {
    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!/^[A-Za-z0-9]{20,40}$/.test(apiKey)) throw httpError(400, 'That doesn’t look like a Zotero API key (24 letters and numbers).');
    if (TEST_GROUP && apiKey === TEST_KEY) {
      setSetting(SETTING, JSON.stringify({ userId: 0, username: 'test', testGroup: TEST_GROUP, secret: encrypt(''), connectedAt: Date.now() }));
      return { connected: true, userId: 0, username: 'test', groups: false };
    }
    const info = await zotero('/keys/current', apiKey);
    if (!info?.userID) throw httpError(400, 'Zotero didn’t recognise that key.');
    if (!info.access?.user?.library) throw httpError(400, 'This key can’t read your library. Edit it at zotero.org/settings/keys and tick “Allow library access”.');
    const groups = !!info.access?.groups && Object.values(info.access.groups).some((g) => g.library);
    setSetting(SETTING, JSON.stringify({
      userId: info.userID, username: info.username, groups, secret: encrypt(apiKey), connectedAt: Date.now(),
    }));
    return { connected: true, userId: info.userID, username: info.username, groups };
  });

  app.delete('/api/zotero', async () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING);
    return { connected: false };
  });

  app.get('/api/zotero/libraries', async () => libraries(requireConnection()));

  // Search every readable library by title, creator and year. ?q=romans moo
  app.get('/api/zotero/search', async (req) => {
    const c = requireConnection();
    const q = String(req.query.q ?? '').trim().slice(0, 200);
    if (!q) return [];
    const libs = await libraries(c);
    const params = `q=${encodeURIComponent(q)}&qmode=titleCreatorYear&limit=25&include=data,csljson`;
    const results = await Promise.all(libs.map(async (l) => {
      const items = await zotero(`/${l.id}/items/top?${params}`, c.apiKey).catch((e) => (l.id.startsWith('users/') ? Promise.reject(e) : []));
      // Standalone notes and files aren't sources.
      return items.filter((item) => !['note', 'attachment', 'annotation'].includes(item.data?.itemType)).map((item) => summary(l.id, l.name, item));
    }));
    return results.flat();
  });

  // ---------- sources (CSL-JSON of cited items) ----------
  // ?ids=a,b,c -> [{ id, ...csl }]; unknown ids are left out.
  app.get('/api/sources', async (req) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 500);
    if (!ids.length) return [];
    return db.prepare(`SELECT csl FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => JSON.parse(r.csl));
  });

  // The sources cited most recently, for the citation dialog's starting list.
  app.get('/api/sources/recent', async () => db.prepare('SELECT csl FROM sources ORDER BY updated_at DESC LIMIT 20')
    .all().map((r) => JSON.parse(r.csl)));

  // Body: [{ id, ...csl }] (from a search result), saved when a source is cited.
  app.post('/api/sources', async (req) => {
    const list = (Array.isArray(req.body) ? req.body : []).filter((s) => typeof s?.id === 'string' && s.id.length < 200);
    saveSources(list);
    return { saved: list.length };
  });

  // Re-read every cited Zotero item, so edits made in Zotero show up in notes.
  app.post('/api/sources/refresh', async () => {
    const c = requireConnection();
    const ids = db.prepare("SELECT id FROM sources WHERE id LIKE 'zotero:%'").all().map((r) => r.id);
    const byLib = new Map();
    for (const id of ids) {
      const m = /^zotero:((?:users|groups)\/\d+)\/(\w+)$/.exec(id);
      if (m) byLib.set(m[1], [...(byLib.get(m[1]) ?? []), m[2]]);
    }
    let updated = 0;
    for (const [lib, keys] of byLib) {
      for (let i = 0; i < keys.length; i += 50) {
        const items = await zotero(`/${lib}/items?itemKey=${keys.slice(i, i + 50).join(',')}&include=csljson`, c.apiKey);
        saveSources(items.map((item) => toSource(lib, item)));
        updated += items.length;
      }
    }
    return { updated, total: ids.length };
  });
}
