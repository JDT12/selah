import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Selects with more options than this open the searchable picker instead of the browser's long list. */
const LONG = 10;

const setNative = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;

/** Reads a <select>'s options (and optgroup headings) from the DOM. */
function readOptions(sel) {
  const out = [];
  let group = null;
  for (const o of sel.options) {
    const g = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
    if (g && g !== group) out.push({ heading: g.label });
    group = g;
    if (o.hidden) continue;
    out.push({ value: o.value, label: o.label || o.textContent, disabled: o.disabled || g?.disabled, selected: o.selected });
  }
  return out;
}

/**
 * Watches the whole page: clicking (or opening with the keyboard) a long single <select> opens a compact,
 * searchable list under it instead. Picking sets the select's value and fires a real change event, so the
 * page's own onChange runs as usual. Touch screens keep the phone's own picker, which already handles long lists.
 */
export default function SelectPicker() {
  const [open, setOpen] = useState(null); // { sel, n }: n gives each opening a fresh picker
  useEffect(() => {
    let touch = false;
    const long = (t) => t instanceof HTMLSelectElement && !t.multiple && !t.disabled && t.size <= 1 && t.options.length > LONG;
    const onPointer = (e) => { touch = e.pointerType === 'touch'; };
    const onDown = (e) => {
      if (e.button !== 0 || touch || !long(e.target)) return;
      e.preventDefault();
      e.target.focus();
      setOpen((cur) => (cur?.sel === e.target ? null : { sel: e.target, n: Date.now() }));
    };
    const onKey = (e) => {
      if (!long(e.target)) return;
      const opens = (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) || e.key === 'F4' || e.key === ' ' || e.key === 'Enter';
      if (!opens) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen({ sel: e.target, n: Date.now() });
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return open ? <Picker key={open.n} sel={open.sel} close={() => setOpen(null)} /> : null;
}

function Picker({ sel, close }) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const [all] = useState(() => readOptions(sel));
  const [q, setQ] = useState('');
  const [pos, setPos] = useState(null);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? all.filter((o) => !o.heading && words.every((w) => o.label.toLowerCase().includes(w)))
    : all;
  const pickable = shown.filter((o) => !o.heading && !o.disabled);
  const [active, setActive] = useState(() => pickable.find((o) => o.selected)?.value ?? pickable[0]?.value);
  const activeOk = pickable.some((o) => o.value === active) ? active : pickable[0]?.value;

  useLayoutEffect(() => {
    const r = sel.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 240), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      width,
      maxHeight: Math.min(360, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, [sel]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeOk, pos]);

  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && e.target !== sel && close();
    const scroll = (e) => !ref.current?.contains(e.target) && close();
    document.addEventListener('mousedown', off, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', off, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [sel, close]);

  const pick = (value) => {
    close();
    sel.focus();
    if (value === sel.value) return;
    setNative.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const onKey = (e) => {
    const i = pickable.findIndex((o) => o.value === activeOk);
    const move = (n) => { e.preventDefault(); setActive(pickable[Math.max(0, Math.min(pickable.length - 1, n))]?.value); };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'PageDown') move(i + 8);
    else if (e.key === 'PageUp') move(i - 8);
    else if (e.key === 'Enter') { e.preventDefault(); if (activeOk != null) pick(activeOk); }
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      close();
      sel.focus();
    }
  };

  if (!pos) return <div ref={ref} className="select-picker" style={{ visibility: 'hidden' }} />;
  return (
    <div ref={ref} className="select-picker" style={pos} role="listbox" aria-label={sel.getAttribute('aria-label') || undefined}>
      <input className="select-picker-search" autoFocus placeholder="Search…" value={q}
        onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search the list" />
      <div ref={listRef} className="select-picker-list">
        {shown.map((o, i) => (o.heading
          ? <div key={`h${i}`} className="select-picker-head">{o.heading}</div>
          : (
            <button key={`${o.value}|${i}`} type="button" role="option" aria-selected={o.selected} disabled={o.disabled} tabIndex={-1}
              className={`select-picker-item ${o.value === activeOk ? 'is-active' : ''} ${o.selected ? 'is-selected' : ''}`}
              onMouseMove={() => o.value !== activeOk && setActive(o.value)}
              onClick={() => pick(o.value)}>
              {o.label}
            </button>
          )))}
        {!pickable.length && <div className="select-picker-none">No matches</div>}
      </div>
    </div>
  );
}
