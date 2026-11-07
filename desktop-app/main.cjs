// Selah Desktop (12.0): the Windows app. Two ways to run, chosen on first start and changeable in Settings:
//   Offline   Selah's own server runs here, on 127.0.0.1 only, with the library in %LOCALAPPDATA%\Selah. There's no
//             sign-in: the app starts the server with a fresh key each launch and adds it to every request its own
//             windows make (X-Selah-Desktop), so nothing else on the PC can use the server.
//   Connect   the window shows a Selah Cloud server (https://…), signed in to like a browser.
// Either way: a tray icon (closing the window keeps Selah running for reminders), Start with Windows, Windows
// notifications, quick capture (Ctrl+Alt+N), the slides window full screen on a second monitor, and updates from
// GitHub Releases. Offline adds an optional PIN / Windows Hello lock.
'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor,
  safeStorage, screen, session, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const netMod = require('node:net');
const path = require('node:path');

// ---------- folders ----------
// Everything in %LOCALAPPDATA%\Selah (not Roaming: a roaming profile would copy the library at every sign-in).
// SELAH_DESKTOP_ROOT: a scratch folder for tests (never set in the installed app).
const ROOT = process.env.SELAH_DESKTOP_ROOT || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Selah');
const DIRS = {
  root: ROOT,
  app: path.join(ROOT, 'app'), // Chromium's profile and app-settings.json
  storage: path.join(ROOT, 'storage'), // notes.db, files\, restore-points\
  data: path.join(ROOT, 'data'), // caches, the sealed secrets key, restore staging
  logs: path.join(ROOT, 'logs'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
app.setPath('userData', DIRS.app);
app.setPath('sessionData', DIRS.app);
app.setAppLogsPath(DIRS.logs);
app.setAppUserModelId('app.selah.desktop');

const HIDDEN_ARG = '--hidden';
const DEFAULT_PORT = 47821;
const SETTINGS_FILE = path.join(DIRS.app, 'app-settings.json');
const SEALED_KEY = path.join(DIRS.data, 'secrets.key.sealed');
const PLAIN_KEY = path.join(DIRS.data, 'wordpress.key');
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'server') : path.resolve(__dirname, '..');
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// ---------- app settings (not in the library: they belong to this PC) ----------
// { mode: 'offline' | 'connect', server, port, startWithWindows, lock: { hash, salt, hello, idleMinutes }, window }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
let settings = readSettings();
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
}

// ---------- logs ----------
const LOG = path.join(DIRS.logs, 'selah.log');
function log(line) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never stop the app */ }
}

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

// ---------- the secrets key, sealed by Windows ----------
/** The 32-byte key server/secrets.js encrypts stored sign-ins with. A plain wordpress.key (a restore puts one
 * back) is sealed and removed first. */
function secretKey() {
  if (!safeStorage.isEncryptionAvailable()) return null; // the server keeps a plain key file instead
  if (fs.existsSync(PLAIN_KEY)) {
    const key = fs.readFileSync(PLAIN_KEY);
    if (key.length === 32) {
      fs.writeFileSync(SEALED_KEY, safeStorage.encryptString(key.toString('base64')));
      fs.rmSync(PLAIN_KEY, { force: true });
    }
  }
  if (!fs.existsSync(SEALED_KEY)) {
    fs.writeFileSync(SEALED_KEY, safeStorage.encryptString(crypto.randomBytes(32).toString('base64')));
  }
  try {
    return safeStorage.decryptString(fs.readFileSync(SEALED_KEY));
  } catch (e) {
    log(`The sealed key can't be opened (${e.message}); stored sign-ins will need entering again.`);
    fs.renameSync(SEALED_KEY, `${SEALED_KEY}.unreadable-${Date.now()}`);
    return secretKey();
  }
}

// ---------- the local server (Offline) ----------
let server = null; // { proc, port, key, origin }
let serverStopping = false;

