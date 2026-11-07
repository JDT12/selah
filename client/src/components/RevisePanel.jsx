import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { reviseKey } from '../editor/ReviseMarks.js';
import { KINDS, PAPER_KINDS, docBlocks, gradeLabel, readingSentences } from '../revise.js';
import { wordDiff } from '../wordDiff.js';
import { methodById } from '../../../shared/methods.js';

const DEFAULTS = { kinds: ['long', 'passive', 'filler', 'hedge', 'repeat', 'pet'], longLimit: 30, pet: [] };
const n = (x) => Math.round(x).toLocaleString();
const htmlText = (html) => {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  body.querySelectorAll('p, li, h1, h2, h3, h4, blockquote').forEach((el) => el.append('\n'));
  return body.textContent.replace(/\n{3,}/g, '\n\n').trim();
};
const draftName = (v) => (v.reason ?? '').replace(/^Draft:\s*/, '') || 'Draft';

/**
 * Beside the note while revising (6.6): what the rule-based checks in revise.js see, as highlights you can turn on
 * and off, with figures, paragraphs to look at first when cutting, drafts to compare, the method's questions, and
 * read aloud. It points and asks; it never offers wording, so the ideas and the words stay yours.
 */
export default function RevisePanel({ editor, noteId, method, flush, readOnly, onClose }) {
  const dialog = useDialog();
  const [tab, setTab] = useState('overview');
  const [prefs, setPrefs] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const [, setTick] = useState(0);
  const [current, setCurrent] = useState(null);
  const paper = method?.method === 'paper';
  const m = methodById(method?.method);
  const kinds = paper ? [...KINDS, ...PAPER_KINDS] : KINDS;

  // Settings follow you (a server pref); dismissals are kept per note.
  useEffect(() => {
    api.getPref('revise').then((v) => setPrefs({ ...DEFAULTS, ...(v ?? {}) })).catch(() => setPrefs(DEFAULTS));
    api.getPref(`reviseDismissed-${noteId}`).then((v) => setDismissed(new Set(Array.isArray(v) ? v : []))).catch(() => setDismissed(new Set()));
  }, [noteId]);
  const savePrefs = (next) => { setPrefs(next); api.setPref('revise', next).catch(() => {}); };

  // Turn the highlights on with these settings, and off when the panel closes.
  useEffect(() => {
    if (!editor || !prefs || !dismissed) return undefined;
    const on = new Set([...prefs.kinds, ...(paper ? PAPER_KINDS.map((k) => k.key) : [])]);
    editor.view.dispatch(editor.state.tr.setMeta(reviseKey, { on: true, kinds: on, opts: { longLimit: prefs.longLimit, pet: prefs.pet, paper }, dismissed, current }));
    return undefined;
  }, [editor, prefs, dismissed, paper, current]);
  useEffect(() => () => {
    window.speechSynthesis?.cancel();
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(reviseKey, { on: false, reading: null, current: null }));
  }, [editor]);
  // Follow the note as it changes (redraw at most once a frame).
  useEffect(() => {
    if (!editor) return undefined;
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick((t) => t + 1)); };
    editor.on('transaction', on);
    editor.storage.reviseMarks.onPick = (issue) => { setCurrent(issue); setTab('marks'); };
    return () => { editor.off('transaction', on); cancelAnimationFrame(raf); if (editor.storage.reviseMarks) editor.storage.reviseMarks.onPick = null; };
  }, [editor]);

  const state = editor ? reviseKey.getState(editor.state) : null;
  const result = state?.result ?? { issues: [], stats: null, paragraphs: [] };
  const visible = result.issues.filter((i) => state?.kinds.has(i.kind) && !dismissed?.has(i.key));
  const countOf = (k) => result.issues.filter((i) => i.kind === k && !dismissed?.has(i.key)).length;

  const show = (from, to = from) => {
    if (!editor) return;
    editor.chain().setTextSelection({ from, to }).run();
    requestAnimationFrame(() => {
      const { node } = editor.view.domAtPos(from);
      (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
  };
  const go = (by) => {
    if (!visible.length) return;
    const at = current ? visible.findIndex((i) => i.key === current.key && i.from === current.from) : -1;
    const next = visible[(at + by + visible.length) % visible.length];
    setCurrent(next);
    show(next.from, next.to);
  };
  const dismiss = (issue) => {
    const next = new Set(dismissed);
    next.add(issue.key);
    setDismissed(next);
    api.setPref(`reviseDismissed-${noteId}`, [...next].slice(-500)).catch(() => {});
    const at = visible.findIndex((i) => i === issue);
    setCurrent(visible[at + 1] ?? null);
  };
  const undismissAll = () => { setDismissed(new Set()); api.setPref(`reviseDismissed-${noteId}`, []).catch(() => {}); };
  const toggleKind = (k) => savePrefs({ ...prefs, kinds: prefs.kinds.includes(k) ? prefs.kinds.filter((x) => x !== k) : [...prefs.kinds, k] });

  if (!prefs || !dismissed) return <aside className="sources-panel revise-panel"><p className="muted revise-pad">Loading…</p></aside>;
  const tabs = [['overview', 'Overview'], ['marks', 'Highlights'], ['cut', 'Cut'], ['drafts', 'Drafts'], ...(m?.sections.some((s) => s.ask) ? [['structure', 'Structure']] : [])];
  return (
    <aside className="sources-panel revise-panel" aria-label="Revise">
      <div className="sources-head">
        <strong>Revise</strong>
        <ReadAloud editor={editor} />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Revise"><Icon name="x" size={16} /></button>
      </div>
      <div className="segmented revise-tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="revise-body">
        {tab === 'overview' && <Overview stats={result.stats} kinds={kinds} countOf={countOf} noteId={noteId} editor={editor} onKind={() => setTab('marks')} />}
        {tab === 'marks' && (
          <>
            {current && (
              <div className={`revise-card rv-card-${current.kind}`}>
                <span className="revise-card-kind">{kinds.find((k) => k.key === current.kind)?.label}</span>
                <q>{current.text.length > 140 ? `${current.text.slice(0, 140)}…` : current.text}</q>
                <p>{current.why}</p>
                <div className="revise-card-actions">
                  <button type="button" className="btn btn-small" onClick={() => go(-1)} aria-label="Previous"><Icon name="chevronLeft" size={13} /></button>
                  <button type="button" className="btn btn-small" onClick={() => go(1)} aria-label="Next"><Icon name="chevronRight" size={13} /></button>
                  <span className="spacer" />
                  <button type="button" className="btn btn-small" onClick={() => dismiss(current)}>Dismiss</button>
                </div>
              </div>
            )}
            {!current && <p className="muted revise-hint">Click a highlight in the note to see why it’s marked, or step through them.{visible.length > 0 && <> <button type="button" className="link-btn" onClick={() => go(1)}>Start at the first</button></>}</p>}
            <ul className="revise-kinds">
              {kinds.map((k) => (
                <li key={k.key}>
                  <label className="check-row">
                    <input type="checkbox" checked={state?.kinds.has(k.key) ?? false} disabled={PAPER_KINDS.some((p) => p.key === k.key)} onChange={() => toggleKind(k.key)} />
                    <span className={`rv-swatch rv-${k.key}`} />
                    <span>{k.label}</span>
                    <span className="revise-count">{countOf(k.key)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {paper && <p className="muted revise-hint">Paper checks follow Turabian (notes-bibliography) and are always on for a research paper.</p>}
            <details className="revise-settings">
              <summary>Settings</summary>
              <label className="field">Long sentence after
                <span className="revise-inline"><input className="input" type="number" min="12" max="80" value={prefs.longLimit} onChange={(e) => savePrefs({ ...prefs, longLimit: Math.max(12, Math.min(80, Number(e.target.value) || 30)) })} /> words</span>
              </label>
              <label className="field">Your words to watch <span className="muted">(one per line: words you lean on)</span>
                <textarea className="input" rows={3} defaultValue={prefs.pet.join('\n')} onBlur={(e) => savePrefs({ ...prefs, pet: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100) })} />
              </label>
              {dismissed.size > 0 && <button type="button" className="link-btn" onClick={undismissAll}>Show the {dismissed.size} dismissed again</button>}
            </details>
            <p className="muted revise-hint">Quotations, block quotes and citations aren’t checked. These are rules, not judgments: keep anything that’s right for what you mean.</p>
          </>
        )}
        {tab === 'cut' && <Cut stats={result.stats} paragraphs={result.paragraphs} show={show} />}
        {tab === 'drafts' && <Drafts noteId={noteId} flush={flush} readOnly={readOnly} editor={editor} />}
        {tab === 'structure' && <Structure method={m} editor={editor} show={show} />}
      </div>
    </aside>
  );
}

function Overview({ stats, kinds, countOf, noteId, editor, onKind }) {
  const [since, setSince] = useState(null);
  // Words changed since the last draft you marked.
  useEffect(() => {
    let live = true;
    api.noteVersions(noteId).then(async (list) => {
      const last = list.find((v) => /^Draft:/.test(v.reason ?? ''));
      if (!last || !live) return;
      const v = await api.noteVersion(noteId, last.id);
      if (live) setSince({ name: draftName(last), html: v.html });
    }).catch(() => {});
    return () => { live = false; };
  }, [noteId]);
  const changed = useMemo(() => {
    if (!since || !editor) return null;
    const runs = wordDiff(htmlText(since.html), htmlText(editor.getHTML()));
    const count = (t) => runs.filter((r) => r.type === t).reduce((s, r) => s + (r.text.match(/[\p{L}\p{N}]+/gu) ?? []).length, 0);
    return { added: count('add'), removed: count('del') };
  }, [since, editor, stats]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stats) return <p className="muted">Reading the note…</p>;
  return (
    <div className="revise-overview">
      <dl className="revise-stats">
        <div><dt>Words</dt><dd>{n(stats.words)}</dd></div>
        <div><dt>Reading time</dt><dd>{stats.minutes < 1 ? 'under a minute' : `${Math.round(stats.minutes)} min`}</dd></div>
        <div><dt>Sentences</dt><dd>{n(stats.sentences)}</dd></div>
        <div><dt>Average sentence</dt><dd>{stats.avgSentence ? `${stats.avgSentence.toFixed(1)} words` : '—'}</dd></div>
        <div className="wide"><dt>Reading level</dt><dd>{gradeLabel(stats.grade)}</dd></div>
        {changed && <div className="wide"><dt>Since “{since.name}”</dt><dd><span className="rv-added">+{n(changed.added)}</span> <span className="rv-removed">−{n(changed.removed)}</span> words</dd></div>}
      </dl>
      {stats.words > stats.prose && <p className="muted revise-hint">{n(stats.words - stats.prose)} words in quotations and headings aren’t counted in the reading level.</p>}
      <h4>Marked</h4>
      <ul className="revise-tally">
        {kinds.map((k) => countOf(k.key) > 0 && (
          <li key={k.key}><button type="button" className="link-btn" onClick={onKind}><span className={`rv-swatch rv-${k.key}`} /> {k.label}</button><span>{countOf(k.key)}</span></li>
        ))}
      </ul>
      {!kinds.some((k) => countOf(k.key)) && <p className="muted">Nothing marked.</p>}
      <p className="muted revise-hint">The reading level is the Flesch–Kincaid grade: it counts words per sentence and syllables per word, nothing about meaning.</p>
    </div>
  );
}

function Cut({ stats, paragraphs, show }) {
  const [pct, setPct] = useState(10);
  const [base, setBase] = useState(null);
  // The target is set from the length when you start (or change the percentage), and the counter follows your cuts.
  useEffect(() => { if (stats && base === null) setBase(stats.words); }, [stats, base]);
  if (!stats || base === null) return <p className="muted">Reading the note…</p>;
  const target = Math.round(base * (1 - pct / 100));
  const left = Math.max(0, stats.words - target);
  return (
    <div className="revise-cut">
      <div className="revise-cut-head">
        <label>Cut
          <select className="input" value={pct} onChange={(e) => { setPct(Number(e.target.value)); setBase(stats.words); }}>
            {[5, 10, 15, 20, 25].map((x) => <option key={x} value={x}>{x}%</option>)}
          </select>
        </label>
        <span className="muted">{n(base)} → {n(target)} words</span>
      </div>
      <div className="study-bar" role="progressbar" aria-valuenow={Math.round(Math.min(100, ((base - stats.words) / Math.max(1, base - target)) * 100))}>
        <span style={{ width: `${Math.min(100, Math.max(0, ((base - stats.words) / Math.max(1, base - target)) * 100))}%` }} />
      </div>
      <p className={left ? 'revise-left' : 'revise-left is-done'}>{left ? `${n(left)} words to go` : 'Target reached'}</p>
      <h4>Look here first</h4>
      <p className="muted revise-hint">Paragraphs with the most marked per hundred words: filler, hedges, long sentences, repeats. What to cut is yours to decide.</p>
      <ol className="revise-paras">
        {paragraphs.slice(0, 8).map((p) => (
          <li key={p.start}>
            <button type="button" onClick={() => show(p.start, p.end)}>
              <span className="revise-para-text">{p.snippet}{p.snippet.length >= 120 ? '…' : ''}</span>
              <span className="muted">{p.section ? `${p.section} · ` : ''}{n(p.words)} words</span>
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="link-btn" onClick={() => setBase(stats.words)}>Start counting from now</button>
    </div>
  );
}

function Drafts({ noteId, flush, readOnly, editor }) {
  const dialog = useDialog();
  const [drafts, setDrafts] = useState(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('now');
  const [diff, setDiff] = useState(null);
  const load = () => api.noteVersions(noteId).then((list) => {
    const d = list.filter((v) => /^Draft:/.test(v.reason ?? ''));
    setDrafts(d);
    if (!a && d[0]) setA(String(d[0].id));
  }).catch(() => setDrafts([]));
  useEffect(() => { load(); }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = async () => {
    const name = await dialog.prompt({ title: 'Mark This Draft', label: 'Name', value: `Draft ${(drafts?.length ?? 0) + 1}`, okLabel: 'Mark' });
    if (!name) return;
    try {
      await flush();
      await api.snapshotNote(noteId, `Draft: ${name.trim().slice(0, 70)}`);
      dialog.toast(`Marked “${name}”`);
      load();
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const compare = async () => {
    const text = async (id) => (id === 'now' ? htmlText(editor.getHTML()) : htmlText((await api.noteVersion(noteId, Number(id))).html));
    try {
      const [x, y] = await Promise.all([text(a), text(b)]);
      const runs = wordDiff(x, y);
      const count = (t) => runs.filter((r) => r.type === t).reduce((s, r) => s + (r.text.match(/[\p{L}\p{N}]+/gu) ?? []).length, 0);
      setDiff({ runs, added: count('add'), removed: count('del') });
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  if (!drafts) return <p className="muted">Loading drafts…</p>;
  const label = (v) => `${draftName(v)} · ${formatDate(v.created_at)}`;
  return (
    <div className="revise-drafts">
      <p className="muted revise-hint">Mark a draft when you finish a pass. Marked drafts are kept for good in the note’s version history, so you can compare any two.</p>
      {!readOnly && <button type="button" className="btn btn-small btn-primary" onClick={mark}><Icon name="flag" size={13} /> Mark this draft…</button>}
      {drafts.length > 0 && (
        <>
          <ul className="revise-draft-list">{drafts.map((v) => <li key={v.id}><Icon name="flag" size={12} /> {label(v)}</li>)}</ul>
          <div className="revise-compare">
            <select className="input" value={a} onChange={(e) => setA(e.target.value)} aria-label="Compare from">
              {drafts.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="input" value={b} onChange={(e) => setB(e.target.value)} aria-label="Compare to">
              <option value="now">Now</option>
              {drafts.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
            </select>
            <button type="button" className="btn btn-small" onClick={compare} disabled={!a || a === b}>Compare</button>
          </div>
        </>
      )}
      {diff && (
        <div className="revise-diff">
          <p><span className="rv-added">+{n(diff.added)}</span> <span className="rv-removed">−{n(diff.removed)}</span> words</p>
          <div className="revise-diff-text">
            {diff.runs.map((r, i) => (r.type === 'same' ? <span key={i}>{r.text}</span> : r.type === 'add' ? <ins key={i}>{r.text}</ins> : <del key={i}>{r.text}</del>))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The method's sections, each with the question it answers and how much you've written there. */
function Structure({ method, editor, show }) {
  const blocks = editor ? docBlocks(editor.state.doc) : [];
  const headings = blocks.filter((b) => b.heading);
  return (
    <div className="revise-structure">
      <p className="muted revise-hint">{method.name}: the question each part answers. The answers are yours.</p>
      <ol>
        {method.sections.filter((s) => s.ask).map((s) => {
          const h = headings.find((x) => s.match.test(x.text.trim()));
          const words = h ? blocks.filter((b) => !b.heading && b.section === h.text.trim()).reduce((t, b) => t + (b.text.match(/[\p{L}\p{N}]+/gu) ?? []).length, 0) : 0;
          return (
            <li key={s.title} className={h ? (words ? 'is-written' : 'is-empty') : 'is-missing'}>
              <button type="button" disabled={!h} onClick={() => h && show(h.start)}>
                <strong>{s.title}</strong>
                <span className="muted">{h ? (words ? `${words.toLocaleString()} words` : 'Not started') : 'No heading for it yet'}</span>
              </button>
              <p>{s.ask}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Read aloud from the cursor with the browser's own voice, highlighting each sentence as it's read. */
function ReadAloud({ editor }) {
  const [on, setOn] = useState(false);
  const stop = useRef(false);
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  useEffect(() => () => { stop.current = true; synth?.cancel(); }, [synth]);
  if (!synth) return null;
  const mark = (reading) => editor && !editor.isDestroyed && editor.view.dispatch(editor.state.tr.setMeta(reviseKey, { reading }));
  const start = () => {
    const blocks = docBlocks(editor.state.doc);
    // From the cursor, or from the top when the cursor is at the end.
    let list = readingSentences(blocks, editor.state.selection.from === 1 ? 0 : editor.state.selection.from);
    if (!list.length) list = readingSentences(blocks, 0);
    if (!list.length) return;
    stop.current = false;
    setOn(true);
    let i = 0;
    const next = () => {
      if (stop.current || i >= list.length) { setOn(false); mark(null); return; }
      const s = list[i];
      i += 1;
      mark({ from: s.from, to: s.to });
      const u = new SpeechSynthesisUtterance(s.text);
      u.rate = 1;
      u.onend = next;
      u.onerror = () => { setOn(false); mark(null); };
      synth.speak(u);
    };
    synth.cancel();
    next();
  };
  const end = () => { stop.current = true; synth.cancel(); setOn(false); mark(null); };
  return (
    <button type="button" className={`btn btn-small revise-read ${on ? 'is-on' : ''}`} onClick={on ? end : start} title={on ? 'Stop reading' : 'Read aloud from the cursor'}>
      <Icon name={on ? 'stop' : 'play'} size={12} /> {on ? 'Stop' : 'Read aloud'}
    </button>
  );
}

