import { db } from './db.js';
import { escapeHtml } from './html.js';
import { changed, connection, decodeEntities, touched, wpFetch } from './wordpress.js';
import { chaptersOf } from './studies.js';

/**
 * WordPress series from a Writing project: each chapter posted to the site gets a box at the top of the post with
 * the series name, "Part 2 of 5" and links to the previous and next parts that are live. Posting a chapter
 * rebuilds its content from the note, so the box is put back (and the neighbours' links brought up to date) after
 * each post, and whenever the project asks.
 *
 * The box is a Group block with the class "selah-series"; it's found and replaced by that, and nothing else in the
 * post is touched. With the series' "tag" setting on, posts also get a tag named after the series.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const BOX = /<!-- wp:group \{"className":"selah-series"\} -->[\s\S]*?<!-- \/wp:group -->\s*/;
const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

export function seriesBox({ name, part, total, prev, next }) {
  const nav = [
    prev && `← <a href="${escapeHtml(prev.link)}">${escapeHtml(prev.title)}</a>`,
    next && `<a href="${escapeHtml(next.link)}">${escapeHtml(next.title)}</a> →`,
  ].filter(Boolean).join(' &nbsp;|&nbsp; ');
  return [
    '<!-- wp:group {"className":"selah-series"} -->',
    '<div class="wp-block-group selah-series"><!-- wp:paragraph -->',
    `<p><strong>${escapeHtml(name)}</strong> · Part ${part} of ${total}</p>`,
    '<!-- /wp:paragraph -->',
    ...(nav ? ['<!-- wp:paragraph -->', `<p>${nav}</p>`, '<!-- /wp:paragraph -->'] : []),
    '</div>',
    '<!-- /wp:group -->',
  ].join('\n');
}

/** The id of the tag named after the series (made on the site if it isn't there). */
async function seriesTag(conn, name) {
  const { data } = await wpFetch(conn, '/wp/v2/tags', { query: { search: name, per_page: 100, _fields: 'id,name' } });
  const found = data.find((t) => decodeEntities(t.name).toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  try {
    return (await wpFetch(conn, '/wp/v2/tags', { method: 'POST', json: { name } })).data.id;
  } catch (e) {
    if (e.wpCode === 'term_exists' && Number.isInteger(e.wpData?.term_id)) return e.wpData.term_id;
    throw e;
  }
}

/** Brings every posted chapter's series box (and tag) up to date. Returns { updated, posts }. */
export async function syncSeries(studyId) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  const series = parseData(study?.data).series;
  if (!study || !series?.enabled) return { updated: 0, posts: 0 };
  const conn = connection();
  if (!conn) throw httpError(409, 'Not connected to WordPress. Connect in Settings → WordPress.');
  const chapters = chaptersOf(studyId);
  const posted = chapters.map((c, i) => ({ ...c, part: i + 1 }))
    .filter((c) => c.wp_status)
    .map((c) => ({ ...c, post: db.prepare(`SELECT post_id, link, status FROM wp_posts WHERE note_id = ? AND site = ? AND status NOT IN ('trash', 'deleted')`).get(c.id, conn.site) }))
    .filter((c) => c.post);
  const name = String(series.name || study.title).trim();
  const tagId = series.tag !== false ? await seriesTag(conn, name) : null;
  let updated = 0;
  for (const [i, c] of posted.entries()) {
    const { data } = await wpFetch(conn, `/wp/v2/posts/${c.post.post_id}`, { query: { context: 'edit', _fields: 'id,content,tags,status,link,title' } });
    if (data.status !== c.post.status || data.link !== c.post.link) {
      db.prepare('UPDATE wp_posts SET status = ?, link = ? WHERE site = ? AND post_id = ?').run(data.status, data.link, conn.site, data.id);
      c.post.status = data.status;
      c.post.link = data.link;
    }
    c.title = decodeEntities(data.title?.raw ?? c.title);
    c.raw = data.content?.raw ?? '';
    c.tags = data.tags ?? [];
  }
  // Only live posts are linked: a draft or scheduled post isn't there for readers yet.
  const live = (c) => c.post.status === 'publish';
  for (const [i, c] of posted.entries()) {
    const prev = posted.slice(0, i).reverse().find(live);
    const next = posted.slice(i + 1).find(live);
    const box = seriesBox({ name, part: c.part, total: chapters.length, prev: prev && { link: prev.post.link, title: prev.title }, next: next && { link: next.post.link, title: next.title } });
    // The same blank line after the box either way, so an unchanged box reads as unchanged next time.
    const content = BOX.test(c.raw) ? c.raw.replace(BOX, `${box}\n\n`) : `${box}\n\n${c.raw.replace(/^\s+/, '')}`;
    const tags = tagId && !c.tags.includes(tagId) ? [...c.tags, tagId] : null;
    if (content === c.raw && !tags) continue;
    await wpFetch(conn, `/wp/v2/posts/${c.post.post_id}`, { method: 'POST', json: { content, ...(tags ? { tags } : {}) } });
    touched(conn.site, c.post.post_id);
    updated += 1;
  }
  db.prepare('UPDATE studies SET data = ? WHERE id = ?').run(JSON.stringify({ ...parseData(study.data), seriesSyncedAt: Date.now() }), studyId);
  if (updated) changed();
  return { updated, posts: posted.length };
}

export default async function seriesRoutes(app) {
  app.post('/api/studies/:id/series/sync', async (req) => syncSeries(intParam(req.params.id)));
  // After a note is posted: every series it's a chapter of.
  app.post('/api/notes/:id/series/sync', async (req) => {
    const id = intParam(req.params.id);
    const studies = db.prepare(`SELECT s.id, s.data FROM study_notes sn JOIN studies s ON s.id = sn.study_id
      WHERE sn.note_id = ? AND sn.role = 'chapter' AND s.kind = 'writing'`).all(id).filter((s) => parseData(s.data).series?.enabled);
    let updated = 0;
    for (const s of studies) updated += (await syncSeries(s.id)).updated;
    return { series: studies.length, updated };
  });
}
