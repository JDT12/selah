import { db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './secrets.js';
import { parse } from '../shared/scripture.js';
import { ESV_COPYRIGHT } from '../shared/bibleCopyright.js';

/**
 * ESV Bible text from Crossway's ESV API (api.esv.org), for verse previews on Bible references and for inserting
 * passages into notes. The API key is the user's own (free, non-commercial) and is stored encrypted; the browser
 * never sees it.
 *
 * Crossway's terms (checked 2026-10): at most 500 verses stored at a time, so the cache drops the least recently
 * used passages beyond that; 5,000 requests a day, 1,000 an hour, 60 a minute; always credit "ESV" and link to
 * esv.org; don't change the words.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const SETTING = 'esv';
const API = 'https://api.esv.org/v3/passage/text/';
const TIMEOUT = 15_000;
const MAX_CACHED = 500; // verses, Crossway's limit
const MAX_PASSAGE = 100; // verses per lookup here: enough for any preview or quotation in a note
const PER_MINUTE = 50; // ours, a little under Crossway's 60
// Crossway's limits on calls to the API (cached passages don't count). The meter in Settings → ESV shows them.
const LIMITS = { minute: 60, hour: 1000, day: 5000 };
const WARN_AT = 0.8; // passages fetched past 80% of the hourly or daily limit carry a warning
// Tests only: with this set, the key "esvtestkeyesvtestkeyesvtestkeyesvtestkey" gives made-up text.
const TEST = process.env.NOTEAPP_ESV_TEST === '1';
const TEST_KEY = 'esvtestkeyesvtestkeyesvtestkeyesvtestkey';

export const COPYRIGHT = ESV_COPYRIGHT;

db.exec(`CREATE TABLE IF NOT EXISTS esv_cache (
  ref TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  verses INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS esv_calls (at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS esv_calls_at ON esv_calls(at);`);
// stored = 1: a lookup answered from the verses kept here (free; shown on the meter, not counted against the limits).
if (!db.prepare('PRAGMA table_info(esv_calls)').all().some((c) => c.name === 'stored')) {
  db.exec('ALTER TABLE esv_calls ADD COLUMN stored INTEGER NOT NULL DEFAULT 0');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * Calls to the API in the last minute, hour and 24 hours, lookups answered from the stored verses in the last 24 hours,
 * and the verses kept here.
 */
export function usage() {
  const now = Date.now();
  db.prepare('DELETE FROM esv_calls WHERE at < ?').run(now - DAY);
  const count = (ms, stored = 0) => db.prepare('SELECT COUNT(*) AS n FROM esv_calls WHERE at >= ? AND stored = ?').get(now - ms, stored).n;
  const { cached } = db.prepare('SELECT COALESCE(SUM(verses), 0) AS cached FROM esv_cache').get();
  return {
    minute: count(MINUTE), hour: count(HOUR), day: count(DAY), storedDay: count(DAY, 1),
    limits: LIMITS, cached, maxCached: MAX_CACHED,
  };
}
/** 'hour' or 'day' once past 80% of that limit, else null. */
function nearLimit(u) {
  if (u.day >= LIMITS.day * WARN_AT) return 'day';
  if (u.hour >= LIMITS.hour * WARN_AT) return 'hour';
  return null;
}

function apiKey() {
  try {
    const c = JSON.parse(getSetting(SETTING) ?? 'null');
    return c ? decrypt(c.secret) : null;
  } catch {
    return null;
  }
}

let recent = [];
async function esv(q, key) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) throw httpError(429, 'Too many ESV lookups this minute; try again shortly.');
  const u = usage();
  if (u.day >= LIMITS.day) throw httpError(429, `The ESV allows ${LIMITS.day.toLocaleString('en-US')} lookups a day, and Selah has used them; passages already looked up still work.`);
  if (u.hour >= LIMITS.hour) throw httpError(429, `The ESV allows ${LIMITS.hour.toLocaleString('en-US')} lookups an hour, and Selah has used them; try again later.`);
  recent.push(now);
  db.prepare('INSERT INTO esv_calls (at) VALUES (?)').run(now);
  if (TEST && key === TEST_KEY) {
    const { refs } = parse(q);
    if (!refs.length) return { canonical: q, passages: [] };
    const r = refs[0];
    const from = r.v_start || 1;
    // A whole chapter has 40 made-up verses (Psalm 119: 176, to test lookups over 100).
    const whole = r.ch_start === r.ch_end && r.v_end === 999 ? (r.book === 19 && r.ch_start === 119 ? 176 : 40) : null;
    const to = r.ch_start === r.ch_end ? (whole ?? Math.min(r.v_end, r.book === 19 && r.ch_start === 119 ? 176 : 40)) : from + 2;
    const verses = Array.from({ length: to - from + 1 }, (_, i) => `[${from + i}] Test text of ${r.label} verse ${from + i}.`);
    return { canonical: r.label, passages: [`${verses.join(' ')}\n\n(ESV)`] };
  }
  const params = new URLSearchParams({
    q,
    'include-passage-references': 'false',
    'include-verse-numbers': 'true',
    'include-first-verse-numbers': 'true',
    'include-footnotes': 'false',
    'include-footnote-body': 'false',
    'include-headings': 'false',
    'include-short-copyright': 'false',
    'include-copyright': 'false',
    'include-selahs': 'true',
    'indent-poetry': 'true',
    'indent-poetry-lines': '2',
    'indent-paragraphs': '0',
  });
  let res;
  try {
    res = await fetch(`${API}?${params}`, { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw httpError(502, `Couldn’t reach the ESV API (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  if (res.status === 401 || res.status === 403) throw httpError(400, 'The ESV API didn’t accept that key.');
  if (res.status === 429) throw httpError(429, 'The ESV API’s request limit was reached; try again later.');
  if (!res.ok) throw httpError(502, `The ESV API answered ${res.status}.`);
  return res.json();
}

/** { reference, text, verses }: text keeps verse numbers as [16] and poetry lines/indents. */
export async function passage(q) {
  const key = apiKey();
  if (!key) throw httpError(409, 'The ESV isn’t connected. Add your API key in Settings → ESV Bible.');
  const { refs, errors } = parse(q);
  if (!refs.length) throw httpError(400, errors[0] ?? 'Not a Bible reference.');
  const ref = refs.map((r) => r.label).join('; ');
  const row = db.prepare('SELECT data FROM esv_cache WHERE ref = ?').get(ref);
  if (row) {
    db.prepare('UPDATE esv_cache SET used_at = ? WHERE ref = ?').run(Date.now(), ref);
    db.prepare('INSERT INTO esv_calls (at, stored) VALUES (?, 1)').run(Date.now());
    return JSON.parse(row.data);
  }
  const r = await esv(ref, key);
  const text = (r.passages ?? []).join('\n\n').replace(/\s*\(ESV\)\s*$/, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) throw httpError(404, `The ESV API has no text for ${ref}.`);
  const verses = (text.match(/\[\d+\]/g) ?? []).length || 1;
  if (verses > MAX_PASSAGE) throw httpError(400, `${r.canonical ?? ref} is ${verses} verses; look up at most ${MAX_PASSAGE} at a time.`);
  const data = { reference: r.canonical ?? ref, text, verses };
  db.prepare(`INSERT INTO esv_cache (ref, data, verses, used_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET data = excluded.data, verses = excluded.verses, used_at = excluded.used_at`)
    .run(ref, JSON.stringify(data), verses, Date.now());
  // Keep within Crossway's 500 stored verses: drop the least recently used.
  for (;;) {
    const { total } = db.prepare('SELECT COALESCE(SUM(verses), 0) AS total FROM esv_cache').get();
    if (total <= MAX_CACHED) break;
    db.prepare('DELETE FROM esv_cache WHERE ref = (SELECT ref FROM esv_cache ORDER BY used_at LIMIT 1)').run();
  }
  const near = nearLimit(usage());
  return near ? { ...data, nearLimit: near } : data;
}

export default async function esvRoutes(app) {
  app.get('/api/esv', async () => {
    const c = JSON.parse(getSetting(SETTING) ?? 'null');
    return { connected: !!c, connectedAt: c?.connectedAt ?? null, copyright: COPYRIGHT };
  });

  // Body: { apiKey }. Checked with a one-verse lookup before it's saved.
  app.put('/api/esv', async (req) => {
    const key = String(req.body?.apiKey ?? '').trim();
    if (!/^[A-Za-z0-9]{20,64}$/.test(key)) throw httpError(400, 'That doesn’t look like an ESV API key (40 letters and numbers).');
    await esv('John 11:35', key);
    setSetting(SETTING, JSON.stringify({ secret: encrypt(key), connectedAt: Date.now() }));
    return { connected: true };
  });

  app.delete('/api/esv', async () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING);
    db.prepare('DELETE FROM esv_cache').run();
    return { connected: false };
  });

  app.get('/api/esv/usage', async () => usage());

  // The passages kept here, most recently used first.
  app.get('/api/esv/stored', async () => db.prepare(
    'SELECT ref, verses, used_at AS usedAt FROM esv_cache ORDER BY used_at DESC').all());
  // ?ref=John 3:16 forgets one passage; no ref forgets them all. They're looked up again when next needed.
  app.delete('/api/esv/stored', async (req) => {
    const ref = req.query.ref;
    if (ref) db.prepare('DELETE FROM esv_cache WHERE ref = ?').run(String(ref));
    else db.prepare('DELETE FROM esv_cache').run();
    return usage();
  });

  // ?q=John 3:16-18
  app.get('/api/esv/passage', async (req) => passage(String(req.query.q ?? '').slice(0, 200)));
}
