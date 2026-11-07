import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { parseCapture } from '../captureParse.js';
import { parseTask } from '../taskParse.js';
import { todayStr, relativeDay } from '../time.js';
import { RecorderDialog, canCapture } from './MediaCapture.jsx';

/** Saves a voice memo as a note in the Inbox; returns the note's id (or null if nothing was recorded). */
export async function recordVoiceMemo(dialog) {
  if (!canCapture() || !window.MediaRecorder) {
    dialog.toast('This browser cannot record audio.', 'error');
    return null;
  }
  const file = await dialog.open((close) => <RecorderDialog close={close} />, { dismissable: false });
  if (!file) return null;
  const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const t = dialog.toast('Saving voice memo…', 'info', 0);
  try {
    const { id } = await api.capture({ title: `Voice memo · ${stamp}`, text: '' });
    await api.upload(id, file, null, { recording: true, append: true });
    t.close();
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    return id;
  } catch (e) {
    t.close();
    dialog.toast(e.message, 'error');
    return null;
  }
}

/**
 * Alt+N: a box for a quick thought. Enter saves it to the Inbox (Shift+Enter for a new line); #tag, @Notebook and
 * !task are picked out as you type. `onSaved(id, kind)` runs afterwards ('note' or 'task').
 */
export default function QuickCapture({ tree, close, onSaved }) {
  const dialog = useDialog();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState([]);
  const ref = useRef(null);
  useEffect(() => { api.listTaskLists().then(setLists).catch(() => {}); }, []);
  useEffect(() => { ref.current?.focus(); }, []);

  const parsed = useMemo(() => parseCapture(text, tree.notebooks), [text, tree.notebooks]);
  const task = useMemo(() => (parsed.task ? parseTask(parsed.taskText, { today: todayStr(), lists }) : null), [parsed, lists]);

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      if (parsed.task) {
        let listId = task.list?.id ?? null;
        if (task.list?.isNew) listId = (await api.createTaskList({ name: task.list.name })).id;
        const { id } = await api.createTask({
          title: task.title, due_date: task.due_date, due_time: task.due_time, start_date: task.start_date,
          priority: task.priority, rrule: task.rrule, list_id: listId,
        });
        close();
        dialog.toast('Task added');
        onSaved?.(id, 'task');
      } else {
        const r = await api.capture({ title: parsed.title, text: parsed.body, tags: parsed.tags, notebook_id: parsed.notebook?.id });
        close();
        const where = parsed.notebook ? parsed.notebook.name : 'Inbox';
        dialog.toast(`Saved to ${where}`, 'info', 5000, { label: 'Open', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: r.id })) });
        onSaved?.(r.id, 'note');
      }
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };

  const voice = async () => {
    close();
    const id = await recordVoiceMemo(dialog);
    if (id) {
      dialog.toast('Voice memo saved to Inbox', 'info', 5000, { label: 'Open', onClick: () => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: id })) });
      onSaved?.(id, 'note');
    }
  };

  return (
    <div className="capture-box">
      <div className="capture-head">
        <Icon name="bolt" size={16} />
        <span>Quick capture</span>
        <span className="spacer" />
        <kbd>Alt</kbd>+<kbd>N</kbd>
      </div>
      <textarea ref={ref} className="capture-input" rows={3} value={text} disabled={busy}
        placeholder={'A thought, a link, a to-do…\n#tag  @Notebook  !task'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } }} />
      <div className="capture-chips" aria-live="polite">
        {parsed.task ? (
          <>
            <span className="capture-chip is-task"><Icon name="todo" size={13} /> Task</span>
            {task?.due_date && <span className="capture-chip"><Icon name="calendar" size={13} /> {relativeDay(task.due_date)}</span>}
            {task?.list && <span className="capture-chip"><Icon name="list" size={13} /> {task.list.name}</span>}
          </>
        ) : (
          <>
            <span className="capture-chip"><Icon name={parsed.notebook ? 'notebook' : 'inbox'} size={13} /> {parsed.notebook?.name ?? 'Inbox'}</span>
            {parsed.tags.map((t) => <span key={t} className="capture-chip"><Icon name="tag" size={13} /> {t}</span>)}
          </>
        )}
      </div>
      <div className="capture-foot">
        <button type="button" className="btn btn-small" onClick={voice} title="Record a voice memo to the Inbox">
          <Icon name="mic" size={14} /> Voice memo
        </button>
        <span className="spacer" />
        <span className="muted capture-keys"><kbd>Enter</kbd> save · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
        <button type="button" className="btn btn-primary btn-small" disabled={!text.trim() || busy} onClick={save}>Save</button>
      </div>
    </div>
  );
}
