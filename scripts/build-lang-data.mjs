#!/usr/bin/env node
/**
 * Builds Selah's Greek and Hebrew data (server/lang/) from STEPBible-Data (https://github.com/STEPBible/STEPBible-Data,
 * CC BY 4.0, Tyndale House Cambridge / STEPBible.org): the brief lexicons (TBESG, TBESH) and the amalgamated tagged
 * texts (TAGNT, TAHOT). Run it again when STEPBible updates them:
 *
 *   node scripts/build-lang-data.mjs <folder with the downloaded .txt files>
 *
 * Writes lexicon.json.gz ({ code: [lemma, translit, pos, gloss, definition html] }) and words.json.gz
 * ([[verse key, [surface, translit, gloss, code, morph], …], …], English verse numbering, NA27/28 Greek and the
 * Leningrad codex with its Qere).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('Usage: node scripts/build-lang-data.mjs <folder with the STEPBible .txt files>');
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'lang');
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith('.txt'));
const read = (prefix) => files.filter((f) => f.startsWith(prefix)).map((f) => fs.readFileSync(path.join(src, f), 'utf8'));

// STEPBible's book codes in Selah's book order (shared/scripture.js).
const CODES = 'Gen Exo Lev Num Deu Jos Jdg Rut 1Sa 2Sa 1Ki 2Ki 1Ch 2Ch Ezr Neh Est Job Psa Pro Ecc Sng Isa Jer Lam Ezk Dan Hos Jol Amo Oba Jon Mic Nah Hab Zep Hag Zec Mal Mat Mrk Luk Jhn Act Rom 1Co 2Co Gal Eph Php Col 1Th 2Th 1Ti 2Ti Tit Phm Heb Jas 1Pe 2Pe 1Jn 2Jn 3Jn Jud Rev'.split(' ');
const ORDER = Object.fromEntries(CODES.map((c, i) => [c, i + 1]));
const sortKey = (b, ch, v) => b * 1_000_000 + ch * 1000 + v;

// ---- lexicon ----
// One Unicode form for Greek and Hebrew (STEPBible uses oxia, ά U+1F71, where keyboards type tonos, ά U+03AC).
const nfc = (t) => String(t ?? '').normalize('NFC');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The definition as a little safe HTML: bold, italics and line breaks kept, references as plain text, the rest escaped. */
function cleanDef(raw) {
  const text = raw
    .replace(/<ref=[^>]*>([\s\S]*?)<\/ref>/gi, '$1')
    .replace(/<\/?re>/gi, '')
    .replace(/<br\s*\/?>/gi, '\u0001')
    .replace(/<(\/?)b>/gi, '\u0002$1\u0003')
    .replace(/<(\/?)i>/gi, '\u0004$1\u0005')
    .replace(/<[^>]+>/g, '');
  return esc(text)
    .replace(/\u0001/g, '<br>')
    .replace(/\u0002(\/?)\u0003/g, '<$1b>')
    .replace(/\u0004(\/?)\u0005/g, '<$1i>')
    .replace(/__/g, '')
    .replace(/^(\s|<br>)+|(\s|<br>)+$/g, '')
    .trim();
}
const lexicon = {};
for (const text of [...read('TBESG'), ...read('TBESH')]) {
  for (const line of text.split(/\r?\n/)) {
    if (!/^[GH]\d/.test(line)) continue;
    const c = line.split('\t');
    const code = c[1]?.split(/\s/)[0];
    if (!code || lexicon[code]) continue;
    lexicon[code] = [nfc(c[3]), nfc(c[4]), c[5] ?? '', c[6] ?? '', nfc(cleanDef(c[7] ?? '')).slice(0, 6000)];
  }
}

// ---- tagged texts ----
const verses = new Map();
const add = (ref, word) => {
  const m = /^(\w{3})\.(\d+)\.(\d+)/.exec(ref);
  const b = m && ORDER[m[1]];
  if (!b) return;
  const key = sortKey(b, Number(m[2]), Number(m[3]));
  if (!verses.has(key)) verses.set(key, []);
  verses.get(key).push(word);
};
// STEPBible marks paragraphs with ¶ and splits Hebrew words into parts with / and \.
const tidy = (s) => (s ?? '').replace(/[/\\¶]/g, '').replace(/\s+/g, ' ').trim();
// Greek: words in the NA27/28 text (types with N).
for (const text of read('TAGNT')) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w{3}\.\d+\.\d+)#\d+=([A-Za-z]+)\t/.exec(line);
    if (!m || !m[2].includes('N')) continue;
    const c = line.split('\t');
    const surface = tidy((c[1] ?? '').replace(/\s*\(.*\)\s*$/, ''));
    const translit = /\(([^)]*)\)/.exec(c[1] ?? '')?.[1] ?? '';
    const [code, morph] = (c[3] ?? '').split('=');
    add(m[1], [nfc(surface), nfc(translit), tidy(c[2]), code ?? '', morph ?? '']);
  }
}
// Hebrew: the Leningrad codex (L…) and its Qere (Q).
for (const text of read('TAHOT')) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w{3}\.\d+\.\d+)(?:\([^)]*\))?#\d+=([A-Za-z]+)/.exec(line);
    if (!m || !/^[LQ]/.test(m[2])) continue;
    const c = line.split('\t');
    const code = /\{([HG]\d+[A-Za-z]?)\}/.exec(c[4] ?? '')?.[1] ?? (c[4] ?? '').split(/[/\\]/)[0];
    add(m[1], [nfc(tidy(c[1])), nfc(tidy(c[2])), tidy(c[3]), code ?? '', c[5] ?? '']);
  }
}

const gz = (name, data) => {
  const buf = zlib.gzipSync(JSON.stringify(data), { level: 9 });
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`${name}: ${(buf.length / 1e6).toFixed(1)} MB`);
};
gz('lexicon.json.gz', lexicon);
gz('words.json.gz', [...verses].sort((a, b) => a[0] - b[0]).map(([k, w]) => [k, ...w]));
console.log(`${Object.keys(lexicon).length} lexicon entries, ${verses.size} verses, ${[...verses.values()].reduce((n, w) => n + w.length, 0)} words`);
