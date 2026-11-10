// 13.0: saving a quick capture, and, in the phone and tablet app, keeping the ones made with no connection on the
// device until they can be sent. The app's built-in offline page (mobile-app/www/shell.js) adds to the same queue.
//
// A capture: { text, dest: 'inbox' | 'bank', bankKind, files: [{ blob, name, type, recording, ocr }] }.
// `ocr` marks a photo whose words still need reading (it was taken offline); they go into the note under the text.
// The queue: selah-cache/<host>-captures/queue.json (a list of captures, each file saved beside it as base64).
import { api } from './api.js';
import { parseCapture } from './captureParse.js';
import { parseTask } from './taskParse.js';
import { todayStr } from './time.js';
import { canvasBlob, pagesFromFile } from './handwriting.js';

const fsPlugin = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.Filesystem ?? null : null);
const DIR = () => `selah-cache/${location.host}-captures`;
const INDEX = () => `${DIR()}/queue.json`;

/** A failure that means "no connection" (as opposed to the server saying no). */
export const isOffline = (e) => !navigator.onLine || !!e?.offline;

export const BANK_KINDS = [
  ['illustration', 'Illustration'], ['quote', 'Quote'], ['application', 'Application'], ['scripture', 'Scripture'], ['other', 'Idea'],
];

const stamp = () => new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/** The words in a photo, read on the server (server/ocr.js). '' when there are none. */
export async function readPhotoText(blob) {
  const file = blob instanceof File ? blob : new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
  const pages = await pagesFromFile(file);
  const out = [];
  for (const p of pages) out.push((await api.ocr(await canvasBlob(p.canvas))).text?.trim() ?? '');
  return out.filter(Boolean).join('\n\n');
}

/**
 * Saves a capture now. Returns { kind: 'note' | 'task' | 'bank', id, where }. Throws as the request did, so an
 * offline failure (isOffline) can be queued instead.
 */
export async function saveCapture(c, { notebooks = [], lists = null } = {}) {
  let text = String(c.text ?? '').trim();
  const files = c.files ?? [];
  // Shared from another app (dest 'share'): always the Inbox, saved as the share menu saves it (a link's page title).
  if (c.dest === 'share') {
    const asFiles = files.map((f) => (f.blob instanceof File ? f.blob : new File([f.blob], f.name || 'shared', { type: f.type || f.blob.type })));
    const r = await api.share({ title: c.title ?? '', text, files: asFiles });
    return { kind: 'note', id: r.id, where: 'Inbox', title: r.title };
  }
  for (const f of files) {
    if (!f.ocr) continue;
    const read = await readPhotoText(f.blob).catch((e) => { if (isOffline(e)) throw e; return ''; });
    if (read) text = text ? `${text}\n\n${read}` : read;
    f.ocr = false;
  }

  if (c.dest === 'bank') {
    const parsed = parseCapture(text, []);
    const lines = text.split('\n');
    const many = lines.length > 1 && lines.slice(1).join('').trim();
    const item = await api.addToBank({
      kind: c.bankKind || 'illustration',
      title: many ? parsed.title : '',
      html: paragraphs(many ? parsed.body : parsed.title || text) || '<p></p>',
      topics: parsed.tags,
    });
    return { kind: 'bank', id: item.id, where: 'the sermon bank' };
  }

  const parsed = parseCapture(text, notebooks);
  if (parsed.task && !files.length) {
    const task = parseTask(parsed.taskText, { today: todayStr(), lists: lists ?? await api.listTaskLists().catch(() => []) });
    let listId = task.list?.id ?? null;
    if (task.list?.isNew) listId = (await api.createTaskList({ name: task.list.name })).id;
    const { id } = await api.createTask({
      title: task.title, due_date: task.due_date, due_time: task.due_time, start_date: task.start_date,
      priority: task.priority, rrule: task.rrule, list_id: listId,
    });
    return { kind: 'task', id, where: 'Tasks' };
  }
  const p = parsed.task ? { title: parsed.taskText, body: '', tags: [], notebook: null } : parsed;
  const recording = files.some((f) => f.recording);
  const title = p.title || (recording ? `Voice memo · ${stamp()}` : files.length ? `Photo · ${stamp()}` : 'Quick capture');
  const r = await api.capture({ title, text: p.body, tags: p.tags, notebook_id: p.notebook?.id });
  for (const f of files) {
    const file = f.blob instanceof File ? f.blob : new File([f.blob], f.name || 'capture', { type: f.type || f.blob.type });
    await api.upload(r.id, file, null, { recording: !!f.recording, append: true });
  }
  return { kind: 'note', id: r.id, where: p.notebook?.name ?? 'Inbox' };
}

