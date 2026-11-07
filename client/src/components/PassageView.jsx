import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import HandwritingDialog from './HandwritingDialog.jsx';
import { newStudy } from './StudyBuilder.jsx';
import { startStudy } from './StudyReview.jsx';
import { BackgroundCard } from './ReferenceStudies.jsx';
import { openLessonBuilder, writeLesson } from './LessonBuilder.jsx';
import { showStudy } from '../pages/DeskPage.jsx';
import { isLessonNote } from '../lesson.js';
import { openPassage } from '../logos.js';
import { onLive } from '../live.js';
import { parse } from '../../../shared/scripture.js';
import { Credit, TranslationPicker, useBible } from './TranslationPicker.jsx';
import { WORK_TYPES, workRow } from '../work.js';
import { openBuilderPage } from '../builderPages.js';

/**
 * A passage on the Scripture page, with everything you've written on it. The verses asked for (ESV), one row each,
 * with your verse notes beside them: click a verse (or its +) to jot one, which becomes a note titled with the
 * verse. ★ adds a verse to your memory verses. Beside the text: your studies of the passage (and a button to start
 * one), sermons on it with when you preached them, what you teach on it (lessons and planned sessions in teaching
 * studies, courses and series), other notes that mention it, and its memory verses.
 */
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export default function PassageView({ query, onQuery, onOpenNote, onClose }) {
  const dialog = useDialog();
  const [p, setP] = useState(null);
  const [writing, setWriting] = useState(null); // verse key being noted
  const [work, setWork] = useState(null); // 11.0: your studies, lessons and sermons on these verses

  const bible = useBible('passage');
  const load = useCallback(() => {
    api.work(query).then(setWork).catch(() => setWork([]));
    return api.versePassage(query, bible.tr).then(setP).catch((e) => { dialog.toast(e.message, 'error'); setP({ failed: true }); });
  }, [query, dialog, bible.tr]);
  useEffect(() => { setP(null); setWriting(null); load(); }, [load]);
  // Notes edited elsewhere (the peek panel, another window) show here when they change.
  useEffect(() => {
    const off = onLive(load, 800);
    window.addEventListener('noteapp:notes-changed', load);
    return () => { off(); window.removeEventListener('noteapp:notes-changed', load); };
  }, [load]);

  if (!p) return <section className="passage"><p className="muted">Loading {query}…</p></section>;
  if (p.failed) return null;

  const verseNotes = (key) => p.notes.filter((n) => n.kind === 'verse' && n.verse === key);
  const learning = (key) => p.memory.some((m) => m.start <= key && m.end >= key);
  const partial = p.chapters.some((c) => !c.whole);
  const single = p.refs.length === 1 && parse(p.refs[0]).refs[0];
  const canLearn = single && !(single.ch_start !== single.ch_end && single.v_start === 0);
  const lessons = p.lessons ?? [];
  // 11.0: "Your work on" this passage: its studies, lessons and sermons in one list, with how far along each is.
  const mine = (work ?? []).map(workRow);
  const noteOf = (id) => p.notes.find((n) => n.id === id);
  const planned = lessons.filter((l) => !l.note_id || !mine.some((w) => w.note_id === l.note_id));
  const others = p.notes.filter((n) => n.kind === 'note' || (n.kind === 'lesson' && !lessons.some((l) => l.note_id === n.id)));
  // Verse notes the text can't show beside their verse (no ESV, or a verse outside the verses shown).
  const shown = new Set(p.esv ? p.chapters.flatMap((c) => c.verses.map((v) => v.key)) : []);
  const loose = p.notes.filter((n) => n.kind === 'verse' && !shown.has(n.verse));

  const changed = () => window.dispatchEvent(new Event('noteapp:notes-changed'));
  const addNote = async (c, v, text) => {
    try {
      await api.addVerseNote({ book: c.book, chapter: c.chapter, verse: v.v, text });
      setWriting(null);
      changed();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const learn = async (ref) => {
    try {
      const r = await api.addMemoryVerse(ref);
      dialog.toast(r.existing ? `${ref} is already on your memory list` : `${ref} added to your memory verses`);
      load();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const study = async () => {
    await startStudy(dialog, p.reference);
    load();
  };
  const studyWord = async () => { await newStudy(dialog, single && single.ch_start === single.ch_end && single.v_start > 0 ? p.reference : '', {}, { method: 'word' }); load(); };
  /** A lesson opens in the lesson builder when it's laid out for it, else as a note; a planned session gets its lesson written. */
  const openLesson = async (l) => {
    if (!l.note_id) { if (await writeLesson(dialog, l.item_id, onOpenNote, l.study_id)) load(); return; }
    const note = await api.getNote(l.note_id).catch(() => null);
    if (note && isLessonNote(note.html)) { await openLessonBuilder(dialog, l.note_id); load(); } else onOpenNote(l.note_id);
  };
  const openTeaching = (l) => {
    showStudy(l.study_id, l.course);
    window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: 'desk' }));
  };
  /** Your handwritten notes on the passage (a photo of your Bible's margins or a notebook page), read into a note. */
  const photo = async () => {
    const r = await dialog.open((close) => <HandwritingDialog actions={[{ key: 'insert', label: 'Save as a note on the passage' }]} close={close} />, { dismissable: false });
    if (!r?.text?.trim()) return;
    try {
      const { id } = await api.addVerseNote({ ref: p.reference, html: r.html, text: r.text });
      changed();
      dialog.toast(`Saved your notes as “${p.reference}”`);
      onOpenNote(id);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  const rail = (
    <aside className="passage-rail" aria-label="On this passage">
      <div className="rail-group pv-work">
        <div className="rail-head"><Icon name="desk" size={14} /> <strong>Your work on {p.reference}</strong><span className="muted">{mine.length || ''}</span></div>
        {work && !mine.length && <p className="rail-meta">No studies, lessons or sermons on these verses yet.</p>}
        {mine.map((w) => {
          const n = noteOf(w.note_id);
          return (
            <div key={w.key} className={`rail-item is-work ${w.done ? 'is-done' : ''}`}>
              <button type="button" className="rail-title" onClick={() => openBuilderPage(w.note_id, w.builder)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'note', id: w.note_id, title: w.title } })); } }}>
                <span className="work-dot" style={{ background: w.color }} />{w.title}
              </button>
              <span className="rail-meta">
                <span className="pv-work-type">{WORK_TYPES[w.type]?.label}</span>
                {w.passage && w.passage !== p.reference ? ` · ${w.passage}` : ''}
                {' · '}{w.done ? <span className="pv-work-done"><Icon name="checkCircle" size={12} /> Done</span> : `Step ${w.step} of ${w.steps}`}
              </span>
              {n?.word && (n.word.lemma || n.word.strongs) && <span className="rail-meta" dir="auto">{[n.word.lemma, n.word.translit, n.word.strongs].filter(Boolean).join(' · ')}</span>}
              {n?.keeper && <p className="rail-keeper">“{n.keeper}”</p>}
              {w.type === 'sermon' && n && <span className="rail-meta">{n.preachings?.length
                ? `Preached ${n.preachings.slice(0, 3).map((x) => [longDate(x.date), x.place].filter(Boolean).join(', ')).join(' · ')}${n.preachings.length > 3 ? ` · ${n.preachings.length - 3} more` : ''}`
                : 'Not preached yet'}</span>}
              <span className="rail-meta"><button type="button" className="link-btn" onClick={() => onOpenNote(w.note_id)}>Read the note</button></span>
            </div>
          );
        })}
        <div className="pv-work-new">
          <button type="button" className="btn btn-small btn-primary rail-study" onClick={study}><Icon name="plus" size={13} /> Study this passage</button>
          <button type="button" className="btn btn-small rail-study" onClick={studyWord}><Icon name="plus" size={13} /> Study a word</button>
        </div>
      </div>
      <div className="rail-group">
        <BackgroundCard passage={p.reference} compact />
      </div>
      {planned.length > 0 && (
        <div className="rail-group">
          <div className="rail-head"><Icon name="present" size={14} /> <strong>Teaching</strong><span className="muted">{planned.length}</span></div>
          {planned.map((l) => (
            <div key={l.item_id ?? `n${l.note_id}`} className={`rail-item ${l.note_id ? '' : 'is-planned'}`}>
              {l.note_id
                ? <button type="button" className="rail-title" onClick={() => onOpenNote(l.note_id)}>{l.title || 'Untitled Lesson'}</button>
                : <span className="rail-title">{l.title || 'Untitled Session'}</span>}
              <span className="rail-meta">
                {[l.date && longDate(l.date), l.ref !== p.reference && l.ref].filter(Boolean).join(' · ')}
                {l.study && <>{l.date || (l.ref && l.ref !== p.reference) ? ' · ' : ''}<button type="button" className="link-btn" onClick={() => openTeaching(l)} title={l.course ? 'Open the course' : 'Open it on Desk'}>{l.study}</button></>}
              </span>
              <span className="rail-meta">{l.note_id
                ? <button type="button" className="link-btn" onClick={() => openLesson(l)}>Open the lesson</button>
                : <>{l.done ? 'Taught · ' : 'Not written yet · '}<button type="button" className="link-btn" onClick={() => openLesson(l)}>Write the lesson</button></>}</span>
            </div>
          ))}
        </div>
      )}
      {p.memory.length > 0 && (
        <div className="rail-group">
          <div className="rail-head"><Icon name="star" size={14} /> <strong>Memory Verses</strong></div>
          <p className="rail-meta">{p.memory.map((m) => m.ref).join(' · ')}</p>
        </div>
      )}
      <div className="rail-group">
        <div className="rail-head"><Icon name="note" size={14} /> <strong>Notes That Mention It</strong><span className="muted">{others.length || ''}</span></div>
        {!others.length && <p className="rail-meta">None yet.</p>}
        {others.map((n) => (
          <button key={n.id} type="button" className="rail-item rail-note" onClick={() => onOpenNote(n.id)}>
            <span className="rail-title">{n.title || 'Untitled'}</span>
            <span className="rail-meta">{n.refs.join(' · ')} · {formatDate(n.updated_at)}{n.notebook ? ` · ${n.notebook}` : ''}</span>
          </button>
        ))}
        <button type="button" className="link-btn rail-photo" onClick={photo}><Icon name="camera" size={13} /> Photo of your handwritten notes</button>
      </div>
    </aside>
  );

  return (
    <section className="passage">
      <div className="passage-head">
        <h2>{p.reference}</h2>
        <span className="passage-nav">
          {p.prev && <button type="button" className="btn btn-small" onClick={() => onQuery(p.prev)} title={p.prev}><Icon name="chevronLeft" size={14} /> {p.prev}</button>}
          {partial && <button type="button" className="btn btn-small" onClick={() => onQuery(p.chapters.map((c) => c.label).filter((l, i, a) => a.indexOf(l) === i).join('; '))}>Whole chapter</button>}
          {p.next && <button type="button" className="btn btn-small" onClick={() => onQuery(p.next)} title={p.next}>{p.next} <Icon name="chevronRight" size={14} /></button>}
        </span>
        <span className="spacer" />
        {canLearn && <button type="button" className="btn btn-small" onClick={() => learn(p.refs[0])} title="Add to your memory verses"><Icon name="star" size={14} /> Learn it</button>}
        {single && <button type="button" className="btn btn-small" onClick={() => openPassage(single)} title="Open this passage in Logos"><Icon name="external" size={14} /> Logos</button>}
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the passage"><Icon name="x" size={16} /></button>}
      </div>

      <div className="passage-layout">
        {rail}
        <div className="passage-body">
          <div className="passage-tr"><TranslationPicker bible={bible} /></div>
          {!p.esv && (
            <p className="passage-noesv muted">
              {/connected/.test(p.error ?? '') ? 'Connect a Bible in Settings → Connections → Bible to read the text here.' : p.error}
            </p>
          )}
          {loose.length > 0 && (
            <div className="passage-loose">
              {loose.map((n) => <VerseNote key={n.id} n={n} withRef onOpen={() => onOpenNote(n.id)} />)}
            </div>
          )}

          {p.esv && p.chapters.map((c) => (
            <div key={`${c.book}.${c.chapter}`} className="passage-chapter">
              {p.chapters.length > 1 && <h3 className="passage-chapter-title">{c.label}</h3>}
              {c.verses.map((v) => {
                const notes = verseNotes(v.key);
                const open = writing === v.key;
                if (!v.v) return <div key="title" className="verse-row is-title"><div className="verse-text"><Lines text={v.text} /></div></div>;
                return (
                  <div key={v.v} className={`verse-row ${open ? 'is-writing' : ''} ${notes.length ? 'has-notes' : ''}`} data-verse={v.v}>
                    <div className="verse-text" role="button" tabIndex={0} title="Click to write a note on this verse"
                      onClick={() => { if (!getSelection()?.toString()) setWriting(open ? null : v.key); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') setWriting(open ? null : v.key); }}>
                      <sup className="verse-no">{v.v}</sup><Lines text={v.text} />
                    </div>
                    <span className="verse-tools">
                      <button type="button" className="icon-btn" onClick={() => setWriting(open ? null : v.key)} aria-label={`Note on verse ${v.v}`} title="Note on this verse"><Icon name="plus" size={14} /></button>
                      <button type="button" className={`icon-btn ${learning(v.key) ? 'is-learning' : ''}`} onClick={() => learn(v.ref)}
                        aria-label={`Learn verse ${v.v}`} title={learning(v.key) ? 'On your memory verses' : 'Add to memory verses'}><Icon name="star" size={14} /></button>
                    </span>
                    <div className="verse-margin">
                      {notes.map((n) => <VerseNote key={n.id} n={n} onOpen={() => onOpenNote(n.id)} />)}
                      {open && <NoteBox placeholder={`Note on ${v.ref}…`} onSave={(t) => addNote(c, v, t)} onCancel={() => setWriting(null)} />}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {p.esv && p.translation && <Credit passage={{ credit: p.translation.credit, translation: p.translation.label, translationId: p.translation.id }} />}
        </div>
      </div>
    </section>
  );
}

/** Poetry lines and indents as the ESV gives them. */
function Lines({ text }) {
  const lines = text.split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
  return lines.map((l, i) => (
    <span key={i} className={`verse-line ${/^\s{3,}/.test(l) ? 'is-indent' : ''} ${!l.trim() ? 'is-gap' : ''}`}>{l.trim()}</span>
  ));
}

/** A verse note beside its verse: the start of its text; click to open the note. */
function VerseNote({ n, withRef, onOpen }) {
  return (
    <button type="button" className="margin-note" onClick={onOpen} title="Open the note">
      {withRef && <strong className="margin-note-ref">{n.title}</strong>}
      <p>{n.text.length > 280 ? `${n.text.slice(0, 280)}…` : n.text}</p>
    </button>
  );
}

/** Writing a verse note: Ctrl+Enter saves, Esc cancels. */
function NoteBox({ placeholder, onSave, onCancel }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const save = () => { if (text.trim()) onSave(text.trim()); };
  return (
    <div className="margin-box">
      <textarea ref={ref} className="input" rows={3} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        }} />
      <span className="margin-box-actions">
        <span className="muted">Ctrl+Enter to save</span>
        <button type="button" className="btn btn-small" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-small btn-primary" disabled={!text.trim()} onClick={save}>Save</button>
      </span>
    </div>
  );
}
