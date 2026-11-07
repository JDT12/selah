import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt } from './secrets.js';
import { cachedFontsCss, fontFile, siteStyle } from './wpstyle.js';
import { safeFetch } from './netguard.js';

/**
 * Publishing notes to a WordPress site through its REST API, signed in with an Application
 * Password (Users → Profile in WordPress). All WordPress calls go through this server, so the
 * password never reaches the browser. It's stored encrypted with a key kept in the data
 * directory, so a copy of the notes disk alone doesn't reveal it.
 *
 * The form is built from what the site reports: the post schema (custom fields such as the
 * Scripture Blog plugin's scripture_refs / sbt_downloads), the taxonomies attached to posts,
 * and their terms.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};

const SETTING = 'wordpress';
const TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 15 * 60_000;

// ---------- the stored connection ----------

// Posts this app changed on the site without posting the note (scheduling, publishing, moving categories), so
// those changes aren't mistaken for edits made in WordPress.
db.exec('CREATE TABLE IF NOT EXISTS wp_touched (site TEXT NOT NULL, post_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (site, post_id))');
export const touched = (site, postId) => db.prepare('INSERT INTO wp_touched (site, post_id, at) VALUES (?, ?, ?) ON CONFLICT(site, post_id) DO UPDATE SET at = excluded.at')
  .run(site, postId, Date.now());

// Dashboard numbers, cached briefly; cleared (with whatever else registers in `onChange`) when posts change.
let statsCache = null;
export const onChange = new Set();
export function changed() {
  statsCache = null;
  for (const fn of onChange) fn();
}

export function connection() {
  const raw = getSetting(SETTING);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return { ...c, password: decrypt(c.secret) };
  } catch {
    return null; // key lost or setting damaged: treat as not connected
  }
}
export const requireConnection = () => {
  const c = connection();
  if (!c) throw httpError(409, 'Not connected to WordPress. Connect in Settings → WordPress.');
  return c;
};

// ---------- talking to WordPress ----------

/** "example.com/blog/" -> "https://example.com/blog". Only HTTPS: the password is sent with every request. */
function normalizeSite(input) {
  let s = String(input ?? '').trim();
  if (!s) throw httpError(400, 'Enter the site address.');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw httpError(400, 'That doesn’t look like a web address.'); }
  if (u.protocol !== 'https:') throw httpError(400, 'The site must use HTTPS (https://…).');
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/+$/, '');
}

/** URL for a REST route, for sites with pretty permalinks (/wp-json/) or without (?rest_route=). */
function routeUrl(conn, route, query = {}) {
  const qs = new URLSearchParams(query).toString();
  if (conn.apiRoot.includes('rest_route=')) {
    return `${conn.site}/?rest_route=${encodeURIComponent(route)}${qs ? `&${qs}` : ''}`;
  }
  return `${conn.apiRoot.replace(/\/$/, '')}${route}${qs ? `?${qs}` : ''}`;
}

export async function wpFetch(conn, route, { method = 'GET', query, json, body, headers = {}, timeout = TIMEOUT, auth = true } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (auth) h.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString('base64')}`;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await safeFetch(routeUrl(conn, route, query), {
      method, headers: h, body, duplex: body instanceof ReadableStream ? 'half' : undefined,
      signal: AbortSignal.timeout(timeout), redirect: 'follow',
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'it took too long to answer' : e.cause?.code === 'EPRIVATE' ? 'it’s on a private network' : (e.cause?.code || e.cause?.message || e.message);
    throw httpError(400, `Couldn't reach ${conn.site} (${why}).`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    // 4xx (not 5xx) so the message reaches the user instead of a generic server error.
    const err = httpError(res.status === 404 ? 404 : 400, wpMessage(res.status, data, conn));
    err.wpCode = data?.code;
    err.wpData = data?.data;
    throw err;
  }
  if (data === null && text) throw httpError(400, `${conn.site} answered with something other than WordPress data.`);
  return { data, headers: res.headers };
}

