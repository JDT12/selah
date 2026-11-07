import path from 'node:path';
import sax from 'sax';
import { db, tx } from './db.js';
import { escapeHtml, htmlToText } from './html.js';
import { setNoteTags } from './tags.js';
import { myNotesId } from './mynotes.js';
import { plansOn } from './readingplans.js';
import { readZip } from './zip.js';
import { allPrayers, hasPrayers, prayedDays, prayerDay, prayerNeeded, setPrayed } from './prayer.js';

/**
 * The Daily Walk page: each day's reading from the devotional books imported as EPUBs, side by side, with a "read" check per reading, stats, and a journal note per day. The day's prayers (prayer.js) count as one more
 * reading: a day is complete when everything is read and every request due that day is prayed.
 *
 * Days are "YYYY-MM-DD" in the user's time zone (the page sends them); readings are looked up by month and day.
 * Everything here is a private reader: the text is shown only in this app, credited and linked to its source.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

db.exec(`
CREATE TABLE IF NOT EXISTS dw_books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dw_entries (
  book_id INTEGER NOT NULL REFERENCES dw_books(id) ON DELETE CASCADE,
  mmdd TEXT NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, mmdd)
);
CREATE TABLE IF NOT EXISTS dw_reads (
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (source, day)
);
CREATE TABLE IF NOT EXISTS dw_journal (
  day TEXT PRIMARY KEY,
  note_id INTEGER NOT NULL
);`);
// Reading schedules (books before 6.2 were all dated) and which devotionals are connected. For numbered books,
// dw_entries.mmdd holds "#<day>" instead of a month and day, and num the day number.
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('dw_books', 'schedule')) {
  db.exec(`ALTER TABLE dw_books ADD COLUMN schedule TEXT NOT NULL DEFAULT 'date';
    ALTER TABLE dw_books ADD COLUMN start_day TEXT;
    ALTER TABLE dw_books ADD COLUMN length INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE dw_books ADD COLUMN connected INTEGER NOT NULL DEFAULT 1;`);
}
if (!hasColumn('dw_entries', 'num')) db.exec('ALTER TABLE dw_entries ADD COLUMN num INTEGER');
// 7.3: My Utmost for His Highest is gone (its text is under copyright). Its saved readings and settings go with it;
// read checks stay in dw_reads but no longer count, like any removed source's.
db.exec(`DROP TABLE IF EXISTS dw_utmost;
  DELETE FROM settings WHERE key IN ('dailywalk.utmost', 'dailywalk.utmostIndex');`);

/** At most this many devotionals show on the page at a time; the rest wait in the library. */
export const MAX_CONNECTED = 3;

