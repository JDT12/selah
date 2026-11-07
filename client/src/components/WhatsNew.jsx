import { isDesktopEdition } from '../mode.js';
import { useEffect, useState } from 'react';
import { WHATS_NEW, compareVersions } from '../../../shared/whatsnew.js';
import { version } from '../../../package.json';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

function Entries({ entries }) {
  return entries.map((e) => (
    <section key={e.version} className="whatsnew-entry">
      <h3>{e.title} <span className="muted">{e.version} · {day(e.date)}</span></h3>
      <ul>{e.items.map((t) => <li key={t}>{t}</li>)}</ul>
    </section>
  ));
}

/** Settings → About → What's new: every entry. */
export function WhatsNewDialog({ close }) {
  return (
    <div className="whatsnew-dialog">
      <div className="dialog-header">
        <h2>What’s New in Selah</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      {/* An entry for a release still in beta stays out until it ships. */}
      <div className="whatsnew-body"><Entries entries={WHATS_NEW.filter((e) => compareVersions(e.version, version) <= 0)} /></div>
      <div className="modal-actions"><button className="btn btn-primary" onClick={() => close()}>Done</button></div>
    </div>
  );
}

/**
 * Once after an update: a card with what's new since the version you last saw (remembered for you, on every
 * device). A brand-new Selah shows the latest entry once, as a welcome.
 */
export function WhatsNewCard({ onShowAll }) {
  const [entries, setEntries] = useState(null);
  useEffect(() => {
    let live = true;
    api.getPref('whatsNewSeen').then((seen) => {
      if (!live) return;
      const upToNow = WHATS_NEW.filter((e) => compareVersions(e.version, version) <= 0);
      // A new Selah Desktop library starts with the tour, not with news of changes it never saw.
      const fresh = seen ? upToNow.filter((e) => compareVersions(e.version, seen) > 0) : isDesktopEdition() ? [] : upToNow.slice(0, 1);
      if (fresh.length) setEntries(fresh.slice(0, 3));
      else if (seen !== version) api.setPref('whatsNewSeen', version).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!entries) return null;
  const dismiss = () => {
    setEntries(null);
    api.setPref('whatsNewSeen', version).catch(() => {});
  };
  return (
    <aside className="whatsnew-card" role="status" aria-label="What’s new">
      <div className="whatsnew-card-head">
        <Icon name="callout" size={18} />
        <strong>What’s New in Selah {entries[0].version}</strong>
        <button className="icon-btn" onClick={dismiss} aria-label="Close" title="Close"><Icon name="x" size={16} /></button>
      </div>
      <div className="whatsnew-card-body"><Entries entries={entries} /></div>
      <div className="whatsnew-card-actions">
        <button className="btn btn-small" onClick={() => { dismiss(); onShowAll(); }}>See all</button>
        <button className="btn btn-small btn-primary" onClick={dismiss}>Got it</button>
      </div>
    </aside>
  );
}
