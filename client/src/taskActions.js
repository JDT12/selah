// Task actions shared by the Tasks page, dashboard and calendar. Completing, deleting and bulk changes
// show a toast with Undo. onChanged runs after each change (and after an undo) to reload.
import { api } from './api.js';
import { relativeDay } from './time.js';

const UNDO_MS = 8000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (s) => (s.length > 40 ? `${s.slice(0, 38)}…` : s);

// Only the latest change can be undone: a new Undo toast replaces the previous one.
let lastUndo = null;

function undoToast(dialog, message, undo, onChanged) {
  lastUndo?.close();
  lastUndo = dialog.toast(message, 'info', UNDO_MS, {
    label: 'Undo',
    onClick: async () => {
      try {
        await undo();
      } catch (e) {
        dialog.toast(e.message, 'error');
      }
      onChanged?.();
    },
  });
}

/** Complete one task, or un-complete it if it's done. */
export async function toggleTask(task, dialog, onChanged) {
  try {
    if (task.completed_at) {
      await api.uncompleteTask(task.id);
      onChanged?.();
      return;
    }
    const { next } = await api.completeTask(task.id);
    onChanged?.();
    undoToast(dialog, next ? `Done. Next due: ${relativeDay(next.due_date)}` : `Completed “${short(task.title)}”`,
      () => api.uncompleteTask(task.id, next?.id), onChanged);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

export async function deleteTasks(tasks, dialog, onChanged) {
  try {
    const { deleted } = tasks.length === 1
      ? await api.deleteTask(tasks[0].id)
      : await api.bulkTasks({ action: 'delete', ids: tasks.map((t) => t.id) });
    onChanged?.();
    undoToast(dialog, deleted.length === 1 ? `Deleted “${short(deleted[0].title)}”` : `Deleted ${plural(deleted.length, 'task')}`,
      () => api.restoreTasks(deleted), onChanged);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

export async function completeTasks(tasks, dialog, onChanged) {
  const open = tasks.filter((t) => !t.completed_at);
  if (!open.length) return;
  try {
    const { done } = await api.bulkTasks({ action: 'complete', ids: open.map((t) => t.id) });
    onChanged?.();
    undoToast(dialog, `Completed ${plural(done.length, 'task')}`,
      () => api.bulkTasks({ action: 'uncomplete', items: done.map((d) => ({ id: d.id, next_id: d.next?.id })) }), onChanged);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}

/**
 * Change the due date, list or priority of several tasks. Undo puts each task's old values back
 * (including the repeat, which clearing the date removes, and the start date, which an earlier due date moves).
 */
export async function updateTasks(tasks, changes, dialog, onChanged, message) {
  if (!tasks.length) return;
  const before = tasks.map((t) => ({
    id: t.id,
    old: Object.fromEntries(Object.keys(changes).map((k) => [k, t[k]])
      .concat('due_date' in changes ? [['due_time', t.due_time], ['rrule', t.rrule], ['start_date', t.start_date]] : [])),
  }));
  try {
    await api.bulkTasks({ action: 'update', ids: tasks.map((t) => t.id), changes });
    onChanged?.();
    undoToast(dialog, message ?? `Updated ${plural(tasks.length, 'task')}`,
      () => Promise.all(before.map((b) => api.updateTask(b.id, b.old))), onChanged);
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}
