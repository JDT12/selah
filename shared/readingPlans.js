/**
 * Reading plans (10.2): the built-in plans, a splitter for plans you build from books, CSV in and out, and the day
 * math. A plan is a schedule (an array of days, each an array of passages like "Genesis 1–3") read on chosen
 * weekdays from a start date. Shared by the server (it stores plans and works out today) and the browser (it builds
 * and previews plans before saving them).
 */
import { BOOKS, END, format, parse } from './scripture.js';
import { MCHEYNE } from './readingPlansMcheyne.js';

// ---------- chapters and splitting ----------

/** Every chapter a reference covers, as [book, chapter] pairs (a partial chapter counts once). */
function chaptersOf(text) {
  const out = [];
  for (const r of parse(text).refs) {
    for (let c = r.ch_start; c <= r.ch_end; c++) out.push([r.book, c]);
  }
  return out;
}

/** Chapters as readable passages: consecutive chapters of one book join ("Genesis 1–3"). */
export function labelChapters(list) {
  const parts = [];
  for (const [b, c] of list) {
    const last = parts[parts.length - 1];
    if (last && last.book === b && last.ch_end === c - 1) last.ch_end = c;
    else parts.push({ book: b, ch_start: c, ch_end: c });
  }
  return parts.map((p) => format({ ...p, v_start: 0, v_end: END }));
}

/** Splits chapters over `days` days as evenly as whole chapters allow. */
export function splitChapters(list, days) {
  const n = Math.max(1, Math.round(days));
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const to = Math.round(((i + 1) * list.length) / n);
    out.push(labelChapters(list.slice(at, to)));
    at = to;
  }
  return out;
}

/** The chapters of some books (by order), in canonical order. */
export function bookChapters(orders) {
  const pick = new Set(orders.map(Number));
  return BOOKS.filter((b) => pick.has(b.order)).flatMap((b) => Array.from({ length: b.chapters }, (_, i) => [b.order, i + 1]));
}

// ---------- the built-in plans ----------

const range = (from, to) => BOOKS.filter((b) => b.order >= from && b.order <= to).map((b) => b.order);

/** Bible in a year: the Old Testament once (Psalms and Proverbs aside), the New Testament once, Psalms and Proverbs twice. */
function bibleInAYear() {
  const ot = bookChapters(range(1, 39).filter((o) => o !== 19 && o !== 20));
  const nt = bookChapters(range(40, 66));
  const wisdom = bookChapters([19, 20]);
  const streams = [splitChapters(ot, 365), splitChapters(nt, 365), splitChapters([...wisdom, ...wisdom], 365)];
  return Array.from({ length: 365 }, (_, i) => streams.flatMap((s) => s[i]));
}

/**
 * The Bible in the order its events happened, as Selah arranges it: Job with the patriarchs, the Psalms with David's
 * life, Solomon's writings in his reign, the prophets beside the kings they spoke to, the exile and the return, a
 * harmony of the Gospels by chapters, and the letters where they fall in Acts. Scholars differ on some placements
 * (Joel, Job, Isaiah 40–66, many psalms); this is one reasonable order. Every chapter appears exactly once.
 */
