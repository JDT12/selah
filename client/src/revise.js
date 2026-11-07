/**
 * The Revise panel's checks (6.6): plain rules run in the browser, with no AI and nothing sent anywhere. They point
 * at places worth a second look and say why, and never suggest wording: the writing stays the writer's.
 *
 * Quotations ("…", “…”, block quotes) and citations are left out of every check and of the reading figures, so a
 * quoted passage of Scripture or a source never counts against you.
 *
 * Input: the note as blocks, { text, start, heading, section }, where text has one character per document position
 * from `start` (an inline node like a citation is U+FFFC). Output: issues { kind, from, to, text, why, key } in
 * document positions, the figures for Overview, and paragraphs ranked for Cut.
 */

export const KINDS = [
  { key: 'long', label: 'Long sentences', color: 'orange' },
  { key: 'passive', label: 'Passive voice', color: 'blue' },
  { key: 'adverb', label: 'Adverbs (-ly)', color: 'purple' },
  { key: 'filler', label: 'Filler words', color: 'pink' },
  { key: 'hedge', label: 'Hedges', color: 'teal' },
  { key: 'repeat', label: 'Repeated words', color: 'green' },
  { key: 'pet', label: 'Your words to watch', color: 'red' },
];
// A research paper's checks (Turabian), shown when the note is a paper.
export const PAPER_KINDS = [
  { key: 'uncited', label: 'Quotation with no footnote', color: 'red' },
  { key: 'claim', label: 'Source-like claim, no footnote', color: 'orange' },
  { key: 'blockquote', label: 'Long quotation in the text', color: 'blue' },
  { key: 'contraction', label: 'Contractions', color: 'purple' },
];

const WHY = {
  long: (n) => `${n} words in one sentence. Long sentences ask more of the reader; is this one doing more than one job?`,
  passive: () => 'Passive voice: the one doing the action isn’t the subject. Sometimes that’s what you want, sometimes it hides who acts.',
  adverb: () => 'An -ly word. Does it add something the verb or adjective doesn’t already say?',
  filler: () => 'A filler word or phrase. Would the sentence lose anything without it?',
  hedge: () => 'A hedge. Is the doubt intended, or could you stand behind the point?',
  repeat: (n) => `Used ${n} words ago too. Is the repeat on purpose?`,
  pet: () => 'One of your words to watch (Settings in this panel).',
  uncited: () => 'Turabian: a quotation needs a footnote saying where it comes from.',
  claim: () => 'This reads like a fact or finding from a source, and the paragraph has no footnote.',
  blockquote: (n) => `A quotation of about ${n} words. Turabian sets quotations of five or more lines as block quotations.`,
  contraction: () => 'Turabian: contractions are usually avoided in formal papers.',
};

