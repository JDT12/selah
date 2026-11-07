import { useEffect, useState } from 'react';
import { api, formatDate } from '../../api.js';
import { formatMoment } from '../../time.js';
import { useDialog } from '../Dialogs.jsx';
import Icon from '../Icon.jsx';
import { askDeletePosts } from '../WordPressDialogs.jsx';
import { plural, STATUS_LABEL, SyncBadges } from './shared.jsx';

/** Every post: search, status and category filters, bulk publish and delete, and per-post actions. */
export default function Posts({ actions, onMenu, onOpenNote, canPublish, version, onChanged }) {
  const dialog = useDialog();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null); // { posts, total, pages, page }
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null);

  useEffect(() => { api.wordpressTerms('categories').then(setCategories).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    let live = true;
    setError(null);
    setSelected(new Set());
    api.wordpressPosts({ status, search: query, category, page: 1 })
      .then((r) => live && setList({ ...r, page: 1 }))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [status, query, category, version]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const r = await api.wordpressPosts({ status, search: query, category, page: list.page + 1 });
      setList((l) => {
        const seen = new Set(l.posts.map((p) => p.id));
        return { ...r, posts: [...l.posts, ...r.posts.filter((p) => !seen.has(p.id))], page: l.page + 1 };
      });
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const posts = list?.posts ?? [];
  const chosen = posts.filter((p) => selected.has(p.id));
  const publishable = chosen.filter((p) => ['draft', 'pending', 'future'].includes(p.status));
  const allChecked = posts.length > 0 && posts.every((p) => selected.has(p.id));
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const bulk = async (label, fn, okMsg) => {
    setBusy(label);
    const failed = [];
    let n = 0;
    for (const p of chosen) {
      try { if (await fn(p)) n++; } catch (e) { failed.push(`${p.title}: ${e.message}`); }
    }
    setBusy(null);
    if (n) dialog.toast(okMsg(n));
    if (failed.length) dialog.toast(`Couldn’t finish: ${failed.join('; ')}`, 'error', 8000);
    onChanged();
  };
  const bulkDelete = async () => {
    const how = await askDeletePosts(dialog, { count: chosen.length, title: chosen[0]?.title });
    if (how) bulk('Deleting…', async (p) => { await api.deleteWordpressPost(p.id, how.permanent); return true; }, (n) => `${plural(n, 'post')} ${how.permanent ? 'deleted' : 'moved to the Trash'}`);
  };
  const bulkPublish = async () => {
    const ok = await dialog.confirm({ title: `Publish ${plural(publishable.length, 'post')}?`, message: 'They go live on the site straight away.', okLabel: 'Publish' });
    if (ok) bulk('Publishing…', async (p) => (['draft', 'pending', 'future'].includes(p.status) ? (await api.updateWordpressPost(p.id, { status: 'publish' }), true) : false), (n) => `${plural(n, 'post')} published`);
  };

  return (
    <section className="wp-posts">
      <div className="wp-filters">
        <label className="pr-search">
          <Icon name="search" size={15} />
          <input className="input" type="search" placeholder="Search posts" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search posts" />
        </label>
        <select className="input input-inline" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input input-inline" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
        </select>
      </div>

      <div className="wp-posts-bar">
        <label className="check">
          <input type="checkbox" checked={allChecked} disabled={!posts.length || !!busy}
            onChange={() => setSelected(allChecked ? new Set() : new Set(posts.map((p) => p.id)))} />
          {selected.size ? `${selected.size} selected` : list ? plural(list.total, 'post') : ''}
        </label>
        {canPublish && publishable.length > 0 && (
          <button className="btn btn-small" disabled={!!busy} onClick={bulkPublish}><Icon name="upload" size={14} /> Publish {publishable.length}</button>
        )}
        {selected.size > 0 && (
          <button className="btn btn-small btn-danger" disabled={!!busy} onClick={bulkDelete}><Icon name="trash" size={14} /> {busy ?? 'Delete'}</button>
        )}
      </div>

      <div className="wp-table">
        {error && <p className="muted wp-pad">{error}</p>}
        {!list && !error && <div className="wp-skeleton" />}
        {list && !posts.length && <p className="muted wp-pad">{query || status || category ? 'No posts match.' : 'No posts yet.'}</p>}
        {posts.map((p) => (
          <div key={p.id} className={`wp-row ${selected.has(p.id) ? 'is-selected' : ''}`} onContextMenu={(e) => onMenu(e, p)}>
            <input type="checkbox" checked={selected.has(p.id)} disabled={!!busy} onChange={() => toggle(p.id)} aria-label={`Select “${p.title}”`} />
            <div className="wp-row-text">
              <a className="wp-row-title" href={p.status === 'publish' ? p.link : p.editLink} target="_blank" rel="noopener noreferrer">{p.title}</a>
              <span className="wp-row-meta">
                <span className={`wp-dot is-${p.status}`} />{STATUS_LABEL[p.status] ?? p.status}
                {p.status === 'future' && p.date ? ` · ${formatMoment(p.date)}` : p.date ? ` · ${formatDate(Date.parse(p.date))}` : ''}
                {p.categories?.length > 0 && <> · {p.categories.map((id) => catName.get(id)).filter(Boolean).join(', ')}</>}
                {p.noteId && <> · <button type="button" className="link-btn" onClick={() => onOpenNote(p.noteId)}>from a note</button></>}
              </span>
            </div>
            <span className="wp-line-badges"><SyncBadges post={p} onUpdate={() => actions.postFromNote(p.noteId)} /></span>
            {!p.noteId && <button type="button" className="btn btn-small wp-import" onClick={() => actions.importPost(p)} title="Make a note from this post">Import</button>}
            <button type="button" className="icon-btn" aria-label={`Actions for “${p.title}”`} title="More" onClick={(e) => onMenu(e, p)}><Icon name="more" size={16} /></button>
          </div>
        ))}
        {list && list.page < list.pages && (
          <button className="btn wp-more" onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more'}</button>
        )}
      </div>
    </section>
  );
}
