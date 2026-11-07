import { useId, useState } from 'react';
import Icon from './Icon.jsx';
import { tagColor } from '../tagColors.js';

export default function TagInput({ tags, allTags, onChange, disabled }) {
  const [value, setValue] = useState('');
  const listId = useId();
  const colorOf = (name) => tagColor(allTags.find((x) => x.name.toLowerCase() === name.toLowerCase())?.color);

  const add = (raw) => {
    const t = raw.trim().replace(/,$/, '').trim();
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...tags, t]);
    setValue('');
  };

  return (
    <div className="tag-input">
      <Icon name="tag" size={15} className="muted" />
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {colorOf(t) && <span className="tag-dot" style={{ '--tag': colorOf(t) }} />}
          {t}
          {!disabled && (
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <>
          <input
            className="tag-field"
            value={value}
            list={listId}
            placeholder={tags.length ? '' : 'Add tag…'}
            onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setValue(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); add(value); }
              if (e.key === 'Backspace' && !value && tags.length) onChange(tags.slice(0, -1));
            }}
            onBlur={() => value && add(value)}
          />
          <datalist id={listId}>
            {allTags.filter((t) => !tags.includes(t.name)).map((t) => <option key={t.id} value={t.name} />)}
          </datalist>
        </>
      )}
    </div>
  );
}
