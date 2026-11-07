import { useEffect, useState } from 'react';
import { api, setConfirmIdentity } from '../api.js';
import { setServerInfo } from '../mode.js';
import { setTimeZone } from '../time.js';
import { useStoredState } from '../useStoredState.js';
import { useDialog } from '../components/Dialogs.jsx';
import Login from '../components/Login.jsx';
import Icon from '../components/Icon.jsx';
import { ConfirmIdentityDialog, SecurityPane } from '../components/SecuritySettings.jsx';
import { adminApi } from './adminApi.js';
import { useLoad } from './common.jsx';
import Overview from './Overview.jsx';
import Tenants from './Tenants.jsx';
import Backups from './Backups.jsx';
import SecurityLog from './SecurityLog.jsx';
import Sharing from './Sharing.jsx';
import Updates from './Updates.jsx';
import Settings from './Settings.jsx';
import Docs from './Docs.jsx';
import { MaintenanceBanner } from './Maintenance.jsx';
import UpdateBanner from '../components/UpdateBanner.jsx';
import { ADMIN_VERSION } from '../../../server/admin/version.js';
import { version as SELAH_VERSION } from '../../../package.json';
import { request } from '../api.js';

// The console's own version and Selah's (a release can change either): a new one of either offers a reload.
const consoleLatest = () => request('GET', '/api/version').then((r) => ({
  key: `${r.adminVersion}/${r.version}`,
  name: r.adminVersion !== ADMIN_VERSION ? 'Console' : 'Selah',
  version: r.adminVersion !== ADMIN_VERSION ? r.adminVersion : r.version,
}));

