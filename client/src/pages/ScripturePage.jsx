import { useCallback, useEffect, useState } from 'react';
import { api, formatDate } from '../api.js';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { parse } from '../../../shared/scripture.js';
import PassageView from '../components/PassageView.jsx';
import MemoryVerses from '../components/MemoryVerses.jsx';
import { BibleStudies, WeekReview } from '../components/StudyReview.jsx';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Scripture: look up a passage (its text, in a translation picked on the page, with your verse notes, studies, sermons and the notes that mention it),
 * browse books and chapters (a coverage map of the chapters you've studied), your Bible studies, the weekly review
 * and the memory verse list. Typing words instead of a reference searches your notes.
 */
export default function ScripturePage({ onOpenNote, onPeekNote, onMenu, initialQuery }) {
  const dialog = useDialog();
  // Coming back to Scripture starts on its home view: Passages, no book open.
  const [tab, setTab] = useState('passages');
  const [summary, setSummary] = useState(null);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [bookOrder, setBookOrder] = useState(null);
  const [passage, setPassage] = useState(null); // the reference being read
  const [result, setResult] = useState(null); // { title, query, notes, errors }
  const [wordHits, setWordHits] = useState(null); // { q, notes }
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(() => api.scriptureSummary().then(setSummary).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => {
    loadSummary();
    window.addEventListener('noteapp:notes-changed', loadSummary);
    return () => window.removeEventListener('noteapp:notes-changed', loadSummary);
  }, [loadSummary]);

  const show = useCallback(async (params, title) => {
    setBusy(true);
    try {
      const r = await api.scriptureNotes(params);
      setResult({ ...r, title: title ?? r.query.join('; ') });
    } catch (e) {
      dialog.toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [dialog]);
  /** Read a passage: its text and everything written on it. */
  const open = useCallback((q) => {
    setTab('passages');
    setWordHits(null);
    setResult(null);
    setQuery(q);
    setPassage(q);
    document.querySelector('.scripture-page')?.scrollTo?.({ top: 0 });
  }, [setTab]);
  useEffect(() => { if (initialQuery) open(initialQuery); }, [initialQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (parse(q).refs.length) { open(q); return; }
    // Not a reference: look for it in your notes.
    setPassage(null);
    setResult(null);
    try {
      setWordHits({ q, notes: await api.listNotes({ q, rank: 1, limit: 30 }) });
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };
  const close = () => { setPassage(null); setResult(null); };
  const selected = summary?.books.find((b) => b.order === bookOrder);

  return (
    <div className="page scripture-page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Scripture</h1>
          <p className="muted">{summary ? `${plural(summary.total, 'note')} mention Scripture` : '…'}</p>
        </div>
      </header>

      <div className="home-tabs scripture-tabs" role="tablist" aria-label="Bible">
        {[['passages', 'Passages'], ['studies', 'Bible Studies'], ['week', 'This Week'], ['memory', 'Memory Verses']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'memory' && <MemoryVerses onOpenPassage={open} />}
      {tab === 'studies' && <BibleStudies onOpenNote={onPeekNote ?? onOpenNote} onOpenPassage={open} />}
      {tab === 'week' && <WeekReview onOpenNote={onPeekNote ?? onOpenNote} onOpenPassage={open} />}
      {tab === 'passages' && (<>
      <form className="scripture-search" onSubmit={search}>
        <label className="nb-search">
          <Icon name="search" size={16} className="muted" />
          <input placeholder="Read a passage (Romans 8:28-39, Ps 23) or search your notes…" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Passage" />
        </label>
        <button className="btn btn-primary" disabled={!query.trim() || busy}>Go</button>
      </form>

      {wordHits && (
        <section className="scripture-results">
          <div className="scripture-results-head">
            <h2>Notes: “{wordHits.q}”</h2>
            <span className="muted">{plural(wordHits.notes.length, 'note')}</span>
            <button className="icon-btn" onClick={() => setWordHits(null)} aria-label="Close results"><Icon name="x" size={16} /></button>
          </div>
          {!wordHits.notes.length && <p className="muted">No notes say that. To read a passage, type a reference like John 3:16.</p>}
          {wordHits.notes.map((n) => (
            <button key={n.id} type="button" className="scripture-note" onClick={() => (onPeekNote ?? onOpenNote)(n.id)}>
              <span className="scripture-note-title">{n.title || 'Untitled'}</span>
              <span className="scripture-note-meta">{formatDate(n.updated_at)}</span>
            </button>
          ))}
        </section>
      )}

      {passage && <PassageView key={passage} query={passage} onQuery={open} onOpenNote={onPeekNote ?? onOpenNote} onClose={close} />}

      {result && !passage && (
        <section className="scripture-results">
          <div className="scripture-results-head">
            <h2>{result.title || 'Results'}</h2>
            <span className="muted">{plural(result.notes.length, 'note')}</span>
            <button className="icon-btn" onClick={() => setResult(null)} aria-label="Close results"><Icon name="x" size={16} /></button>
          </div>
          {result.errors?.length > 0 && <p className="form-error">{result.errors.join('. ')}</p>}
          {result.notes.length === 0 && !result.errors?.length && <p className="muted">No notes mention this passage yet.</p>}
          {result.notes.map((n) => (
            <button key={n.id} type="button" className="scripture-note" onClick={() => onOpenNote(n.id)}>
              <span className="scripture-note-title">{n.title || 'Untitled'}</span>
              <span className="scripture-note-refs">{n.refs.join(' · ')}</span>
              <span className="scripture-note-meta">{formatDate(n.updated_at)}{n.notebook ? ` · ${n.notebook}` : ''}</span>
            </button>
          ))}
        </section>
      )}

      {selected ? (
        <section className="scripture-book">
          <div className="scripture-results-head">
            <button className="btn btn-small" onClick={() => setBookOrder(null)}><Icon name="chevronLeft" size={14} /> All books</button>
            <h2>{selected.name}</h2>
            <span className="muted">{plural(selected.notes, 'note')} · {selected.studied.length} of {plural(selected.chapters, 'chapter')} studied</span>
            <button className="btn btn-small" onClick={() => { setPassage(null); show({ book: selected.order }, selected.name); }}>All notes on {selected.name}</button>
          </div>
          <div className="chapter-grid">
            {Array.from({ length: selected.chapters }, (_, i) => i + 1).map((ch) => {
              const count = selected.chapterNotes[ch] ?? 0;
              const studied = selected.studied.includes(ch);
              return (
                <button key={ch} type="button" className={`chapter-cell ${count ? 'has-notes' : ''} ${studied ? 'is-studied' : ''}`}
                  onClick={() => open(selected.chapters === 1 ? selected.name : `${selected.order === 19 ? 'Psalm' : selected.name} ${ch}`)}
                  title={[studied && 'Studied', count && plural(count, 'note'), 'Read it'].filter(Boolean).join(' · ')}>
                  <span>{ch}</span>{count > 0 && <small>{count}</small>}
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        summary && (<>
          <Coverage summary={summary} />
          {['OT', 'NT'].map((t) => (
            <section key={t} className="scripture-testament">
              <h2>{t === 'OT' ? 'Old Testament' : 'New Testament'}</h2>
              <div className="book-grid">
                {summary.books.filter((b) => b.testament === t).map((b) => (
                  <button key={b.order} type="button" className={`book-cell ${b.notes ? 'has-notes' : ''} ${b.studied.length ? 'is-studied' : ''}`} onClick={() => setBookOrder(b.order)}
                    title={b.studied.length ? `${b.studied.length} of ${plural(b.chapters, 'chapter')} studied` : undefined}>
                    <span className="book-cell-name">{b.name}</span>
                    <span className="book-cell-count">{b.notes || ''}</span>
                    {b.studied.length > 0 && <span className="book-cell-bar" style={{ '--done': `${Math.max(4, (b.studied.length / b.chapters) * 100)}%` }} />}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>)
      )}
      </>)}
    </div>
  );
}

/** The coverage map's key: how much of the Bible your studies have covered so far. */
function Coverage({ summary }) {
  const studied = summary.books.reduce((n, b) => n + b.studied.length, 0);
  const total = summary.books.reduce((n, b) => n + b.chapters, 0);
  const books = summary.books.filter((b) => b.studied.length).length;
  return (
    <div className="coverage-key">
      <span className="coverage-title"><strong>{studied ? plural(studied, 'chapter') : 'No chapters'}</strong> studied{books ? ` in ${plural(books, 'book')}` : ''}</span>
      <span className="coverage-bar" style={{ '--done': `${(studied / total) * 100}%` }} aria-hidden="true" />
      <span className="coverage-legend"><i className="is-studied" /> Studied <i className="has-notes" /> Mentioned in notes</span>
    </div>
  );
}
