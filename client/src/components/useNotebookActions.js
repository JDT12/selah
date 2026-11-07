import { useDialog } from './Dialogs.jsx';
import { api } from '../api.js';
import { openExport } from './ExportDialog.jsx';
import { openShare } from './SharingDialogs.jsx';
import { serverMode } from '../mode.js';

/**
 * Notebook and stack actions shared by the sidebar and the Notebooks page. Each one asks for
 * whatever it needs (name, confirmation…), reports errors as a toast and then calls onRefresh.
 * onCreated(id) runs after a new notebook is made; onDeleted(id) after a notebook goes away.
 */
export function useNotebookActions({ tree, onRefresh, onCreated, onDeleted }) {
  const dialog = useDialog();
  const shortcuts = tree.shortcuts ?? [];

  const run = async (fn) => {
    try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); }
    onRefresh();
  };

  const newNotebook = (stackId = null) => run(async () => {
    const name = await dialog.prompt({ title: 'New notebook', label: 'Notebook name', okLabel: 'Create' });
    if (!name) return;
    const { id } = await api.createNotebook(name, stackId);
    onCreated?.(id);
  });

  const newStack = (notebookIds = []) => run(async () => {
    const name = await dialog.prompt({ title: 'New shelf', label: 'Shelf name', okLabel: 'Create' });
    if (!name) return;
    await api.createStack(name, notebookIds);
  });

  const renameStack = (s) => run(async () => {
    const name = await dialog.prompt({ title: 'Rename shelf', value: s.name, okLabel: 'Rename' });
    if (name) await api.renameStack(s.id, name);
  });

  const deleteStack = (s) => run(async () => {
    const ok = await dialog.confirm({
      title: `Delete shelf "${s.name}"?`,
      message: 'The notebooks inside will be kept and taken off the shelf.',
      okLabel: 'Delete shelf', danger: true,
    });
    if (ok) await api.deleteStack(s.id);
  });

  const renameNotebook = (nb) => run(async () => {
    const name = await dialog.prompt({ title: 'Rename notebook', value: nb.name, okLabel: 'Rename' });
    if (name) await api.updateNotebook(nb.id, { name });
  });

  /** Ask which stack to move the notebooks to (or a new one). */
  const moveToStack = (notebooks) => run(async () => {
    const one = notebooks.length === 1 ? notebooks[0] : null;
    const choice = await dialog.choose({
      title: one ? `Move "${one.name}" to a shelf` : `Move ${notebooks.length} notebooks to a shelf`,
      value: one?.stack_id ?? 0,
      options: [
        { value: 0, label: 'No shelf' },
        ...tree.stacks.map((s) => ({ value: s.id, label: s.name })),
        { value: -1, label: 'New shelf…' },
      ],
      okLabel: 'Move',
    });
    if (choice === null || choice === undefined) return;
    if (choice === -1) return newStack(notebooks.map((nb) => nb.id));
    for (const nb of notebooks) await api.updateNotebook(nb.id, { stack_id: choice || null });
  });

  const setStack = (nbId, stackId) => run(() => api.updateNotebook(nbId, { stack_id: stackId }));

  const deleteNotebooks = (notebooks) => run(async () => {
    const one = notebooks.length === 1 ? notebooks[0] : null;
    const count = notebooks.reduce((n, nb) => n + nb.count, 0);
    const ok = await dialog.confirm({
      title: one ? `Delete notebook "${one.name}"?` : `Delete ${notebooks.length} notebooks?`,
      message: count ? `${count} note${count === 1 ? '' : 's'} will be moved to the Trash.`
        : one ? 'This notebook is empty.' : 'These notebooks are empty.',
      okLabel: one ? 'Delete notebook' : 'Delete notebooks', danger: true,
    });
    if (!ok) return;
    for (const nb of notebooks) {
      await api.deleteNotebook(nb.id);
      onDeleted?.(nb.id);
    }
  });

  /** Move all of a notebook's notes into another notebook and delete it. */
  const mergeNotebook = (nb) => run(async () => {
    const others = tree.notebooks.filter((x) => x.id !== nb.id);
    if (!others.length) throw new Error('There is no other notebook to merge into');
    const into = await dialog.choose({
      title: `Merge "${nb.name}" into…`,
      message: `Its ${nb.count} note${nb.count === 1 ? '' : 's'} move to the notebook you choose, then "${nb.name}" is deleted.`,
      options: others.map((x) => ({ value: x.id, label: x.name })),
      okLabel: 'Merge',
    });
    if (!into) return;
    await api.mergeNotebook(nb.id, into);
    onDeleted?.(nb.id);
    dialog.toast(`Merged into ${others.find((x) => x.id === into)?.name}`);
  });

  /** Export notebooks (one notebook can also go to Word, as one document). */
  const exportNotebooks = (notebooks) => {
    const one = notebooks.length === 1 ? notebooks[0] : null;
    return openExport(dialog, {
      scope: { notebooks: notebooks.map((nb) => nb.id) },
      title: one ? one.name : `${notebooks.length} notebooks`,
      word: one ? { noteIds: async () => (await api.listNotes({ notebook: one.id })).map((n) => n.id) } : null,
    });
  };
  /** "Share…" for a notebook, in the cloud (8.0); null on a home server, where there's no one to share with. */
  const shareItem = (nb) => (serverMode() === 'tenant' ? { label: 'Share…', onClick: () => openShare(dialog, { kind: 'notebook', id: nb.id, title: nb.name }) } : null);
  const exportStack = (s) => openExport(dialog, { scope: { stack: s.id }, title: s.name });

  const addShortcut = (kind, id) => run(() => api.addShortcut(kind, id));
  const removeShortcut = (id) => run(() => api.removeShortcut(id));
  const shortcutFor = (kind, id) => shortcuts.find((x) => x.kind === kind && x.target_id === id);
  const toggleShortcut = (kind, id) => {
    const sc = shortcutFor(kind, id);
    return sc ? removeShortcut(sc.id) : addShortcut(kind, id);
  };
  /** Menu item that adds or removes a shortcut. */
  const shortcutItem = (kind, id) => (shortcutFor(kind, id)
    ? { label: 'Remove from shortcuts', onClick: () => toggleShortcut(kind, id) }
    : { label: 'Add to shortcuts', onClick: () => toggleShortcut(kind, id) });
  const reorderShortcut = (dragId, beforeId) => {
    if (dragId === beforeId) return;
    const ids = shortcuts.map((sc) => sc.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(beforeId), 0, dragId);
    run(() => api.reorderShortcuts(ids));
  };

  return {
    run, newNotebook, newStack, renameStack, deleteStack, renameNotebook, moveToStack, setStack,
    deleteNotebooks, mergeNotebook, exportNotebooks, exportStack, addShortcut, removeShortcut, shortcutFor, toggleShortcut, shortcutItem,
    reorderShortcut, shareItem,
  };
}
