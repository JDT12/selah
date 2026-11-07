import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { toggleFocus, useFocusMode } from '../focus.js';
import BetaReview from './BetaReview.jsx';

/** A tab's dot: what it is (a lesson, a sermon, a Bible study, a study or course on Desk, or a note). */
const DOT = { page: 'var(--accent)', lesson: 'var(--accent)', sermon: 'var(--oak)', study: 'var(--tc-green, #2e7d4f)', desk: 'var(--tc-green, #2e7d4f)', course: 'var(--accent)', note: 'var(--muted-2, #8e9ba8)' };
const STUDY_HEX = { blue: '#2f5d86', green: '#2e7d4f', orange: '#b7700a', purple: '#6b4fa0', red: '#c93a32', teal: '#23797a', gray: '#6b7785' };
const SUFFIX = { sermon: 'Sermon', study: 'Study' };

/** The tab's label: the title, with what it is when the title doesn't already say. */
export function tabLabel(t) {
  if (t.main) return t.title || 'Home';
  const title = t.title || (t.kind === 'note' ? 'Untitled' : t.kind === 'builder' ? 'Untitled' : t.kind === 'page' ? 'Page' : 'Untitled study');
  if (t.kind === 'builder') return `${title} · Builder`; // a builder's page (10.0), beside its note's tab
  const what = SUFFIX[t.type];
  return what && !title.toLowerCase().includes(what.toLowerCase()) ? `${title} · ${what}` : title;
}

const dotOf = (t) => (t.color ? STUDY_HEX[t.color] ?? DOT[t.type] : DOT[t.type] ?? DOT.note);

/**
 * The strip along the top of every page. 11.0: tabs like a browser's. The main tab comes first, always there, and
 * shows where you are in the app; other tabs are what you opened in a new tab (Ctrl-click, a middle click, Open in new
 * tab) and each builder you have open. Pinned tabs come next to the main tab, narrow, without a close button, and keep
 * what they hold (what you open from one opens in the main tab); a middle click closes a tab; right-click for the tab menu. Tabs shrink to fit, and the strip scrolls past that.
 */
export default function TopBar({ main, tabs, activeUid, onPick, onClose, tabMenu, onPalette, nav, onRefresh }) {
  const dialog = useDialog();
  const focus = useFocusMode();
  const tab = (t) => {
    const on = t.uid === activeUid;
    const label = tabLabel(t);
    return (
      <div key={t.uid} className={`top-tab ${on ? 'is-active' : ''} ${t.pinned ? 'is-pinned' : ''} ${t.main ? 'is-main' : ''}`} role="tab" aria-selected={on}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); if (!t.pinned && !t.main) onClose(t); } }}
        onContextMenu={(e) => { const items = tabMenu(t); if (items.length) dialog.contextMenu(e, items); else e.preventDefault(); }}>
        <button type="button" className="top-tab-title" onClick={() => onPick(t)} title={t.main ? `${label} (the main tab)` : label}>
          {t.main ? <Icon name="home" size={12} className="top-tab-pin" /> : t.pinned ? <Icon name="pin" size={12} className="top-tab-pin" /> : null}
          {!t.main && <span className="top-tab-dot" style={{ background: dotOf(t) }} />}<span className="top-tab-text">{label}</span>
        </button>
        {!t.pinned && !t.main && <button type="button" className="top-tab-close" onClick={() => onClose(t)} aria-label={`Close ${label}`}><Icon name="x" size={12} /></button>}
      </div>
    );
  };
  return (
    <header className="top-bar">
      {nav && (
        <span className="top-nav">
          <button type="button" className="icon-btn" onClick={nav.back} disabled={!nav.canBack} aria-label="Back" title="Back (Alt+←)"><Icon name="arrowLeft" size={16} /></button>
          <button type="button" className="icon-btn" onClick={nav.forward} disabled={!nav.canForward} aria-label="Forward" title="Forward (Alt+→)"><Icon name="arrowRight" size={16} /></button>
        </span>
      )}
      <div className="top-tabs" role="tablist" aria-label="Open">
        {tab(main)}
        {tabs.map(tab)}
      </div>
      <button type="button" className="top-search" onClick={onPalette} aria-label="Search or jump to (Ctrl+K)">
        <Icon name="search" size={15} /><span>Jump to a passage, note or study</span><kbd>Ctrl K</kbd>
      </button>
      {/* 11.0: from the rail's old More menu. */}
      <span className="top-tools">
        <BetaReview />
        <button type="button" className={`icon-btn top-focus ${focus ? 'is-on' : ''}`} onClick={toggleFocus} aria-pressed={focus}
          aria-label={focus ? 'Leave focus mode' : 'Focus mode'} title={focus ? 'Leave focus mode (Ctrl+Shift+F)' : 'Focus mode: hide the pages you chose, counts and the note toolbar (Ctrl+Shift+F)'}>
          <Icon name="focus" size={16} />
        </button>
        {onRefresh && (
          <button type="button" className="icon-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh: load the latest from the server">
            <Icon name="refresh" size={16} />
          </button>
        )}
      </span>
    </header>
  );
}
