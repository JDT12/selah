import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onLive } from '../live.js';
import Icon from '../components/Icon.jsx';
import { api } from '../api.js';
import { useDialog } from '../components/Dialogs.jsx';
import { recordVoiceMemo } from '../components/QuickCapture.jsx';
import { tagColor } from '../tagColors.js';
import { TagToFileDialog } from '../components/TagDialogs.jsx';

const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hr ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

/**
 * Everything captured (quick capture, the Edge clipper, the share menu, voice memos) waits here to be filed.
 * 10.1: filing is tagging. A tagged note moves to My notes (the server does it the moment it has a tag).
 * Keys: ↑ ↓ move, Enter opens, 1–6 tags with a tag from the bar, T types any tag, Delete moves to the Trash.
 */
export default function InboxPage({ tree, onOpenNote, onChanged, onCapture, onSettings, onMenu }) {
  const dialog = useDialog();
  const [inbox, setInbox] = useState(null);
  const [notes, setNotes] = useState(null);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const ib = await api.inbox();
      setInbox(ib);
      setNotes(await api.listNotes({ notebook: ib.notebookId, sort: 'created' }));
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  }, [dialog]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener('noteapp:notes-changed', load);
    // Clips from the Edge clipper (and changes from other devices) show up without leaving the page.
    const off = onLive(load);
    return () => {
      window.removeEventListener('noteapp:notes-changed', load);
      off();
    };
  }, [load]);

  // The tags on the bar, for the selected note: tags named in its title or text first, then your most used.
  const list = notes ?? [];
  const current = list[Math.min(active, list.length - 1)];
  const targets = useMemo(() => {
    const text = `${current?.title ?? ''} ${current?.snippet ?? ''}`.toLowerCase();
    const named = tree.tags.filter((t) => t.name.length > 2 && text.includes(t.name.toLowerCase()));
    const used = [...tree.tags].sort((x, y) => (y.count ?? 0) - (x.count ?? 0));
    return [...new Set([...named, ...used])].slice(0, 6);
  }, [tree, current]);

  const after = () => { load(); onChanged(); };
  const tagNames = (note) => (note.tag_ids ? String(note.tag_ids).split(',') : []).map((id) => tree.tags.find((t) => t.id === Number(id))?.name).filter(Boolean);
  const file = async (note, name) => {
    const before = tagNames(note);
    try {
      await api.updateNote(note.id, { tags: [...before, name] });
      dialog.toast(`Tagged ${name}, now in My notes`, 'info', 5000, {
        label: 'Undo', onClick: () => api.updateNote(note.id, { tags: before, notebook_id: inbox.notebookId }).then(after),
      });
      after();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const fileTo = async (note) => {
    const name = await dialog.open((close) => <TagToFileDialog title={note.title} tags={tree.tags} close={close} />);
    if (name) file(note, name);
  };
  const trash = async (note) => {
    await api.trashNote(note.id);
    dialog.toast('Moved to Trash', 'info', 5000, { label: 'Undo', onClick: () => api.restoreNote(note.id).then(after) });
    after();
  };
  const voice = async () => { if (await recordVoiceMemo(dialog)) after(); };

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey || !current) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); setActive((i) => Math.min(i + 1, list.length - 1)); }
    else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (k === 'Enter') { e.preventDefault(); onOpenNote(current.id); }
    else if (/^[1-6]$/.test(k) && targets[Number(k) - 1]) { e.preventDefault(); file(current, targets[Number(k) - 1].name); }
    else if (k === 't' || k === 'T' || k === 'f' || k === 'F') { e.preventDefault(); fileTo(current); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); trash(current); }
  };
  useEffect(() => {
    listRef.current?.querySelector('.inbox-item.is-active')?.focus({ preventScroll: false });
  }, [active, notes]);

  const tagName = (id) => tree.tags.find((t) => t.id === Number(id));

  return (
    <div className="page inbox-page" onKeyDown={onKey}>
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Inbox</h1>
          <p className="muted">{!notes ? 'Loading…' : list.length ? `${list.length} waiting for a tag` : 'All filed'}</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={voice}><Icon name="mic" size={15} /> Voice memo</button>
          <button className="btn btn-primary" onClick={onCapture} title="Quick capture (Alt+N)"><Icon name="bolt" size={15} /> Quick capture</button>
        </div>
      </header>

      {list.length > 0 && (
        <div className="inbox-bar" role="toolbar" aria-label="Tag the selected item">
          <span className="muted">Tag to file</span>
          {targets.map((t, i) => (
            <button key={t.id} type="button" className="inbox-target" onClick={() => current && file(current, t.name)}
              title={`Tag the selected item ${t.name} and move it to My notes (${i + 1})`}>
              <kbd>{i + 1}</kbd> <span className={`tag-dot ${t.color ? '' : 'is-none'}`} style={{ '--tag': tagColor(t.color) }} />{t.name}
            </button>
          ))}
          <button type="button" className="inbox-target" onClick={() => current && fileTo(current)} title="Type any tag (T)">
            <kbd>T</kbd> {targets.length ? 'Other…' : 'Add a tag…'}
          </button>
        </div>
      )}

      {notes && !list.length && (
        <section className="inbox-empty">
          <div className="inbox-empty-icon"><Icon name="inbox" size={34} strokeWidth={1.4} /></div>
          <h2>Nothing waiting</h2>
          <p className="muted">Things you capture land here until you tag them. Then they move to My notes.</p>
          <ul className="inbox-ways">
            <li><button type="button" className="link-btn" onClick={onCapture}>Quick capture</button> from anywhere in Selah with <kbd>Alt</kbd>+<kbd>N</kbd></li>
            <li><button type="button" className="link-btn" onClick={voice}>Record a voice memo</button></li>
            <li>Clip web pages with the <button type="button" className="link-btn" onClick={onSettings}>Edge clipper</button></li>
            <li>On your Android phone, choose <strong>Selah</strong> in any app’s share menu (install Selah first)</li>
          </ul>
        </section>
      )}

      {list.length > 0 && (
        <ul className="inbox-list" ref={listRef}>
          {list.map((n, i) => (
            <li key={n.id} className={`inbox-item ${n.id === current?.id ? 'is-active' : ''}`} tabIndex={n.id === current?.id ? 0 : -1}
              onFocus={() => setActive(i)} onClick={() => setActive(i)} onDoubleClick={() => onOpenNote(n.id)}>
              <div className="inbox-main">
                <button type="button" className="inbox-title" onClick={() => onOpenNote(n.id)}>{n.title || 'Untitled'}</button>
                {n.snippet && <p className="inbox-snippet">{n.snippet}</p>}
                <div className="inbox-meta">
                  <span>{ago(n.created_at)}</span>
                  {n.attachments > 0 && <span><Icon name="paperclip" size={12} /> {n.attachments}</span>}
                  {(n.tag_ids ? String(n.tag_ids).split(',') : []).map(tagName).filter(Boolean).map((t) => (
                    <span key={t.id} className="inbox-tag"><span style={{ color: tagColor(t.color) ?? undefined }}><Icon name="tag" size={12} /></span> {t.name}</span>
                  ))}
                </div>
              </div>
              <div className="inbox-actions">
                <button type="button" className="btn btn-small" onClick={(e) => { e.stopPropagation(); fileTo(n); }}><Icon name="tag" size={14} /> Tag…</button>
                <button type="button" className="icon-btn" onClick={(e) => { e.stopPropagation(); trash(n); }} aria-label="Move to Trash" title="Move to Trash (Delete)">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <p className="inbox-help muted">
          <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>1</kbd>–<kbd>{Math.max(1, targets.length)}</kbd> tag and file · <kbd>T</kbd> other tag · <kbd>Delete</kbd> trash
        </p>
      )}
    </div>
  );
}
