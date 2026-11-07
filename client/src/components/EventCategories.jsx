import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import ReminderPicker from './ReminderPicker.jsx';
import { useDialog } from './Dialogs.jsx';
import { CATEGORY_ICONS, EVENT_COLORS, NONE, categoriesChanged, useEventCategories } from '../eventCategories.js';
import { LEADS } from '../reminders.js';

const hex = (color) => EVENT_COLORS[color] ?? EVENT_COLORS.green;

/** A category's icon in its color, or a dot of its color when it has no icon. */
export function CategoryMark({ color, icon, size = 14, className = '' }) {
  return icon
    ? <span className={`cat-mark ${className}`} style={{ color: hex(color) }}><Icon name={icon} size={size} strokeWidth={2.2} /></span>
    : <span className={`cat-dot ${className}`} style={{ background: hex(color), width: size * 0.65, height: size * 0.65 }} />;
}

/** Show/hide chips, one per category (and "No category"), with Manage…. */
export function CategoryFilter({ hidden, onToggle, onManage, noneLabel = 'No category' }) {
  const { categories } = useEventCategories();
  if (!categories.length) {
    return <div className="cat-filter"><button type="button" className="link-btn" onClick={onManage}>Add calendar categories…</button></div>;
  }
  const chip = (id, label, mark) => {
    const off = hidden.includes(id);
    return (
      <button key={id} type="button" className={`cat-chip ${off ? 'is-off' : ''}`} aria-pressed={!off} onClick={() => onToggle(id)}
        title={off ? `Show ${label}` : `Hide ${label}`}>
        {mark}<span>{label}</span>
      </button>
    );
  };
  return (
    <div className="cat-filter" role="group" aria-label="Show categories">
      {categories.map((c) => chip(c.id, c.name, <CategoryMark color={c.color} icon={c.icon} />))}
      {chip(NONE, noneLabel, <span className="cat-dot cat-dot-none" />)}
      <button type="button" className="cat-manage" onClick={onManage}><Icon name="settings" size={14} /> Manage…</button>
    </div>
  );
}

