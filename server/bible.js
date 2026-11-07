import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './secrets.js';
import { book, parse } from '../shared/scripture.js';
import { passage as esvPassage } from './esv.js';
import { ESV_COPYRIGHT, NLT_COPYRIGHT } from '../shared/bibleCopyright.js';

/**
 * Bible translations beside the ESV (server/esv.js), each with the user's own key, stored encrypted:
 *
 * - NLT, from Tyndale's NLT API (api.nlt.to). Non-commercial; 5,000 requests a day and 500 verses a request with a
 *   key (checked 2026-11). Text comes as HTML, read here into the ESV's plain form.
 * - Any Bible an API.Bible key (api.bible) may use, chosen in Settings. The free Starter plan allows 5,000 calls a
 *   month and up to 3 copyrighted Bibles plus the open ones; stored text must be refreshed within 30 days; each
 *   lookup is reported to its Fair Use Management System (FUMS); the app shows a link to api.bible.
 *
 * Every translation answers in the ESV's shape: { reference, text, verses } where text keeps verse numbers as [16],
 * paragraphs as blank lines and poetry lines indented, plus translation, credit { label, url } and copyright.
 * A translation id is 'ESV', 'NLT', or 'ab:<API.Bible id>'. The favorite (Settings) is used when none is given.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const TIMEOUT = 15_000;
const MAX_PASSAGE = 100; // verses per lookup, as for the ESV
const MAX_CACHED = 500; // verses kept per translation (the ESV's limit, used for the others too)
const REFRESH = 30 * 24 * 60 * 60 * 1000; // API.Bible: stored text no more than 30 days old
const MAX_CHOSEN = 10;
const NLT_API = 'https://api.nlt.to/api/passages';
const AB_API = 'https://rest.api.bible/v1';
const FUMS = 'https://fums.api.bible/f3';
export const LIMITS = { nlt: { day: 5000 }, apibible: { month: 5000 } };
const WARN_AT = 0.8;
// Tests only: with this set, the keys below give made-up text in each API's own format.
const TEST = process.env.NOTEAPP_BIBLE_TEST === '1';
export const TEST_KEYS = { nlt: 'nlttest-0000-0000-0000-000000000000', apibible: 'abtest00000000000000000000000000' };

export { NLT_COPYRIGHT };
const CREDITS = {
  ESV: { label: 'ESV', url: 'https://www.esv.org/' },
  NLT: { label: 'NLT', url: 'https://www.tyndale.com/nlt' },
};

db.exec(`CREATE TABLE IF NOT EXISTS bible_cache (
  tr TEXT NOT NULL,
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  verses INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (tr, ref)
);
CREATE TABLE IF NOT EXISTS bible_calls (provider TEXT NOT NULL, at INTEGER NOT NULL, stored INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS bible_calls_at ON bible_calls(provider, at);`);

// ---------- settings ----------

const readSetting = (key) => { try { return JSON.parse(getSetting(key) ?? 'null'); } catch { return null; } };
const nltConfig = () => readSetting('bible.nlt');
const abConfig = () => readSetting('bible.apibible');
const keyOf = (c) => { try { return c ? decrypt(c.secret) : null; } catch { return null; } };
const esvConnected = () => !!readSetting('esv');

/** The translations that can be read now, in menu order. */
export function translations() {
  const out = [];
  if (esvConnected()) out.push({ id: 'ESV', label: 'ESV', name: 'English Standard Version', provider: 'esv', credit: CREDITS.ESV, copyright: ESV_COPYRIGHT });
  if (nltConfig()) out.push({ id: 'NLT', label: 'NLT', name: 'New Living Translation', provider: 'nlt', credit: CREDITS.NLT, copyright: NLT_COPYRIGHT });
  for (const b of abConfig()?.chosen ?? []) {
    out.push({
      id: `ab:${b.id}`, label: b.abbr, name: b.name, provider: 'apibible', credit: { label: b.abbr, url: 'https://api.bible/' },
      copyright: abCopyright(b),
    });
  }
  return out;
}
/** An API.Bible Bible's notice, as its last passage gave it (each Bible has its own), or its name and API.Bible. */
function abCopyright(b) {
  const row = db.prepare('SELECT data FROM bible_cache WHERE tr = ? ORDER BY fetched_at DESC LIMIT 1').get(`ab:${b.id}`);
  try { if (row) return JSON.parse(row.data).copyright; } catch { /* fall through */ }
  return `${b.name}. Text from API.Bible (api.bible).`;
}
/** The favorite, or the first translation there is (null when none is connected). */
export function favorite() {
  const all = translations();
  const fav = readSetting('bible.favorite');
  return all.find((t) => t.id === fav)?.id ?? all[0]?.id ?? null;
}