const dayParam = (v) => {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) throw httpError(400, 'Bad date.');
  return s;
};
const mmddOf = (day) => day.slice(5);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const isWeekday = (day) => dow(day) % 6 !== 0;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** Monday-to-Friday days from a to b, both included (0 when b is before a). */
export function weekdaysThrough(a, b) {
  const n = daysBetween(a, b) + 1;
  if (n <= 0) return 0;
  let count = Math.floor(n / 7) * 5;
  for (let i = 0, d = dow(a); i < n % 7; i++, d = (d + 1) % 7) if (d % 6 !== 0) count++;
  return count;
}
const longDate = (day) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${day}T00:00:00Z`));

// ---------- cleaning HTML ----------

// Classes kept from the sources (as "dw-<name>") so the page can lay out Scripture and the book's sections.
const CLASSES = new Set(['normal', 'no-indent', 'line', 'line-indent', 'line-group', 'reflection', 'thought',
  'reflection-head', 'thought-head', 'verse-num', 'divine-name']);
const KEEP = { p: 'p', h2: 'h2', h3: 'h3', h4: 'h4', em: 'em', i: 'em', strong: 'strong', b: 'strong', br: 'br',
  blockquote: 'blockquote', span: 'span', sup: 'sup', sub: 'sub', ul: 'ul', ol: 'ol', li: 'li' };
const DROP = new Set(['script', 'style', 'head', 'title', 'h1', 'svg', 'math', 'iframe', 'object', 'noscript', 'nav']);
const VOID = new Set(['br']);

/**
 * Books laid out with named paragraph and character styles (InDesign exports such as Crossway's: "_Italic",
 * "_Smallcaps", "_Footnote-Reference") carry their formatting in class names. Returns { tag, cls } for one of those,
 * or null to treat the element as usual.
 */
function styleOf(name, classes, epubType) {
  if (name === 'span' || name === 'a') {
    if (/noteref/i.test(epubType ?? '') || /foot-?note-?ref|note-?ref|superscript/i.test(classes)) return { tag: 'sup', cls: null };
    if (/small-?caps/i.test(classes)) return { tag: 'span', cls: 'divine-name' };
    if (/(^|[\s_-])bold/i.test(classes)) return { tag: 'strong', cls: null };
    if (/(^|[\s_-])ital/i.test(classes)) return { tag: 'em', cls: null };
  }
  if (name === 'p' && /foot-?note/i.test(classes)) return { tag: 'p', cls: 'footnote' };
  return null;
}

const VOID_TAGS = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'col', 'area', 'source']);
/**
 * Drops closing tags with nothing open to close: a day cut from the middle of a page ends with its section's </div>,
 * which would close the root and turn the rest into text.
 */
function dropStrayCloses(html) {
  const open = [];
  return html.replace(/<(\/?)([a-z][\w:-]*)\b[^>]*?(\/?)>/gi, (tag, close, name, self) => {
    const n = name.toLowerCase();
    if (self || VOID_TAGS.has(n)) return tag;
    if (!close) { open.push(n); return tag; }
    const at = open.lastIndexOf(n);
    if (at < 0) return '';
    open.length = at;
    return tag;
  });
}

/**
 * Rebuilds HTML from a short list of harmless tags; links, images and everything else are unwrapped to their
 * text. Spans are kept only when they carry a known class (verse numbers, small-caps LORD).
 */
export function cleanHtml(input) {
  const parser = sax.parser(false, { lowercase: true });
  let out = '';
  let dropping = 0;
  const stack = [];
  // sax reports a close for every open tag (unclosed ones when their parent closes), so a stack lines them up.
  parser.onopentag = (node) => {
    if (dropping || DROP.has(node.name)) { stack.push({ drop: true }); dropping += 1; return; }
    const classes = String(node.attributes.class ?? '');
    const look = styleOf(node.name, classes, node.attributes['epub:type']);
    const tag = look?.tag ?? KEEP[node.name];
    const cls = look ? look.cls : classes.split(/\s+/).find((c) => CLASSES.has(c));
    if (!tag || (tag === 'span' && !cls)) { stack.push({ tag: null }); return; }
    out += `<${tag}${cls ? ` class="dw-${cls}"` : ''}>`;
    stack.push({ tag: VOID.has(tag) ? null : tag });
  };
  parser.onclosetag = () => {
    const top = stack.pop();
    if (!top) return;
    if (top.drop) { dropping -= 1; return; }
    if (top.tag) out += `</${top.tag}>`;
  };
  parser.ontext = (t) => { if (!dropping) out += escapeHtml(t); };
  parser.oncdata = parser.ontext;
  parser.onerror = () => { parser.error = null; parser.resume(); };
  // One root element: sax treats anything after the root closes as plain text.
  parser.write(`<div>${dropStrayCloses(String(input))}</div>`).close();
  while (stack.length) { const top = stack.pop(); if (top.tag) out += `</${top.tag}>`; }
  return out
    .replace(/<(p|h[2-4]|li|blockquote)(?: class="[^"]*")?>\s*<\/\1>/g, '') // empty blocks
    .replace(/<sup>\s*<\/sup>/g, '')
    .replace(/ /g, ' ')
    .trim();
}

const text = (html) => htmlToText(html).replace(/\s+/g, ' ').trim();

// ---------- devotional books (EPUB) ----------

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1] ?? '';
const decode = (s) => text(cleanHtml(s));

// "October 19", "Monday, October 19th", "October 19: Title"
const DATE_HEAD = new RegExp(`^(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\\s+)?(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b[\\s.:–—-]*(.*)$`, 'i');
// "Day 1", "DAY 12: Title", "Day 45 — Title"
const DAY_HEAD = /^day\s+(\d{1,3})\b[\s.:–—-]*(.*)$/i;

/**
 * Reads a daily devotional EPUB. Every h1–h3 that names a day starts that day's entry, which runs to the next one or
 * the end of its page. Days are found two ways:
 * - dated headings ("October 19"): read on that date every year (schedule "date");
 * - numbered headings ("Day 1"): 365 or 366 days follow the calendar ("year", kept by month and day, so a 366-day book
 *   skips Feb 29 outside leap years and a 365-day book has nothing that day); 260 follow the year's weekdays, day 1
 *   being its first weekday ("weekdays-year"); any other number is read from a start day, every day or on weekdays,
 *   which the user picks ("daily" | "weekdays"; needsChoice).
 * Returns { title, author, schedule, length, needsChoice, entries: [{ key, num, title, html, prompt }] }.
 */
export function parseEpub(buf) {
  const files = readZip(buf);
  const read = (name) => files.get(name)?.toString('utf8');
  const container = read('META-INF/container.xml');
  const opfPath = container && attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? '', 'full-path');
  const opf = opfPath && read(opfPath);
  if (!opf) throw httpError(400, 'That EPUB has no table of contents (content.opf).');
  if (files.has('META-INF/encryption.xml') && /EncryptedData/i.test(read('META-INF/encryption.xml'))) {
    throw httpError(400, 'That EPUB is copy-protected (DRM), so it can’t be read.');
  }
  const title = decode(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? '') || 'Devotional';
  const author = decode(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1] ?? '');
  const base = path.posix.dirname(opfPath);
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) manifest.set(attr(m[0], 'id'), attr(m[0], 'href'));
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((m) => manifest.get(attr(m[0], 'idref'))).filter(Boolean);

  const dated = new Map();
  const numbered = new Map();
  const entry = (rest, label, fallback) => {
    // A "Week 6" marker before the next day belongs to that day, not this one.
    const html = cleanHtml(rest).replace(/(?:<p(?: class="[^"]*")?>\s*Week\s+\d+\s*<\/p>\s*)+$/i, '').trim();
    // The day's passages, from its section headings ("Acts 2:22–41 · 1 Peter 4:12–19 · Psalm 33:22").
    const heads = [...html.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1])).filter(Boolean);
    const prompt = [...html.matchAll(/<p class="dw-thought">([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).join('\n');
    const sub = text(/<h3>([\s\S]*?)<\/h3>/.exec(html)?.[1] ?? ''); // "Day 1" with its title in a subheading
    return { title: label || heads.join(' · ') || sub || fallback, html, prompt };
  };
  for (const href of spine) {
    let name;
    try { name = path.posix.normalize(path.posix.join(base, decodeURIComponent(href.split('#')[0]))); } catch { continue; }
    const doc = read(name);
    if (!doc) continue;
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(doc)?.[1] ?? doc;
    const marks = [];
    // Headings, or a paragraph that says only "Day 21" / "October 19" (books styled with classes, not h1–h3).
    for (const h of body.matchAll(/<(h[1-3]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const t = decode(h[2]);
      const d = DATE_HEAD.exec(t);
      const n = !d && DAY_HEAD.exec(t);
      if (h[1].toLowerCase() === 'p' && (d?.[3] || n?.[2])) continue;
      if (d || (n && +n[1] >= 1)) marks.push({ at: h.index, end: h.index + h[0].length, d, n });
    }
    marks.forEach((m, i) => {
      let rest = body.slice(m.end, marks[i + 1]?.at ?? body.length);
      // The day's title in its own styled paragraph right under the marker (<p class="_Day-Title">).
      const titled = /^\s*<p\b[^>]*\bclass\s*=\s*["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(rest);
      const titleText = titled ? decode(titled[1]) : '';
      if (titleText) rest = rest.slice(titled[0].length);
      if (m.d) {
        const month = MONTHS.findIndex((x) => x.toLowerCase() === m.d[1].toLowerCase()) + 1;
        if (new Date(Date.UTC(2024, month - 1, +m.d[2])).getUTCMonth() !== month - 1 || +m.d[2] < 1) return; // "February 30"
        const mmdd = `${String(month).padStart(2, '0')}-${String(+m.d[2]).padStart(2, '0')}`;
        if (!dated.has(mmdd)) dated.set(mmdd, { key: mmdd, num: null, ...entry(rest, m.d[3].trim() || titleText, `${MONTHS[month - 1]} ${+m.d[2]}`) });
      } else {
        const num = +m.n[1];
        if (numbered.has(num)) return;
        const e = entry(rest, m.n[2].trim() || titleText, `Day ${num}`);
        // A title taken from the heading under "Day 1" isn't shown twice.
        const first = /^<(h[23])>([\s\S]*?)<\/\1>/.exec(e.html);
        if (first && text(first[2]) === e.title) e.html = e.html.slice(first[0].length).trim();
        numbered.set(num, { num, ...e });
      }
    });
  }
  if (dated.size >= 28 && dated.size >= numbered.size) {
    return { title, author, schedule: 'date', length: dated.size, needsChoice: false, entries: [...dated.values()] };
  }
  if (numbered.size < 3) {
    throw httpError(400, 'Couldn’t find daily readings in that EPUB (headings with a date such as “October 19” or a day such as “Day 1”).');
  }
  const length = Math.max(...numbered.keys());
  const list = [...numbered.values()].sort((a, b) => a.num - b.num);
  if (length === 365 || length === 366) {
    // Day n is the nth day of a leap year (366 days) or a common one (365).
    const y = length === 366 ? 2024 : 2025;
    return { title, author, schedule: 'year', length, needsChoice: false,
      entries: list.map((e) => ({ ...e, key: addDays(`${y}-01-01`, e.num - 1).slice(5) })) };
  }
  const schedule = length === 260 ? 'weekdays-year' : 'daily';
  return { title, author, schedule, length, needsChoice: schedule === 'daily', entries: list.map((e) => ({ ...e, key: `#${e.num}` })) };
}

