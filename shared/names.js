// People's names, for rosters (13.0): sorted by last name so a couple or family stays together, and shown as
// "Brenner, Walt". A name is stored the way it was typed.
const SUFFIX = /^(jr|sr|ii|iii|iv|esq|phd|md|dds)\.?$/i;

/** { first, last, suffix } from "Walt Brenner", "Walt Brenner Jr." or "Brenner, Walt". */
export function nameParts(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  const comma = text.match(/^([^,]+),\s*(.+)$/);
  if (comma && !SUFFIX.test(comma[2])) {
    const given = comma[2].split(' ');
    const suffix = given.length > 1 && SUFFIX.test(given.at(-1)) ? given.pop() : '';
    return { first: given.join(' '), last: comma[1].trim(), suffix };
  }
  const words = text.replace(/,/g, '').split(' ').filter(Boolean);
  const suffix = words.length > 2 && SUFFIX.test(words.at(-1)) ? words.pop() : '';
  const last = words.pop() ?? '';
  return { first: words.join(' '), last, suffix };
}

/** "Brenner, Walt Jr."; a single name stays as it is. */
export function lastFirst(name) {
  const { first, last, suffix } = nameParts(name);
  return first ? `${last}, ${first}${suffix ? ` ${suffix}` : ''}` : `${last}${suffix ? ` ${suffix}` : ''}`;
}

/** Array.sort comparator for two names: last name, then first, ignoring case and accents. */
export function compareNames(a, b) {
  const x = nameParts(a);
  const y = nameParts(b);
  const opts = { sensitivity: 'base', numeric: true };
  return x.last.localeCompare(y.last, undefined, opts) || x.first.localeCompare(y.first, undefined, opts);
}