const CHRONOLOGICAL = [
  'Genesis 1-11', 'Job 1-42', 'Genesis 12-50', 'Exodus 1-40', 'Leviticus 1-27', 'Numbers 1-36', 'Deuteronomy 1-34', 'Psalm 90',
  'Joshua 1-24', 'Judges 1-21', 'Ruth 1-4',
  '1 Samuel 1-20', 'Psalm 59', '1 Samuel 21-22', 'Psalm 34', 'Psalm 52', 'Psalm 56', 'Psalm 142', '1 Samuel 23-24', 'Psalm 57', '1 Samuel 25-31',
  '2 Samuel 1-4', '1 Chronicles 1-10', '2 Samuel 5-6', '1 Chronicles 11-16', 'Psalm 24', 'Psalm 96', 'Psalm 105', 'Psalm 106',
  '2 Samuel 7', '1 Chronicles 17', '2 Samuel 8-10', '1 Chronicles 18-19', '2 Samuel 11-12', 'Psalm 32', 'Psalm 51', '2 Samuel 13-15', 'Psalm 3', 'Psalm 63',
  '2 Samuel 16-22', 'Psalm 18', '2 Samuel 23-24', '1 Chronicles 20-29',
  'Psalms 1-2', 'Psalms 4-17', 'Psalms 19-23', 'Psalms 25-31', 'Psalm 33', 'Psalms 35-50', 'Psalms 53-55', 'Psalm 58', 'Psalms 60-62', 'Psalms 64-71',
  'Psalm 73', 'Psalms 75-78', 'Psalms 80-84', 'Psalms 86-89', 'Psalms 91-95', 'Psalms 97-104', 'Psalms 107-125', 'Psalms 128-136', 'Psalms 138-141', 'Psalms 143-150',
  '1 Kings 1-4', '2 Chronicles 1', 'Psalm 72', 'Song of Solomon 1-8', 'Proverbs 1-31', '1 Kings 5-8', '2 Chronicles 2-7', 'Psalm 127', '1 Kings 9-11', '2 Chronicles 8-9', 'Ecclesiastes 1-12',
  '1 Kings 12-14', '2 Chronicles 10-12', '1 Kings 15-16', '2 Chronicles 13-17', '1 Kings 17-22', '2 Chronicles 18-20', '2 Kings 1-8', 'Obadiah 1',
  '2 Chronicles 21-23', 'Joel 1-3', '2 Kings 9-14', '2 Chronicles 24-25', 'Jonah 1-4', 'Amos 1-9', '2 Chronicles 26', 'Hosea 1-14', 'Isaiah 1-12',
  '2 Kings 15-16', '2 Chronicles 27-28', 'Micah 1-7', 'Isaiah 13-27', '2 Kings 17-19', '2 Chronicles 29-32', 'Isaiah 28-39', '2 Kings 20-21', '2 Chronicles 33',
  'Nahum 1-3', '2 Kings 22-23', '2 Chronicles 34-35', 'Zephaniah 1-3', 'Habakkuk 1-3', 'Jeremiah 1-29', '2 Kings 24-25', '2 Chronicles 36', 'Jeremiah 30-52',
  'Lamentations 1-5', 'Psalm 74', 'Psalm 79', 'Psalm 137', 'Ezekiel 1-48', 'Daniel 1-12', 'Isaiah 40-66',
  'Ezra 1-6', 'Psalm 85', 'Psalm 126', 'Haggai 1-2', 'Zechariah 1-14', 'Esther 1-10', 'Ezra 7-10', 'Nehemiah 1-13', 'Malachi 1-4',
  'Luke 1', 'Matthew 1', 'Luke 2', 'Matthew 2', 'Luke 3', 'Mark 1', 'Matthew 3-4', 'John 1-4', 'Luke 4-5', 'Mark 2-3', 'Matthew 5-7', 'Luke 6-8',
  'Matthew 8-13', 'Mark 4-6', 'John 5-6', 'Matthew 14-17', 'Luke 9', 'Mark 7-9', 'John 7-11', 'Luke 10-19', 'Matthew 18-25', 'Mark 10-13', 'John 12-17',
  'Matthew 26-28', 'Mark 14-16', 'Luke 20-24', 'John 18-21',
  'Acts 1-12', 'James 1-5', 'Acts 13-14', 'Galatians 1-6', 'Acts 15-17', '1 Thessalonians 1-5', '2 Thessalonians 1-3', 'Acts 18-19', '1 Corinthians 1-16',
  '2 Corinthians 1-13', 'Romans 1-16', 'Acts 20-28', 'Ephesians 1-6', 'Philippians 1-4', 'Colossians 1-4', 'Philemon 1', '1 Timothy 1-6', 'Titus 1-3',
  '1 Peter 1-5', 'Hebrews 1-13', '2 Timothy 1-4', '2 Peter 1-3', 'Jude 1', '1 John 1-5', '2 John 1', '3 John 1', 'Revelation 1-22',
];
export const chronologicalChapters = () => CHRONOLOGICAL.flatMap(chaptersOf);

/** The plans Selah comes with: their names, what they are, and their schedules (made when first asked for). */
export const BUILT_IN = {
  bibleyear: {
    title: 'Bible in a Year',
    about: 'Each day some Old Testament, some New Testament, and a Psalm or Proverb. The Old and New Testaments once, Psalms and Proverbs twice.',
    calendar: true,
    schedule: bibleInAYear,
  },
  mcheyne: {
    title: 'M’Cheyne',
    about: 'Robert Murray M’Cheyne’s 1842 calendar: four readings a day, two for the family and two alone. The New Testament and Psalms twice, the rest of the Old Testament once.',
    calendar: true,
    schedule: () => MCHEYNE.map((d) => d.map((r) => r.replace(/-/g, '–'))),
  },
  chronological: {
    title: 'Chronological',
    about: 'The whole Bible in the order its events happened, in a year: Job with the patriarchs, the Psalms with David, the prophets beside their kings, and the letters where they fall in Acts.',
    calendar: false,
    schedule: () => splitChapters(chronologicalChapters(), 365),
  },
};

// ---------- reading days ----------
// Dates are 'YYYY-MM-DD'. A plan reads on the weekdays in `weekdays` (a mask: bit 0 Sunday … bit 6 Saturday; 127 = every
// day). Day 0 is the first reading day on or after `start_date`; `offset` days are skipped back after a "shift".

