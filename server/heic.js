// HEIC/HEIF photos (Android and iPhone cameras) don't display in most browsers. They're kept as uploaded, and a
// JPEG copy is made the first time one is viewed (in a worker thread: decoding a 12-megapixel photo takes a few
// seconds) and kept in data/cache/heic. Download still gives the original.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';

export const HEIC_DIR = path.join(config.dataDir, 'cache', 'heic');
const HEIC_MIME = /^image\/(heic|heif)(-sequence)?$/i;

export const isHeic = (mime, filename = '') => HEIC_MIME.test(mime ?? '') || /\.(heic|heif)$/i.test(filename);

const making = new Map();
const unreadable = new Set();

/** The JPEG copy of a HEIC attachment ({ storage }), made if needed; null if it can't be read. */
export function heicJpeg(a) {
  const dest = path.join(HEIC_DIR, `${a.storage}.jpg`);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (unreadable.has(a.storage)) return Promise.resolve(null);
  if (making.has(dest)) return making.get(dest);
  fs.mkdirSync(HEIC_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const p = new Promise((resolve) => {
    const worker = new Worker(new URL('./heic-worker.js', import.meta.url), {
      workerData: { src: path.join(config.filesDir, a.storage), dest: tmp },
      ...(config.jobMemoryMb ? { resourceLimits: { maxOldGenerationSizeMb: config.jobMemoryMb } } : {}),
    });
    // A photo that takes longer than the job limit is given up on (tenants' limits, set in the admin console).
    const timer = setTimeout(() => { worker.terminate(); fail(); }, config.jobTimeout);
    timer.unref();
    worker.once('exit', () => clearTimeout(timer));
    const fail = () => {
      fs.rm(tmp, { force: true }, () => {});
      unreadable.add(a.storage);
      resolve(null);
    };
    worker.once('message', (ok) => {
      if (!ok || !fs.existsSync(tmp)) return fail();
      fs.renameSync(tmp, dest);
      resolve(dest);
    });
    worker.once('error', fail);
  }).finally(() => making.delete(dest));
  making.set(dest, p);
  return p;
}

export const dropHeic = (storages) => { for (const s of storages) fs.rm(path.join(HEIC_DIR, `${s}.jpg`), { force: true }, () => {}); };
