import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { enmlToHtml } from './enml.js';
import { htmlToText } from './html.js';
import { setNoteTags } from './tags.js';
import { parse, findReferences, BOOKS } from '../shared/scripture.js';
import {
  allTerms, changed, decodeEntities, LIVE, notesByPost, onChange, requireConnection, staleNotes, syncInfo, touched, wpFetch,
} from './wordpress.js';
import { safeFetch } from './netguard.js';

/**
 * The WordPress page: the connected site's posts on a calendar and a pipeline board, Scripture coverage and posting
 * rhythm, comment moderation, categories and tags, the media library, and importing posts into notes. Everything
 * goes through the site's REST API with the stored application password (see wordpress.js); nothing here needs the
 * Scripture Blog plugin, though its scripture_refs field is used for coverage when the site has it.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const DAY = 86_400_000;
const POST_FIELDS = 'id,title,link,status,date_gmt,modified_gmt';
const ALL_STATUSES = 'publish,future,draft,pending,private';
// Notes with this tag (any case) are blog ideas on the pipeline board until they're posted.
export const IDEA_TAG = 'Blog idea';
const TAXONOMIES = new Set(['categories', 'tags']);
const MAX_IMPORT_IMAGES = 30;
const MAX_IMAGE = 20 * 1024 * 1024;

const dateParam = (v) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw httpError(400, 'Bad date.');
  return s;
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const gmt = (s) => (s ? `${s}Z` : null);
const title = (p) => decodeEntities(p.title?.raw ?? p.title?.rendered ?? '') || '(no title)';
/** The app time zone's calendar date (and month) of an exact moment. */
const localDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** Posts in the shape the page uses, with how each stands against the note it came from. */
function postItem(conn, notes, p) {
  return {
    id: p.id,
    title: title(p),
    link: p.link,
    status: p.status,
    date: gmt(p.date_gmt),
    modified: gmt(p.modified_gmt),
    editLink: `${conn.site}/wp-admin/post.php?post=${p.id}&action=edit`,
    ...syncInfo(notes.get(p.id), p),
  };
}

/** Every page of a collection (up to `maxPages` × 100). */
async function everything(conn, route, query, maxPages = 30) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let res;
    try {
      res = await wpFetch(conn, route, { query: { per_page: 100, page, ...query } });
    } catch (e) {
      if (e.wpCode === 'rest_post_invalid_page_number' || e.wpCode === 'rest_invalid_page_number') break;
      throw e;
    }
    out.push(...res.data);
    if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
  }
  return out;
}

// ---------- archive: Scripture coverage and posting rhythm ----------

let archiveCache = null;
let usageCache = null;
onChange.add(() => { archiveCache = null; });

/**
 * Every published post's references: the plugin's scripture_refs where the site has them, otherwise references
 * found in the title and text. coverage: book -> { chapters: { n: [post index] }, whole: [post index] }.
 */