function wpMessage(status, data, conn) {
  const msg = data?.message ? String(data.message).replace(/<[^>]+>/g, '') : null;
  if (status === 401 || data?.code === 'incorrect_password' || data?.code === 'invalid_username') {
    return 'WordPress didn’t accept the username or application password.';
  }
  if (data?.code === 'rest_not_logged_in') {
    // Some hosts strip the Authorization header before PHP sees it.
    return 'WordPress didn’t receive the sign-in details. The web host may be removing the Authorization header; '
      + 'ask the host (or check .htaccess) to pass it through to WordPress.';
  }
  return msg ? `WordPress: ${msg}` : `${conn.site} returned an error (${status}).`;
}

/** Find the REST API root and site name. */
async function discover(site) {
  const conn = { site, apiRoot: `${site}/wp-json/` };
  for (const apiRoot of [`${site}/wp-json/`, `${site}/?rest_route=/`]) {
    conn.apiRoot = apiRoot;
    try {
      const { data } = await wpFetch(conn, '/', { auth: false });
      if (data && Array.isArray(data.namespaces)) return { apiRoot, name: data.name || site, namespaces: data.namespaces };
    } catch (e) {
      if (/^Couldn't reach/.test(e.message)) throw e;
    }
  }
  throw httpError(400, `No WordPress REST API found at ${site}. Check the address (it should be the site's home page).`);
}

/** The Scripture Blog plugin's version and the post fields it accepts; null when it isn't installed. */
async function pluginInfo(conn, namespaces) {
  if (!namespaces?.includes('scripture-blog/v1')) return null;
  try {
    return (await wpFetch(conn, '/scripture-blog/v1/info')).data;
  } catch {
    return { version: null, fields: [] }; // plugin older than 2.5.0
  }
}

/** Ask again (the plugin may have been installed, updated or removed since connecting) and remember the answer. */
async function refreshPlugin(conn) {
  let plugin;
  try {
    plugin = (await wpFetch(conn, '/scripture-blog/v1/info')).data;
  } catch (e) {
    if (e.statusCode !== 404) return conn.plugin; // unsure (e.g. a network blip): keep what we knew
    const { data } = await wpFetch(conn, '/', { auth: false }).catch(() => ({ data: null }));
    plugin = data?.namespaces?.includes('scripture-blog/v1') ? { version: null, fields: [] } : null;
  }
  if (JSON.stringify(plugin) !== JSON.stringify(conn.plugin)) {
    const saved = JSON.parse(getSetting(SETTING));
    setSetting(SETTING, JSON.stringify({ ...saved, plugin }));
    conn.plugin = plugin;
  }
  return plugin;
}
const pluginField = (conn, name) => !!conn.plugin?.fields?.includes(name);
/** Scripture Blog 2.7+ hosts devotionals (one a day, at /wp/v2/devotionals); its info lists their fields under "devotionals". */
const hasDevotionals = (conn) => !!conn.plugin?.devotionals;
const KINDS = { post: 'posts', devotional: 'devotionals' };
const DEVOTIONAL_FIELDS = ['devotional_date', 'verse_reference', 'verse_text', 'verse_version', 'application'];

const publicStatus = (c) => (c
  ? {
    connected: true, site: c.site, name: c.name, username: c.username, displayName: c.displayName,
    canPublish: c.canPublish, plugin: c.plugin, autoTag: c.autoTag !== false,
  }
  : { connected: false });

/** Upload a file to the media library once per site; later calls reuse it if it's still there. */
async function uploadMedia(conn, key, { filename, mime, open }) {
  const cached = db.prepare('SELECT media_id, url FROM wp_media WHERE key = ? AND site = ?').get(key, conn.site);
  if (cached) {
    try {
      const { data } = await wpFetch(conn, `/wp/v2/media/${cached.media_id}`, { query: { context: 'edit', _fields: 'id,source_url' } });
      return { id: data.id, url: data.source_url };
    } catch (e) {
      if (e.statusCode !== 404) throw e; // deleted in WordPress: upload again
    }
  }
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const { data } = await wpFetch(conn, '/wp/v2/media', {
    method: 'POST',
    body: open(),
    timeout: UPLOAD_TIMEOUT,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
  db.prepare('INSERT INTO wp_media (key, site, media_id, url) VALUES (?, ?, ?, ?) ON CONFLICT(key, site) DO UPDATE SET media_id = excluded.media_id, url = excluded.url')
    .run(key, conn.site, data.id, data.source_url);
  return { id: data.id, url: data.source_url };
}

/** Every term of a taxonomy (WordPress pages them 100 at a time). */
export async function allTerms(conn, restBase) {
  const terms = [];
  for (let page = 1; page <= 30; page++) {
    const { data, headers } = await wpFetch(conn, `/wp/v2/${restBase}`, {
      query: { per_page: 100, page, orderby: 'name', order: 'asc', hide_empty: 'false', _fields: 'id,name,parent' },
    });
    terms.push(...data.map((t) => ({ id: t.id, name: decodeEntities(t.name), parent: t.parent ?? 0 })));
    if (page >= Number(headers.get('x-wp-totalpages') || 1)) break;
  }
  return terms;
}

export const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");

/** wp_posts statuses for posts deleted from the app: the row stays so the form choices are remembered. */
const DELETED = ['trash', 'deleted'];
export const LIVE = `status NOT IN ('trash', 'deleted')`;
/** Notes edited since they were last posted (a couple of seconds' grace for the save that comes with posting). */
export const STALE = 'n.updated_at > p.posted_at + 2000';

/** Our record of a note's post, plus its current state in WordPress (null if it was deleted there). */
async function notePost(conn, noteId) {
  const row = db.prepare('SELECT post_id, link, status, form, kind FROM wp_posts WHERE note_id = ? AND site = ?').get(noteId, conn.site);
  if (!row) return { post: null, form: null };
  const form = row.form ? JSON.parse(row.form) : null;
  if (DELETED.includes(row.status)) return { post: null, form };
  const kind = KINDS[row.kind] ? row.kind : 'post';
  const fields = ['id', 'link', 'status', 'date_gmt', ...(kind === 'devotional' ? DEVOTIONAL_FIELDS : ['scripture_refs'])];
  try {
    const { data } = await wpFetch(conn, `/wp/v2/${KINDS[kind]}/${row.post_id}`, { query: { context: 'edit', _fields: fields.join(',') } });
    if (data.status === 'trash') return { post: null, form };
    db.prepare('UPDATE wp_posts SET link = ?, status = ? WHERE note_id = ?').run(data.link, data.status, noteId);
    // scripture_refs is what the post has now (it may have been edited in WordPress); undefined without the plugin.
    // A devotional's fields likewise come back as they are on the site.
    const post = { kind, id: data.id, link: data.link, status: data.status, date: data.date_gmt ? `${data.date_gmt}Z` : null, scripture_refs: data.scripture_refs };
    if (kind === 'devotional') for (const k of DEVOTIONAL_FIELDS) post[k] = data[k];
    return { post, form };
  } catch (e) {
    if (e.statusCode === 404) return { post: null, form };
    throw e;
  }
}

/** post id -> { note_id, title, updated_at, posted_at } for the site's posts made from notes. */
export function notesByPost(conn) {
  return new Map(db.prepare(`SELECT p.post_id, p.note_id, p.posted_at, n.title, n.updated_at, t.at AS touched_at FROM wp_posts p
    JOIN notes n ON n.id = p.note_id LEFT JOIN wp_touched t ON t.site = p.site AND t.post_id = p.post_id
    WHERE p.site = ? AND p.${LIVE} AND n.deleted_at IS NULL`).all(conn.site).map((r) => [r.post_id, r]));
}
/**
 * How a post stands against its note: noteId, stale (the note changed since it was posted) and editedOnSite (the
 * post was changed in WordPress after it was posted from the note, so updating from the note would replace that).
 */
export function syncInfo(row, post) {
  if (!row) return { noteId: null, stale: false, editedOnSite: false };
  const modified = post?.modified_gmt ? Date.parse(`${post.modified_gmt}Z`) : null;
  return {
    noteId: row.note_id,
    stale: row.updated_at > row.posted_at + 2000,
    editedOnSite: modified != null && modified > Math.max(row.posted_at, row.touched_at ?? 0) + 60_000,
  };
}
/** Notes changed since they were posted, newest change first. */
export function staleNotes(conn) {
  return db.prepare(`SELECT p.note_id AS noteId, p.post_id AS postId, p.link, p.status, n.title, n.updated_at AS updatedAt, p.posted_at AS postedAt
    FROM wp_posts p JOIN notes n ON n.id = p.note_id
    WHERE p.site = ? AND p.${LIVE} AND n.deleted_at IS NULL AND ${STALE} ORDER BY n.updated_at DESC`).all(conn.site);
}

/** Remember which post a note went to (one per note: posting it as the other kind replaces the record). */
function recordPost(conn, noteId, kind, data, form) {
  db.prepare(`INSERT INTO wp_posts (note_id, site, post_id, link, status, form, posted_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET site = excluded.site, post_id = excluded.post_id, link = excluded.link,
      status = excluded.status, form = excluded.form, posted_at = excluded.posted_at, kind = excluded.kind`)
    .run(noteId, conn.site, data.id, data.link, data.status, JSON.stringify(form), Date.now(), kind);
  changed();
  return {
    kind,
    id: data.id,
    link: data.link,
    status: data.status,
    date: data.date_gmt ? `${data.date_gmt}Z` : null,
    devotional_date: data.devotional_date,
    editLink: `${conn.site}/wp-admin/post.php?post=${data.id}&action=edit`,
    tag: conn.autoTag !== false ? conn.name : null, // the editor adds it to the note's tags
  };
}

/**
 * Post a note as a devotional. Its day (devotional_date) decides when readers see it, so there's no schedule:
 * a devotional published now for a later day stays hidden until that day.
 */
async function saveDevotional(conn, noteId, b) {
  if (!hasDevotionals(conn)) throw httpError(400, 'This site doesn’t take devotionals. Update the Scripture Blog plugin to 2.7.0 or later.');
  const status = b.status === 'publish' ? 'publish' : 'draft';
  if (status === 'publish' && !conn.canPublish) throw httpError(403, `${conn.displayName} can’t publish on this site; save it as a draft instead.`);
  const day = String(b.devotional_date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw httpError(400, 'Choose the day this devotional is for.');
  const str = (v, max) => String(v ?? '').slice(0, max);
  const post = {
    title: str(b.title, 1000),
    content: String(b.content ?? ''),
    status,
    devotional_date: day,
    verse_reference: str(b.verse_reference, 200).trim(),
    verse_text: str(b.verse_text, 20_000).trim(),
    verse_version: str(b.verse_version, 40).trim(),
    application: String(b.application ?? ''),
  };
  const form = b.form && typeof b.form === 'object' ? b.form : {};
  const existing = db.prepare(`SELECT post_id FROM wp_posts WHERE note_id = ? AND site = ? AND kind = 'devotional' AND ${LIVE}`).get(noteId, conn.site);
  let data;
  try {
    if (existing) {
      try {
        ({ data } = await wpFetch(conn, `/wp/v2/devotionals/${existing.post_id}`, { method: 'POST', json: post }));
        if (data.status === 'trash') data = null;
      } catch (e) {
        if (e.statusCode !== 404) throw e; // deleted in WordPress: create a new one
      }
    }
    if (!data) ({ data } = await wpFetch(conn, '/wp/v2/devotionals', { method: 'POST', json: post }));
  } catch (e) {
    if (e.wpCode === 'sbt_bad_date') e.message = `WordPress didn’t accept ${day} as the devotional’s day.`;
    throw e;
  }
  return recordPost(conn, noteId, 'devotional', data, form);
}

export default async function wordpress(app) {
  app.get('/api/wordpress', async () => publicStatus(connection()));

  app.put('/api/wordpress', async (req) => {
    const b = req.body ?? {};
    const site = normalizeSite(b.site);
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '').trim();
    if (!username || !password) throw httpError(400, 'Enter your WordPress username and an application password.');
    const found = await discover(site);
    const conn = { site, apiRoot: found.apiRoot, username, password };
    const { data: me } = await wpFetch(conn, '/wp/v2/users/me', { query: { context: 'edit' } });
    const caps = me.capabilities ?? {};
    if (!caps.edit_posts) throw httpError(400, `${me.name || username} can’t write posts on this site.`);
    const previous = connection();
    const saved = {
      site,
      apiRoot: found.apiRoot,
      name: decodeEntities(found.name),
      username,
      displayName: me.name || username,
      canPublish: !!caps.publish_posts,
      plugin: await pluginInfo(conn, found.namespaces),
      secret: encrypt(password),
      autoTag: b.autoTag ?? previous?.autoTag ?? true,
    };
    setSetting(SETTING, JSON.stringify(saved));
    changed();
    return publicStatus(saved);
  });

  // Options that don't need signing in again.
  app.patch('/api/wordpress', async (req) => {
    const conn = requireConnection();
    const saved = JSON.parse(getSetting(SETTING));
    if (typeof req.body?.autoTag === 'boolean') saved.autoTag = req.body.autoTag;
    setSetting(SETTING, JSON.stringify(saved));
    return publicStatus({ ...conn, ...saved });
  });

  app.delete('/api/wordpress', async () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING);
    changed();
    return { connected: false };
  });

  // What the posting form should ask for.
  app.get('/api/wordpress/schema', async () => {
    const conn = requireConnection();
    const [{ data: taxes }, { data: options }] = await Promise.all([
      wpFetch(conn, '/wp/v2/taxonomies', { query: { type: 'post', context: 'edit' } }),
      wpFetch(conn, '/wp/v2/posts', { method: 'OPTIONS' }),
      refreshPlugin(conn),
    ]);
    const props = options?.schema?.properties ?? {};
    const taxonomies = await Promise.all(Object.values(taxes)
      .filter((t) => t.rest_base && props[t.rest_base])
      .map(async (t) => ({
        slug: t.slug,
        name: decodeEntities(t.name),
        restBase: t.rest_base,
        hierarchical: !!t.hierarchical,
        terms: await allTerms(conn, t.rest_base),
      })));
    return {
      site: conn.site,
      name: conn.name,
      canPublish: conn.canPublish,
      taxonomies,
      fields: {
        excerpt: !!props.excerpt,
        featuredMedia: !!props.featured_media,
        // Only when the plugin confirms it handles them, not just because something registered the name.
        scriptureRefs: !!props.scripture_refs && pluginField(conn, 'scripture_refs'),
        downloads: !!props.sbt_downloads && pluginField(conn, 'sbt_downloads'),
        devotionals: hasDevotionals(conn),
      },
      plugin: conn.plugin,
      autoTag: conn.autoTag !== false,
    };
  });

  // Check scripture references with the Scripture Blog plugin, without saving anything.
  app.get('/api/wordpress/parse', async (req) => {
    const conn = requireConnection();
    const refs = String(req.query.refs ?? '').slice(0, 2000);
    if (!refs.trim()) return { refs: [], errors: [] };
    return (await wpFetch(conn, '/scripture-blog/v1/parse', { query: { refs: refs.replace(/\n/g, '; ') } })).data;
  });

  // Put a note attachment (JSON { attachmentId }) or a rendered drawing (multipart PNG) in the media library.
  app.post('/api/wordpress/media', async (req) => {
    const conn = requireConnection();
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024 } });
      if (!file) throw httpError(400, 'No file uploaded');
      const buf = await file.toBuffer();
      if (file.mimetype !== 'image/png') throw httpError(400, 'Only PNG images can be sent this way');
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      return uploadMedia(conn, `png:${hash}`, {
        filename: path.basename(file.filename || 'drawing.png'), mime: 'image/png', open: () => buf,
      });
    }
    const id = intParam(req.body?.attachmentId);
    const a = db.prepare('SELECT filename, mime, size, storage FROM attachments WHERE id = ?').get(id);
    if (!a) throw httpError(404, 'Attachment not found');
    const file = path.join(config.filesDir, a.storage);
    // Sent whole where possible: a streamed body goes out chunked, which some PHP setups refuse.
    const open = () => (fs.statSync(file).size <= 256 * 1024 * 1024 ? fs.readFileSync(file) : Readable.toWeb(fs.createReadStream(file)));
    return uploadMedia(conn, `att:${id}`, { filename: a.filename, mime: a.mime, open });
  });

  app.get('/api/notes/:id/wordpress', async (req) => {
    const conn = requireConnection();
    return notePost(conn, intParam(req.params.id));
  });

  // Create the note's post, or update it if it was posted before (and still exists).
  app.put('/api/notes/:id/wordpress', async (req) => {
    const conn = requireConnection();
    const noteId = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId)) throw httpError(404, 'Note not found');
    const b = req.body ?? {};
    if (b.kind === 'devotional') return saveDevotional(conn, noteId, b);
    const status = ['publish', 'future'].includes(b.status) ? b.status : 'draft';
    if (status !== 'draft' && !conn.canPublish) {
      throw httpError(403, `${conn.displayName} can’t ${status === 'future' ? 'schedule posts' : 'publish'} on this site; save it as a draft instead.`);
    }

    const post = {
      title: String(b.title ?? '').slice(0, 1000),
      content: String(b.content ?? ''),
      status,
    };
    // A schedule is an exact moment (UTC), so the site's own time zone setting doesn't matter.
    // "Publish now" and "draft" clear an earlier schedule; otherwise WordPress would keep the
    // future date (and quietly turn "publish" back into "scheduled").
    if (status === 'future') {
      const at = Date.parse(String(b.date ?? ''));
      if (!Number.isFinite(at)) throw httpError(400, 'Choose when the post should go live.');
      if (at < Date.now() + 60_000) throw httpError(400, 'Choose a time in the future to schedule the post.');
      post.date_gmt = new Date(at).toISOString().slice(0, 19);
    } else if (b.clearSchedule) {
      post.date_gmt = status === 'publish' ? new Date().toISOString().slice(0, 19) : null;
    }
    if (typeof b.excerpt === 'string') post.excerpt = b.excerpt;
    // WordPress's own footnotes (6.3+): the text of each is post meta; the content has the numbered links.
    if (typeof b.footnotes === 'string') post.meta = { footnotes: b.footnotes };
    if (Number.isInteger(b.featured_media)) post.featured_media = b.featured_media;
    // Left out unless sent: the site then keeps the post's current references and downloads.
    if (typeof b.scripture_refs === 'string' && pluginField(conn, 'scripture_refs')) post.scripture_refs = b.scripture_refs;
    if (Array.isArray(b.sbt_downloads) && pluginField(conn, 'sbt_downloads')) {
      post.sbt_downloads = b.sbt_downloads
        .filter((d) => Number.isInteger(d?.id))
        .map((d) => ({ id: d.id, label: String(d.label ?? '').slice(0, 200) }));
    }

    // Terms: existing ids, plus new names created on the site first.
    const form = b.form && typeof b.form === 'object' ? b.form : {};
    for (const [restBase, ids] of Object.entries(b.terms ?? {})) {
      if (!/^[\w-]+$/.test(restBase)) continue;
      const termIds = (Array.isArray(ids) ? ids : []).filter(Number.isInteger);
      for (const name of (b.newTerms?.[restBase] ?? []).map((n) => String(n).trim()).filter(Boolean)) {
        try {
          const { data } = await wpFetch(conn, `/wp/v2/${restBase}`, { method: 'POST', json: { name } });
          termIds.push(data.id);
        } catch (e) {
          if (e.wpCode === 'term_exists' && Number.isInteger(e.wpData?.term_id)) termIds.push(e.wpData.term_id);
          else throw e;
        }
      }
      post[restBase] = [...new Set(termIds)];
    }

    const existing = db.prepare(`SELECT post_id FROM wp_posts WHERE note_id = ? AND site = ? AND kind = 'post' AND ${LIVE}`).get(noteId, conn.site);
    let data;
    if (existing) {
      try {
        ({ data } = await wpFetch(conn, `/wp/v2/posts/${existing.post_id}`, { method: 'POST', json: post }));
        if (data.status === 'trash') data = null;
      } catch (e) {
        if (e.statusCode !== 404) throw e; // deleted in WordPress: create a new one
      }
    }
    if (!data) ({ data } = await wpFetch(conn, '/wp/v2/posts', { method: 'POST', json: post }));

    return recordPost(conn, noteId, 'post', data, form);
  });

  // The site's posts, for "Manage posts". A page at a time, newest change first.
  app.get('/api/wordpress/posts', async (req) => {
    const conn = requireConnection();
    const all = 'publish,draft,future,pending,private';
    const status = all.split(',').includes(req.query.status) ? req.query.status : all;
    const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
    const query = { per_page: 20, page, status, orderby: 'modified', context: 'edit', _fields: 'id,title,link,status,date_gmt,modified_gmt,categories' };
    const search = String(req.query.search ?? '').trim().slice(0, 200);
    if (search) Object.assign(query, { search, orderby: 'relevance' });
    if (/^\d+$/.test(String(req.query.category ?? ''))) query.categories = req.query.category;
    let res;
    try {
      res = await wpFetch(conn, '/wp/v2/posts', { query });
    } catch (e) {
      if (e.wpCode === 'rest_post_invalid_page_number') return { posts: [], total: 0, pages: 0 };
      throw e;
    }
    const notes = notesByPost(conn);
    return {
      posts: res.data.map((p) => ({
        ...syncInfo(notes.get(p.id), p),
        categories: p.categories ?? [],
        id: p.id,
        title: decodeEntities(p.title?.raw ?? p.title?.rendered ?? '') || '(no title)',
        link: p.link,
        status: p.status,
        date: p.date_gmt ? `${p.date_gmt}Z` : null,
        modified: p.modified_gmt ? `${p.modified_gmt}Z` : null,
        editLink: `${conn.site}/wp-admin/post.php?post=${p.id}&action=edit`,
      })),
      total: Number(res.headers.get('x-wp-total') || 0),
      pages: Number(res.headers.get('x-wp-totalpages') || 0),
    };
  });

  // Move a post to the site's Trash (restorable in WordPress), or with ?permanent=1 delete it for good.
  app.delete('/api/wordpress/posts/:id', async (req) => {
    const conn = requireConnection();
    const id = intParam(req.params.id);
    const permanent = req.query.permanent === '1';
    // A note's devotional is deleted through the same menu; WordPress ids are shared across post types.
    const kind = db.prepare('SELECT kind FROM wp_posts WHERE site = ? AND post_id = ?').get(conn.site, id)?.kind;
    try {
      await wpFetch(conn, `/wp/v2/${KINDS[kind] ?? 'posts'}/${id}`, { method: 'DELETE', query: permanent ? { force: 'true' } : {} });
    } catch (e) {
      if (e.statusCode !== 404 && e.wpCode !== 'rest_already_trashed') throw e; // already gone is fine
    }
    // The note keeps its saved form choices; posting it again makes a new post.
    db.prepare('UPDATE wp_posts SET status = ? WHERE site = ? AND post_id = ?').run(permanent ? 'deleted' : 'trash', conn.site, id);
    changed();
    return { ok: true };
  });

  // Numbers for the dashboard widget, plus the site's look. Cached briefly: the dashboard reloads on every focus.
  app.get('/api/wordpress/stats', async (req) => {
    const conn = connection();
    if (!conn) return { connected: false };
    const fresh = req.query.fresh === '1';
    if (statsCache && statsCache.site === conn.site && Date.now() - statsCache.at < 120_000 && !fresh) {
      // Which notes changed since posting is local, so it's always current.
      const notes = notesByPost(conn);
      const resync = (p) => ({ ...p, ...syncInfo(notes.get(p.id), { modified_gmt: p.modified?.replace(/Z$/, '') }) });
      const d = statsCache.data;
      return { ...d, stale: staleNotes(conn), scheduled: d.scheduled.map(resync), recent: d.recent.map(resync) };
    }
    const total = async (route, query) => {
      try {
        const { headers } = await wpFetch(conn, route, { query: { per_page: 1, _fields: 'id', ...query } });
        return Number(headers.get('x-wp-total') || 0);
      } catch (e) {
        if (/^Couldn't reach/.test(e.message)) throw e;
        return null; // not allowed for this account
      }
    };
    const list = (query) => wpFetch(conn, '/wp/v2/posts', {
      query: { context: 'edit', _fields: 'id,title,link,status,date_gmt,modified_gmt', ...query },
    }).then((r) => r.data).catch(() => []);
    const tagline = async () => (await wpFetch(conn, '/', { auth: false, query: { _fields: 'description' } })).data?.description;
    const [publish, draft, future, pending, comments, scheduled, recent, style] = await Promise.all([
      total('/wp/v2/posts', { status: 'publish' }),
      total('/wp/v2/posts', { status: 'draft' }),
      total('/wp/v2/posts', { status: 'future' }),
      total('/wp/v2/posts', { status: 'pending' }),
      total('/wp/v2/comments', { status: 'hold' }),
      list({ per_page: 5, status: 'future', orderby: 'date', order: 'asc' }),
      list({ per_page: 5, status: 'publish,draft,pending', orderby: 'modified' }),
      siteStyle(conn, { fresh, tagline }),
    ]);
    const fromNotes = db.prepare(`SELECT p.note_id, p.post_id, p.status FROM wp_posts p JOIN notes n ON n.id = p.note_id
      WHERE p.site = ? AND p.${LIVE} AND n.deleted_at IS NULL`).all(conn.site);
    const notes = notesByPost(conn);
    const item = (p) => ({
      ...syncInfo(notes.get(p.id), p),
      id: p.id,
      title: decodeEntities(p.title?.raw ?? p.title?.rendered ?? '') || '(no title)',
      link: p.link,
      status: p.status,
      date: p.date_gmt ? `${p.date_gmt}Z` : null,
      modified: p.modified_gmt ? `${p.modified_gmt}Z` : null,
      editLink: `${conn.site}/wp-admin/post.php?post=${p.id}&action=edit`,
    });
    // Notes' posts that were scheduled and have gone live since: keep their badges right.
    // Only when the list holds every scheduled post, so a missing one really isn't scheduled.
    const stillScheduled = new Set(scheduled.map((p) => p.id));
    for (const r of fromNotes) {
      if (r.status === 'future' && !stillScheduled.has(r.post_id) && future !== null && future <= scheduled.length) {
        db.prepare('UPDATE wp_posts SET status = ? WHERE site = ? AND post_id = ?').run('publish', conn.site, r.post_id);
        r.status = 'publish';
      }
    }
    const data = {
      connected: true,
      site: conn.site,
      name: conn.name,
      canPublish: !!conn.canPublish,
      style,
      posts: { publish, draft, future, pending },
      comments, // awaiting moderation (null when this account can't moderate)
      stale: staleNotes(conn),
      fromNotes: { total: fromNotes.length, published: fromNotes.filter((r) => r.status === 'publish').length },
      scheduled: scheduled.map(item),
      recent: recent.map(item),
      at: Date.now(),
    };
    statsCache = { site: conn.site, at: Date.now(), data };
    return data;
  });

  // The connected site's web fonts, for the widget (see wpstyle.js).
  app.get('/api/wordpress/fonts.css', async (req, reply) => {
    const conn = connection();
    if (conn && !cachedFontsCss()) await siteStyle(conn);
    reply.header('Cache-Control', 'private, max-age=86400').type('text/css; charset=utf-8');
    return cachedFontsCss() ?? '';
  });

  app.get('/api/wordpress/fonts/:file', async (req, reply) => {
    let file;
    try { file = await fontFile(req.params.file); } catch { throw httpError(502, 'Couldn’t fetch the font.'); }
    if (!file) throw httpError(404, 'Not found');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable').type('font/woff2');
    return fs.createReadStream(file);
  });
}