function portFree(port) {
  return new Promise((resolve) => {
    const s = netMod.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** The same port every time where possible: the page's own storage (tabs, layout) belongs to its address. */
async function choosePort() {
  const want = settings.port || DEFAULT_PORT;
  if (await portFree(want)) return want;
  for (let p = DEFAULT_PORT + 1; p < DEFAULT_PORT + 40; p++) {
    if (await portFree(p)) { log(`Port ${want} is taken; using ${p}.`); return p; }
  }
  throw new Error('No free port for Selah’s server.');
}

async function startServer() {
  const port = await choosePort();
  if (port !== settings.port) saveSettings({ port });
  const key = crypto.randomBytes(32).toString('base64url');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NOTEAPP_EDITION: 'desktop',
    NOTEAPP_DESKTOP_KEY: key,
    NOTEAPP_PORT: String(port),
    NOTEAPP_DATA_DIR: DIRS.data,
    NOTEAPP_STORAGE_DIR: DIRS.storage,
    NOTEAPP_LOG_LEVEL: 'warn',
    NOTEAPP_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
  };
  const sealed = secretKey();
  if (sealed) env.NOTEAPP_SECRET_KEY = sealed;
  const out = fs.openSync(path.join(DIRS.logs, 'server.log'), 'a');
  const proc = spawn(process.execPath, [path.join(SERVER_DIR, 'server', 'index.js')], {
    cwd: SERVER_DIR, env, stdio: ['ignore', out, out, 'ipc'], windowsHide: true,
  });
  fs.closeSync(out);
  const origin = `http://127.0.0.1:${port}`;
  server = { proc, port, key, origin };
  proc.on('exit', (code) => {
    log(`Server stopped (${code}).`);
    if (server?.proc === proc) {
      server = null;
      if (!serverStopping && !quitting) serverCrashed(code);
    }
  });
  // Ready when it answers.
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`Selah’s server stopped while starting (code ${proc.exitCode}). See ${path.join(DIRS.logs, 'server.log')}.`);
    try {
      const r = await net.fetch(`${origin}/api/version`, { headers: { 'X-Selah-Desktop': key } });
      if (r.ok) return server;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Selah’s server didn’t start in time.');
}

function stopServer() {
  if (!server) return Promise.resolve();
  const { proc } = server;
  serverStopping = true;
  return new Promise((resolve) => {
    const done = () => { serverStopping = false; resolve(); };
    proc.once('exit', done);
    // Asked to finish its requests, save to the sync folder and close the database (server/index.js); killed if
    // it hasn't in a minute.
    try { proc.send('shutdown'); } catch { proc.kill(); }
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 60_000).unref();
  });
}

let crashes = [];
async function serverCrashed(code) {
  crashes = crashes.filter((t) => Date.now() - t < 5 * 60_000).concat(Date.now());
  if (crashes.length > 3) {
    dialog.showErrorBox('Selah', `Selah’s server keeps stopping (code ${code}). The log is in ${DIRS.logs}.`);
    return;
  }
  try {
    await startServer();
    installKeyHeader();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().startsWith('http')) w.webContents.reload();
  } catch (e) {
    dialog.showErrorBox('Selah', e.message);
  }
}

// ---------- the key on every request from Selah's own windows ----------
let locked = false;
let headerInstalled = false;
function installKeyHeader() {
  if (headerInstalled) return;
  headerInstalled = true;
  // Installed once; it always uses the server running now (a restart brings a new port and key).
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, cb) => {
    const s = server;
    // While locked, the page gets nothing from the server.
    if (s && !locked && details.url.startsWith(`${s.origin}/`)) details.requestHeaders['X-Selah-Desktop'] = s.key;
    cb({ requestHeaders: details.requestHeaders });
  });
}

/** The address the windows show: the local server, or the Cloud server chosen. */
const home = () => (settings.mode === 'connect' ? settings.server : server?.origin);
const sameOrigin = (url) => { try { return new URL(url).origin === new URL(home()).origin; } catch { return false; } };

// ---------- windows ----------
let main = null;
let capture = null;
const slides = new Map(); // note id -> window
let tray = null;
let quitting = false;

function webPrefs() {
  return { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true };
}

/** Links to other sites open in the default browser; Selah's own pages stay in its windows. */
function guard(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      const m = /#slides(?:\/(\d+))?/.exec(url);
      if (m) { openSlides(m[1] ? Number(m[1]) : null, {}); return { action: 'deny' }; }
      return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, webPreferences: webPrefs() } };
    }
    if (/^(https?|mailto|logosres|logos4):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (sameOrigin(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^(https?|mailto|logosres|logos4):/i.test(url)) shell.openExternal(url);
  });
}

