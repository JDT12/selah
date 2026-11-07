import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState } from '@tiptap/react';
import Icon from '../components/Icon.jsx';
import { useDialog } from '../components/Dialogs.jsx';
import { CELL_COLORS, HIGHLIGHT_COLORS, TEXT_COLORS } from './extensions.js';
import { useFocusMode } from '../focus.js';

function Btn({ icon, title, active, disabled, onClick }) {
  return (
    <button type="button" className={`tb-btn ${active ? 'is-active' : ''}`} title={title} aria-label={title}
      aria-pressed={active ?? undefined} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} size={17} />
    </button>
  );
}

const Sep = () => <span className="tb-sep" />;

const title = (c) => c[0].toUpperCase() + c.slice(1);

/**
 * A toolbar menu: [open, setOpen, ref (the button's wrapper), menuRef]. It closes on a click outside both, Escape, or
 * when anything scrolls (the toolbar scrolls sideways, and the menu doesn't move with it).
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t) => ref.current?.contains(t) || menuRef.current?.contains(t);
    const off = (e) => !inside(e.target) && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    const scroll = (e) => !menuRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [open]);
  return [open, setOpen, ref, menuRef];
}

/**
 * A menu under its button, drawn on the page itself: the toolbar's row scrolls sideways, which would clip a menu
 * inside it. Kept on screen at the right edge.
 */
function FloatingMenu({ anchor, menuRef, className, children, ...rest }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const w = menuRef.current?.offsetWidth ?? 0;
    if (a) setPos({ top: a.bottom + 4, left: Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) });
  }, [anchor, menuRef]);
  return createPortal(
    <div ref={menuRef} className={`menu tb-float ${className}`} style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}
      onMouseDown={(e) => e.preventDefault()} {...rest}>
      {children}
    </div>,
    document.body,
  );
}

