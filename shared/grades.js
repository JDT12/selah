/**
 * A class's grade (5.15): the syllabus categories (papers, quizzes, discussion…) each carry a weight. A category's
 * score comes from its graded assignments (score out of points), or, before any are graded, from the earned / out of
 * typed on the category itself (how grades were kept before 5.15). The grade is the weighted average of the
 * categories that have a score, so it is "so far"; the letter comes from the class's grading scale.
 * Used by the server (cards on Desk) and the browser (the Grades section).
 */

export const DEFAULT_SCALE = [
  { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
  { letter: 'F', min: 0 },
];

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** The letter for a percent (0–100) on a scale (highest minimum first, whatever order it's stored in). */
export function letterFor(percent, scale = DEFAULT_SCALE) {
  if (percent == null) return null;
  const rows = [...(scale?.length ? scale : DEFAULT_SCALE)].filter((r) => r.letter && num(r.min) != null).sort((a, b) => num(b.min) - num(a.min));
  return rows.find((r) => percent >= num(r.min) - 1e-9)?.letter ?? rows.at(-1)?.letter ?? null;
}

/** An assignment counts once it has points and a score. */
export const isGraded = (item) => num(item.data?.points) > 0 && num(item.data?.score) != null;

/**
 * categories: [{ name, weight, earned?, possible? }]; items: the class's assignments ({ data: { category, points,
 * score } }). Returns { percent, letter, categories: [{ name, weight, earned, possible, percent, graded, fromItems }],
 * ungraded, uncategorized }. Without categories, every graded assignment counts by its points.
 */
export function classGrade(categories = [], items = [], scale = DEFAULT_SCALE) {
  const assignments = items.filter((i) => i.kind === 'assignment');
  const graded = assignments.filter(isGraded);
  const names = new Set(categories.map((c) => (c.name ?? '').trim().toLowerCase()).filter(Boolean));
  const inCat = (i, c) => (i.data?.category ?? '').trim().toLowerCase() === (c.name ?? '').trim().toLowerCase();
  const rows = categories.map((c) => {
    const mine = graded.filter((i) => c.name && inCat(i, c));
    const fromItems = mine.length > 0;
    const earned = fromItems ? mine.reduce((n, i) => n + num(i.data.score), 0) : num(c.earned);
    const possible = fromItems ? mine.reduce((n, i) => n + num(i.data.points), 0) : num(c.possible);
    const percent = possible > 0 && earned != null ? (earned / possible) * 100 : null;
    return { name: c.name ?? '', weight: num(c.weight) ?? 0, earned, possible, percent, graded: mine.length, fromItems };
  });
  let percent = null;
  if (categories.length) {
    const scored = rows.filter((r) => r.percent != null && r.weight > 0);
    const w = scored.reduce((n, r) => n + r.weight, 0);
    if (w > 0) percent = scored.reduce((n, r) => n + r.weight * r.percent, 0) / w;
  } else if (graded.length) {
    const possible = graded.reduce((n, i) => n + num(i.data.points), 0);
    percent = (graded.reduce((n, i) => n + num(i.data.score), 0) / possible) * 100;
  }
  return {
    percent, letter: letterFor(percent, scale), categories: rows,
    ungraded: assignments.filter((i) => !isGraded(i)).length,
    uncategorized: categories.length ? graded.filter((i) => !names.has((i.data?.category ?? '').trim().toLowerCase())).length : 0,
  };
}

/** Week number of a date in a class that starts on `start` (week 1 is the first seven days). */
export function weekOf(date, start) {
  if (!date || !start) return null;
  const days = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return days < 0 ? 0 : Math.floor(days / 7) + 1;
}

/** Pages in "45–80", "pp. 12-30, 41-50" or "112" (0 when it isn't page numbers). */
export function pageCount(pages) {
  let n = 0;
  for (const m of String(pages ?? '').matchAll(/(\d+)\s*(?:[-–—]\s*(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b >= a && b - a < 2000) n += b - a + 1;
  }
  return n;
}
