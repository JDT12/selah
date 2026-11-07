import { useEffect, useLayoutEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { uid } from '../sermon.js';

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'];
const alpha = (n) => String.fromCharCode(96 + ((n - 1) % 26) + 1);
/** 1. / A. / I. / a. / i. / (1) by level, the way the note numbers it; a section heading starts again at 1. */
function labels(lines) {
  const counts = [];
  return lines.map((l) => {
    if (l.heading) {
      counts.length = 0;
      return '';
    }
    counts.length = l.level + 1;
    counts[l.level] = (counts[l.level] ?? 0) + 1;
    const n = counts[l.level];
    return [`${n}.`, `${alpha(n).toUpperCase()}.`, `${(ROMAN[n - 1] ?? String(n)).toUpperCase()}.`, `${alpha(n)}.`, `${ROMAN[n - 1] ?? n}.`, `(${n})`][l.level % 6];
  });
}
/** A line and the lines under it. */
const blockEnd = (lines, i) => {
  let j = i + 1;
  while (j < lines.length && lines[j].level > lines[i].level) j += 1;
  return j;
};

/** One line: a text area that grows with its text. */
function Line({ line, label, refFn, onKeyDown, onChange, onRemove, onToggleHeading, placeholder, extra }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [line.text]);
  return (
    <li className={`ol-line ${line.heading ? 'is-heading' : ''}`} style={{ '--level': line.level }}>
      {!line.heading && <span className="ol-n" aria-hidden="true">{label}</span>}
      <textarea ref={(el) => { ref.current = el; refFn(el); }} className="ol-input" rows={1} value={line.text} placeholder={line.heading ? 'Section heading' : placeholder}
        onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))} onKeyDown={onKeyDown} aria-label={line.heading ? 'Section heading' : `Line ${label}`} />
      {extra}
      {onToggleHeading && (
        <button type="button" className="icon-btn ol-remove ol-kind" onClick={onToggleHeading} aria-label={line.heading ? 'Make this a point' : 'Make this a section heading'} title={line.heading ? 'Make this a point' : 'Make this a section heading'}>
          {line.heading ? '1.' : 'H2'}
        </button>
      )}
      <button type="button" className="icon-btn ol-remove" onClick={onRemove} aria-label="Remove this line" title="Remove this line"><Icon name="x" size={13} /></button>
    </li>
  );
}

/**
 * An outline typed line by line: Enter adds a line, Tab and Shift+Tab move it in and out a level, Alt+↑/↓ move it
 * (with the lines under it), Backspace on an empty line removes it. It becomes the note's nested numbered list.
 */
