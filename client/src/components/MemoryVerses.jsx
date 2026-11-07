import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { biblePassage } from '../esv.js';
import { useStoredState } from '../useStoredState.js';
import { parse } from '../../../shared/scripture.js';

/**
 * Memory verses: a simple list (no schedule) with three ways to practice: fading words, typing it out, and
 * reference ↔ text. Each time you get one, it counts as practiced. The list hides its words while you practice (so
 * they can't give the answer away), and whenever Hide the words is on.
 */

/** The verse's words, without verse numbers. */
export const verseWords = (text) => text.replace(/\[\d+\]/g, ' ').split(/\s+/).filter(Boolean);
/** For comparing: lower case, no punctuation (but keep apostrophes inside words), curly quotes straightened. */
const norm = (w) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');

/**
 * Word-by-word comparison of what you typed with the verse (longest common subsequence): [{ word, ok }] for the
 * verse's words (ok = typed in order) and `extra` for typed words that aren't in it.
 */
export function compareWords(expected, typed) {
  const a = expected.map(norm);
  const b = typed.map(norm).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const words = [];
  const extra = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { words.push({ word: expected[i], ok: true }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { words.push({ word: expected[i], ok: !a[i] }); i += 1; }
    else { extra.push(b[j]); j += 1; }
  }
  for (; i < a.length; i += 1) words.push({ word: expected[i], ok: !a[i] });
  for (; j < b.length; j += 1) extra.push(b[j]);
  return { words, extra, score: words.length ? words.filter((w) => w.ok).length / words.length : 0 };
}

/** A fixed shuffle for a verse, so words fade in the same order each round. */
function fadeOrder(n, seed) {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = [...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  for (let i = n - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

function useVerseText(ref) {
  const [state, setState] = useState({ ref, text: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ ref, text: null, error: null });
    if (ref) biblePassage(ref).then((p) => live && setState({ ref, text: p.text, error: null })).catch((e) => live && setState({ ref, text: null, error: e.message }));
    return () => { live = false; };
  }, [ref]);
  return state.ref === ref ? state : { ref, text: null, error: null };
}

export default function MemoryVerses({ onOpenPassage }) {
  const dialog = useDialog();
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState('');
  const [practice, setPractice] = useState(null); // { id, mode }
  const [hideWords, setHideWords] = useStoredState('noteapp.memory.hideWords', false);
  const [peek, setPeek] = useState(false); // the words shown during this practice anyway

  const load = useCallback(() => api.memoryVerses().then(setList).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    const ref = adding.trim();
    if (!ref) return;
    try {
      const r = await api.addMemoryVerse(ref);
      if (r.existing) dialog.toast('Already on your list');
      setAdding('');
      load();
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };
  const move = async (i, d) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setList(next);
    await api.orderMemoryVerses(next.map((m) => m.id));
  };
  const remove = async (m) => {
    await api.deleteMemoryVerse(m.id);
    load();
    dialog.toast(`${m.ref} taken off the list`, 'info', 6000, { label: 'Undo', onClick: async () => { await api.addMemoryVerse(m.ref); load(); } });
  };
  const practiced = async (id) => { await api.practicedMemoryVerse(id).catch(() => {}); load(); };

  if (!list) return <p className="muted">Loading…</p>;
  const current = practice && list.find((m) => m.id === practice.id);
  const hidden = current ? !peek : hideWords;
  const toggleWords = () => (current ? setPeek(!peek) : setHideWords(!hideWords));

  return (
    <div className="memory">
      <form className="memory-add" onSubmit={add}>
        <input className="input" placeholder="Add a verse to learn: Romans 8:28, Ps 23:1-3…" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Verse to learn" />
        <button className="btn btn-primary" disabled={!adding.trim() || !parse(adding).refs.length}><Icon name="plus" size={15} /> Add</button>
      </form>

      {current && (
        <Practice key={`${current.id}-${practice.mode}`} verse={current} list={list} mode={practice.mode}
          onMode={(mode) => setPractice({ ...practice, mode })} onPick={(id) => setPractice({ ...practice, id })}
          onPracticed={practiced} onClose={() => { setPractice(null); setPeek(false); }} />
      )}

      {!list.length && <p className="nb-empty">No memory verses yet. Add one above, or press ★ beside a verse when you look up a passage.</p>}
      {list.length > 0 && (
        <div className="memory-list-head">
          <span className="muted">{current && hidden ? 'The words are hidden while you practice.' : `${list.length} verse${list.length === 1 ? '' : 's'}`}</span>
          <button type="button" className="btn btn-small" onClick={toggleWords} aria-pressed={hidden}>
            <Icon name={hidden ? 'eye' : 'eyeOff'} size={14} /> {hidden ? 'Show the words' : 'Hide the words'}
          </button>
        </div>
      )}
      <ul className="memory-list">
        {list.map((m, i) => (
          <MemoryRow key={m.id} m={m} active={current?.id === m.id} hidden={hidden}
            onPractice={() => setPractice({ id: m.id, mode: practice?.mode ?? 'fade' })} onOpen={() => onOpenPassage(m.ref)}
            onUp={i > 0 ? () => move(i, -1) : null} onDown={i < list.length - 1 ? () => move(i, 1) : null} onRemove={() => remove(m)} />
        ))}
      </ul>
    </div>
  );
}

function MemoryRow({ m, active, hidden, onPractice, onOpen, onUp, onDown, onRemove }) {
  const { text, error } = useVerseText(hidden ? null : m.ref);
  return (
    <li className={`memory-row ${active ? 'is-active' : ''}`}>
      <div className="memory-main">
        <button type="button" className="link-btn memory-ref" onClick={onOpen} title="Open the passage">{m.ref}</button>
        {!hidden && <p className="memory-text">{text ? verseWords(text).join(' ') : <span className="muted">{error ?? '…'}</span>}</p>}
        <span className="muted memory-meta">{m.practiced ? `Practiced ${m.practiced} time${m.practiced === 1 ? '' : 's'}, last ${formatDate(m.practiced_at)}` : 'Not practiced yet'}</span>
      </div>
      <span className="memory-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={onPractice}>Practice</button>
        <button type="button" className="icon-btn" onClick={onUp ?? undefined} disabled={!onUp} aria-label="Move up"><Icon name="arrowUp" size={14} /></button>
        <button type="button" className="icon-btn" onClick={onDown ?? undefined} disabled={!onDown} aria-label="Move down"><Icon name="arrowDown" size={14} /></button>
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Take ${m.ref} off the list`}><Icon name="trash" size={14} /></button>
      </span>
    </li>
  );
}

const MODES = [['fade', 'Fading words'], ['type', 'Type it out'], ['ref', 'Reference ↔ text']];

function Practice({ verse, list, mode, onMode, onPick, onPracticed, onClose }) {
  const { text, error } = useVerseText(verse.ref);
  return (
    <section className="practice" aria-label="Practice">
      <div className="practice-head">
        <div className="home-tabs is-sub" role="tablist">
          {MODES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? 'is-active' : ''} onClick={() => onMode(k)}>{l}</button>)}
        </div>
        <span className="spacer" />
        {mode !== 'ref' && list.length > 1 && (
          <select className="input practice-pick" value={verse.id} onChange={(e) => onPick(Number(e.target.value))} aria-label="Verse">
            {list.map((m) => <option key={m.id} value={m.id}>{m.ref}</option>)}
          </select>
        )}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Stop practicing"><Icon name="x" size={16} /></button>
      </div>
      {mode === 'ref' ? <RefText list={list} first={verse} onPracticed={onPracticed} />
        : !text ? <p className="muted">{error ?? 'Loading…'}</p>
          : mode === 'fade' ? <Fade verse={verse} text={text} onPracticed={onPracticed} />
            : <TypeIt verse={verse} text={text} onPracticed={onPracticed} />}
    </section>
  );
}

const STEPS = 5;

/** Fading words: each round hides more of the verse until you're saying it from memory. Click a blank to peek. */
function Fade({ verse, text, onPracticed }) {
  const words = useMemo(() => verseWords(text), [text]);
  const order = useMemo(() => fadeOrder(words.length, verse.ref), [words, verse.ref]);
  const [step, setStep] = useState(0);
  const [peek, setPeek] = useState(new Set());
  const hidden = useMemo(() => new Set(order.slice(0, Math.round((words.length * step) / STEPS))), [order, words, step]);
  const go = (s) => { setStep(s); setPeek(new Set()); };
  return (
    <div className="practice-body">
      <h3 className="practice-ref">{verse.ref}</h3>
      <p className="fade-text">
        {words.map((w, i) => (hidden.has(i) && !peek.has(i)
          ? <button key={i} type="button" className="fade-blank" style={{ width: `${Math.max(2, w.length) * 0.62}em` }} onClick={() => setPeek(new Set([...peek, i]))} aria-label="Show this word" />
          : <span key={i} className={peek.has(i) ? 'fade-peeked' : ''}>{w}</span>)).reduce((out, el, i) => (i ? [...out, ' ', el] : [el]), [])}
      </p>
      <div className="practice-foot">
        <span className="muted">{step === 0 ? 'Read it through, then hide some words.' : step < STEPS ? `Round ${step} of ${STEPS}: say it, peeking only if you must.` : 'All hidden: say it from memory.'}</span>
        <span className="spacer" />
        {step > 0 && <button type="button" className="btn btn-small" onClick={() => go(step - 1)}>Show more</button>}
        {step < STEPS && <button type="button" className="btn btn-small btn-primary" onClick={() => go(step + 1)}>Hide more</button>}
        {step === STEPS && <button type="button" className="btn btn-small btn-primary" onClick={() => { onPracticed(verse.id); go(0); }}><Icon name="check" size={14} /> I said it</button>}
      </div>
    </div>
  );
}

/** Type it out, then see each word marked right or missed. */
function TypeIt({ verse, text, onPracticed }) {
  const words = useMemo(() => verseWords(text), [text]);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState(null);
  const check = () => {
    const r = compareWords(words, typed.split(/\s+/));
    setResult(r);
    if (r.score === 1 && !r.extra.length) onPracticed(verse.id);
  };
  return (
    <div className="practice-body">
      <h3 className="practice-ref">{verse.ref}</h3>
      {!result ? (
        <>
          <textarea className="input type-box" rows={4} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type the verse from memory…"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); } }} />
          <div className="practice-foot">
            <span className="muted">Punctuation and capitals don’t count. Ctrl+Enter to check.</span>
            <span className="spacer" />
            <button type="button" className="btn btn-small btn-primary" disabled={!typed.trim()} onClick={check}>Check</button>
          </div>
        </>
      ) : (
        <>
          <p className="type-result">
            {result.words.map((w, i) => <span key={i} className={w.ok ? 'is-ok' : 'is-missed'}>{w.word}</span>).reduce((out, el, i) => (i ? [...out, ' ', el] : [el]), [])}
          </p>
          {result.extra.length > 0 && <p className="muted type-extra">Not in the verse: {result.extra.join(', ')}</p>}
          <div className="practice-foot">
            <strong className={result.score === 1 && !result.extra.length ? 'type-perfect' : ''}>
              {result.score === 1 && !result.extra.length ? 'Word perfect!' : `${Math.round(result.score * 100)}% of the words`}
            </strong>
            <span className="spacer" />
            <button type="button" className="btn btn-small" onClick={() => { setResult(null); setTyped(''); }}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Reference ↔ text, through the whole list (shuffled, starting with the verse you picked): see the reference and
 * recall the words, or see the words and name the reference.
 */
function RefText({ list, first, onPracticed }) {
  const [dir, setDir] = useState('ref'); // shown: 'ref' or 'text'
  // Shuffled once (ticking one off reloads the list, which shouldn't reshuffle it).
  const ids = list.map((m) => m.id).join(',');
  const deck = useMemo(() => [first, ...list.filter((m) => m.id !== first.id).sort(() => Math.random() - 0.5)], [ids, first.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [at, setAt] = useState(0);
  const [shown, setShown] = useState(false);
  const [guess, setGuess] = useState('');
  const card = deck[at % deck.length];
  const { text, error } = useVerseText(card.ref);
  const next = () => { setAt(at + 1); setShown(false); setGuess(''); };
  const g = parse(guess).refs;
  const target = parse(card.ref).refs[0];
  const right = g.length === 1 && target && g[0].start === target.start && g[0].end === target.end;
  return (
    <div className="practice-body">
      <div className="practice-dir">
        <label><input type="radio" checked={dir === 'ref'} onChange={() => { setDir('ref'); setShown(false); }} /> See the reference, say the verse</label>
        <label><input type="radio" checked={dir === 'text'} onChange={() => { setDir('text'); setShown(false); }} /> See the verse, name the reference</label>
      </div>
      {dir === 'ref' ? (
        <>
          <h3 className="practice-ref is-big">{card.ref}</h3>
          {shown && <p className="practice-answer">{text ? verseWords(text).join(' ') : error ?? '…'}</p>}
        </>
      ) : (
        <>
          <p className="practice-answer">{text ? verseWords(text).join(' ') : error ?? '…'}</p>
          <input className="input ref-guess" value={guess} onChange={(e) => setGuess(e.target.value)} placeholder="Which verse is it?" aria-label="Your answer"
            onKeyDown={(e) => { if (e.key === 'Enter') setShown(true); }} />
          {shown && <p className={`ref-check ${guess.trim() ? (right ? 'is-ok' : 'is-missed') : ''}`}>{guess.trim() ? (right ? 'Right: ' : 'It’s ') : ''}<strong>{card.ref}</strong></p>}
        </>
      )}
      <div className="practice-foot">
        <span className="muted">{deck.length > 1 ? `${(at % deck.length) + 1} of ${deck.length}` : ''}</span>
        <span className="spacer" />
        {!shown ? <button type="button" className="btn btn-small btn-primary" onClick={() => setShown(true)}>Show the answer</button> : (
          <>
            <button type="button" className="btn btn-small" onClick={next}>Again later</button>
            <button type="button" className="btn btn-small btn-primary" onClick={() => { onPracticed(card.id); next(); }}><Icon name="check" size={14} /> I knew it</button>
          </>
        )}
      </div>
    </div>
  );
}
