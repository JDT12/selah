import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { api } from '../api.js';

/**
 * 13.0: writing on the sermon or lesson in Preach and Teach with a pen (Apple Pencil, S Pen): circle, underline, write
 * in the margin. A pen always writes and a short tap with it still folds headings and opens verses; fingers scroll; a
 * mouse writes while the Ink tools are open. The pen's button (or the eraser) erases.
 *
 * Each stroke belongs to the paragraph, point or heading it starts beside and is kept in em units from that block's
 * top (and the text's left edge), so it stays with its words when the text gets larger, a section folds or the screen
 * turns. Blocks are known by their text, so the same ink shows in Manuscript and Outline. Saved with the note on the
 * server (GET/PUT /api/notes/:id/ink), so it's there next time and on your other devices.
 */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td';
const COLORS = { red: '#d93b30', blue: '#2f6fd6', ink: 'currentColor', green: '#2f9a5c' };
const MARKERS = { yellow: '#f5d000', pink: '#ff7eb6' };
const WIDTH = { p: 0.09, h: 0.9 }; // em

/** A block's own words (not the lists inside it, not verse text opened under it). */
function ownText(el) {
  const copy = el.cloneNode(true);
  copy.querySelectorAll('ol, ul, .pm-verse, .pm-slide-pin, .d-verse').forEach((x) => x.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

/** Every block in the text with its key: its words, and which time those words come up (1st, 2nd…). */
function blockKeys(root) {
  const seen = new Map();
  const out = [];
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.closest('.pm-verse')) continue;
    const text = ownText(el);
    if (!text) continue;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    out.push({ el, key: `${text}#${n}` });
  }
  return out;
}

// 13.0: a stroke is kept beside the word under it (its letter's place in the block's own text), so when the lines
// wrap differently (larger text, a narrower screen) the ink moves with the word. Older strokes without one keep
// their place from the block's top.
const SKIP = 'ol, ul, .pm-verse, .pm-slide-pin';
function ownTextNodes(el) {
  const out = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const n = walk.currentNode;
    const skip = n.parentElement.closest(SKIP);
    if (skip && el.contains(skip) && skip !== el) continue;
    out.push(n);
  }
  return out;
}
function offsetAt(el, x, y) {
  let node = null;
  let at = 0;
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; at = r.startOffset; } }
  else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; at = p.offset; } }
  if (!node || node.nodeType !== 3) return null;
  let total = 0;
  for (const n of ownTextNodes(el)) {
    if (n === node) return total + Math.min(at, Math.max(0, n.length - 1));
    total += n.length;
  }
  return null;
}
function rectAt(el, offset) {
  let left = offset;
  for (const n of ownTextNodes(el)) {
    if (left < n.length) {
      const r = document.createRange();
      r.setStart(n, left);
      r.setEnd(n, Math.min(n.length, left + 1));
      const box = r.getClientRects()[0] ?? r.getBoundingClientRect();
      return box && box.height ? box : null;
    }
    left -= n.length;
  }
  return null;
}

const pathOf = (pts) => {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0].x} ${pts[0].y}l0.01 0`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last.x} ${last.y}`;
};
const r2 = (n) => Math.round(n * 100) / 100;

