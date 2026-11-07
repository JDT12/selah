import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { electron } from '../desktop.js';
import { isDesktopEdition } from '../mode.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

const ANSWER_WAIT = 2 * 60_000; // how long to wait for the other PC before offering Take over anyway

/**
 * Selah Desktop with its library in a sync folder (server/desktopsync.js): the banner while this PC is read-only
 * because another PC is editing, while waiting for that PC to hand over, once it has (Edit here), and after a
 * conflict. Checked every 15 seconds and when the window comes back.
 */
export default function SyncBanner() {
  const dialog = useDialog();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.desktopSync().then(setS).catch(() => {}), []);
  useEffect(() => {
    if (!isDesktopEdition()) return undefined;
    load();
    const t = setInterval(load, 15_000);
    window.addEventListener('focus', load);
    return () => { clearInterval(t); window.removeEventListener('focus', load); };
  }, [load]);

  const restart = async (msg) => {
    setBusy(true);
    dialog.toast(msg, 'info', 30_000);
    try { await electron()?.restartServer(); } catch (e) { dialog.toast(e.message, 'error'); setBusy(false); }
  };
  const ask = async () => {
    try { await api.desktopSyncTakeOver(false); load(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const force = async () => {
    const ok = await dialog.confirm({
      title: 'Take over anyway?',
      message: `${s.readOnlyBy?.pc ?? 'The other PC'} hasn’t answered. Take over only if Selah isn’t really in use there (it may be asleep or offline). Changes it hasn’t saved to the folder yet are kept there as a conflict copy, not merged.`,
      okLabel: 'Take over', danger: true,
    });
    if (!ok) return;
    try { await api.desktopSyncTakeOver(true); await restart('Taking over…'); } catch (e) { dialog.toast(e.message, 'error'); }
  };

  if (!s?.enabled) return null;
  if (s.conflict?.file) {
    return (
      <div className="notice-banner is-now" role="status">
        <Icon name="alert" size={17} />
        <span className="notice-banner-text">
          <strong>Some changes from this PC weren’t in the sync folder in time.</strong>{' '}
          They’re kept as a backup file in the folder: {s.conflict.file}. To bring any of them back, choose it in Settings → Data &amp; backup → Restore from a backup; the notes come back as copies.
        </span>
        <button className="icon-btn" onClick={() => api.desktopSyncConflictSeen().then(load)} aria-label="Dismiss" title="Hide"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (s.role !== 'reading') return null;
  const by = s.readOnlyBy?.pc ?? 'Another PC';
  const waiting = s.asking && s.editorActive;
  const handed = !s.editorActive;
  return (
    <div className="notice-banner sync-banner" role="status">
      <Icon name="lock" size={17} />
      <span className="notice-banner-text">
        {handed ? <><strong>{by} has finished with your library.</strong> Open it here to make changes{s.newer ? ' (with the latest copy from the folder)' : ''}.</>
          : waiting ? <><strong>Asking {by} to save and hand over…</strong> This takes a minute or two while the sync folder catches up.</>
            : <><strong>Read-only: {by} is using your library.</strong> You can read everything here; take over to make changes.</>}
      </span>
      <span className="about-btns">
        {handed && <button className="btn btn-small btn-primary" disabled={busy} onClick={() => restart('Opening your library…')}>Edit here</button>}
        {!handed && !waiting && <button className="btn btn-small" onClick={ask}>Take over</button>}
        {waiting && Date.now() - s.asking.at > ANSWER_WAIT && <button className="btn btn-small" onClick={force}>Take over anyway…</button>}
      </span>
    </div>
  );
}
