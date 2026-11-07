/**
 * Background and word studies (8.5): their steps as the note lays them out (studyLayout.js), the parts their builders
 * write from what they keep, and the word study's fallacy check.
 */
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const BACKGROUND_STEPS = [
  { key: 'author', title: 'Book and Author', label: 'Book and Author', match: /author/i,
    parts: [['author', 'Author', /^author|^who/i], ['authorEvidence', 'Evidence', /evidence|why/i]] },
  { key: 'setting', title: 'Date and Setting', label: 'Date and Setting', match: /^date|setting/i,
    parts: [['date', 'Date', /^date|^when/i], ['place', 'Place and Events', /place|event|where/i]] },
  { key: 'audience', title: 'Audience and Occasion', label: 'Audience and Occasion', match: /audience|occasion/i,
    parts: [['audience', 'Audience', /audience|reader|recipient/i], ['occasion', 'Occasion', /occasion/i]] },
  { key: 'culture', title: 'Culture and History', label: 'Culture and History', match: /culture|histor/i,
    parts: [['culture', 'Customs, Politics and Religion', /custom|politic|religio|culture/i]] },
  { key: 'genre', title: 'Genre and Structure', label: 'Genre and Structure', match: /genre|structure|outline/i,
    parts: [['genre', 'Genre', /genre/i], ['outline', 'Outline', /outline|structure/i]] },
  { key: 'purpose', title: 'Purpose and Themes', label: 'Purpose and Themes', match: /purpose|theme/i,
    parts: [['purpose', 'Purpose', /purpose/i], ['themes', 'Themes and Key Words', /theme|word/i], ['keyVerses', 'Key Verses', /verse/i]] },
  { key: 'scholars', title: 'Scholars Compared', label: 'Scholars Compared', match: /scholar|views/i, generated: true,
    parts: [['scholarNotes', 'Notes', /^notes?$/i]] },
  { key: 'keeper', title: 'Keeper', label: 'Keeper', match: /^keeper/i, parts: [] },
];

export const WORD_STEPS = [
  { key: 'word', title: 'The Word', label: 'The Word', match: /^the\s+word$/i,
    parts: [['english', 'English Word', /english|^word/i], ['why', 'Why It Matters', /why|matter/i]] },
  { key: 'original', title: 'Original Language', label: 'Original Language', match: /original|hebrew|greek/i, generated: true,
    parts: [['originalNotes', 'Notes', /^notes?$/i]] },
  { key: 'translations', title: 'Translations', label: 'Translations', match: /translation/i, generated: true,
    parts: [['translationNotes', 'Notes', /^notes?$/i]] },
  { key: 'range', title: 'Range of Meaning', label: 'Range of Meaning', match: /range|meanings?$/i, generated: true,
    parts: [['rangeNotes', 'Notes', /^notes?$/i]] },
  { key: 'usage', title: 'Usage', label: 'Usage', match: /usage|uses|occurrence/i, generated: true,
    parts: [['usageNotes', 'Notes', /^notes?$/i]] },
  { key: 'context', title: 'In This Context', label: 'In This Context', match: /context/i,
    parts: [['context', 'Meaning Here', /meaning|here/i], ['reasons', 'Why This Sense', /why|reason/i]] },
  { key: 'keeper', title: 'Keeper', label: 'Keeper', match: /^keeper/i, parts: [] },
];

/** A background's facts in one line each (shown beside studies of the book, and on its passage pages). */
export const FACT_FIELDS = [['author', 'Author'], ['date', 'Date'], ['audience', 'Audience'], ['purpose', 'Purpose']];

// ---- background: scholars compared ----

/** The scholars' views as a table: question, view, who holds it, why. */
export function scholarsHtml(rows) {
  const list = (rows ?? []).filter((r) => [r.question, r.view, r.who, r.why].some((x) => String(x ?? '').trim()));
  if (!list.length) return '';
  const cell = (t) => `<td><p>${esc(String(t ?? '').trim())}</p></td>`;
  return `<table><tbody><tr><th><p>Question</p></th><th><p>View</p></th><th><p>Held By</p></th><th><p>Why</p></th></tr>${
    list.map((r) => `<tr>${cell(r.question)}${cell(r.view)}${cell(r.who)}${cell(r.why)}</tr>`).join('')}</tbody></table>`;
}
/** The table back from a note (when the study's own copy is missing): rows under the Scholars heading. */
export function readScholars(html) {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const head = [...body.querySelectorAll('h1')].find((h) => /scholar|views/i.test(h.textContent));
  if (!head) return [];
  let el = head.nextElementSibling;
  while (el && el.tagName !== 'H1' && el.tagName !== 'TABLE') el = el.nextElementSibling;
  if (el?.tagName !== 'TABLE') return [];
  return [...el.querySelectorAll('tr')].slice(1).map((tr) => {
    const [question, view, who, why] = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    return { question: question ?? '', view: view ?? '', who: who ?? '', why: why ?? '' };
  });
}

