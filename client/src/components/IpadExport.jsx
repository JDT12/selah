import { useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { bibleConnected } from '../esv.js';
import { electron } from '../desktop.js';
import { buildPackage, exportInfo } from '../ipadExport.js';

const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(`noteapp.ipad.${k}`)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`noteapp.ipad.${k}`, JSON.stringify(v)); } catch { /* private window */ } };
const KIND = { sermon: 'sermon', lesson: 'lesson', note: 'note' };

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const fileName = (title) => `${String(title || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'}.selahlesson`;
const dateOf = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Export for iPad (12.2): the sermon, lesson or note as a .selahlesson file for Selah Companion, with the Bible text
 * or references only, and its slides. Selah Desktop can save it straight into a folder the iPad reaches (iCloud
 * Drive, OneDrive); otherwise it's a download to put there. Exporting again makes a new version of the same lesson,
 * which Companion updates in place, keeping the notes written on the iPad.
 */
function IpadExportDialog({ noteId, title, info, settings: initial, bible, onIds, close, dialog }) {
  const [settings, setSettings] = useState(initial);
  const [bibleText, setBibleText] = useState(() => bible && pref('bibleText', true));
  const [slides, setSlides] = useState(() => pref('slides', true));
  const [where, setWhere] = useState(() => (initial.desktop ? pref('where', 'folder') : 'download'));
  const [busy, setBusy] = useState(false);
  const kind = KIND[info.meta.kind] ?? 'note';
  const desk = !!electron();

  const chooseFolder = async () => {
    const picked = await electron()?.pickFolder({ title: 'Choose a folder your iPad can open', defaultPath: settings.folder ?? settings.suggested });
    if (!picked) return false;
    try {
      const r = await api.setIpadExportSettings({ folder: picked });
      setSettings((s) => ({ ...s, folder: r.folder }));
      return true;
    } catch (e) {
      dialog.toast(e.message, 'error', 7000);
      return false;
    }
  };

  const run = async (e) => {
    e.preventDefault();
    if (where === 'folder' && !settings.folder && !(await chooseFolder())) return;
    setBusy(true);
    setPref('bibleText', bibleText);
    setPref('slides', slides);
    if (settings.desktop) setPref('where', where);
    try {
      const { body, skipped } = await buildPackage(noteId, { info, bibleText, slides, onIds });
      let msg;
      if (where === 'folder') {
        const r = await api.ipadExportToFolder(noteId, body);
        msg = `Saved “${r.file}” (version ${r.version}) in ${r.folder}`;
      } else {
        const { blob, version } = await api.ipadExportFile(noteId, body);
        download(blob, fileName(title));
        msg = `Exported “${fileName(title)}”${version ? ` (version ${version})` : ''}`;
      }
      if (skipped.length) msg += `. ${skipped.length} reference${skipped.length === 1 ? '' : 's'} went without their text (a package holds up to 500 verses).`;
      dialog.toast(msg, 'info', 8000);
      close(true);
    } catch (err) {
      dialog.toast(`Couldn’t export it: ${err.message}`, 'error', 8000);
      setBusy(false);
    }
  };

  return (
    <form className="export-dialog ipad-export" onSubmit={run}>
      <div className="dialog-header">
        <h2>Export for iPad</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">“{title || 'Untitled'}”, for Preach and Teach in Selah Companion on your iPad.
        {info.last ? ` Last exported as version ${info.last.version} on ${dateOf(info.last.exported_at)}; exporting again updates it on the iPad and keeps your notes there.` : ''}</p>

      <div className="export-formats" role="radiogroup" aria-label="Bible text">
        <label className={`export-format ${bibleText ? 'is-active' : ''} ${bible ? '' : 'is-disabled'}`}>
          <input type="radio" name="ipad-bible" checked={bibleText} disabled={!bible} onChange={() => setBibleText(true)} />
          <span><strong>Include the verse text</strong>
            <span className="muted">{bible ? 'The text of each reference goes with it (up to 500 verses), with its translation and copyright line, so it shows on the iPad without the internet.' : 'Connect a Bible in Settings → Bible to include the text.'}</span></span>
        </label>
        <label className={`export-format ${!bibleText ? 'is-active' : ''}`}>
          <input type="radio" name="ipad-bible" checked={!bibleText} onChange={() => setBibleText(false)} />
          <span><strong>References only</strong><span className="muted">The iPad shows each reference; you read the text from your own Bible. Passage slides still get their verses.</span></span>
        </label>
      </div>

      {info.deck && (
        <label className="check-row"><input type="checkbox" checked={slides} onChange={(e) => setSlides(e.target.checked)} />
          <span><strong>Slides ({info.deck.slides.length})</strong><span className="muted">To show on a TV or projector from the iPad (HDMI or AirPlay).</span></span></label>
      )}

      {settings.desktop && (
        <div className="export-formats" role="radiogroup" aria-label="Where">
          <label className={`export-format ${where === 'folder' ? 'is-active' : ''}`}>
            <input type="radio" name="ipad-where" checked={where === 'folder'} onChange={() => setWhere('folder')} />
            <span><strong>Into your iPad folder</strong>
              <span className="muted ipad-folder">{settings.folder ?? `Not chosen yet (suggested: ${settings.suggested})`}</span>
              {desk && <button type="button" className="link-btn" onClick={(ev) => { ev.preventDefault(); chooseFolder(); }}>{settings.folder ? 'Change…' : 'Choose…'}</button>}</span>
          </label>
          <label className={`export-format ${where === 'download' ? 'is-active' : ''}`}>
            <input type="radio" name="ipad-where" checked={where === 'download'} onChange={() => setWhere('download')} />
            <span><strong>Choose where to save</strong><span className="muted">Save the file anywhere, then open it on the iPad.</span></span>
          </label>
        </div>
      )}
      <p className="muted ipad-how"><Icon name="tablet" size={14} /> {where === 'folder'
        ? 'Pick a folder in iCloud Drive, OneDrive or Google Drive. On the iPad, Selah Companion finds new versions there (Check for new versions).'
        : 'Put the file in iCloud Drive, OneDrive or Google Drive (or AirDrop it), then open it on the iPad in Selah Companion.'}</p>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}><Icon name="tablet" size={15} /> {busy ? 'Making it…' : `Export the ${kind}`}</button>
      </div>
    </form>
  );
}

/**
 * Opens Export for iPad for a note. `onIds({ html, updated_at })` is told when the export gave the note's blocks
 * their ids (a builder with the note open reloads it from that).
 */
export async function exportForIpad(dialog, noteId, { title = null, onIds = null } = {}) {
  try {
    const [info, settings, bible, note] = await Promise.all([
      exportInfo(noteId), api.ipadExportSettings().catch(() => ({ desktop: false })), bibleConnected().catch(() => false),
      title == null ? api.getNote(noteId) : null,
    ]);
    await dialog.open((close) => <IpadExportDialog noteId={noteId} title={title ?? note?.title ?? ''} info={info} settings={settings} bible={bible} onIds={onIds} close={close} dialog={dialog} />);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

