import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { book, format, parse } from '../shared/scripture.js';

/**
 * Greek and Hebrew for word studies, from STEPBible-Data (Tyndale House Cambridge / STEPBible.org, CC BY 4.0), built
 * into server/lang/ by scripts/build-lang-data.mjs: the brief lexicons (Extended Strong's, with Abbott-Smith for
 * Greek and a BDB-based outline for Hebrew) and the tagged NA27/28 Greek New Testament and Leningrad Hebrew Old
 * Testament, word by word in English verse numbering. Read on first use and kept in memory.
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lang');
const load = (name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8'));

export const CREDIT = 'Greek and Hebrew from STEPBible.org (Tyndale House Cambridge), CC BY 4.0';

// Each verse's words are kept packed in one string and the index as typed arrays: a third of the memory of arrays of
// arrays. Let go after a quiet spell; the next lookup reads it again.
const FIELD = '\u0002';
const WORD = '\u0001';
const IDLE = 15 * 60_000;
let data = null;
let idle = null;
/** { lexicon, verses: Map(key → packed words), index: Map(code → Int32Array of keys) } */
function lang() {
  clearTimeout(idle);
  idle = setTimeout(() => { data = null; }, IDLE);
  idle.unref?.();
  if (data) return data;
  const lexicon = load('lexicon.json.gz');
  const verses = new Map();
  const lists = new Map();
  for (const [key, ...words] of load('words.json.gz')) {
    verses.set(key, words.map((w) => w.join(FIELD)).join(WORD));
    for (const w of words) {
      const code = w[3];
      if (!code) continue;
      const list = lists.get(code) ?? [];
      if (list[list.length - 1] !== key) list.push(key);
      lists.set(code, list);
    }
  }
  const index = new Map([...lists].map(([k, v]) => [k, Int32Array.from(v)]));
  data = { lexicon, verses, index };
  return data;
}
const wordsOf = (packed) => (packed ? packed.split(WORD).map((w) => w.split(FIELD)) : []);
export const available = () => fs.existsSync(path.join(dir, 'words.json.gz'));

/** "G26", "g0026", "H157" → the lexicon's form ("G0026", "H0157G"…); null when it isn't a Strong's number. */
export function normalizeCode(v) {
  const m = /^\s*([GH])\s*0*(\d{1,4})([A-Za-z]?)\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const base = `${m[1].toUpperCase()}${m[2].padStart(4, '0')}`;
  const { lexicon } = lang();
  if (m[3]) return lexicon[`${base}${m[3].toUpperCase()}`] ? `${base}${m[3].toUpperCase()}` : null;
  if (lexicon[base]) return base;
  // Hebrew (and some Greek) entries carry a letter: the first sense.
  return Object.keys(lexicon).find((k) => k.startsWith(base) && /^[GH]\d{4}[A-Z]$/.test(k)) ?? null;
}
const baseOf = (code) => code.slice(0, 5);
/** Every code that shares a Strong's number (a Hebrew word's senses, say). */
const family = (code) => Object.keys(lang().lexicon).filter((k) => baseOf(k) === baseOf(code));

function entry(code) {
  const e = lang().lexicon[code];
  if (!e) return null;
  const [lemma, translit, pos, gloss, def] = e;
  return { code, strongs: `${code[0]}${Number(code.slice(1, 5))}`, lang: code[0] === 'G' ? 'greek' : 'hebrew', lemma, translit, pos, gloss, def };
}

const label = (key) => {
  const b = Math.floor(key / 1_000_000);
  const ch = Math.floor((key % 1_000_000) / 1000);
  const v = key % 1000;
  return format({ book: b, ch_start: ch, v_start: v, ch_end: ch, v_end: v });
};

// Who wrote what, for grouping a word's uses (same author before the rest of the Bible). Traditional attributions.
const AUTHORS = [
  ['Moses', [1, 2, 3, 4, 5]], ['David and the Psalmists', [19]], ['Solomon', [20, 21, 22]], ['Jeremiah', [24, 25]],
  ['Samuel–Kings', [9, 10, 11, 12]], ['The Chronicler', [13, 14, 15, 16]],
  ['Luke', [42, 44]], ['John', [43, 62, 63, 64, 66]], ['Paul', [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57]], ['Peter', [60, 61]],
];
const authorOf = (b) => AUTHORS.find(([, books]) => books.includes(b)) ?? null;

/**
 * A verse's words: { ref, key, words: [{ surface, translit, gloss, code, morph, lemma, lex_translit, pos, lex_gloss }] }
 * for each verse in the reference (translit and gloss are the word as it stands in the verse; lex_ the dictionary form's).
 */
