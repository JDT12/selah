import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import Icon from '../components/Icon.jsx';
import { useStoredState } from '../useStoredState.js';

/**
 * A pen/stylus drawing block. Strokes are kept in the note itself (data-strokes), in a
 * 1000-unit-wide coordinate space, so a drawing scales with the page and copies, undoes and
 * saves like any other block.
 *
 * Input: a pen (S Pen, Apple Pencil) always draws, and its side button erases. Once a pen has
 * been used on this device, fingers scroll instead of drawing, so a resting palm leaves no
 * marks; the hand button switches finger drawing back on.
 */

const W = 1000;
const MIN_H = 160;
const MAX_H = 4000;
const GROW = 240;
const LINE = 40; // paper line spacing

const PEN_COLORS = { ink: null, blue: '#2f6fd6', red: '#d93b30', green: '#2f9a5c', orange: '#e07b16' };
const HIGHLIGHT_COLORS = { yellow: '#f5d000', green: '#5fd38d', pink: '#ff7eb6', blue: '#6cb6ff' };
const SIZES = [2, 4, 8];
const PAPERS = ['blank', 'lined', 'grid'];

// ---- stroke encoding: { t: 'p'|'h', c: color, w: width, d: [x, y, p, dx, dy, dp, ...] } ----
// x/y are stored in half units, pressure as 0-100, all delta-encoded to keep notes small.

export function decodeStrokes(s) {
  try {
    const list = JSON.parse(s || '[]');
    return list.map((st) => {
      const pts = [];
      let x = 0, y = 0, p = 0;
      for (let i = 0; i + 2 < st.d.length; i += 3) {
        x += st.d[i]; y += st.d[i + 1]; p += st.d[i + 2];
        pts.push({ x: x / 2, y: y / 2, p: p / 100 });
      }
      return { t: st.t, c: st.c, w: st.w, pts };
    });
  } catch {
    return [];
  }
}

function encodeStrokes(strokes) {
  return JSON.stringify(strokes.map((st) => {
    const d = [];
    let x = 0, y = 0, p = 0;
    for (const pt of st.pts) {
      const nx = Math.round(pt.x * 2), ny = Math.round(pt.y * 2), np = Math.round(pt.p * 100);
      d.push(nx - x, ny - y, np - p);
      x = nx; y = ny; p = np;
    }
    return { t: st.t, c: st.c, w: st.w, d };
  }));
}

// ---- rendering ----

function colorOf(st, ink) {
  if (st.t === 'h') return HIGHLIGHT_COLORS[st.c] ?? HIGHLIGHT_COLORS.yellow;
  return PEN_COLORS[st.c] ?? ink;
}

const penWidth = (st, p) => st.w * (0.45 + 0.9 * p);

function drawStroke(ctx, st, ink) {
  const { pts } = st;
  if (!pts.length) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = colorOf(st, ink);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (st.t === 'h') {
    // One path at a constant width so overlapping segments don't stack the transparency.
    ctx.globalAlpha = 0.38;
    ctx.lineWidth = st.w * 4;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
    ctx.stroke();
  } else if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, penWidth(st, pts[0].p) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Quadratic curves through the midpoints, each segment at its own pressure width.
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let from = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const to = i === pts.length - 1 ? pts[i] : mid(pts[i], pts[i + 1]);
      ctx.beginPath();
      ctx.lineWidth = penWidth(st, (pts[i - 1].p + pts[i].p) / 2);
      ctx.moveTo(from.x, from.y);
      if (i === pts.length - 1) ctx.lineTo(to.x, to.y);
      else ctx.quadraticCurveTo(pts[i].x, pts[i].y, to.x, to.y);
      ctx.stroke();
      from = to;
    }
  }
  ctx.restore();
}

function drawPaper(ctx, paper, height, color) {
  if (paper === 'blank') return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = LINE; y < height; y += LINE) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  if (paper === 'grid') for (let x = LINE; x < W; x += LINE) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  ctx.stroke();
  ctx.restore();
}

