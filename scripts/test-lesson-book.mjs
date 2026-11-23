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

  section('The builder: the book edited in place');
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(async (p) => fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p }) }), PASSWORD);
  await page.reload();
  await page.waitForTimeout(1500);
  for (const t of ['Later', 'Got it', 'Not now']) { const b = page.locator('button', { hasText: t }); if (await b.count()) await b.first().click().catch(() => {}); }
  const openBook = async () => {
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })), study.id);
    const opener = page.locator('button', { hasText: 'Lesson book…' });
    await until(async () => (await opener.count()) > 0);
    await opener.first().click();
    return until(() => page.locator('.lb-edit').isVisible());
  };
  check('the series page opens the builder, with the book to edit', await openBook(), errors.join(' | ') || (await page.locator('.cb').count() ? 'cb shown' : 'no cb'));
  const docText = () => page.locator('.lb-edit').innerText();
  check('the lessons are copied in', await until(async () => /Lesson 1: Saved by grace[\s\S]*Lesson 2: One new people/.test(await docText())));
  const view = (label) => page.locator('.cb-edition button', { hasText: label }).click();
  const previewText = () => page.locator('.cb-preview .lesson-book').innerText();
  await view('Student book');
  check('the student book has blanks', await until(async () => (await page.locator('.cb-preview .handout-blank').count()) === 2 && (await page.locator('.cb-preview .handout-answer').count()) === 0));
  await view('Teacher guide');
  check('the teacher guide has the answers', await until(async () => (await page.locator('.cb-preview .handout-answer').count()) === 2));
  await view('Edit');
  await page.waitForSelector('.lb-edit');
  await page.fill('.lb-cover-input[aria-label="Subtitle"]', 'Six weeks in the letter');

  // Type at the end of the book, with a Blank in it.
  const tool = (label) => page.locator('.cb-tool', { hasText: label }).first();
  // In lesson 1, after its first paragraph (the end of the book is inside lesson 2's student-only notes).
  await page.locator('.lb-edit p', { hasText: 'We are saved by' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Grace leaves no room for ');
  await tool('Blank').click();
  await page.keyboard.type('boasting');
  await tool('Blank').click();
  await page.keyboard.type('.');
  check('Blank marks words in the book', await until(async () => (await page.locator('.lb-edit mark', { hasText: 'boasting' }).count()) === 1));
  await page.keyboard.press('Enter');
  await tool('Leader note').click();
  await page.keyboard.type('Bring a map of Ephesus.');
  check('a leader note is a Teacher only block', await until(async () => (await page.locator('.lb-edit .book-edition-teacher', { hasText: 'Bring a map' }).count()) === 1));
  await page.keyboard.press('Control+End');
  await page.fill('.cb-lines-n input', '6');
  await tool('Writing lines').click();
  check('writing lines go in', await until(async () => (await page.locator('.lb-edit .book-lines[data-lines="6"]').count()) === 1));
  const breaks = await page.locator('.lb-edit .book-page-break').count();
  await tool('Prayer requests').click();
  check('a ready-made page goes in on a new page', await until(async () => (await page.locator('.lb-edit .book-page-break').count()) === breaks + 1 && /Prayer requests/.test(await docText())));
  check('and the contents list it', await until(async () => /Prayer requests/.test(await page.locator('.lb-contents-auto').innerText())));
  await page.locator('.lb-edit h1', { hasText: 'Prayer requests' }).click();
  await tool('Student only').click();
  check('Student only wraps the block', await until(async () => (await page.locator('.lb-edit .book-edition-student h1', { hasText: 'Prayer requests' }).count()) === 1));
  await view('Student book');
  check('the student book: the blank, no leader note, the student page', await until(async () => {
    const t = await previewText();
    return (await page.locator('.cb-preview .handout-blank').count()) === 3 && !t.includes('Bring a map') && t.includes('Prayer requests');
  }), (await previewText()).slice(-400));
  await view('Teacher guide');
  check('the teacher guide: the answer and the leader note, no student page', await until(async () => {
    const t = await previewText();
    return t.includes('Bring a map') && !/Prayer requests/.test(t.split('Contents')[1] ?? t) && (await page.locator('.cb-preview .handout-answer', { hasText: 'boasting' }).count()) === 1;
  }), (await previewText()).slice(-500));
  await view('Edit');
  await page.waitForSelector('.lb-edit');

  section('The bank and the lessons');
  await page.locator('.lb-edit').click();
  await page.keyboard.press('Control+End');
  await page.locator('.cb-tabs button', { hasText: 'Bank' }).click();
  await page.locator('.cb-piece', { hasText: 'What does Paul mean by gift?' }).locator('button', { hasText: 'Insert' }).click();
  check('a lesson’s question goes in at the cursor', await until(async () => ((await docText()).match(/What does Paul mean by gift\?/g) ?? []).length === 2));
  await page.locator('.cb-bank .rb-body').first().click();
  await page.keyboard.type('Memory verse: Ephesians 2:8');
  await page.locator('.cb-bank-buttons button', { hasText: 'Add to bank' }).click();
  check('your own piece is kept in the bank', await until(async () => (await page.locator('.cb-piece-mine').count()) === 1));
  await page.locator('.lb-edit').click();
  await page.keyboard.press('Control+End');
  await page.locator('.cb-piece-mine button', { hasText: 'Insert' }).click();
  check('and goes into the book', await until(async () => /Memory verse: Ephesians 2:8/.test(await docText())));
  await page.locator('.cb-tabs button', { hasText: 'Layout' }).click();
  await page.locator('label.field:has-text("Font") select').selectOption('sans');
  await page.locator('label.field:has-text("Header") select').selectOption('title');
  check('the layout changes the book', await until(async () => /sans-serif/.test(await page.locator('.lesson-book').first().getAttribute('style'))));
  check('saves as you go', await until(async () => (await page.locator('.cb-name .muted').innerText()).includes('Saved'), 6000));
  const saved = await api('GET', `/api/curricula/${book.id}`);
  check('the book is kept', saved.data.subtitle === 'Six weeks in the letter' && /<mark>boasting<\/mark>/.test(saved.data.doc) && /data-edition="teacher"/.test(saved.data.doc) && /data-lines="6"/.test(saved.data.doc) && saved.data.font === 'sans' && saved.data.bank?.length === 1, JSON.stringify({ sub: saved.data.subtitle, mark: /<mark>boasting/.test(saved.data.doc), ed: /data-edition=.teacher/.test(saved.data.doc), lines: /data-lines=.6/.test(saved.data.doc), font: saved.data.font, bank: saved.data.bank?.length }));
  const bookNote = await api('GET', `/api/notes/${book.note_id}`);
  check('the book’s note is the teacher guide', bookNote.html.includes('Teacher guide') && bookNote.html.includes('Bring a map') && !bookNote.html.includes('data-edition'), JSON.stringify({ tg: bookNote.html.includes('Teacher guide'), map: bookNote.html.includes('Bring a map'), ed: bookNote.html.includes('data-edition') }));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'lesson-book.png') });
  await view('Student book');
  await page.evaluate(() => { window.print = () => { window.__printed = document.getElementById('handout-print')?.innerText ?? ''; window.__pageCss = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join(' '); }; });
  await page.locator('.cb-actions button', { hasText: 'Print' }).click();
  check('prints the edition shown', await until(async () => /Student book/.test(await page.evaluate(() => window.__printed ?? ''))));
  check('with the header and page numbers', await until(async () => { const css = await page.evaluate(() => window.__pageCss ?? ''); return css.includes('@top-center { content: "Ephesians for adults"') && css.includes('counter(page)'); }));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'lesson-book-student.png') });

  // A lesson changed after it was copied in.
  await page.locator('.cb-bar button[aria-label="Close"]').click();
  await api('PATCH', `/api/notes/${two.id}`, { html: '<p>Christ is our <mark>peace</mark>. He broke down the wall.</p>' });
  await openBook();
  await page.locator('.cb-tabs button', { hasText: 'Lessons' }).click();
  const twoItem = page.locator('.cb-lesson-item', { hasText: 'One new people' });
  check('the builder says a lesson changed', await until(async () => /Changed since/.test(await twoItem.innerText())));
  await twoItem.locator('button', { hasText: 'Update from lesson' }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  check('Update from lesson brings the change in', await until(async () => /broke down the wall/.test(await docText()) && /Lesson 2: One new people/.test(await docText())));
  check('and what was added elsewhere in the book stays', /Memory verse: Ephesians 2:8/.test(await docText()) && /Bring a map/.test(await docText()));
  check('it no longer says changed', await until(async () => /In the book/.test(await twoItem.innerText())));
  check('no page errors', !errors.length, errors.join(' | '));
  await page.locator('.cb-bar button[aria-label="Close"]').click();
  await wait(1200);

  section('A package for another church');
  const pkg = await (await fetch(`${BASE}/api/curricula/${book.id}/package`, { headers: { cookie } })).json();
  check('the package has the book and its lessons', pkg.format === 'selah-lesson-book' && pkg.lessons.length === 2 && pkg.book.subtitle === 'Six weeks in the letter' && /data-lesson/.test(pkg.book.doc ?? ''));
  const made = await api('POST', '/api/curricula/import', pkg);
  check('importing makes a new series with the lessons', made.study_id !== study.id && made.lessons.length === 2 && made.lessons[0].html.includes('<mark>grace</mark>'), JSON.stringify(made).slice(0, 300));
  check('the book’s lessons point to the new lessons', made.lessons.every((l) => made.data.doc.includes(`data-lesson="${l.id}"`)) && !made.data.doc.includes(`data-lesson="${one.id}"`), made.data.doc.slice(0, 300));
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