// ---------- usage ----------

const DAY = 24 * 60 * 60 * 1000;
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
export function usage() {
  db.prepare('DELETE FROM bible_calls WHERE at < ?').run(Math.min(Date.now() - DAY, monthStart()) - DAY);
  const count = (provider, since, stored = 0) => db.prepare('SELECT COUNT(*) AS n FROM bible_calls WHERE provider = ? AND at >= ? AND stored = ?').get(provider, since, stored).n;
  const cached = (prefix) => db.prepare('SELECT COALESCE(SUM(verses), 0) AS n FROM bible_cache WHERE tr LIKE ?').get(prefix).n;
  return {
    nlt: { day: count('nlt', Date.now() - DAY), storedDay: count('nlt', Date.now() - DAY, 1), limits: LIMITS.nlt, cached: cached('NLT') },
    apibible: { month: count('apibible', monthStart()), storedMonth: count('apibible', monthStart(), 1), limits: LIMITS.apibible, cached: cached('ab:%') },
  };
}
function nearLimit(provider) {
  const u = usage()[provider];
  if (provider === 'nlt') return u.day >= LIMITS.nlt.day * WARN_AT ? 'day' : null;
  return u.month >= LIMITS.apibible.month * WARN_AT ? 'month' : null;
}
function spend(provider) {
  const u = usage()[provider];
  if (provider === 'nlt' && u.day >= LIMITS.nlt.day) throw httpError(429, `The NLT API allows ${LIMITS.nlt.day.toLocaleString('en-US')} lookups a day, and Selah has used them; passages already looked up still work.`);
  if (provider === 'apibible' && u.month >= LIMITS.apibible.month) throw httpError(429, `API.Bible allows ${LIMITS.apibible.month.toLocaleString('en-US')} lookups a month, and Selah has used them; passages already looked up still work.`);
  db.prepare('INSERT INTO bible_calls (provider, at) VALUES (?, ?)').run(provider, Date.now());
}

// ---------- reading each API's text into the ESV's form ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** Paragraphs of { level, text } lines (level 0 prose, 1–2 poetry) → "[1] …" text with blank lines and indents. */
function render(paras) {
  return paras
    .map((p) => p.lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text)
      .map((l) => `${' '.repeat(l.level * 2)}${l.text}`).join('\n'))
    .filter(Boolean).join('\n\n');
}
function builder() {
  const paras = [];
  return {
    paras,
    prose() { paras.push({ poetry: false, lines: [{ level: 0, text: '' }] }); },
    poetry(level) {
      const last = paras[paras.length - 1];
      if (last?.poetry) last.lines.push({ level, text: '' });
      else paras.push({ poetry: true, lines: [{ level, text: '' }] });
    },
    add(text) {
      if (!paras.length) this.prose();
      const lines = paras[paras.length - 1].lines;
      lines[lines.length - 1].text += text;
    },
  };
}