/**
 * A drawing as a PNG on white paper (for publishing), cropped just below the lowest stroke. forText leaves out the
 * paper lines and highlighter, and draws all ink black, for reading the writing as text.
 */
export function drawingToPng({ strokes, height, paper }, width = 1200, { forText = false } = {}) {
  const list = decodeStrokes(strokes).filter((st) => !forText || st.t !== 'h');
  const bottom = Math.max(0, ...list.flatMap((st) => st.pts.map((p) => p.y + st.w * 2)));
  const h = Math.min(height, Math.max(80, Math.ceil(bottom + 30)));
  const scale = width / W;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (!forText) drawPaper(ctx, paper, h, '#e3e3df');
  for (const st of list) drawStroke(ctx, forText ? { ...st, c: 'ink' } : st, forText ? '#000000' : '#1d1f1e');
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render drawing'))), 'image/png'));
}

/** Prepare a canvas for drawing in logical units; returns its 2D context. */
function setupCanvas(canvas, scale, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(W * scale * dpr);
  const h = Math.round(height * scale * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  ctx.clearRect(0, 0, W, height);
  return ctx;
}

// ---- hit testing for the eraser ----

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hits(st, p, radius) {
  const r = radius + (st.t === 'h' ? st.w * 2 : st.w);
  const { pts } = st;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r;
  for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= r) return true;
  return false;
}

/** Re-render when the app or system switches between light and dark. */
function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((n) => n + 1);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', bump); mo.disconnect(); };
  }, []);
  return v;
}

// Keep receiving a pointer's moves after it leaves the canvas.
const capture = (e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } };

const PEN_SEEN_KEY = 'noteapp.penSeen';
const penSeenBefore = () => { try { return localStorage.getItem(PEN_SEEN_KEY) === '1'; } catch { return false; } };