/** The category of an event: one of them, or none; New… adds one there and then. */
export function CategoryPicker({ value, onChange }) {
  const dialog = useDialog();
  const { categories } = useEventCategories();
  const add = async () => {
    const name = await dialog.prompt({ title: 'New category', label: 'Name', placeholder: 'e.g. Church', okLabel: 'Add' });
    if (!name) return;
    const used = new Set(categories.map((c) => c.color));
    const color = Object.keys(EVENT_COLORS).find((c) => !used.has(c)) ?? 'blue';
    try {
      const c = await api.createEventCategory({ name, color });
      await categoriesChanged();
      onChange(c.id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  return (
    <div className="cat-picker" role="radiogroup" aria-label="Category">
      {categories.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className={`cat-chip ${value === c.id ? 'is-active' : ''}`}
          style={value === c.id ? { borderColor: hex(c.color), background: `color-mix(in srgb, ${hex(c.color)} 14%, transparent)` } : undefined}
          onClick={() => onChange(c.id)}>
          <CategoryMark color={c.color} icon={c.icon} /><span>{c.name}</span>
        </button>
      ))}
      <button type="button" role="radio" aria-checked={value == null} className={`cat-chip ${value == null ? 'is-active' : ''}`} onClick={() => onChange(null)}>
        <span className="cat-dot cat-dot-none" /><span>None</span>
      </button>
      <button type="button" className="cat-chip cat-chip-add" onClick={add}><Icon name="plus" size={13} /> New…</button>
    </div>
  );
}

const leadsLabel = (r) => (!r.length ? 'none' : r.map((m) => LEADS.find((l) => l.min === m)?.short ?? m).join(', '));

/** Settings for the categories: name, color, icon, reminders for their events, order, the default, add and delete. */
export function CategoriesDialog({ close }) {
  const dialog = useDialog();
  const { categories, defaultId } = useEventCategories();
  const [open, setOpen] = useState(null); // the category being edited
  const [newName, setNewName] = useState('');

  const run = async (fn) => {
    try { await fn(); } catch (e) { dialog.toast(e.message, 'error'); }
    await categoriesChanged();
  };
  const update = (c, body) => run(() => api.updateEventCategory(c.id, body));
  const move = (i, to) => {
    if (to < 0 || to >= categories.length) return;
    const ids = categories.map((c) => c.id);
    ids.splice(to, 0, ids.splice(i, 1)[0]);
    run(() => api.orderEventCategories(ids));
  };
  const remove = async (c) => {
    const ok = await dialog.confirm({
      title: `Delete “${c.name}”?`,
      message: 'Its events stay on the calendar, without a category.',
      okLabel: 'Delete category', danger: true,
    });
    if (ok) run(() => api.deleteEventCategory(c.id));
  };
  const add = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const used = new Set(categories.map((c) => c.color));
    const color = Object.keys(EVENT_COLORS).find((x) => !used.has(x)) ?? 'blue';
    await run(async () => { const c = await api.createEventCategory({ name, color }); setOpen(c.id); });
    setNewName('');
  };

  return (
    <div className="cat-dialog">
      <div className="dialog-header">
        <h2>Calendar categories</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">An event’s category gives it its color and icon, and can give it reminders. Show or hide categories on the Calendar and Home.</p>
      <ul className="cat-list">
        {categories.map((c, i) => (
          <li key={c.id} className={open === c.id ? 'is-open' : ''}>
            <div className="cat-row">
              <span className="cat-arrows">
                <button type="button" className="icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${c.name} up`}><Icon name="chevronUp" size={13} /></button>
                <button type="button" className="icon-btn" onClick={() => move(i, i + 1)} disabled={i === categories.length - 1} aria-label={`Move ${c.name} down`}><Icon name="chevronDown" size={13} /></button>
              </span>
              <button type="button" className="cat-row-main" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                <CategoryMark color={c.color} icon={c.icon} size={17} />
                <strong>{c.name}</strong>
                {defaultId === c.id && <span className="cat-badge">Default</span>}
                <span className="muted cat-row-rem">{c.reminders ? `Reminders: ${leadsLabel(c.reminders)}` : ''}</span>
              </button>
              <button type="button" className="icon-btn" onClick={() => setOpen(open === c.id ? null : c.id)} aria-label={`Edit ${c.name}`}>
                <Icon name={open === c.id ? 'chevronUp' : 'chevronDown'} size={16} />
              </button>
            </div>
            {open === c.id && (
              <div className="cat-edit">
                <label className="field">Name
                  <input className="input" defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && update(c, { name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} />
                </label>
                <div className="field"><span>Color</span>
                  <div className="cat-swatches" role="radiogroup" aria-label="Color">
                    {Object.entries(EVENT_COLORS).map(([name, h]) => (
                      <button key={name} type="button" role="radio" aria-checked={c.color === name} title={name} aria-label={name}
                        className={`swatch ${c.color === name ? 'is-active' : ''}`} style={{ background: h }} onClick={() => update(c, { color: name })} />
                    ))}
                  </div>
                </div>
                <div className="field"><span>Icon</span>
                  <div className="cat-icons" role="radiogroup" aria-label="Icon">
                    {CATEGORY_ICONS.map(([name, label]) => (
                      <button key={name || 'none'} type="button" role="radio" aria-checked={c.icon === name} title={label} aria-label={label}
                        className={`cat-icon-btn ${c.icon === name ? 'is-active' : ''}`} style={{ color: hex(c.color) }} onClick={() => update(c, { icon: name })}>
                        {name ? <Icon name={name} size={17} /> : <span className="cat-dot" style={{ background: hex(c.color) }} />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field"><span>Reminders</span>
                  <label className="check-row cat-rem-toggle"><input type="checkbox" checked={!!c.reminders} onChange={(e) => update(c, { reminders: e.target.checked ? [1440] : null })} />
                    <span><strong>Its events remind me</strong><span className="muted">Unless an event sets its own. Otherwise they get the usual reminders.</span></span></label>
                  {c.reminders && <ReminderPicker value={c.reminders} onChange={(r) => update(c, { reminders: r })} />}
                </div>
                <div className="cat-edit-foot">
                  {defaultId === c.id
                    ? <button type="button" className="btn btn-small" onClick={() => run(() => api.setDefaultEventCategory(null))}>No default</button>
                    : <button type="button" className="btn btn-small" onClick={() => run(() => api.setDefaultEventCategory(c.id))}>Make default for new events</button>}
                  <button type="button" className="btn btn-small btn-danger-text" onClick={() => remove(c)}>Delete…</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="cat-add" onSubmit={add}>
        <input className="input" placeholder="New category, e.g. Church" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New category name" />
        <button className="btn" disabled={!newName.trim()}><Icon name="plus" size={15} /> Add</button>
      </form>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => close(true)}>Done</button>
      </div>
    </div>
  );
}

export const openCategories = (dialog) => dialog.open((close) => <CategoriesDialog close={close} />);