/** The NLT API's HTML (verse_export elements, p.body / p.poet1 / p.poet2, span.vn, footnotes in span.tn). */
export function nltText(html) {
  let h = String(html);
  const start = h.indexOf('id="bibletext"');
  if (start >= 0) h = h.slice(h.indexOf('>', start) + 1);
  h = h.replace(/<a class="a-tn">[\s\S]*?<\/a>/g, '')
    .replace(/<span class="(?:tn|cr)">(?:<span[^>]*>[\s\S]*?<\/span>|[\s\S])*?<\/span>/g, '')
    .replace(/<h\d\b[^>]*>[\s\S]*?<\/h\d>/g, '')
    .replace(/<span class="sc">([\s\S]*?)<\/span>/g, (m, t) => t.toUpperCase())
    .replace(/<\/body>[\s\S]*$/, '');
  const b = builder();
  const TOKENS = /<p\b([^>]*)>|<span class="vn">(\d+)<\/span>|<[^>]*>|[^<]+/g;
  let m;
  while ((m = TOKENS.exec(h))) {
    if (m[1] !== undefined) {
      const cls = /class="([^"]*)"/.exec(m[1])?.[1] ?? '';
      if (!cls) continue; // a stray <p> the API leaves where a paragraph goes on
      const poet = /^poet(\d)/.exec(cls);
      if (poet) b.poetry(Math.min(2, Number(poet[1]))); else b.prose();
    } else if (m[2]) {
      b.add(` [${m[2]}] `);
    } else if (m[0][0] !== '<') {
      b.add(decode(m[0]).replace(/\s+/g, ' '));
    }
  }
  return render(b.paras);
}

// USX paragraph styles: headings and the like are left out; q/q1/q2… are poetry.
const SKIP_PARA = /^(?:s\d?|ms\d?|mr|r|sr|sp|cl|cp|mt\d?|imt\d?|is\d?|ip|iot|io\d?|rem|h|toc\d?|b)$/;
const SKIP_CHAR = /^(?:f|fe|x|fr|ft|fq|fqa|xo|xt)$/;
/** API.Bible's JSON content (USX-like nodes: para, verse, char, note, text) for a passage. */
export function apiBibleText(content) {
  if (typeof content === 'string') {
    return content.split(/\n+/).map((l) => l.trim()).filter(Boolean).join('\n\n').replace(/\[(\d+)\]\s*/g, '[$1] ');
  }
  const b = builder();
  const inline = (nodes, upper = false) => {
    for (const n of nodes ?? []) {
      if (n.type === 'text') { b.add((upper ? n.text.toUpperCase() : n.text ?? '')); continue; }
      const style = n.attrs?.style ?? '';
      if (n.name === 'verse' || style === 'v') { b.add(` [${n.attrs?.number ?? ''}] `); continue; }
      if (n.name === 'note' || SKIP_CHAR.test(style)) continue;
      inline(n.items, upper || style === 'nd');
    }
  };
  const block = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.name !== 'para') { if (n.items) block(n.items); continue; }
      const style = n.attrs?.style ?? 'p';
      if (SKIP_PARA.test(style)) continue;
      const q = /^q(\d)?$/.exec(style);
      if (q) b.poetry(Math.min(2, Number(q[1] ?? 1))); else b.prose();
      inline(n.items);
    }
  };
  block(Array.isArray(content) ? content : [content]);
  return render(b.paras);
}

// ---------- references ----------

const USFM = ['GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH',
  'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM',
  'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH',
  '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV'];

/** "John 3:16-18" for the NLT API (one-chapter books keep their chapter: "Jude 1:3"). */
export function nltRef(r) {
  const info = book(r.book);
  const name = r.book === 19 ? 'Psalm' : info.name;
  if (r.v_start === 0) return r.ch_start === r.ch_end ? `${name} ${r.ch_start}` : `${name} ${r.ch_start}-${r.ch_end}`;
  if (r.ch_start === r.ch_end) return `${name} ${r.ch_start}:${r.v_start}${r.v_end !== r.v_start ? `-${r.v_end}` : ''}`;
  return `${name} ${r.ch_start}:${r.v_start}-${r.ch_end}:${r.v_end}`;
}
/** API.Bible passage ids: "JHN.3.16-JHN.3.18", or one per chapter ("PSA.23") for whole chapters. */
export function apiBibleIds(r) {
  const b = USFM[r.book - 1];
  if (r.v_start === 0) return Array.from({ length: r.ch_end - r.ch_start + 1 }, (_, i) => `${b}.${r.ch_start + i}`);
  const from = `${b}.${r.ch_start}.${r.v_start}`;
  const to = `${b}.${r.ch_end}.${r.v_end}`;
  return [from === to ? from : `${from}-${to}`];
}