export default function PreachInk({ noteId, pageRef, contentRef, version, open, onClose, dialog }) {
  const [strokes, setStrokes] = useState([]); // { k, t: 'p'|'h', c, w, pts: [{ x, y, p }] } in em
  const [shown, setShown] = useState(true);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState('red');
  const [marker, setMarker] = useState('yellow');
  const [drawn, setDrawn] = useState({ w: 0, h: 0, items: [] }); // where each stroke is on the page, in px
  const [live, setLive] = useState(null);
  const loaded = useRef(false);
  const undo = useRef([]);
  const gesture = useRef(null);
  const saveTimer = useRef(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const penDown = useRef(false);

  useEffect(() => {
    let alive = true;
    api.noteInk(noteId).then((r) => { if (alive) { setStrokes(r.strokes ?? []); loaded.current = true; } }).catch(() => { loaded.current = true; });
    return () => { alive = false; };
  }, [noteId]);
  const save = useCallback((next) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => api.saveNoteInk(noteId, next).catch(() => dialog?.toast('Your ink wasn’t saved. Check the connection.', 'error')), 700);
  }, [noteId, dialog]);
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); api.saveNoteInk(noteId, strokesRef.current).catch(() => {}); }
  }, [noteId]);
  const change = (next) => {
    undo.current.push(strokesRef.current);
    if (undo.current.length > 50) undo.current.shift();
    setStrokes(next);
    save(next);
  };

  // ---- where things are: em size, the text's left edge, each block's box (all relative to the page's content) ----
  const geometry = useCallback(() => {
    const page = pageRef.current;
    const content = contentRef.current;
    if (!page || !content) return null;
    const pr = page.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(content).fontSize) || 20;
    const toPage = (x, y) => ({ x: x - pr.left + page.scrollLeft, y: y - pr.top + page.scrollTop });
    const left = toPage(cr.left, 0).x;
    const blocks = blockKeys(content).map((b) => {
      const r = b.el.getBoundingClientRect();
      const top = toPage(0, r.top).y;
      return { ...b, top, bottom: top + r.height, visible: r.height > 0 };
    });
    const fromPage = (x, y) => ({ x: x + pr.left - page.scrollLeft, y: y + pr.top - page.scrollTop });
    return { page, em, left, blocks, toPage, fromPage };
  }, [pageRef, contentRef]);

  const layout = useCallback(() => {
    const g = geometry();
    if (!g) return;
    const byKey = new Map(g.blocks.map((b) => [b.key, b]));
    const items = [];
    for (const [i, st] of strokesRef.current.entries()) {
      const b = byKey.get(st.k);
      if (!b || !b.visible) continue;
      const word = st.o != null ? rectAt(b.el, st.o) : null;
      const ax = word ? g.toPage(word.left, 0).x : g.left;
      const ay = word ? g.toPage(0, word.top).y : b.top;
      items.push({ i, st, pts: st.pts.map((p) => ({ x: r2(ax + p.x * g.em), y: r2(ay + p.y * g.em) })), em: g.em });
    }
    setDrawn({ w: g.page.scrollWidth, h: g.page.scrollHeight, items });
  }, [geometry]);
  useLayoutEffect(() => { layout(); }, [layout, strokes, version]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const ro = new ResizeObserver(() => layout());
    ro.observe(content);
    const mo = new MutationObserver(() => layout());
    mo.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', layout);
    return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', layout); };
  }, [contentRef, layout]);

  // ---- input ----
  // The eraser tool, or a pen's eraser end. The pen's side button switches between pen and eraser (Samsung keeps it
  // to itself while the pen touches, so it can't be held down to erase).
  const toolNow = useRef(tool);
  toolNow.current = tool;
  const isEraser = (e) => toolNow.current === 'eraser' || (e.buttons & 32) !== 0;
  const lastButtons = useRef(0);
  const lastTool = useRef('pen');
  const toggleTool = () => {
    const next = toolNow.current === 'eraser' ? lastTool.current : 'eraser';
    if (next === 'eraser') lastTool.current = toolNow.current;
    toolNow.current = next;
    setTool(next);
  };
  const penButton = (e) => {
    if (e.pointerType !== 'pen') return false;
    const pressed = (e.buttons & 2) !== 0;
    const was = (lastButtons.current & 2) !== 0;
    lastButtons.current = e.buttons;
    if (pressed && !was) { toggleTool(); return true; }
    return false;
  };
  const eraseNear = (pt, g) => {
    const near = new Set(drawn.items.filter((it) => it.pts.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < g.em * 0.6)).map((it) => it.i));
    if (!near.size) return;
    const next = strokesRef.current.filter((_, i) => !near.has(i));
    strokesRef.current = next;
    setStrokes(next);
    gesture.current.erased = true;
  };

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;
    // iPadOS and Android scroll with a pen unless its touch is stopped; the pen writes instead.
    // Android has no touchType, but the pen's pointerdown comes first, so a touch that started as a pen is known.
    const onTouch = (e) => { if (shown && (penDown.current || [...e.touches].some((t) => t.touchType === 'stylus'))) e.preventDefault(); };
    page.addEventListener('touchstart', onTouch, { passive: false });
    page.addEventListener('touchmove', onTouch, { passive: false });
    return () => { page.removeEventListener('touchstart', onTouch); page.removeEventListener('touchmove', onTouch); };
  }, [pageRef, shown]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;
    const down = (e) => {
      if (e.pointerType === 'pen') { penDown.current = true; penButton(e); }
      if (!shown || gesture.current) return;
      const writes = e.pointerType === 'pen' || (e.pointerType === 'mouse' && open && e.button === 0);
      if (!writes || e.target.closest('button, input, select, .pm-slides')) return;
      const g = geometry();
      if (!g) return;
      const pt = g.toPage(e.clientX, e.clientY);
      gesture.current = { id: e.pointerId, g, start: pt, pts: [{ ...pt, p: e.pressure || 0.5 }], moved: false, erase: isEraser(e), before: strokesRef.current, target: e.target };
      try { page.setPointerCapture(e.pointerId); } catch { /* gone */ }
      if (e.pointerType === 'mouse') e.preventDefault();
    };
    const move = (e) => {
      if (e.pointerType === 'pen' && e.buttons !== lastButtons.current) penButton(e);
      const gs = gesture.current;
      if (!gs || gs.id !== e.pointerId) return;
      const samples = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
      for (const s of samples) {
        const pt = gs.g.toPage(s.clientX, s.clientY);
        if (!gs.moved && Math.hypot(pt.x - gs.start.x, pt.y - gs.start.y) < 4) continue;
        gs.moved = true;
        if (gs.erase) { eraseNear(pt, gs.g); continue; }
        gs.pts.push({ ...pt, p: s.pressure || 0.5 });
      }
      if (gs.moved && !gs.erase) setLive({ t: tool === 'marker' ? 'h' : 'p', c: tool === 'marker' ? marker : color, pts: gs.pts, em: gs.g.em });
      if (gs.moved) e.preventDefault();
    };
    const up = (e) => {
      if (e.pointerType === 'pen') { penDown.current = false; lastButtons.current = e.buttons; }
      const gs = gesture.current;
      if (!gs || gs.id !== e.pointerId) return;
      gesture.current = null;
      setLive(null);
      if (!gs.moved) {
        // A tap with the pen: what a finger's tap does (fold a heading, open a verse).
        if (e.pointerType === 'pen') gs.target.click?.();
        return;
      }
      if (gs.erase) {
        if (gs.erased) { undo.current.push(gs.before); save(strokesRef.current); }
        return;
      }
      // Which block: the one beside where the stroke starts (the deepest that spans that height), else the nearest.
      const y = gs.pts[0].y;
      const vis = gs.g.blocks.filter((b) => b.visible);
      const spans = vis.filter((b) => b.top - 2 <= y && y <= b.bottom + 2).sort((a, b) => (a.bottom - a.top) - (b.bottom - b.top));
      const b = spans[0] ?? vis.sort((a, c) => Math.min(Math.abs(a.top - y), Math.abs(a.bottom - y)) - Math.min(Math.abs(c.top - y), Math.abs(c.bottom - y)))[0];
      if (!b) return;
      const { em, left } = gs.g;
      // The word under the middle of the stroke (kept inside the block): the stroke is kept from that word's corner.
      const xs = gs.pts.map((p) => p.x);
      const ys = gs.pts.map((p) => p.y);
      const mid = gs.g.fromPage((Math.min(...xs) + Math.max(...xs)) / 2, Math.min(b.bottom - 2, Math.max(b.top + 2, (Math.min(...ys) + Math.max(...ys)) / 2)));
      const o = offsetAt(b.el, mid.x, mid.y);
      const word = o != null ? rectAt(b.el, o) : null;
      const ax = word ? gs.g.toPage(word.left, 0).x : left;
      const ay = word ? gs.g.toPage(0, word.top).y : b.top;
      const st = {
        k: b.key, ...(word ? { o } : {}), t: tool === 'marker' ? 'h' : 'p', c: tool === 'marker' ? marker : color,
        pts: gs.pts.map((p) => ({ x: r2((p.x - ax) / em), y: r2((p.y - ay) / em), p: Math.round((p.p ?? 0.5) * 100) / 100 })),
      };
      change([...strokesRef.current, st]);
    };
    page.addEventListener('pointerdown', down);
    page.addEventListener('pointermove', move);
    page.addEventListener('pointerup', up);
    const cancel = (e) => { if (e.pointerType === 'pen') { penDown.current = false; lastButtons.current = 0; } gesture.current = null; setLive(null); };
    page.addEventListener('pointercancel', cancel);
    // Other ways a pen's button may arrive: a right click or a pen's context menu.
    const menu = (e) => {
      if (e.pointerType !== 'pen' && !penDown.current) return;
      e.preventDefault();
      toggleTool();
    };
    const hover = (e) => { if (e.pointerType === 'pen' && e.buttons !== lastButtons.current) penButton(e); };
    page.addEventListener('contextmenu', menu);
    page.addEventListener('auxclick', menu);
    window.addEventListener('pointermove', hover);
    return () => {
      page.removeEventListener('contextmenu', menu);
      page.removeEventListener('auxclick', menu);
      window.removeEventListener('pointermove', hover);
      page.removeEventListener('pointerdown', down);
      page.removeEventListener('pointermove', move);
      page.removeEventListener('pointerup', up);
      page.removeEventListener('pointercancel', cancel);
    };
  }); // fresh handlers each render: they read the current tool and color

  const strokeStyle = (st, em) => {
    const marker = st.t === 'h';
    return { stroke: marker ? (MARKERS[st.c] ?? MARKERS.yellow) : (COLORS[st.c] ?? COLORS.red), strokeWidth: em * (marker ? WIDTH.h : WIDTH.p), opacity: marker ? 0.38 : 1 };
  };

  return (
    <>
      {shown && (
        <svg className="pm-ink" width={drawn.w} height={drawn.h} aria-hidden="true">
          {drawn.items.map((it) => <path key={it.i} d={pathOf(it.pts)} style={strokeStyle(it.st, it.em)} />)}
          {live && <path d={pathOf(live.pts)} style={strokeStyle(live, live.em)} />}
        </svg>
      )}
      {open && pageRef.current?.parentElement && createPortal(
        <div className="pm-ink-bar" role="toolbar" aria-label="Ink">
          <span className="pm-ink-group">
            {Object.entries(COLORS).map(([k, v]) => (
              <button key={k} type="button" className={`pm-ink-swatch ${tool === 'pen' && color === k ? 'is-on' : ''}`} style={{ '--sw': v === 'currentColor' ? 'var(--pm-text)' : v }}
                aria-label={`${k} pen`} aria-pressed={tool === 'pen' && color === k} onClick={() => { setTool('pen'); setColor(k); }} />
            ))}
          </span>
          <span className="pm-ink-group">
            {Object.entries(MARKERS).map(([k, v]) => (
              <button key={k} type="button" className={`pm-ink-swatch is-marker ${tool === 'marker' && marker === k ? 'is-on' : ''}`} style={{ '--sw': v }}
                aria-label={`${k} highlighter`} aria-pressed={tool === 'marker' && marker === k} onClick={() => { setTool('marker'); setMarker(k); }} />
            ))}
            <button type="button" className={`pm-icon ${tool === 'eraser' ? 'is-on' : ''}`} aria-pressed={tool === 'eraser'} onClick={() => setTool(tool === 'eraser' ? lastTool.current : (lastTool.current = tool, 'eraser'))} aria-label="Eraser" title="Eraser (the pen's side button switches it too, where the pen sends it)"><Icon name="eraser" size={16} /></button>
          </span>
          <span className="pm-ink-group">
            <button type="button" className="pm-icon" disabled={!undo.current.length} onClick={() => { const prev = undo.current.pop(); if (prev) { setStrokes(prev); save(prev); } }} aria-label="Undo ink" title="Undo"><Icon name="undo" size={16} /></button>
            <button type="button" className="pm-link" onClick={() => setShown(!shown)}>{shown ? 'Hide ink' : 'Show ink'}</button>
            <button type="button" className="pm-link" disabled={!strokes.length} onClick={async () => {
              if (await dialog.confirm({ title: 'Clear all the ink on this sermon?', message: 'Undo brings it back while Preach is open.', okLabel: 'Clear', danger: true })) change([]);
            }}>Clear</button>
          </span>
          <span className="pm-ink-hint">{shown ? 'Write with your pen. A mouse writes while these tools are open.' : 'Ink is hidden.'}</span>
          <button type="button" className="pm-icon" onClick={onClose} aria-label="Close the ink tools"><Icon name="x" size={16} /></button>
        </div>,
        pageRef.current.parentElement,
      )}
    </>
  );
}
