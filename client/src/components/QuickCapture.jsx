import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { parseCapture } from '../captureParse.js';
import { parseTask } from '../taskParse.js';
import { todayStr, relativeDay } from '../time.js';
import { RecorderDialog, canCapture } from './MediaCapture.jsx';
import { BANK_KINDS, canQueue, isOffline, queueCapture, readPhotoText, saveCapture } from '../captureSave.js';
import { canDictate, hasCamera, nativePhoto, startDictation } from '../mobile.js';
import { device } from '../device.js';

const openNote = (id) => window.dispatchEvent(new CustomEvent('noteapp:open-note', { detail: id }));
const DEST_KEY = 'selah.capture.dest';
const KIND_KEY = 'selah.capture.bankKind';
const stored = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* it just won't be remembered */ } };
const QUEUED = 'Saved on this device. It’s sent when you’re back online.';

/** Saves a capture, or keeps it on the device when there's no connection. Resolves to the result, 'queued' or null. */
async function saveOrQueue(c, dialog, ctx) {
  if (!navigator.onLine && canQueue()) {
    await queueCapture(c);
    dialog.toast(QUEUED);
    return 'queued';
  }
  try {
    return await saveCapture(c, ctx);
  } catch (e) {
    if (isOffline(e) && canQueue()) {
      await queueCapture(c);
      dialog.toast(QUEUED);
      return 'queued';
    }
    throw e;
  }
}

/** Records a voice memo and saves it to the Inbox; returns the note's id ('queued' offline, null if nothing was saved). */
export async function recordVoiceMemo(dialog) {
  if (!canCapture() || !window.MediaRecorder) {
    dialog.toast('This browser cannot record audio.', 'error');
    return null;
  }
  const file = await dialog.open((close) => <RecorderDialog close={close} />, { dismissable: false });
  if (!file) return null;
  const t = dialog.toast('Saving voice memo…', 'info', 0);
  try {
    const r = await saveOrQueue({ text: '', dest: 'inbox', files: [{ blob: file, name: file.name, type: file.type, recording: true }] }, dialog);
    t.close();
    if (r === 'queued') return 'queued';
    window.dispatchEvent(new Event('noteapp:notes-changed'));
    return r.id;
  } catch (e) {
    t.close();
    dialog.toast(e.message, 'error');
    return null;
  }
}

/**
 * Alt+N, the + button on a phone, and the app icon's quick actions: a box for a quick thought, to the Inbox or the
 * sermon bank. #tag, @Notebook and !task are picked out as you type. A voice memo or photo can go with it; a photo's
 * words are read into the box. With no connection the app keeps it on the device until it can be sent.
 * `start` begins with 'photo', 'library' or 'dictate'. `onSaved(id, kind)` runs afterwards ('note', 'task' or 'bank').
 */
