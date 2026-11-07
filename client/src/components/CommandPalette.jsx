import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { parse } from '../../../shared/scripture.js';
import { SIDEBAR_PAGES } from '../sidebarPages.js';
import { DESK_TABS, STUDY_KINDS } from '../studyPlans.js';
import { tagColor } from '../tagColors.js';

const RECENT_KEY = 'noteapp.recentNotes';

/** Notes opened lately, newest first (for the palette before you type). */
export function rememberNote(id, title) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((n) => n.id !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ id, title }, ...list].slice(0, 8)));
  } catch { /* storage unavailable */ }
}
export function recentNotes() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

/** Every word of the query appears in the text; text starting with the query ranks first. */
function score(text, words, q) {
  const t = text.toLowerCase();
  if (!words.every((w) => t.includes(w))) return 0;
  return t.startsWith(q) ? 3 : t.split(/\s+/).some((x) => x.startsWith(words[0])) ? 2 : 1;
}

/**
 * Ctrl+K: jump to any page (hidden ones too), note, notebook, shelf or tag, or run an action.
 * `go` holds what each kind of result does; see Workspace in App.jsx.
 */
export default function CommandPalette({ tree, go, close }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ q: '', notes: [] });
  const [active, setActive] = useState(0);
  const [studies, setStudies] = useState([]);
  useEffect(() => { api.studies().then(setStudies).catch(() => {}); }, []);
  const listRef = useRef(null);
  const q = query.trim().toLowerCase();
  const words = useMemo(() => q.split(/\s+/).filter(Boolean), [q]);

  // Notes come from the server's full-text search, a moment after you stop typing.
  useEffect(() => {
    if (q.length < 2) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.listNotes({ q, rank: 1, limit: 8 }).catch(() => []).then((notes) => live && setFound({ q, notes }));
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const groups = useMemo(() => {
    const actions = [
      { label: 'Quick capture to Inbox', icon: 'bolt', hint: 'Alt+N', run: go.capture },
      { label: 'New note', icon: 'plus', run: go.newNote },
      { label: 'New note from template…', icon: 'copy', run: go.newFromTemplate },
      { label: 'New task…', icon: 'todo', run: go.newTask },
      { label: 'New event…', icon: 'calendar', run: go.newEvent },
      { label: 'New sermon…', icon: 'lectern', run: go.newSermon },
      { label: 'New study…', icon: 'bible', run: go.newStudy },
      { label: 'New course…', icon: 'present', run: go.newCourse },
      { label: 'Record a voice memo', icon: 'mic', run: go.voiceMemo },
      { label: 'Settings', icon: 'settings', run: go.settings },
      { label: 'Customize sidebar…', icon: 'layout', run: go.customizeSidebar },
      { label: 'Theme: light', icon: 'sun', run: () => go.theme('light') },
      { label: 'Theme: dark', icon: 'sun', run: () => go.theme('dark') },
      { label: 'Theme: match the system', icon: 'sun', run: () => go.theme('system') },
    ];
    const pages = SIDEBAR_PAGES.filter((p) => p.key !== 'shortcuts' && p.key !== 'utility' && (p.key !== 'wordpress' || tree.wordpress))
      .map((p) => ({
        label: p.key === 'wordpress' ? tree.wordpress : p.label, icon: p.icon, run: () => go.page(p.key),
      }))
      .concat(DESK_TABS.map((d) => ({ label: `Desk: ${d.label}`, icon: d.icon, run: () => go.page(`desk:${d.key}`) })))
      .concat([{ label: 'Plan: Attendance', icon: 'users', run: () => go.page('attendance') }]);
    const notebooks = []; // 10.1: notebooks aren't shown; tags sort your notes
    const tags = tree.tags.map((t) => ({
      label: `#${t.name}`, icon: 'tag', color: tagColor(t.color), hint: `${t.count}`, run: () => go.view({ type: 'tag', id: t.id }),
    }));
    const notebookName = (id) => (id === tree.inbox?.id ? 'Inbox' : undefined);
    const studyItem = (st) => st.data?.course
      ? { label: st.title, icon: 'present', hint: st.status === 'archived' ? 'Archived course' : 'Course', run: () => go.course(st.id) }
      : { label: st.title, icon: STUDY_KINDS[st.kind]?.icon ?? 'book', hint: `${st.status === 'archived' ? 'Archived: ' : ''}${STUDY_KINDS[st.kind]?.label ?? 'Study'}`, run: () => go.study(st.id) };
    const studyItems = studies.filter((st) => st.status !== 'archived').map(studyItem)
      .concat(studies.filter((st) => st.status === 'archived').map(studyItem));

    if (!q) {
      const recent = recentNotes().map((n) => ({ label: n.title || 'Untitled', icon: 'note', run: () => go.note(n.id) }));
      return [
        { title: 'Recent notes', items: recent },
        { title: 'Actions', items: actions.slice(0, 5) },
        { title: 'Pages', items: pages },
      ];
    }
    const pick = (list, max) => list
      .map((it) => ({ ...it, s: score(it.label.replace(/^#/, ''), words, q) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s - a.s)
      .slice(0, max);
    // Notes matched by their text (not their title) rank below a page or action whose name matches.
    const notes = found.q === q ? found.notes.map((n) => ({
      label: n.title || 'Untitled', icon: 'note', hint: notebookName(n.notebook_id), run: () => go.note(n.id),
      s: score(n.title || '', words, q) || 0.5,
    })) : [];
    // A typed reference opens the passage.
    const refs = /\d/.test(q) ? parse(query.trim()).refs : [];
    const passage = refs.length ? [{ label: `Read ${refs.map((r) => r.label).join('; ')}`, icon: 'bible', hint: 'Scripture', run: () => go.scripture(query.trim()), s: 0.9 }] : [];
    // The group with the best match comes first, so Enter picks it; ties keep this order.
    const best = (items) => Math.max(0, ...items.map((it) => it.s));
    return [
      { title: 'Pages', items: pick(pages, 4) },
      { title: 'Scripture', items: passage },
      { title: 'Notes', items: notes },
      { title: 'Desk', items: pick(studyItems, 4) },
      { title: 'Notebooks', items: pick(notebooks, 5) },
      { title: 'Tags', items: pick(tags, 5) },
      { title: 'Actions', items: pick(actions, 4) },
    ].sort((a, b) => best(b.items) - best(a.items));
  }, [q, query, words, found, tree, go, studies]);

  const flat = groups.flatMap((g) => g.items);
  useEffect(() => { setActive(0); }, [q, found]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item) => {
    if (!item) return;
    close();
    item.run();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); run(flat[active]); }
  };

  let index = -1;
  return (
    <div className="palette">
      <div className="palette-search">
        <Icon name="search" size={18} />
        <input className="palette-input" autoFocus placeholder="Search notes and pages, or type a command…"
          aria-label="Search or jump to" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-results" ref={listRef} role="listbox">
        {groups.filter((g) => g.items.length).map((g) => (
          <div key={g.title} className="palette-group">
            <div className="palette-group-title">{g.title}</div>
            {g.items.map((it) => {
              index += 1;
              const i = index;
              return (
                <button key={`${g.title}${i}`} type="button" role="option" aria-selected={i === active}
                  className={`palette-item ${i === active ? 'is-active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)} onClick={() => run(it)}>
                  <span className="palette-icon" style={it.color ? { color: it.color } : undefined}><Icon name={it.icon} size={16} /></span>
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <p className="palette-empty">{q.length >= 2 && found.q !== q ? 'Searching…' : `Nothing matches “${query.trim()}”.`}</p>
        )}
      </div>
      <div className="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
        <span><kbd>Enter</kbd> to open</span>
      </div>
    </div>
  );
}
