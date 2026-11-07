/**
 * Bible references: the 66-book table, a parser for reference strings, and a scanner that finds references in
 * ordinary prose. Ported from the Scripture Blog WordPress plugin (SBT_Books, SBT_Parser) so notes and the blog
 * read references the same way. Used by the server (the Scripture index) and the browser (links in notes).
 */

// [order, name, chapters, testament, section, aliases]
const RAW = [
  [1, 'Genesis', 50, 'OT', 'Law', ['gen', 'ge', 'gn']],
  [2, 'Exodus', 40, 'OT', 'Law', ['ex', 'exo', 'exod']],
  [3, 'Leviticus', 27, 'OT', 'Law', ['lev', 'le', 'lv']],
  [4, 'Numbers', 36, 'OT', 'Law', ['num', 'nu', 'nm', 'nb']],
  [5, 'Deuteronomy', 34, 'OT', 'Law', ['deut', 'deu', 'dt']],
  [6, 'Joshua', 24, 'OT', 'History', ['josh', 'jos', 'jsh']],
  [7, 'Judges', 21, 'OT', 'History', ['judg', 'jdg', 'jg', 'jdgs']],
  [8, 'Ruth', 4, 'OT', 'History', ['rth', 'ru']],
  [9, '1 Samuel', 31, 'OT', 'History', ['1sam', '1sa', '1sm', '1s']],
  [10, '2 Samuel', 24, 'OT', 'History', ['2sam', '2sa', '2sm', '2s']],
  [11, '1 Kings', 22, 'OT', 'History', ['1kgs', '1ki', '1kin', '1k']],
  [12, '2 Kings', 25, 'OT', 'History', ['2kgs', '2ki', '2kin', '2k']],
  [13, '1 Chronicles', 29, 'OT', 'History', ['1chr', '1ch', '1chron']],
  [14, '2 Chronicles', 36, 'OT', 'History', ['2chr', '2ch', '2chron']],
  [15, 'Ezra', 10, 'OT', 'History', ['ezr', 'ez']],
  [16, 'Nehemiah', 13, 'OT', 'History', ['neh', 'ne']],
  [17, 'Esther', 10, 'OT', 'History', ['esth', 'est', 'es']],
  [18, 'Job', 42, 'OT', 'Poetry & Wisdom', ['jb']],
  [19, 'Psalms', 150, 'OT', 'Poetry & Wisdom', ['ps', 'psa', 'psalm', 'pss', 'psm']],
  [20, 'Proverbs', 31, 'OT', 'Poetry & Wisdom', ['prov', 'pro', 'prv', 'pr']],
  [21, 'Ecclesiastes', 12, 'OT', 'Poetry & Wisdom', ['eccl', 'ecc', 'eccles', 'qoh']],
  [22, 'Song of Solomon', 8, 'OT', 'Poetry & Wisdom', ['song', 'sos', 'songofsongs', 'song of songs', 'canticles', 'cant', 'ss']],
  [23, 'Isaiah', 66, 'OT', 'Major Prophets', ['isa', 'is']],
  [24, 'Jeremiah', 52, 'OT', 'Major Prophets', ['jer', 'je', 'jr']],
  [25, 'Lamentations', 5, 'OT', 'Major Prophets', ['lam', 'la']],
  [26, 'Ezekiel', 48, 'OT', 'Major Prophets', ['ezek', 'eze', 'ezk']],
  [27, 'Daniel', 12, 'OT', 'Major Prophets', ['dan', 'da', 'dn']],
  [28, 'Hosea', 14, 'OT', 'Minor Prophets', ['hos', 'ho']],
  [29, 'Joel', 3, 'OT', 'Minor Prophets', ['jl']],
  [30, 'Amos', 9, 'OT', 'Minor Prophets', ['am']],
  [31, 'Obadiah', 1, 'OT', 'Minor Prophets', ['obad', 'ob']],
  [32, 'Jonah', 4, 'OT', 'Minor Prophets', ['jon', 'jnh']],
  [33, 'Micah', 7, 'OT', 'Minor Prophets', ['mic', 'mc']],
  [34, 'Nahum', 3, 'OT', 'Minor Prophets', ['nah', 'na']],
  [35, 'Habakkuk', 3, 'OT', 'Minor Prophets', ['hab', 'hb']],
  [36, 'Zephaniah', 3, 'OT', 'Minor Prophets', ['zeph', 'zep', 'zp']],
  [37, 'Haggai', 2, 'OT', 'Minor Prophets', ['hag', 'hg']],
  [38, 'Zechariah', 14, 'OT', 'Minor Prophets', ['zech', 'zec', 'zc']],
  [39, 'Malachi', 4, 'OT', 'Minor Prophets', ['mal', 'ml']],
  [40, 'Matthew', 28, 'NT', 'Gospels', ['matt', 'mat', 'mt']],
  [41, 'Mark', 16, 'NT', 'Gospels', ['mrk', 'mk', 'mr']],
  [42, 'Luke', 24, 'NT', 'Gospels', ['luk', 'lk']],
  [43, 'John', 21, 'NT', 'Gospels', ['jhn', 'jn']],
  [44, 'Acts', 28, 'NT', 'History', ['act', 'ac']],
  [45, 'Romans', 16, 'NT', 'Pauline Epistles', ['rom', 'ro', 'rm']],
  [46, '1 Corinthians', 16, 'NT', 'Pauline Epistles', ['1cor', '1co']],
  [47, '2 Corinthians', 13, 'NT', 'Pauline Epistles', ['2cor', '2co']],
  [48, 'Galatians', 6, 'NT', 'Pauline Epistles', ['gal', 'ga']],
  [49, 'Ephesians', 6, 'NT', 'Pauline Epistles', ['eph', 'ephes']],
  [50, 'Philippians', 4, 'NT', 'Pauline Epistles', ['phil', 'php', 'pp']],
  [51, 'Colossians', 4, 'NT', 'Pauline Epistles', ['col', 'co']],
  [52, '1 Thessalonians', 5, 'NT', 'Pauline Epistles', ['1thess', '1th', '1thes']],
  [53, '2 Thessalonians', 3, 'NT', 'Pauline Epistles', ['2thess', '2th', '2thes']],
  [54, '1 Timothy', 6, 'NT', 'Pauline Epistles', ['1tim', '1ti', '1tm']],
  [55, '2 Timothy', 4, 'NT', 'Pauline Epistles', ['2tim', '2ti', '2tm']],
  [56, 'Titus', 3, 'NT', 'Pauline Epistles', ['tit', 'ti']],
  [57, 'Philemon', 1, 'NT', 'Pauline Epistles', ['philem', 'phlm', 'phm']],
  [58, 'Hebrews', 13, 'NT', 'General Epistles', ['heb']],
  [59, 'James', 5, 'NT', 'General Epistles', ['jas', 'jm']],
  [60, '1 Peter', 5, 'NT', 'General Epistles', ['1pet', '1pe', '1pt', '1p']],
  [61, '2 Peter', 3, 'NT', 'General Epistles', ['2pet', '2pe', '2pt', '2p']],
  [62, '1 John', 5, 'NT', 'General Epistles', ['1jn', '1jo', '1jhn', '1j']],
  [63, '2 John', 1, 'NT', 'General Epistles', ['2jn', '2jo', '2jhn', '2j']],
  [64, '3 John', 1, 'NT', 'General Epistles', ['3jn', '3jo', '3jhn', '3j']],
  [65, 'Jude', 1, 'NT', 'General Epistles', ['jud', 'jd']],
  [66, 'Revelation', 22, 'NT', 'Prophecy', ['rev', 're', 'rv', 'revelations', 'apocalypse']],
];

