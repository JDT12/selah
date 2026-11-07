import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useDialog } from '../Dialogs.jsx';
import Icon from '../Icon.jsx';
import { plural } from './shared.jsx';

/** Pick the term to merge into. Resolves to its id or null. */
function MergeDialog({ term, terms, noun, close }) {
  const others = terms.filter((t) => t.id !== term.id);
  const [into, setInto] = useState(others[0]?.id ?? null);
  return (
    <form className="dw-journal-dialog" onSubmit={(e) => { e.preventDefault(); if (into) close(into); }}>
      <h2>Merge “{term.name}”</h2>
      <p className="muted">Its {plural(term.count, 'post')} move to the {noun} you choose, then “{term.name}” is deleted.</p>
      <label className="field-label" htmlFor="wp-merge">Into</label>
      <select id="wp-merge" className="input" autoFocus value={into ?? ''} onChange={(e) => setInto(Number(e.target.value))}>
        {others.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.count})</option>)}
      </select>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!into}>Merge</button>
      </div>
    </form>
  );
}

/** Categories and tags on the site: counts, add, rename, merge and delete. */
export default function Terms({ onChanged, version }) {
  const dialog = useDialog();
  const [taxonomy, setTaxonomy] = useState('categories');
  const [terms, setTerms] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('name');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(null);
  const noun = taxonomy === 'categories' ? 'category' : 'tag';

  const load = useCallback(() => api.wordpressTerms(taxonomy).then((t) => { setTerms(t); setError(null); }).catch((e) => setError(e.message)), [taxonomy]);
  useEffect(() => { setTerms(null); load(); }, [load, version]);

  const run = async (label, fn, msg) => {
    setBusy(label);
    try {
      const r = await fn();
      if (msg) dialog.toast(typeof msg === 'function' ? msg(r) : msg);
      await load();
      onChanged();
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    run('Adding…', () => api.addWordpressTerm({ taxonomy, name }), `Added ${noun} “${name.trim()}”`).then(() => setName(''));
  };
  const rename = async (t) => {
    const n = await dialog.prompt({ title: `Rename ${noun}`, label: 'Name', value: t.name, okLabel: 'Rename' });
    if (n && n.trim() !== t.name) run('Renaming…', () => api.updateWordpressTerm(t.id, { taxonomy, name: n }), 'Renamed');
  };
  const merge = async (t) => {
    const into = await dialog.open((close) => <MergeDialog term={t} terms={terms} noun={noun} close={close} />);
    if (into) run('Merging…', () => api.mergeWordpressTerms({ taxonomy, from: t.id, into }), (r) => `Merged: ${plural(r.moved, 'post')} moved`);
  };
  const remove = async (t) => {
    const ok = await dialog.confirm({
      title: `Delete ${noun} “${t.name}”?`,
      message: t.count ? `${plural(t.count, 'post')} lose${t.count === 1 ? 's' : ''} this ${noun}; the posts stay.${taxonomy === 'categories' ? ' Posts left without a category go to the site’s default one.' : ''}` : 'No posts use it.',
      okLabel: 'Delete', danger: true,
    });
    if (ok) run('Deleting…', () => api.deleteWordpressTerm(t.id, taxonomy), 'Deleted');
  };

  const words = filter.toLowerCase();
  const shown = (terms ?? []).filter((t) => !words || t.name.toLowerCase().includes(words))
    .sort((a, b) => (sort === 'count' ? b.count - a.count || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
  const parentName = new Map((terms ?? []).map((t) => [t.id, t.name]));
  const unused = (terms ?? []).filter((t) => t.count === 0).length;

  return (
    <section className="wp-terms">
      <div className="wp-filters">
        <div className="home-tabs is-sub" role="tablist">
          {[['categories', 'Categories'], ['tags', 'Tags']].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={taxonomy === k} className={taxonomy === k ? 'is-active' : ''} onClick={() => setTaxonomy(k)}>{l}</button>
          ))}
        </div>
        <label className="pr-search">
          <Icon name="search" size={15} />
          <input className="input" type="search" placeholder={`Filter ${taxonomy}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <select className="input input-inline" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="name">A–Z</option>
          <option value="count">Most used</option>
        </select>
      </div>
      <form className="wp-term-add" onSubmit={add}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${noun}`} maxLength={200} aria-label={`New ${noun}`} />
        <button className="btn" disabled={!name.trim() || !!busy}><Icon name="plus" size={14} /> Add</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {!terms && !error && <div className="wp-skeleton" />}
      {terms && (
        <>
          <p className="muted">{plural(terms.length, noun, taxonomy)}{unused ? ` · ${unused} unused` : ''}{busy ? ` · ${busy}` : ''}</p>
          <ul className="wp-term-list">
            {shown.map((t) => (
              <li key={t.id} className={t.count ? '' : 'is-unused'}>
                <span className="wp-term-name">
                  {t.link ? <a href={t.link} target="_blank" rel="noopener noreferrer">{t.name}</a> : t.name}
                  {t.parent ? <small className="muted"> in {parentName.get(t.parent) ?? '…'}</small> : null}
                </span>
                <span className="wp-term-count">{plural(t.count, 'post')}</span>
                <span className="wp-term-actions">
                  <button className="btn btn-small" disabled={!!busy} onClick={() => rename(t)}>Rename</button>
                  <button className="btn btn-small" disabled={!!busy || terms.length < 2} onClick={() => merge(t)}>Merge…</button>
                  <button className="btn btn-small btn-danger-text" disabled={!!busy} onClick={() => remove(t)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
