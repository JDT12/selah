import { createRequire } from 'node:module';
import { createWorker, OEM } from 'tesseract.js';
import { config } from './config.js';

/**
 * Handwriting (and print) to text with Tesseract, on this server: no account, and the pictures never leave it.
 * The browser does the preparing (it turns photos, PDF pages and drawings into clean grayscale PNGs) and sends one
 * page at a time. One worker reads them in turn; it starts on the first page and stops after a few idle minutes,
 * since it holds the English model (about 30 MB) in memory.
 */
const require = createRequire(import.meta.url);
const langPath = require('@tesseract.js-data/eng').langPath.replace(/4\.0\.0$/, '4.0.0_best_int');
const IDLE_MS = 3 * 60 * 1000;
const MAX_IMAGE = 25 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|webp|bmp)$/;
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

let worker = null;
let idle = null;
let busy = 0;

function getWorker() {
  clearTimeout(idle);
  worker ??= createWorker('eng', OEM.LSTM_ONLY, {
    langPath, gzip: true, cacheMethod: 'none',
    errorHandler: () => { worker = null; },
  }).catch((err) => { worker = null; throw err; });
  return worker;
}

function release() {
  if (--busy > 0) return;
  clearTimeout(idle);
  idle = setTimeout(async () => {
    const w = worker;
    worker = null;
    if (w) (await w.catch(() => null))?.terminate().catch(() => {});
  }, IDLE_MS);
  idle.unref();
}

/** Tesseract's blocks → paragraphs of lines, each word with how sure it was (0-100). */
function shape(data) {
  const paragraphs = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      const lines = para.lines
        .map((line) => ({ words: line.words.map((w) => ({ text: w.text, confidence: Math.round(w.confidence) })).filter((w) => w.text.trim()) }))
        .filter((line) => line.words.length);
      if (lines.length) paragraphs.push({ lines });
    }
  }
  const text = paragraphs.map((p) => p.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n')).join('\n\n');
  return { text, confidence: Math.round(data.confidence ?? 0), paragraphs };
}

export async function recognize(image) {
  busy++;
  try {
    const w = await getWorker();
    let timer;
    const tooLong = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        // The worker is stuck on this image: drop it, so the next one starts fresh.
        if (worker) { const stuck = worker; worker = null; stuck.then((x) => x.terminate()).catch(() => {}); }
        reject(httpError(504, 'Reading the handwriting took too long. Try a smaller or clearer image.'));
      }, config.jobTimeout);
    });
    try {
      const { data } = await Promise.race([w.recognize(image, {}, { text: true, blocks: true }), tooLong]);
      return shape(data);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release();
  }
}

export default async function ocrRoutes(app) {
  app.post('/api/ocr', async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_IMAGE } });
    if (!file) throw httpError(400, 'No image uploaded');
    if (!IMAGE_MIME.test((file.mimetype || '').toLowerCase())) {
      file.file.resume();
      throw httpError(415, 'Send a PNG, JPEG, WebP or BMP image');
    }
    const image = await file.toBuffer();
    if (file.file.truncated) throw httpError(413, 'Image is too large (25 MB max)');
    try {
      return await recognize(image);
    } catch (err) {
      req.log.error(err);
      throw httpError(422, 'Could not read the image');
    }
  });
}
