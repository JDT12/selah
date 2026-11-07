import { LEADS } from '../reminders.js';

/**
 * Which reminders an event or task gets: any of the lead times, or none. `value` is the list in effect
 * (the usual ones when it hasn't been chosen); onChange gets the new list.
 */
export default function ReminderPicker({ value, onChange, untimed }) {
  const toggle = (min) => onChange(value.includes(min) ? value.filter((m) => m !== min) : [...value, min].sort((a, b) => a - b));
  return (
    <div className="reminder-picker">
      <div className="reminder-chips" role="group" aria-label="Remind me">
        {LEADS.map((l) => (
          <button key={l.min} type="button" className={`chip-toggle ${value.includes(l.min) ? 'is-active' : ''}`}
            aria-pressed={value.includes(l.min)} title={l.label} onClick={() => toggle(l.min)}>
            {l.short}
          </button>
        ))}
        <button type="button" className={`chip-toggle ${value.length ? '' : 'is-active'}`} aria-pressed={!value.length}
          onClick={() => onChange([])}>None</button>
      </div>
      {untimed && value.length > 0 && <p className="muted reminder-hint">No time set, so these count back from midnight.</p>}
    </div>
  );
}