// ---------- the APIs ----------

async function get(url, headers, what) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw httpError(502, `Couldn’t reach ${what} (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  if (res.status === 401 || res.status === 403) throw httpError(400, `${what} didn’t accept that key.`);
  if (res.status === 429) throw httpError(429, `${what}’s request limit was reached; try again later.`);
  if (res.status === 404) throw httpError(404, `${what} has no text for that passage.`);
  if (!res.ok) throw httpError(502, `${what} answered ${res.status}.`);
  return res;
}

async function nltFetch(refs, key) {
  spend('nlt');
  const q = refs.map(nltRef).join(';');
  if (TEST && key === TEST_KEYS.nlt) return fakeNlt(refs);
  const res = await get(`${NLT_API}?${new URLSearchParams({ ref: q, version: 'NLT', key })}`, {}, 'The NLT API');
  return res.text();
}

async function abFetch(path, key) {
  if (TEST && key === TEST_KEYS.apibible) return fakeApiBible(path);
  return (await get(`${AB_API}${path}`, { 'api-key': key, Accept: 'application/json' }, 'API.Bible')).json();
}
const PASSAGE_PARAMS = new URLSearchParams({
  'content-type': 'json', 'include-notes': 'false', 'include-titles': 'false', 'include-chapter-numbers': 'false',
  'include-verse-numbers': 'true', 'include-verse-spans': 'false',
}).toString();

// A device id for this Selah and a session id per day, for API.Bible's fair-use reports (no person is identified).
function fumsIds() {
  let device = getSetting('bible.fumsDevice');
  if (!device) { device = crypto.randomUUID(); setSetting('bible.fumsDevice', device); }
  const day = new Date().toISOString().slice(0, 10);
  return { dId: device, sId: crypto.createHash('sha256').update(`${device}:${day}`).digest('hex').slice(0, 32) };
}
function reportFums(tokens) {
  if (!tokens.length || TEST) return;
  const p = new URLSearchParams(fumsIds());
  for (const t of tokens) p.append('t', t);
  fetch(`${FUMS}?${p}`, { signal: AbortSignal.timeout(TIMEOUT) }).catch(() => {});
}

// ---------- lookups ----------

const countVerses = (text) => (text.match(/\[\d+\]/g) ?? []).length || 1;

function cached(tr, ref, maxAge) {
  const row = db.prepare('SELECT data, fetched_at FROM bible_cache WHERE tr = ? AND ref = ?').get(tr, ref);
  if (!row || (maxAge && Date.now() - row.fetched_at > maxAge)) return null;
  db.prepare('UPDATE bible_cache SET used_at = ? WHERE tr = ? AND ref = ?').run(Date.now(), tr, ref);
  return JSON.parse(row.data);
}
function store(tr, ref, data) {
  const now = Date.now();
  db.prepare(`INSERT INTO bible_cache (tr, ref, data, verses, used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tr, ref) DO UPDATE SET data = excluded.data, verses = excluded.verses, used_at = excluded.used_at, fetched_at = excluded.fetched_at`)
    .run(tr, ref, JSON.stringify(data), data.verses, now, now);
  for (;;) {
    const { total } = db.prepare('SELECT COALESCE(SUM(verses), 0) AS total FROM bible_cache WHERE tr = ?').get(tr);
    if (total <= MAX_CACHED) break;
    db.prepare('DELETE FROM bible_cache WHERE tr = ? AND ref = (SELECT ref FROM bible_cache WHERE tr = ? ORDER BY used_at LIMIT 1)').run(tr, tr);
  }
}

/**
 * A passage in a translation (the favorite when `tr` is empty): { reference, text, verses, translation, credit,
 * copyright, nearLimit? }.
 */
export async function passage(q, tr = '') {
  const all = translations();
  const id = tr || favorite();
  const t = all.find((x) => x.id === id);
  if (!t) {
    if (!all.length) throw httpError(409, 'No Bible is connected. Add a key in Settings → Connections → Bible.');
    throw httpError(409, `${tr.startsWith('ab:') ? 'That Bible' : tr} isn’t connected. Add it in Settings → Connections → Bible.`);
  }
  const extra = { translation: t.label, translationId: t.id, credit: t.credit };
  if (t.provider === 'esv') return { ...(await esvPassage(q)), ...extra, copyright: ESV_COPYRIGHT };

  const { refs, errors } = parse(q);
  if (!refs.length) throw httpError(400, errors[0] ?? 'Not a Bible reference.');
  const ref = refs.map((r) => r.label).join('; ');
  const provider = t.provider;
  const hit = cached(t.id, ref, provider === 'apibible' ? REFRESH : 0);
  if (hit) {
    db.prepare('INSERT INTO bible_calls (provider, at, stored) VALUES (?, ?, 1)').run(provider, Date.now());
    return { ...hit, ...extra };
  }
  let text;
  let copyright;
  if (provider === 'nlt') {
    text = nltText(await nltFetch(refs, keyOf(nltConfig())));
    copyright = NLT_COPYRIGHT;
  } else {
    const key = keyOf(abConfig());
    const bibleId = t.id.slice(3);
    const parts = [];
    const tokens = [];
    for (const pid of refs.flatMap(apiBibleIds).slice(0, 6)) {
      spend('apibible');
      const r = await abFetch(`/bibles/${encodeURIComponent(bibleId)}/passages/${encodeURIComponent(pid)}?${PASSAGE_PARAMS}`, key);
      parts.push(apiBibleText(r.data?.content ?? ''));
      copyright = r.data?.copyright || copyright;
      if (r.meta?.fumsToken) tokens.push(r.meta.fumsToken);
    }
    reportFums(tokens);
    text = parts.filter(Boolean).join('\n\n');
    copyright = `${(copyright ?? '').replace(/<[^>]+>/g, '').trim()}${copyright ? ' ' : ''}Text from API.Bible (api.bible).`;
  }
  if (!text.trim()) throw httpError(404, `The ${t.label} has no text for ${ref}.`);
  const verses = countVerses(text);
  if (verses > MAX_PASSAGE) throw httpError(400, `${ref} is ${verses} verses; look up at most ${MAX_PASSAGE} at a time.`);
  const data = { reference: ref, text, verses, copyright };
  store(t.id, ref, data);
  const near = nearLimit(provider);
  return { ...data, ...extra, ...(near ? { nearLimit: near, nearProvider: provider } : {}) };
}

/** The Bibles an API.Bible key may use: [{ id, abbr, name, language }], English first. */
async function apiBibleList(key) {
  const r = await abFetch('/bibles', key);
  return (r.data ?? []).map((b) => ({
    id: String(b.id), abbr: String(b.abbreviationLocal || b.abbreviation || b.id).slice(0, 20),
    name: String(b.nameLocal || b.name || b.id).slice(0, 200), language: String(b.language?.name ?? ''),
  })).sort((a, b) => (b.language === 'English') - (a.language === 'English') || a.name.localeCompare(b.name));
}

// ---------- test fakes (NOTEAPP_BIBLE_TEST=1) ----------

function fakeNlt(refs) {
  const sections = refs.map((r) => {
    const from = r.v_start || 1;
    const to = r.v_start === 0 ? 40 : r.ch_start === r.ch_end ? r.v_end : from + 2; // a whole chapter: 40 verses
    let body = `<h2 class="bk_ch_vs_header">${r.label}, NLT</h2>`;
    for (let v = from; v <= to; v += 1) {
      const poem = r.book === 19;
      body += `<verse_export orig="x_${v}" vn="${v}">\n${v === from ? '<h3 class="subhead">A Heading</h3>' : ''}`
        + (poem
          ? `<p class="poet1-vn"><span class="vn">${v}</span>NLT line of ${r.label} verse ${v}, the <span class="sc">Lord</span>;</p>\n<p class="poet2">its second line.</p>`
          : `${v === from ? '<p class="body">' : ''}<span class="vn">${v}</span>NLT text of ${r.label} verse ${v}.<a class="a-tn">*</a><span class="tn"><span class="tn-ref">${v}</span> A <em>footnote</em>.</span> `)
        + '</verse_export>';
    }
    return `<section>${body}</section>`;
  });
  return `<!DOCTYPE html><html><body><div id="bibletext" class="NLT">${sections.join('')}</div></body></html>`;
}
function fakeApiBible(path) {
  if (path === '/bibles') {
    return { data: [
      { id: 'de4e12af7f28f599-01', abbreviation: 'engKJV', abbreviationLocal: 'KJV', name: 'King James (Authorised) Version', nameLocal: 'King James Version', language: { name: 'English' } },
      { id: '9879dbb7cfe39e4d-01', abbreviation: 'WEB', abbreviationLocal: 'WEB', name: 'World English Bible', language: { name: 'English' } },
      { id: '592420522e16049f-01', abbreviation: 'RVR09', abbreviationLocal: 'RVR09', name: 'Reina Valera 1909', language: { name: 'Spanish' } },
    ] };
  }
  const m = /\/passages\/([^?]+)/.exec(path);
  const id = decodeURIComponent(m[1]);
  const [, bk, ch, v1, , v2] = /^(\w+)\.(\d+)(?:\.(\d+))?(?:-(\w+)\.\d+\.(\d+))?$/.exec(id) ?? [];
  if (!bk || bk === 'XXX') { const e = new Error('API.Bible has no text for that passage.'); e.statusCode = 404; throw e; }
  const from = Number(v1 || 1);
  const to = v1 ? Number(v2 || v1) : 40; // a whole chapter: 40 verses
  const poem = bk === 'PSA';
  const paras = [{ name: 'para', type: 'tag', attrs: { style: 's1' }, items: [{ text: 'A Heading', type: 'text' }] }];
  for (let v = from; v <= to; v += 1) {
    const verse = { name: 'verse', type: 'tag', attrs: { number: String(v), style: 'v', sid: `${bk} ${ch}:${v}` }, items: [{ text: String(v), type: 'text' }] };
    const words = [{ text: `AB text of ${bk} ${ch}:${v}, the `, type: 'text' }, { name: 'char', type: 'tag', attrs: { style: 'nd' }, items: [{ text: 'Lord', type: 'text' }] },
      { name: 'note', type: 'tag', attrs: { style: 'f' }, items: [{ text: 'a note', type: 'text' }] }, { text: '.', type: 'text' }];
    if (poem) {
      paras.push({ name: 'para', type: 'tag', attrs: { style: 'q1' }, items: [verse, ...words] });
      paras.push({ name: 'para', type: 'tag', attrs: { style: 'q2' }, items: [{ text: 'a second line', type: 'text' }] });
    } else if (v === from) paras.push({ name: 'para', type: 'tag', attrs: { style: 'p' }, items: [verse, ...words] });
    else paras[paras.length - 1].items.push(verse, ...words);
  }
  return { data: { id, content: paras, copyright: 'PUBLIC DOMAIN except in the United Kingdom' }, meta: { fumsToken: 'test-token' } };
}

// ---------- routes ----------

export default async function bibleRoutes(app) {
  app.get('/api/bible', async () => {
    const nlt = nltConfig();
    const ab = abConfig();
    return {
      favorite: favorite(),
      translations: translations(),
      providers: {
        esv: { connected: esvConnected() },
        nlt: { connected: !!nlt, connectedAt: nlt?.connectedAt ?? null, copyright: NLT_COPYRIGHT },
        apibible: { connected: !!ab, connectedAt: ab?.connectedAt ?? null, chosen: ab?.chosen ?? [] },
      },
    };
  });

  app.put('/api/bible/favorite', async (req) => {
    const id = String(req.body?.id ?? '');
    if (!translations().some((t) => t.id === id)) throw httpError(400, 'That translation isn’t connected');
    setSetting('bible.favorite', JSON.stringify(id));
    return { favorite: id };
  });

  // ?q=John 3:16&t=NLT (t empty: the favorite)
  app.get('/api/bible/passage', async (req) => passage(String(req.query.q ?? '').slice(0, 200), String(req.query.t ?? '').slice(0, 100)));
  app.get('/api/bible/usage', async () => usage());
  // ?t=NLT forgets that translation's stored passages (they're looked up again when next needed).
  app.delete('/api/bible/stored', async (req) => {
    const t = String(req.query.t ?? '');
    if (t === 'apibible') db.prepare("DELETE FROM bible_cache WHERE tr LIKE 'ab:%'").run();
    else db.prepare('DELETE FROM bible_cache WHERE tr = ?').run(t);
    return usage();
  });

  // ---- NLT: Body { apiKey }, checked with a one-verse lookup before it's saved ----
  app.put('/api/bible/nlt', async (req) => {
    const key = String(req.body?.apiKey ?? '').trim();
    if (!/^[\w-]{8,80}$/.test(key) || key.toUpperCase() === 'TEST') throw httpError(400, 'That doesn’t look like an NLT API key.');
    const text = nltText(await nltFetch(parse('John 11:35').refs, key));
    if (!/\[35\]/.test(text)) throw httpError(400, 'The NLT API didn’t answer with Bible text for that key.');
    setSetting('bible.nlt', JSON.stringify({ secret: encrypt(key), connectedAt: Date.now() }));
    return { connected: true };
  });
  app.delete('/api/bible/nlt', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'bible.nlt'").run();
    db.prepare("DELETE FROM bible_cache WHERE tr = 'NLT'").run();
    return { connected: false };
  });

  // ---- API.Bible: Body { apiKey }; replies with the Bibles the key may use, to choose from ----
  app.put('/api/bible/apibible', async (req) => {
    const key = String(req.body?.apiKey ?? '').trim();
    if (!/^[\w-]{16,80}$/.test(key)) throw httpError(400, 'That doesn’t look like an API.Bible key.');
    const bibles = await apiBibleList(key);
    const old = abConfig();
    setSetting('bible.apibible', JSON.stringify({ secret: encrypt(key), connectedAt: Date.now(), chosen: old?.chosen ?? [] }));
    return { connected: true, bibles };
  });
  app.get('/api/bible/apibible/bibles', async () => {
    const key = keyOf(abConfig());
    if (!key) throw httpError(409, 'API.Bible isn’t connected.');
    return apiBibleList(key);
  });
  // Body { bibles: [{ id, abbr, name }] }: the ones to show in Selah.
  app.put('/api/bible/apibible/chosen', async (req) => {
    const c = abConfig();
    if (!c) throw httpError(409, 'API.Bible isn’t connected.');
    const list = Array.isArray(req.body?.bibles) ? req.body.bibles : [];
    if (list.length > MAX_CHOSEN) throw httpError(400, `Pick at most ${MAX_CHOSEN}.`);
    const chosen = list.map((b) => ({ id: String(b.id ?? '').slice(0, 80), abbr: String(b.abbr ?? '').trim().slice(0, 20), name: String(b.name ?? '').slice(0, 200) }))
      .filter((b) => /^[\w-]+$/.test(b.id) && b.abbr);
    const gone = (c.chosen ?? []).filter((b) => !chosen.some((x) => x.id === b.id));
    for (const b of gone) db.prepare('DELETE FROM bible_cache WHERE tr = ?').run(`ab:${b.id}`);
    setSetting('bible.apibible', JSON.stringify({ ...c, chosen }));
    return { chosen };
  });
  app.delete('/api/bible/apibible', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'bible.apibible'").run();
    db.prepare("DELETE FROM bible_cache WHERE tr LIKE 'ab:%'").run();
    return { connected: false };
  });
}
