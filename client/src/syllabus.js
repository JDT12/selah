/**
 * Reading a class's details out of its syllabus PDF's text (11.0): the course code, professor, email, term, office
 * hours, course site and the term's first and last days. Best guesses only: Learn shows what it found and you pick
 * what to keep. Returns { code, professor, contact, term, officeHours, link, start_date, target_date } (found ones).
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const two = (n) => String(n).padStart(2, '0');

/** "August 24, 2026" (or "Aug 24 2026", "8/24/2026", "2026-08-24") → "2026-08-24"; year from `year` when missing. */
export function isoDate(text, year = null) {
  const t = String(text).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${two(m[2])}-${two(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${two(m[1])}-${two(m[2])}`;
  m = new RegExp(`^${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?$`, 'i').exec(t);
  if (m && (m[3] || year)) return `${m[3] ?? year}-${two(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1)}-${two(m[2])}`;
  return null;
}

const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s,;:–—-]+$/g, '').trim();
/** The value after a label on its line ("Instructor: Dr. Ruth Calder"), or on the next line when the label stands alone. */
function labelled(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const rest = clean(lines[i].slice(m.index + m[0].length));
    if (rest) return rest;
    const next = clean(lines[i + 1] ?? '');
    if (next) return next;
  }
  return null;
}

export function parseSyllabus(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');
  const out = {};

  // Course code: "OBST 680", "NBST 652", "THEO-525" (not page or ISBN numbers).
  const code = /\b(?!ISBN|PAGE|ROOM|SUITE|BOX|EXT|HWY|ROUTE|PHONE)([A-Z]{2,5})[ -]?(\d{3,4}[A-Z]?)\b/.exec(all);
  if (code) out.code = `${code[1]} ${code[2]}`;

  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(all);
  if (email) out.contact = email[0].replace(/\.$/, '');

  let prof = labelled(lines, /^(?:course\s+)?(?:professor|instructor|faculty(?:\s+member)?|lecturer|teacher)(?:'s)?(?:\s+name)?\s*[:–—-]?\s*/i);
  if (prof) prof = prof.replace(/\s*(?:e-?mail|phone|office)\b.*$/i, '').replace(/[\w.+-]+@\S+/, '').trim();
  if (!prof) {
    const m = /\b(?:Dr\.|Prof\.|Professor)\s+[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3}/.exec(all);
    if (m) prof = m[0];
  }
  if (prof && prof.length <= 80 && /[A-Za-z]/.test(prof)) out.professor = clean(prof);

  const term = /\b(Fall|Spring|Summer|Winter|Autumn|J-?Term|May\s?Term)\s+(?:Term\s+|Semester\s+|Session\s+)?(20\d{2})(?:\s*(?:[-–—]\s*)?(?:Sub-?term|Session|Term)?\s*([A-D8]|\d{1,2}[- ]?(?:Week|Wk)s?)\b)?/i.exec(all);
  if (term) out.term = clean(`${term[1][0].toUpperCase()}${term[1].slice(1).toLowerCase()} ${term[2]}${term[3] ? ` ${term[3].toUpperCase()}` : ''}`);
  else {
    const t = labelled(lines, /^(?:term|semester|session)\s*[:–—-]\s*/i);
    if (t && t.length <= 40) out.term = t;
  }

  const hours = labelled(lines, /^office\s+hours?\s*[:–—-]?\s*/i);
  if (hours && hours.length <= 120) out.officeHours = hours;

  const link = /\bhttps?:\/\/[^\s<>"')]+/.exec(all);
  if (link) out.link = link[0].replace(/[.,;]+$/, '');

  // The term's dates: "August 24, 2026 – October 16, 2026", "Aug 24 – Oct 16, 2026", "8/24/2026 - 10/16/2026".
  const d = `(?:${MONTH.replace("(Jan", "(?:Jan")}\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`;
  const range = new RegExp(`(${d})\\s*(?:[-–—]|to|through|thru)\\s*(${d})`, 'i').exec(all);
  if (range) {
    const year = /(\d{4})/.exec(range[2])?.[1] ?? /(\d{4})/.exec(range[1])?.[1] ?? null;
    const a = isoDate(range[1], year);
    const b = isoDate(range[2], year);
    if (a && b && a < b) {
      // "Dec 1 – Jan 20, 2027": the start is the year before.
      out.start_date = a;
      out.target_date = b;
    } else if (a && b && a > b && !/\d{4}/.test(range[1])) {
      out.start_date = `${Number(a.slice(0, 4)) - 1}${a.slice(4)}`;
      out.target_date = b;
    }
  }
  return out;
}
