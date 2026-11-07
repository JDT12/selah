import { useDialog } from './Dialogs.jsx';
import { openExport } from './ExportDialog.jsx';
import TemplatePicker from './TemplatePicker.jsx';
import { api } from '../api.js';

/**
 * Note actions shared by the note list, the dashboard and the note's own menu. A note can be pinned to the
 * top of its notebook (`pinned`) and, separately, pinned to Home (`dash_pinned`).
 * Templates (`is_template`) live in their own list and are copied to start new notes.
 * onChange(id, patch) runs after a change is saved; errors are reported as a toast (and the action resolves false).
 * onCreated(id, { notebook_id, is_template }) runs after a new note is made (a duplicate or one from a template).
 */
export function useNoteActions({ tree, onChange, onCreated }) {
  const dialog = useDialog();

  const save = async (note, patch, message) => {
    try {
      await api.updateNote(note.id, patch);
      if (message) dialog.toast(message);
      onChange?.(note.id, patch);
      return true;
    } catch (e) {
      dialog.toast(e.message, 'error');
      return false;
    }
  };

  const setPinned = (note, on) => save(note, { pinned: on ? 1 : 0 },
    on ? 'Pinned to the top of the list' : 'Unpinned from the top of the list');
  const setOnDashboard = (note, on) => save(note, { dash_pinned: on ? 1 : 0 },
    on ? 'Pinned to Home' : 'Removed from Home');

  /** Asks for a notebook; `move(id, notebookId)` does the move when the caller has its own (the app's re-selects). */
  const moveTo = async (note, move) => {
    const others = tree.notebooks.filter((nb) => nb.id !== note.notebook_id);
    if (!others.length) return dialog.toast('There is no other notebook to move it to', 'error');
    const into = await dialog.choose({
      title: `Move “${note.title || 'Untitled'}” to…`,
      options: others.map((nb) => ({ value: nb.id, label: nb.name })),
      okLabel: 'Move',
    });
    if (!into) return undefined;
    if (move) return move(note.id, into);
    return save(note, { notebook_id: into }, `Moved to ${others.find((nb) => nb.id === into)?.name}`);
  };

  const copyLink = async (note) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/#note/${note.id}`);
      dialog.toast('Note link copied');
    } catch {
      dialog.toast('Could not access clipboard', 'error');
    }
  };

  const notebookName = (id) => tree.notebooks.find((nb) => nb.id === id)?.name;

  const setTemplate = async (note, on) => {
    if (on) return save(note, { is_template: 1 }, 'Moved to Templates');
    // Its notebook may have been deleted while it was a template.
    let notebook = note.notebook_id;
    if (!notebookName(notebook)) notebook = tree.myNotes ?? tree.notebooks[0]?.id; // 10.1: no notebook to ask about
    return save(note, { is_template: 0, notebook_id: notebook }, 'No longer a template; it’s back in My notes');
  };

  const copy = async (note, body, message) => {
    try {
      const { id } = await api.copyNote(note.id, body);
      dialog.toast(message);
      const notebookId = body.notebook_id ?? (notebookName(note.notebook_id) ? note.notebook_id : tree.notebooks[0]?.id);
      onCreated?.(id, { notebook_id: notebookId, is_template: body.asTemplate ? 1 : 0 });
      return id;
    } catch (e) {
      dialog.toast(e.message, 'error');
      return null;
    }
  };
  const duplicate = (note) => copy(note, note.is_template ? { asTemplate: true } : {},
    note.is_template ? 'Template duplicated' : 'Note duplicated');
  /** A new note from a template, in `notebookId` (default: the template's own notebook, or the first one). */
  const newFromTemplate = (template, notebookId) => {
    const nb = notebookId ?? tree.myNotes ?? tree.notebooks[0]?.id; // 10.1: new notes go to My notes
    return copy(template, { notebook_id: nb }, 'New note from the template');
  };
  /** Ask which template (and notebook), then make the note. */
  const pickTemplate = async (notebookId) => {
    const r = await dialog.open((close) => <TemplatePicker tree={tree} notebookId={notebookId} close={close} />);
    if (!r) return null;
    return newFromTemplate({ id: r.template }, r.notebook);
  };

  const pinItems = (note) => [
    { label: note.pinned ? 'Unpin from top of the list' : 'Pin to top of the list', onClick: () => setPinned(note, !note.pinned) },
    { label: note.dash_pinned ? 'Remove from Home' : 'Pin to Home', onClick: () => setOnDashboard(note, !note.dash_pinned) },
  ];

  /** Right-click menu for a note. Leave out a handler to leave out its item. */
  const menuItems = (note, { open, openInTab, move, trash, restore, deleteForever } = {}) => {
    if (note.deleted_at) {
      return [
        restore && { label: 'Restore', onClick: () => restore(note.id) },
        deleteForever && { label: 'Delete forever…', danger: true, onClick: () => deleteForever(note.id) },
      ];
    }
    if (note.is_template) {
      return [
        { label: 'New note from this template', onClick: () => newFromTemplate(note) },
        open && { label: 'Edit template', onClick: () => open(note.id) },
        'sep',
        { label: 'Duplicate template', onClick: () => duplicate(note) },
        { label: 'Stop using as template', onClick: () => setTemplate(note, false) },
        'sep',
        trash && { label: 'Move to Trash', danger: true, onClick: () => trash(note.id) },
      ];
    }
    return [
      open && { label: 'Open', onClick: () => open(note.id) },
      // 11.0: a tab of its own beside the main tab.
      { label: 'Open in new tab', onClick: () => (openInTab ? openInTab(note.id)
        : window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'note', id: note.id, title: note.title } }))) },
      'sep',
      ...pinItems(note),
      'sep',
      { label: 'Duplicate', onClick: () => duplicate(note) },
      { label: 'Make into template', onClick: () => setTemplate(note, true) },
      { label: 'Copy link to note', onClick: () => copyLink(note) },
      { label: 'Export…', onClick: () => openExport(dialog, { scope: { notes: [note.id] }, title: note.title || 'Untitled', word: { noteIds: [note.id] } }) },
      'sep',
      trash && { label: 'Move to Trash', danger: true, onClick: () => trash(note.id) },
    ];
  };

  return {
    setPinned, setOnDashboard, moveTo, copyLink, pinItems, menuItems, setTemplate, duplicate, newFromTemplate, pickTemplate,
  };
}
