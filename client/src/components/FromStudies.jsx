import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { getField, parseStudy } from '../bibleStudy.js';
import { parse } from '../../../shared/scripture.js';

const overlaps = (a, b) => a.some((x) => b.some((y) => x.start <= y.end && x.end >= y.start));

/**
 * Your Bible studies of a sermon's or lesson's passage, in its builder: what each found (summary, principle, words,
 * questions, application, keeper). In the sermon builder (onUse) the summary can be the text idea and the principle
 * the sermon idea; other builders pass their own actions: { fieldKey: [[label, (text) => …], …] }.
 */
export default function FromStudies({ passage, onUse, actions }) {
  const [studies, setStudies] = useState(null); // [{ id, title, updated, fields }]
  const [open, setOpen] = useState(0);

  useEffect(() => {
    const refs = parse(passage ?? '').refs;
    if (!refs.length) { setStudies([]); return undefined; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const all = (await api.bibleStudies()).filter((s) => overlaps(s.refs ?? [], refs));
        const notes = await Promise.all(all.slice(0, 5).map((s) => api.getNote(s.note_id).catch(() => null)));
        if (!live) return;
        setStudies(all.slice(0, 5).map((s, i) => {
          const m = notes[i] && parseStudy(notes[i].html);
          const get = (k) => (m ? getField(m, k).text.trim() : '');
          return {
            id: s.id, title: s.title, passage: s.passage, updated: s.note_updated,
            fields: [['summary', 'What It Meant', get('summary')], ['principles', 'Principle', get('principles')], ['words', 'Important Words', get('words')],
              ...(actions ? [['questions', 'Questions', get('questions')]] : []), ['application', 'Application', get('application')], ['keeper', 'Keeper', get('keeper')]].filter((f) => f[2]),
          };
        }));
      } catch {
        if (live) setStudies([]);
      }
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [passage]);

  if (!studies?.length) return null;
  return (
    <div className="from-studies">
      <p className="from-studies-head"><Icon name="bible" size={14} /> <strong>From Your {studies.length === 1 ? 'Study' : 'Studies'} of This Passage</strong></p>
      {studies.map((s, i) => (
        <div key={s.id} className={`from-study ${open === i ? 'is-open' : ''}`}>
          <button type="button" className="link-btn from-study-title" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i}>
            <Icon name={open === i ? 'chevronDown' : 'chevronRight'} size={13} /> {s.title} <span className="muted">· {s.passage} · {formatDate(s.updated)}</span>
          </button>
          {open === i && (
            <dl>
              {!s.fields.length && <dd className="muted">Nothing written in its steps yet.</dd>}
              {s.fields.map(([k, label, text]) => (
                <div key={k}>
                  <dt>{label}
                    {onUse && k === 'summary' && <button type="button" className="link-btn" onClick={() => onUse('textIdea', text)}>Use as the text idea</button>}
                    {onUse && k === 'principles' && <button type="button" className="link-btn" onClick={() => onUse('sermonIdea', text.split(/\n{2,}/)[0])}>Use as the sermon idea</button>}
                    {(actions?.[k] ?? []).map(([label, run]) => <button key={label} type="button" className="link-btn" onClick={() => run(text)}>{label}</button>)}
                  </dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}