async function archive(conn, fresh) {
  if (archiveCache && archiveCache.site === conn.site && Date.now() - archiveCache.at < 10 * 60_000 && !fresh) return archiveCache.data;
  const withPlugin = !!conn.plugin?.fields?.includes('scripture_refs');
  const raw = await everything(conn, '/wp/v2/posts', {
    status: 'publish', orderby: 'date', order: 'desc', context: 'edit',
    _fields: `id,title,link,date_gmt${withPlugin ? ',scripture_refs' : ',content'}`,
  });
  const posts = [];
  const coverage = {};
  const cover = (b) => (coverage[b] ??= { chapters: {}, whole: [] });
  for (const p of raw) {
    const i = posts.length;
    let refs;
    if (withPlugin && typeof p.scripture_refs === 'string' && p.scripture_refs.trim()) {
      refs = parse(p.scripture_refs).refs;
    } else if (!withPlugin) {
      const text = `${title(p)}\n${htmlToText(p.content?.raw ?? p.content?.rendered ?? '')}`;
      refs = findReferences(text).flatMap((f) => f.refs);
    } else {
      refs = [];
    }
    const labels = [...new Set(refs.map((r) => r.label))];
    posts.push({ id: p.id, title: title(p), link: p.link, date: gmt(p.date_gmt), refs: labels });
    for (const r of refs) {
      const info = BOOKS[r.book - 1];
      const c = cover(r.book);
      // A whole book ("Romans") marks the book, not every chapter in it.
      if (r.ch_start === 1 && r.v_start === 0 && r.ch_end === info.chapters && info.chapters > 1) {
        if (!c.whole.includes(i)) c.whole.push(i);
        continue;
      }
      for (let ch = r.ch_start; ch <= r.ch_end; ch++) {
        const list = (c.chapters[ch] ??= []);
        if (!list.includes(i)) list.push(i);
      }
    }
  }
  const data = { posts, coverage, source: withPlugin ? 'plugin' : 'text', rhythm: rhythm(posts), at: Date.now() };
  archiveCache = { site: conn.site, at: Date.now(), data };
  return data;
}

/** Posts per month (last 24), weekdays, gaps and the run of months with a post. */
function rhythm(posts) {
  const days = posts.filter((p) => p.date).map((p) => localDay(Date.parse(p.date))).sort();
  const today = localDay(Date.now());
  const months = {};
  const ym = today.slice(0, 7);
  let [y, m] = ym.split('-').map(Number);
  const keys = [];
  for (let i = 0; i < 24; i++) {
    keys.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  for (const k of keys) months[k] = 0;
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const byMonth = new Set();
  for (const d of days) {
    if (d.slice(0, 7) in months) months[d.slice(0, 7)] += 1;
    byMonth.add(d.slice(0, 7));
    weekdays[new Date(`${d}T00:00:00Z`).getUTCDay()] += 1;
  }
  // Months in a row with a post, counting back from this month (or last month, while this one is young).
  let monthStreak = 0;
  let k = keys.length - 1;
  if (!byMonth.has(keys[k])) k -= 1;
  for (; k >= 0 && byMonth.has(keys[k]); k--) monthStreak++;
  let longestGap = 0;
  for (let i = 1; i < days.length; i++) {
    longestGap = Math.max(longestGap, Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY));
  }
  const last = days.at(-1) ?? null;
  const lastYear = keys.slice(-12).reduce((n, key) => n + months[key], 0);
  return {
    months, weekdays, monthStreak, longestGap, total: days.length, first: days[0] ?? null, last,
    sinceLast: last ? Math.round((Date.parse(today) - Date.parse(last)) / DAY) : null,
    perMonth: Math.round((lastYear / 12) * 10) / 10,
  };
}

// ---------- importing a post into a note ----------

/** Downloads the post's images (up to MAX_IMPORT_IMAGES) into storage: src -> { storage, filename, mime, size }. */
export async function fetchImages(html) {
  const found = new Map();
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = decodeEntities(m[1]);
    if (/^https?:\/\//i.test(src) && !found.has(src) && found.size < MAX_IMPORT_IMAGES) found.set(src, null);
  }
  for (const src of found.keys()) {
    const storage = crypto.randomBytes(16).toString('hex');
    try {
      const res = await safeFetch(src, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !mime.startsWith('image/') || mime === 'image/svg+xml') continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE) continue;
      fs.writeFileSync(path.join(config.filesDir, storage), buf);
      const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'image').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'image';
      found.set(src, { storage, filename: name, mime, size: buf.length });
    } catch {
      // Left as a link to the image on the site.
    }
  }
  return found;
}

