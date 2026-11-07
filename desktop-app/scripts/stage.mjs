// Gathers what Selah Desktop's installer carries for its local server into desktop-app/stage/server:
// server/, shared/, extension/ (the clipper download), the built client (client/dist), and production node_modules
// (npm ci --omit=dev, so ffmpeg-static fetches its Windows binary). Run from desktop-app: npm run stage.
// The client must be built first (npm run build in the repo).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'stage', 'server');
const dist = path.join(repo, 'client', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('client/dist is missing: run "npm run build" in the repo first.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const skip = (src) => /[\/](admin|demo)[\/]?$/.test(src) && src.includes(`${path.sep}server${path.sep}`);
for (const dir of ['server', 'shared', 'extension']) {
  fs.cpSync(path.join(repo, dir), path.join(out, dir), { recursive: true, filter: (src) => !skip(src) });
}
fs.cpSync(dist, path.join(out, 'client', 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) fs.copyFileSync(path.join(repo, f), path.join(out, f));
console.log('Installing production packages…');
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' });

// Sizes, for the record.
const walk = (p, fn) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q, fn); else fn(q); } };
const measure = (p) => { let bytes = 0; let files = 0; walk(p, (f) => { bytes += fs.statSync(f).size; files++; }); return { bytes, files }; };
const before = measure(out);

// 12.0.0: what the local server never reads comes out, so the installer is smaller and has fewer files to unpack
// (installing, and the first start after it, are mostly Windows unpacking and checking files).
const nm = path.join(out, 'node_modules');
const rm = (rel) => fs.rmSync(path.join(nm, rel), { recursive: true, force: true });
const keepOnly = (dir, keep) => {
  for (const f of fs.readdirSync(path.join(nm, dir))) if (!keep.some((k) => (k instanceof RegExp ? k.test(f) : k === f))) rm(path.join(dir, f));
};
// Fonts: the page has its own copies (client/dist); the server only serves the wordmark (capture.js).
for (const family of fs.readdirSync(path.join(nm, '@fontsource'))) {
  if (family !== 'cormorant-garamond') { rm(path.join('@fontsource', family)); continue; }
  keepOnly(path.join('@fontsource', family), ['LICENSE', 'package.json', 'files']);
  keepOnly(path.join('@fontsource', family, 'files'), ['cormorant-garamond-latin-600-italic.woff2']);
}
// OCR (ocr.js): the engines as .js + .wasm (the .wasm.js copies are for browsers; tesseract.js loads more than the
// LSTM engine while starting, so every variant stays), and only the best_int English model.
keepOnly('tesseract.js-core', ['LICENSE', 'package.json', 'index.js', /^tesseract-core(-simd|-relaxedsimd)?(-lstm)?\.(js|wasm)$/]);
keepOnly(path.join('@tesseract.js-data', 'eng'), ['package.json', 'index.js', '4.0.0_best_int']);
// HEIC photos: heic-decode loads libheif-js/wasm-bundle only.
rm(path.join('libheif-js', 'libheif'));
keepOnly(path.join('libheif-js', 'libheif-wasm'), ['LICENSE', 'libheif-bundle.js']);
// Everywhere: docs, type definitions, source maps, tests and examples.
walk(nm, (f) => {
  const base = path.basename(f);
  if (/^(licen[cs]e|notice|copying|authors)/i.test(base)) return; // licenses stay
  if (/^(readme|changelog|history|contributing)(\.|$)/i.test(base) || /\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i.test(base)) fs.rmSync(f);
});
for (const pkg of fs.readdirSync(nm)) {
  const dirs = pkg.startsWith('@') ? fs.readdirSync(path.join(nm, pkg)).map((p) => path.join(pkg, p)) : [pkg];
  for (const d of dirs) for (const sub of ['test', 'tests', '__tests__', 'example', 'examples', '.github']) rm(path.join(d, sub));
}

// The server must still start and load every package it uses (each one is imported somewhere in server/).
{
  const r = createRequire(path.join(out, 'package.json'));
  for (const m of ['fastify', '@fastify/cookie', '@fastify/multipart', '@fastify/static', '@mozilla/readability', 'citeproc', 'ffmpeg-static', 'heic-convert', 'marked', 'qrcode', 'rrule', 'sax', 'tesseract.js', 'undici', 'libheif-js/wasm-bundle']) r(m);
  for (const v of ['', '-simd', '-relaxedsimd']) for (const l of ['', '-lstm']) r(`tesseract.js-core/tesseract-core${v}${l}`);
  if (!fs.existsSync(path.join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'))) throw new Error('The OCR model is missing.');
  console.log('  packages load');
}

const after = measure(out);
console.log(`Staged ${(after.bytes / 1048576).toFixed(0)} MB, ${after.files} files in ${out} (trimmed ${((before.bytes - after.bytes) / 1048576).toFixed(0)} MB, ${before.files - after.files} files)`);
