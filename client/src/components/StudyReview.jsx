import { useCallback, useEffect, useMemo, useState } from 'react';
import { needsFullApp } from '../device.js';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { openStudyBuilder } from './StudyBuilder.jsx';
import { onLive } from '../live.js';
import { useStoredState } from '../useStoredState.js';
import { methodById } from '../../../shared/methods.js';

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const DAY = 86_400_000;
/** The Sunday that starts the week `ms` is in (local time). */
const weekStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
};
const STEP_KEYS = ['summary', 'differences', 'principles', 'consistency', 'application'];

/** A new study (9.2: the New Study dialog, with the passage filled in when there is one). Resolves the note's id. */
export async function startStudy(dialog, passage = '') {
  if (needsFullApp(dialog)) return null;
  const { openNewStudy } = await import('./NewStudyDialog.jsx');
  return openNewStudy(dialog, { start: passage });
}

/** The Bible studies tab: every study, newest first, with its keeper and how far it got. */
export function BibleStudies({ onOpenNote, onOpenPassage }) {
  const dialog = useDialog();
  const [list, setList] = useState(null);
  const load = useCallback(() => api.bibleStudies().then(setList).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); return onLive(load, 800); }, [load]);
  const start = async () => { await startStudy(dialog); load(); };
  const build = async (s) => { await openStudyBuilder(dialog, s.note_id); load(); };

  return (
    <section className="studies-tab">
      <div className="scripture-results-head">
        <h2>Bible Studies</h2>
        <span className="muted">{list ? plural(list.length, 'study', 'studies') : '…'}</span>
        <button type="button" className="btn btn-primary btn-small" onClick={start}><Icon name="plus" size={13} /> Study a passage</button>
      </div>
      <p className="muted study-method">A passage study follows the Interpretive Journey from <em>Grasping God’s Word</em> (Duvall and Hays): their town, the river, the principlizing bridge, the biblical map, our town. A background study covers a whole book (who wrote it, when, to whom and why), and a word study one word’s Hebrew or Greek. Each finishes with a keeper, the one sentence worth finding again.</p>
      {list && !list.length && <p className="muted">No studies yet. Open a passage and choose <strong>Study this passage</strong>, use <strong>Study it</strong> on a reading in a self-study,, or start one here.</p>}
      <div className="study-list">
        {list?.map((s) => (
          <div key={s.id} className="study-card">
            <div className="study-card-head">
              <button type="button" className="study-card-title" onClick={() => onOpenNote(s.note_id)}>{s.title || 'Untitled Study'}</button>
              {s.method !== 'ggw' && <span className="study-kind-tag">{methodById(s.method)?.name}</span>}
              <span className="study-steps" title="Steps written">{(s.method === 'ggw' ? STEP_KEYS : s.data.done ?? []).map((k, i) => <i key={i} className={(s.data.done ?? [])[i] ? 'is-done' : ''} />)}</span>
            </div>
            {s.data.keeper && <p className="rail-keeper">“{s.data.keeper}”</p>}
            <span className="rail-meta">
              {s.passage && <><button type="button" className="link-btn" onClick={() => onOpenPassage(s.passage)}>{s.passage}</button> · </>}
              {formatDate(s.note_updated)}
              {s.data.timesRead ? ` · read ${plural(s.data.timesRead, 'time')}` : ''}
              {' · '}<button type="button" className="link-btn" onClick={() => build(s)}>Open the builder</button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * This week: the weekly review. Your keepers and verse notes from the last seven days to read again, a strip of the
 * weeks you studied, and one keeper from further back.
 */
export function WeekReview({ onOpenNote, onOpenPassage }) {
  const dialog = useDialog();
  const [r, setR] = useState(null);
  const [all, setAll] = useState([]);
  const [reviewed, setReviewed] = useStoredState('noteapp.review.week', 0);
  const load = useCallback(() => Promise.all([api.studyReview(7), api.bibleStudies()])
    .then(([rev, studies]) => { setR(rev); setAll(studies); }).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); return onLive(load, 800); }, [load]);

  const thisWeek = weekStart(Date.now());
  const weeks = useMemo(() => {
    if (!r) return [];
    const active = new Set(r.activity.map(weekStart));
    return Array.from({ length: 12 }, (_, i) => {
      const at = weekStart(thisWeek - (11 - i) * 7 * DAY);
      return { at, on: active.has(at) };
    });
  }, [r, thisWeek]);
  // Weeks in a row with a study or verse note (this week counts once it has one; until then, from last week).
  const streak = useMemo(() => {
    let n = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].on) n += 1;
      else if (i === weeks.length - 1) continue;
      else break;
    }
    return n;
  }, [weeks]);
  // One keeper from further back, a different one each day.
  const older = all.filter((s) => s.data.keeper && s.note_updated < Date.now() - 7 * DAY);
  const flashback = older.length ? older[Math.floor(Date.now() / DAY) % older.length] : null;

  if (!r) return <p className="muted">Loading…</p>;
  const keepers = r.studies.filter((s) => s.data.keeper);
  const nothing = !r.studies.length && !r.verses.length;

  return (
    <section className="week-review">
      <div className="week-strip-wrap">
        <div>
          <h2>{streak > 1 ? `${streak} Weeks in a Row` : streak === 1 ? 'You Studied This Week' : 'This Week'}</h2>
          <p className="muted">{plural(r.studies.length, 'study', 'studies')} and {plural(r.verses.length, 'verse note')} in the last 7 days.</p>
        </div>
        <div className="week-strip" aria-label="Weeks you studied, the last 12">
          {weeks.map((w) => <span key={w.at} className={`${w.on ? 'is-on' : ''} ${w.at === thisWeek ? 'is-now' : ''}`} title={`Week of ${new Date(w.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${w.on ? ': studied' : ''}`} />)}
        </div>
      </div>

      {nothing && (
        <div className="week-empty">
          <p>Nothing written on Scripture this week yet. A short study counts: read the passage, write what it meant, and one keeper.</p>
          <button type="button" className="btn btn-primary" onClick={async () => { await startStudy(dialog); load(); }}><Icon name="plus" size={14} /> New study</button>
        </div>
      )}

      {keepers.length > 0 && (
        <div className="week-group">
          <h3>Your Keepers</h3>
          {keepers.map((s) => (
            <button key={s.id} type="button" className="week-keeper" onClick={() => onOpenNote(s.note_id)}>
              <span className="week-keeper-text">“{s.data.keeper}”</span>
              <span className="rail-meta">{s.title}{s.passage && s.title !== `${s.passage} Study` ? ` · ${s.passage}` : ''}</span>
            </button>
          ))}
        </div>
      )}
      {r.studies.some((s) => !s.data.keeper) && (
        <div className="week-group">
          <h3>Studies Without a Keeper Yet</h3>
          {r.studies.filter((s) => !s.data.keeper).map((s) => (
            <div key={s.id} className="rail-item">
              <button type="button" className="rail-title" onClick={() => onOpenNote(s.note_id)}>{s.title}</button>
              <span className="rail-meta">{formatDate(s.note_updated)} · <button type="button" className="link-btn" onClick={async () => { await openStudyBuilder(dialog, s.note_id); load(); }}>Finish it in the builder</button></span>
            </div>
          ))}
        </div>
      )}
      {r.verses.length > 0 && (
        <div className="week-group">
          <h3>Verse Notes</h3>
          {r.verses.map((n) => (
            <div key={n.id} className="margin-note week-verse">
              <button type="button" className="link-btn margin-note-ref" onClick={() => onOpenPassage(n.title)}>{n.title}</button>
              <p role="button" tabIndex={0} onClick={() => onOpenNote(n.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenNote(n.id); }}>{n.text}</p>
            </div>
          ))}
        </div>
      )}
      {flashback && (
        <div className="week-group">
          <h3>From Your Library</h3>
          <button type="button" className="week-keeper is-old" onClick={() => onOpenNote(flashback.note_id)}>
            <span className="week-keeper-text">“{flashback.data.keeper}”</span>
            <span className="rail-meta">{flashback.title} · {formatDate(flashback.note_updated)}</span>
          </button>
        </div>
      )}
      {!nothing && (
        <p className="week-done">
          {reviewed === thisWeek
            ? <span className="muted"><Icon name="checkCircle" size={14} /> Reviewed this week.</span>
            : <button type="button" className="btn" onClick={() => setReviewed(thisWeek)}><Icon name="check" size={14} /> I’ve read these again</button>}
        </p>
      )}
    </section>
  );
}
