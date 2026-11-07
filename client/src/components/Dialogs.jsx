import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SelectPicker from './SelectPicker.jsx';

const DialogContext = createContext(null);
export const useDialog = () => useContext(DialogContext);

let nextId = 1;

export function DialogProvider({ children }) {
  const [dialogs, setDialogs] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [context, setContext] = useState(null); // { x, y, items } for the open right-click menu

  // dismissable: false keeps a click outside or Escape from closing it (e.g. mid-recording).
  const open = useCallback((render, { dismissable = true } = {}) => new Promise((resolve) => {
    const id = nextId++;
    const close = (value) => {
      setDialogs((d) => d.filter((x) => x.id !== id));
      resolve(value);
    };
    setDialogs((d) => [...d, { id, render, close, dismissable }]);
  }), []);

  // action: { label, onClick } adds a button (e.g. Undo); the toast closes when it's clicked.
  const toast = useCallback((message, kind = 'info', ms = 4000, action = null) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, message, kind, action }]);
    if (ms) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
    return {
      update: (m) => setToasts((t) => t.map((x) => (x.id === id ? { ...x, message: m } : x))),
      close: () => setToasts((t) => t.filter((x) => x.id !== id)),
    };
  }, []);

  const api = useMemo(() => ({
    open,
    toast,
    prompt: (opts) => open((close) => <PromptDialog {...opts} close={close} />),
    confirm: (opts) => open((close) => <ConfirmDialog {...opts} close={close} />),
    choose: (opts) => open((close) => <ChooseDialog {...opts} close={close} />),
    /** Right-click menu at the pointer: onContextMenu={(e) => dialog.contextMenu(e, items)}. Items as for <Menu>. */
    contextMenu: (e, items) => {
      const list = tidyItems(items);
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      setContext({ x: e.clientX, y: e.clientY, items: list });
    },
  }), [open, toast]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialogs.map((d) => (
        <Modal key={d.id} onClose={() => d.dismissable && d.close(null)}>{d.render(d.close)}</Modal>
      ))}
      {context && <ContextMenu {...context} close={() => setContext(null)} />}
      <SelectPicker />
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
            {t.action && (
              <button type="button" className="toast-action" onClick={() => {
                setToasts((all) => all.filter((x) => x.id !== t.id));
                t.action.onClick();
              }}>{t.action.label}</button>
            )}
          </div>
        ))}
      </div>
    </DialogContext.Provider>
  );
}

export function Modal({ children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    // With stacked dialogs, Escape only closes the topmost one.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.modal-backdrop');
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={ref} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

function PromptDialog({ title, label, value = '', okLabel = 'OK', placeholder, close }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) close(v.trim()); }}>
      <h2>{title}</h2>
      {label && <label className="field-label">{label}</label>}
      <input ref={ref} className="input" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!v.trim()}>{okLabel}</button>
      </div>
    </form>
  );
}

function ConfirmDialog({ title, message, okLabel = 'OK', cancelLabel = 'Cancel', danger, close }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div>
      <h2>{title}</h2>
      {message && <p className="modal-message">{message}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={() => close(false)}>{cancelLabel}</button>
        <button ref={ref} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>{okLabel}</button>
      </div>
    </div>
  );
}

