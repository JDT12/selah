import { db } from './db.js';
import { addDays, today } from './recurrence.js';
import { chaptersOf, itemsOf, studyRow } from './studies.js';
import { lessonSummary } from './courses.js';
import { completedAt } from './methods.js';

/**
 * Desk's Home (6.4): what's next across Study, Teach, Write and Learn, the notes you were last working in, and the
 * week ahead, from the studies under way.
 */
const TAB_OF = { self: 'study', teaching: 'teach', preaching: 'teach', writing: 'write', class: 'learn' };
const tabOf = (s) => (s.data?.course ? 'teach' : TAB_OF[s.kind] ?? 'study');
const alive = (id) => id && db.prepare('SELECT id, title, html, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);

/**
 * How ready a session's lesson or sermon is: 'none' (no note yet), 'started', or 'ready' (marked complete in its
 * builder, or every step written).
 */
function readiness(s, item) {
  const note = item.note_id && item.note_title !== null ? alive(item.note_id) : null;
  if (!note) return { ready: 'none', reached: null, missing: [] };
  const complete = !!completedAt(note.id);
  if (s.kind === 'preaching') return { ready: complete ? 'ready' : 'started', reached: null, missing: [], note_id: note.id, note_title: note.title };
  const sum = lessonSummary(note, item.data.lesson);
  const missing = Object.entries(sum.written).filter(([, v]) => !v).map(([k]) => k);
  return { ready: complete || !missing.length ? 'ready' : 'started', reached: sum.levels?.reached ?? null, missing, note_id: note.id, note_title: note.title };
}

export function deskHome() {
  const t = today();
  const until = addDays(t, 6);
  const studies = db.prepare("SELECT * FROM studies WHERE status = 'active' ORDER BY updated_at DESC").all().map(studyRow);
  const brief = (s) => ({ id: s.id, title: s.title, kind: s.kind, color: s.color, course: !!s.data?.course, tab: tabOf(s) });

  const teach = [];
  const week = [];
  const late = { study: 0, teach: 0, write: 0, learn: 0 };
  const pace = [];
  const writing = [];
  for (const s of studies) {
    const items = itemsOf(s.id);
    const tab = tabOf(s);
    for (const i of items) {
      if (i.done || !i.date) continue;
      // Lectures you sit in aren't due; everything else dated this week goes on the strip.
      if (i.date < t) { if (!(tab === 'learn' && i.kind === 'session')) late[tab] += 1; continue; }
      if (i.date <= until) week.push({ id: i.id, date: i.date, title: i.title, kind: i.kind, ref: i.ref, task_id: i.task_id ?? null, study: brief(s) });
    }
    if (tab === 'teach') {
      const next = items.find((i) => !i.done && i.kind === 'session' && i.date && i.date >= t);
      if (next) teach.push({ study: brief(s), item: { id: next.id, title: next.title, ref: next.ref, date: next.date }, ...readiness(s, next) });
    } else if (tab === 'study') {
      pace.push({ study: brief(s), done: s.progress.done, total: s.progress.total, behind: s.progress.behind, perWeek: s.progress.perWeek,
        next: s.progress.next ? { title: s.progress.next.title, date: s.progress.next.date } : null });
    } else if (tab === 'write') {
      const words = chaptersOf(s.id).reduce((n, c) => n + c.words, 0);
      writing.push({ study: brief(s), words, goal: Number(s.data.wordGoal) || null, target: s.target_date,
        next: s.progress.next ? { title: s.progress.next.title, date: s.progress.next.date } : null });
    }
  }
  teach.sort((a, b) => a.item.date.localeCompare(b.item.date));
  week.sort((a, b) => a.date.localeCompare(b.date));

  // The notes you were last in, from any study under way (its lessons, sermons, chapters and notes).
  const ids = studies.map((s) => s.id);
  const byId = new Map(studies.map((s) => [s.id, s]));
  const recent = ids.length ? db.prepare(`SELECT n.id, n.title, n.updated_at, x.study_id, x.role FROM (
      SELECT study_id, note_id, role FROM study_notes WHERE study_id IN (${ids.map(() => '?').join(',')})
      UNION SELECT study_id, note_id, kind AS role FROM study_items WHERE note_id IS NOT NULL AND study_id IN (${ids.map(() => '?').join(',')})
    ) x JOIN notes n ON n.id = x.note_id AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 40`).all(...ids, ...ids) : [];
  const seen = new Set();
  const continueWith = [];
  for (const r of recent) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const s = byId.get(r.study_id);
    const bs = db.prepare('SELECT 1 FROM bible_studies WHERE note_id = ?').get(r.id);
    const what = bs ? 'study' : s.kind === 'preaching' && r.role === 'session' ? 'sermon' : s.kind === 'teaching' && r.role === 'session' ? 'lesson'
      : r.role === 'chapter' ? 'chapter' : 'note';
    continueWith.push({ note_id: r.id, title: r.title, updated_at: r.updated_at, what, study: brief(s) });
    if (continueWith.length >= 6) break;
  }

  const counts = Object.fromEntries(['study', 'teach', 'write', 'learn'].map((k) => [k, studies.filter((s) => tabOf(s) === k).length]));
  const due = week.filter((w) => w.study.tab === 'learn' && w.kind !== 'session').length;
  return { today: t, counts, late, due, teach: teach.slice(0, 3), pace, writing, week, continue: continueWith };
}

export default async function deskRoutes(app) {
  app.get('/api/desk/home', async () => deskHome());
}