export const BOOKS = RAW.map(([order, name, chapters, testament, section, aliases]) => ({
  order, name, chapters, testament, section, abbr: aliases[0],
}));
export const book = (order) => BOOKS[order - 1] ?? null;

/** Lower case, no punctuation or spaces, leading ordinals (I, II, First, 1st…) as digits. */
export function normalize(name) {
  let n = String(name).toLowerCase().trim().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  n = n.replace(/^(iii|third|3rd)\s*/, '3 ').replace(/^(ii|second|2nd)\s+/, '2 ').replace(/^(i|first|1st)\s+/, '1 ');
  return n.replace(/ /g, '');
}

const ALIASES = new Map();
for (const [order, name, , , , aliases] of RAW) {
  ALIASES.set(normalize(name), order);
  for (const a of aliases) ALIASES.set(normalize(a), order);
}

/** Book order from a name or abbreviation ("Gen", "1 Cor", "I Samuel", "Song of Songs"); unique prefixes too. */
export function lookup(name, { prefixes = true } = {}) {
  const key = normalize(name);
  if (!key) return null;
  if (ALIASES.has(key)) return ALIASES.get(key);
  if (!prefixes || key.replace(/^\d/, '').length < 3) return null;
  const found = RAW.filter((r) => normalize(r[1]).startsWith(key));
  return found.length === 1 ? found[0][0] : null;
}

