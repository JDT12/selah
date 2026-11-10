import { useEffect, useState } from 'react';
import { device } from '../device.js';
import Icon from './Icon.jsx';
import { Menu, useDialog } from './Dialogs.jsx';
import { api, formatDate } from '../api.js';
import { PLACEHOLDER_HELP } from './TemplatePicker.jsx';
import { tagColor } from '../tagColors.js';

/** Up to three of a note's tags (colored ones first), and how many more there are. */
function NoteTags({ ids, tags }) {
  if (!ids) return null;
  const list = String(ids).split(',').map((id) => tags.find((t) => t.id === Number(id))).filter(Boolean)
    .sort((a, b) => (!!b.color - !!a.color) || a.name.localeCompare(b.name));
  if (!list.length) return null;
  return (
    <span className="note-card-tags">
      {list.slice(0, 3).map((t) => (
        <span key={t.id} className="note-card-tag">
          <span className={`tag-dot ${t.color ? '' : 'is-none'}`} style={{ '--tag': tagColor(t.color) }} />{t.name}
        </span>
      ))}
      {list.length > 3 && <span className="note-card-tag">+{list.length - 3}</span>}
    </span>
  );
}

/** Where a trashed note came from: its notebook, the notebook deleted with it, or neither. */
function trashGroup(n, notebookName) {
  if (n.notebook_id && notebookName(n.notebook_id)) return { key: `nb${n.notebook_id}`, label: notebookName(n.notebook_id) };
  let was = null;
  try { was = JSON.parse(n.trash_notebook ?? 'null'); } catch { /* none */ }
  if (was?.name) return { key: `was:${was.name}`, label: was.name, deleted: true };
  return n.is_template ? { key: 'templates', label: 'Templates' } : { key: 'none', label: 'No notebook' };
}

const DAY = 86_400_000;

/**
 * 10.1: My notes is sorted by tags. A row of them under the search box: All, notes with files, then your tags (the
 * most used first, a few at a time until you ask for the rest). Picking one shows its notes; picking it again goes back.
 */