function createMain({ show = true } = {}) {
  const place = settings.window ?? {};
  main = new BrowserWindow({
    title: 'Selah', icon: ICON, width: place.width ?? 1280, height: place.height ?? 860, x: place.x, y: place.y,
    minWidth: 420, minHeight: 520, show: false, autoHideMenuBar: true, backgroundColor: '#f6f3ee', webPreferences: webPrefs(),
  });
  if (place.maximized) main.maximize();
  guard(main);
  main.once('ready-to-show', () => { if (show) main.show(); });
  const remember = () => {
    if (!main || main.isDestroyed() || main.isMinimized()) return;
    saveSettings({ window: { ...main.getNormalBounds(), maximized: main.isMaximized() } });
  };
  main.on('resized', remember);
  main.on('moved', remember);
  // Closing keeps Selah in the tray (reminders still arrive); Quit is in the tray menu.
  main.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    remember();
    main.hide();
    if (!settings.toldAboutTray) {
      saveSettings({ toldAboutTray: true });
      notify('Selah is still running', 'It’s in the tray by the clock, so reminders still arrive. Right-click it to quit.');
    }
  });
  return main;
}

function loadHome(win = main) {
  if (locked) return win.loadFile(path.join(__dirname, 'pages', 'lock.html'));
  return win.loadURL(home());
}

function showMain() {
  if (!main || main.isDestroyed()) { createMain(); loadHome(); return; }
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

function showCapture() {
  if (locked || !home()) { showMain(); return; }
  if (capture && !capture.isDestroyed()) { capture.show(); capture.focus(); return; }
  capture = new BrowserWindow({
    title: 'Quick capture · Selah', icon: ICON, width: 460, height: 420, minWidth: 360, minHeight: 340,
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, show: false, webPreferences: webPrefs(),
  });
  guard(capture);
  capture.loadURL(`${home()}/#capture`);
  capture.once('ready-to-show', () => capture.show());
  capture.on('close', (e) => { if (!quitting) { e.preventDefault(); capture.hide(); } });
}

/**
 * The slides window: full screen on a monitor other than the one Selah's main window is on, when there is one
 * (`otherScreen`, or always when there are two), the controls staying on the laptop. One screen: an ordinary window.
 */
function openSlides(noteId, { otherScreen = false } = {}) {
  const key = noteId ?? 0;
  const old = slides.get(key);
  if (old && !old.isDestroyed()) { old.show(); old.focus(); return { screens: screen.getAllDisplays().length }; }
  const displays = screen.getAllDisplays();
  const mine = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
  const other = displays.find((d) => d.id !== mine.id);
  const onOther = !!other && (otherScreen || displays.length > 1);
  const b = onOther ? other.bounds : { width: 1280, height: 720 };
  const w = new BrowserWindow({
    title: 'Selah Slides', icon: ICON, x: b.x, y: b.y, width: b.width, height: b.height, autoHideMenuBar: true,
    backgroundColor: '#000000', show: false, webPreferences: webPrefs(),
  });
  guard(w);
  w.loadURL(`${home()}/#slides${noteId ? `/${noteId}` : ''}`);
  w.once('ready-to-show', () => {
    w.show();
    if (onOther) w.setFullScreen(true);
    // The controls stay in front of the presenter.
    if (onOther && main && !main.isDestroyed()) main.focus();
  });
  w.on('closed', () => slides.delete(key));
  slides.set(key, w);
  return { screens: displays.length, otherScreen: onOther };
}

// ---------- notifications ----------
function notify(title, body, sectionName = null) {
  if (!Notification.isSupported()) throw new Error('Windows notifications aren’t available.');
  const n = new Notification({ title, body, icon: ICON, silent: false });
  n.on('click', () => {
    showMain();
    if (sectionName) main?.webContents.send('show-section', sectionName);
  });
  n.show();
}

// ---------- tray ----------
function buildTray() {
  const hotkey = globalShortcut.register('Control+Alt+N', showCapture);
  if (!hotkey) log('Ctrl+Alt+N belongs to another program; Quick capture is in the tray menu.');
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Selah');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Quick capture', accelerator: hotkey ? 'Ctrl+Alt+N' : undefined, click: showCapture },
    { label: 'Open Selah', click: showMain },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (i) => setStartWithWindows(i.checked) },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    { label: 'Open the logs folder', click: () => shell.openPath(DIRS.logs) },
    { type: 'separator' },
    { label: 'Quit Selah', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', () => tray.popUpContextMenu(menu()));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  tray.on('double-click', showMain);
}

const startsWithWindows = () => app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin;
function setStartWithWindows(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, args: [HIDDEN_ARG] });
  saveSettings({ startWithWindows: !!on });
}