export const END = 999; // "to the end of the chapter"
export const sortKey = (b, ch, v) => b * 1_000_000 + ch * 1000 + v;

function make(b, cs, vs, ce, ve) {
  const ref = { book: b, ch_start: +cs, v_start: +vs, ch_end: +ce, v_end: +ve };
  ref.start = sortKey(b, ref.ch_start, ref.v_start);
  ref.end = sortKey(b, ref.ch_end, ref.v_end);
  ref.label = format(ref);
  return ref;
}

function validate(ref, info) {
  if (ref.ch_start < 1 || ref.ch_start > info.chapters || ref.ch_end > info.chapters) return `${info.name} only has ${info.chapters} chapters`;
  if (ref.ch_end < ref.ch_start || (ref.ch_end === ref.ch_start && ref.v_end < ref.v_start)) return `Range runs backwards: ${ref.label}`;
  if (ref.v_start > 200 || (ref.v_end > 200 && ref.v_end !== END)) return `Verse number looks wrong: ${ref.label}`;
  return '';
}

/**
 * Parses a reference string ("Rom 8:28-9:5; 12:1-2", "Gen 1-3", "Jude 3") into
 * { refs: [{ book, ch_start, v_start, ch_end, v_end, start, end, label }], errors: [] }. v_start 0 = whole chapter.
 */
export function parse(input, { prefixes = true } = {}) {
  const refs = [];
  const errors = [];
  let text = String(input).replace(/[‒–—−]/g, '-');
  text = text.replace(/(\d)\s*\.\s*(\d)/g, '$1:$2').replace(/\s+/g, ' ');
  let current = null;
  for (let segment of text.split(/[;\n]+/)) {
    segment = segment.replace(/^[\s,\t]+|[\s,\t]+$/g, '');
    if (!segment) continue;
    let rest;
    const m = /^((?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)?\s*[a-z][a-z .]*?)\s*(\d.*)?$/i.exec(segment);
    if (m && /[a-z]{2,}/i.test(m[1])) {
      const b = lookup(m[1], { prefixes });
      if (!b) { errors.push(`Unknown book: "${m[1].trim()}"`); current = null; continue; }
      current = b;
      rest = (m[2] ?? '').trim();
    } else {
      rest = segment;
    }
    if (!current) { errors.push(`No book given for "${segment}"`); continue; }
    const info = book(current);
    if (!rest) { refs.push(make(current, 1, 0, info.chapters, END)); continue; }
    const single = info.chapters === 1;
    let chapter = null;
    for (let part of rest.split(',')) {
      part = part.replace(/ /g, '');
      if (!part) continue;
      let ref = null;
      let p;
      if ((p = /^(\d+):(\d+)[a-c]?-(\d+):(\d+)[a-c]?$/.exec(part))) { ref = make(current, p[1], p[2], p[3], p[4]); chapter = +p[3]; }
      else if ((p = /^(\d+):(\d+)[a-c]?-(\d+)[a-c]?$/.exec(part))) { ref = make(current, p[1], p[2], p[1], p[3]); chapter = +p[1]; }
      else if ((p = /^(\d+):(\d+)[a-c]?(?:ff?)?$/.exec(part))) { ref = make(current, p[1], p[2], p[1], p[2]); chapter = +p[1]; }
      else if ((p = /^(\d+)[a-c]?-(\d+)[a-c]?$/.exec(part))) {
        if (chapter !== null) ref = make(current, chapter, p[1], chapter, p[2]);
        else if (single) ref = make(current, 1, p[1], 1, p[2]);
        else ref = make(current, p[1], 0, p[2], END);
      } else if ((p = /^(\d+)[a-c]?$/.exec(part))) {
        if (chapter !== null) ref = make(current, chapter, p[1], chapter, p[1]);
        else if (single) ref = make(current, 1, p[1], 1, p[1]);
        else ref = make(current, p[1], 0, p[1], END);
      }
      if (!ref) { errors.push(`Could not read "${part}"`); continue; }
      const problem = validate(ref, info);
      if (problem) { errors.push(problem); continue; }
      refs.push(ref);
    }
  }
  return { refs, errors };
}

