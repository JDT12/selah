import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { DEFAULT_FOCUS_HIDDEN, SIDEBAR_PAGES, orderedPageKeys, useFocusPages, usePageOrder } from '../sidebarPages.js';

/** Settings → Focus mode: tick the pages focus mode hides from the sidebar. */
export default function FocusPagesDialog({ close }) {
  const dialog = useDialog();
  const [hidden, save] = useFocusPages();
  const [order] = usePageOrder();
  const apply = (next) => save(next).catch((e) => dialog.toast(`Couldn’t save: ${e.message}`, 'error'));
  const toggle = (k) => apply(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);
  const byKey = Object.fromEntries(SIDEBAR_PAGES.map((p) => [p.key, p]));
  const rows = [...orderedPageKeys(order).map((k) => byKey[k]), ...SIDEBAR_PAGES.filter((p) => p.group !== 'pages')];
  const isDefault = hidden.length === DEFAULT_FOCUS_HIDDEN.length && DEFAULT_FOCUS_HIDDEN.every((k) => hidden.includes(k));
  return (
    <div className="sidebar-dialog">
      <div className="dialog-header">
        <h2>Focus mode pages</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">Tick the pages focus mode hides from the sidebar. They're still a <kbd>Ctrl</kbd>+<kbd>K</kbd> away.</p>
      <div className="sidebar-choices">
        {rows.map((p, i) => (
          <div key={p.key} className={`sidebar-choice ${i && rows[i - 1].group !== p.group ? 'group-start' : ''}`}>
            <label>
              <input type="checkbox" checked={hidden.includes(p.key)} onChange={() => toggle(p.key)} />
              <Icon name={p.icon} size={16} />
              <span>{p.label}</span>
            </label>
          </div>
        ))}
      </div>
      <div className="modal-actions spread">
        <button className="btn" disabled={isDefault} onClick={() => apply(DEFAULT_FOCUS_HIDDEN)}>Reset</button>
        <button className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}