const PAGES = [
  { key: 'overview', label: 'Overview', icon: 'home' },
  { key: 'tenants', label: 'Tenants', icon: 'users' },
  { key: 'sharing', label: 'Sharing', icon: 'share' },
  { key: 'backups', label: 'Backups', icon: 'restore' },
  { key: 'security', label: 'Security', icon: 'lock' },
  { key: 'updates', label: 'Updates', icon: 'refresh' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
  { key: 'docs', label: 'Docs', icon: 'book' },
];

function useTheme() {
  const [theme, setTheme] = useStoredState('noteapp.theme', 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme];
}

export default function AdminApp() {
  const [auth, setAuth] = useState('loading');
  const [passwordSet, setPasswordSet] = useState(true);
  useEffect(() => {
    api.session().then((s) => {
      setServerInfo(s);
      setTimeZone(s.timeZone);
      setPasswordSet(s.passwordSet);
      setAuth(s.authenticated ? 'ok' : 'login');
    }).catch(() => setAuth('login'));
    const onUnauthorized = () => setAuth('login');
    window.addEventListener('noteapp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('noteapp:unauthorized', onUnauthorized);
  }, []);
  if (auth === 'loading') return null;
  if (auth === 'login') return <Login title="Selah" subtitle="Admin console" passwordSet={passwordSet} cert={null} onDone={() => setAuth('ok')} />;
  return <Console onLogout={async () => { await api.logout().catch(() => {}); setAuth('login'); }} />;
}

/** The page from the address (#tenants, #tenants/name, …). */
const fromHash = () => {
  const [page, arg] = location.hash.replace(/^#/, '').split('/');
  return { page: PAGES.some((p) => p.key === page) ? page : 'overview', arg: arg ? decodeURIComponent(arg) : null };
};

function Console({ onLogout }) {
  const dialog = useDialog();
  const [theme, setTheme] = useTheme();
  const [route, setRoute] = useState(fromHash);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setConfirmIdentity(() => dialog.open((c) => <ConfirmIdentityDialog close={c} />));
    return () => setConfirmIdentity(null);
  }, [dialog]);
  useEffect(() => {
    const on = () => setRoute(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (page, arg = null) => {
    location.hash = arg ? `${page}/${encodeURIComponent(arg)}` : page;
    setMenuOpen(false);
  };

  // Two-step sign-in has to be on before anything else works.
  const overview = useLoad(() => adminApi.overview(), [], 20_000);
  const needTwoStep = overview.error?.data?.needTwoStep;
  const unseen = overview.data?.alerts?.length ?? 0;

  if (needTwoStep) {
    return (
      <div className="adm-gate">
        <div className="adm-gate-card">
          <h1 className="wordmark">Selah</h1>
          <p className="muted">Admin console</p>
          <h2>Turn on two-step sign-in first</h2>
          <p>The admin console looks after everyone’s Selah, so it needs a code from an authenticator app as well as the password. Turn it on below; the console opens when it’s done.</p>
          <SecurityPane cert={null} onSignOut={onLogout} />
          <div className="modal-actions"><button className="btn btn-primary" onClick={() => overview.reload()}>Continue</button></div>
        </div>
      </div>
    );
  }

  const page = {
    overview: <Overview data={overview.data} error={overview.error} reload={overview.reload} go={go} />,
    tenants: <Tenants open={route.arg} go={go} />,
    sharing: <Sharing />,
    backups: <Backups go={go} />,
    security: <SecurityLog go={go} slug={route.arg} />,
    updates: <Updates go={go} />,
    settings: <Settings onSignOut={onLogout} />,
    docs: <Docs tab={route.arg} go={go} />,
  }[route.page];

  return (
    <div className={`adm ${menuOpen ? 'is-menu-open' : ''}`}>
      <aside className="adm-nav">
        <div className="adm-brand">
          <img src="/favicon.svg?v=4" alt="" width="34" height="34" />
          <span className="adm-mark">Admin</span>
          <span className="adm-brand-text"><span className="wordmark">Selah</span><small>Admin console</small></span>
          <button className="icon-btn adm-menu-close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><Icon name="x" /></button>
        </div>
        <nav aria-label="Admin console">
          {PAGES.map((p) => (
            <button key={p.key} className={route.page === p.key ? 'is-active' : ''} aria-current={route.page === p.key ? 'page' : undefined} onClick={() => go(p.key)} title={p.label}>
              <Icon name={p.icon} size={19} /> <span>{p.label}</span>
              {p.key === 'overview' && unseen > 0 && <span className="adm-count" aria-label={`${unseen} new alerts`}>{unseen}</span>}
            </button>
          ))}
        </nav>
        <div className="adm-nav-foot">
          {/* Appearance: Auto, then Light, then Dark. */}
          <button type="button" className="adm-tool" onClick={() => setTheme({ system: 'light', light: 'dark', dark: 'system' }[theme] ?? 'system')}
            title={`Appearance: ${{ system: 'Auto', light: 'Light', dark: 'Dark' }[theme] ?? 'Auto'}`} aria-label="Change appearance">
            <Icon name="sun" size={18} /><span>Appearance: {{ system: 'Auto', light: 'Light', dark: 'Dark' }[theme] ?? 'Auto'}</span>
          </button>
          <button type="button" className="adm-tool" onClick={onLogout} title="Sign out" aria-label="Sign out"><Icon name="logout" size={18} /><span>Sign out</span></button>
        </div>
      </aside>
      <div className="adm-backdrop" onClick={() => setMenuOpen(false)} />
      <main className="adm-main">
        <header className="adm-topbar">
          <button className="icon-btn adm-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
          <h1>{PAGES.find((p) => p.key === route.page).label}</h1>
          {unseen > 0 && (
            <button className="btn btn-small adm-alert-btn" onClick={() => go('overview')}>
              <Icon name="alert" size={14} /> {unseen} alert{unseen === 1 ? '' : 's'}
            </button>
          )}
          {overview.data && <span className="muted adm-version">Console {overview.data.adminVersion} · Selah {overview.data.version}</span>}
        </header>
        <UpdateBanner current={`${ADMIN_VERSION}/${SELAH_VERSION}`} load={consoleLatest} />
        <MaintenanceBanner overview={overview.data} reload={overview.reload} />
        <div className="adm-page">{page}</div>
      </main>
    </div>
  );
}
