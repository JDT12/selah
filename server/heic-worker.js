// Decodes one HEIC photo to JPEG for heic.js, off the main thread.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';

try {
  const out = await convert({ buffer: fs.readFileSync(workerData.src), format: 'JPEG', quality: 0.88 });
  fs.writeFileSync(workerData.dest, Buffer.from(out));
  parentPort.postMessage(true);
} catch {
  parentPort.postMessage(false);
}