function ChooseDialog({ title, message, options, value, okLabel = 'OK', close }) {
  const [v, setV] = useState(value ?? options[0]?.value);
  const [q, setQ] = useState('');
  // Long lists (many notebooks, say) get a search box and a compact, scrolling list.
  const long = options.length > 8;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? options.filter((o) => typeof o.label === 'string' && words.every((w) => o.label.toLowerCase().includes(w))) : options;
  const ok = shown.some((o) => o.value === v) ? v : shown[0]?.value;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (shown.length) close(ok); }}>
      <h2>{title}</h2>
      {message && <p className="modal-message">{message}</p>}
      {long && <input className="input choice-search" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the list" />}
      <div className={`choice-list ${long ? 'is-long' : ''}`}>
        {!shown.length && <p className="muted">No matches</p>}
        {shown.map((o) => (
          <label key={String(o.value)} className={`choice ${ok === o.value ? 'is-active' : ''}`} onDoubleClick={() => close(o.value)}>
            <input type="radio" checked={ok === o.value} onChange={() => setV(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary">{okLabel}</button>
      </div>
    </form>
  );
}

/** Drops empty items and separators that would sit at the start, the end, or next to another one. */
function tidyItems(items) {
  const out = [];
  for (const it of items.filter(Boolean)) {
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** On a phone, menus open as a sheet along the bottom of the screen (a menu by the finger could run off it). */
const isPhone = () => window.matchMedia('(max-width: 800px)').matches;

function MenuItems({ items, onPick }) {
  return items.map((it, i) => (it === 'sep'
    ? <div key={i} className="menu-sep" />
    : (
      <button key={i} type="button" role="menuitem" className={`menu-item ${it.danger ? 'is-danger' : ''}`}
        onClick={(e) => { e.stopPropagation(); onPick(); it.onClick(); }}>
        {it.label}
      </button>
    )));
}

/**
 * The right-click menu: kept inside the window (scrolling when it's taller than the window), closed by a click
 * elsewhere, Escape, scrolling or resizing. On a phone it's a sheet along the bottom.
 */
function ContextMenu({ x, y, items, close }) {
  const ref = useRef(null);
  const [sheet] = useState(isPhone);
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' });
  useLayoutEffect(() => {
    if (sheet) { setPos({}); ref.current.querySelector('.menu-item')?.focus(); return; }
    const r = ref.current.getBoundingClientRect();
    const room = window.innerHeight - 8;
    const h = Math.min(r.height, room);
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, y + h > window.innerHeight - 4 ? Math.min(y - h, window.innerHeight - 4 - h) : y),
      maxHeight: room,
    });
    ref.current.querySelector('.menu-item')?.focus();
  }, [x, y, sheet]);
  useEffect(() => {
    // A tap on a sheet's scrim closes it on click, so the tap can't land on what's underneath.
    const off = (e) => !ref.current?.contains(e.target) && !e.target.classList?.contains('menu-scrim') && close();
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...ref.current.querySelectorAll('.menu-item')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    };
    // Scrolling the menu itself (a long one, or the sheet) keeps it open.
    const scroll = (e) => !ref.current?.contains(e.target) && close();
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', off, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [close]);
  return (
    <>
      {sheet && <div className="menu-scrim" onClick={close} />}
      <div ref={ref} className={`menu context-menu ${sheet ? 'is-sheet' : ''}`} role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
        <MenuItems items={items} onPick={close} />
      </div>
    </>
  );
}

/**
 * Small dropdown menu anchored to a trigger button. items: [{label, onClick, danger, icon}] | 'sep'. It opens upward
 * when there's more room above, scrolls when it's taller than the room it has, and on a phone opens as a sheet.
 */
export function Menu({ trigger, items, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [place, setPlace] = useState(null);
  const ref = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !ref.current?.contains(e.target) && !menuRef.current?.contains(e.target) && !e.target.classList?.contains('menu-scrim') && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || sheet || !menuRef.current) { setPlace(null); return; }
    const t = ref.current.getBoundingClientRect();
    const h = menuRef.current.scrollHeight;
    const below = window.innerHeight - t.bottom - 12;
    const above = t.top - 12;
    const up = h > below && above > below;
    setPlace(up ? { top: 'auto', bottom: 'calc(100% + 4px)', maxHeight: above } : { maxHeight: below });
  }, [open, sheet]);
  const toggle = (e) => {
    e?.stopPropagation();
    if (!open) setSheet(isPhone());
    setOpen((o) => !o);
  };
  const list = <MenuItems items={tidyItems(items)} onPick={() => setOpen(false)} />;
  return (
    <div className={`menu-wrap ${className}`} ref={ref}>
      {trigger({ open, toggle })}
      {open && !sheet && <div ref={menuRef} className={`menu menu-${align}`} role="menu" style={place ?? undefined}>{list}</div>}
      {open && sheet && createPortal(
        <>
          {/* Clicks here mustn't reach the trigger's parents (a sheet is still inside them, as React sees it). */}
          <div className="menu-scrim" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div ref={menuRef} className="menu is-sheet" role="menu" onClick={(e) => e.stopPropagation()}>{list}</div>
        </>,
        document.body,
      )}
    </div>
  );
}
