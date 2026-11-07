// Gathers what Selah Desktop's installer carries for its local server into desktop-app/stage/server:
// server/, shared/, extension/ (the clipper download), the built client (client/dist), and production node_modules
// (npm ci --omit=dev, so ffmpeg-static fetches its Windows binary). Run from desktop-app: npm run stage.
// The client must be built first (npm run build in the repo).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const size = (p) => { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size; return n; };
console.log(`Staged ${(size(out) / 1048576).toFixed(0)} MB in ${out}`);