// ---------- the lock (Offline) ----------
const scryptHash = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64');
let lastActive = Date.now();
let pinTries = [];

function lockNow() {
  if (!settings.lock || settings.mode === 'connect' || locked) return;
  locked = true;
  for (const w of [capture, ...slides.values()]) if (w && !w.isDestroyed()) w.hide();
  if (main && !main.isDestroyed()) loadHome();
}

async function unlock() {
  locked = false;
  lastActive = Date.now();
  if (main && !main.isDestroyed()) { await loadHome(); main.show(); }
}

function watchIdle() {
  powerMonitor.on('lock-screen', lockNow);
  powerMonitor.on('suspend', lockNow);
  setInterval(() => {
    if (!settings.lock || locked) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle >= (settings.lock.idleMinutes ?? 15) * 60) lockNow();
  }, 30_000).unref();
}

/** Windows Hello through Windows' own consent prompt (UserConsentVerifier), from PowerShell: no native module. */
const HELLO_PS = (op) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null
${op === 'check'
    ? "Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])"
    : "Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Unlock Selah')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])"}
`;
function hello(op) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HELLO_PS(op)], { windowsHide: true, timeout: op === 'check' ? 15_000 : 120_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}
let helloAvailable = null;

// ---------- updates (GitHub Releases) ----------
let updater = null;
function setUpUpdates() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) { log(`Updater unavailable: ${e.message}`); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // A beta build follows betas; a release build only releases.
  updater.allowPrerelease = /-beta\./.test(app.getVersion());
  updater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox({
      type: 'info', title: 'Selah update', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Selah ${info.version} is ready (you have ${app.getVersion()}).`,
      detail: 'Selah closes and reopens to finish. Later installs it the next time you quit.',
    });
    if (r.response === 0) { quitting = true; updater.quitAndInstall(false, true); }
  });
  updater.on('error', (e) => log(`Update check failed: ${e?.message ?? e}`));
  setTimeout(() => checkForUpdates(false), 60_000);
  setInterval(() => checkForUpdates(false), 6 * 3600_000).unref();
}
async function checkForUpdates(manual) {
  if (!updater) {
    if (manual) dialog.showMessageBox({ message: app.isPackaged ? 'Updates aren’t available right now.' : 'Updates only work in the installed app.', title: 'Selah' });
    return;
  }
  try {
    const r = await updater.checkForUpdates();
    if (manual && (!r?.updateInfo || r.updateInfo.version === app.getVersion())) {
      dialog.showMessageBox({ message: `Selah ${app.getVersion()} is up to date.`, title: 'Selah' });
    } else if (manual) {
      dialog.showMessageBox({ message: `Downloading Selah ${r.updateInfo.version}…`, detail: 'You’ll be asked to restart when it’s ready.', title: 'Selah' });
    }
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Couldn’t check for updates.', detail: e.message, title: 'Selah' });
  }
}

// ---------- the bridge (preload.cjs) ----------
const fromSelah = (e) => sameOrigin(e.senderFrame?.url ?? '') || (e.senderFrame?.url ?? '').startsWith('file:');
function handle(name, fn) {
  ipcMain.handle(name, async (e, ...args) => {
    if (!fromSelah(e)) throw new Error('Not from Selah');
    return fn(e, ...args);
  });
}

function appSettingsView() {
  return {
    version: app.getVersion(),
    mode: settings.mode,
    server: settings.mode === 'connect' ? settings.server : null,
    startWithWindows: startsWithWindows(),
    lock: settings.lock ? { hello: !!settings.lock.hello, idleMinutes: settings.lock.idleMinutes ?? 15 } : null,
    helloAvailable: helloAvailable === 'Available',
    root: DIRS.root,
  };
}

