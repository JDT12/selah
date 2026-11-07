import { useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { SIDEBAR_PAGES, orderedPageKeys, useHiddenPages, usePageOrder } from '../sidebarPages.js';

/** Customize the rail (7.1): tick the pages it shows and put them in order. (10.1: no pinned notebooks.) */
export default function SidebarDialog({ close }) {
  const dialog = useDialog();
  const [hidden, save] = useHiddenPages();
  const [order, saveOrder] = usePageOrder();
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const failed = (e) => dialog.toast(`Couldn’t save: ${e.message}`, 'error');
  const apply = (next) => save(next).catch(failed);
  const toggle = (k) => apply(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);

  const keys = orderedPageKeys(order);
  const reorder = (next) => saveOrder(next).catch(failed);
  const move = (k, d) => {
    const i = keys.indexOf(k);
    const next = [...keys];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    reorder(next);
  };
  const dropOn = (k) => {
    if (!dragging || dragging === k) return;
    const next = keys.filter((x) => x !== dragging);
    next.splice(next.indexOf(k) + (keys.indexOf(dragging) < keys.indexOf(k) ? 1 : 0), 0, dragging);
    reorder(next);
  };
  const isDefault = keys.every((k, i) => k === orderedPageKeys([])[i]);

  const byKey = Object.fromEntries(SIDEBAR_PAGES.map((p) => [p.key, p]));
  // My notes and Utility close the list; either can go (a right-click on the rail still reaches it).
  const rows = [...keys.map((k) => byKey[k]), byKey.mynotes, byKey.utility];

  return (
    <div className="sidebar-dialog">
      <div className="dialog-header">
        <h2>Customize the rail</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">
        Choose the pages the rail shows, and drag them (or use the arrows) to put them in your order. My notes follows
        them, and Utility sits at the foot. It follows you to your other devices, and hidden pages are still a right-click on the rail (or <kbd>Ctrl</kbd>+<kbd>K</kbd>) away; on a phone, under More.
      </p>
      <div className="sidebar-choices">
        {rows.map((p, i) => {
          const movable = p.group === 'pages';
          const at = keys.indexOf(p.key);
          return (
            <div key={p.key}
              className={`sidebar-choice ${i && rows[i - 1].group !== p.group ? 'group-start' : ''} ${movable ? 'is-movable' : ''} ${dragging === p.key ? 'is-dragging' : ''} ${over === p.key && dragging && dragging !== p.key ? 'is-over' : ''}`}
              draggable={movable}
              onDragStart={movable ? (e) => { setDragging(p.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.key); } : undefined}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onDragOver={movable && dragging ? (e) => { e.preventDefault(); setOver(p.key); } : undefined}
              onDrop={movable ? (e) => { e.preventDefault(); dropOn(p.key); setDragging(null); setOver(null); } : undefined}>
              <label>
                <input type="checkbox" checked={!hidden.includes(p.key)} onChange={() => toggle(p.key)} />
                <Icon name={p.icon} size={16} />
                <span>{p.label}</span>
                {p.note && <span className="muted sidebar-choice-note">{p.note}</span>}
              </label>
              {movable && (
                <span className="sidebar-choice-move">
                  <button type="button" className="icon-btn" disabled={at === 0} onClick={() => move(p.key, -1)} aria-label={`Move ${p.label} up`}><Icon name="arrowUp" size={14} /></button>
                  <button type="button" className="icon-btn" disabled={at === keys.length - 1} onClick={() => move(p.key, 1)} aria-label={`Move ${p.label} down`}><Icon name="arrowDown" size={14} /></button>
                  <span className="sidebar-choice-grip" title="Drag to reorder"><Icon name="grip" size={14} /></span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="modal-actions spread">
        <span className="modal-actions-group">
          <button className="btn" disabled={!hidden.length} onClick={() => apply([])}>Show all</button>
          <button className="btn" disabled={isDefault} onClick={() => reorder([])}>Reset order</button>
        </span>
        <button className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}