const ADVERB_OK = new Set(['only', 'early', 'family', 'holy', 'reply', 'apply', 'supply', 'july', 'italy', 'ugly', 'belly', 'lily', 'rely', 'fly', 'ally', 'daily', 'likely', 'lovely', 'lonely', 'friendly', 'godly', 'ungodly', 'heavenly', 'worldly', 'costly', 'elderly', 'silly', 'jelly', 'bully', 'hilly', 'oily', 'curly', 'fully', 'assembly', 'anomaly', 'comply', 'multiply', 'imply', 'monopoly', 'rally', 'tally', 'folly', 'jolly', 'holly', 'kindly', 'orderly', 'timely', 'weekly', 'monthly', 'yearly', 'hourly', 'nightly', 'manly', 'womanly', 'brotherly', 'neighborly', 'unlikely', 'italy', 'emily', 'billy', 'molly', 'sally', 'kelly', 'beverly']);
const FILLER = ['very', 'really', 'just', 'actually', 'basically', 'quite', 'simply', 'literally', 'totally', 'truly', 'certainly', 'definitely', 'extremely', 'in order to', 'the fact that', 'a lot of', 'kind of', 'sort of', 'needless to say', 'at the end of the day', 'it is important to note that', 'in terms of'];
const HEDGE = ['perhaps', 'maybe', 'possibly', 'probably', 'seemingly', 'somewhat', 'arguably', 'apparently', 'i think', 'i believe', 'i feel', 'it seems', 'seems to', 'seem to', 'tend to', 'tends to', 'in a sense', 'to some extent', 'more or less'];
// A word already marked as filler or a hedge isn't marked again as an adverb.
const LISTED = new Set([...FILLER, ...HEDGE].filter((w) => !w.includes(' ')));
const BE = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', "isn't", "wasn't", "aren't", "weren't"]);
const IRREGULAR = new Set(['given', 'taken', 'written', 'spoken', 'chosen', 'known', 'shown', 'seen', 'done', 'made', 'said', 'told', 'found', 'held', 'kept', 'left', 'led', 'brought', 'bought', 'caught', 'taught', 'thought', 'sought', 'sent', 'spent', 'built', 'felt', 'heard', 'paid', 'laid', 'sold', 'meant', 'put', 'set', 'cut', 'hit', 'read', 'born', 'borne', 'torn', 'worn', 'sworn', 'broken', 'stolen', 'frozen', 'woven', 'forgiven', 'forgotten', 'gotten', 'hidden', 'ridden', 'driven', 'risen', 'beaten', 'eaten', 'fallen', 'drawn', 'grown', 'thrown', 'blown', 'flown', 'sown', 'sewn', 'slain', 'begun', 'sung', 'rung', 'drunk', 'sunk', 'struck', 'stuck', 'hung', 'won', 'spun', 'bound', 'ground', 'wound', 'fed', 'bred', 'fled', 'shed', 'spread', 'lost', 'shut', 'bent', 'lent', 'dealt', 'meant', 'crucified', 'baptized', 'called', 'saved', 'raised', 'filled', 'judged', 'justified', 'sanctified', 'glorified', 'redeemed', 'condemned']);
const NOT_PARTICIPLE = new Set(['need', 'indeed', 'seed', 'feed', 'speed', 'deed', 'bed', 'red', 'shed', 'hundred', 'sacred', 'naked', 'wicked', 'beloved', 'blessed', 'learned', 'aged', 'ragged', 'rugged', 'crooked', 'wretched', 'tired', 'interested', 'excited', 'married', 'used', 'supposed', 'concerned', 'involved', 'related', 'based', 'pleased', 'prepared', 'convinced', 'determined', 'devoted', 'committed', 'opposed', 'exposed']);
// "used to", "supposed to" etc. are common phrases, not passives worth a look.
const STOP = new Set('the a an and or but if then than that this these those there their they them he him his she her hers it its we us our you your i me my mine of to in on at by for with from as into onto over under about after before through during without within upon not no nor so too also is are was were be been being am do does did have has had will would shall should can could may might must what which who whom whose when where why how all any each every some such own same other more most much many few one two three just very only into out up down off again once here very like unto thee thou thy ye'.split(' '));
const ABBREV = /\b(?:mr|mrs|ms|dr|st|jr|sr|vs|cf|ch|chs|vv?|pp?|ed|eds|trans|vol|no|e\.g|i\.e|etc|ibid|ca|fig|gen|ex|lev|num|deut|matt|rom|cor|gal|eph|phil|col|thess|tim|heb|jas|pet|rev)\.$/i;

const OBJ = '\uFFFC';

/** Syllables in a word, by rule (good enough for a reading level). */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (s.match(/[aeiouy]{1,2}/g) ?? []).length);
}

/** The text with quotations and citations blanked out (same length, so offsets still line up). */
export function maskQuotes(text) {
  const out = [...text];
  const blank = (a, b) => { for (let i = a; i < b; i += 1) out[i] = ' '; };
  for (let i = 0; i < out.length; i += 1) if (out[i] === OBJ) out[i] = ' ';
  // Curly quotes pair up; straight double quotes pair in order.
  for (const [open, close] of [['“', '”'], ['"', '"']]) {
    let at = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === open && at < 0) at = i;
      else if (text[i] === close && at >= 0) { blank(at, i + 1); at = -1; }
    }
    // An open quote with no close runs to the end of the paragraph.
    if (at >= 0) blank(at, text.length);
  }
  return out.join('');
}

/** Quotations in a paragraph: [{ from, to, words }] as offsets. */
function quotations(text) {
  const out = [];
  for (const [open, close] of [['“', '”'], ['"', '"']]) {
    let at = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === open && at < 0) at = i;
      else if (text[i] === close && at >= 0) {
        out.push({ from: at, to: i + 1, words: (text.slice(at, i).match(/[\p{L}\p{N}]+/gu) ?? []).length });
        at = -1;
      }
    }
  }
  return out;
}

