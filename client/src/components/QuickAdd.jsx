import { forwardRef, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatTime, relativeDay, todayStr } from '../time.js';
import { tagColor } from '../tagColors.js';
import { parseTask } from '../taskParse.js';
import { describeRule } from './RecurrenceEditor.jsx';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

const ICONS = { date: 'calendar', start: 'clock', time: 'clock', repeat: 'repeat', priority: 'flag', list: 'list' };

const HELP = [
  ['tomorrow, friday, next week, oct 25, 12/1, in 3 days', 'due date'],
  ['3pm, at 9, noon', 'time'],
  ['start monday, starts oct 20', 'start date'],
  ['every day, every other week, every mon and thu', 'repeat'],
  ['!high  !med  !low  (or !!!)', 'priority'],
  ['#Church', 'list (a new name makes a new list)'],
];

/**
 * Type a task in plain words: dates, times, repeats, !priority and #list are picked out as you type
 * and shown as chips (× keeps that text in the title instead). defaults: { due_date, list_id } for the
 * current view. onCreated(id, task) runs after it's added.
 */
const QuickAdd = forwardRef(function QuickAdd({ lists: listsProp, defaults = {}, placeholder = 'Add a task', onCreated, onListsChanged, className = '' }, ref) {
  const dialog = useDialog();
  // Without a lists prop (e.g. on the dashboard) it loads them itself.
  const [ownLists, setOwnLists] = useState([]);
  const lists = listsProp ?? ownLists;
  useEffect(() => {
    if (!listsProp) api.listTaskLists().then(setOwnLists).catch(() => {});
  }, [listsProp]);
  const [text, setText] = useState('');
  const [ignore, setIgnore] = useState([]);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const parsed = useMemo(() => parseTask(text, { today: todayStr(), lists, ignore }), [text, lists, ignore]);
  const defaultList = lists.find((l) => l.id === defaults.list_id);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      let listId = parsed.list ? parsed.list.id : defaults.list_id ?? null;
      if (parsed.list?.isNew) {
        listId = (await api.createTaskList({ name: parsed.list.name })).id;
        if (listsProp) onListsChanged?.();
        else api.listTaskLists().then(setOwnLists).catch(() => {});
      }
      const body = {
        title: parsed.title,
        due_date: parsed.due_date ?? defaults.due_date ?? null,
        due_time: parsed.due_time,
        start_date: parsed.start_date,
        priority: parsed.priority,
        rrule: parsed.rrule,
        list_id: listId,
      };
      const { id } = await api.createTask(body);
      setText('');
      setIgnore([]);
      onCreated?.(id, body);
    } catch (err) {
      dialog.toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const label = (tok) => {
    if (tok.kind === 'date') return relativeDay(parsed.due_date);
    if (tok.kind === 'time') return formatTime(parsed.due_time);
    if (tok.kind === 'start') return `Starts ${relativeDay(parsed.start_date)}`;
    if (tok.kind === 'repeat') return describeRule(parsed.rrule) || tok.label;
    if (tok.kind === 'list') return tok.isNew ? `New list: ${tok.label}` : tok.label;
    return tok.label;
  };
  const showDefaultDate = !parsed.due_date && defaults.due_date && text.trim();
  const showDefaultList = !parsed.list && defaultList && text.trim();

  return (
    <form className={`quick-add smart-add ${className}`} onSubmit={submit}>
      <div className="smart-add-row">
        <Icon name="plus" size={18} className="smart-add-plus" />
        <input ref={ref} value={text} placeholder={placeholder} aria-label="New task" enterKeyHint="done"
          onChange={(e) => { setText(e.target.value); if (!e.target.value) setIgnore([]); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); setIgnore([]); e.currentTarget.blur(); } }} />
        <button type="button" className="icon-btn smart-add-help" onClick={() => setHelp(!help)} aria-expanded={help}
          title="What can I type?" aria-label="What can I type?">?</button>
        {text.trim() && <button type="submit" className="btn btn-primary btn-small" disabled={busy}>Add</button>}
      </div>
      {(parsed.tokens.length > 0 || showDefaultDate || showDefaultList) && (
        <div className="smart-chips">
          {parsed.tokens.map((tok) => (
            <span key={tok.key} className={`smart-chip kind-${tok.kind} ${tok.kind === 'priority' ? `prio-${parsed.priority}` : ''}`}
              title={`From “${tok.text.trim()}”`}>
              {tok.kind === 'list'
                ? <span className="tag-dot" style={{ '--tag': tagColor(parsed.list?.color) ?? 'var(--muted)' }} />
                : <Icon name={ICONS[tok.kind]} size={12} />}
              {label(tok)}
              <button type="button" aria-label={`Keep “${tok.text.trim()}” in the title`} title="Keep this text in the title"
                onClick={() => setIgnore([...ignore, tok.key])}><Icon name="x" size={11} /></button>
            </span>
          ))}
          {showDefaultDate && <span className="smart-chip is-default"><Icon name="calendar" size={12} />{relativeDay(defaults.due_date)}</span>}
          {showDefaultList && (
            <span className="smart-chip is-default">
              <span className="tag-dot" style={{ '--tag': tagColor(defaultList.color) ?? 'var(--muted)' }} />{defaultList.name}
            </span>
          )}
        </div>
      )}
      {help && (
        <div className="smart-help">
          <p>Type naturally. These are picked out of the title:</p>
          <dl>{HELP.map(([ex, what]) => <div key={what}><dt>{ex}</dt><dd>{what}</dd></div>)}</dl>
          <p className="muted">Click × on a chip to keep that text in the title.</p>
        </div>
      )}
    </form>
  );
});

export default QuickAdd;