/** The key of a book's entry for a day ("MM-DD" or "#<day number>"), or null when it has no reading scheduled. */
export function entryKey(book, day) {
  let n;
  switch (book.schedule) {
    case 'weekdays-year': n = isWeekday(day) ? weekdaysThrough(`${day.slice(0, 4)}-01-01`, day) : 0; break;
    case 'daily': n = book.start_day && day >= book.start_day ? daysBetween(book.start_day, day) + 1 : 0; break;
    case 'weekdays': n = book.start_day && isWeekday(day) ? weekdaysThrough(book.start_day, day) : 0; break;
    default: return mmddOf(day);
  }
  return n >= 1 && n <= book.length ? `#${n}` : null;
}

/** Why a book has nothing on a day, for the page. */
function offDayNote(book, day) {
  const weekdays = book.schedule === 'weekdays' || book.schedule === 'weekdays-year';
  if (book.schedule === 'daily' || book.schedule === 'weekdays') {
    if (day < book.start_day) return `This book starts on ${longDate(book.start_day)}.`;
    if (weekdays && !isWeekday(day)) return 'This book is read on weekdays, so there’s no reading today.';
    return `You’ve come to the end of this book (${book.length} days). Start it again under Books, or disconnect it to make room for another.`;
  }
  if (weekdays && !isWeekday(day)) return 'This book is read on weekdays, so there’s no reading today.';
  if (book.schedule === 'weekdays-year') return `This book has ${book.length} weekday readings, and this year has more weekdays than that.`;
  return 'This book has no reading for this day.';
}

