#!/usr/bin/env node
// Tests 14.5 lesson books (npm run test:lesson-book): a throwaway Selah, a teaching series with two lessons, the
// book made from it (settings, the teacher guide kept as its note), the builder in Chromium (both editions, blanks and
// answers, print), and a package imported as a new series. Needs a built client. Exits 1 when something failed.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
const PORT = Number(process.env.TEST_BOOK_PORT ?? 8630);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'lesson-book-test-only';
const SHOTS = process.env.TEST_BOOK_SHOTS ?? null;

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
};
const section = (name) => console.log(`\n${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* again */ } await wait(200); } return false; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-book-test-'));
const env = {
  ...process.env, NOTEAPP_MODE: 'tenant', NOTEAPP_TENANT: 'booktest', NOTEAPP_TLS: '0', NOTEAPP_HOST: '127.0.0.1', NOTEAPP_PORT: String(PORT),
  NOTEAPP_CONTROL_PORT: String(PORT + 1), NOTEAPP_CONTROL_TOKEN: 'x'.repeat(40), NOTEAPP_DATA_DIR: path.join(dir, 'data'), NOTEAPP_STORAGE_DIR: path.join(dir, 'store'),
};
fs.mkdirSync(path.join(dir, 'store', 'files'), { recursive: true });
fs.writeFileSync(path.join(dir, 'store', '.note-app-storage'), '');
execFileSync(process.execPath, ['--input-type=module', '-e', "const a = await import('./server/auth.js'); await a.setPassword(process.env.TP); process.exit(0);"], { cwd: ROOT, env: { ...env, TP: PASSWORD }, stdio: 'ignore' });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { cookie, origin: BASE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

let browser = null;
try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/api/session`); break; } catch { await wait(250); } }
  await api('POST', '/api/login', { password: PASSWORD });
  await api('PUT', '/api/prefs/whatsNewSeen', { value: '99.9.9' });

  section('A series made into a book');
  const study = await api('POST', '/api/studies', { kind: 'teaching', title: 'Ephesians for adults', notebook: 'new' });
  const nb = (await api('GET', `/api/studies/${study.id}`)).notebook?.id ?? study.notebook_id;
  const one = await api('POST', '/api/notes', { notebook_id: nb, title: 'Saved by grace', html: '<h1>Hook</h1><p>We are saved by <mark>grace</mark> through faith.</p><h1>Look</h1><ul><li><p>What does Paul mean by gift?</p></li></ul>' });
  const two = await api('POST', '/api/notes', { notebook_id: nb, title: 'One new people', html: '<p>Christ is our <mark>peace</mark>.</p>' });
  await api('POST', `/api/studies/${study.id}/items`, [{ kind: 'session', title: 'Saved by grace', ref: 'Ephesians 2:1-10', note_id: one.id }, { kind: 'session', title: 'One new people', ref: 'Ephesians 2:11-22', note_id: two.id }])
    .catch(() => api('POST', `/api/studies/${study.id}/items`, { items: [{ kind: 'session', title: 'Saved by grace', ref: 'Ephesians 2:1-10', note_id: one.id }, { kind: 'session', title: 'One new people', ref: 'Ephesians 2:11-22', note_id: two.id }] }));
  const book = await api('POST', '/api/curricula', { study_id: study.id });
  check('the book has the series’ lessons, in order', book.lessons.map((l) => l.title).join('|') === 'Saved by grace|One new people', JSON.stringify(book.lessons.map((l) => l.title)));
  check('its note is made', !!book.note_id && book.note?.title === 'Ephesians for adults');
  check('a series that isn’t teaching or preaching is refused', await api('POST', '/api/curricula', { study_id: 999 }).then(() => false, () => true));

  section('The builder');
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(async (p) => fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p }) }), PASSWORD);
  await page.goto(`${BASE}/#study/${study.id}`);
  await page.reload();
  await page.waitForTimeout(1500);
  for (const t of ['Later', 'Got it', 'Not now']) { const b = page.locator('button', { hasText: t }); if (await b.count()) await b.first().click().catch(() => {}); }
  // Open the series however the app routes it, then its Lesson book button.
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })), study.id);
  const opener = page.locator('button', { hasText: 'Lesson book…' });
  check('the series page has Lesson book…', await until(async () => (await opener.count()) > 0));
  await opener.first().click();
  check('the builder opens', await until(() => page.locator('.cb-preview .lesson-book').isVisible()));
  const preview = () => page.locator('.cb-preview .lesson-book').innerText();
  check('the teacher guide shows the answers', await until(async () => (await page.locator('.cb-preview .handout-answer').count()) === 2));
  await page.locator('.cb-edition button', { hasText: 'Student book' }).click();
  check('the student book has blanks instead', await until(async () => (await page.locator('.cb-preview .handout-blank').count()) === 2 && (await page.locator('.cb-preview .handout-answer').count()) === 0));
  check('and room to write', (await page.locator('.cb-preview .handout-lines').count()) >= 1);
  await page.fill('label.field:has-text("Subtitle") input', 'Six weeks in the letter');
  const lessonRow = (t) => page.locator('.cb-row-lesson', { hasText: t });
  await lessonRow('Saved by grace').locator('.cb-sec').click();
  await lessonRow('Saved by grace').locator('.cb-fields .rb-body').nth(2).click();
  await page.keyboard.type('Why does grace leave no room for ');
  await lessonRow('Saved by grace').locator('.rb-blank').nth(2).click();
  await page.keyboard.type('boasting');
  await lessonRow('Saved by grace').locator('.rb-blank').nth(2).click();
  await page.keyboard.type('?');
  check('questions show in the student book', await until(async () => /Talk it over[\s\S]*room for/i.test(await preview())), (await preview()).slice(0, 700));
  check('a Blank in a question is a blank in the student book', await until(async () => (await page.locator('.cb-preview .lb-questions .handout-blank').count()) === 1));
  await page.locator('input[aria-label="Hook in the student book"]').uncheck();
  check('a part left out of the student book goes from it', await until(async () => !(await preview()).includes('We are saved')));
  await page.locator('.cb-edition button', { hasText: 'Teacher guide' }).click();
  check('and stays in the teacher guide, with the question’s answer', await until(async () => (await preview()).includes('We are saved') && (await page.locator('.cb-preview .lb-questions .handout-answer').count()) === 1));
  await page.locator('.cb-row-lesson .cb-row-head > input[type=checkbox]').nth(1).uncheck();
  check('a lesson left out goes from the book', await until(async () => !(await preview()).includes('One new people')));

  section('Pages, breaks and layout');
  await lessonRow('Saved by grace').locator('.cb-sec').click(); // closes it; still where new pages go after
  await page.locator('.cb-add select').selectOption({ label: 'Prayer requests' });
  check('a custom page is added', await until(async () => (await preview()).includes('Prayer requests')));
  await page.locator('.cb-add select').selectOption({ label: 'Answer key' });
  await page.locator('.cb-edition button', { hasText: 'Student book' }).click();
  check('a teacher-only page stays out of the student book', await until(async () => (await preview()).includes('Prayer requests') && !(await preview()).includes('Answer key')));
  await page.locator('.cb-edition button', { hasText: 'Teacher guide' }).click();
  const order = () => page.locator('.cb-preview .lesson-book > section > h2').allInnerTexts();
  check('pages go after the lesson that was open', await until(async () => { const o = await order(); return o.indexOf('Prayer requests') > o.indexOf('Lesson 1: Saved by grace'); }), JSON.stringify(await order()));
  for (let i = 0; i < 2; i++) await page.locator('.cb-row-page', { hasText: 'Prayer requests' }).locator('button[aria-label="Move up"]').click().catch(() => {});
  check('moving a page changes the order', await until(async () => { const o = await order(); return o.indexOf('Prayer requests') < o.indexOf('Lesson 1: Saved by grace'); }), JSON.stringify(await order()));
  await page.locator('.cb-side > .cb-sec', { hasText: 'Page layout' }).click();
  const breaks = () => page.locator('.cb-preview .lesson-book > section.lb-break').count();
  const before = await breaks();
  await page.locator('label.check-row:has-text("Each lesson and page starts a new page") input').uncheck();
  check('sections can run on', await until(async () => (await breaks()) < before), `${before} → ${await breaks()}`);
  await page.locator('label.field:has-text("Font") select').selectOption('sans');
  await page.locator('label.field:has-text("Text size") select').selectOption('14');
  const bookStyle = () => page.locator('.cb-preview .lesson-book').getAttribute('style');
  check('font and size change the book', await until(async () => /sans-serif/.test(await bookStyle()) && /--lb-text:14pt/.test(await bookStyle())));
  await page.locator('label.field:has-text("Header") select').selectOption('title');
  const runOn = await breaks();
  await page.locator('.cb-row-page', { hasText: 'Prayer requests' }).locator('.cb-sec').click();
  await page.locator('.cb-add button', { hasText: 'Page break' }).click();
  check('a page break starts a new page', await until(async () => (await breaks()) === runOn + 1), `${runOn} → ${await breaks()}`);

  section('The book bank');
  await lessonRow('Saved by grace').locator('.cb-sec').click();
  await page.locator('.cb-tabs button', { hasText: 'Bank' }).click();
  check('it says where pieces go', (await page.locator('.cb-target').innerText()).includes('Lesson 1: Saved by grace'));
  const gift = page.locator('.cb-piece', { hasText: 'What does Paul mean by gift?' });
  check('it has the lessons’ questions', await gift.count() === 1);
  await gift.locator('button', { hasText: 'Insert' }).click();
  const extra = () => page.locator('.cb-preview .lb-extra').first().innerText().catch(() => '');
  check('a piece goes into the lesson', await until(async () => /What does Paul mean by gift/.test(await extra())));
  await page.locator('.cb-bank .rb-body').first().click();
  await page.keyboard.type('Memory verse: Ephesians 2:8');
  await page.locator('.cb-bank-add').click();
  check('your own piece goes in the bank', await until(async () => (await page.locator('.cb-piece-mine').count()) === 1));
  await page.locator('.cb-piece-mine button', { hasText: 'Insert' }).click();
  check('and into the lesson', await until(async () => /Memory verse/.test(await extra())));
  await page.locator('.cb-tabs button', { hasText: 'Book' }).click();
  check('saves as you go', await until(async () => (await page.locator('.cb-name .muted').innerText()).includes('Saved'), 6000));
  const saved = await api('GET', `/api/curricula/${book.id}`);
  check('the settings are kept', saved.data.subtitle === 'Six weeks in the letter' && saved.data.lessons?.[two.id]?.skip === true && /<mark>boasting<\/mark>/.test(saved.data.lessons?.[one.id]?.questions ?? '')
    && saved.data.font === 'sans' && saved.data.newPage === false && Object.keys(saved.data.pages ?? {}).length === 2 && saved.data.bank?.length === 1 && saved.data.order?.some((k) => k.startsWith('B:')), JSON.stringify(saved.data).slice(0, 400));
  const bookNote = await api('GET', `/api/notes/${book.note_id}`);
  check('the book’s note is the teacher guide', bookNote.html.includes('Teacher guide') && bookNote.html.includes('handout-answer'), bookNote.html.slice(0, 200));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'lesson-book.png') });
  await page.locator('.cb-edition button', { hasText: 'Student book' }).click();
  await page.evaluate(() => { window.print = () => { window.__printed = document.getElementById('handout-print')?.innerText ?? ''; window.__pageCss = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join(' '); }; });
  await page.locator('.cb-actions button', { hasText: 'Print' }).click();
  check('prints the edition shown', await until(async () => /Student book/.test(await page.evaluate(() => window.__printed ?? ''))));
  check('with the header and page numbers', await until(async () => { const css = await page.evaluate(() => window.__pageCss ?? ''); return css.includes('@top-center { content: "Ephesians for adults"') && css.includes('counter(page)'); }));
  check('no page errors', !errors.length, errors.join(' | '));

  section('A package for another church');
  const pkg = await (await fetch(`${BASE}/api/curricula/${book.id}/package`, { headers: { cookie } })).json();
  check('the package has the book and its lessons', pkg.format === 'selah-lesson-book' && pkg.lessons.length === 2 && pkg.book.subtitle === 'Six weeks in the letter');
  const made = await api('POST', '/api/curricula/import', pkg);
  check('importing makes a new series with the lessons', made.study_id !== study.id && made.lessons.length === 2 && made.lessons[0].html.includes('<mark>grace</mark>'), JSON.stringify(made).slice(0, 300));
  check('the per-lesson settings move to the new lessons', /boasting/.test(made.data.lessons?.[made.lessons[0].id]?.questions ?? '') && made.data.lessons?.[made.lessons[1].id]?.skip === true, JSON.stringify(made.data.lessons));
  check('something else isn’t imported', await api('POST', '/api/curricula/import', { format: 'nope' }).then(() => false, () => true));
  check('the server logged no errors', !/Error|error:/.test(serverErr), serverErr.slice(0, 300));
} catch (e) {
  failed++;
  console.error(`\n✗ ${e.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n✗ ${failed} failed.` : '\n✓ All passed.');
process.exit(failed ? 1 : 0);
