// Builds Selah Desktop's installer: stages the local server (stage.mjs), then electron-builder, with the app's
// version taken from Selah's own package.json (Desktop and Selah are versioned together).
//   node scripts/dist.mjs                    desktop-app/dist-installer/Selah-Setup-<version>.exe
//   node scripts/dist.mjs --publish always   and uploads it to a draft GitHub release (CI; needs GH_TOKEN)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.resolve(app, '..', 'package.json'), 'utf8')).version;
const publish = process.argv.includes('--publish') ? process.argv[process.argv.indexOf('--publish') + 1] : 'never';
execSync('node scripts/stage.mjs', { cwd: app, stdio: 'inherit' });
execSync(`npx electron-builder --win --publish ${publish} -c.extraMetadata.version=${version}`, { cwd: app, stdio: 'inherit' });
console.log(`Selah Desktop ${version} built.`);