export default function QuickCapture({ tree, close, onSaved, start = null }) {
  const dialog = useDialog();
  const [text, setText] = useState('');
  const [dest, setDest] = useState(() => stored(DEST_KEY, 'inbox'));
  const [bankKind, setBankKind] = useState(() => stored(KIND_KEY, 'illustration'));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [listening, setListening] = useState(null); // the stop() for dictation
  const [lists, setLists] = useState([]);
  const ref = useRef(null);
  const fileRef = useRef(null);
  const enterSaves = device.full;
  useEffect(() => { api.listTaskLists().then(setLists).catch(() => {}); }, []);
  useEffect(() => { if (!start) ref.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => listening?.(), [listening]);

  const bank = dest === 'bank';
  const parsed = useMemo(() => parseCapture(text, bank ? [] : tree.notebooks), [text, tree.notebooks, bank]);
  const task = useMemo(() => (!bank && parsed.task ? parseTask(parsed.taskText, { today: todayStr(), lists }) : null), [parsed, lists, bank]);
  const recording = files.some((f) => f.recording);
  const canSave = (text.trim() || (!bank && files.length) || files.some((f) => f.ocr)) && !busy && !reading;

  const pickDest = (d) => { setDest(d); store(DEST_KEY, d); };
  const pickKind = (k) => { setBankKind(k); store(KIND_KEY, k); };
  const append = (more) => setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${more}` : more));

  const save = async () => {
    if (!canSave) return;
    listening?.();
    setBusy(true);
    try {
      const c = { text, dest, bankKind, files: bank ? files.filter((f) => f.ocr) : files };
      const r = await saveOrQueue(c, dialog, { notebooks: tree.notebooks, lists });
      close();
      if (r === 'queued') return;
      if (r.kind === 'task') dialog.toast('Task added');
      else if (r.kind === 'bank') dialog.toast('Saved to the sermon bank');
      else {
        dialog.toast(`Saved to ${r.where}`, 'info', 5000, { label: 'Open', onClick: () => openNote(r.id) });
        window.dispatchEvent(new Event('noteapp:notes-changed'));
      }
      onSaved?.(r.id, r.kind);
    } catch (e) {
      dialog.toast(e.message, 'error');
      setBusy(false);
    }
  };

  const voice = async () => {
    if (!canCapture() || !window.MediaRecorder) { dialog.toast('This browser cannot record audio.', 'error'); return; }
    const file = await dialog.open((c) => <RecorderDialog close={c} />, { dismissable: false });
    if (file) setFiles((f) => [...f.filter((x) => !x.recording), { blob: file, name: file.name, type: file.type, recording: true }]);
  };

  /** A photo joins the capture and its words go into the box (or, offline, are read when it's sent). */
  const addPhoto = async (file) => {
    if (!file) return;
    const entry = { blob: file, name: file.name || 'photo.jpg', type: file.type || 'image/jpeg', photo: true, ocr: false };
    if (!navigator.onLine) {
      setFiles((f) => [...f, { ...entry, ocr: true }]);
      return;
    }
    setFiles((f) => [...f, entry]);
    setReading(true);
    try {
      const words = await readPhotoText(file);
      if (words) append(words);
      else dialog.toast('No words found in that photo.');
    } catch (e) {
      if (isOffline(e)) setFiles((f) => f.map((x) => (x === entry ? { ...x, ocr: true } : x)));
      else dialog.toast(e.message, 'error');
    }
    setReading(false);
  };
  const photoFrom = async (source) => {
    try { await addPhoto(await nativePhoto(source)); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const photo = (e) => {
    if (!hasCamera()) { fileRef.current?.click(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    dialog.contextMenu({ clientX: r.left, clientY: r.top - 4, preventDefault() {}, stopPropagation() {} }, [
      { label: 'Take a photo', onClick: () => photoFrom('camera') },
      { label: 'Choose a photo', onClick: () => photoFrom('library') },
    ]);
  };

  const dictate = async () => {
    if (listening) { listening(); return; }
    const base = text.trim() ? `${text.replace(/\s+$/, '')} ` : '';
    try {
      const stop = await startDictation({
        onText: (words) => setText(base + words),
        onEnd: () => setListening(null),
      });
      setListening(() => stop);
    } catch (e) { dialog.toast(e.message, 'error'); }
  };

  useEffect(() => {
    if (start === 'photo' || start === 'library') { if (hasCamera()) photoFrom(start === 'library' ? 'library' : 'camera'); else fileRef.current?.click(); }
    if (start === 'dictate' && canDictate()) dictate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`capture-box ${bank ? 'is-bank' : ''}`}>
      <div className="capture-head">
        <Icon name="bolt" size={16} />
        <span>Quick capture</span>
        <span className="spacer" />
        <div className="segmented capture-dest" role="group" aria-label="Save to">
          <button type="button" className={bank ? '' : 'is-active'} aria-pressed={!bank} onClick={() => pickDest('inbox')}>Inbox</button>
          <button type="button" className={bank ? 'is-active' : ''} aria-pressed={bank} onClick={() => pickDest('bank')}>Sermon bank</button>
        </div>
      </div>
      <textarea ref={ref} className="capture-input" rows={device.phone ? 5 : 3} value={text} disabled={busy}
        placeholder={bank ? 'An illustration, a quote, an idea…\n#topic' : 'A thought, a link, a to-do…\n#tag  @Notebook  !task'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (enterSaves && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } }} />
      <div className="capture-chips" aria-live="polite">
        {bank ? (
          <>
            <select className="capture-kind" value={bankKind} onChange={(e) => pickKind(e.target.value)} aria-label="Kind">
              {BANK_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {parsed.tags.map((t) => <span key={t} className="capture-chip"><Icon name="tag" size={13} /> {t}</span>)}
          </>
        ) : parsed.task && !files.length ? (
          <>
            <span className="capture-chip is-task"><Icon name="todo" size={13} /> Task</span>
            {task?.due_date && <span className="capture-chip"><Icon name="calendar" size={13} /> {relativeDay(task.due_date)}</span>}
            {task?.list && <span className="capture-chip"><Icon name="list" size={13} /> {task.list.name}</span>}
          </>
        ) : (
          <>
            <span className="capture-chip"><Icon name={parsed.notebook ? 'notebook' : 'inbox'} size={13} /> {parsed.notebook?.name ?? 'Inbox'}</span>
            {parsed.tags.map((t) => <span key={t} className="capture-chip"><Icon name="tag" size={13} /> {t}</span>)}
          </>
        )}
        {files.map((f, i) => (
          <span key={i} className="capture-chip is-file">
            <Icon name={f.recording ? 'mic' : 'image'} size={13} />
            {f.recording ? 'Voice memo' : f.ocr ? 'Photo (words read when sent)' : bank ? 'Photo (its words only)' : 'Photo'}
            <button type="button" className="capture-chip-x" aria-label="Remove" onClick={() => setFiles((all) => all.filter((x) => x !== f))}><Icon name="x" size={11} /></button>
          </span>
        ))}
        {reading && <span className="capture-chip is-busy">Reading the photo…</span>}
        {listening && <span className="capture-chip is-listening">Listening… tap Stop when done</span>}
      </div>
      <div className="capture-foot">
        {canDictate() && (
          <button type="button" className={`btn btn-small ${listening ? 'is-on' : ''}`} onClick={dictate} aria-pressed={!!listening} title="Type what you say">
            <Icon name="text" size={14} /> {listening ? 'Stop' : 'Speak'}
          </button>
        )}
        {!bank && (
          <button type="button" className="btn btn-small" onClick={voice} disabled={busy} title="Record a voice memo to go with it">
            <Icon name="mic" size={14} /> {recording ? 'Record again' : 'Record'}
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={photo} disabled={busy || reading} title="A photo, with its words read into the box">
          <Icon name="camera" size={14} /> Photo
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { addPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        <span className="spacer" />
        {enterSaves && <span className="muted capture-keys"><kbd>Enter</kbd> save · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>}
        <button type="button" className="btn btn-primary btn-small" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
