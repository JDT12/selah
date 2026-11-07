import { useMemo, useState } from 'react';
import { formatDate } from '../../api.js';
import { BOOKS } from '../../../../shared/scripture.js';
import Icon from '../Icon.jsx';
import { plural } from './shared.jsx';

const TOTAL_CHAPTERS = BOOKS.reduce((n, b) => n + b.chapters, 0);

/**
 * Which books and chapters the site's published posts are about, from the Scripture Blog plugin's references when
 * the site has them (else references found in the posts). Click a chapter or a book for its posts.
 */
export default function Coverage({ archive, error, onRetry, onOpenScripture }) {
  const [pick, setPick] = useState(null); // { book, ch? }
  const [only, setOnly] = useState(false);
  const sums = useMemo(() => {
    if (!archive) return null;
    let chapters = 0;
    let ot = 0;
    let nt = 0;
    let books = 0;
    for (const b of BOOKS) {
      const c = archive.coverage[b.order];
      if (!c) continue;
      const n = Object.keys(c.chapters).length;
      chapters += n;
      if (n || c.whole.length) books++;
      if (b.testament === 'OT') ot += n; else nt += n;
    }
    const withRefs = archive.posts.filter((p) => p.refs.length).length;
    return { chapters, books, ot, nt, withRefs };
  }, [archive]);

  if (error) return <section className="wp-panel"><p className="muted">{error}</p><button className="btn btn-small" onClick={onRetry}>Try again</button></section>;
  if (!archive) return <section className="wp-panel"><div className="wp-skeleton" /><div className="wp-skeleton" /></section>;

  const postsFor = (b, ch) => {
    const c = archive.coverage[b];
    if (!c) return [];
    const idx = ch ? c.chapters[ch] ?? [] : [...new Set([...c.whole, ...Object.values(c.chapters).flat()])];
    return idx.map((i) => archive.posts[i]).sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
  };
  const picked = pick ? postsFor(pick.book, pick.ch) : [];
  const pickedName = pick ? `${BOOKS[pick.book - 1].name}${pick.ch ? ` ${pick.ch}` : ''}` : '';
  const sections = [];
  for (const b of BOOKS) {
    const last = sections.at(-1);
    if (!last || last.name !== b.section) sections.push({ name: b.section, testament: b.testament, books: [b] });
    else last.books.push(b);
  }

  return (
    <div className="wp-coverage">
      <section className="wp-panel">
        <div className="wp-cov-nums">
          <div><strong>{sums.chapters}</strong><span>of {TOTAL_CHAPTERS.toLocaleString()} chapters</span></div>
          <div><strong>{sums.books}</strong><span>of 66 books</span></div>
          <div><strong>{sums.ot}</strong><span>Old Testament chapters</span></div>
          <div><strong>{sums.nt}</strong><span>New Testament chapters</span></div>
        </div>
        <p className="muted wp-cov-source">
          {plural(sums.withRefs, 'post')} of {archive.posts.length} published have Bible references
          ({archive.source === 'plugin' ? 'from the Scripture Blog references on each post' : 'found in the posts’ text'}).
          Click a chapter to see its posts.
        </p>
        <label className="check"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only books with posts</label>
      </section>

      <div className="wp-cov-layout">
        <section className="wp-panel wp-cov-map">
          {sections.map((s) => {
            const books = s.books.filter((b) => !only || archive.coverage[b.order]);
            if (!books.length) return null;
            return (
              <div key={s.name} className="wp-cov-section">
                <h3>{s.name} <span className="muted">{s.testament === 'OT' ? 'Old Testament' : 'New Testament'}</span></h3>
                {books.map((b) => {
                  const c = archive.coverage[b.order];
                  return (
                    <div key={b.order} className={`wp-cov-book ${c ? 'has-posts' : ''}`}>
                      <button type="button" className={`wp-cov-name ${pick?.book === b.order && !pick.ch ? 'is-picked' : ''} ${c?.whole.length ? 'is-whole' : ''}`}
                        onClick={() => setPick({ book: b.order })} title={c ? `${b.name}: ${plural(postsFor(b.order).length, 'post')}` : b.name}>{b.name}</button>
                      <div className="wp-cov-cells">
                        {Array.from({ length: b.chapters }, (_, i) => {
                          const n = c?.chapters[i + 1]?.length ?? 0;
                          return (
                            <button key={i} type="button" className={`wp-cov-cell lvl-${Math.min(n, 3)} ${pick?.book === b.order && pick.ch === i + 1 ? 'is-picked' : ''}`}
                              title={`${b.name} ${i + 1}${n ? `: ${plural(n, 'post')}` : ''}`} aria-label={`${b.name} ${i + 1}, ${plural(n, 'post')}`}
                              onClick={() => setPick({ book: b.order, ch: i + 1 })} />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="dw-heat-legend"><span>None</span><i className="wp-cov-cell lvl-0" /><i className="wp-cov-cell lvl-1" /><i className="wp-cov-cell lvl-2" /><i className="wp-cov-cell lvl-3" /><span>3+ posts</span></div>
        </section>

        <aside className="wp-panel wp-cov-side">
          {!pick && <p className="muted">Pick a chapter or a book to list its posts.</p>}
          {pick && (
            <>
              <h3>{pickedName}</h3>
              {picked.length === 0 && <p className="muted">No posts on {pickedName} yet.</p>}
              <ul className="wp-lines">
                {picked.map((p) => (
                  <li key={p.id} className="wp-line">
                    <a className="wp-line-main" href={p.link} target="_blank" rel="noopener noreferrer">
                      <span className="wp-line-title">{p.title}</span>
                      <span className="wp-line-meta">{p.date ? formatDate(Date.parse(p.date)) : ''}{p.refs.length ? ` · ${p.refs.join('; ')}` : ''}</span>
                    </a>
                  </li>
                ))}
              </ul>
              {onOpenScripture && <button className="btn btn-small" onClick={() => onOpenScripture(pickedName)}><Icon name="bible" size={14} /> Your notes on {pickedName}</button>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