// ---- the queue on the device ----

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const fromBase64 = (b64, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

async function readQueue() {
  try {
    const { data } = await fsPlugin().readFile({ path: INDEX(), directory: 'DATA', encoding: 'utf8' });
    const list = JSON.parse(data);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
const writeQueue = (list) => fsPlugin().writeFile({ path: INDEX(), data: JSON.stringify(list), directory: 'DATA', encoding: 'utf8', recursive: true });

/** Whether this device can keep captures for later (the phone and tablet app). */
export const canQueue = () => !!fsPlugin();

/** Keeps a capture on the device until there's a connection. */
export async function queueCapture(c) {
  const fs = fsPlugin();
  if (!fs) throw new Error('No connection, and this browser can’t keep the capture for later.');
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const files = [];
  for (const [i, f] of (c.files ?? []).entries()) {
    const file = `${id}-${i}`;
    await fs.writeFile({ path: `${DIR()}/${file}`, data: await toBase64(f.blob), directory: 'DATA', recursive: true });
    files.push({ file, name: f.name || 'capture', type: f.type || f.blob.type || 'application/octet-stream', recording: !!f.recording, ocr: !!f.ocr });
  }
  const list = await readQueue();
  // A capture with no words keeps the time it was made as its title, not the time it's sent.
  let text = String(c.text ?? '');
  if (!text.trim() && c.dest !== 'bank' && c.dest !== 'share') text = `${files.some((f) => f.recording) ? 'Voice memo' : 'Photo'} · ${stamp()}`;
  list.push({ id, created_at: Date.now(), text, title: c.title ?? '', dest: c.dest ?? 'inbox', bankKind: c.bankKind ?? null, files });
  await writeQueue(list);
  window.dispatchEvent(new Event('noteapp:capture-queue'));
}

export async function queuedCount() {
  return fsPlugin() ? (await readQueue()).length : 0;
}

let flushing = null;
/**
 * Sends what's waiting. Resolves to how many went. A capture the server turns down is saved to the Inbox as plain
 * text instead, so nothing waits forever. Stops at the first sign the connection is gone again.
 */
export function flushCaptureQueue(ctx) {
  if (!fsPlugin() || !navigator.onLine) return Promise.resolve(0);
  flushing ??= (async () => {
    const fs = fsPlugin();
    let sent = 0;
    try {
      for (const entry of await readQueue()) {
        const files = [];
        for (const f of entry.files ?? []) {
          try {
            const { data } = await fs.readFile({ path: `${DIR()}/${f.file}`, directory: 'DATA' });
            files.push({ ...f, blob: fromBase64(data, f.type) });
          } catch { /* a file that's gone can't be sent; the rest still go */ }
        }
        try {
          await saveCapture({ ...entry, files }, ctx);
        } catch (e) {
          if (isOffline(e)) break;
          try {
            await api.capture({ title: `Quick capture · ${new Date(entry.created_at).toLocaleString()}`, text: entry.text || '(a capture that couldn’t be saved as it was)' });
          } catch (e2) { if (isOffline(e2)) break; }
        }
        const left = (await readQueue()).filter((x) => x.id !== entry.id);
        await writeQueue(left);
        for (const f of entry.files ?? []) await fs.deleteFile({ path: `${DIR()}/${f.file}`, directory: 'DATA' }).catch(() => {});
        sent++;
      }
    } finally {
      flushing = null;
    }
    if (sent) window.dispatchEvent(new Event('noteapp:capture-queue'));
    return sent;
  })();
  return flushing;
}