/** "John 3:16–18", "Genesis 1–3", "Romans 8:28–9:5", "Psalm 23". */
export function format(ref, short = false) {
  const info = book(ref.book);
  if (!info) return '';
  let name = short ? info.abbr[0].toUpperCase() + info.abbr.slice(1) : info.name;
  if (ref.book === 19 && !short && ref.ch_start === ref.ch_end) name = 'Psalm';
  const { ch_start: cs, v_start: vs, ch_end: ce, v_end: ve } = ref;
  const d = '–';
  if (cs === 1 && vs === 0 && ce === info.chapters && ve === END) return name;
  if (vs === 0 && ve === END) return cs === ce ? `${name} ${cs}` : `${name} ${cs}${d}${ce}`;
  if (info.chapters === 1) return vs === ve ? `${name} ${vs}` : `${name} ${vs}${d}${ve}`;
  if (cs === ce) return vs === ve ? `${name} ${cs}:${vs}` : `${name} ${cs}:${vs}${d}${ve}`;
  return `${name} ${cs}:${vs}${d}${ce}:${ve}`;
}

// ---- finding references in prose ----
// Only spaces separate the parts of a reference: a line break ends it ("1 Peter" and "2 Peter" on two lines are
// two book names, not 1 Peter 2).
const SP = '[ \\u00a0]';
// A book: an optional ordinal, then a capitalised word (or "Song of Solomon/Songs"), optionally ending in ".".
const BOOK_RE = `(?:(?:[1-3]|I{1,3}|First|Second|Third|1st|2nd|3rd)${SP}?)?(?:Song${SP}+of${SP}+(?:Solomon|Songs)|[A-Z][a-z]+)\\.?`;
const NUM = '\\d{1,3}';
const CV = `${NUM}(?:[:.]${NUM}[a-c]?)?`;
const RANGE = `${CV}(?:${SP}?[-\\u2013\\u2014]${SP}?${CV})?(?:ff?\\b)?`;
// More parts after a comma or semicolon, unless the number starts the next book ("…; 1 Cor 13").
const MORE = `(?:${SP}?[,;]${SP}?${RANGE}(?!${SP}?[A-Z][a-z]))*`;
const SCAN = new RegExp(`(?<![\\w.])(${BOOK_RE})${SP}?(${RANGE}${MORE})`, 'g');

/**
 * Finds Bible references in text: [{ from, to, text, refs }] with character offsets. Cautious with prose: the book
 * must be capitalised and a full name or known abbreviation (no guessing from prefixes), and two-letter
 * abbreviations ("Is 5", "Am 3") count only with chapter and verse.
 */
export function findReferences(text) {
  const out = [];
  SCAN.lastIndex = 0;
  let m;
  while ((m = SCAN.exec(text))) {
    const [whole, bookText, nums] = m;
    // Not a reference: look again from the next character, so "Compare 1 Cor 13" still finds "1 Cor 13".
    const skip = () => { SCAN.lastIndex = m.index + 1; };
    const b = lookup(bookText, { prefixes: false });
    if (!b) { skip(); continue; }
    const letters = bookText.replace(/^(?:[1-3]|I{1,3}|First|Second|Third|1st|2nd|3rd)[ \u00a0]?/, '').replace(/\.$/, '');
    if (letters.length <= 2 && !/\d[:.]\d/.test(nums)) { skip(); continue; }
    const { refs } = parse(`${bookText} ${nums}`, { prefixes: false });
    if (!refs.length) { skip(); continue; }
    // Drop a trailing separator the pattern may have taken.
    const trimmed = whole.replace(/[\s,;]+$/, '');
    out.push({ from: m.index, to: m.index + trimmed.length, text: trimmed, refs });
  }
  return out;
}

