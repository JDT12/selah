import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { pageLinkProps, pageTabItems } from '../openTab.js';
import { useDialog } from './Dialogs.jsx';
import { useNotebookActions } from './useNotebookActions.js';
import { useTagActions } from './useTagActions.jsx';
import { SIDEBAR_PAGES, orderedPageKeys, useFocusPages, useHiddenPages, usePageOrder } from '../sidebarPages.js';
import { toggleFocus, useFocusMode } from '../focus.js';
import SidebarDialog from './SidebarDialog.jsx';
import { UtilityPanel } from './RailPanels.jsx';

/**
 * Drag payloads: notes carry "application/x-note", notebooks "application/x-notebook",
 * stacks "application/x-stack", tags "application/x-tag" and shortcuts "application/x-shortcut".
 * 10.1: dropping a note on My notes moves it there (out of the Inbox, say).
 */
export function useDropTarget(accepts, onDrop) {
  const [over, setOver] = useState(false);
  const match = (e) => accepts.some((t) => e.dataTransfer.types.includes(t));
  return {
    over,
    props: {
      onDragOver: (e) => { if (match(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e) => {
        setOver(false);
        for (const t of accepts) {
          const v = e.dataTransfer.getData(t);
          if (v) { e.preventDefault(); onDrop(t, Number(v)); return; }
        }
      },
    },
  };
}

const PAGE = Object.fromEntries(SIDEBAR_PAGES.map((p) => [p.key, p]));
/** The sections that belong to the notes library: they light up My notes (or Utility) on the rail. */
export const NOTES_SECTIONS = ['notes', 'notebooks', 'tags', 'attachments'];
/** The note list's views that are My notes (the rest, Templates and the Trash, belong to Utility). */
const MY_NOTES_VIEWS = ['all', 'tag', 'files', 'untagged', 'notebook', 'stack'];

function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/**
 * The rail. 7.1: a slim navy rail; 9.2: your day's pages, a divider, Walk, Bible and Preach. 10.1: notes are sorted by
 * tags, so the Shelf and pinned notebooks are gone. After the pages come the WordPress site (while one is connected)
 * and My notes; Utility (templates, attachments, tags, the Trash, shared with me) sits at the foot under New, above
 * Settings, and opens as a panel beside the rail. 11.0: More is gone: Focus mode and Refresh are buttons on the top
 * bar, Customize the rail is in Settings and on the rail's right-click menu (with the pages you took off it), and the
 * whole rail scrolls on a short screen. On a phone a tab bar runs along the bottom, with More for everything else.
 */
export default function Sidebar({
  tree, view, onView, onNewNote, onNewFromTemplate, onRefresh, onNotesChanged, onMoveNote, onRefreshAll, onSettings, section, onSection,
  onOpenNote,
}) {
  const dialog = useDialog();
  const phone = useMedia('(max-width: 800px)');
  const [hidden] = useHiddenPages();
  const [order] = usePageOrder();
  const focus = useFocusMode();
  const [focusHidden] = useFocusPages();
  const [panel, setPanel] = useState(null); // 'utility'
  // What the rail leaves out right now: your hidden pages, and in focus mode its pages too.
  const out = focus ? [...hidden, ...focusHidden] : hidden;
  const actions = useNotebookActions({ tree, onRefresh, onCreated: () => {}, onDeleted: () => {} });
  const tagActions = useTagActions({
    tags: tree.tags, notebookActions: actions, onRefresh: () => { onRefresh(); onNotesChanged?.(); },
    onDeleted: (id) => { if (view.type === 'tag' && view.id === id) onView({ type: 'all' }); },
  });

  // The panel closes when you go somewhere, and with Esc.
  useEffect(() => { setPanel(null); }, [section, view.type, view.id]);
  useEffect(() => {
    if (!panel) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .context-menu, .menu')) setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  const customize = () => dialog.open((close) => <SidebarDialog tree={tree} close={close} />);
  const go = (key) => { setPanel(null); onSection(key); };
  const openMyNotes = () => { setPanel(null); onView({ type: 'all' }); };

  // 11.0: Desk has its own place on the rail, so Home is only Home.
  const homeTo = !out.includes('dashboard') ? 'dashboard' : null;
  const pageKeys = orderedPageKeys(order).filter((k) => (k === 'wordpress' ? !!tree.wordpress && !out.includes(k)
    : k === 'dashboard' ? homeTo : !out.includes(k)));
  const label = (k) => (k === 'wordpress' ? tree.wordpress : PAGE[k].label);
  const short = (k) => (k === 'wordpress' ? 'Site' : PAGE[k].short);
  const badge = (k) => (k === 'inbox' ? tree.inbox?.count || 0 : k === 'calendar' ? tree.tasksDue || 0 : 0);
  const activeOf = {
    dashboard: section === 'dashboard',
    calendar: section === 'calendar' || section === 'tasks' || section === 'attendance',
    dailywalk: section === 'dailywalk' || section === 'plans' || section === 'prayer',
  };
  const isActive = (k) => activeOf[k] ?? section === k;
  const inUtility = ['tags', 'attachments', 'shared'].includes(section) || (section === 'notes' && ['templates', 'trash'].includes(view.type));
  const myNotesActive = !panel && ((section === 'notes' && MY_NOTES_VIEWS.includes(view.type)) || section === 'notebooks');
  const withMyNotes = !out.includes('mynotes');
  const withUtility = !out.includes('utility');
  const myNotesDrop = useDropTarget(['application/x-note'], (_, noteId) => { if (tree.myNotes) onMoveNote(noteId, tree.myNotes); });

  const newMenu = [
    { label: 'New note', onClick: () => onNewNote() },
    { label: 'New note from template…', onClick: () => onNewFromTemplate() },
  ];
  const openAt = (e, items, beside = true) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = beside && !phone ? { clientX: r.right + 8, clientY: r.top } : { clientX: r.left, clientY: r.top - 4 };
    dialog.contextMenu({ ...at, preventDefault() {}, stopPropagation() {} }, items);
  };
  const allPages = orderedPageKeys(order).filter((k) => k !== 'wordpress' || tree.wordpress);
  // The pages that aren't on the rail: still a right-click (or Ctrl+K) away, and under More on a phone.
  const offRail = [
    ...allPages.filter((k) => !pageKeys.includes(k)).map((k) => ({ label: label(k), onClick: () => go(k) })),
    !withMyNotes && { label: 'My notes', onClick: openMyNotes },
  ].filter(Boolean);
  // The rail's right-click menu: the pages you took off it, then Customize.
  const railMenu = (e) => dialog.contextMenu(e, [...offRail, offRail.length > 0 && 'sep', { label: 'Customize the rail…', onClick: customize }].filter(Boolean));
  const onRailMenu = (e) => { e.preventDefault(); e.stopPropagation(); railMenu(e); };
  const toggleUtility = () => setPanel((cur) => (cur ? null : 'utility'));

  const item = (k) => {
    const n = badge(k);
    return (
      <button key={k} type="button" className={`nr-item ${isActive(k) && !panel ? 'is-active' : ''}`} {...pageLinkProps({ section: k }, () => go(k === 'dashboard' ? homeTo : k))}
        aria-current={isActive(k) ? 'page' : undefined} title={label(k)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); dialog.contextMenu(e, [...pageTabItems({ section: k }), 'sep', ...offRail, offRail.length > 0 && 'sep', { label: 'Customize the rail…', onClick: customize }].filter(Boolean)); }}>
        <span className="nr-icon"><Icon name={PAGE[k].icon} size={20} strokeWidth={1.8} />{n > 0 && <span className={`nr-badge ${k === 'calendar' ? 'is-urgent' : ''}`}>{n > 99 ? '99+' : n}</span>}</span>
        <span className="nr-label">{short(k)}</span>
      </button>
    );
  };
  // Your day's pages (Home leads), a divider, the rest in your order, a divider, the WordPress site and My notes.
  const isDay = (k) => PAGE[k].band === 'day';
  const dayKeys = pageKeys.filter(isDay);
  const restKeys = pageKeys.filter((k) => !isDay(k) && k !== 'wordpress');
  const siteKey = pageKeys.includes('wordpress') ? 'wordpress' : null;
  const myNotesItem = withMyNotes && (
    <button key="mynotes" type="button" className={`nr-item ${myNotesActive ? 'is-active' : ''} ${myNotesDrop.over ? 'is-drop' : ''}`} onClick={openMyNotes}
      aria-current={myNotesActive ? 'page' : undefined} title="My notes: all your notes, sorted by tag" {...myNotesDrop.props}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); dialog.contextMenu(e, [
        { label: 'New note', onClick: () => onNewNote() },
        { label: 'New note from template…', onClick: () => onNewFromTemplate() },
        'sep',
        ...offRail, offRail.length > 0 && 'sep',
        { label: 'Customize the rail…', onClick: customize },
      ].filter(Boolean)); }}>
      <span className="nr-icon"><Icon name="notes" size={20} strokeWidth={1.8} /></span><span className="nr-label">My notes</span>
    </button>
  );
  const utilityItem = withUtility && (
    <button key="utility" type="button" className={`nr-item ${panel === 'utility' || (inUtility && !panel) ? 'is-active' : ''}`} onClick={toggleUtility}
      aria-expanded={panel === 'utility'} title="Utility: templates, attachments, tags, the Trash and what's shared with you">
      <span className="nr-icon"><Icon name="grid" size={20} strokeWidth={1.8} /></span><span className="nr-label">Utility</span>
    </button>
  );

  const panels = (
    <>
      {panel && <div className="nr-scrim" onMouseDown={() => setPanel(null)} />}
      {panel === 'utility' && (
        <UtilityPanel tree={tree} tagActions={tagActions} onView={(v) => { setPanel(null); onView(v); }} onSection={go}
          onOpenNote={(id) => { setPanel(null); onOpenNote(id); }} onNewFromTemplate={onNewFromTemplate} onClose={() => setPanel(null)} />
      )}
    </>
  );

  if (phone) {
    // A phone's tab bar: your first two pages, New, My notes, and More (everything else, as a sheet).
    const tabs = pageKeys.filter((k) => k !== 'wordpress').slice(0, 2);
    return (
      <>
        {panels}
        <nav className="ar-tabbar" aria-label="Pages">
          {tabs.map((k) => (
            <button key={k} type="button" className={`ar-tab ${isActive(k) && !panel ? 'is-active' : ''}`} onClick={() => go(k === 'dashboard' ? homeTo : k)} aria-label={label(k)}>
              <span className="ar-icon"><Icon name={PAGE[k].icon} size={21} strokeWidth={1.8} />{badge(k) > 0 && <span className={`ar-badge ${k === 'calendar' ? 'is-urgent' : ''}`}>{badge(k) > 99 ? '99+' : badge(k)}</span>}</span><span>{short(k)}</span>
            </button>
          ))}
          <button type="button" className="ar-tab ar-tab-new" onClick={() => onNewNote()} aria-label="New note"><span><Icon name="plus" size={22} /></span></button>
          <button type="button" className={`ar-tab ${myNotesActive ? 'is-active' : ''}`} onClick={openMyNotes} aria-label="My notes">
            <span className="ar-icon"><Icon name="notes" size={21} strokeWidth={1.8} /></span><span>My notes</span>
          </button>
          <button type="button" className="ar-tab" aria-label="More" onClick={(e) => openAt(e, [
            ...pageKeys.filter((k) => !tabs.includes(k)).map((k) => ({ label: label(k), onClick: () => go(k === 'dashboard' ? homeTo : k) })),
            withUtility && { label: 'Utility: templates, attachments, tags, Trash', onClick: () => setPanel('utility') },
            offRail.length > 0 && 'sep',
            ...offRail,
            'sep',
            { label: focus ? 'Leave focus mode' : 'Focus mode', onClick: toggleFocus },
            { label: 'Refresh', onClick: onRefreshAll },
            { label: 'Settings', onClick: onSettings },
          ].filter(Boolean), false)}>
            <span className="ar-icon"><Icon name="menu" size={21} /></span><span>More</span>
          </button>
        </nav>
      </>
    );
  }

  return (
    <>
      <nav className="app-rail" aria-label="Main" onContextMenu={(e) => { if (e.target.closest('.nr-item, .nr-new, .nr-brand')) return; onRailMenu(e); }}>
        <button type="button" className="nr-brand" onClick={() => go(homeTo ?? pageKeys[0] ?? 'notes')} aria-label="Selah home" title="Selah"><img src="/selah-rail.svg?v=4" alt="" /></button>
        <div className="nr-scroll">
          {dayKeys.map(item)}
          {dayKeys.length > 0 && restKeys.length > 0 && <div className="nr-divider" aria-hidden="true" />}
          {restKeys.map(item)}
          {(siteKey || myNotesItem) && <div className="nr-divider" aria-hidden="true" />}
          {siteKey && item(siteKey)}
          {myNotesItem}
        </div>
        {/* 10.1.1: New first, then the tools as labeled tiles like the pages above. 11.0: Utility and Settings (More is gone). */}
        <div className="nr-foot">
          <button type="button" className="nr-new" onClick={(e) => openAt(e, newMenu)} aria-label="New" title="New note" aria-haspopup="menu">
            <Icon name="plus" size={18} strokeWidth={2.2} />
          </button>
          <div className="nr-divider" aria-hidden="true" />
          {utilityItem}
          <button type="button" className="nr-item" onClick={onSettings} aria-label="Settings" title="Settings">
            <span className="nr-icon"><Icon name="sliders" size={20} strokeWidth={1.8} /></span><span className="nr-label">Settings</span>
          </button>
        </div>
      </nav>
      {panels}
    </>
  );
}