function readLast(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

/**
 * Highlighter or text color: the button uses the last color picked, the arrow beside it opens the colors.
 * `current` is the color under the cursor ('' for none); `onPick(color)` applies one, `onPick(null)` takes it off.
 */
function ColorPicker({ kind, icon, label, colors, current, onPick }) {
  const [open, setOpen, ref, menuRef] = useMenu();
  const store = `noteapp.last.${kind}`;
  const [last, setLast] = useState(() => readLast(store, colors[0]));
  const pick = (color) => {
    setOpen(false);
    if (color) {
      setLast(color);
      try { localStorage.setItem(store, color); } catch { /* remembered for this visit only */ }
    }
    onPick(color);
  };
  return (
    <div className={`menu-wrap color-picker color-${kind}`} ref={ref}>
      <button type="button" className={`tb-btn color-main ${current ? 'is-active' : ''}`} title={`${label}: ${title(last)}`}
        aria-label={`${label} ${title(last)}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(last)}>
        <Icon name={icon} size={17} />
        <span className="color-bar" data-swatch={last} />
      </button>
      <button type="button" className={`tb-btn color-more ${open ? 'is-active' : ''}`} title={`${label} colors`} aria-label={`${label} colors`}
        aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Icon name="caret" size={13} />
      </button>
      {open && (
        <FloatingMenu anchor={ref} menuRef={menuRef} className={`color-menu color-${kind}`} role="menu">
          <div className="color-swatches">
            {colors.map((col) => (
              <button key={col} type="button" role="menuitemradio" aria-checked={current === col} title={title(col)} aria-label={title(col)}
                className={`color-swatch ${current === col ? 'is-on' : ''}`} data-swatch={col} onClick={() => pick(col)}>
                {kind === 'text' && 'A'}
              </button>
            ))}
          </div>
          <button type="button" className="menu-item color-none" role="menuitem" onClick={() => pick(null)}>
            <Icon name="x" size={14} /> {kind === 'text' ? 'Default color' : 'No highlight'}
          </button>
        </FloatingMenu>
      )}
    </div>
  );
}

/** Table button with a hover grid for picking the new table's size. */
function TablePicker({ active, onInsert }) {
  const [open, setOpen, ref, menuRef] = useMenu();
  const [size, setSize] = useState({ rows: 3, cols: 3 });
  const N = 8;
  return (
    <div className="menu-wrap" ref={ref}>
      <Btn icon="table" title="Insert table" active={active || open} onClick={() => setOpen(!open)} />
      {open && (
        <FloatingMenu anchor={ref} menuRef={menuRef} className="table-picker">
          <div className="table-picker-grid" style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }}>
            {Array.from({ length: N * N }, (_, i) => {
              const r = Math.floor(i / N) + 1;
              const col = (i % N) + 1;
              return (
                <button key={i} type="button" aria-label={`${r} by ${col} table`}
                  className={r <= size.rows && col <= size.cols ? 'is-on' : ''}
                  onMouseEnter={() => setSize({ rows: r, cols: col })}
                  onFocus={() => setSize({ rows: r, cols: col })}
                  onClick={() => { setOpen(false); onInsert(r, col); }} />
              );
            })}
          </div>
          <div className="table-picker-size">{size.rows} × {size.cols}</div>
        </FloatingMenu>
      )}
    </div>
  );
}

export default function Toolbar({ editor, onPickFile, onTakePhoto, onRecord, onInsertTemplate, onCite }) {
  const dialog = useDialog();
  // A mouse wheel scrolls the formatting row sideways when it doesn't fit (a touchpad or Shift+wheel already does).
  const row = useRef(null);
  useEffect(() => {
    const el = row.current;
    if (!el) return undefined;
    const wheel = (e) => {
      if (e.deltaX || !e.deltaY || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1'
        : e.isActive('heading', { level: 2 }) ? 'h2'
          : e.isActive('heading', { level: 3 }) ? 'h3'
            : e.isActive('heading', { level: 4 }) ? 'h4' : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight') ? (e.getAttributes('highlight').color || 'yellow') : '',
      textColor: e.isActive('textColor') ? e.getAttributes('textColor').color || '' : '',
      inList: e.isActive('listItem') || e.isActive('taskItem'),
      link: e.isActive('link'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      details: e.isActive('details'),
      callout: e.isActive('callout'),
      table: e.isActive('table'),
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
      cellColor: e.getAttributes('tableCell').backgroundColor ?? e.getAttributes('tableHeader').backgroundColor ?? '',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      selected: !e.state.selection.empty,
    }),
  });
  const quiet = useFocusMode(); // focus mode: out of sight until text is selected (or you point at it)
  const c = () => editor.chain().focus();

  const setBlock = (v) => {
    if (v === 'p') c().setParagraph().run();
    else c().setHeading({ level: Number(v[1]) }).run();
  };

  const editLink = async () => {
    const prev = editor.getAttributes('link').href ?? '';
    const url = await dialog.prompt({
      title: prev ? 'Edit link' : 'Insert link', label: 'URL', value: prev, placeholder: 'https://…', okLabel: 'Apply',
    });
    if (url === null) return;
    c().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className={`toolbar ${quiet ? 'is-quiet' : ''} ${quiet && s.selected ? 'is-shown' : ''}`} role="toolbar" aria-label="Formatting">
      <div className="toolbar-row" ref={row}>
        <Btn icon="undo" title="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()} />
        <Btn icon="redo" title="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo} onClick={() => c().redo().run()} />
        <Sep />
        <select className="tb-select" value={s.block} onChange={(e) => setBlock(e.target.value)} title="Text style">
          <option value="p">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
        </select>
        <Sep />
        <Btn icon="bold" title="Bold (Ctrl+B)" active={s.bold} onClick={() => c().toggleBold().run()} />
        <Btn icon="italic" title="Italic (Ctrl+I)" active={s.italic} onClick={() => c().toggleItalic().run()} />
        <Btn icon="underline" title="Underline (Ctrl+U)" active={s.underline} onClick={() => c().toggleUnderline().run()} />
        <Btn icon="strike" title="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()} />
        <ColorPicker kind="highlight" icon="highlight" label="Highlight" colors={HIGHLIGHT_COLORS} current={s.highlight}
          onPick={(col) => (col === null ? c().unsetHighlight().run()
            : s.highlight === col ? c().unsetHighlight().run()
              : c().setHighlight({ color: col === 'yellow' ? null : col }).run())} />
        <ColorPicker kind="text" icon="textColor" label="Text color" colors={TEXT_COLORS} current={s.textColor}
          onPick={(col) => (col === null || s.textColor === col ? c().unsetTextColor().run() : c().setTextColor(col).run())} />
        <Btn icon="code" title="Inline code (Ctrl+E)" active={s.code} onClick={() => c().toggleCode().run()} />
        <Btn icon="link" title="Link" active={s.link} onClick={editLink} />
        <Sep />
        <Btn icon="list" title="Bulleted list" active={s.bulletList} onClick={() => c().toggleBulletList().run()} />
        <Btn icon="listOrdered" title="Numbered list" active={s.orderedList} onClick={() => c().toggleOrderedList().run()} />
        <Btn icon="todo" title="To-do list" active={s.taskList} onClick={() => c().toggleTaskList().run()} />
        <Sep />
        <Btn icon="quote" title="Quote" active={s.blockquote} onClick={() => c().toggleBlockquote().run()} />
        <Btn icon="codeBlock" title="Code block" active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()} />
        <Btn icon="details" title={s.details ? 'Remove collapsible section' : 'Collapsible section'} active={s.details}
          onClick={() => (s.details ? c().unsetDetails().run() : c().setDetails().run())} />
        <Btn icon="callout" title="Callout" active={s.callout} onClick={() => c().toggleCallout().run()} />
        <TablePicker active={s.table} onInsert={(rows, cols) => c().insertTable({ rows, cols, withHeaderRow: true }).run()} />
        <Btn icon="hr" title="Divider" onClick={() => c().setHorizontalRule().run()} />
        <Btn icon="paperclip" title="Attach image or file" onClick={onPickFile} />
        <Sep />
        <Btn icon="pen" title="Drawing (pen or finger)" onClick={() => c().insertDrawing().run()} />
        <Btn icon="camera" title="Take photo" onClick={onTakePhoto} />
        <Btn icon="mic" title="Record audio" onClick={onRecord} />
        {onInsertTemplate && <Btn icon="copy" title="Insert template" onClick={onInsertTemplate} />}
        {onCite && <Btn icon="cite" title="Cite a source (Ctrl+Alt+F)" onClick={onCite} />}
      </div>
      {s.inList && (
        <div className="toolbar-row list-tools">
          <span className="tb-label">List item</span>
          <Btn icon="outdent" title="Outdent (Shift+Tab)" onClick={() => c().outdentListItem().run()} />
          <Btn icon="indent" title="Indent (Tab)" onClick={() => c().indentListItem().run()} />
          <Btn icon="arrowUp" title="Move up (Alt+↑)" onClick={() => c().moveListItemUp().run()} />
          <Btn icon="arrowDown" title="Move down (Alt+↓)" onClick={() => c().moveListItemDown().run()} />
        </div>
      )}
      {s.table && (
        <div className="toolbar-row table-tools">
          <span className="tb-group">
            <span className="tb-label">Row</span>
            <button type="button" className="btn btn-small" title="Insert row above" onClick={() => c().addRowBefore().run()}>+ Above</button>
            <button type="button" className="btn btn-small" title="Insert row below" onClick={() => c().addRowAfter().run()}>+ Below</button>
            <button type="button" className="btn btn-small" title="Delete row" onClick={() => c().deleteRow().run()}>Delete</button>
          </span>
          <span className="tb-group">
            <span className="tb-label">Column</span>
            <button type="button" className="btn btn-small" title="Insert column to the left" onClick={() => c().addColumnBefore().run()}>+ Left</button>
            <button type="button" className="btn btn-small" title="Insert column to the right" onClick={() => c().addColumnAfter().run()}>+ Right</button>
            <button type="button" className="btn btn-small" title="Delete column" onClick={() => c().deleteColumn().run()}>Delete</button>
          </span>
          <span className="tb-group">
            <span className="tb-label">Header</span>
            <button type="button" className="btn btn-small" onClick={() => c().toggleHeaderRow().run()}>Row</button>
            <button type="button" className="btn btn-small" onClick={() => c().toggleHeaderColumn().run()}>Column</button>
          </span>
          <span className="tb-group">
            <span className="tb-label">Cells</span>
            <button type="button" className="btn btn-small" disabled={!s.canMerge} onClick={() => c().mergeCells().run()}>Merge</button>
            <button type="button" className="btn btn-small" disabled={!s.canSplit} onClick={() => c().splitCell().run()}>Split</button>
            <select className="tb-select cell-color" value={s.cellColor} title="Cell color"
              onChange={(e) => c().setCellAttribute('backgroundColor', e.target.value || null).run()}>
              <option value="">No color</option>
              {CELL_COLORS.map((col) => <option key={col} value={col}>{col[0].toUpperCase() + col.slice(1)}</option>)}
            </select>
          </span>
          <button type="button" className="btn btn-small btn-danger-text" onClick={() => c().deleteTable().run()}>Delete table</button>
        </div>
      )}
    </div>
  );
}
