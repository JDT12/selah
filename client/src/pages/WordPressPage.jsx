import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Menu, useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { WordPressConnectDialog } from '../components/WordPressDialogs.jsx';
import Calendar from '../components/wpsite/Calendar.jsx';
import Comments from '../components/wpsite/Comments.jsx';
import Coverage from '../components/wpsite/Coverage.jsx';
import Media from '../components/wpsite/Media.jsx';
import Overview from '../components/wpsite/Overview.jsx';
import Pipeline from '../components/wpsite/Pipeline.jsx';
import Posts from '../components/wpsite/Posts.jsx';
import Terms from '../components/wpsite/Terms.jsx';
import { siteVars, usePostActions, useSiteFonts } from '../components/wpsite/shared.jsx';
import { useStoredState } from '../useStoredState.js';

const TABS = [
  ['overview', 'Overview', 'home'], ['posts', 'Posts', 'notes'], ['calendar', 'Calendar', 'calendar'], ['pipeline', 'Pipeline', 'layout'],
  ['scripture', 'Scripture', 'bible'], ['comments', 'Comments', 'inbox'], ['terms', 'Categories & tags', 'tag'], ['media', 'Media', 'image'],
];
// Tabs that can be hidden (the ⚙ menu at the end of the tab bar).
const OPTIONAL = ['comments', 'terms'];

