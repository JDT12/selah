import { useEffect, useState } from 'react';
import { device } from '../device.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { pageLinkProps, pageTabItems } from '../openTab.js';
import { api } from '../api.js';
import { useStoredState } from '../useStoredState.js';
import { tagColor } from '../tagColors.js';
import { formatShortDate } from '../time.js';
import { byPerson, KIND_ICON, KIND_LABEL, useSharing } from '../sharing.js';
import { openContacts } from './SharingDialogs.jsx';

/**
 * Shared with me (8.0): what contacts share, grouped by person; a dot marks what's new or changed since I looked.
 * Opening one shows it on its own page (SharedPage). Only in the cloud.
 */
function SharedWithMe({ words, hit, folded, setFolded, onClose }) {
  const dialog = useDialog();
  const s = useSharing();
  if (!s?.enabled) return null;
  const people = byPerson(s.sharedWithMe.filter((x) => !words.length || hit(`${x.title} ${x.ownerName}`)));
  const asking = s.contacts.filter((c) => c.status === 'incoming').length;
  if (words.length && !people.length) return null;
  const open = (id) => { onClose(); window.dispatchEvent(new CustomEvent('noteapp:open-shared', { detail: { id } })); };
  const shown = !folded.shared;
  return (
    <section className="rp-group rp-shared">
      <div className="rp-group-head">
        <button type="button" className="rp-fold" onClick={() => setFolded({ ...folded, shared: shown })} aria-expanded={shown} aria-label={`${shown ? 'Fold' : 'Unfold'} Shared with me`}>
          <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
        <span className="rp-group-name is-plain">Shared with me</span>
        <button type="button" className="link-btn rp-contacts" onClick={() => openContacts(dialog)} title="People you share with">
          Contacts{asking > 0 && <span className="rp-ask">{asking}</span>}
        </button>
      </div>
      {shown && !people.length && (
        <p className="rp-empty">{s.on ? 'Nothing yet. When a contact shares a note, notebook or project with you, it shows here.' : 'Sharing is turned off for your Selah.'}</p>
      )}
      {shown && people.map((p) => (
        <div key={p.owner} className="rp-person">
          <div className="rp-person-name"><span className="share-avatar is-small" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>{p.name}</div>
          {p.shares.map((x) => (
            <button key={x.id} type="button" className="rp-row rp-shared-row" onClick={() => open(x.id)} title={`${KIND_LABEL[x.kind]} from ${p.name}`}>
              <Icon name={KIND_ICON[x.kind]} size={15} />
              <span className="rp-name">{x.title || 'Untitled'}</span>
              {x.replies > 0 && <span className="rp-count" title="New replies"><Icon name="comment" size={11} /> {x.replies}</span>}
              {x.unseen && <span className={`rp-new ${x.isNew ? 'is-new' : ''}`} title={x.isNew ? 'New' : 'Updated'} />}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

const KIND_BADGE = { pdf: 'PDF', image: 'IMG', audio: 'AUDIO', video: 'VIDEO', document: 'DOC', other: 'FILE' };
function fileBadge(a) {
  const ext = /\.([a-z0-9]{2,4})$/i.exec(a.filename)?.[1];
  return (ext ?? KIND_BADGE[a.kind] ?? 'FILE').toUpperCase();
}

/**
 * Utility (7.1): your templates, recent attachments and tags, and the Trash, a click from every page. Each part
 * has a link to its whole page. 10.1: at the foot of the rail, with what's shared with you (it was on the Shelf).
 */
export function UtilityPanel({ tree, tagActions, onView, onSection, onOpenNote, onNewFromTemplate, onClose }) {
  const dialog = useDialog();
  const [folded, setFolded] = useStoredState('noteapp.shelfFolded', {});
  const [templates, setTemplates] = useState(null);
  const [files, setFiles] = useState(null);
  useEffect(() => {
    api.listNotes({ templates: 1, sort: 'updated' }).then((l) => setTemplates(l.slice(0, 3))).catch(() => setTemplates([]));
    api.attachments({ sort: 'newest', limit: 3 }).then((r) => setFiles(r.items ?? [])).catch(() => setFiles([]));
  }, []);
  const tags = [...tree.tags].sort((x, y) => (y.count ?? 0) - (x.count ?? 0));
  const shownTags = tags.slice(0, 8);

  return (
    <aside className="rail-panel" aria-label="Utility">
      <div className="rp-head">
        <h2>Utility</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Utility" title="Close (Esc)"><Icon name="x" size={16} /></button>
      </div>
      <div className="rp-scroll">
        {device.full && (<>
        <div className="rp-section-head">
          <h3>Templates</h3>
          <button type="button" className="link-btn" {...pageLinkProps({ view: 'templates' }, () => onView({ type: 'templates' }))} onContextMenu={(e) => dialog.contextMenu(e, pageTabItems({ view: 'templates' }))}>See all{tree.templates ? ` ${tree.templates}` : ''}</button>
        </div>
        {templates?.map((n) => (
          <button key={n.id} type="button" className="rp-row" onClick={() => onOpenNote(n.id)}>
            <Icon name="copy" size={15} /><span className="rp-name">{n.title || 'Untitled template'}</span>
          </button>
        ))}
        {templates && !templates.length && <p className="rp-empty">No templates yet. Any note can become one (its ⋯ menu).</p>}
        </>)}
        <button type="button" className="rp-row rp-link" onClick={() => { onClose(); onNewFromTemplate(); }}>
          <Icon name="plus" size={15} /><span className="rp-name">New note from template…</span>
        </button>

        <div className="rp-section-head">
          <h3>Attachments</h3>
          <button type="button" className="link-btn" {...pageLinkProps({ section: 'attachments' }, () => onSection('attachments'))} onContextMenu={(e) => dialog.contextMenu(e, pageTabItems({ section: 'attachments' }))}>See all{tree.attachments ? ` ${tree.attachments}` : ''}</button>
        </div>
        {files?.map((f) => (
          <button key={f.id} type="button" className="rp-row" onClick={() => (f.noteId ? onOpenNote(f.noteId) : onSection('attachments'))} title={f.noteTitle ? `In “${f.noteTitle}”` : f.filename}>
            <span className={`rp-file is-${f.kind}`}>{fileBadge(f)}</span>
            <span className="rp-name">{f.filename}</span>
            <span className="rp-count">{f.createdAt ? formatShortDate(new Date(f.createdAt).toISOString().slice(0, 10)) : ''}</span>
          </button>
        ))}
        {files && !files.length && <p className="rp-empty">Files you add to notes show up here.</p>}

        {device.full && (
        <button type="button" className="rp-row rp-link" {...pageLinkProps({ section: 'media' }, () => onSection('media'))} onContextMenu={(e) => dialog.contextMenu(e, pageTabItems({ section: 'media' }))}>
          <Icon name="image" size={15} /><span className="rp-name">Media: church brand, slide pictures and art</span>
        </button>
        )}

        <div className="rp-section-head">
          <h3>Tags</h3>
          <button type="button" className="link-btn" {...pageLinkProps({ section: 'tags' }, () => onSection('tags'))} onContextMenu={(e) => dialog.contextMenu(e, pageTabItems({ section: 'tags' }))}>Manage</button>
        </div>
        <div className="rp-tags">
          {shownTags.map((t) => (
            <button key={t.id} type="button" className="rp-tag" style={{ '--tc': tagColor(t.color) ?? 'var(--muted)' }}
              onClick={() => onView({ type: 'tag', id: t.id })} onContextMenu={(e) => dialog.contextMenu(e, tagActions.menuItems(t, { open: () => onView({ type: 'tag', id: t.id }) }))}>
              {t.name} <span>{t.count}</span>
            </button>
          ))}
          {tags.length > shownTags.length && <button type="button" className="rp-tag is-more" onClick={() => onSection('tags')}>+ {tags.length - shownTags.length} more</button>}
          {!tags.length && <p className="rp-empty">No tags yet. Type # in a note to add one.</p>}
        </div>
        <SharedWithMe words={[]} hit={() => true} folded={folded} setFolded={setFolded} onClose={onClose} />
      </div>
      {/* 13.0: on a phone too, to bring back something deleted by mistake. */}
      <div className="rp-foot is-trash">
        <button type="button" className="rp-row" {...pageLinkProps({ view: 'trash' }, () => onView({ type: 'trash' }))} onContextMenu={(e) => dialog.contextMenu(e, pageTabItems({ view: 'trash' }))}>
          <Icon name="trash" size={15} /><span className="rp-name">Trash</span><span className="rp-count">{tree.trash || ''}</span>
        </button>
      </div>
    </aside>
  );
}