// ---- word studies ----

const POS = { N: 'noun', V: 'verb', A: 'adjective', ADV: 'adverb', PREP: 'preposition', CONJ: 'conjunction', PRT: 'particle', T: 'article', P: 'pronoun', R: 'pronoun', INJ: 'interjection' };
const GENDER = { M: 'masculine', F: 'feminine', N: 'neuter' };
/** "G:N-F" → "noun, feminine"; "H:V" → "verb". */
export function partOfSpeech(pos) {
  const [, rest = ''] = String(pos ?? '').split(':');
  const [p, g] = rest.split('-');
  const name = POS[p] ?? (p === 'N' ? 'noun' : '');
  if (!name) return '';
  return g && GENDER[g] && name === 'noun' ? `${name}, ${GENDER[g]}` : name;
}
export const strongsLabel = (w) => (w?.strongs ? `Strong’s ${w.strongs}` : '');
export const langLabel = (w) => (w?.lang === 'greek' ? 'Greek' : w?.lang === 'hebrew' ? 'Hebrew' : '');

/** The word's original: lemma, transliteration, number, part of speech, basic meaning and how often it's used. */
export function originalHtml(w, count) {
  if (!w?.lemma && !w?.translit) return '';
  const line = [w.lemma && `<strong>${esc(w.lemma)}</strong>`, w.translit && `(${esc(w.translit)})`].filter(Boolean).join(' ');
  const meta = [langLabel(w), strongsLabel(w), partOfSpeech(w.pos)].filter(Boolean).map(esc).join(' · ');
  return `<p>${line}${meta ? ` · ${meta}` : ''}</p>${w.gloss ? `<p>Basic meaning: ${esc(w.gloss)}</p>` : ''}`
    + (count ? `<p>Used ${count} time${count === 1 ? '' : 's'} in the ${w.lang === 'hebrew' ? 'Old' : 'New'} Testament.</p>` : '');
}
/** How each translation renders the word in its verse. */
export function renderingsHtml(renderings) {
  const list = Object.entries(renderings ?? {}).filter(([, v]) => String(v ?? '').trim());
  return list.length ? `<ul>${list.map(([t, v]) => `<li><p><strong>${esc(t)}</strong>: ${esc(v)}</p></li>`).join('')}</ul>` : '';
}
/** The senses the word can carry, numbered. */
export function sensesHtml(senses) {
  const list = (senses ?? []).filter((s) => String(s.label ?? '').trim());
  return list.length ? `<ol>${list.map((s) => `<li><p><strong>${esc(s.label.trim())}</strong>${String(s.note ?? '').trim() ? `: ${esc(s.note.trim())}` : ''}</p></li>`).join('')}</ol>` : '';
}
/** The uses you looked at, with the sense each carries, in Bible order. */
export function usesHtml(uses, senses, count) {
  const list = [...(uses ?? [])].sort((a, b) => a.key - b.key);
  if (!list.length) return '';
  const label = (i) => (Number.isInteger(i) && senses?.[i]?.label?.trim() ? senses[i].label.trim() : '');
  const head = count ? `<p>Looked at ${list.length} of its ${count} use${count === 1 ? '' : 's'}.</p>` : '';
  return `${head}<ul>${list.map((u) => `<li><p><strong>${esc(u.ref)}</strong>${label(u.sense) ? `: ${esc(label(u.sense))}` : ''}${u.note?.trim() ? ` (${esc(u.note.trim())})` : ''}</p></li>`).join('')}</ul>`;
}