async function importPost(conn, postId, notebookId) {
  if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId)) throw httpError(404, 'Notebook not found.');
  const linked = notesByPost(conn).get(postId);
  if (linked) throw Object.assign(httpError(409, 'That post is already linked to a note.'), { noteId: linked.note_id });
  const { data: p } = await wpFetch(conn, `/wp/v2/posts/${postId}`, {
    query: { context: 'edit', _fields: 'id,title,content,status,link,date_gmt,modified_gmt,categories,tags,excerpt,scripture_refs' },
  });
  const html = p.content?.rendered ?? '';
  const images = await fetchImages(html);
  const [cats, tags] = await Promise.all([
    p.categories?.length ? allTerms(conn, 'categories').catch(() => []) : [],
    p.tags?.length ? allTerms(conn, 'tags').catch(() => []) : [],
  ]);
  const names = (terms, ids) => (ids ?? []).map((id) => terms.find((t) => t.id === id)?.name).filter(Boolean);
  const form = {
    terms: { categories: names(cats, p.categories), tags: names(tags, p.tags) },
    excerpt: htmlToText(p.excerpt?.raw ?? '').trim(),
    refs: typeof p.scripture_refs === 'string' ? p.scripture_refs.split(/\s*;\s*/).filter(Boolean).join('\n') : '',
  };
  const created = p.date_gmt ? Date.parse(`${p.date_gmt}Z`) : Date.now();
  const now = Date.now();
  try {
    return tx(() => {
      const { lastInsertRowid } = db.prepare('INSERT INTO notes (notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(notebookId, title(p).slice(0, 500), created, now);
      const noteId = Number(lastInsertRowid);
      const attached = new Map();
      const resolve = (src) => {
        const img = images.get(decodeEntities(src));
        if (!img) return null;
        if (attached.has(img.storage)) return attached.get(img.storage);
        const { lastInsertRowid: id } = db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(noteId, img.filename, img.mime, img.size, img.storage, now);
        const att = { id: Number(id), filename: img.filename, mime: img.mime, size: img.size };
        attached.set(img.storage, att);
        return att;
      };
      const out = enmlToHtml(`<en-note>${html}</en-note>`, new Map(), resolve) || '<p></p>';
      db.prepare('UPDATE notes SET html = ?, text = ? WHERE id = ?').run(out, htmlToText(out), noteId);
      if (conn.autoTag !== false) setNoteTags(noteId, [conn.name]);
      db.prepare(`INSERT INTO wp_posts (note_id, site, post_id, link, status, form, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(noteId, conn.site, p.id, p.link, p.status, JSON.stringify(form), now);
      // Images the note didn't end up using.
      unlinkStorage([...images.values()].filter((img) => img && !attached.has(img.storage)).map((img) => img.storage));
      return { id: noteId, images: attached.size };
    });
  } catch (e) {
    unlinkStorage([...images.values()].filter(Boolean).map((img) => img.storage));
    throw e;
  }
}

// ---------- routes ----------

export default async function wpSiteRoutes(app) {
  // Posts dated in a range (app time zone dates), plus drafts without a schedule to drag onto the calendar.
  app.get('/api/wordpress/calendar', async (req) => {
    const conn = requireConnection();
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    const notes = notesByPost(conn);
    const [dated, drafts] = await Promise.all([
      everything(conn, '/wp/v2/posts', {
        status: 'publish,future', context: 'edit', orderby: 'date', order: 'asc', _fields: POST_FIELDS,
        after: `${addDays(from, -2)}T00:00:00`, before: `${addDays(to, 2)}T23:59:59`,
      }, 5),
      wpFetch(conn, '/wp/v2/posts', { query: { status: 'draft,pending', context: 'edit', per_page: 50, orderby: 'modified', _fields: POST_FIELDS } })
        .then((r) => r.data),
    ]);
    return {
      posts: dated.map((p) => postItem(conn, notes, p)),
      drafts: drafts.map((p) => postItem(conn, notes, p)),
      canPublish: !!conn.canPublish,
    };
  });

  // Body: { date } (an exact moment) to schedule or move a post, or { status: 'publish' | 'draft' }.
  app.patch('/api/wordpress/posts/:id', async (req) => {
    const conn = requireConnection();
    const id = intParam(req.params.id);
    const b = req.body ?? {};
    const { data: cur } = await wpFetch(conn, `/wp/v2/posts/${id}`, { query: { context: 'edit', _fields: 'id,status' } });
    const body = {};
    if (b.date != null) {
      if (!conn.canPublish) throw httpError(403, `${conn.displayName} can’t schedule posts on this site.`);
      if (cur.status === 'publish') throw httpError(400, 'That post is already published; change its date in WordPress.');
      const at = Date.parse(String(b.date));
      if (!Number.isFinite(at)) throw httpError(400, 'Bad date.');
      if (at < Date.now() + 60_000) throw httpError(400, 'Choose a time in the future to schedule the post.');
      Object.assign(body, { status: 'future', date_gmt: new Date(at).toISOString().slice(0, 19) });
    } else if (b.status === 'publish') {
      if (!conn.canPublish) throw httpError(403, `${conn.displayName} can’t publish on this site.`);
      Object.assign(body, { status: 'publish', date_gmt: new Date().toISOString().slice(0, 19) });
    } else if (b.status === 'draft') {
      body.status = 'draft';
    } else {
      throw httpError(400, 'Nothing to change.');
    }
    const { data } = await wpFetch(conn, `/wp/v2/posts/${id}`, { method: 'POST', json: body });
    touched(conn.site, id);
    db.prepare('UPDATE wp_posts SET status = ?, link = ? WHERE site = ? AND post_id = ?').run(data.status, data.link, conn.site, id);
    changed();
    return postItem(conn, notesByPost(conn), data);
  });

  // The pipeline board: blog ideas (tagged notes not yet posted), drafts and pending, scheduled, recently published.
  app.get('/api/wordpress/pipeline', async () => {
    const conn = requireConnection();
    const notes = notesByPost(conn);
    const list = (query) => wpFetch(conn, '/wp/v2/posts', { query: { context: 'edit', _fields: POST_FIELDS, ...query } })
      .then((r) => r.data.map((p) => postItem(conn, notes, p)));
    const [drafts, scheduled, published] = await Promise.all([
      list({ status: 'draft,pending', per_page: 50, orderby: 'modified' }),
      list({ status: 'future', per_page: 50, orderby: 'date', order: 'asc' }),
      list({ status: 'publish', per_page: 8, orderby: 'date', order: 'desc' }),
    ]);
    const ideas = db.prepare(`SELECT n.id, n.title, n.updated_at, substr(n.text, 1, 160) AS snippet FROM notes n
      JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.id = nt.tag_id
      WHERE lower(t.name) IN ('blog idea', 'blog ideas') AND n.deleted_at IS NULL AND n.is_template = 0
        AND NOT EXISTS (SELECT 1 FROM wp_posts p WHERE p.note_id = n.id AND p.site = ? AND p.${LIVE})
      GROUP BY n.id ORDER BY n.updated_at DESC LIMIT 100`).all(conn.site);
    return { ideas, drafts, scheduled, published, ideaTag: IDEA_TAG, stale: staleNotes(conn), canPublish: !!conn.canPublish };
  });

  app.get('/api/wordpress/archive', async (req) => archive(requireConnection(), req.query.fresh === '1'));

  // ---------- comments ----------

  // ?status=hold|approve|spam|trash&page=1&search=
  app.get('/api/wordpress/comments', async (req) => {
    const conn = requireConnection();
    const status = ['hold', 'approve', 'spam', 'trash'].includes(req.query.status) ? req.query.status : 'hold';
    const page = Math.max(1, Math.min(500, Number.parseInt(req.query.page, 10) || 1));
    const query = { status, page, per_page: 20, context: 'edit', _fields: 'id,post,parent,author_name,author_email,author_url,date_gmt,content,status,link' };
    const search = String(req.query.search ?? '').trim().slice(0, 200);
    if (search) query.search = search;
    let res;
    try {
      res = await wpFetch(conn, '/wp/v2/comments', { query });
    } catch (e) {
      if (e.wpCode === 'rest_comment_invalid_page_number' || e.wpCode === 'rest_invalid_page_number') return { comments: [], total: 0, pages: 0 };
      if (e.wpCode === 'rest_forbidden_context' || e.wpCode === 'rest_forbidden_param' || e.wpCode === 'rest_forbidden') {
        throw httpError(403, `${conn.displayName} can’t moderate comments on this site.`);
      }
      throw e;
    }
    const ids = [...new Set(res.data.map((c) => c.post).filter(Boolean))];
    const posts = ids.length
      ? (await wpFetch(conn, '/wp/v2/posts', { query: { include: ids.join(','), per_page: 100, status: ALL_STATUSES, context: 'edit', _fields: 'id,title,link' } })).data
      : [];
    const postFor = new Map(posts.map((p) => [p.id, { id: p.id, title: title(p), link: p.link }]));
    const notes = notesByPost(conn);
    return {
      comments: res.data.map((c) => ({
        id: c.id,
        post: postFor.get(c.post) ?? { id: c.post, title: `Post ${c.post}`, link: null },
        noteId: notes.get(c.post)?.note_id ?? null,
        parent: c.parent,
        author: decodeEntities(c.author_name || 'Anonymous'),
        email: c.author_email || '',
        url: c.author_url || '',
        date: gmt(c.date_gmt),
        text: htmlToText(c.content?.raw ?? c.content?.rendered ?? ''),
        status: c.status === 'approved' ? 'approve' : c.status,
        link: c.link,
      })),
      total: Number(res.headers.get('x-wp-total') || 0),
      pages: Number(res.headers.get('x-wp-totalpages') || 0),
    };
  });

  // Body: { status: 'approve' | 'hold' | 'spam' }.
  app.patch('/api/wordpress/comments/:id', async (req) => {
    const conn = requireConnection();
    const status = req.body?.status;
    if (!['approve', 'hold', 'spam'].includes(status)) throw httpError(400, 'Unknown status.');
    await wpFetch(conn, `/wp/v2/comments/${intParam(req.params.id)}`, { method: 'POST', json: { status } });
    changed();
    return { ok: true };
  });

  // To the Trash, or with ?permanent=1 deleted for good.
  app.delete('/api/wordpress/comments/:id', async (req) => {
    const conn = requireConnection();
    await wpFetch(conn, `/wp/v2/comments/${intParam(req.params.id)}`, { method: 'DELETE', query: req.query.permanent === '1' ? { force: 'true' } : {} });
    changed();
    return { ok: true };
  });

  // Body: { post, parent, text }: a reply as the connected user (approving the comment replied to, as WordPress does).
  app.post('/api/wordpress/comments', async (req) => {
    const conn = requireConnection();
    const b = req.body ?? {};
    const text = String(b.text ?? '').trim().slice(0, 20_000);
    if (!text) throw httpError(400, 'Write a reply first.');
    const parent = intParam(b.parent);
    const post = intParam(b.post);
    const html = text.split(/\n{2,}/).map((para) => para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')).join('\n\n');
    await wpFetch(conn, `/wp/v2/comments/${parent}`, { method: 'POST', json: { status: 'approve' } }).catch(() => {});
    const { data } = await wpFetch(conn, '/wp/v2/comments', { method: 'POST', json: { post, parent, content: html } });
    changed();
    return { id: data.id };
  });

  // ---------- categories and tags ----------

  const taxParam = (v) => {
    if (!TAXONOMIES.has(v)) throw httpError(400, 'Unknown taxonomy.');
    return v;
  };

  app.get('/api/wordpress/terms', async (req) => {
    const conn = requireConnection();
    const tax = taxParam(req.query.taxonomy);
    const terms = await everything(conn, `/wp/v2/${tax}`, { orderby: 'name', order: 'asc', hide_empty: 'false', _fields: 'id,name,slug,count,parent,description,link' }, 20);
    return terms.map((t) => ({ id: t.id, name: decodeEntities(t.name), slug: t.slug, count: t.count, parent: t.parent ?? 0, description: t.description ?? '', link: t.link }));
  });

  app.post('/api/wordpress/terms', async (req) => {
    const conn = requireConnection();
    const tax = taxParam(req.body?.taxonomy);
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    if (!name) throw httpError(400, 'Give it a name.');
    const json = { name };
    if (tax === 'categories' && Number.isInteger(req.body?.parent)) json.parent = req.body.parent;
    const { data } = await wpFetch(conn, `/wp/v2/${tax}`, { method: 'POST', json });
    return { id: data.id };
  });

  // Body: { taxonomy, name?, parent?, description? }.
  app.patch('/api/wordpress/terms/:id', async (req) => {
    const conn = requireConnection();
    const b = req.body ?? {};
    const tax = taxParam(b.taxonomy);
    const json = {};
    if (typeof b.name === 'string') {
      json.name = b.name.trim().slice(0, 200);
      if (!json.name) throw httpError(400, 'Give it a name.');
    }
    if (typeof b.description === 'string') json.description = b.description.slice(0, 2000);
    if (tax === 'categories' && Number.isInteger(b.parent)) json.parent = b.parent;
    await wpFetch(conn, `/wp/v2/${tax}/${intParam(req.params.id)}`, { method: 'POST', json });
    return { ok: true };
  });

  app.delete('/api/wordpress/terms/:id', async (req) => {
    const conn = requireConnection();
    const tax = taxParam(req.query.taxonomy);
    await wpFetch(conn, `/wp/v2/${tax}/${intParam(req.params.id)}`, { method: 'DELETE', query: { force: 'true' } });
    changed();
    return { ok: true };
  });

  // Body: { taxonomy, from, into }: moves every post from one term to the other, then deletes the first.
  app.post('/api/wordpress/terms/merge', async (req) => {
    const conn = requireConnection();
    const b = req.body ?? {};
    const tax = taxParam(b.taxonomy);
    const from = intParam(b.from);
    const into = intParam(b.into);
    if (from === into) throw httpError(400, 'Choose two different terms.');
    const posts = await everything(conn, '/wp/v2/posts', { [tax]: from, status: ALL_STATUSES, context: 'edit', _fields: `id,${tax}` }, 50);
    let moved = 0;
    for (const p of posts) {
      const ids = [...new Set([...(p[tax] ?? []).filter((t) => t !== from), into])];
      await wpFetch(conn, `/wp/v2/posts/${p.id}`, { method: 'POST', json: { [tax]: ids } });
      touched(conn.site, p.id);
      moved++;
    }
    await wpFetch(conn, `/wp/v2/${tax}/${from}`, { method: 'DELETE', query: { force: 'true' } });
    changed();
    return { moved };
  });

  // ---------- media ----------

  // ?page=1&search=&type=image|video|audio|application
  app.get('/api/wordpress/media', async (req) => {
    const conn = requireConnection();
    const page = Math.max(1, Math.min(500, Number.parseInt(req.query.page, 10) || 1));
    const query = { page, per_page: 40, context: 'edit', _fields: 'id,title,source_url,mime_type,media_type,date_gmt,post,media_details,alt_text,link' };
    const search = String(req.query.search ?? '').trim().slice(0, 200);
    if (search) query.search = search;
    if (['image', 'video', 'audio', 'application'].includes(req.query.type)) query.media_type = req.query.type;
    let res;
    try {
      res = await wpFetch(conn, '/wp/v2/media', { query });
    } catch (e) {
      if (e.wpCode === 'rest_post_invalid_page_number') return { items: [], total: 0, pages: 0 };
      throw e;
    }
    return {
      items: res.data.map((m) => ({
        id: m.id,
        title: title(m),
        url: m.source_url,
        mime: m.mime_type,
        type: m.media_type === 'image' || m.mime_type?.startsWith('image/') ? 'image' : m.mime_type?.split('/')[0] ?? 'file',
        date: gmt(m.date_gmt),
        width: m.media_details?.width ?? null,
        height: m.media_details?.height ?? null,
        size: mediaBytes(m),
        postId: m.post || null,
        alt: m.alt_text ?? '',
        editLink: `${conn.site}/wp-admin/post.php?post=${m.id}&action=edit`,
      })),
      total: Number(res.headers.get('x-wp-total') || 0),
      pages: Number(res.headers.get('x-wp-totalpages') || 0),
    };
  });

  // Space the media library takes: the originals plus the sizes WordPress made of them (WordPress 6.0+ records sizes).
  app.get('/api/wordpress/media-usage', async (req) => {
    const conn = requireConnection();
    if (usageCache && usageCache.site === conn.site && Date.now() - usageCache.at < 10 * 60_000 && req.query.fresh !== '1') return usageCache.data;
    const all = await everything(conn, '/wp/v2/media', { context: 'edit', _fields: 'id,mime_type,media_details' }, 50);
    const byType = {};
    let bytes = 0;
    let unknown = 0;
    for (const m of all) {
      const n = mediaBytes(m);
      if (n == null) { unknown++; continue; }
      const t = m.mime_type?.split('/')[0] ?? 'other';
      byType[t] = (byType[t] ?? 0) + n;
      bytes += n;
    }
    const data = { count: all.length, bytes, byType, unknown };
    usageCache = { site: conn.site, at: Date.now(), data };
    return data;
  });

  // A small image of a media item, fetched by this server (the app's pages only load images from itself).
  app.get('/api/wordpress/media/:id/thumb', async (req, reply) => {
    const conn = requireConnection();
    const { data: m } = await wpFetch(conn, `/wp/v2/media/${intParam(req.params.id)}`, { query: { context: 'edit', _fields: 'source_url,mime_type,media_details' } });
    const sizes = m.media_details?.sizes ?? {};
    const src = sizes.medium?.source_url ?? sizes.thumbnail?.source_url ?? sizes.medium_large?.source_url ?? m.source_url;
    if (!src || !/^https?:\/\//i.test(src) || !String(m.mime_type).startsWith('image/')) throw httpError(404, 'No image.');
    let res;
    try {
      res = await safeFetch(src, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    } catch {
      throw httpError(502, 'Couldn’t fetch the image.');
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/') || type === 'image/svg+xml') throw httpError(404, 'No image.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw httpError(413, 'Image too large to preview.');
    reply.header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff').type(type);
    return buf;
  });

  app.delete('/api/wordpress/media/:id', async (req) => {
    const conn = requireConnection();
    const id = intParam(req.params.id);
    await wpFetch(conn, `/wp/v2/media/${id}`, { method: 'DELETE', query: { force: 'true' } });
    db.prepare('DELETE FROM wp_media WHERE site = ? AND media_id = ?').run(conn.site, id);
    usageCache = null;
    return { ok: true };
  });

  // ---------- import ----------

  // Body: { notebook_id } -> { id, images }: a note made from the post, linked to it so it can be updated from the note.
  app.post('/api/wordpress/posts/:id/import', async (req, reply) => {
    const conn = requireConnection();
    try {
      const r = await importPost(conn, intParam(req.params.id), intParam(req.body?.notebook_id));
      changed();
      return r;
    } catch (e) {
      if (e.noteId) return reply.code(409).send({ error: e.message, noteId: e.noteId });
      throw e;
    }
  });
}

/** Bytes for a media item and the sizes made from it, or null when the site doesn't record them. */
function mediaBytes(m) {
  const d = m.media_details ?? {};
  if (!Number.isFinite(d.filesize)) return null;
  let n = d.filesize;
  for (const s of Object.values(d.sizes ?? {})) if (Number.isFinite(s?.filesize) && s.source_url !== m.source_url) n += s.filesize;
  return n;
}