function DrawingView({ node, updateAttributes, editor, deleteNode, selected, getPos }) {
  const editable = editor.isEditable;
  const wrapRef = useRef(null);
  const baseRef = useRef(null);
  const liveRef = useRef(null);
  const [scale, setScale] = useState(0);
  const themeVersion = useThemeVersion();

  const [tool, setTool] = useStoredState('noteapp.draw.tool', 'pen');
  const [penColor, setPenColor] = useStoredState('noteapp.draw.penColor', 'ink');
  const [hlColor, setHlColor] = useStoredState('noteapp.draw.hlColor', 'yellow');
  const [size, setSize] = useStoredState('noteapp.draw.size', 4);
  const [fingerDraws, setFingerDraws] = useStoredState('noteapp.draw.finger', !penSeenBefore());

  // Strokes being edited locally; reset whenever the saved attribute changes (undo, remote edit).
  const saved = node.attrs.strokes;
  const decoded = useMemo(() => decodeStrokes(saved), [saved]);
  const strokes = useRef(decoded);
  const [height, setHeight] = useState(node.attrs.height);
  useEffect(() => { strokes.current = decoded; }, [decoded]);
  useEffect(() => { setHeight(node.attrs.height); }, [node.attrs.height]);

  const history = useRef({ undo: [], redo: [] });
  const [, setHistoryVersion] = useState(0);
  const gesture = useRef(null);

  // Track the block's width.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    setScale(el.clientWidth / W);
    return () => ro.disconnect();
  }, []);

  const inkColors = useCallback(() => {
    const cs = getComputedStyle(wrapRef.current);
    return { ink: cs.getPropertyValue('--text').trim() || '#1d1f1e', line: cs.getPropertyValue('--border').trim() || '#e3e3df' };
  }, []);

  const renderBase = useCallback((h = height) => {
    const canvas = baseRef.current;
    if (!canvas || !scale) return;
    const { ink, line } = inkColors();
    const ctx = setupCanvas(canvas, scale, h);
    drawPaper(ctx, node.attrs.paper, h, line);
    for (const st of strokes.current) drawStroke(ctx, st, ink);
  }, [scale, height, node.attrs.paper, inkColors]);

  useEffect(() => { renderBase(); }, [renderBase, decoded, themeVersion]);

  const commit = (next, nextHeight = height) => {
    history.current.undo.push({ strokes: strokes.current, height });
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
    setHistoryVersion((n) => n + 1);
    strokes.current = next;
    updateAttributes({ strokes: encodeStrokes(next), height: nextHeight });
  };

  const restore = (from, to) => {
    const entry = history.current[from].pop();
    if (!entry) return;
    history.current[to].push({ strokes: strokes.current, height });
    setHistoryVersion((n) => n + 1);
    strokes.current = entry.strokes;
    updateAttributes({ strokes: encodeStrokes(entry.strokes), height: entry.height });
  };

  // ---- pointer input ----

  const toLogical = (e) => {
    const r = baseRef.current.getBoundingClientRect();
    const p = e.pointerType === 'touch' ? 0.5 : (e.pressure || (e.buttons ? 0.5 : 0));
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale, p: Math.min(1, p) };
  };

  const isEraseButton = (e) => (e.buttons & 32) !== 0 || (e.pointerType === 'pen' && (e.buttons & 2) !== 0);

  const drawLive = () => {
    const g = gesture.current;
    const canvas = liveRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, scale, height);
    if (g?.stroke) drawStroke(ctx, g.stroke, inkColors().ink);
    if (g) g.frame = null;
  };

  const onPointerDown = (e) => {
    if (!editable || !scale) return;
    const g = gesture.current;
    if (e.pointerType === 'pen') {
      // The first time a pen is used on this device, fingers switch to scrolling.
      if (!penSeenBefore()) {
        try { localStorage.setItem(PEN_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
        setFingerDraws(false);
      }
      // A pen landing replaces whatever a palm started.
      if (g?.kind === 'scroll' || (g && g.pointerType === 'touch')) gesture.current = null;
    } else if (g) {
      return; // a second finger/palm while drawing
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    capture(e);

    if (e.pointerType === 'touch' && !fingerDraws) {
      const scroller = wrapRef.current.closest('.editor-scroll') ?? document.scrollingElement;
      gesture.current = { kind: 'scroll', id: e.pointerId, pointerType: 'touch', y: e.clientY, scroller };
      return;
    }
    const pt = toLogical(e);
    if (tool === 'eraser' || isEraseButton(e)) {
      gesture.current = { kind: 'erase', id: e.pointerId, pointerType: e.pointerType, before: strokes.current, changed: false };
      eraseAt(pt);
      return;
    }
    const highlighter = tool === 'highlighter';
    gesture.current = {
      kind: 'draw', id: e.pointerId, pointerType: e.pointerType,
      stroke: { t: highlighter ? 'h' : 'p', c: highlighter ? hlColor : penColor, w: size, pts: [pt] },
    };
    drawLive();
  };

  // Erase along the path from the previous sample, so a fast swipe doesn't skip strokes.
  const eraseAt = (pt) => {
    const g = gesture.current;
    const from = g.last ?? pt;
    g.last = pt;
    const steps = Math.max(1, Math.ceil(Math.hypot(pt.x - from.x, pt.y - from.y) / 4));
    const path = Array.from({ length: steps + 1 }, (_, i) => ({
      x: from.x + ((pt.x - from.x) * i) / steps, y: from.y + ((pt.y - from.y) * i) / steps,
    }));
    const keep = strokes.current.filter((st) => !path.some((p) => hits(st, p, 8)));
    if (keep.length !== strokes.current.length) {
      strokes.current = keep;
      g.changed = true;
      renderBase();
    }
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    if (g.kind === 'scroll') {
      g.scroller.scrollTop -= e.clientY - g.y;
      g.y = e.clientY;
      return;
    }
    const events = e.getCoalescedEvents?.() ?? [];
    const samples = events.length ? events : [e];
    if (g.kind === 'erase') {
      for (const s of samples) eraseAt(toLogical(s));
      return;
    }
    const { pts } = g.stroke;
    for (const s of samples) {
      const pt = toLogical(s);
      const last = pts[pts.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.75) continue;
      pts.push(pt);
    }
    if (!g.frame) g.frame = requestAnimationFrame(drawLive);
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.frame) cancelAnimationFrame(g.frame);
    if (g.kind === 'erase' && g.changed) {
      const next = strokes.current;
      strokes.current = g.before;
      commit(next);
    } else if (g.kind === 'draw') {
      const st = g.stroke;
      // Writing near the bottom makes room to keep going.
      const lowest = Math.max(...st.pts.map((p) => p.y));
      const nextHeight = lowest > height - 60 ? Math.min(MAX_H, height + GROW) : height;
      commit([...strokes.current, st], nextHeight);
      setupCanvas(liveRef.current, scale, nextHeight);
      renderBase(nextHeight);
    }
  };

  const onPointerCancel = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'erase') { strokes.current = g.before; renderBase(); }
    if (liveRef.current) setupCanvas(liveRef.current, scale, height);
  };

  // ---- resize handle ----
  const resize = useRef(null);
  const contentBottom = () => Math.max(0, ...strokes.current.flatMap((st) => st.pts.map((p) => p.y)));
  const onResizeDown = (e) => {
    e.preventDefault();
    capture(e);
    resize.current = { y: e.clientY, h: height, min: Math.max(MIN_H, Math.ceil(contentBottom() + 20)) };
  };
  const onResizeMove = (e) => {
    const r = resize.current;
    if (!r) return;
    setHeight(Math.round(Math.max(r.min, Math.min(MAX_H, r.h + (e.clientY - r.y) / scale))));
  };
  const onResizeUp = () => {
    if (!resize.current) return;
    resize.current = null;
    updateAttributes({ height });
  };

  const clear = () => {
    if (strokes.current.length) commit([]);
  };

  const swatches = tool === 'highlighter' ? HIGHLIGHT_COLORS : PEN_COLORS;
  const activeColor = tool === 'highlighter' ? hlColor : penColor;
  const pickColor = tool === 'highlighter' ? setHlColor : setPenColor;
  const cssHeight = Math.round(height * scale);
  const stop = (e) => e.preventDefault();
  // Keep the editor's focus and selection where they are (but let the paper menu open).
  const keepFocus = (e) => e.target.closest('select') || e.preventDefault();

  return (
    <NodeViewWrapper className={`drawing ${selected ? 'is-selected' : ''} ${editable ? 'is-editable' : ''}`}
      data-paper={node.attrs.paper}>
      {editable && (
        <div className="drawing-tools" contentEditable={false} onMouseDown={keepFocus}>
          <span className="drawing-group" role="radiogroup" aria-label="Tool">
            {[['pen', 'pen', 'Pen'], ['highlighter', 'marker', 'Highlighter'], ['eraser', 'eraser', 'Eraser (or hold the pen button)']].map(([t, icon, label]) => (
              <button key={t} type="button" className={`tb-btn ${tool === t ? 'is-active' : ''}`} title={label} aria-label={label}
                aria-pressed={tool === t} onClick={() => setTool(t)}>
                <Icon name={icon} size={17} />
              </button>
            ))}
          </span>
          {tool !== 'eraser' && (
            <span className="drawing-group" aria-label="Color">
              {Object.keys(swatches).map((c) => (
                <button key={c} type="button" className={`swatch ${activeColor === c ? 'is-active' : ''}`} title={c[0].toUpperCase() + c.slice(1)}
                  aria-label={`${c} ${tool}`} aria-pressed={activeColor === c} data-color={c}
                  style={{ '--swatch': swatches[c] ?? 'var(--text)' }} onClick={() => pickColor(c)} />
              ))}
            </span>
          )}
          {tool !== 'eraser' && (
            <span className="drawing-group" aria-label="Thickness">
              {SIZES.map((s) => (
                <button key={s} type="button" className={`tb-btn size-btn ${size === s ? 'is-active' : ''}`} title={['Fine', 'Medium', 'Thick'][SIZES.indexOf(s)]}
                  aria-label={`${['Fine', 'Medium', 'Thick'][SIZES.indexOf(s)]} line`} aria-pressed={size === s} onClick={() => setSize(s)}>
                  <span className="size-dot" style={{ width: s + 3, height: s + 3 }} />
                </button>
              ))}
            </span>
          )}
          <span className="drawing-group">
            <button type="button" className={`tb-btn ${fingerDraws ? 'is-active' : ''}`} aria-pressed={fingerDraws}
              title={fingerDraws ? 'Finger draws (tap so fingers scroll and only the pen draws)' : 'Only the pen draws; fingers scroll (tap to draw with a finger)'}
              aria-label="Draw with finger" onClick={() => setFingerDraws(!fingerDraws)}>
              <Icon name="hand" size={17} />
            </button>
            <select className="tb-select" value={node.attrs.paper} title="Paper" aria-label="Paper"
              onChange={(e) => updateAttributes({ paper: e.target.value })}>
              {PAPERS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </span>
          <span className="spacer" />
          <span className="drawing-group">
            <button type="button" className="btn btn-small drawing-to-text" disabled={!decoded.length}
              title="Type up the writing: handwriting to text" onClick={() => editor.storage.noteApp?.drawingToText?.(getPos())}>
              <Icon name="scan" size={14} /> To text
            </button>
            <button type="button" className="tb-btn" title="Undo stroke" aria-label="Undo stroke"
              disabled={!history.current.undo.length} onClick={() => restore('undo', 'redo')}><Icon name="undo" size={17} /></button>
            <button type="button" className="tb-btn" title="Redo stroke" aria-label="Redo stroke"
              disabled={!history.current.redo.length} onClick={() => restore('redo', 'undo')}><Icon name="redo" size={17} /></button>
            <button type="button" className="btn btn-small" onClick={clear}>Clear</button>
            <button type="button" className="tb-btn" title="Delete drawing" aria-label="Delete drawing" onClick={() => deleteNode()}>
              <Icon name="trash" size={16} />
            </button>
          </span>
        </div>
      )}
      <div ref={wrapRef} className="drawing-canvas" contentEditable={false} style={{ height: cssHeight || undefined }}>
        <canvas ref={baseRef} aria-label="Drawing" role="img" />
        <canvas ref={liveRef} className="drawing-live"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel} onContextMenu={stop} />
        {editable && !decoded.length && (
          <div className="drawing-hint">{fingerDraws ? 'Draw or write here' : 'Write here with your pen'}</div>
        )}
      </div>
      {editable && (
        <div className="drawing-resize" contentEditable={false} title="Drag to resize"
          onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} />
      )}
    </NodeViewWrapper>
  );
}

const dataAttr = (name, parse) => ({
  parseHTML: (el) => parse(el.getAttribute(`data-${name}`)),
  renderHTML: (attrs) => ({ [`data-${name}`]: attrs[name] }),
});

export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      strokes: { default: '[]', ...dataAttr('strokes', (v) => v || '[]') },
      height: { default: 400, ...dataAttr('height', (v) => Math.max(MIN_H, Math.min(MAX_H, Number(v) || 400))) },
      paper: { default: 'blank', ...dataAttr('paper', (v) => (PAPERS.includes(v) ? v : 'blank')) },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-drawing]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-drawing': '', ...HTMLAttributes }];
  },

  renderText() {
    return '[Drawing]';
  },

  addCommands() {
    return {
      insertDrawing: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawingView, {
      // Leave every pointer/mouse event inside the block to the block itself.
      stopEvent: ({ event }) => !event.type.startsWith('drag'),
    });
  },
});
