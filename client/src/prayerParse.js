// Quick-add for prayer requests: pulls a person, category, rhythm and Bible references out of the typed text, e.g.
// "Dad's job search @Dad #Family mon,thu" or "Missionaries in Peru #Missions rotate Col 4:3".
// Like tasks (taskParse.js), each piece becomes a chip that can be ignored to keep its text in the title.
import { findReferences } from '../../shared/scripture.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_RE = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayBit = (s) => 1 << DAYS.indexOf(s.toLowerCase().slice(0, 3));

const RULES = [
  ['schedule', '(?:every\\s+day|daily)', () => ({ schedule: 'daily' })],
  ['schedule', '(?:in\\s+)?rotat(?:e|ion)', () => ({ schedule: 'rotation' })],
  ['schedule', '(?:on\\s+)?weekdays', () => ({ schedule: 'weekly', weekdays: 0b0111110 })],
  ['schedule', '(?:on\\s+)?weekends', () => ({ schedule: 'weekly', weekdays: 0b1000001 })],
  ['schedule', `(?:(?:every|on)\\s+)?(?:${DAY_RE})s?(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*|\\s*\\/\\s*)(?:${DAY_RE})s?)*`, (m) => ({
    schedule: 'weekly',
    weekdays: m[0].toLowerCase().replace(/^(every|on)\s+/, '').split(/\s*,\s*|\s+and\s+|\s*&\s*|\s*\/\s*/).reduce((b, d) => b | dayBit(d), 0),
  })],
  ['category', "#([\\p{L}\\p{N}][\\p{L}\\p{N}_\\-&']*)", (m) => ({ category: m[1].replace(/[_-]+/g, ' ') })],
  ['person', "@([\\p{L}\\p{N}][\\p{L}\\p{N}_\\-.']*)", (m) => ({ person: m[1].replace(/_+/g, ' ') })],
];
const COMPILED = RULES.map(([kind, src, fn]) => [kind, new RegExp(`(?<=^|[\\s,(])(?:${src})(?=$|[\\s,.;:)!?])`, 'giu'), fn]);

/** "Mon, Thu", "Weekdays", "Every day". */
export function describeSchedule(schedule, weekdays) {
  if (schedule === 'daily') return 'Every day';
  if (schedule === 'rotation') return 'In rotation';
  if (weekdays === 0b0111110) return 'Weekdays';
  if (weekdays === 0b1000001) return 'Weekends';
  if (weekdays === 0b1111111) return 'Every day';
  return WEEKDAY_NAMES.filter((_, i) => (weekdays >> i) & 1).join(', ') || 'No days';
}

/**
 * parsePrayer('Mom’s surgery @Mom #Family mon,thu Ps 46:1', { categories })
 * -> { title, person, category, schedule, weekdays, refs, tokens: [{ key, kind, text, label, start }] }
 * A category matching a known one (ignoring case) takes its spelling. `ignore` holds token keys to leave in the title.
 */
export function parsePrayer(input, { categories = [], ignore = [] } = {}) {
  const text = input ?? '';
  const taken = [];
  const tokens = [];
  const out = { person: '', category: '', schedule: null, weekdays: 0, refs: '' };
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
  const seen = new Set();

  for (const [kind, re, fn] of COMPILED) {
    if (seen.has(kind)) continue;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const key = `${kind}:${m[0].toLowerCase().replace(/\s+/g, ' ')}`;
      if (overlaps(start, end) || ignore.includes(key)) continue;
      const r = fn(m);
      if (r.schedule) {
        out.schedule = r.schedule;
        out.weekdays = r.weekdays ?? 0;
      }
      if (r.category) {
        const known = categories.find((c) => c.toLowerCase() === r.category.toLowerCase());
        out.category = known ?? r.category;
      }
      if (r.person) out.person = r.person;
      const label = r.schedule ? describeSchedule(out.schedule, out.weekdays) : r.category ? out.category : out.person;
      taken.push([start, end]);
      tokens.push({ key, kind, text: m[0], label, start });
      seen.add(kind);
      break;
    }
  }

  // Bible references (all of them) go to the request's references.
  const refs = [];
  for (const f of findReferences(text)) {
    const key = `refs:${text.slice(f.from, f.to).toLowerCase()}`;
    if (overlaps(f.from, f.to) || ignore.includes(key)) continue;
    const label = f.refs.map((r) => r.label).join('; ');
    refs.push(label);
    taken.push([f.from, f.to]);
    tokens.push({ key, kind: 'refs', text: text.slice(f.from, f.to), label, start: f.from });
  }
  out.refs = refs.join('; ');

  let title = text;
  for (const [s, e] of [...taken].sort((a, b) => b[0] - a[0])) title = `${title.slice(0, s)} ${title.slice(e)}`;
  title = title.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();
  if (!title) title = text.trim();

  tokens.sort((a, b) => a.start - b.start);
  return { title, ...out, tokens };
}
