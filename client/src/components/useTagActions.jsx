import { openExport } from './ExportDialog.jsx';
import { useDialog } from './Dialogs.jsx';
import { TagColorDialog, TagNotesDialog } from './TagDialogs.jsx';
import { api } from '../api.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Tag actions shared by the sidebar and the Tags page. `tags` is the full list (with counts) used to find name
 * clashes and merge targets; `notebookActions` supplies shortcuts. Each action reports errors as a toast and
 * then calls onRefresh. onDeleted(id) runs when a tag goes away (deleted or merged into another).
 */
export function useTagActions({ tags, notebookActions, onRefresh, onDeleted }) {
  const dialog = useDialog();

  const run = async (fn) => {
    try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); }
    onRefresh();
  };
  const byName = (name, exceptId) => tags.find((t) => t.id !== exceptId && t.name.toLowerCase() === name.trim().toLowerCase());

  const rename = (tag) => run(async () => {
    const name = await dialog.prompt({ title: 'Rename tag', value: tag.name, okLabel: 'Rename' });
    if (!name || name.trim() === tag.name) return;
    const clash = byName(name, tag.id);
    if (clash) {
      const ok = await dialog.confirm({
        title: `Merge into “${clash.name}”?`,
        message: `There's already a tag called “${clash.name}”. Merging moves the notes tagged “${tag.name}” to it and removes “${tag.name}”.`,
        okLabel: 'Merge',
      });
      if (!ok) return;
    }
    await api.updateTag(tag.id, { name, merge: !!clash });
    if (clash) onDeleted?.(tag.id);
    dialog.toast(clash ? `Merged into ${clash.name}` : 'Tag renamed');
  });

  const setColor = (list) => run(async () => {
    const one = list.length === 1 ? list[0] : null;
    const color = await dialog.open((close) => (
      <TagColorDialog title={one ? `Color for “${one.name}”` : `Color for ${list.length} tags`} value={one?.color} close={close} />
    ));
    if (color === null || color === undefined) return;
    for (const t of list) await api.updateTag(t.id, { color: color || null });
  });

  /** Merge the tags into one of the others (asked). */
  const merge = (list) => run(async () => {
    const ids = new Set(list.map((t) => t.id));
    const others = tags.filter((t) => !ids.has(t.id));
    if (!others.length) throw new Error('There is no other tag to merge into');
    const one = list.length === 1 ? list[0] : null;
    const into = await dialog.choose({
      title: one ? `Merge “${one.name}” into…` : `Merge ${list.length} tags into…`,
      message: `Their notes get the tag you choose, then ${one ? `“${one.name}” is` : 'they are'} removed.`,
      options: others.map((t) => ({ value: t.id, label: `${t.name} (${t.count})` })),
      okLabel: 'Merge',
    });
    if (!into) return;
    for (const t of list) {
      await api.mergeTag(t.id, into);
      onDeleted?.(t.id);
    }
    dialog.toast(`Merged into ${others.find((t) => t.id === into)?.name}`);
  });

  const remove = (list) => run(async () => {
    const one = list.length === 1 ? list[0] : null;
    const notes = list.reduce((n, t) => n + (t.count ?? 0) + (t.templates ?? 0) + (t.trashed ?? 0), 0);
    const ok = await dialog.confirm({
      title: one ? `Delete tag “${one.name}”?` : `Delete ${list.length} tags?`,
      message: `${notes ? `${one ? 'It' : 'They'} will be removed from ${plural(notes, 'note')}. ` : ''}The notes themselves are kept.`,
      okLabel: one ? 'Delete tag' : 'Delete tags', danger: true,
    });
    if (!ok) return;
    for (const t of list) {
      await api.deleteTag(t.id);
      onDeleted?.(t.id);
    }
  });

  /** Add or remove the tag on many notes at once; `tag` may be { name } for a new one. */
  const tagNotes = (tag) => run(async () => {
    const r = await dialog.open((close) => <TagNotesDialog tag={tag} close={close} />);
    if (r) dialog.toast(`#${tag.name}: added to ${plural(r.added, 'note')}, removed from ${r.removed}`);
  });

  const create = async () => {
    const name = await dialog.prompt({ title: 'New tag', label: 'Tag name', okLabel: 'Next: choose notes' });
    if (!name?.trim()) return;
    const existing = byName(name);
    // A tag exists only while a note has it, so a new tag starts by choosing its notes.
    tagNotes(existing ?? { name: name.trim() });
  };

  /** Keep the tags' notes out of the Scripture index (and Same Scripture connections), or put them back. */
  const setIgnoreScripture = (list, ignore) => run(async () => {
    for (const t of list) await api.updateTag(t.id, { ignore_scripture: ignore });
    const what = list.length === 1 ? `#${list[0].name}` : `${list.length} tags`;
    dialog.toast(ignore ? `Scripture references in notes tagged ${what} are now ignored` : `Notes tagged ${what} are back in the Scripture index`);
  });

  /** Menu items for one tag; `open` shows its notes. */
  const menuItems = (tag, { open } = {}) => [
    open && { label: 'Show notes', onClick: () => open(tag) },
    { label: 'Tag notes…', onClick: () => tagNotes(tag) },
    'sep',
    { label: 'Rename…', onClick: () => rename(tag) },
    { label: 'Color…', onClick: () => setColor([tag]) },
    { label: 'Merge into…', onClick: () => merge([tag]) },
    tag.ignore_scripture
      ? { label: 'Include in Scripture index', onClick: () => setIgnoreScripture([tag], false) }
      : { label: 'Ignore Scripture references', onClick: () => setIgnoreScripture([tag], true) },
    { label: 'Export notes…', onClick: () => openExport(dialog, { scope: { tag: tag.id }, title: `#${tag.name}` }) },
    notebookActions.shortcutItem('tag', tag.id),
    'sep',
    { label: 'Delete tag…', danger: true, onClick: () => remove([tag]) },
  ];

  return { rename, setColor, merge, remove, tagNotes, create, setIgnoreScripture, menuItems };
}