function bridge() {
  ipcMain.on('info', (e) => { e.returnValue = { mode: settings.mode ?? null, version: app.getVersion(), screens: screen.getAllDisplays().length }; });
  ipcMain.on('screens', (e) => { e.returnValue = screen.getAllDisplays().length; });
  handle('notify', (_e, title, body, sectionName) => notify(String(title), String(body ?? ''), sectionName));
  handle('open-slides', (_e, noteId, opts) => openSlides(noteId == null ? null : Number(noteId), opts ?? {}));
  handle('hide-capture', () => { capture?.hide(); });
  handle('open-main', () => { capture?.hide(); showMain(); });
  handle('pick-folder', async (e, opts = {}) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: opts.title ?? 'Choose a folder', defaultPath: opts.defaultPath, properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('pick-backup-file', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Choose a Selah backup', properties: ['openFile'],
      filters: [{ name: 'Selah backups', extensions: ['selahbak', 'gz'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // After a restore was staged: the server puts it in place as it starts.
  handle('restart-server', async () => {
    if (settings.mode === 'connect') return;
    await stopServer();
    await startServer();
    installKeyHeader();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w !== main) w.close();
    await loadHome();
  });
  handle('app-settings', () => appSettingsView());
  handle('set-app-settings', async (_e, patch = {}) => {
    if ('startWithWindows' in patch) setStartWithWindows(!!patch.startWithWindows);
    if ('lock' in patch) {
      if (!patch.lock) saveSettings({ lock: null });
      else {
        const pin = String(patch.lock.pin ?? '');
        if (!/^\d{4,12}$/.test(pin)) throw new Error('Use 4 to 12 digits.');
        const salt = crypto.randomBytes(16).toString('base64');
        const idle = [5, 15, 30, 60, 240].includes(patch.lock.idleMinutes) ? patch.lock.idleMinutes : 15;
        saveSettings({ lock: { salt, hash: scryptHash(pin, salt), hello: !!patch.lock.hello && helloAvailable === 'Available', idleMinutes: idle } });
      }
    }
    return appSettingsView();
  });
  handle('set-server', async (_e, url) => {
    const u = String(url ?? '').trim();
    let origin = null;
    if (u) {
      try { origin = new URL(u); } catch { /* checked below */ }
      if (origin?.protocol !== 'https:') throw new Error('Type the whole address, starting with https://');
    }
    saveSettings(origin ? { mode: 'connect', server: origin.origin } : { mode: 'offline' });
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== HIDDEN_ARG) });
    quitting = true;
    app.exit(0);
  });
  handle('check-for-updates', () => checkForUpdates(true));
  // The lock page.
  handle('unlock-pin', async (_e, pin) => {
    pinTries = pinTries.filter((t) => Date.now() - t < 5 * 60_000);
    if (pinTries.length >= 8) throw new Error('Too many wrong PINs. Wait five minutes.');
    const l = settings.lock;
    if (!l) { await unlock(); return true; }
    const ok = crypto.timingSafeEqual(Buffer.from(scryptHash(pin, l.salt), 'base64'), Buffer.from(l.hash, 'base64'));
    if (!ok) { pinTries.push(Date.now()); return false; }
    pinTries = [];
    await unlock();
    return true;
  });
  handle('unlock-hello', async () => {
    if (!settings.lock?.hello) return false;
    const r = await hello('verify');
    if (r === 'Verified') { await unlock(); return true; }
    return false;
  });
  handle('lock-info', () => ({ hello: !!settings.lock?.hello && helloAvailable === 'Available' }));
  // First start.
  handle('first-run', async (_e, choice) => {
    if (choice?.mode === 'connect') {
      const u = new URL(String(choice.server ?? '').trim());
      if (u.protocol !== 'https:') throw new Error('Type the whole address, starting with https://');
      saveSettings({ mode: 'connect', server: u.origin });
    } else {
      saveSettings({ mode: 'offline' });
    }
    await begin();
  });
}

// ---------- start ----------
async function begin() {
  if (settings.mode === 'offline') {
    try {
      await startServer();
      installKeyHeader();
    } catch (e) {
      log(e.message);
      dialog.showErrorBox('Selah couldn’t start', `${e.message}\n\nThe log is in ${DIRS.logs}.`);
      quitting = true;
      app.quit();
      return;
    }
  }
  locked = !!settings.lock && settings.mode !== 'connect';
  if (!main || main.isDestroyed()) createMain({ show: !process.argv.includes(HIDDEN_ARG) });
  await loadHome();
  if (!tray) buildTray();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  bridge();
  watchIdle();
  setUpUpdates();
  hello('check').then((r) => { helloAvailable = r; });
  // Downloads (backups, exports) ask where to save, in front of Selah.
  session.defaultSession.on('will-download', (_e, item) => { item.setSaveDialogOptions({ title: 'Save' }); });
  if (!settings.mode) {
    createMain();
    main.loadFile(path.join(__dirname, 'pages', 'welcome.html'));
    return;
  }
  await begin();
});

// Keep running in the tray with no windows open.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  if (server) {
    e.preventDefault();
    await stopServer();
    server = null;
    app.quit();
  }
});