// ---- Logos ----
const LOGOS_BOOK = {
  1: 'Ge', 2: 'Ex', 3: 'Le', 4: 'Nu', 5: 'Dt', 6: 'Jos', 7: 'Jdg', 8: 'Ru', 9: '1Sa', 10: '2Sa', 11: '1Ki', 12: '2Ki',
  13: '1Ch', 14: '2Ch', 15: 'Ezr', 16: 'Ne', 17: 'Es', 18: 'Job', 19: 'Ps', 20: 'Pr', 21: 'Ec', 22: 'So', 23: 'Is',
  24: 'Je', 25: 'La', 26: 'Eze', 27: 'Da', 28: 'Ho', 29: 'Joe', 30: 'Am', 31: 'Ob', 32: 'Jon', 33: 'Mic', 34: 'Na',
  35: 'Hab', 36: 'Zep', 37: 'Hag', 38: 'Zec', 39: 'Mal', 40: 'Mt', 41: 'Mk', 42: 'Lk', 43: 'Jn', 44: 'Ac', 45: 'Ro',
  46: '1Co', 47: '2Co', 48: 'Ga', 49: 'Eph', 50: 'Php', 51: 'Col', 52: '1Th', 53: '2Th', 54: '1Ti', 55: '2Ti', 56: 'Tt',
  57: 'Phm', 58: 'Heb', 59: 'Jas', 60: '1Pe', 61: '2Pe', 62: '1Jn', 63: '2Jn', 64: '3Jn', 65: 'Jud', 66: 'Re',
};

/** A ref.ly link that opens the passage in Logos (desktop, web or mobile), optionally in a given Bible version. */
export function logosUrl(ref, version = '') {
  const b = LOGOS_BOOK[ref.book];
  const info = book(ref.book);
  let loc;
  if (ref.v_start === 0) loc = ref.ch_start === ref.ch_end || ref.v_end !== END ? `${b}${ref.ch_start}` : `${b}${ref.ch_start}-${ref.ch_end}`;
  else if (info.chapters === 1) loc = `${b}${ref.v_start}${ref.v_end !== ref.v_start ? `-${ref.v_end}` : ''}`;
  else if (ref.ch_start === ref.ch_end) loc = `${b}${ref.ch_start}.${ref.v_start}${ref.v_end !== ref.v_start ? `-${ref.v_end}` : ''}`;
  else loc = `${b}${ref.ch_start}.${ref.v_start}-${ref.ch_end}.${ref.v_end}`;
  return `https://ref.ly/${loc}${version ? `;${encodeURIComponent(version.toLowerCase())}` : ''}`;
}

/**
 * Turns a link copied from Logos ("Copy location as → URL" gives https://ref.ly/logosres/…; older or desktop
 * forms are logosres:… and logos4:…) into a ref.ly link that opens in Logos desktop, web or mobile, with a short
 * readable label. Returns null if the text isn't a Logos link.
 */
export function logosLink(text) {
  const t = String(text).trim();
  let m = /^https?:\/\/ref\.ly\/((?:logosres|logos4)\/[^\s]+)$/i.exec(t);
  let path = m?.[1];
  if (!path && (m = /^(logosres|logos4):([^\s]+)$/i.exec(t))) path = `${m[1].toLowerCase()}/${m[2].replace(/;/, '?')}`;
  if (!path) return null;
  const url = `https://ref.ly/${path}`;
  const [, kind, rest = ''] = /^(logosres|logos4)\/(.*)$/i.exec(path) ?? [];
  const [resource, query = ''] = rest.split(/[?;]/, 2);
  let where = '';
  const ref = new URLSearchParams(query).get('ref');
  if (ref) {
    // "BibleESV.Jn3.16" -> "Jn 3:16"; "Page.p_529" -> "p. 529"; anything else as it comes.
    where = ref.replace(/^Bible[A-Z0-9]*\./i, '').replace(/^([1-3]?[A-Za-z]+)(\d+)\.(\d+)/, '$1 $2:$3')
      .replace(/^Page\.p_?/i, 'p. ').replace(/\+/g, ' ');
  }
  const name = kind.toLowerCase() === 'logos4' ? decodeURIComponent(resource || 'Logos') : resource;
  return { url, label: `Logos: ${name}${where ? `, ${where}` : ''}` };
}