const connectedCount = () => db.prepare('SELECT COUNT(*) AS n FROM dw_books WHERE connected = 1').get().n;

/** Adds a book to the library, connected when there's room. `today` is day 1 of a book read from its upload day. */
export function addBook(buf, today = new Date().toISOString().slice(0, 10)) {
  const book = parseEpub(buf);
  return tx(() => {
    const connected = connectedCount() < MAX_CONNECTED;
    const start = book.schedule === 'daily' ? today : null;
    const { lastInsertRowid } = db.prepare(`INSERT INTO dw_books (title, author, added_at, schedule, start_day, length, connected)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(book.title.slice(0, 300), book.author.slice(0, 300), Date.now(), book.schedule,
      start, book.length, connected ? 1 : 0);
    const id = Number(lastInsertRowid);
    const ins = db.prepare('INSERT INTO dw_entries (book_id, mmdd, title, html, prompt, num) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of book.entries) ins.run(id, e.key, e.title.slice(0, 500), e.html, e.prompt, e.num);
    return { id, key: `book:${id}`, title: book.title, author: book.author, entries: book.entries.length, schedule: book.schedule,
      length: book.length, start_day: start, needsChoice: book.needsChoice, connected };
  });
}

const allBooks = () => db.prepare(`SELECT b.id, b.title, b.author, b.added_at, b.schedule, b.start_day, b.length, b.connected,
  COUNT(e.mmdd) AS entries FROM dw_books b LEFT JOIN dw_entries e ON e.book_id = b.id GROUP BY b.id ORDER BY b.id`).all();
/** The connected books, in the order they show. */
const books = () => allBooks().filter((b) => b.connected);

/** Every devotional in the library, for the Books dialog. */
const library = () => allBooks().map((b) => ({ ...b, key: `book:${b.id}`, connected: !!b.connected }));

// ---------- reading, stats ----------

const sourceKeys = () => [...books().map((b) => `book:${b.id}`), ...(hasPrayers() ? ['prayer'] : [])];
// Which readings a day has, from the connected devotionals: a book where it has an entry scheduled, prayer when
// requests were due (or prayed).
function needed(day, bookDays, prayers) {
  const keys = [...bookDays].filter(([, { book, set }]) => set.has(entryKey(book, day))).map(([key]) => key);
  if (prayers.length && prayerNeeded(day, prayers)) keys.push('prayer');
  return keys;
}

/**
 * Streaks count days on which every reading was checked. Today doesn't break a streak until it's over.
 * heat: the last 26 weeks, day -> 1 (some read) | 2 (all read).
 */
export function stats(today) {
  const keys = new Set(sourceKeys());
  const bookDays = new Map(books().map((b) => [`book:${b.id}`,
    { book: b, set: new Set(db.prepare('SELECT mmdd FROM dw_entries WHERE book_id = ?').all(b.id).map((r) => r.mmdd)) }]));
  const byDay = new Map();
  for (const r of db.prepare('SELECT source, day FROM dw_reads ORDER BY day').all()) {
    if (!keys.has(r.source)) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, new Set());
    byDay.get(r.day).add(r.source);
  }
  // Days with some prayers checked count as partly done.
  for (const day of prayedDays()) if (!byDay.has(day)) byDay.set(day, new Set());
  const prayers = allPrayers();
  const complete = (day) => {
    const read = byDay.get(day);
    return !!read && needed(day, bookDays, prayers).every((k) => read.has(k));
  };

  let streak = 0;
  for (let d = complete(today) ? today : addDays(today, -1); complete(d); d = addDays(d, -1)) streak++;
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of [...byDay.keys()].sort().filter(complete)) {
    run = prev && addDays(prev, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }

  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const perSource = Object.fromEntries([...keys].map((k) => [k, 0]));
  let yearDays = 0;
  let monthDays = 0;
  let readings = 0;
  for (const [day, set] of byDay) {
    if (day > today || !day.startsWith(year)) continue;
    for (const k of set) { perSource[k] += 1; readings += 1; }
    if (complete(day)) { yearDays += 1; if (day.startsWith(month)) monthDays += 1; }
  }
  const heat = {};
  for (let i = 0; i < 26 * 7; i++) {
    const day = addDays(today, -i);
    if (byDay.has(day)) heat[day] = complete(day) ? 2 : 1;
  }
  return {
    streak, longest: Math.max(longest, streak), yearDays, monthDays, readings, perSource, heat,
    daysThisMonth: +today.slice(8, 10), daysThisYear: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`)) / DAY) + 1,
  };
}