/** Words with their offsets. */
function words(text) {
  const out = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ w: m[0], lw: m[0].toLowerCase().replace(/’/g, "'"), from: m.index, to: m.index + m[0].length });
  return out;
}

/** Sentences as offset ranges (a period after a common abbreviation doesn't end one). */
function sentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]+["”’)]*(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(start, m.index - 8), m.index + 1);
    if (m[0] === '.' && ABBREV.test(before)) continue;
    out.push({ from: start, to: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (text.slice(start).trim()) out.push({ from: start, to: text.length });
  return out.map((s) => {
    // Trim the spaces at either end.
    let { from, to } = s;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    return { from, to };
  }).filter((s) => s.to > s.from);
}

/** Every place a phrase from the list appears (whole words, any case). */
function phrases(lower, list) {
  const out = [];
  for (const p of list) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}'’])`, 'giu');
    for (let m = re.exec(lower); m; m = re.exec(lower)) out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/**
 * The checks over the note. options: { longLimit = 30, pet = [], paper = false, repeatWindow = 50 }. Headings are
 * left out of the checks and the figures (they're labels, not prose).
 */
export function analyze(blocks, { longLimit = 30, pet = [], paper = false, repeatWindow = 50 } = {}) {
  const issues = [];
  const add = (kind, block, from, to, arg, sentence) => {
    const text = block.text.slice(from, to);
    // A dismissal is kept against the words and the sentence they're in, so it survives edits elsewhere.
    const key = `${kind}:${text.toLowerCase()}:${sentence.slice(0, 60).toLowerCase()}`;
    issues.push({ kind, from: block.start + from, to: block.start + to, text, why: WHY[kind](arg), key });
  };
  const total = { words: 0, sentences: 0, syllables: 0, allWords: 0 };
  const paras = [];
  // Recent content words across paragraphs, for repeats: word → its index in the running word count.
  const recent = new Map();
  let wordIndex = 0;
  for (const block of blocks) {
    const allWords = words(block.text.replace(new RegExp(OBJ, 'g'), ' ')).length;
    total.allWords += allWords;
    if (block.heading) continue;
    const text = maskQuotes(block.text);
    const lower = text.toLowerCase();
    const ws = words(text);
    if (!ws.length && !paper) continue;
    const ss = sentences(text);
    const para = { start: block.start, end: block.start + block.text.length, words: ws.length, weight: 0, snippet: block.text.replace(new RegExp(OBJ, 'g'), '').slice(0, 120), section: block.section };
    const sentenceOf = (at) => { const s = ss.find((x) => at >= x.from && at < x.to); return s ? text.slice(s.from, s.to) : ''; };
    for (const s of ss) {
      const sw = ws.filter((w) => w.from >= s.from && w.to <= s.to);
      if (!sw.length) continue;
      total.sentences += 1;
      if (sw.length > longLimit) { add('long', block, s.from, s.to, sw.length, text.slice(s.from, s.to)); para.weight += 2; }
    }
    for (const w of ws) total.syllables += syllables(w.w);
    total.words += ws.length;
    // Passive: a form of "be", maybe one -ly word, then a past participle.
    for (let i = 0; i < ws.length - 1; i += 1) {
      if (!BE.has(ws[i].lw)) continue;
      let j = i + 1;
      if (/ly$/.test(ws[j].lw) && ws[j + 1]) j += 1;
      const p = ws[j].lw;
      const participle = IRREGULAR.has(p) || (/[a-z]{2,}ed$/.test(p) && !NOT_PARTICIPLE.has(p));
      // Only within one sentence ("used to" and "supposed to" aren't participles here: see NOT_PARTICIPLE).
      if (participle && !/[.!?]/.test(text.slice(ws[i].to, ws[j].from))) {
        add('passive', block, ws[i].from, ws[j].to, null, sentenceOf(ws[i].from));
        para.weight += 1;
      }
    }
    for (const w of ws) {
      if (/^[a-z]{3,}ly$/.test(w.lw) && !ADVERB_OK.has(w.lw) && !LISTED.has(w.lw)) { add('adverb', block, w.from, w.to, null, sentenceOf(w.from)); para.weight += 1; }
    }
    for (const r of phrases(lower, FILLER)) { add('filler', block, r.from, r.to, null, sentenceOf(r.from)); para.weight += 1.5; }
    for (const r of phrases(lower, HEDGE)) { add('hedge', block, r.from, r.to, null, sentenceOf(r.from)); para.weight += 1; }
    if (pet.length) for (const r of phrases(lower, pet.map((p) => p.toLowerCase()))) add('pet', block, r.from, r.to, null, sentenceOf(r.from));
    // Repeats: a content word used again within `repeatWindow` words. Names (capitalized mid-sentence) are skipped.
    const starts = new Set(ss.map((s) => s.from));
    for (const w of ws) {
      wordIndex += 1;
      if (w.lw.length < 4 || STOP.has(w.lw) || /^\d/.test(w.lw)) continue;
      if (/^\p{Lu}/u.test(w.w) && !starts.has(w.from)) continue;
      const stem = w.lw.replace(/(?:'s|s)$/, '');
      const last = recent.get(stem);
      if (last != null && wordIndex - last <= repeatWindow) { add('repeat', block, w.from, w.to, wordIndex - last, sentenceOf(w.from)); para.weight += 1; }
      recent.set(stem, wordIndex);
    }
    if (paper) {
      const hasCite = block.text.includes(OBJ);
      for (const q of quotations(block.text)) {
        if (!hasCite) add('uncited', block, q.from, q.to, null, block.text);
        if (q.words >= 60) add('blockquote', block, q.from, q.to, q.words, block.text);
      }
      if (!hasCite) {
        const claim = /\b(?:studies|research|scholars|surveys?|data|statistics)\s+(?:show|shows|suggest|suggests|found|indicate|indicates)\b|\baccording to\b|\b\d+(?:\.\d+)?\s?(?:%|percent)\b/i.exec(text);
        if (claim) add('claim', block, claim.index, claim.index + claim[0].length, null, sentenceOf(claim.index));
      }
      for (const w of ws) if (/^[a-z]+(?:n't|'re|'ve|'ll|'d|'m)$/i.test(w.lw) || /^(?:it|that|there|what|who|he|she|let)'s$/i.test(w.lw)) add('contraction', block, w.from, w.to, null, sentenceOf(w.from));
    }
    if (ws.length) paras.push({ ...para, weight: para.weight / Math.max(1, ws.length) * 100 });
  }
  const avg = total.sentences ? total.words / total.sentences : 0;
  const grade = total.words && total.sentences ? Math.max(0, 0.39 * avg + 11.8 * (total.syllables / total.words) - 15.59) : 0;
  return {
    issues,
    stats: {
      words: total.allWords, prose: total.words, sentences: total.sentences, avgSentence: avg, grade,
      minutes: total.allWords / 238,
    },
    // Paragraphs with the most marked per hundred words come first (a short one with one filler word doesn't top it).
    paragraphs: paras.filter((p) => p.words >= 12).sort((a, b) => b.weight - a.weight),
  };
}

/** The note as blocks for analyze(): each paragraph or heading, leaving out block quotes and code. */
export function docBlocks(doc) {
  const out = [];
  let section = null;
  doc.descendants((node, pos) => {
    const t = node.type.name;
    if (t === 'blockquote' || t === 'codeBlock') return false;
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, OBJ);
    if (t === 'heading') section = text.trim();
    out.push({ text, start: pos + 1, heading: t === 'heading', section });
    return false;
  });
  return out;
}

/** Sentences to read aloud from `fromPos` on, quotations included: [{ from, to, text }] in document positions. */
export function readingSentences(blocks, fromPos = 0) {
  const out = [];
  for (const b of blocks) {
    if (b.start + b.text.length < fromPos) continue;
    for (const s of sentences(b.text)) {
      const from = b.start + s.from;
      const to = b.start + s.to;
      if (to <= fromPos) continue;
      const text = b.text.slice(s.from, s.to).replace(new RegExp(OBJ, 'g'), '').trim();
      if (text) out.push({ from, to, text });
    }
  }
  return out;
}

/** A Flesch–Kincaid grade in words. */
export function gradeLabel(g) {
  if (!g) return '—';
  const n = Math.round(g);
  const plain = n <= 6 ? 'easy for nearly everyone' : n <= 9 ? 'easy for most adults' : n <= 12 ? 'fine for most adults' : n <= 16 ? 'college level' : 'graduate level';
  return `Grade ${n} · ${plain}`;
}
