import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { version } from '../../../package.json';
import Icon from './Icon.jsx';

const CHECK_EVERY = 15 * 60 * 1000;

const selahLatest = () => api.version().then((r) => ({ key: r.version, name: 'Selah', version: r.version }));

/**
 * Offers a reload once the server is running a newer release than this page was loaded with.
 * Checks when the window comes back into view and every 15 minutes while it's open.
 * `current` is what this page was built as, `load()` resolves to { key, name, version } for what the server runs now (the
 * admin console passes its own: both its version and Selah's).
 */
export default function UpdateBanner({ current = version, load = selahLatest }) {
  const [latest, setLatest] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  useEffect(() => {
    let last = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 30_000) return;
      last = Date.now();
      load().then(setLatest).catch(() => {});
    };
    check();
    const timer = setInterval(check, CHECK_EVERY);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!latest || latest.key === current || latest.key === dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <Icon name="restore" size={16} />
      <span>{latest.name} <strong>v{latest.version}</strong> is available.</span>
      <button className="btn btn-small btn-primary" onClick={() => location.reload()}>Reload</button>
      <button className="icon-btn" onClick={() => setDismissed(latest.key)} aria-label="Dismiss" title="Not now"><Icon name="x" size={14} /></button>
    </div>
  );
}
