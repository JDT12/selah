import { useEffect, useState } from 'react';
import { api, formatDate, formatSize } from '../../api.js';
import { useDialog } from '../Dialogs.jsx';
import Icon from '../Icon.jsx';
import { plural } from './shared.jsx';

const TYPES = [['', 'All'], ['image', 'Images'], ['video', 'Video'], ['audio', 'Audio'], ['application', 'Documents']];
const ICON = { video: 'camera', audio: 'mic', application: 'file', file: 'file' };

/** The site's media library: space used, a filterable grid with previews, and copy, open and delete. */
export default function Media({ version }) {
  const dialog = useDialog();
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => { api.wordpressMediaUsage().then(setUsage).catch(() => setUsage(false)); }, [version]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    let live = true;
    setError(null);
    api.wordpressMedia({ type, search: query, page: 1 })
      .then((r) => live && setList({ ...r, page: 1 }))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [type, query, version]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const r = await api.wordpressMedia({ type, search: query, page: list.page + 1 });
      setList((l) => ({ ...r, items: [...l.items, ...r.items.filter((m) => !l.items.some((x) => x.id === m.id))], page: l.page + 1 }));
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (m) => {
    const ok = await dialog.confirm({
      title: `Delete “${m.title}” permanently?`,
      message: 'It’s removed from the media library and the site’s server. Posts that show it will have a broken image or link. This can’t be undone.',
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteWordpressMedia(m.id);
      setList((l) => ({ ...l, items: l.items.filter((x) => x.id !== m.id), total: l.total - 1 }));
      dialog.toast('Deleted from the media library');
      api.wordpressMediaUsage(true).then(setUsage).catch(() => {});
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const menu = (e, m) => dialog.contextMenu(e, [
    { label: 'Copy link', onClick: () => navigator.clipboard.writeText(m.url).then(() => dialog.toast('Link copied')).catch(() => dialog.toast('Could not access clipboard', 'error')) },
    { label: 'Open file', onClick: () => window.open(m.url, '_blank', 'noopener,noreferrer') },
    { label: 'Edit in WordPress', onClick: () => window.open(m.editLink, '_blank', 'noopener,noreferrer') },
    'sep',
    { label: 'Delete permanently…', danger: true, onClick: () => remove(m) },
  ]);

  return (
    <section className="wp-media">
      {usage && (
        <div className="wp-usage">
          <strong>{formatSize(usage.bytes)}</strong>
          <span>used by {plural(usage.count, 'file')}{usage.unknown ? ` (${usage.unknown} without a recorded size)` : ''}</span>
          <div className="wp-usage-bar" aria-hidden="true">
            {Object.entries(usage.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
              <i key={t} className={`is-${t}`} style={{ flexGrow: n }} title={`${t}: ${formatSize(n)}`} />
            ))}
          </div>
          <span className="wp-usage-legend">
            {Object.entries(usage.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => <span key={t}><i className={`is-${t}`} /> {t} {formatSize(n)}</span>)}
          </span>
        </div>
      )}
      <div className="wp-filters">
        <div className="home-tabs is-sub" role="tablist">
          {TYPES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={type === k} className={type === k ? 'is-active' : ''} onClick={() => setType(k)}>{l}</button>)}
        </div>
        <label className="pr-search">
          <Icon name="search" size={15} />
          <input className="input" type="search" placeholder="Search media" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <div className="wp-skeleton" />}
      {list && list.items.length === 0 && <p className="muted">{query || type ? 'Nothing matches.' : 'The media library is empty.'}</p>}
      <ul className="wp-media-grid">
        {list?.items.map((m) => (
          <li key={m.id}>
            <button type="button" className="wp-media-item" onClick={(e) => menu(e, m)} onContextMenu={(e) => menu(e, m)} title={m.title}>
              <span className="wp-media-thumb">
                {m.type === 'image'
                  ? <img src={`/api/wordpress/media/${m.id}/thumb`} alt={m.alt || m.title} loading="lazy" />
                  : <Icon name={ICON[m.type] ?? 'file'} size={30} />}
              </span>
              <span className="wp-media-name">{m.title}</span>
              <span className="wp-media-meta">
                {[m.width && m.height ? `${m.width}×${m.height}` : m.mime?.split('/')[1]?.toUpperCase(), m.size != null ? formatSize(m.size) : null, m.date ? formatDate(Date.parse(m.date)) : null].filter(Boolean).join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list && list.page < list.pages && <button className="btn wp-more" onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more'}</button>}
    </section>
  );
}
