// Selah Desktop's bridge: window.selahDesktop, for Selah's pages (client/src/desktop.js, DesktopSettings.jsx,
// SlideView.jsx, CaptureWindow.jsx) and the app's own pages (pages/). Each call is checked in main.cjs to come from
// Selah's own address.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('info');
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('selahDesktop', {
  kind: 'electron',
  version: info.version,
  // 'offline' (the library on this PC) or 'connect' (a Selah Cloud server)
  mode: info.mode,
  screenCount: () => ipcRenderer.sendSync('screens'),
  notify: call('notify'),
  openSlides: call('open-slides'),
  hideCapture: call('hide-capture'),
  openMain: call('open-main'),
  pickFolder: call('pick-folder'),
  pickBackupFile: call('pick-backup-file'),
  restartServer: call('restart-server'),
  appSettings: call('app-settings'),
  setAppSettings: call('set-app-settings'),
  setServer: call('set-server'),
  checkForUpdates: call('check-for-updates'),
  // pages/lock.html and pages/welcome.html
  unlockPin: call('unlock-pin'),
  unlockHello: call('unlock-hello'),
  lockInfo: call('lock-info'),
  firstRun: call('first-run'),
});

// A notification was clicked: the page it's about.
ipcRenderer.on('show-section', (_e, section) => {
  window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: section }));
});