export const EVERY_DAY = 127;
const dayNum = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
const isoOf = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const weekday = (n) => (n + 4) % 7; // 1970-01-01 was a Thursday
const reads = (mask, n) => ((mask || EVERY_DAY) >> weekday(n)) & 1;

/** Reading days from `from` up to (not including) `to`. */
function readingDaysBetween(mask, from, to) {
  if (to <= from) return 0;
  const weeks = Math.floor((to - from) / 7);
  let count = weeks * [0, 1, 2, 3, 4, 5, 6].filter((d) => ((mask || EVERY_DAY) >> d) & 1).length;
  for (let n = from + weeks * 7; n < to; n++) count += reads(mask, n);
  return count;
}

/** The plan day a date falls on: { day, reading } (reading false on a day the plan skips; day is then the next one). */
export function dayOn(plan, iso) {
  const start = dayNum(plan.start_date);
  const n = dayNum(iso);
  const day = readingDaysBetween(plan.weekdays, start, n) - (plan.offset ?? 0);
  return { day, reading: n >= start && !!reads(plan.weekdays, n) };
}

/** The date a plan day falls on. */
export function dateOf(plan, day) {
  let n = dayNum(plan.start_date);
  let left = day + (plan.offset ?? 0);
  while (!reads(plan.weekdays, n)) n++;
  while (left > 0) {
    n++;
    if (reads(plan.weekdays, n)) left--;
  }
  return isoOf(n);
}

/** Reading days from a start date to an end date (inclusive), for "finish by". */
export function readingDaysUntil(start, end, mask = EVERY_DAY) {
  return readingDaysBetween(mask, dayNum(start), dayNum(end) + 1);
}

// ---------- CSV ----------

/** A CSV line's fields (quotes allowed). */
function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** The template for importing a plan: a day number, then its passages (more columns, or several separated by ";"). */
export const CSV_TEMPLATE = [
  'day,passage 1,passage 2,passage 3,passage 4',
  '1,Genesis 1-2,Matthew 1,Psalm 1,',
  '2,Genesis 3-4,Matthew 2,Psalm 2,',
  '3,Genesis 5-7,Matthew 3; Matthew 4,Psalm 3,',
  '4,Genesis 8-10,Matthew 5:1-26,Psalm 4,Proverbs 1',
].join('\r\n');

/**
 * Reads a plan from CSV: the first column is the day (1, 2, 3… in order; rows for the same day add to it), the rest
 * are passages. A first row with "day" in it is a header. Returns { schedule, errors: ['Row 4: …'] }.
 */
export function planFromCsv(text) {
  const rows = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const days = new Map();
  const errors = [];
  rows.forEach((line, i) => {
    if (!line.trim()) return;
    const f = csvFields(line);
    if (i === 0 && /day/i.test(f[0])) return;
    const day = Number(f[0]);
    if (!Number.isInteger(day) || day < 1 || day > 3000) { errors.push(`Row ${i + 1}: “${f[0]}” isn’t a day number`); return; }
    const passages = f.slice(1).flatMap((x) => x.split(';')).map((x) => x.trim()).filter(Boolean);
    for (const p of passages) {
      const r = parse(p);
      if (!r.refs.length || r.errors.length) { errors.push(`Row ${i + 1}: ${r.errors[0] ?? `“${p}” isn’t a Bible reference`}`); return; }
    }
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(...passages.map((p) => parse(p).refs.map((x) => x.label).join('; ')));
  });
  const last = Math.max(0, ...days.keys());
  const schedule = Array.from({ length: last }, (_, i) => days.get(i + 1) ?? []);
  if (!schedule.length && !errors.length) errors.push('No days found. The first column is the day number, the next ones the passages.');
  return { schedule, errors };
}

/** A schedule as CSV, in the template's shape. */
export function planToCsv(schedule) {
  const width = Math.max(1, ...schedule.map((d) => d.length));
  const q = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    ['day', ...Array.from({ length: width }, (_, i) => `passage ${i + 1}`)].join(','),
    ...schedule.map((d, i) => [String(i + 1), ...d.map(q), ...Array(width - d.length).fill('')].join(',')),
  ].join('\r\n');
}

/** Checks a schedule sent to the server: days of passages that parse. Returns an error message or ''. */
export function scheduleProblem(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return 'A plan needs at least one day.';
  if (schedule.length > 3000) return 'A plan can have at most 3000 days.';
  for (let i = 0; i < schedule.length; i++) {
    const d = schedule[i];
    if (!Array.isArray(d) || d.length > 12) return `Day ${i + 1} isn’t a list of passages (at most 12).`;
    for (const p of d) {
      if (typeof p !== 'string' || p.length > 200 || !parse(p).refs.length) return `Day ${i + 1}: “${String(p).slice(0, 40)}” isn’t a Bible reference.`;
    }
  }
  return '';
}