export default function OutlineEditor({ lines, onChange, placeholder, addLabel = 'Add a point', extra, flat = false, headings = false, focusRef }) {
  const inputs = useRef(new Map());
  const pending = useRef(null); // { id, at: number | 'end' }
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const el = inputs.current.get(p.id);
    if (!el) return;
    el.focus();
    const at = p.at === 'end' ? el.value.length : p.at;
    el.setSelectionRange(at, at);
  });
  const focus = (id, at = 'end') => { pending.current = { id, at }; };
  // Lets the builder add a line from outside (a verse clicked in the passage) and type into it.
  if (focusRef) focusRef.current = (text) => {
    const blank = lines.length === 1 && !lines[0].text.trim();
    const line = { id: uid(), level: 0, text };
    onChange(blank ? [line] : [...lines, line]);
    focus(line.id);
  };
  const nums = labels(lines);

  const key = (i) => (e) => {
    const el = e.target;
    const line = lines[i];
    const at = el.selectionStart;
    const none = el.selectionStart === el.selectionEnd;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const made = { id: uid(), level: line.heading ? 0 : line.level, text: el.value.slice(el.selectionEnd).trimStart() };
      const next = [...lines];
      next.splice(i, 1, { ...line, text: el.value.slice(0, el.selectionStart).trimEnd() }, made);
      onChange(next);
      focus(made.id, 0);
    } else if (e.key === ' ' && headings && !line.heading && none && at === 2 && el.value.startsWith('##')) {
      // "## " at the start of a line makes it a section heading, as in a note.
      e.preventDefault();
      onChange(lines.map((l, j) => (j === i ? { ...l, heading: true, level: 0, text: l.text.slice(2) } : l)));
      focus(line.id, 0);
    } else if (e.key === 'Tab' && !flat) {
      e.preventDefault();
      if (line.heading) return;
      const max = i === 0 || lines[i - 1].heading ? 0 : lines[i - 1].level + 1;
      const level = e.shiftKey ? Math.max(0, line.level - 1) : Math.min(max, line.level + 1, 5);
      if (level === line.level) return;
      // The lines under it move with it.
      const end = blockEnd(lines, i);
      const d = level - line.level;
      onChange(lines.map((l, j) => (j >= i && j < end ? { ...l, level: l.level + d } : l)));
      focus(line.id, at);
    } else if (e.key === 'Backspace' && none && at === 0) {
      if (line.level > 0 && !flat) {
        e.preventDefault();
        onChange(lines.map((l, j) => (j === i ? { ...l, level: l.level - 1 } : l)));
        focus(line.id, 0);
      } else if (i > 0) {
        e.preventDefault();
        const prev = lines[i - 1];
        const joined = prev.text && line.text ? `${prev.text} ${line.text}` : prev.text + line.text;
        onChange(lines.filter((_, j) => j !== i).map((l) => (l.id === prev.id ? { ...l, text: joined } : l)));
        focus(prev.id, prev.text.length + (prev.text && line.text ? 1 : 0));
      }
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      if (i === 0) return;
      // Above the line (or block) before it at the same level or higher.
      let j = i - 1;
      while (j > 0 && lines[j].level > line.level) j -= 1;
      const end = blockEnd(lines, i);
      onChange([...lines.slice(0, j), ...lines.slice(i, end), ...lines.slice(j, i), ...lines.slice(end)]);
      focus(line.id, at);
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      const end = blockEnd(lines, i);
      if (end >= lines.length) return;
      const after = blockEnd(lines, end);
      onChange([...lines.slice(0, i), ...lines.slice(end, after), ...lines.slice(i, end), ...lines.slice(after)]);
      focus(line.id, at);
    } else if (e.key === 'ArrowUp' && none && at === 0 && i > 0) {
      e.preventDefault();
      const prev = inputs.current.get(lines[i - 1].id);
      prev?.focus();
      prev?.setSelectionRange(prev.value.length, prev.value.length);
    } else if (e.key === 'ArrowDown' && none && at === el.value.length && i < lines.length - 1) {
      e.preventDefault();
      const next = inputs.current.get(lines[i + 1].id);
      next?.focus();
      next?.setSelectionRange(0, 0);
    }
  };
  const remove = (i) => {
    const next = lines.filter((_, j) => j !== i);
    onChange(next.length ? next : [{ id: uid(), level: 0, text: '' }]);
  };
  const add = (heading = false) => {
    const line = { id: uid(), level: 0, text: '', ...(heading ? { heading: true } : {}) };
    // An empty outline's blank first line becomes the heading.
    const blank = heading && lines.length === 1 && !lines[0].text.trim();
    onChange(blank ? [line, { ...lines[0], level: 0 }] : [...lines, line]);
    focus(line.id);
  };
  const toggleHeading = (i) => {
    const next = lines.map((l, j) => (j === i ? { ...l, heading: !l.heading, level: 0 } : l));
    // The points under a new heading start again at the top level.
    if (!lines[i].heading) for (let j = i + 1; j < next.length && next[j].level > 0 && !next[j].heading; j += 1) next[j] = { ...next[j], level: next[j].level - 1 };
    onChange(next);
    focus(lines[i].id);
  };

  return (
    <div className="ol">
      <ol className="ol-lines">
        {lines.map((l, i) => (
          <Line key={l.id} line={l} label={nums[i]} placeholder={i === 0 ? placeholder : ''}
            refFn={(el) => { if (el) inputs.current.set(l.id, el); else inputs.current.delete(l.id); }}
            onKeyDown={key(i)} onChange={(text) => onChange(lines.map((x) => (x.id === l.id ? { ...x, text } : x)))} onRemove={() => remove(i)}
            onToggleHeading={headings ? () => toggleHeading(i) : undefined}
            extra={extra?.(l, i)} />
        ))}
      </ol>
      <div className="ol-foot">
        <button type="button" className="link-btn" onClick={() => add()}><Icon name="plus" size={13} /> {addLabel}</button>
        {headings && <button type="button" className="link-btn" onClick={() => add(true)}><Icon name="plus" size={13} /> Add a section heading</button>}
        <span className="muted">{flat ? 'Enter adds a line · Alt+↑/↓ moves one' : `Enter adds a line · Tab and Shift+Tab move it in and out · Alt+↑/↓ moves it${headings ? ' · ## and a space makes a heading' : ''}`}</span>
      </div>
    </div>
  );
}