/** The connected WordPress site: overview, posts, calendar, pipeline, Scripture coverage, comments, terms and media. */
export default function WordPressPage({ onOpenNote, onOpenScripture, onMenu }) {
  const dialog = useDialog();
  const [chosenTab, setTab] = useStoredState('noteapp.wpTab', 'overview');
  // Hidden optional tabs: kept on the server so the choice follows you to other devices, and cached here.
  const [hidden, setHidden] = useStoredState('noteapp.wpTabsHidden', []);
  useEffect(() => { api.getPref('wordpressTabs').then((v) => Array.isArray(v) && setHidden(v)).catch(() => {}); }, [setHidden]);
  const toggleTab = (k) => {
    const next = hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k];
    setHidden(next);
    api.setPref('wordpressTabs', next).catch((e) => dialog.toast(`Couldn’t save: ${e.message}`, 'error'));
  };
  const tab = hidden.includes(chosenTab) ? 'overview' : chosenTab;
  const showComments = !hidden.includes('comments');
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [archive, setArchive] = useState(null);
  const [archiveError, setArchiveError] = useState(null);
  const [version, setVersion] = useState(0); // bumped after changes so the open tab reloads
  const [refreshing, setRefreshing] = useState(false);

  const loadStats = useCallback((fresh) => api.wordpressStats(fresh).then((s) => { setStats(s); setError(null); }).catch((e) => setError(e.message)), []);
  const loadArchive = useCallback((fresh) => {
    setArchiveError(null);
    return api.wordpressArchive(fresh).then(setArchive).catch((e) => setArchiveError(e.message));
  }, []);
  useEffect(() => {
    loadStats();
    const onFocus = () => loadStats();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadStats]);
  useEffect(() => {
    if ((tab === 'overview' || tab === 'scripture') && stats?.connected && !archive) loadArchive();
  }, [tab, stats?.connected, archive, loadArchive]);
  useSiteFonts(stats?.style);

  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    loadStats(true);
    setArchive(null);
  }, [loadStats]);
  const actions = usePostActions({ onOpenNote, onChanged: changed });
  const postMenu = (e, p) => dialog.contextMenu(e, actions.menu(p, { canPublish: !!stats?.canPublish }));

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadStats(true), tab === 'overview' || tab === 'scripture' ? loadArchive(true) : null]);
    setVersion((v) => v + 1);
    setRefreshing(false);
  };
  const connect = async () => {
    const s = await dialog.open((close) => <WordPressConnectDialog close={close} />);
    if (s?.connected) loadStats(true);
  };

  const header = (
    <header className="page-header">
      <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
      <div className="page-heading"><h1>{stats?.name ?? 'WordPress'}</h1></div>
    </header>
  );
  if (error && !stats) {
    return <div className="page wp-page">{header}<p className="form-error">{error}</p><button className="btn" onClick={() => loadStats(true)}>Try again</button></div>;
  }
  if (!stats) return <div className="page wp-page">{header}<div className="wp-skeleton wp-skeleton-tall" /></div>;
  if (!stats.connected) {
    return (
      <div className="page wp-page">
        {header}
        <div className="pr-blank"><Icon name="globe" size={30} /><p>Connect your WordPress site to manage it here.</p><button className="btn btn-primary" onClick={connect}>Connect…</button></div>
      </div>
    );
  }

  const { style } = stats;
  const tiles = [
    { key: 'publish', label: 'Published', value: stats.posts.publish },
    { key: 'future', label: 'Scheduled', value: stats.posts.future },
    { key: 'draft', label: 'Drafts', value: stats.posts.draft },
    { key: 'pending', label: 'Pending review', value: stats.posts.pending },
    { key: 'comments', label: 'Comments waiting', value: stats.comments },
  ].filter((t) => t.value !== null && t.value !== undefined && (t.value > 0 || !['pending', 'comments'].includes(t.key)));
  const badge = { comments: stats.comments || 0, overview: stats.stale.length };

  return (
    <div className="page wp-page">
      <div className="site-card wp-site-head" style={siteVars(style)}>
        <header className="site-head">
          <button className="icon-btn mobile-only wp-menu-btn" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
          {style?.icon && <img className="site-icon" src={style.icon} alt="" width="34" height="34" />}
          <div className="site-id">
            <a className="site-name" href={stats.site} target="_blank" rel="noopener noreferrer">{stats.name}</a>
            {style?.tagline && <p className="site-tagline">{style.tagline}</p>}
          </div>
          <a className="site-link" href={`${stats.site}/wp-admin/`} target="_blank" rel="noopener noreferrer">Admin <Icon name="external" size={12} /></a>
          <button className={`site-refresh ${refreshing ? 'is-busy' : ''}`} onClick={refresh} disabled={refreshing} aria-label="Refresh" title="Refresh"><Icon name="restore" size={15} /></button>
        </header>
        <div className="site-band">
          {tiles.map((t) => (
            <button type="button" key={t.key} className={`site-stat is-${t.key} ${(t.key === 'future' || t.key === 'comments') && t.value > 0 ? 'is-lit' : ''}`}
              onClick={() => (t.key === 'comments' && !showComments
                ? window.open(`${stats.site}/wp-admin/edit-comments.php?comment_status=moderated`, '_blank', 'noopener,noreferrer')
                : setTab(t.key === 'comments' ? 'comments' : t.key === 'future' ? 'calendar' : t.key === 'publish' ? 'posts' : 'pipeline'))}>
              <strong>{t.value.toLocaleString()}</strong>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="wp-tabs-row">
      <nav className="wp-tabs" role="tablist" aria-label="WordPress">
        {TABS.filter(([k]) => !hidden.includes(k)).map(([k, label, icon]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`wp-tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>
            <Icon name={icon} size={15} /> {label}
            {badge[k] > 0 && <span className="pr-tab-count">{badge[k]}</span>}
          </button>
        ))}
      </nav>
      <Menu align="right" className="wp-tabs-menu" trigger={({ toggle }) => (
        <button type="button" className="icon-btn" onClick={toggle} aria-label="Choose tabs" title="Choose tabs"><Icon name="settings" size={16} /></button>
      )} items={OPTIONAL.map((k) => {
        const label = TABS.find(([key]) => key === k)[1];
        return { label: hidden.includes(k) ? `Show ${label} tab` : `Hide ${label} tab`, onClick: () => toggleTab(k) };
      })} />
      </div>

      <div className="wp-tab-body">
        {tab === 'overview' && (
          <Overview stats={stats} archive={archive} archiveError={archiveError} onArchiveRetry={() => loadArchive(true)}
            actions={actions} onOpenNote={onOpenNote} onMenu={postMenu} onTab={setTab} commentsTab={showComments} />
        )}
        {tab === 'posts' && <Posts actions={actions} onMenu={postMenu} onOpenNote={onOpenNote} canPublish={!!stats.canPublish} version={version} onChanged={changed} />}
        {tab === 'calendar' && <Calendar actions={actions} onMenu={postMenu} version={version} />}
        {tab === 'pipeline' && <Pipeline actions={actions} onMenu={postMenu} onOpenNote={onOpenNote} version={version} />}
        {tab === 'scripture' && <Coverage archive={archive} error={archiveError} onRetry={() => loadArchive(true)} onOpenScripture={onOpenScripture} />}
        {tab === 'comments' && <Comments onOpenNote={onOpenNote} onChanged={() => loadStats(true)} version={version} />}
        {tab === 'terms' && <Terms onChanged={() => { loadStats(true); setArchive(null); }} version={version} />}
        {tab === 'media' && <Media version={version} />}
      </div>
    </div>
  );
}
