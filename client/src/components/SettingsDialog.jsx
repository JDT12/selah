import { lazy, Suspense, useEffect, useState } from 'react';
import { device } from '../device.js';
import { allowExactReminders, appReminderStatus, canNotify, isDesktopApp, remindersOn, scheduleAppReminders, setReminders, testNotification } from '../desktop.js';
import { canLock, changeServer, isMobileApp, offlineWorkStatus, readLock, saveForOffline, setLock } from '../mobile.js';
import { api, formatSize } from '../api.js';
import { version } from '../../../package.json';
import { useDialog } from './Dialogs.jsx';
import AccountPane from './AccountPane.jsx';
import { WhatsNewDialog } from './WhatsNew.jsx';
import { isDesktopEdition, isHosted, isOwnServer } from '../mode.js';
import { DesktopAppRow, DesktopBackups, IpadExportFolder } from './DesktopSettings.jsx';
import { OffsiteBackupRow } from './OffsiteBackup.jsx';
import { BackupDownloadRow } from './BackupDownload.jsx';
import ImportDialog from './ImportDialog.jsx';
import BackupRestoreDialog from './BackupRestoreDialog.jsx';
import { openExport } from './ExportDialog.jsx';
import MarkdownImportDialog from './MarkdownImportDialog.jsx';
import Icon from './Icon.jsx';
import { WordPressConnectDialog } from './WordPressDialogs.jsx';
import { ZoteroConnectDialog } from './ZoteroDialogs.jsx';
import { BibleSettings } from './BibleDialogs.jsx';
import { LogosSettingsDialog } from './LogosDialog.jsx';
import { InstallAppRow } from './InstallApp.jsx';
import { useStoredState } from '../useStoredState.js';
import SidebarDialog from './SidebarDialog.jsx';
import CreditsPane from './CreditsPane.jsx';
import { DESKTOP_DOWNLOAD_URL, SOURCE_URL } from '../../../shared/credits.js';
import { desktopSystem, downloadDesktop } from '../desktopDownload.js';
import { ClipperRow } from './ClipperSettings.jsx';
import FocusPagesDialog from './FocusPagesDialog.jsx';
import { setFocus, useFocusMode } from '../focus.js';
import { SecurityPane } from './SecuritySettings.jsx';
import { MethodDefaults } from './MethodPicker.jsx';
import { deleteSample, startTour } from './Tour.jsx';

/** The tour's sample word study, while you have it: one click deletes it. */
function SampleRow() {
  const [id, setId] = useState(undefined);
  useEffect(() => { api.getPref('tourSample').then((v) => setId(v ?? null)).catch(() => setId(null)); }, []);
  if (!id) return null;
  return (
    <div className="about-row">
      <span className="muted">The sample word study the tour made.</span>
      <button className="btn btn-small" onClick={async () => { await deleteSample(); setId(null); }}><Icon name="trash" size={14} /> Delete the sample</button>
    </div>
  );
}
import { noteFont, setNoteFont } from '../noteFont.js';

// The full changelog is only for whoever runs the server (a hosted Selah's people see What's new), so it's loaded
// only when opened.
const ChangelogDialog = lazy(() => import('./ChangelogDialog.jsx'));

const TABS = [
  { key: 'general', label: 'General', icon: 'settings' },
  { key: 'connections', label: 'Connections', icon: 'link' },
  { key: 'data', label: 'Data & backup', icon: 'folder' },
  { key: 'account', label: 'Account', icon: 'users' },
  { key: 'security', label: 'Security', icon: 'lock' },
  { key: 'about', label: 'About', icon: 'callout' },
  { key: 'credits', label: 'Credits', icon: 'heart' },
];

