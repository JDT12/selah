import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { BANK_KINDS, BankItemDialog } from './SermonDialogs.jsx';
import { CONCLUSION_PARTS, DIVISION_PARTS, INTRO_PARTS, joinStatement, words } from '../sermon.js';
import {
  boardOf, deliveryUnits, diffLines, fitTransition, htmlBlocks, indentBlock, insertBlocks, moveBlock, moveDivision, movePart,
  numberDivision, numberable, outlineLines, removeBlock, removeDivision, removePart, setBlockOrder, subtree,
} from '../sermonBoard.js';

/**
 * The builder's Arrange board: the whole sermon as cards to drag (divisions, their parts, and each paragraph or list
 * item), with the sermon bank beside it to drag reusable material in from. Every card also has a menu for moving it
 * without dragging (phones, or a long way) and for removing it; a card can also be dragged onto Remove. Moves change
 * the builder's model (Undo brings back a removed card); nothing reaches the note until Save.
 */

const pref = (k, d) => { try { return localStorage.getItem(`noteapp.sb.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`noteapp.sb.${k}`, v); } catch { /* private window */ } };
const knownOf = (kind) => (kind === 'intro' ? INTRO_PARTS : kind === 'concl' ? CONCLUSION_PARTS : DIVISION_PARTS);
const kindLabel = Object.fromEntries(BANK_KINDS);
// Bank kinds a block from a part probably is.
const KIND_FOR_PART = { illustration: 'illustration', attention: 'illustration', visualization: 'illustration', application: 'application', action: 'application' };

const ELEMENTS = new Set(DIVISION_PARTS.map(([k]) => k));
const elClass = (key) => (ELEMENTS.has(key) ? `ab-el-${key}` : '');

/** A block's delivery number: type it, Enter or leave the box to set it (empty clears it). */
function OrderBox({ value, dup, onSet }) {
  return (
    <input className={`ab-order ${value ? 'is-set' : ''} ${dup ? 'is-dup' : ''}`} defaultValue={value ?? ''} inputMode="numeric" maxLength={3} placeholder="#"
      aria-label="Delivery order" title={dup ? 'Another block in this division has this number' : 'When this is preached in the division (1, 2, 3…)'}
      draggable={false} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.value = value ?? ''; e.currentTarget.blur(); }
      }}
      onBlur={(e) => { const v = e.target.value.replace(/\D/g, ''); if (v !== (value ?? '')) onSet(v); }} />
  );
}

/** Where a drop lands on a card: its top half is "before", its bottom half "after". */
const half = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
};

export default function SermonBoard({ model, move, undo, canUndo, savedModel, sermon, noteId, passage, reiteration, onRefreshReiteration, onDismissReiteration, setTransition, dialog }) {
  const board = useMemo(() => boardOf(model), [model]);
  const [dense, setDense] = useState(() => pref('dense', 'outline'));
  const [compare, setCompare] = useState(false);
  const [drag, setDrag] = useState(null); // what's being dragged
  const [over, setOver] = useState(null); // { id, pos } of the drop target
  const [bank, setBank] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  // The bank starts closed on a phone, where it would share a small screen with the board.
  const [tray, setTray] = useState(() => pref('tray', window.innerWidth < 800 ? 'closed' : 'open'));
  const [editing, setEditing] = useState(null); // a division uid whose transition is being rewritten
  const dragRef = useRef(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;

  useEffect(() => { setPref('dense', dense); }, [dense]);
  useEffect(() => { setPref('tray', tray); }, [tray]);
  const loadBank = () => api.sermonBank().then(setBank).catch(() => setBank([]));
  useEffect(() => { loadBank(); }, []);

  // ---------- dragging ----------
  const start = (what) => (e) => {
    e.stopPropagation();
    dragRef.current = what;
    setDrag(what);
    e.dataTransfer.effectAllowed = what.type === 'bank' ? 'copy' : 'move';
    e.dataTransfer.setData('text/plain', what.type);
  };
  const end = () => { dragRef.current = null; setDrag(null); setOver(null); };
  /** Props for a drop target: `accepts` the dragged thing, then `drop(what, pos)`. */
  const target = (id, accepts, drop, whole = false) => ({
    onDragOver: (e) => {
      const what = dragRef.current;
      if (!what || !accepts(what)) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = whole ? 'into' : half(e);
      if (over?.id !== id || over?.pos !== pos) setOver({ id, pos });
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget) && over?.id === id) setOver(null); },
    onDrop: (e) => {
      const what = dragRef.current;
      if (!what || !accepts(what)) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = whole ? 'into' : half(e);
      end();
      drop(what, pos);
    },
  });
  const dropClass = (id) => (over?.id === id ? `is-drop-${over.pos}` : '');

  // ---------- moves ----------
  const bankInto = (item, to) => {
    move((m) => insertBlocks(m, to, htmlBlocks(item.html || `<p>${item.title}</p>`)));
    if (sermon?.id) api.usedBankItem(item.id, sermon.id).then((u) => setBank((all) => all?.map((x) => (x.id === u.id ? u : x)))).catch(() => {});
  };
  const blockTo = (what, to) => {
    if (what.type === 'bank') bankInto(bank.find((x) => x.id === what.id), to);
    else move((m) => moveBlock(m, { sec: what.sec, part: what.part, index: what.index }, to));
  };
  const partTo = (what, sec, before) => move((m) => movePart(m, { sec: what.sec, part: what.part }, { sec, before }));
  const nextPart = (section, uid) => {
    const subs = section.parts.filter((p) => p.uid !== 'lead');
    const i = subs.findIndex((p) => p.uid === uid);
    return subs[i + 1]?.uid ?? null;
  };
  /** Where a missing known part would go among the section's parts. */
  const beforeForKey = (section, key) => {
    const order = knownOf(section.kind).map(([k]) => k);
    return section.parts.find((p) => p.key && order.indexOf(p.key) > order.indexOf(key))?.uid ?? null;
  };

  // Every part on the board, for "Move to…".
  const destinations = (exceptPart) => board.flatMap((s) => {
    const name = s.kind === 'division' ? `${s.n}. ${s.division.statement || 'Untitled Division'}` : s.title;
    const have = s.parts.filter((p) => !p.locked && p.uid !== exceptPart).map((p) => ({ value: `${s.id}|${p.uid}`, label: `${name} › ${p.title ?? 'Under the heading'}` }));
    const missing = knownOf(s.kind).filter(([k]) => k !== 'bridging' && !s.parts.some((p) => p.key === k)).map(([k, l]) => ({ value: `${s.id}|key:${k}`, label: `${name} › ${l} (new)` }));
    return [...have, ...missing];
  });
  const chooseDest = async (title, exceptPart) => {
    const v = await dialog.choose({ title, options: destinations(exceptPart), okLabel: 'Move here' });
    if (!v) return null;
    const [sec, part] = v.split('|');
    return { sec, part };
  };

  /** Takes a card off the board, with Undo in the toast. */
  const remove = (fn, what) => {
    move(fn);
    dialog.toast(`${what} removed`, 'info', 6000, { label: 'Undo', onClick: () => undoRef.current() });
  };
  const removeDragged = (what) => {
    if (what.type === 'division') remove((m) => removeDivision(m, what.index), `Division ${what.index + 1}`);
    else if (what.type === 'part') remove((m) => removePart(m, what), sectionPart(what)?.title ?? 'Part');
    else if (what.type === 'block') remove((m) => removeBlock(m, what), 'Block');
  };
  const sectionPart = (at) => board.find((x) => x.id === at.sec)?.parts.find((x) => x.uid === at.part);

  const saveToBank = async (start) => {
    const item = await dialog.open((close) => <BankItemDialog start={{ passage, source_note_id: noteId, ...start }} close={close} />);
    if (item) { dialog.toast('Added to the sermon bank'); loadBank(); setTray('open'); }
  };

  // ---------- menus ----------
  const divisionMenu = (s, i) => {
    const numbered = s.parts.some((p) => p.blocks.some((b) => b.order));
    return [
      i > 0 && { label: 'Move up', onClick: () => move((m) => moveDivision(m, i, i - 1)) },
      i < model.divisions.length - 1 && { label: 'Move down', onClick: () => move((m) => moveDivision(m, i, i + 2)) },
      (i > 0 || i < model.divisions.length - 1) && 'sep',
      { label: numbered ? 'Renumber in the order shown' : 'Number in the order shown', onClick: () => move((m) => numberDivision(m, s.id)) },
      numbered && { label: 'Clear the numbers', onClick: () => move((m) => numberDivision(m, s.id, true)) },
      'sep',
      { label: 'Remove the division', danger: true, onClick: () => remove((m) => removeDivision(m, i), `Division ${s.n}`) },
    ];
  };
  const partMenu = (s, p) => {
    const subs = s.parts.filter((x) => x.uid !== 'lead');
    const i = subs.findIndex((x) => x.uid === p.uid);
    return [
      p.uid !== 'lead' && i > 0 && { label: 'Move up', onClick: () => partTo({ sec: s.id, part: p.uid }, s.id, subs[i - 1].uid) },
      p.uid !== 'lead' && i < subs.length - 1 && { label: 'Move down', onClick: () => partTo({ sec: s.id, part: p.uid }, s.id, subs[i + 2]?.uid ?? null) },
      p.uid !== 'lead' && {
        label: 'Move to…',
        onClick: async () => {
          const opts = board.filter((x) => x.id !== s.id).map((x) => ({ value: x.id, label: x.kind === 'division' ? `${x.n}. ${x.division.statement || 'Untitled Division'}` : x.title }));
          const sec = await dialog.choose({ title: `Move ${p.title} to`, options: opts, okLabel: 'Move here' });
          if (sec) partTo({ sec: s.id, part: p.uid }, sec, null);
        },
      },
      p.blocks.length > 0 && { label: 'Save to the sermon bank…', onClick: () => saveToBank({ kind: KIND_FOR_PART[p.key] ?? 'other', title: p.title ?? '', html: p.blocks.map((b) => b.html).join('') }) },
      (p.uid !== 'lead' || p.blocks.length > 0) && 'sep',
      p.uid !== 'lead' && { label: `Remove ${p.title || 'this part'}`, danger: true, onClick: () => remove((m) => removePart(m, { sec: s.id, part: p.uid }), p.title || 'Part') },
      p.uid === 'lead' && p.blocks.length > 0 && { label: 'Remove what’s under the heading', danger: true, onClick: () => remove((m) => removePart(m, { sec: s.id, part: 'lead' }), 'Text under the heading') },
    ];
  };
  const blockMenu = (s, p, j) => {
    const b = p.blocks[j];
    const [, e] = subtree(p.blocks, j);
    const at = { sec: s.id, part: p.uid, index: j };
    return [
      j > 0 && { label: 'Move up', onClick: () => move((m) => moveBlock(m, at, { sec: s.id, part: p.uid, index: j - 1 })) },
      e < p.blocks.length && { label: 'Move down', onClick: () => move((m) => moveBlock(m, at, { sec: s.id, part: p.uid, index: subtree(p.blocks, e)[1] })) },
      b.kind === 'li' && { label: 'Indent', onClick: () => move((m) => indentBlock(m, at, 1)) },
      b.kind === 'li' && b.depth > 0 && { label: 'Outdent', onClick: () => move((m) => indentBlock(m, at, -1)) },
      { label: 'Move to…', onClick: async () => { const to = await chooseDest('Move to', null); if (to) move((m) => moveBlock(m, at, { ...to, index: null })); } },
      'sep',
      { label: 'Save to the sermon bank…', onClick: () => saveToBank({ kind: KIND_FOR_PART[p.key] ?? 'other', html: p.blocks.slice(j, e).map((x) => x.html).join('') }) },
      { label: e - j > 1 ? 'Remove (with its sub-points)' : 'Remove', danger: true, onClick: () => remove((m) => removeBlock(m, at), 'Block') },
    ];
  };
  const bankMenu = (item) => [
    { label: 'Insert into…', onClick: async () => { const to = await chooseDest(`Insert “${item.title || 'item'}” into`, null); if (to) bankInto(item, { ...to, index: null }); } },
    { label: 'Edit…', onClick: async () => { const u = await dialog.open((close) => <BankItemDialog item={item} close={close} />); if (u) setBank((all) => all.map((x) => (x.id === u.id ? u : x))); } },
    item.source_note_id && item.source_title != null && { label: `Open “${item.source_title || 'Untitled'}”`, onClick: () => { location.hash = `#note/${item.source_note_id}`; } },
    'sep',
    {
      label: 'Delete', danger: true,
      onClick: async () => {
        if (!(await dialog.confirm({ title: 'Delete this bank item?', message: 'Sermons it was used in keep their copy.', okLabel: 'Delete', danger: true }))) return;
        await api.removeBankItem(item.id).catch((e) => dialog.toast(e.message, 'error'));
        loadBank();
      },
    },
  ];
  const menuBtn = (items, label) => (
    <button type="button" className="icon-btn ab-menu" aria-label={label} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); dialog.contextMenu({ clientX: r.right - 4, clientY: r.bottom, preventDefault() {}, stopPropagation() {} }, items); }}>
      <Icon name="more" size={15} />
    </button>
  );

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      if (e.target.closest?.('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ---------- the bank ----------
  const shown = useMemo(() => {
    if (!bank) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const book = passage?.replace(/\s*\d.*$/, '').toLowerCase();
    return bank
      .filter((x) => !kind || x.kind === kind)
      .filter((x) => words.every((w) => `${x.title} ${x.text} ${x.topics} ${x.passage}`.toLowerCase().includes(w)))
      // Clips made for this sermon first, then material on its book.
      .map((x) => ({ x, near: sermon?.id && x.for_sermon_id === sermon.id ? -1 : book && x.passage.toLowerCase().startsWith(book) ? 0 : 1 }))
      .sort((a, b) => a.near - b.near)
      .map(({ x }) => x);
  }, [bank, q, kind, passage, sermon?.id]);

  // ---------- compare ----------
  const diff = useMemo(() => (compare ? diffLines(outlineLines(savedModel), outlineLines(model)) : null), [compare, savedModel, model]);

  const dragging = drag?.type;
  const blockLike = (w) => w.type === 'block' || w.type === 'bank';

  const blockCard = (s, p, b, j, dups) => {
    const id = `b:${s.id}:${p.uid}:${j}`;
    const isMoving = drag?.type === 'block' && drag.sec === s.id && drag.part === p.uid && j >= drag.index && j < subtree(p.blocks, drag.index)[1];
    return (
      <li key={j} className={`ab-block ab-${b.kind} ${dropClass(id)} ${isMoving ? 'is-moving' : ''}`} style={{ '--depth': b.depth }}
        draggable onDragStart={start({ type: 'block', sec: s.id, part: p.uid, index: j })} onDragEnd={end}
        onContextMenu={(e) => dialog.contextMenu(e, blockMenu(s, p, j))}
        {...target(id, blockLike, (what, pos) => blockTo(what, { sec: s.id, part: p.uid, index: pos === 'before' ? j : subtree(p.blocks, j)[1] }))}>
        <span className="ab-grip" aria-hidden="true"><Icon name="grip" size={13} /></span>
        {s.kind === 'division' && (numberable(b)
          ? <OrderBox key={`${j}:${b.order ?? ''}`} value={b.order} dup={!!b.order && dups.has(b.order)} onSet={(v) => move((m) => setBlockOrder(m, { sec: s.id, part: p.uid, index: j }, v))} />
          : <span className="ab-order-space" aria-hidden="true" />)}
        {b.kind === 'li' && <span className="ab-bullet" aria-hidden="true">{b.tag === 'ol' ? '#' : '•'}</span>}
        {dense === 'outline'
          ? <span className="ab-text">{b.text || <em className="muted">(picture or empty line)</em>}</span>
          : <div className="ab-html" dangerouslySetInnerHTML={{ __html: b.html }} />}
        {menuBtn(blockMenu(s, p, j), 'Block actions')}
      </li>
    );
  };

  const partCard = (s, p, dups) => {
    const id = `p:${s.id}:${p.uid}`;
    const n = p.blocks.reduce((t, b) => t + words(b.text), 0);
    if (p.uid === 'lead' && !p.blocks.length) return null;
    return (
      <div key={p.uid} className={`ab-part ${s.kind === 'division' ? elClass(p.key) : ''} ${p.locked ? 'is-locked' : ''} ${p.uid === 'lead' ? 'is-lead' : ''} ${dropClass(id)} ${drag?.type === 'part' && drag.part === p.uid ? 'is-moving' : ''}`}
        {...target(id, (w) => w.type === 'part' || (blockLike(w) && !p.locked), (what, pos) => {
          if (what.type === 'part') partTo(what, s.id, p.uid === 'lead' ? s.parts.find((x) => x.uid !== 'lead')?.uid ?? null : pos === 'before' ? p.uid : nextPart(s, p.uid));
          else blockTo(what, { sec: s.id, part: p.uid, index: null });
        })}>
        <div className="ab-part-head" draggable={p.uid !== 'lead' && !p.locked} onDragStart={start({ type: 'part', sec: s.id, part: p.uid })} onDragEnd={end}
          onContextMenu={(e) => dialog.contextMenu(e, partMenu(s, p))}>
          {p.uid !== 'lead' && !p.locked && <span className="ab-grip" aria-hidden="true"><Icon name="grip" size={13} /></span>}
          <strong>{p.title ?? 'Under the heading'}</strong>
          {p.locked ? <span className="muted">Edit in step 5</span> : n > 0 && <span className="muted">{n} words</span>}
          {!p.locked && menuBtn(partMenu(s, p), `${p.title ?? 'Part'} actions`)}
        </div>
        {!p.locked && (p.blocks.length
          ? <ul className="ab-blocks">{p.blocks.map((b, j) => blockCard(s, p, b, j, dups))}</ul>
          : <p className="ab-empty muted">Drop here</p>)}
      </div>
    );
  };

  const sectionCard = (s) => {
    const i = s.kind === 'division' ? s.n - 1 : -1;
    const id = `s:${s.id}`;
    // Parts the section doesn't have yet, as drop slots (always shown, so the board doesn't jump when a drag starts).
    const missing = knownOf(s.kind).filter(([k]) => k !== 'bridging' && !s.parts.some((p) => p.key === k));
    // Numbers used twice in a division (both still sort, by where they sit now).
    const seen = new Set();
    const dups = new Set();
    for (const p of s.parts) for (const b of p.blocks) if (b.order) (seen.has(b.order) ? dups : seen).add(b.order);
    return (
      <section key={s.id} className={`ab-section ab-${s.kind} ${s.kind === 'division' ? dropClass(id) : ''} ${drag?.type === 'division' && drag.index === i ? 'is-moving' : ''}`}
        {...(s.kind === 'division' ? target(id, (w) => w.type === 'division', (what, pos) => move((m) => moveDivision(m, what.index, pos === 'before' ? i : i + 1))) : {})}>
        <header className="ab-section-head" draggable={s.kind === 'division'} onDragStart={s.kind === 'division' ? start({ type: 'division', index: i }) : undefined} onDragEnd={end}
          onContextMenu={s.kind === 'division' ? (e) => dialog.contextMenu(e, divisionMenu(s, i)) : undefined}>
          {s.kind === 'division' ? (
            <>
              <span className="ab-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
              <span className="sb-div-n">{s.n}</span>
              <h4>{joinStatement(s.division.statement, s.division.verses) || 'Untitled Division'}</h4>
              {menuBtn(divisionMenu(s, i), `Division ${s.n} actions`)}
            </>
          ) : <h4 className="ab-fixed">{s.title}</h4>}
        </header>
        <div className="ab-parts">
          {s.parts.map((p) => partCard(s, p, dups))}
          {missing.length > 0 && <div className="ab-slots">{missing.map(([k, l]) => (
            <div key={k} className={`ab-slot ${dropClass(`k:${s.id}:${k}`)}`} title={`Drop a card here to start ${l}`}
              {...target(`k:${s.id}:${k}`, (w) => w.type === 'part' || blockLike(w), (what) => {
                if (what.type === 'part') partTo(what, s.id, beforeForKey(s, k));
                else blockTo(what, { sec: s.id, part: `key:${k}`, index: null });
              }, true)}>
              <Icon name="plus" size={12} /> {l}
            </div>
          ))}</div>}
        </div>
        {s.kind === 'division' && s.division.transition.trim() && (
          <div className={`ab-transition ${s.stale ? 'is-stale' : ''}`}>
            {editing === s.id ? (
              <input className="input" autoFocus defaultValue={s.division.transition} aria-label="Transition"
                onBlur={(e) => { setTransition(s.id, e.target.value); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
            ) : (
              <>
                {s.stale && <Icon name="alert" size={14} />}
                <span><strong>Transition:</strong> {s.division.transition}</span>
              </>
            )}
            {s.stale && editing !== s.id && (
              <span className="ab-stale-actions">
                <span className="ab-stale-note">{i === model.divisions.length - 1 ? 'This is the last division now.' : 'It was written to lead into a different division.'}</span>
                <button type="button" className="link-btn" onClick={() => setEditing(s.id)}>Rewrite</button>
                <button type="button" className="link-btn" onClick={() => move((m) => fitTransition(m, s.id))}>It still fits</button>
              </span>
            )}
          </div>
        )}
      </section>
    );
  };

  /** A division as it will be preached: its numbered blocks in order, each marked with the element it came from. */
  const deliveryCard = (s) => {
    const units = deliveryUnits(s.division).filter((u) => u.blocks.some((b) => b.text || /<img\b/i.test(b.html)));
    const numbered = units.some((u) => u.order);
    return (
      <section key={s.id} className="ab-section ab-division ab-delivery">
        <header className="ab-section-head">
          <span className="sb-div-n">{s.n}</span>
          <h4>{joinStatement(s.division.statement, s.division.verses) || 'Untitled Division'}</h4>
          {!numbered && units.length > 0 && <button type="button" className="link-btn" onClick={() => move((m) => numberDivision(m, s.id))}>Number in the order shown</button>}
          {menuBtn(divisionMenu(s, s.n - 1), `Division ${s.n} actions`)}
        </header>
        {units.length ? (
          <ol className="ab-dl">
            {units.map((u) => {
              const first = u.blocks[0];
              const subs = u.blocks.length - 1;
              return (
                <li key={u.seq} className={`ab-dl-item ${elClass(u.key)} ${u.order ? '' : 'is-unnumbered'}`}>
                  <span className="ab-dl-n" title={u.order ? undefined : 'Not numbered: comes after the numbered blocks'}>{u.order ?? '–'}</span>
                  <span className="ab-dl-chip">{u.key === 'lead' ? 'Under the heading' : u.title}</span>
                  <span className="ab-dl-text">{first.text || <em className="muted">(picture)</em>}{subs > 0 && <span className="muted"> · {subs} sub-point{subs === 1 ? '' : 's'}</span>}</span>
                </li>
              );
            })}
          </ol>
        ) : <p className="ab-empty muted">Nothing under this division yet.</p>}
        {!numbered && units.length > 0 && <p className="ab-dl-note muted">Not numbered, so it’s preached as grouped.</p>}
      </section>
    );
  };

  return (
    <div className={`ab ${tray === 'open' ? 'has-tray' : ''}`}>
      <div className="ab-main">
        <div className="ab-toolbar">
          <button type="button" className="btn btn-small" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)"><Icon name="undo" size={14} /> Undo</button>
          <div className="segmented ab-seg" role="group" aria-label="Show">
            <button type="button" className={dense === 'outline' ? 'is-active' : ''} aria-pressed={dense === 'outline'} onClick={() => setDense('outline')}>Outline</button>
            <button type="button" className={dense === 'full' ? 'is-active' : ''} aria-pressed={dense === 'full'} onClick={() => setDense('full')}>Full Text</button>
            <button type="button" className={dense === 'delivery' ? 'is-active' : ''} aria-pressed={dense === 'delivery'} onClick={() => setDense('delivery')} title="Each division in the order it will be preached">Delivery Order</button>
          </div>
          <button type="button" className={`btn btn-small ${compare ? 'is-on' : ''}`} aria-pressed={compare} onClick={() => setCompare(!compare)}><Icon name="layout" size={14} /> Compare</button>
          {dragging && dragging !== 'bank' && (
            <div className={`ab-trash ${dropClass('trash')}`} {...target('trash', (w) => w.type !== 'bank' && !(w.type === 'part' && w.part === 'lead'), removeDragged, true)}>
              <Icon name="trash" size={14} /> Drop here to remove
            </div>
          )}
          <span className="ab-hint muted">{dense === 'delivery'
            ? 'Preaching mode and Word follow this order. Set the numbers in Outline or Full Text.'
            : 'Drag cards to rearrange (or onto Remove). Number a division’s blocks (#) for the order you’ll preach them.'}</span>
          <button type="button" className={`btn btn-small ab-tray-btn ${tray === 'open' ? 'is-on' : ''}`} aria-pressed={tray === 'open'} onClick={() => setTray(tray === 'open' ? 'closed' : 'open')}><Icon name="book" size={14} /> Bank</button>
        </div>
        {reiteration && (
          <p className="sb-warn ab-reit"><Icon name="alert" size={14} /> The conclusion’s Reiteration may list the divisions in the old order.
            <button type="button" className="link-btn" onClick={onRefreshReiteration}>List them again</button>
            <button type="button" className="link-btn" onClick={onDismissReiteration}>Leave it</button>
          </p>
        )}
        {compare ? (
          <div className="ab-compare">
            {[['Last saved', diff.a, 'is-removed'], ['Now', diff.b, 'is-added']].map(([label, lines, cls]) => (
              <div key={label} className="ab-compare-col">
                <h4>{label}</h4>
                <ol>{lines.map((l, k) => <li key={k} className={`lvl-${Math.min(l.level, 4)} ${l.changed ? cls : ''}`}>{l.text}</li>)}</ol>
              </div>
            ))}
          </div>
        ) : dense === 'delivery' ? (
          <div className="ab-sections">
            <p className="ab-dl-intro muted">The Introduction and Conclusion are preached as written. Blocks without a number come after the numbered ones.</p>
            {board.filter((s) => s.kind === 'division').map(deliveryCard)}
          </div>
        ) : (
          <div className="ab-sections">{board.map(sectionCard)}</div>
        )}
      </div>
      {tray === 'open' && (
        <aside className="ab-tray" aria-label="Sermon bank">
          <div className="ab-tray-head">
            <strong>Sermon Bank</strong>
            <button type="button" className="btn btn-small" onClick={() => saveToBank({ kind: 'illustration' })}><Icon name="plus" size={13} /> New</button>
          </div>
          <div className="ab-tray-filters">
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the bank" aria-label="Search the bank" />
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="">All kinds</option>
              {BANK_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          {bank == null ? <p className="muted">Loading…</p> : !bank.length ? (
            <p className="muted ab-tray-empty">Keep illustrations, quotes and applications here to use in any sermon. Add one with New, from a card’s ⋯ menu, or by selecting text in any note and right-clicking it.</p>
          ) : !shown.length ? <p className="muted">Nothing matches.</p> : (
            <ul className="ab-bank">
              {shown.map((x) => (
                <li key={x.id} className={`ab-bank-item ${sermon?.id && x.for_sermon_id === sermon.id ? 'is-for' : ''}`} draggable onDragStart={start({ type: 'bank', id: x.id })} onDragEnd={end}
                  onContextMenu={(e) => dialog.contextMenu(e, bankMenu(x))}>
                  <div className="ab-bank-head">
                    <span className={`ab-kind ab-kind-${x.kind}`}>{kindLabel[x.kind]}</span>
                    <strong>{x.title || x.text.slice(0, 60)}</strong>
                    {menuBtn(bankMenu(x), 'Bank item actions')}
                  </div>
                  {sermon?.id && x.for_sermon_id === sermon.id && <p className="ab-bank-for">Clipped for this sermon</p>}
                  <p className="ab-bank-text">{x.text}</p>
                  <p className="ab-bank-meta muted">
                    {x.source_url && <><a href={x.source_url} {...(x.source_url.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })} title={x.source_url.startsWith('#') ? 'Open the book here' : x.source_url}>{x.source_page || 'Web page'}</a>{' · '}</>}
                    {[x.passage, x.topics, x.uses.length ? `Used in ${x.uses.length === 1 ? `“${x.uses[0].title}”` : `${x.uses.length} sermons`}` : 'Not used yet'].filter(Boolean).join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
