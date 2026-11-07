// Builds Selah Desktop for the system it runs on: stages the local server (stage.mjs), then electron-builder, with
// the app's version taken from Selah's own package.json (Desktop and Selah are versioned together).
//   Windows  dist-installer/Selah-Setup-<version>.exe
//   Mac      dist-installer/Selah-<version>-mac-{arm64,x64}.dmg (+ .zip, which the updater uses)
//   Linux    dist-installer/Selah-<version>-x86_64.AppImage and selah-desktop_<version>_amd64.deb
//   node scripts/dist.mjs --publish always   and uploads them to the draft GitHub release (CI; needs GH_TOKEN)
// A Mac build is signed and notarized when CI gives it the Apple secrets (see .github/workflows/desktop.yml);
// without them it's unsigned, which macOS only opens after Open Anyway.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.resolve(app, '..', 'package.json'), 'utf8')).version;
const publish = process.argv.includes('--publish') ? process.argv[process.argv.indexOf('--publish') + 1] : 'never';
const target = { win32: '--win', darwin: '--mac --arm64 --x64', linux: '--linux --x64' }[process.platform];
// Unsigned Mac builds are still signed "ad hoc": Apple Silicon Macs won't run an app with no signature at all.
const adhoc = process.platform === 'darwin' && process.env.SELAH_MAC_ADHOC ? ' -c.mac.identity=-' : '';
if (!target) throw new Error(`Selah Desktop doesn't build on ${process.platform}.`);
execSync('node scripts/stage.mjs', { cwd: app, stdio: 'inherit' });
execSync(`npx electron-builder ${target} --publish ${publish} -c.extraMetadata.version=${version}${adhoc}`, { cwd: app, stdio: 'inherit' });
console.log(`Selah Desktop ${version} built for ${process.platform}.`);
