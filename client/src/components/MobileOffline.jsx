import { useEffect, useRef, useState } from 'react';
import { isMobileApp, lockIsOn, openSavedCopies, readLock, saveSessionKey, sendOfflineEdits, startReadCache, verifyUnlock } from '../mobile.js';
import { device } from '../device.js';
import { todayStr } from '../time.js';

const RELOCK_MS = 5 * 60 * 1000;

/** In the mobile app: keeps the saved copies and sign-in fresh, says when the connection drops, and locks after time away. */
export default function MobileOffline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [locked, setLocked] = useState(false);
  const [merged, setMerged] = useState(null); // 14.4: what came in from editing with no connection
  const hiddenAt = useRef(0);

  const unlock = async () => {
    try { await verifyUnlock(); setLocked(false); } catch { /* stays locked; the button tries again */ }
  };

  useEffect(() => {
    if (!isMobileApp()) return undefined;
    // 14.4: edits made on the offline page go to Selah as soon as it's reachable.
    const send = () => {
      if (!navigator.onLine) return;
      sendOfflineEdits(device.tablet ? 'Tablet' : 'Phone').then((r) => {
        if (!r.sent.length) return;
        setMerged(r);
      }).catch(() => {});
    };
    send();
    const update = () => { setOnline(navigator.onLine); send(); };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const stop = startReadCache(todayStr);
    saveSessionKey();
    readLock();
    const seen = () => {
      if (document.hidden) { hiddenAt.current = Date.now(); return; }
      if (lockIsOn() && hiddenAt.current && Date.now() - hiddenAt.current >= RELOCK_MS) { setLocked(true); unlock(); }
      hiddenAt.current = 0;
    };
    document.addEventListener('visibilitychange', seen);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', seen);
      stop();
    };
  }, []);

  if (!isMobileApp()) return null;
  if (locked) {
    return (
      <div className="mobile-lock" role="dialog" aria-modal="true" aria-label="Selah is locked">
        <h1>Selah</h1>
        <p>Selah is locked.</p>
        <button type="button" className="btn btn-primary" onClick={unlock}>Unlock</button>
      </div>
    );
  }
  if (online && merged) {
    const both = merged.sent.reduce((n, e) => n + e.conflicts, 0);
    const names = merged.sent.map((e) => e.title || 'Untitled').slice(0, 3).join(', ');
    return (
      <div className="mobile-offline mobile-merged" role="status">
        <span>
          Your offline changes are in: {names}{merged.sent.length > 3 ? ' and more' : ''}.
          {both > 0 && ` ${both === 1 ? 'One part was' : `${both} parts were`} changed here and elsewhere, so both versions are kept.`}
          {' '}The note as it was is in Version history.
        </span>
        <button type="button" className="link-btn" onClick={() => setMerged(null)}>OK</button>
      </div>
    );
  }
  if (online) return null;
  return (
    <div className="mobile-offline" role="status">
      <span>You're offline. Editing needs a connection.</span>
      <button type="button" className="link-btn" onClick={openSavedCopies}>Saved copies</button>
    </div>
  );
}
