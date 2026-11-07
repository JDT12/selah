import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const CHECK_EVERY = 5 * 60 * 1000;
const SEEN = 'noteapp.noticeDismissed';

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Sat, Nov 28, 9:00 PM – 10:00 PM" (or into another day). */
export function noticeWindow(n) {
  if (!n.end) return `from ${when(n.start)}`;
  return `${when(n.start)} – ${sameDay(n.start, n.end) ? time(n.end) : when(n.end)}`;
}

/**
 * The maintenance banner the admin console sends (server/admin/notice.js, GET /api/notice): when Selah will be down,
 * from the time chosen there. Checked every 5 minutes and when the window comes back; ✕ hides it until it changes.
 */
export default function NoticeBanner() {
  const [notice, setNotice] = useState(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(SEEN); } catch { return null; } });

  useEffect(() => {
    let last = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 30_000) return;
      last = Date.now();
      api.notice().then((r) => setNotice(r.notice)).catch(() => {});
    };
    check();
    const timer = setInterval(() => { last = 0; check(); }, CHECK_EVERY);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!notice) return null;
  const key = `${notice.id}:${notice.now ? 'now' : 'soon'}`;
  if (key === dismissed) return null;
  const hide = () => {
    setDismissed(key);
    try { localStorage.setItem(SEEN, key); } catch { /* hidden for this visit */ }
  };
  return (
    <div className={`notice-banner ${notice.now ? 'is-now' : ''}`} role="status">
      <Icon name="alert" size={17} />
      <span className="notice-banner-text">
        <strong>{notice.now ? 'Server maintenance is under way.' : 'Server maintenance is coming up.'}</strong>{' '}
        Selah may be unavailable {noticeWindow(notice)}.
        {notice.message && <span className="notice-banner-msg">{notice.message}</span>}
      </span>
      <button className="icon-btn" onClick={hide} aria-label="Dismiss" title="Hide"><Icon name="x" size={14} /></button>
    </div>
  );
}
