// Selah Desktop's demo, for videos and screenshots: a separate library (never your own) filled with the demo tenant's
// sample data (Cedar Hollow Bible Church; server/demo/seed.js) and six automatic backups dated over the last two weeks.
//
//   node scripts/demo.mjs            opens it (made the first time) with this checkout's code
//   node scripts/demo.mjs --reset    starts it over from the sample data
//   node scripts/demo.mjs --packaged uses the built app (dist-installer/win-unpacked) instead
//
// The demo lives in %USERPROFILE%\Selah Demo (SELAH_DEMO_DIR to change it): Selah\ is its library, Demo OneDrive\
// its backup folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.SELAH_DEMO_DIR || path.join(os.homedir(), 'Selah Demo');
const root = path.join(base, 'Selah');
if (process.argv.includes('--reset')) fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'app'), { recursive: true });
const settings = path.join(root, 'app', 'app-settings.json');
// Straight to the library on this PC (no welcome screen), on its own port so it never shares a page's storage with
// a real Selah Desktop.
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ mode: 'offline', port: 47851, toldAboutTray: true }, null, 2));
const packaged = process.argv.includes('--packaged');
const exe = packaged ? path.join(app, 'dist-installer', 'win-unpacked', 'Selah.exe') : path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const p = spawn(exe, packaged ? [] : [app], {
  env: { ...process.env, SELAH_DESKTOP_ROOT: root, NOTEAPP_DESKTOP_DEMO: '1' },
  stdio: 'inherit', detached: true,
});
p.unref();
console.log(`Selah Desktop demo: ${root}${fs.existsSync(path.join(root, 'storage')) ? '' : ' (the sample data takes a few seconds the first time)'}`);
