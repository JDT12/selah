// Selah: run pdf.js's worker with the same additions as the page (see compat.mjs). The viewer copies its own
// workerSrc option over GlobalWorkerOptions when it opens a file, so the option is changed on "webviewerloaded",
// which the viewer sends to the parent page's document when it can reach it, or else to its own.
const WORKER = '../build/pdf.worker.compat.mjs';
const targets = [document];
try { if (parent !== window && parent.document) targets.push(parent.document); } catch { /* another origin */ }
const onLoaded = (event) => {
  if (event.detail?.source !== window) return;
  for (const t of targets) t.removeEventListener('webviewerloaded', onLoaded);
  window.PDFViewerApplicationOptions?.set('workerSrc', WORKER);
};
for (const t of targets) t.addEventListener('webviewerloaded', onLoaded);
