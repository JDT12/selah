#!/usr/bin/env node
// Tests what the phone and tablet apps show and hide (npm run test:devices, after npm run build). It starts a throwaway
// Selah with sample work and opens it three ways in Chromium: as the phone app, the tablet app (a fake Capacitor bridge
// and the device's screen size) and a plain browser. Pass --shots <folder> to save screenshots. Exits 1 when something failed.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_DEVICE_PORT ?? 8624);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'device-test-only-password';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail !== '' ? ` (${detail})` : ''}`);
};
const section = (name) => console.log(`\n${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await wait(100);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-device-test-'));
const env = { ...process.env, NOTEAPP_ESV_TEST: '1', NOTEAPP_DATA_DIR: path.join(dir, 'data'), NOTEAPP_STORAGE_DIR: path.join(dir, 'store'), NOTEAPP_HOST: '127.0.0.1', NOTEAPP_PORT: String(PORT), NOTEAPP_TLS: '0' };
fs.mkdirSync(path.join(dir, 'store', 'files'), { recursive: true });
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
fs.writeFileSync(path.join(dir, 'store', '.note-app-storage'), '');
execFileSync(process.execPath, ['--input-type=module', '-e', "const a = await import('./server/auth.js'); await a.setPassword(process.env.TP); process.exit(0);"], { cwd: ROOT, env: { ...env, TP: PASSWORD }, stdio: 'ignore' });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });

async function launch() {
  try { return await chromium.launch(); } catch (e) {
    const base = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
    const shell = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop() : null;
    if (!shell) throw e;
    return chromium.launch({ executablePath: path.join(base, shell, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe') });
  }
}

const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, ...(b === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}, [method, url, body]);

/** One device, signed in, on Home. `app` is the fake bridge; a plain browser has none. */
async function open(browser, { width, height, app }) {
  const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, hasTouch: !!app });
  if (app) await context.addInitScript((p) => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => p, Plugins: {} }; }, app);
  const page = await context.newPage();
  await page.goto(BASE);
  await call(page, 'POST', '/api/login', { password: PASSWORD });
  await call(page, 'PUT', '/api/prefs/whatsNewSeen', { value: '99.0.0' });
  await call(page, 'POST', '/api/identity/later').catch(() => {});
  await call(page, 'PUT', '/api/prefs/tourOffered', { value: true }).catch(() => {});
  await page.reload();
  await page.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  return { context, page };
}
const closeDialogs = async (page) => {
  const later = page.getByRole('button', { name: 'Later', exact: true });
  if (await later.count()) await later.first().click().catch(() => {});
};
const go = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await wait(500);
  await closeDialogs(page);
  await wait(300);
};
const text = (page, sel = 'body') => page.locator(sel).first().innerText();
const has = async (page, name) => (await page.getByRole('button', { name, exact: true }).count()) > 0;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const noteEditable = (page) => page.locator('.ProseMirror').first().getAttribute('contenteditable');
const noteMenu = async (page) => {
  await page.getByRole('button', { name: 'Note actions' }).first().click();
  await wait(250);
  const items = await page.locator('.menu, [role="menu"], .bottom-sheet, .sheet').last().innerText();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 300).catch(() => {});
  await wait(150);
  return items;
};
const settingsTabs = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Settings')?.click());
  if (!await until(async () => (await page.locator('[id^="settings-tab-"]').count()) > 0, 2500)) {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).or(page.getByText('Settings', { exact: true })).first().click();
    await until(async () => (await page.locator('[id^="settings-tab-"]').count()) > 0);
  }
  const ids = await page.locator('[id^="settings-tab-"]').evaluateAll((l) => l.map((e) => e.id.replace('settings-tab-', '')));
  return ids;
};

let browser;
try {
  if (!await until(async () => (await fetch(`${BASE}/api/session`)).ok, 20000)) throw new Error('The test server did not start.');
  browser = await launch();

  const desk = await open(browser, { width: 1500, height: 950 });
  await desk.page.reload();
  const p0 = desk.page;
  const sermon = await call(p0, 'POST', '/api/sermons', { title: 'Grace Alone', passage: 'Ephesians 2:8-9', html: '<h1>Grace</h1><p>Sermon text</p>' });
  const sermonNote = sermon.note_id;
  const writing = await call(p0, 'POST', '/api/studies', { kind: 'writing', title: 'Blog series' });
  const chapter = await call(p0, 'POST', `/api/studies/${writing.id}/chapters`, { title: 'First chapter' });
  const klass = await call(p0, 'POST', '/api/studies', { kind: 'class', title: 'Greek One' });
  const tree = await call(p0, 'GET', '/api/tree');
  const plain = await call(p0, 'POST', '/api/notes', { notebook_id: tree.inbox?.id ?? tree.myNotes, html: '<p>Ordinary note</p>', title: 'Plain' });
  const studyHost = await call(p0, 'POST', '/api/notes', { notebook_id: tree.inbox?.id ?? tree.myNotes, html: '<p>Study</p>', title: 'A study' });
  await call(p0, 'POST', '/api/bible-studies', { note_id: studyHost.id });
  const chapterId = chapter.note_id ?? chapter.id;

  section('Desktop and web keep everything');
  await go(p0, '#dashboard');
  check('Preach is on the rail', await has(p0, 'Preach') || (await text(p0, '.app-rail')).includes('Preach'));
  await go(p0, `#build/sermon/${sermonNote}`);
  check('a builder opens', await until(() => p0.locator('.builder-page').isVisible()));
  await go(p0, '#desk');
  check('Desk offers new work', (await text(p0, '.page-actions')).includes('New'));
  await go(p0, `#note/${sermonNote}`);
  await until(() => p0.locator('.work-builder').isVisible());
  check('a sermon is editable', (await noteEditable(p0)) === 'true');
  check('the builder button shows', await p0.locator('.work-builder').isVisible());
  await go(p0, '#dashboard');
  await p0.locator('.home-tabs [role="tab"]').nth(1).click();
  await go(p0, '#desk');
  await p0.locator('.app-rail .nr-item', { hasText: 'Home' }).first().click();
  check('the rail’s Home opens the Home tab', await until(async () => (await p0.locator('.home-tabs [role="tab"][aria-selected="true"]').first().innerText()).startsWith('Home')));
  await p0.locator('.home-tabs [role="tab"]').nth(1).click();
  await p0.locator('.app-rail .nr-item', { hasText: 'Home' }).first().click();
  check('even from another Home tab', await until(async () => (await p0.locator('.home-tabs [role="tab"][aria-selected="true"]').first().innerText()).startsWith('Home')));
  const dTabs = await settingsTabs(p0);
  check('Settings has every tab', dTabs.includes('connections') && dTabs.includes('data'), dTabs.join());
  await p0.locator('#settings-tab-data').click();
  check('Settings shows storage', await until(async () => /used/.test(await text(p0, '.modal-backdrop'))));
  await desk.context.close();

  section('Phone');
  const phone = await open(browser, { width: 412, height: 915, app: 'android' });
  const p = phone.page;
  await closeDialogs(p);
  await shot(p, 'phone-home');
  check('app is marked a phone', await p.evaluate(() => document.documentElement.classList.contains('is-phone-app')));
  await p.locator('.ar-tab-new').click();
  await p.getByText('Quick capture', { exact: true }).first().click();
  check('the + button opens quick capture', await until(() => p.locator('.capture-box').isVisible()));
  check('a phone saves with the button, not Enter', !(await p.locator('.capture-keys').count()));
  await shot(p, 'phone-capture');
  await p.keyboard.press('Escape');
  await wait(200);
  // 13.0 after beta.27: the Trash is back on the phone, to restore a note deleted by mistake.
  const gone = await call(p, 'POST', '/api/capture', { title: 'Deleted by mistake', text: 'x' });
  await call(p, 'DELETE', `/api/notes/${gone.id}`);
  await p.locator('.ar-tabbar').getByRole('button', { name: 'More' }).click();
  await p.getByText('Utility', { exact: true }).last().click();
  check('the phone’s Utility has the Trash', await until(() => p.locator('.rp-foot.is-trash button').isVisible()));
  await p.locator('.rp-foot.is-trash button').click();
  check('the Trash lists the deleted note', await until(async () => (await text(p)).includes('Deleted by mistake')));
  await shot(p, 'phone-trash');
  await call(p, 'POST', `/api/notes/${gone.id}/restore`).catch(() => {});
  await go(p, `#build/sermon/${sermonNote}`);
  check('a builder link opens the note', await until(async () => p.url().includes(`#note/${sermonNote}`)), p.url());
  check('no builder on the page', !(await p.locator('.builder-page').count()));
  await until(() => p.getByText('Read-only here').isVisible());
  check('sermon says read-only', await p.getByText('Read-only here').isVisible());
  check('sermon cannot be typed in', (await noteEditable(p)) === 'false');
  check('no builder or Preach button on the page', !(await p.locator('.work-builder, .work-go').count()));
  await shot(p, 'phone-sermon');
  const pm = await noteMenu(p);
  check('menu keeps Preach as the backup', pm.includes('Preach'), pm);
  check('menu has no builder, slides, export or blog', !/builder|Slides|Export|WordPress|Move to Trash/.test(pm), pm);
  await go(p, `#note/${plain.id}`);
  check('an ordinary note can be edited', await until(async () => (await noteEditable(p)) === 'true'));
  await go(p, '#sermons');
  check('Preach page sends you Home', await until(async () => p.url().endsWith('#dashboard')), p.url());
  await go(p, '#wordpress');
  check('Site page sends you Home', await until(async () => p.url().endsWith('#dashboard')), p.url());
  await go(p, '#media');
  check('Media sends you Home', await until(async () => p.url().endsWith('#dashboard')), p.url());
  await go(p, '#desk');
  check('Desk has no New button', !(await text(p, '.desk-page')).match(/\bNew\b/));
  await shot(p, 'phone-desk');
  await p.evaluate((id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })), writing.id);
  await until(() => p.locator('.device-readonly .study-detail').isVisible());
  check('writing project reads only', await p.locator('.device-readonly .study-detail').isVisible());
  check('writing project has no Edit or add', !(await p.getByRole('button', { name: 'Edit…' }).isVisible().catch(() => false)) && !(await p.locator('.device-readonly form:visible').count()));
  await shot(p, 'phone-writing');
  await p.evaluate((id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })), klass.id);
  await wait(600);
  check('class reads only', await p.locator('.device-readonly').count() === 1 && (await text(p, '.device-readonly')).includes('Greek One'));
  await shot(p, 'phone-class');
  if (chapterId) {
    await go(p, `#note/${chapterId}`);
    check('a writing chapter reads only', await until(async () => (await noteEditable(p)) === 'false'));
  }
  await go(p, '#tags');
  check('Tags is view only', await p.locator('.device-readonly').count() === 1 && !(await p.getByRole('button', { name: 'New tag' }).isVisible().catch(() => false)));
  await go(p, '#dashboard');
  const pTabs = await settingsTabs(p);
  check('Settings drops Connections and Data', !pTabs.includes('connections') && !pTabs.includes('data') && pTabs.includes('security'), pTabs.join());
  await shot(p, 'phone-settings');
  await phone.context.close();

  section('Tablet');
  const tablet = await open(browser, { width: 1180, height: 820, app: 'ios' });
  const t = tablet.page;
  await closeDialogs(t);
  await shot(t, 'tablet-home');
  check('app is marked a tablet', await t.evaluate(() => document.documentElement.classList.contains('is-tablet-app')));
  check('Preach is on the rail', (await text(t, '.app-rail')).includes('Preach'));
  await go(t, `#build/sermon/${sermonNote}`);
  check('a builder link opens the note', await until(async () => t.url().includes(`#note/${sermonNote}`)), t.url());
  await until(() => t.locator('.work-go').isVisible());
  check('sermon can be edited as a page', (await noteEditable(t)) === 'true');
  check('Preach is one tap away', await t.locator('.work-go').isVisible());
  check('no builder button', !(await t.locator('.work-builder').count()));
  await shot(t, 'tablet-sermon');
  const tm = await noteMenu(t);
  check('menu keeps Present, Preach and Slides', /Present/.test(tm) && /Preach/.test(tm) && /Slides/.test(tm), tm);
  check('menu has no builder, export or blog', !/builder|Export|WordPress/.test(tm), tm);
  await t.getByRole('button', { name: 'Slides', exact: true }).click();
  check('Slides opens', await until(() => t.locator('.se-toolbar').isVisible()));
  check('no PowerPoint or layout picker', !(await t.locator('.se-type-field').count()) && !(await t.getByRole('button', { name: 'PowerPoint' }).count()));
  await t.getByRole('tab', { name: 'Design' }).click();
  check('Design has theme, colors and fonts', await until(async () => { const d = await text(t, '.se-design'); return d.includes('Theme') && d.includes('Colors') && d.includes('Fonts'); }));
  await shot(t, 'tablet-slides');
  await t.getByRole('button', { name: 'Close', exact: true }).first().click();
  await wait(300);
  await go(t, `#note/${studyHost.id}`);
  check('a Bible study reads only', await until(async () => (await noteEditable(t)) === 'false'));
  await go(t, '#wordpress');
  check('Site page sends you Home', await until(async () => t.url().endsWith('#dashboard')), t.url());
  await go(t, '#sermons');
  await wait(400);
  check('Preach library has no New or Builder', !(await has(t, 'New sermon')) && !(await t.locator('.sermon-row').getByRole('button', { name: 'Builder' }).count()));
  await shot(t, 'tablet-preach');
  check('no builder tab left over', !(await text(t, '.top-bar, header, body')).includes('· Builder'));
  check('Preach library can preach', await t.getByRole('button', { name: 'Preach', exact: true }).last().isVisible());
  const tabCount = () => t.locator('.top-tab-close').count();
  const before = await tabCount();
  await t.locator('.sermon-main').first().click();
  check('a note from a list opens in a tab', await until(async () => t.url().includes(`#note/${sermonNote}`) && (await tabCount()) === before + 1), t.url());
  check('no slide-out panel', !(await t.locator('.note-peek').count()));
  await t.locator('.top-tab.is-active .top-tab-close').click();
  check('closing the tab removes it and comes back', await until(async () => t.url().endsWith('#sermons') && (await tabCount()) === before), t.url());
  await t.evaluate((id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })), writing.id);
  check('writing project reads only', await until(() => t.locator('.device-readonly .study-detail').isVisible()));
  await t.setViewportSize({ width: 834, height: 1194 });
  await go(t, `#note/${sermonNote}`);
  await t.locator('.work-go').click();
  await t.locator('.pm-more').waitFor({ timeout: 8000 });
  await t.locator('.pm-more').click();
  await wait(300);
  const bar = await t.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    const tools = [...document.querySelectorAll('.pm-tools > :not(.pm-more, .pm-exit)')].filter((e) => e.getClientRects().length);
    return { x: box('.pm-exit').right, y: box('.pm-exit').top, more: box('.pm-more').left, last: Math.max(...tools.map((e) => e.getBoundingClientRect().right)), row: Math.max(...tools.map((e) => e.getBoundingClientRect().top)), n: tools.length };
  });
  await shot(t, 'tablet-preach-tools');
  check('Preach tools open left of the X, on one row', bar.n > 3 && bar.last <= bar.more && Math.abs(bar.row - bar.y) < 14, JSON.stringify(bar));
  await tablet.context.close();

  section('Phone remote');
  // The tablet preaches; the phone app is the remote. Haptics are faked so each buzz is counted.
  const pad = await open(browser, { width: 1180, height: 820, app: 'ios' });
  const ph = await browser.newContext({ viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, hasTouch: true });
  await ph.addInitScript(() => {
    window.__buzz = [];
    const rec = (kind) => async (a) => { window.__buzz.push(kind === 'impact' ? 'tap' : a?.type); };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Haptics: { impact: rec('impact'), notification: rec('notification') } } };
  });
  const rp = await ph.newPage();
  await rp.goto(BASE);
  await call(rp, 'POST', '/api/login', { password: PASSWORD });
  await rp.reload();
  await rp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(rp);
  await rp.getByRole('button', { name: 'More', exact: true }).click();
  await rp.getByText('Remote', { exact: true }).click();
  check('More → Remote opens it', await until(() => rp.locator('.remote-host .remote').isVisible()));
  // A sermon with no slides, a 6-minute goal and 58 s already run: five minutes left comes in about 2 s.
  const tp = pad.page;
  const bare = await call(tp, 'POST', '/api/sermons', { title: 'No Slides Sermon', html: '<h1>One</h1><p>Text</p>' });
  const sermonNote2 = bare.note_id;
  await call(tp, 'PUT', `/api/notes/${sermonNote2}/slides`, { deck: { theme: 'lamplight', slides: [] } });
  await tp.evaluate((id) => { localStorage.setItem(`noteapp.preach.goal.${id}`, '6'); localStorage.setItem(`noteapp.preach.timer.${id}`, JSON.stringify({ start: null, acc: 58000 })); }, sermonNote2);
  await go(tp, `#note/${sermonNote2}`);
  await tp.locator('.work-go').click();
  await tp.locator('.preach').waitFor({ timeout: 8000 });
  check('the phone follows a sermon with no slides', await until(async () => (await text(rp, '.remote-host')).includes('No Slides Sermon'), 8000));
  check('it shows the time left, large', await until(() => rp.locator('.remote-big-time').isVisible()));
  await rp.getByRole('button', { name: 'Start the timer again' }).click();
  check('Start on the phone starts the timer on the iPad', await until(async () => (await tp.locator('.pm-timer').getAttribute('class')).includes('is-running'), 5000));
  check('buzzes at five minutes left', await until(async () => (await rp.evaluate(() => window.__buzz)).includes('WARNING'), 8000), JSON.stringify(await rp.evaluate(() => window.__buzz)));
  await rp.getByRole('button', { name: 'Pause the timer' }).click();
  check('Pause on the phone pauses it', await until(async () => !(await tp.locator('.pm-timer').getAttribute('class')).includes('is-running'), 5000));
  await shot(rp, 'phone-remote');
  await ph.setOffline(true);
  await rp.getByRole('button', { name: 'Start the timer again' }).click();
  check('says when the connection drops', await until(() => rp.locator('.remote-trouble').isVisible(), 10000));
  await shot(rp, 'phone-remote-lost');
  await ph.setOffline(false);
  await rp.getByRole('button', { name: 'Start the timer again' }).click();
  check('clears when it comes back', await until(async () => !(await rp.locator('.remote-trouble').isVisible()), 15000));
  await rp.locator('.remote-close').click();
  check('the remote closes back to the app', await until(async () => !(await rp.locator('.remote-host').count())));
  await pad.context.close();
  await ph.close();

  section('Slides made when Preach opens');
  const fresh = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const fp = await fresh.newPage();
  await fp.goto(BASE);
  await call(fp, 'POST', '/api/login', { password: PASSWORD });
  const newer = await call(fp, 'POST', '/api/sermons', { title: 'Never Opened Slides', passage: 'Romans 5:1', html: '<h1>Peace</h1><p>Text</p>' });
  check('starts with no saved slides', !(await call(fp, 'GET', `/api/notes/${newer.note_id}/slides`)).deck);
  await fp.reload();
  await fp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(fp);
  await go(fp, `#note/${newer.note_id}`);
  await fp.locator('.work-go').click();
  check('Preach makes them from the outline and shows the slide bar', await until(() => fp.locator('.preach .ss-strip, .preach .pm-slides').first().isVisible(), 8000));
  check('and saves them', !!(await call(fp, 'GET', `/api/notes/${newer.note_id}/slides`)).deck?.slides?.length);

  section('Slides as pictures');
  await fp.reload();
  await fp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(fp);
  await go(fp, `#note/${newer.note_id}`);
  await fp.getByRole('button', { name: 'Note actions' }).first().click();
  await fp.getByText('Slides…', { exact: true }).first().click();
  await fp.getByRole('button', { name: 'Download', exact: true }).click();
  check('Download offers PowerPoint and pictures', await until(async () => (await fp.getByText('Pictures (.png, in a .zip)').count()) > 0));
  const dl = fp.waitForEvent('download', { timeout: 60000 });
  await fp.getByText('Pictures (.png, in a .zip)').click();
  const file = await dl;
  const zipPath = path.join(os.tmpdir(), `selah-slides-${Date.now()}.zip`);
  await file.saveAs(zipPath);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const names = Object.keys(zip.files).sort();
  const deckNow = (await call(fp, 'GET', `/api/notes/${newer.note_id}/slides`)).deck;
  check('a picture for each slide', names.length >= deckNow.slides.length && names[0] === '01.png', names.join());
  const png = await zip.file(names[0]).async('nodebuffer');
  check('1920 × 1080 PNG', png.readUInt32BE(16) === 1920 && png.readUInt32BE(20) === 1080, `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`);
  if (SHOTS) for (const n of names.slice(0, 3)) fs.writeFileSync(path.join(SHOTS, `slide-${n}`), await zip.file(n).async('nodebuffer'));
  fs.rmSync(zipPath, { force: true });
  await fresh.close();

  section('Pen');
  const penc = await browser.newContext({ viewport: { width: 1180, height: 820 }, screen: { width: 1180, height: 820 }, hasTouch: true });
  await penc.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
  const pp = await penc.newPage();
  await pp.goto(BASE);
  await call(pp, 'POST', '/api/login', { password: PASSWORD });
  await pp.reload();
  await pp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(pp);
  // A pen stroke as the Pencil sends it: pointer events with pointerType 'pen' and pressure.
  const penStroke = (sel, pts, { tap = false } = {}) => pp.evaluate(([s, list, isTap]) => {
    const el = document.querySelector(s);
    const fire = (type, [x, y]) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', pressure: 0.6, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    fire('pointerdown', list[0]);
    if (!isTap) for (const p of list.slice(1)) fire('pointermove', p);
    fire('pointerup', list[isTap ? 0 : list.length - 1]);
  }, [sel, pts, tap]);
  await pp.locator('.nr-new').click();
  await pp.getByText('New handwritten note', { exact: true }).click();
  check('New handwritten note opens a full-screen page', await until(() => pp.locator('.drawing.is-full').isVisible(), 8000));
  const box = await pp.locator('.drawing.is-full .drawing-live').boundingBox();
  await penStroke('.drawing.is-full .drawing-live', [[box.x + 100, box.y + 100], [box.x + 160, box.y + 130], [box.x + 240, box.y + 110], [box.x + 300, box.y + 150]]);
  await shot(pp, 'pen-handwritten');
  await pp.getByRole('button', { name: 'Done', exact: true }).click();
  check('Done closes full screen', await until(async () => !(await pp.locator('.drawing.is-full').count())));
  const noteId = Number((pp.url().match(/#note\/(\d+)/) ?? [])[1]);
  check('the pen stroke is saved in the note', await until(async () => /data-strokes="\[\{/.test((await call(pp, 'GET', `/api/notes/${noteId}`)).html), 8000));
  // Ink in Preach: a stroke beside the first paragraph, a pen tap that folds, and the ink back after reopening.
  await go(pp, `#note/${sermonNote}`);
  await pp.locator('.work-go').click();
  await pp.locator('.preach .pm-content p').first().waitFor({ timeout: 8000 });
  await pp.getByRole('button', { name: 'Ink', exact: true }).click();
  const para = await pp.locator('.preach .pm-content p').first().boundingBox();
  await penStroke('.preach .pm-content p', [[para.x + 10, para.y + para.height / 2], [para.x + 80, para.y + para.height / 2 + 6], [para.x + 160, para.y + para.height / 2]]);
  check('the pen writes on the sermon', await until(async () => (await pp.locator('.pm-ink path').count()) === 1));
  const noScroll = await pp.evaluate(() => {
    const el = document.querySelector('.preach .pm-content p');
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'pen', clientX: 5, clientY: 5, buttons: 1, bubbles: true }));
    const t = new Touch({ identifier: 9, target: el, clientX: 5, clientY: 5 });
    const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'pen', clientX: 5, clientY: 5, bubbles: true }));
    return ev.defaultPrevented;
  });
  check('a pen touch doesn’t scroll the page (Android)', noScroll);
  const erase = await pp.evaluate(() => {
    const el = document.querySelector('.preach .pm-content p');
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: 'pen', button: type === 'pointerdown' ? 2 : -1, buttons: type === 'pointerup' ? 0 : 3, clientX: x, clientY: y, bubbles: true }));
    fire('pointerdown', r.left + 5); fire('pointermove', r.left + 60); fire('pointermove', r.left + 160); fire('pointerup', r.left + 160);
  });
  void erase;
  check('pressing the pen’s side button switches to the eraser', await until(async () => (await pp.locator('.pm-ink path').count()) === 0, 3000));
  // Pressing it again (here while hovering) switches back to the pen.
  await pp.evaluate(() => {
    const el = document.querySelector('.preach .pm-content p');
    el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 13, pointerType: 'pen', buttons: 2, clientX: 9, clientY: 9, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 13, pointerType: 'pen', buttons: 0, clientX: 9, clientY: 9, bubbles: true }));
  });
  check('and back to the pen', await until(async () => (await pp.locator('.pm-ink-bar [aria-label="Eraser"]').getAttribute('aria-pressed').catch(() => 'false')) !== 'true' , 3000));
  await pp.evaluate(() => {
    const el = document.querySelector('.preach .pm-content p');
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 12, pointerType: 'pen', pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true }));
    fire('pointerdown', r.left + 10); fire('pointermove', r.left + 80); fire('pointermove', r.left + 160); fire('pointerup', r.left + 160);
  });
  check('the ink is saved with the note', await until(async () => (await call(pp, 'GET', `/api/notes/${sermonNote}/ink`)).strokes.length === 1, 5000));
  await pp.getByRole('button', { name: 'Larger text' }).click();
  await pp.getByRole('button', { name: 'Larger text' }).click();
  await pp.waitForTimeout(300);
  const stays = await pp.evaluate(() => {
    const p = document.querySelector('.preach .pm-content p').getBoundingClientRect();
    const ink = document.querySelector('.pm-ink path').getBoundingClientRect();
    return ink.top >= p.top - 4 && ink.bottom <= p.bottom + 4;
  });
  check('it stays beside its words when the text gets larger', stays);
  await shot(pp, 'pen-preach');
  const head = await pp.locator('.preach .pm-head').first().boundingBox();
  await penStroke('.preach .pm-head', [[head.x + 30, head.y + head.height / 2]], { tap: true });
  check('a pen tap still folds a heading', await until(async () => (await pp.locator('.pm-sec.is-folded').count()) === 1));
  check('folded ink hides with its words', await until(async () => (await pp.locator('.pm-ink path').count()) === 0));
  await penStroke('.preach .pm-head', [[head.x + 30, head.y + head.height / 2]], { tap: true });
  await pp.getByRole('button', { name: /^Leave/ }).click();
  await pp.getByRole('button', { name: 'Leave', exact: true }).click().catch(() => {});
  await pp.waitForTimeout(400);
  await pp.locator('.work-go').click();
  check('the ink is there next time', await until(async () => (await pp.locator('.pm-ink path').count()) === 1, 8000));
  await penc.close();

  section('Ink follows its word');
  const wc = await browser.newContext({ viewport: { width: 1180, height: 820 }, screen: { width: 1180, height: 820 } });
  // As the iPad app, so Preach doesn't take the browser full screen (a full-screen window can't be resized).
  await wc.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
  const wp = await wc.newPage();
  await wp.goto(BASE);
  await call(wp, 'POST', '/api/login', { password: PASSWORD });
  const words = 'In the beginning was the Word and the Word was with God and the Word was God. He was in the beginning with God. All things were made through him and without him was not any thing made that was made. In him was life and the life was the light of men. The light shines in the darkness and the darkness has not overcome it.';
  const ws = await call(wp, 'POST', '/api/sermons', { title: 'Word Anchors', html: `<h1>Light</h1><p>${words}</p>` });
  await call(wp, 'PUT', `/api/notes/${ws.note_id}/slides`, { deck: { theme: 'lamplight', slides: [] } });
  await wp.reload();
  await wp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(wp);
  await go(wp, `#note/${ws.note_id}`);
  await wp.locator('.work-go').click();
  await wp.locator('.preach .pm-content p').first().waitFor({ timeout: 8000 });
  const wordBox = () => wp.evaluate(() => {
    const p = document.querySelector('.preach .pm-content p');
    const text = p.firstChild;
    const at = text.textContent.indexOf('darkness');
    const r = document.createRange(); r.setStart(text, at); r.setEnd(text, at + 8);
    const b = r.getClientRects()[0];
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  const wb = await wordBox();
  await wp.evaluate(([b]) => {
    const el = document.querySelector('.preach .pm-content p');
    const y = b.y + b.h + 2;
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'pen', pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true }));
    fire('pointerdown', b.x); fire('pointermove', b.x + b.w / 2); fire('pointermove', b.x + b.w); fire('pointerup', b.x + b.w);
  }, [wb]);
  await until(async () => (await wp.locator('.pm-ink path').count()) === 1);
  await wp.setViewportSize({ width: 620, height: 900 });
  await wp.getByRole('button', { name: 'Larger text' }).click().catch(() => {});
  await wp.waitForTimeout(500);
  const after = await wordBox();
  const ink = await wp.evaluate(() => { const r = document.querySelector('.pm-ink path').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await shot(wp, 'ink-word');
  check('underline stays under its word when the lines wrap differently', Math.abs((ink.x + ink.w / 2) - (after.x + after.w / 2)) < after.h && ink.y > after.y && ink.y < after.y + after.h * 1.6, JSON.stringify({ ink, after }));
  await wc.close();

  section('Notifications and attendance');
  const nc = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const np = await nc.newPage();
  await np.goto(BASE);
  await call(np, 'POST', '/api/login', { password: PASSWORD });
  const day = new Date(Date.now() + 2 * 86400000).toLocaleDateString('en-CA');
  const lessonNote = (await call(np, 'POST', '/api/sermons', { title: 'Linked Lesson', html: '<h1>One</h1><p>Text</p>' })).note_id;
  const ev = await call(np, 'POST', '/api/events', { title: 'Sunday School', start: `${day}T09:30`, end: `${day}T10:30`, note_id: lessonNote });
  const grp = await call(np, 'POST', '/api/attendance/groups', { name: 'Adult Class', kind: 'class', event_id: ev.id });
  await call(np, 'POST', `/api/attendance/groups/${grp.id}/people`, { name: 'Ruth Anders' });
  const cal = await call(np, 'GET', `/api/calendar?from=${day}&to=${new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA')}`);
  const occ = cal.events.find((x) => x.id === ev.id);
  check('the calendar says who meets and what’s linked', occ?.attendance?.name === 'Adult Class' && occ?.note_title === 'Linked Lesson', JSON.stringify(occ?.attendance));
  const linked = await call(np, 'GET', `/api/notes/${lessonNote}/attendance`);
  check('the lesson knows its class', linked.group?.name === 'Adult Class' && !!linked.date, JSON.stringify(linked));
  await nc.close();
  // The apps schedule reminders on the device; a fake LocalNotifications plugin records them.
  const appWith = async (w, h, platform) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, hasTouch: true });
    await c.addInitScript((p) => {
      try { localStorage.setItem('noteapp.reminders', 'on'); } catch { /* fine */ }
      window.__sched = [];
      const pending = [];
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => p, Plugins: { LocalNotifications: {
        checkPermissions: async () => ({ display: 'granted' }), requestPermissions: async () => ({ display: 'granted' }),
        getPending: async () => ({ notifications: pending.slice() }), cancel: async () => { pending.length = 0; },
        schedule: async ({ notifications }) => { pending.push(...notifications); window.__sched = notifications.map((n) => ({ title: n.title, at: n.schedule.at, open: n.extra?.open })); },
        addListener: async () => ({ remove() {} }),
        checkExactNotificationSetting: async () => ({ exact_alarm: 'denied' }),
        changeExactNotificationSetting: async () => { window.__exactAsked = true; return { exact_alarm: 'denied' }; },
      } } };
    }, platform);
    const pg = await c.newPage();
    await pg.goto(BASE);
    await call(pg, 'POST', '/api/login', { password: PASSWORD });
    await pg.reload();
    await pg.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
    return { c, pg };
  };
  const scheduled = (pg) => pg.evaluate(() => window.__sched);
  const phoneN = await appWith(412, 915, 'android');
  check('the phone schedules “Take attendance” at the class’s start', await until(async () => (await scheduled(phoneN.pg)).some((n) => n.title === 'Take attendance: Adult Class' && n.open?.attendance === grp.id), 10000), JSON.stringify(await scheduled(phoneN.pg)));
  await closeDialogs(phoneN.pg);
  await settingsTabs(phoneN.pg);
  await phoneN.pg.locator('#settings-tab-general').click().catch(() => {});
  check('Settings shows what’s scheduled on the phone', await until(async () => /reminders? scheduled on this device/.test(await text(phoneN.pg, '.notify-status')), 8000));
  await phoneN.pg.getByRole('button', { name: 'allow on-time reminders' }).click();
  check('and offers Android’s on-time setting', await until(() => phoneN.pg.evaluate(() => window.__exactAsked === true)));
  await shot(phoneN.pg, 'phone-notify-settings');
  // The real moment: 9:30 in Selah's time zone (America/Chicago unless set), not 9:30 UTC.
  const sched = await scheduled(phoneN.pg);
  const startAt = Date.parse(sched.find((n) => n.title === 'Take attendance: Adult Class').at);
  const wall = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(startAt));
  check('it’s set for 9:30 in Selah’s time zone (not hours early)', wall === '09:30', `${new Date(startAt).toISOString()} is ${wall} in Chicago`);
  check('nothing is scheduled in the past', sched.every((n) => Date.parse(n.at) > Date.now()));
  await phoneN.c.close();
  const padN = await appWith(1180, 820, 'ios');
  check('the iPad schedules “Time to teach” with the lesson', await until(async () => (await scheduled(padN.pg)).some((n) => n.title === 'Time to teach: Linked Lesson' && n.open?.note === lessonNote), 10000), JSON.stringify(await scheduled(padN.pg)));
  // Attendance from Teach or Preach.
  const tp2 = padN.pg;
  await closeDialogs(tp2);
  await go(tp2, `#note/${lessonNote}`);
  await tp2.locator('.work-go').click();
  await tp2.locator('.preach').waitFor({ timeout: 8000 });
  check('Preach offers attendance for the linked class', await until(() => tp2.getByRole('button', { name: 'Attendance', exact: true }).isVisible(), 8000));
  await tp2.getByRole('button', { name: 'Attendance', exact: true }).click();
  await tp2.getByRole('button', { name: 'Ruth Anders' }).click();
  await shot(tp2, 'preach-attendance');
  check('checking someone off saves it', await until(async () => {
    const d = await call(tp2, 'GET', `/api/attendance/groups/${grp.id}`);
    return d.dates.some((x) => x.present?.length === 1);
  }, 5000));
  await padN.c.close();

  section('Daily Walk routine');
  const rc = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const rp2 = await rc.newPage();
  await rp2.goto(BASE);
  await call(rp2, 'POST', '/api/login', { password: PASSWORD });
  const tday = await rp2.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()));
  await call(rp2, 'PUT', '/api/esv', { apiKey: 'esvtestkey'.repeat(4) });
  const plan = await call(rp2, 'POST', '/api/plans', { source: 'bibleyear', today: tday });
  await call(rp2, 'POST', '/api/routine/items', { kind: 'plan', plan_id: plan.id });
  await call(rp2, 'POST', '/api/routine/items', { kind: 'journal' });
  await call(rp2, 'POST', '/api/routine/items', { kind: 'custom', title: 'Memory verse', minutes: 5, note: 'Psalm 119:11' });
  await call(rp2, 'PUT', '/api/routine/reminder', { time: '23:58' });
  await rp2.reload();
  await rp2.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(rp2);
  await go(rp2, '#dailywalk');
  // 13.0 after beta.27: every item but the journal is a card in its own color; the journal is the Journal button.
  check('Daily Walk shows the routine as cards', await until(async () => (await rp2.locator('.rt-cards > .dw-card').count()) === 2));
  check('a reading plan card and your own item’s card', (await rp2.locator('.rt-card-plan').count()) === 1 && (await rp2.locator('.rt-card-custom').count()) === 1);
  check('the journal isn’t a card', !(await rp2.locator('.rt-cards .rt-journal').count()));
  // After beta.28: a plan card lists the references; the text is fetched only on Read here, or every day with the option.
  check('the plan lists its passages without their text', await until(async () => (await rp2.locator('.rt-card-plan .rt-plan-ref').count()) > 0, 6000)
    && !(await rp2.locator('.rt-card-plan .rt-passage').count()));
  await rp2.locator('.rt-card-plan').getByRole('button', { name: 'Read here' }).first().click();
  check('Read here shows a passage in place', await until(() => rp2.locator('.rt-card-plan .rt-passage .esv-card-body').first().isVisible(), 8000));
  await rp2.locator('.rt-card-plan .rt-show-text input').click();
  check('Always show the text is saved on the item', await until(async () => (await call(rp2, 'GET', `/api/routine?date=${tday}&today=${tday}`)).items.find((x) => x.kind === 'plan')?.show_text === 1, 6000));
  check('and every passage shows its text', await until(async () => (await rp2.locator('.rt-card-plan .rt-passage').count()) === (await rp2.locator('.rt-card-plan .rt-plan-ref').count()), 8000));
  await shot(rp2, 'routine-cards');
  check('your own item shows its note', (await text(rp2, '.rt-card-custom')).includes('Psalm 119:11'));
  await rp2.locator('.rt-card-plan .dw-card-foot .dw-check').click();
  check('Mark all read finishes the plan', await until(async () => (await rp2.locator('.rt-card-plan.is-read').count()) === 1, 6000));
  check('a finished card folds to its header', await until(async () => (await rp2.locator('.rt-card-plan.is-folded').count()) === 1, 4000));
  await rp2.locator('.rt-card-plan .rt-fold').click();
  check('and opens again', await until(async () => (await rp2.locator('.rt-card-plan.is-folded').count()) === 0 && (await rp2.locator('.rt-card-plan .rt-plan-ref').count()) > 0, 4000));
  await rp2.locator('.rt-card-custom .dw-card-head .dw-check').click();
  check('your own item ticks off', await until(async () => (await rp2.locator('.rt-card-custom.is-read').count()) === 1));
  await rp2.locator('.page-actions').getByRole('button', { name: 'Journal' }).click();
  await rp2.locator('textarea.rt-journal').fill('Grace, not works.');
  await rp2.getByRole('button', { name: 'Save', exact: true }).click();
  check('the Journal button saves into the day’s note', await until(async () => !!(await call(rp2, 'GET', `/api/routine?date=${tday}&today=${tday}`)).journal, 6000));
  check('all done counts toward the streak', await until(async () => (await call(rp2, 'GET', `/api/routine?date=${tday}&today=${tday}`)).stats.streak === 1, 6000));
  check('an Add card opens Edit routine', (await rp2.locator('.rt-add-card').count()) === 1);
  await shot(rp2, 'routine-done');
  await go(rp2, '#dashboard');
  check('Home shows the routine card', await until(() => rp2.locator('.home-routine').isVisible(), 6000));
  await rc.close();
  const rem = await appWith(412, 915, 'android');
  check('the routine’s daily reminder is scheduled (tomorrow on)', await until(async () => (await scheduled(rem.pg)).some((n) => n.title === 'Daily Walk' && n.open?.section === 'dailywalk'), 10000), JSON.stringify((await scheduled(rem.pg)).map((n) => n.title)));
  await rem.c.close();

  // A devotional EPUB of your own as a routine item: today's reading in full, marked read.
  const { zipSync, strToU8 } = await import('fflate');
  const tdate = new Date(`${tday}T12:00:00Z`);
  const epub = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Mornings</dc:title><dc:creator>A. Writer</dc:creator></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
    // A month of dated readings around today (the importer wants at least 28); today's says “Grace meets you”.
    'OEBPS/c1.xhtml': strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${Array.from({ length: 31 }, (_, i) => { const d = new Date(tdate.getTime() + (i - 15) * 86400000); const h = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }); return `<h2>${h}</h2><p>${i === 15 ? 'Grace meets you this morning.' : `Reading for ${h}.`}</p>`; }).join('')}</body></html>`),
  });
  const dc = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const dp = await dc.newPage();
  await dp.goto(BASE);
  await call(dp, 'POST', '/api/login', { password: PASSWORD });
  await dp.reload();
  await dp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(dp);
  await go(dp, '#dailywalk');
  await dp.getByRole('button', { name: 'Edit routine' }).click();
  const chooser = dp.waitForEvent('filechooser');
  await dp.getByRole('button', { name: 'Devotional (EPUB)…' }).click();
  await (await chooser).setFiles({ name: 'test.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(epub) });
  check('an EPUB becomes a routine item', await until(async () => (await call(dp, 'GET', `/api/routine?date=${tday}&today=${tday}`)).items.some((x) => x.kind === 'devotional'), 8000));
  await dp.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  check('its reading for today shows in full on its own card', await until(async () => (await text(dp, '.dw-card-book .dw-body')).includes('Grace meets you'), 6000));
  await shot(dp, 'routine-devotional');
  await dp.locator('.dw-card-book .dw-card-foot .dw-check').click();
  check('and marks read', await until(async () => (await dp.locator('.dw-card-book.is-read').count()) === 1, 6000));
  await dc.close();

  section('Android back button');
  const bc = await browser.newContext({ viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, hasTouch: true });
  await bc.addInitScript(() => {
    window.__exited = false;
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: {
      addListener: async (name, fn) => { if (name === 'backButton') window.__back = fn; return { remove() {} }; },
      exitApp: async () => { window.__exited = true; },
    } } };
  });
  const bp = await bc.newPage();
  await bp.goto(BASE);
  await call(bp, 'POST', '/api/login', { password: PASSWORD });
  await bp.goto(`${BASE}/#dashboard`);
  await bp.reload();
  await bp.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(bp);
  const pressBack = () => bp.evaluate(() => window.__back?.());
  await bp.locator('.ar-tab', { hasText: 'Plan' }).click();
  await until(async () => bp.url().endsWith('#calendar'));
  await bp.getByRole('button', { name: 'More', exact: true }).click();
  await bp.waitForTimeout(300);
  await pressBack();
  check('back closes a menu first', await until(async () => !(await bp.locator('.context-menu, .sheet-backdrop').count()) && bp.url().endsWith('#calendar')));
  await pressBack();
  check('then goes back a page', await until(async () => bp.url().endsWith('#dashboard')), bp.url());
  check('without leaving the app', !(await bp.evaluate(() => window.__exited)));
  await pressBack();
  check('and leaves only from Home', await until(() => bp.evaluate(() => window.__exited === true)));
  await bc.close();

  section('Slides on a TV from the iPad');
  // A fake SlidesScreen plugin: a TV is connected, and each show and hide is counted.
  const tvc = await browser.newContext({ viewport: { width: 1180, height: 820 }, screen: { width: 1180, height: 820 }, hasTouch: true });
  await tvc.addInitScript(() => {
    window.__tv = [];
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { SlidesScreen: {
      status: async () => ({ connected: true }), addListener: async () => ({ remove() {} }),
      show: async (a) => { window.__tv.push(`show ${a.url}`); }, hide: async () => { window.__tv.push('hide'); },
    } } };
  });
  const tv = await tvc.newPage();
  await tv.goto(BASE);
  await call(tv, 'POST', '/api/login', { password: PASSWORD });
  await tv.reload();
  await tv.locator('.app').first().waitFor({ state: 'attached', timeout: 10000 });
  await closeDialogs(tv);
  await go(tv, `#note/${sermonNote}`);
  await tv.locator('.work-go').click();
  await tv.locator('.preach').waitFor({ timeout: 8000 });
  const calls = () => tv.evaluate(() => window.__tv);
  check('Preach with slides puts them on the TV', await until(async () => (await calls()).some((c) => c.startsWith('show ') && c.endsWith(`?tv=1#slides/${sermonNote}`))), JSON.stringify(await calls()));
  check('the slide bar says so', await tv.getByRole('button', { name: 'Slides on the TV' }).isVisible());
  check('no slides window button in the app', !(await tv.getByRole('button', { name: 'Open slides window' }).count()));
  await shot(tv, 'tablet-tv-bar');
  await tv.getByRole('button', { name: 'Slides on the TV' }).click();
  check('the TV button switches to mirroring', await until(async () => (await calls()).at(-1) === 'hide' && await tv.getByRole('button', { name: 'Mirroring the iPad' }).isVisible()));
  await tv.getByRole('button', { name: 'Mirroring the iPad' }).click();
  check('and back to the slides', await until(async () => (await calls()).at(-1)?.startsWith('show ')));
  await tvc.close();
  const screen = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const sp = await screen.newPage();
  await sp.goto(BASE);
  await call(sp, 'POST', '/api/login', { password: PASSWORD });
  await sp.goto(`${BASE}/?tv=1#slides/${sermonNote}`);
  await until(() => sp.locator('.slide.is-screen').isVisible(), 8000);
  check('the TV page shows the slide with no bar', await sp.locator('.slide.is-screen').isVisible() && !(await sp.locator('.slides-window-bar').count()));
  await shot(sp, 'tv-screen');
  await screen.close();
} catch (e) {
  failed++;
  console.error(`\n✗ ${e.stack ?? e}`);
} finally {
  await browser?.close();
  server.kill();
  await wait(500);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `\n✗ ${failed} failed.` : '\n✓ All passed.');
process.exit(failed ? 1 : 0);