/** Strips accents and breathing marks: "agapē" → "agape", "che.sed" → "chesed". */
export const plainWord = (s) => String(s ?? '').normalize('NFD').replace(/[̀-֑ͯ-ׇ]/g, '').replace(/[.'ʼʾʿ’-]/g, '').toLowerCase();

/**
 * The word study's fallacy check: rule-based flags from D. A. Carson's Exegetical Fallacies (and the use-count
 * check from Duvall and Hays). Each says what to look at again; none suggests wording. `text` is what you wrote about
 * the meaning (context, reasons, keeper, notes).
 */
export function fallacies({ word, senses = [], uses = [], count = 0, chosen = null, text = '' }) {
  const out = [];
  const t = String(text ?? '');
  if (!t.trim()) return out;
  if (/\b(root|roots|literally (means|meant)|comes? from|came from|derived from|derives from|etymolog\w*|originally meant|made up of|compound of)\b/i.test(t)) {
    out.push({
      key: 'root', title: 'Root fallacy',
      detail: 'You mention where the word comes from. A word means what its users meant by it in their day, not what its roots or parts once meant. Check that your reading rests on how it’s used.',
    });
  }
  const labels = senses.map((s) => String(s.label ?? '').trim().toLowerCase()).filter((l) => l.length >= 3);
  const named = labels.filter((l) => t.toLowerCase().includes(l));
  if (named.length >= 2 || /\b(all (of )?(these|its|the|those) (meanings|senses)|every (meaning|sense)|full range|all (three|four) (meanings|senses)|carries all|both senses at once)\b/i.test(t)) {
    out.push({
      key: 'totality', title: 'Reading in every meaning',
      detail: `Your notes ${named.length >= 2 ? `name ${named.length} of its senses` : 'reach for the whole range'}. In one verse a word usually carries one of its senses, not all of them at once (illegitimate totality transfer).`,
    });
  }
  const stem = plainWord(word?.translit).replace(/[^a-z]/g, '').slice(0, 5);
  if (stem.length >= 4) {
    // English spells Greek upsilon y and kappa c: dunamis → dynamite, ekklēsia → ecclesiastical.
    const stems = [...new Set([stem, stem.replace(/u/g, 'y'), stem.replace(/k/g, 'c'), stem.replace(/u/g, 'y').replace(/k/g, 'c')])];
    const later = [...t.matchAll(/[A-Za-z]+/g)].map((m) => m[0]).find((x) => {
      const p = x.toLowerCase();
      return stems.some((st) => p.startsWith(st)) && p !== plainWord(word.translit) && p.length > stem.length + 1;
    });
    if (later || /\b(where we get (our|the) (english )?word|our (english )?word .{0,20} comes from)\b/i.test(t)) {
      out.push({
        key: 'anachronism', title: 'A later meaning',
        detail: `${later ? `“${later}”` : 'An English word'} may come from it, but a word coined centuries later can’t tell us what it meant to the first readers (anachronism).`,
      });
    }
  }
  const need = Math.min(5, count || 5);
  if (count > 1 && uses.length < need) {
    out.push({
      key: 'uses', title: 'Few uses looked at',
      detail: `You’ve looked at ${uses.length} of its ${count} uses. Meaning comes from use: look at a few more, nearest first (the same book, then the same author).`,
    });
  }
  if (senses.filter((s) => s.label?.trim()).length >= 2 && chosen == null) {
    out.push({ key: 'choose', title: 'No sense chosen', detail: 'You listed more than one sense. Say which one fits this verse.' });
  }
  return out;
}

// ---- hover marks: where a studied word shows in your notes ----

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The terms that mark a word study in notes: its Hebrew or Greek word, its transliteration (with and without
 * accents), its Strong's number (G26 or G0026), and the English word when you asked for that. [{ re, study }]
 */
export function wordTerms(list) {
  const out = [];
  for (const s of list ?? []) {
    const terms = new Set();
    if (s.lemma) terms.add(s.lemma);
    if (s.translit && plainWord(s.translit).length >= 4) {
      terms.add(s.translit);
      terms.add(plainWord(s.translit));
    }
    if (s.strongs) {
      const m = /^([GH])(\d+)$/i.exec(s.strongs);
      if (m) { terms.add(`${m[1]}${m[2]}`); terms.add(`${m[1]}${m[2].padStart(4, '0')}`); }
    }
    if (s.mark && s.english?.trim().length >= 3) terms.add(s.english.trim());
    for (const term of terms) out.push({ term, study: s });
  }
  return out;
}
/** One expression for all of them, longest first, matched as whole words (case-insensitive for Latin letters). */
export function termsRegex(terms) {
  if (!terms.length) return null;
  const list = [...new Set(terms.map((t) => t.term))].sort((a, b) => b.length - a.length).map(reEsc);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