const TAG_BAR_SHOWN = 10;
function TagBar({ tags, view, onView }) {
  const [all, setAll] = useState(false);
  const sorted = [...tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
  const active = view.type === 'tag' ? sorted.find((t) => t.id === view.id) : null;
  let shown = all ? sorted : sorted.slice(0, TAG_BAR_SHOWN);
  if (active && !shown.includes(active)) shown = [...shown, active];
  const chip = (key, label, on, pick, extra) => (
    <button key={key} type="button" className={`tag-bar-chip ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={pick} {...extra}>{label}</button>
  );
  return (
    <div className="tag-bar" role="toolbar" aria-label="Sort by tag">
      {chip('all', 'All', view.type === 'all', () => onView({ type: 'all' }))}
      {chip('files', <><Icon name="paperclip" size={12} /> Files</>, view.type === 'files', () => onView(view.type === 'files' ? { type: 'all' } : { type: 'files' }))}
      {shown.map((t) => chip(t.id, (
        <><span className={`tag-dot ${t.color ? '' : 'is-none'}`} style={{ '--tag': tagColor(t.color) }} />{t.name}<span className="tag-bar-count">{t.count}</span></>
      ), active?.id === t.id, () => onView(active?.id === t.id ? { type: 'all' } : { type: 'tag', id: t.id })))}
      {sorted.length > TAG_BAR_SHOWN && (
        <button type="button" className="tag-bar-more" onClick={() => setAll(!all)}>{all ? 'Fewer' : `+ ${sorted.length - TAG_BAR_SHOWN} more`}</button>
      )}
      {!tags.length && <span className="tag-bar-hint">Add a tag to a note (type # in it) to sort your notes.</span>}
    </div>
  );
}

/** 9.0: what made a note, by its builder's method (the list's `builder`): its chip's label and color. */
const BUILDERS = {
  ggw: ['Bible Study', 'study'], background: ['Background', 'study'], word: ['Word Study', 'study'],
  hblt: ['Lesson', 'lesson'], points: ['Lesson', 'lesson'], lesson: ['Lesson', 'lesson'],
  mcdill: ['Sermon', 'sermon'],
  book: ['Chapter', 'writing'], blog: ['Blog Post', 'writing'], paper: ['Paper', 'writing'], devotional: ['Devotional', 'writing'],
};

/** The Trash's own line: how long notes stay (a setting), and restoring from a backup. */
function TrashHint({ days, setDays, onRestoreFromBackup }) {
  const dialog = useDialog();
  const change = async (v) => {
    const next = Number(v);
    if (next && !await dialog.confirm({
      title: `Delete notes after ${next} days?`,
      message: `Notes that have been in the Trash longer than ${next} days, and their attachments, will be deleted forever, starting now.`,
      okLabel: `After ${next} days`, danger: true,
    })) return;
    try { setDays((await api.setTrashDays(next)).days); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  return (
    <div className="list-hint trash-hint">
      <label>
        <span>Keep deleted notes</span>
        <select value={days ?? 0} onChange={(e) => change(e.target.value)} disabled={days == null} aria-label="Keep deleted notes">
          <option value={0}>until I empty the Trash</option>
          <option value={30}>for 30 days</option>
          <option value={60}>for 60 days</option>
          <option value={90}>for 90 days</option>
        </select>
      </label>
      <button type="button" className="link-btn" onClick={onRestoreFromBackup}><Icon name="restore" size={13} /> Restore from a backup…</button>
    </div>
  );
}

export default function NoteList({
  title, notes, selectedId, onSelect, query, onQuery, sort, onSort, onNewNote, isTrash, onEmptyTrash,
  notebookName, showNotebook, onMenu, noteMenu, isTemplates, onNewFromTemplate, onUseTemplate, tags = [],
  checked, selectMode, onSelectMode, onSelectAll, onClearChecked, bulk, bulkItems, onRestoreGroup, onRestoreFromBackup, onOpenInTab, tagBar,
}) {
  const selecting = selectMode || checked.size > 0;
  const dialog = useDialog();
  const [trashDays, setTrashDays] = useState(null);
  useEffect(() => { if (isTrash) api.trashSettings().then((r) => setTrashDays(r.days)).catch(() => setTrashDays(0)); }, [isTrash]);
  // The Trash in groups, by the notebook each note came from (in the order they first appear).
  const groups = [];
  if (isTrash) {
    const byKey = new Map();
    for (const n of notes) {
      const g = trashGroup(n, notebookName);
      if (!byKey.has(g.key)) { byKey.set(g.key, { ...g, notes: [] }); groups.push(byKey.get(g.key)); }
      byKey.get(g.key).notes.push(n);
    }
  }
  return (
    <section className="note-list">
      <header className="list-header">
        <div className="list-title-row">
          <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
          <h1 className="list-title" title={title}>{title}</h1>
          <button className={`icon-btn ${selectMode ? 'is-on' : ''}`} onClick={onSelectMode} aria-pressed={selectMode}
            title={selectMode ? 'Stop selecting' : 'Select notes (or Ctrl/⌘-click, Shift-click)'} aria-label="Select notes">
            <Icon name="check" />
          </button>
          {!isTrash && !isTemplates && (
            <button className="icon-btn" onClick={onNewFromTemplate} title="New note from template" aria-label="New note from template">
              <Icon name="copy" />
            </button>
          )}
          {!isTrash && (
            <button className="icon-btn" onClick={onNewNote} title={isTemplates ? 'New template' : 'New note'}
              aria-label={isTemplates ? 'New template' : 'New note'}><Icon name="plus" /></button>
          )}
        </div>
        <div className="search-box">
          <Icon name="search" size={15} className="muted" />
          <input type="search" placeholder={`Search ${title.toLowerCase()}…`} value={query}
            onChange={(e) => onQuery(e.target.value)} />
        </div>
        <div className="list-sub">
          <span>{notes.length} note{notes.length === 1 ? '' : 's'}</span>
          {isTrash ? (
            device.full && notes.length > 0 && <button className="btn btn-small btn-danger-text" onClick={onEmptyTrash}>Empty trash</button>
          ) : (
            <label className="sort-select">
              <Icon name="sort" size={13} />
              <select value={sort} onChange={(e) => onSort(e.target.value)}>
                <option value="updated">Date updated</option>
                <option value="created">Date created</option>
                <option value="title">Title</option>
              </select>
            </label>
          )}
        </div>
        {tagBar && <TagBar {...tagBar} />}
      </header>

      {selecting && (
        <div className="list-bulk" role="toolbar" aria-label="Selected notes">
          <span className="list-bulk-count">{checked.size} selected</span>
          <span className="spacer" />
          {checked.size > 0 && isTrash && (
            <>
              <button className="btn btn-small" onClick={bulk.restore}>Restore</button>
              {device.full && (<button className="btn btn-small btn-danger-text" onClick={bulk.deleteForever}>Delete…</button>)}
            </>
          )}
          {checked.size > 0 && !isTrash && !isTemplates && (
            <>
              <button className="icon-btn" onClick={bulk.tag} title="Add or remove a tag" aria-label="Add or remove a tag"><Icon name="tag" size={16} /></button>
            </>
          )}
          {checked.size > 0 && !isTrash && (
            <button className="icon-btn is-danger" onClick={bulk.trash} title="Move to Trash" aria-label="Move to Trash"><Icon name="trash" size={16} /></button>
          )}
          <Menu align="right" trigger={({ toggle }) => (
            <button className="icon-btn" onClick={toggle} aria-label="More actions for the selected notes" title="More"><Icon name="more" size={16} /></button>
          )} items={[
            checked.size < notes.length && { label: 'Select all', onClick: onSelectAll },
            'sep',
            ...(checked.size > 0 ? bulkItems() : []),
          ]} />
          <button className="icon-btn" onClick={onClearChecked} aria-label="Clear selection" title="Clear selection (Esc)"><Icon name="x" size={16} /></button>
        </div>
      )}

      <div className="list-scroll">
        {isTemplates && (
          <p className="list-hint">
            Start new notes from these. Use <strong>Make into template</strong> on any note to add one. {PLACEHOLDER_HELP}
          </p>
        )}
        {isTrash && <TrashHint days={trashDays} setDays={setTrashDays} onRestoreFromBackup={onRestoreFromBackup} />}
        {notes.length === 0 && (
          <div className="list-empty">
            {query ? 'No matching notes.' : isTrash ? 'Trash is empty.' : isTemplates ? 'No templates yet.' : 'No notes yet.'}
          </div>
        )}
        {(isTrash ? groups : [{ key: 'all', notes }]).map((g) => (
          <div key={g.key} className="note-group">
            {isTrash && (
              <div className="note-group-head">
                <Icon name={g.deleted ? 'trash' : g.key === 'templates' ? 'copy' : 'notebook'} size={13} />
                <span className="note-group-name" title={g.deleted ? 'From a notebook that’s gone. Restoring puts these in My notes, tagged with its name.' : undefined}>
                  {g.label}{g.deleted && <span className="muted"> · back to My notes</span>}
                </span>
                <span className="muted">{g.notes.length}</span>
                <button type="button" className="btn btn-small" onClick={() => onRestoreGroup(g.notes.map((n) => n.id))}
                  title={g.deleted ? `Restore these to My notes, tagged “${g.label}”` : `Restore these to ${g.label}`}>
                  Restore {g.notes.length === 1 ? '' : 'all'}
                </button>
              </div>
            )}
            {g.notes.map((n) => (
          <article
            key={n.id}
            className={`note-card ${n.id === selectedId && !selecting ? 'is-active' : ''} ${checked.has(n.id) ? 'is-checked' : ''}`}
            onClick={(e) => onSelect(n.id, e)}
            onAuxClick={(e) => { if (e.button === 1 && !isTrash) { e.preventDefault(); onOpenInTab?.(n); } }}
            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            aria-selected={selecting ? checked.has(n.id) : undefined}
            draggable={!isTrash}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-note', String(n.id)); e.dataTransfer.effectAllowed = 'move'; }}
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(n.id)}
            onContextMenu={(e) => dialog.contextMenu(e, noteMenu(n))}
          >
            <div className="note-card-title">
              {selecting && <span className={`note-card-check ${checked.has(n.id) ? 'is-on' : ''}`} aria-hidden="true"><Icon name="check" size={12} /></span>}
              {!!n.pinned && <span className="note-card-flag" title="Pinned to the top of the list"><Icon name="pin" size={13} className="pin" /></span>}
              {!!n.dash_pinned && <span className="note-card-flag" title="Pinned to Home"><Icon name="home" size={13} className="pin" /></span>}
              {!!n.read_only && <span className="note-card-flag" title="Opens read-only"><Icon name="lock" size={13} className="pin" /></span>}
              <span>{n.title || 'Untitled'}</span>
            </div>
            <div className="note-card-snippet">{n.snippet || <span className="muted">No additional text</span>}</div>
            <NoteTags ids={n.tag_ids} tags={tags} />
            <div className="note-card-meta">
              {BUILDERS[n.builder] && <span className={`note-card-kind is-${BUILDERS[n.builder][1]}`}>{BUILDERS[n.builder][0]}</span>}
              <span>{isTrash ? `Deleted ${formatDate(n.deleted_at)}` : formatDate(n.updated_at)}</span>
              {isTrash && trashDays > 0 && (
                <span className="note-card-expires" title="When it’s deleted forever (the Trash’s setting)">
                  {Math.max(0, Math.ceil((n.deleted_at + trashDays * DAY - Date.now()) / DAY))}d left
                </span>
              )}
              {!isTrash && showNotebook && notebookName(n.notebook_id) && <span className="note-card-nb">{notebookName(n.notebook_id)}</span>}
              {n.attachments > 0 && <span className="note-card-att"><Icon name="paperclip" size={12} />{n.attachments}</span>}
              {isTemplates && (
                <button type="button" className="btn btn-small note-card-use" onClick={(e) => { e.stopPropagation(); onUseTemplate(n); }}>
                  Use template
                </button>
              )}
            </div>
          </article>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