export function verseWords(ref) {
  const { refs, errors } = parse(String(ref ?? '').slice(0, 100));
  if (!refs.length || errors.length) throw httpError(400, 'Not a Bible reference');
  const r = refs[0];
  if (r.end - r.start > 3000) throw httpError(400, 'Choose a verse or a few verses');
  const { verses, lexicon } = lang();
  const out = [];
  for (const [key, packed] of verses) {
    if (key < r.start || key > r.end || key % 1000 === 0) continue;
    out.push({
      key, ref: label(key),
      words: wordsOf(packed).map(([surface, translit, gloss, code, morph]) => {
        const e = lexicon[code];
        return { surface, translit, gloss, code, morph, lemma: e?.[0] ?? '', lex_translit: e?.[1] ?? '', pos: e?.[2] ?? '', lex_gloss: e?.[3] ?? '' };
      }),
    });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * A word's entry and its uses: { entry, senses: [entries sharing its number], count, groups: [{ key, label, uses:
 * [{ key, ref, surface, gloss }] }] }. With `ref` (the verse studied) its uses group as the same book, the same
 * author, then the rest of its Testament (and the other one).
 */
export function wordUses(code, ref = '', { all = false } = {}) {
  const e = entry(code);
  if (!e) throw httpError(404, 'That word isn’t in the lexicon');
  const { verses, index } = lang();
  const codes = all ? family(code) : [code];
  const keys = [...new Set(codes.flatMap((c) => [...(index.get(c) ?? [])]))].sort((a, b) => a - b);
  const home = parse(String(ref ?? '')).refs[0] ?? null;
  const homeBook = home?.book ?? null;
  const author = homeBook ? authorOf(homeBook) : null;
  const groups = [
    { key: 'book', label: homeBook ? `In ${book(homeBook).name}` : null, uses: [] },
    { key: 'author', label: author ? `Elsewhere by ${author[0]}` : null, uses: [] },
    { key: 'rest', label: homeBook ? 'The rest of the Bible' : 'In the Bible', uses: [] },
  ];
  for (const key of keys) {
    const b = Math.floor(key / 1_000_000);
    const w = wordsOf(verses.get(key)).find((x) => codes.includes(x[3]));
    const use = { key, ref: label(key), surface: w?.[0] ?? '', gloss: w?.[2] ?? '' };
    if (homeBook && b === homeBook) groups[0].uses.push(use);
    else if (author && author[1].includes(b)) groups[1].uses.push(use);
    else groups[2].uses.push(use);
  }
  // How each use is rendered (the tagged text's English), most common first: a quick look at the word's range.
  const renderings = new Map();
  for (const g of groups) for (const u of g.uses) {
    const t = u.gloss.replace(/[[\]<>.,;:!?“”"'’]/g, '').trim().toLowerCase();
    if (t) renderings.set(t, (renderings.get(t) ?? 0) + 1);
  }
  return {
    entry: e,
    senses: family(code).filter((c) => c !== code).map(entry).filter(Boolean).map(({ def, ...x }) => x),
    count: keys.length,
    renderings: [...renderings].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([text, n]) => ({ text, n })),
    groups: groups.filter((g) => g.label && g.uses.length).map((g) => ({ ...g, total: g.uses.length, uses: g.uses.slice(0, 400) })),
    credit: CREDIT,
  };
}

/** Lexicon entries matching a Strong's number, a lemma, a transliteration or an English gloss (best first). */
export function searchLexicon(q, limit = 20) {
  const text = String(q ?? '').trim().slice(0, 60);
  if (!text) return [];
  const code = normalizeCode(text);
  if (code) return [entry(code)].map(({ def, ...x }) => x);
  const plain = (s) => String(s).normalize('NFD').replace(/[̀-֑ͯ-ׇ]/g, '').replace(/[.'ʼʾʿ-]/g, '').toLowerCase();
  const needle = plain(text);
  const { lexicon, index } = lang();
  const hits = [];
  for (const [k, [lemma, translit, , gloss]] of Object.entries(lexicon)) {
    if (/^[GH]9\d{3}/.test(k)) continue; // prefixes, suffixes and punctuation
    const l = plain(lemma);
    const t = plain(translit);
    const g = gloss.toLowerCase();
    let score = 0;
    if (l === needle || t === needle) score = 100;
    else if (l.startsWith(needle) || t.startsWith(needle)) score = 60;
    else if (needle.length >= 4 && t.includes(needle)) score = 50; // "hesed" finds che.sed
    else if (new RegExp(`(^|[^a-z])${needle.replace(/[^a-z ]/g, '')}([^a-z]|$)`).test(g) && needle.length > 1) score = 40;
    if (score) hits.push([score + Math.min(19, Math.log2((index.get(k)?.length ?? 0) + 1) * 2), k]);
  }
  return hits.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, k]) => {
    const { def, ...x } = entry(k);
    return { ...x, count: index.get(k)?.length ?? 0 };
  });
}

export default async function langRoutes(app) {
  const ready = () => { if (!available()) throw httpError(503, 'The Greek and Hebrew data isn’t installed'); };
  app.get('/api/lang/verse', async (req) => { ready(); return { verses: verseWords(req.query.ref), credit: CREDIT }; });
  app.get('/api/lang/search', async (req) => { ready(); return searchLexicon(req.query.q); });
  app.get('/api/lang/word/:code', async (req) => {
    ready();
    const code = normalizeCode(req.params.code);
    if (!code) throw httpError(404, 'That isn’t a Strong’s number');
    return wordUses(code, req.query.ref, { all: req.query.all === '1' });
  });
}