// ---------- journal notes ----------

// 10.1: journal notes go to My notes (tagged Devotions), since notebooks are no longer shown.
const journalNotebook = () => myNotesId();

function createJournal(day, notebookId) {
  const existing = db.prepare(`SELECT j.note_id FROM dw_journal j JOIN notes n ON n.id = j.note_id
    WHERE j.day = ? AND n.deleted_at IS NULL`).get(day);
  if (existing) return { id: existing.note_id, existed: true };
  if (notebookId != null && !db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId)) throw httpError(404, 'Notebook not found.');
  const nb = notebookId ?? journalNotebook();
  if (!nb) throw httpError(409, 'Create a notebook first.');
  const parts = [];
  for (const b of books()) {
    const e = db.prepare('SELECT title, prompt FROM dw_entries WHERE book_id = ? AND mmdd = ?').get(b.id, entryKey(b, day));
    if (!e) continue;
    parts.push(`<h2>${escapeHtml(b.title)}</h2>`, `<p><strong>Readings:</strong> ${escapeHtml(e.title)}</p>`);
    if (e.prompt) parts.push(`<blockquote><p><strong>Thoughts for prayer:</strong> ${escapeHtml(e.prompt)}</p></blockquote>`);
  }
  // 10.2: the day's passages from your reading plans.
  for (const p of plansOn(day)) parts.push(`<h2>${escapeHtml(p.title)}</h2>`, `<p><strong>Readings:</strong> ${escapeHtml(p.refs.join('; '))}</p>`);
  parts.push('<h2>What stood out to me</h2>', '<p></p>', '<h2>Application</h2>', '<p></p>', '<h2>Prayer</h2>');
  const prayers = prayerDay(day).items;
  if (prayers.length) {
    parts.push(`<ul>${prayers.map((p) => `<li><p>${escapeHtml(p.title)}${p.person ? ` (${escapeHtml(p.person)})` : ''}${p.refs ? `: ${escapeHtml(p.refs)}` : ''}</p></li>`).join('')}</ul>`);
  }
  parts.push('<p></p>');
  const html = parts.join('');
  const now = Date.now();
  return tx(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO notes (notebook_id, title, html, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nb, `Daily Walk: ${longDate(day)}`, html, htmlToText(html), now, now);
    const id = Number(lastInsertRowid);
    setNoteTags(id, ['Devotions']);
    db.prepare('INSERT INTO dw_journal (day, note_id) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET note_id = excluded.note_id').run(day, id);
    return { id, existed: false };
  });
}