export default function SettingsDialog({ theme, onTheme, cert, tree, onImported, onLogout, close }) {
  // The last tab you used opens next time.
  const [tab, setTab] = useStoredState('noteapp.settingsTab', 'general');
  // Selah Desktop has no sign-in, so no Account or Security tabs (its lock is under General → App).
  const tabs = isDesktopEdition() ? TABS.filter((t) => t.key !== 'account' && t.key !== 'security')
    : device.full ? TABS : TABS.filter((t) => t.key !== 'connections' && t.key !== 'data');
  const current = tabs.some((t) => t.key === tab) ? tab : 'general';
  // The dialog is rendered once when opened, so the `theme` prop never updates;
  // track the choice locally so the selector moves as soon as it's clicked.
  const [themeChoice, setThemeChoice] = useState(theme);
  // The guide is a note: made (or brought up to date) on the server, then opened like any other.
  const openGuide = async (which = 'user') => {
    try {
      const { id } = await (which === 'maintenance' ? api.openMaintenanceGuide() : api.openGuide());
      close();
      window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: id }));
      window.dispatchEvent(new Event('noteapp:notes-changed'));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const dialog = useDialog();

  const pickTheme = (t) => {
    setThemeChoice(t);
    onTheme(t);
  };

  const importEnex = async () => {
    if (await dialog.open((c) => <ImportDialog tree={tree} close={c} />)) onImported();
  };
  // A .selahnb (Export → Selah notebook): its notebooks come in as new ones.
  const importNotebookFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.selahnb';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      dialog.toast(`Importing ${file.name}…`, 'info', 4000);
      try {
        const r = await api.importNotebookFile(file);
        dialog.toast(`Imported ${r.notes} note${r.notes === 1 ? '' : 's'}${r.missing ? ` (${r.missing} attachment${r.missing === 1 ? '' : 's'} missing from the file)` : ''}`);
        close();
        onImported(r.notebooks[0] ?? null);
      } catch (e) {
        dialog.toast(e.message, 'error', 7000);
      }
    };
    input.click();
  };
  const restoreFromBackup = async () => {
    const r = await dialog.open((c) => <BackupRestoreDialog tree={tree} close={c} />);
    if (r) { close(); onImported(r.notebooks.length === 1 ? r.notebooks[0] : null); }
  };
  const importMarkdown = async () => {
    const notebookId = await dialog.open((c) => <MarkdownImportDialog tree={tree} close={c} />);
    if (notebookId) { close(); onImported(notebookId); }
  };

  const pane = {
    general: (
      <>
        <h3>Appearance</h3>
        <div className="segmented">
          {['system', 'light', 'dark'].map((t) => (
            <button key={t} className={themeChoice === t ? 'is-active' : ''} aria-pressed={themeChoice === t} onClick={() => pickTheme(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <NoteFontRow />

        {device.full && (<>
        <h3>Rail</h3>
        <div className="about-row">
          <span className="muted">Choose which pages the rail shows and their order. Pages you take off stay a right-click on the rail (or Ctrl+K) away.</span>
          <button className="btn btn-small" onClick={() => dialog.open((c) => <SidebarDialog close={c} />)}>Customize the rail…</button>
        </div>

        <h3>Desk</h3>
        <MethodDefaults />

        <h3>Focus mode</h3>
        <FocusRow />

        <h3>Connected notes</h3>
        <ConnectionsRow />
        </>)}

        <h3>Notifications</h3>
        <NotificationsRow />

        <h3>App</h3>
        {isMobileApp() ? (
          <>
            <div className="about-row">
              <span className="muted">This device opens {location.host}.</span>
              <button type="button" className="btn btn-small" onClick={changeServer}>Use a different Selah</button>
            </div>
            <MobileLockRow />
            <OfflineWorkRow />
            <StorageRow />
            <div className="about-row"><span className="muted">Connections, exports, imports and backups are on the web and in Selah Desktop.</span></div>
          </>
        ) : (
          <>
            {!isDesktopApp() && <InstallAppRow cert={cert} />}
            {window.selahDesktop?.kind === 'electron' ? <DesktopAppRow /> : <WindowsAppRow />}
          </>
        )}
      </>
    ),
    connections: (
      <>
        <h3>Edge clipper</h3>
        <ClipperRow />

        <h3>WordPress</h3>
        <div className="about-row">
          <span className="muted">Post notes to WordPress. Once connected, the site gets its own page in the sidebar.</span>
          <button className="btn btn-small" onClick={() => dialog.open((c) => <WordPressConnectDialog close={c} />)}>Connect…</button>
        </div>

        <h3>Zotero</h3>
        <div className="about-row">
          <span className="muted">Cite sources from your Zotero library; choose the citation style.</span>
          <button className="btn btn-small" onClick={() => dialog.open((c) => <ZoteroConnectDialog close={c} />)}>Zotero &amp; citations…</button>
        </div>

        <h3>Logos</h3>
        <div className="about-row">
          <span className="muted">Open Bible references and Logos links in the desktop app or on the web.</span>
          <button className="btn btn-small" onClick={() => dialog.open((c) => <LogosSettingsDialog close={c} />)}>Logos…</button>
        </div>

        <BibleSettings />
      </>
    ),
    data: (
      <>
        {isDesktopEdition() ? <><DesktopBackups /><IpadExportFolder /></> : isOwnServer() ? (
          <>
            <h3>Off-site backup</h3>
            <OffsiteBackupRow />
          </>
        ) : (
          <>
            <h3>Backups</h3>
            <div className="about-row">
              <span className="muted">Your Selah is backed up every night with everyone else’s on this server, by the person who runs it. To keep your own copy too, download a backup now and then.</span>
            </div>
          </>
        )}

        <h3>Storage</h3>
        <StorageRow />

        <h3>Download a backup</h3>
        <BackupDownloadRow />

        <h3>Restore notes</h3>
        <div className="about-row">
          <span className="muted">Bring back notes or whole notebooks as they were on an earlier day, as copies. Selah keeps a copy of your notes each day for two weeks{isOwnServer() ? ', and an off-site backup keeps 30 days' : ''}.</span>
          <button className="btn btn-small" onClick={restoreFromBackup}><Icon name="restore" size={14} /> Restore from a backup…</button>
        </div>

        <h3>Import</h3>
        <div className="import-options">
          <button className="import-option" onClick={importEnex}>
            <Icon name="import" size={20} />
            <span><strong>.enex files</strong><span className="muted">Notebook exports, with attachments and tags</span></span>
          </button>
          <button className="import-option" onClick={importMarkdown}>
            <Icon name="file" size={20} />
            <span><strong>Markdown</strong><span className="muted">.md files or a whole folder</span></span>
          </button>
          <button className="import-option" onClick={importNotebookFile}>
            <Icon name="notebook" size={20} />
            <span><strong>Selah notebook</strong><span className="muted">.selahnb files from Export, with attachments and tags</span></span>
          </button>
        </div>

        <h3>Export</h3>
        <div className="about-row">
          <span className="muted">Every note, with attachments. Notebooks, shelves, tags and notes also export from their own menus.</span>
          <button className="btn btn-small" onClick={() => openExport(dialog, { scope: { all: 1 }, title: 'everything' })}>Export everything…</button>
        </div>
      </>
    ),
    account: <AccountPane onDeleted={() => { close(); onLogout(); }} />,
    security: <SecurityPane cert={cert} onSignOut={() => { close(); onLogout(); }} />,
    about: (
      <>
        <div className="settings-about">
          <img src="/favicon.svg?v=4" alt="" width="56" height="56" />
          <div>
            <div className="wordmark settings-about-name">Selah</div>
            <div className="muted">Version {version}</div>
          </div>
        </div>
        <div className="about-row">
          <span className="muted">How to use Selah, page by page.</span>
          <button className="btn btn-small" onClick={() => openGuide()}><Icon name="book" size={14} /> User guide</button>
        </div>
        {device.full && (
        <div className="about-row">
          <span className="muted">A two-minute tour of what’s where: the rail, Home and Desk, tabs, the passage page, preaching and slides.</span>
          <button className="btn btn-small" onClick={() => { close(); startTour(); }}><Icon name="flag" size={14} /> Take the tour</button>
        </div>
        )}
        <SampleRow />
        <div className="about-row">
          <span className="muted">What’s new in Selah, update by update.</span>
          <button className="btn btn-small" onClick={() => dialog.open((c) => <WhatsNewDialog close={c} />)}>What’s new</button>
        </div>
        {isOwnServer() && (
          <>
            <div className="about-row">
              <span className="muted">Looking after the server: the selah command, starting at boot, updates, backups, fixes.</span>
              <button className="btn btn-small" onClick={() => openGuide('maintenance')}><Icon name="settings" size={14} /> Maintenance guide</button>
            </div>
            <div className="about-row">
              <span className="muted">Every change in every version, in detail.</span>
              <button className="btn btn-small" onClick={() => dialog.open((c) => <Suspense fallback={null}><ChangelogDialog version={version} close={c} /></Suspense>)}>Full changelog</button>
            </div>
          </>
        )}
        {isHosted() && (
          <>
            <h3>About this service</h3>
            <p className="muted about-notice">
              Selah is offered free to a few people, as is. It may change or be unavailable at times, and nothing is
              guaranteed. The person who runs the server looks after it and can see what is stored on it, including
              notes, prayers and journals, but doesn’t read them except to fix a problem you ask about. Your data is
              backed up, encrypted, every night. Bible text comes through your own free keys and stays under its
              publishers’ copyright, for personal and church use. Keep your own export of anything you can’t lose
              (Settings → Data &amp; backup → Export).
            </p>
          </>
        )}
        <h3>Free software</h3>
        <div className="about-row">
          <span className="muted">Selah is free software under the GNU AGPL (version 3 or later). Credits &amp; permissions lists everything it uses from others.</span>
          <span className="about-btns">
            <a className="btn btn-small" href={SOURCE_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" size={13} /> Source code</a>
            <button className="btn btn-small" onClick={() => setTab('credits')}><Icon name="heart" size={13} /> Credits</button>
          </span>
        </div>
      </>
    ),
    credits: <CreditsPane />,
  }[current];

  return (
    <div className="settings-dialog">
      <div className="dialog-header">
        <h2>Settings</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist" aria-label="Settings">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" id={`settings-tab-${t.key}`} aria-selected={current === t.key}
              aria-controls="settings-pane" className={current === t.key ? 'is-active' : ''} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={16} /> <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <section className="settings-pane" id="settings-pane" role="tabpanel" aria-labelledby={`settings-tab-${current}`}>
          {pane}
        </section>
      </div>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}

/** Focus mode on this device, and the pages it hides. */
function FocusRow() {
  const dialog = useDialog();
  const on = useFocusMode();
  return (
    <div className="about-row">
      <span className="muted">Hides the pages you choose, sidebar counts and the note toolbar (until you select text), and skips reminders. On this device; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> or the focus button on the top bar.</span>
      <span className="actions-right">
        <button className="btn btn-small" onClick={() => dialog.open((c) => <FocusPagesDialog close={c} />)}>Choose pages…</button>
        <button className="btn btn-small" onClick={() => setFocus(!on)}>{on ? 'Turn off' : 'Turn on'}</button>
      </span>
    </div>
  );
}

/** Note text in a reading serif (the default) or the interface's sans. */
function NoteFontRow() {
  const [v, setV] = useState(noteFont);
  const pick = (next) => { setV(next); setNoteFont(next); };
  return (
    <div className="about-row note-font-row">
      <span className="muted">Note text</span>
      <div className="segmented">
        {[['serif', 'Serif'], ['sans', 'Sans']].map(([k, l]) => (
          <button key={k} type="button" className={v === k ? 'is-active' : ''} aria-pressed={v === k} onClick={() => pick(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/** Connected notes at the foot of a note: only the notes that link to it, or suggestions too. */
function ConnectionsRow() {
  const dialog = useDialog();
  const [only, setOnly] = useState(null);
  useEffect(() => { api.getPref('connectionsIntentional').then((v) => setOnly(!!v)).catch(() => setOnly(false)); }, []);
  const change = (v) => {
    setOnly(v);
    api.setPref('connectionsIntentional', v).catch((e) => { setOnly(!v); dialog.toast(e.message, 'error'); });
  };
  return (
    <label className="check-row">
      <input type="checkbox" checked={!!only} disabled={only === null} onChange={(e) => change(e.target.checked)} />
      <span>Only notes I link<span className="muted">Leave out notes that only mention a note's title or the same Scripture.</span></span>
    </label>
  );
}

/** Reminders on this device; each event and task chooses its own (Remind me). */
/** The app's lock (13.0): hidden on a device with no Face ID, fingerprint or passcode, and in an older app. */
/** How much is ready to preach or teach with no connection on this device, and a way to save right now. */
function OfflineWorkRow() {
  const dialog = useDialog();
  const [status, setStatus] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { offlineWorkStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  if (status === undefined) return null;
  const save = async () => {
    setBusy(true);
    try {
      await saveForOffline(new Date().toLocaleDateString('en-CA'));
      setStatus(await offlineWorkStatus());
      dialog.toast('Saved on this device');
    } catch { dialog.toast('Couldn’t save everything. Check your connection and try again.', 'error'); }
    setBusy(false);
  };
  const when = status?.savedAt ? new Date(status.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return (
    <div className="about-row">
      <span className="muted">{status ? `${status.count} ${status.count === 1 ? 'sermon or lesson' : 'sermons and lessons'} ready with no connection. Saved ${when}.` : 'Sermons and lessons on your calendar, and your most recent, are saved here for when there’s no connection.'}</span>
      <button type="button" className="btn btn-small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save now'}</button>
    </div>
  );
}

/** Space used: your Selah's share of its quota on a hosted server, or the disk Selah keeps its notes on. */
function StorageRow() {
  const [s, setS] = useState(null);
  useEffect(() => { api.storage().then(setS).catch(() => setS(null)); }, []);
  if (!s?.used) return null;
  const pct = s.capacity ? Math.round((s.used / s.capacity) * 100) : null;
  return (
    <div className="about-row">
      <span className="muted">{s.capacity ? `${formatSize(s.used)} of ${formatSize(s.capacity)} used (${pct}%)` : `${formatSize(s.used)} used`}{s.attachments != null ? ` · notes ${formatSize(s.database ?? 0)}, attachments ${formatSize(s.attachments)}` : ''}</span>
      {s.capacity ? <span className={`storage-meter ${pct >= 90 ? 'is-warn' : ''}`} aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }} /></span> : null}
    </div>
  );
}

function MobileLockRow() {
  const dialog = useDialog();
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => { if (await canLock()) { const on = await readLock(); if (live) setState(on); } })();
    return () => { live = false; };
  }, []);
  if (state === null) return null;
  const toggle = async () => {
    try { await setLock(!state); setState(!state); } catch { dialog.toast('The lock wasn’t changed.', 'error'); }
  };
  return (
    <div className="about-row">
      <span className="muted">Ask for Face ID, a fingerprint or this device’s passcode when Selah opens, and after 5 minutes away.</span>
      <button type="button" className="btn btn-small" onClick={toggle}>{state ? 'Turn off' : 'Turn on'}</button>
    </div>
  );
}

function NotificationsRow() {
  const dialog = useDialog();
  const [on, setOn] = useState(remindersOn());
  // 13.0: in the phone and tablet apps, what's scheduled here and whether Android lets it come on time.
  const [status, setStatus] = useState(null);
  const refresh = async () => { await scheduleAppReminders().catch(() => {}); setStatus(await appReminderStatus().catch(() => null)); };
  useEffect(() => { if (on) refresh(); else setStatus(null); }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canNotify()) return <div className="about-row"><span className="muted">This browser can't show notifications.</span></div>;
  const toggle = async () => {
    const next = await setReminders(!on);
    setOn(next);
    if (!on && !next) dialog.toast('Notifications are blocked. Allow them for Selah in the browser or Windows settings.', 'error', 6000);
    else if (next) test();
  };
  const test = async () => {
    const r = await testNotification();
    const where = { windows: 'as a Windows notification', 'service-worker': 'by the browser', browser: 'by the browser', app: 'by this device' }[r.how];
    if (r.ok) dialog.toast(`Test sent ${where}. If nothing appeared, check that notifications for Selah (and Do not disturb) are on in your device's settings.`, 'info', 9000);
    else dialog.toast(`The test couldn't be sent: ${r.error}`, 'error', 9000);
  };
  return (
    <div className="about-row">
      <span className="muted">Reminders on this device for events and tasks. Each one has its own Remind me choices (usually 15 minutes before an event, and at a task's time).{isMobileApp() ? ' They come even when the app is closed.' : ' Selah needs to be open (in the Windows app, the tray is enough).'}</span>
      <span className="actions-right">
        {on && <button className="btn btn-small" onClick={test}>Send a test</button>}
        <button className="btn btn-small" onClick={toggle}>{on ? 'Turn off' : 'Turn on'}</button>
      </span>
      {on && status && (
        <span className="muted notify-status">
          {status.count ? `${status.count} reminder${status.count === 1 ? '' : 's'} scheduled on this device for the next week. Next: ${status.next.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'Nothing scheduled for the next week.'}
          {' '}Changes made on another device reach this one when Selah next opens here.
          {status.exact !== 'granted' && <> <strong>Reminders may come a few minutes late:</strong> <button type="button" className="link-btn" onClick={allowExactReminders}>allow on-time reminders</button> (Android: Alarms &amp; reminders).</>}
        </span>
      )}
    </div>
  );
}

/**
 * Selah Desktop (12.0 Windows, 12.1 Mac and Linux; desktop-app/): where to download it. The older Windows app (Tauri, before 12.0)
 * still opens Selah but no longer updates, so it's pointed at the new one.
 */
function WindowsAppRow() {
  if (isDesktopApp()) {
    return (
      <div className="about-row">
        <span className="muted">This older Windows app no longer gets updates. Install Selah Desktop, choose “On a Selah Cloud server” and type this Selah’s address ({location.origin}); then uninstall this one.</span>
        <a className="btn btn-small" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Download</a>
      </div>
    );
  }
  const system = desktopSystem();
  if (!system) return null;
  return (
    <div className="about-row">
      <span className="muted">Selah Desktop for {system}: its own window, a {system === 'Mac' ? 'menu-bar' : 'tray'} icon, quick capture, notifications, and slides full screen on a second monitor. Choose “On a Selah Cloud server” when it opens to use this Selah in it. <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">{system === 'Windows' ? 'All downloads' : system === 'Mac' ? 'Intel Mac or other downloads' : '.deb or other downloads'}</a></span>
      <button className="btn btn-small" onClick={() => downloadDesktop(system)}>Download</button>
    </div>
  );
}