// ---------- routes ----------

export default async function dailyWalkRoutes(app) {
  // Everything for one day: ?date=2026-10-19&today=2026-10-19 (today, in the user's time zone, for the stats).
  app.get('/api/daily-walk', async (req) => {
    const day = dayParam(req.query.date);
    const today = dayParam(req.query.today ?? day);
    const reads = new Set(db.prepare('SELECT source FROM dw_reads WHERE day = ?').all(day).map((r) => r.source));
    const sources = [];
    for (const b of books()) {
      const key = entryKey(b, day);
      const e = key && db.prepare('SELECT title, html, num FROM dw_entries WHERE book_id = ? AND mmdd = ?').get(b.id, key);
      sources.push({ key: `book:${b.id}`, kind: 'book', name: b.title, author: b.author, schedule: b.schedule, length: b.length,
        ...(e ?? { missing: true, note: offDayNote(b, day) }) });
    }
    for (const s of sources) s.read = reads.has(s.key);
    const journal = db.prepare(`SELECT j.note_id FROM dw_journal j JOIN notes n ON n.id = j.note_id
      WHERE j.day = ? AND n.deleted_at IS NULL`).get(day)?.note_id ?? null;
    return { date: day, sources, max: MAX_CONNECTED, journal, journalNotebook: journalNotebook() ?? null, prayer: prayerDay(day), stats: stats(today) };
  });

  // Body: { source, date, read, today } -> fresh stats.
  app.put('/api/daily-walk/read', async (req) => {
    const b = req.body ?? {};
    const day = dayParam(b.date);
    const today = dayParam(b.today ?? day);
    if (!sourceKeys().includes(b.source)) throw httpError(400, 'Unknown reading.');
    if (b.read) db.prepare('INSERT INTO dw_reads (source, day, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(b.source, day, Date.now());
    else db.prepare('DELETE FROM dw_reads WHERE source = ? AND day = ?').run(b.source, day);
    return stats(today);
  });

  // Body: { id, date, prayed, today } -> { stats, prayer }: checks one prayer request for a day.
  app.put('/api/daily-walk/prayed', async (req) => {
    const b = req.body ?? {};
    const day = dayParam(b.date);
    setPrayed(Number(b.id), day, !!b.prayed);
    return { stats: stats(dayParam(b.today ?? day)), prayer: prayerDay(day) };
  });

  app.get('/api/daily-walk/books', async () => ({ max: MAX_CONNECTED, books: library() }));

  // An EPUB upload (multipart, one file); ?today=YYYY-MM-DD is day 1 of a book read from its upload day.
  app.post('/api/daily-walk/books', async (req) => {
    const today = req.query.today ? dayParam(req.query.today) : undefined;
    const file = await req.file({ limits: { fileSize: 64 * 1024 * 1024 } });
    if (!file) throw httpError(400, 'No file.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw httpError(413, 'That file is too large (64 MB at most).');
    return addBook(buf, today);
  });

  // Body: { connected?, schedule?: 'daily' | 'weekdays', start_day? }.
  app.patch('/api/daily-walk/books/:id', async (req) => {
    const b = req.body ?? {};
    const book = db.prepare('SELECT * FROM dw_books WHERE id = ?').get(Number(req.params.id));
    if (!book) throw httpError(404, 'Book not found.');
    if (b.connected === true && !book.connected && connectedCount() >= MAX_CONNECTED) {
      throw httpError(409, `${MAX_CONNECTED} devotionals are connected already. Disconnect one first.`);
    }
    if (b.schedule !== undefined || b.start_day !== undefined) {
      if (book.schedule !== 'daily' && book.schedule !== 'weekdays') throw httpError(400, 'This book follows the calendar, so its schedule is fixed.');
      if (b.schedule !== undefined && !['daily', 'weekdays'].includes(b.schedule)) throw httpError(400, 'Bad schedule.');
      db.prepare('UPDATE dw_books SET schedule = ?, start_day = ? WHERE id = ?')
        .run(b.schedule ?? book.schedule, b.start_day !== undefined ? dayParam(b.start_day) : book.start_day, book.id);
    }
    if (typeof b.connected === 'boolean') db.prepare('UPDATE dw_books SET connected = ? WHERE id = ?').run(b.connected ? 1 : 0, book.id);
    return { max: MAX_CONNECTED, books: library() };
  });

  app.delete('/api/daily-walk/books/:id', async (req) => {
    const id = Number(req.params.id);
    tx(() => {
      db.prepare('DELETE FROM dw_entries WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM dw_books WHERE id = ?').run(id);
      db.prepare('DELETE FROM dw_reads WHERE source = ?').run(`book:${id}`);
    });
    return { ok: true };
  });

  // Body: { date, notebook_id? } -> { id, existed }: the day's journal note, made from a template the first time (in
  // the given notebook, else one named like "Journal"/"Devotions", else the first).
  app.post('/api/daily-walk/journal', async (req) => {
    const nb = req.body?.notebook_id;
    return createJournal(dayParam(req.body?.date), nb == null ? null : Number(nb));
  });
}
