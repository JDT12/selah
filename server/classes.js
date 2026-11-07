import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db, tx, unlinkStorage } from './db.js';
import { config } from './config.js';
import { addDays, today } from './recurrence.js';
import { escapeHtml } from './html.js';
import { skeletonHtml } from '../shared/methods.js';
import { recordMethod } from './methods.js';
import { getItem, getStudy, insertItem, itemsOf, linkNote, newNote, parseData, shelve, studyNotebook, syncTask } from './studies.js';

/**
 * Learn (5.15): the classes you take. A class is a study of kind 'class' whose data holds its syllabus ({ code,
 * professor, contact, term, format: 'online' | 'in-person', meetDays, meetTime, meetMinutes, location, link,
 * officeHours, noClass }), grade categories (data.grades), grading scale (data.scale) and lecture layout. Its items
 * are lectures (kind 'session'), readings (data.pages, data.week) and assignments (data.category, points, score,
 * paper: the Write project for a paper).
 */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function getClass(id) {
  const s = getStudy(id);
  if (s.kind !== 'class') throw httpError(400, 'Not a class');
  return s;
}

/**
 * The lecture dates: in person, every meeting day from the first day of the term to the last (but days with no
 * class); online, one lecture week per week from the first day. Returns [{ title, date, week }].
 */
export function lectureDates(start, end, syl) {
  if (!start || !end || end < start) throw httpError(400, 'Set the first and last day of the term first (Edit…).');
  const out = [];
  if (syl.format === 'in-person') {
    const days = (syl.meetDays ?? []).map(Number).filter((d) => d >= 0 && d <= 6);
    if (!days.length) throw httpError(400, 'Pick the days the class meets first (Edit…).');
    const skip = new Set(syl.noClass ?? []);
    for (let d = start; d <= end && out.length < 200; d = addDays(d, 1)) {
      if (days.includes(weekday(d)) && !skip.has(d)) out.push({ date: d, week: Math.floor((Date.parse(d) - Date.parse(start)) / 604_800_000) + 1 });
    }
    return out.map((x, i) => ({ ...x, title: `Class ${i + 1}` }));
  }
  for (let d = start, w = 1; d <= end && w <= 60; d = addDays(d, 7), w += 1) out.push({ title: `Week ${w} lectures`, date: d, week: w });
  return out;
}

/** Deletes a class's syllabus file (only an attachment with no note: never a file in someone's note). */
export function removeSyllabusFile(id) {
  const a = db.prepare('SELECT storage FROM attachments WHERE id = ? AND note_id IS NULL').get(id);
  if (!a) return;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  unlinkStorage([a.storage]);
}

export default async function classRoutes(app) {
  /** Fills in the lectures from the syllabus; dates that already have one are left alone. */
  app.post('/api/classes/:id/lectures', async (req) => {
    const s = getClass(intParam(req.params.id));
    const syl = parseData(s.data).syllabus ?? {};
    const dates = lectureDates(s.start_date, s.target_date, syl);
    return tx(() => {
      const have = new Set(db.prepare("SELECT date FROM study_items WHERE study_id = ? AND kind = 'session' AND date IS NOT NULL").all(s.id).map((r) => r.date));
      let added = 0;
      for (const l of dates) {
        if (have.has(l.date)) continue;
        insertItem(s.id, { kind: 'session', title: l.title, date: l.date, data: { week: l.week } });
        added += 1;
      }
      db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), s.id);
      return { added, total: dates.length };
    });
  });

  /**
   * An assignment's paper: a Write project named after it, due the day it's due, with its notes in the class's
   * notebook and a first chapter to write in (citations follow your Zotero style, Turabian unless you changed it).
   */
  app.post('/api/study-items/:id/paper', async (req) => {
    const item = getItem(intParam(req.params.id));
    const cls = getClass(item.study_id);
    const existing = item.data.paper && db.prepare("SELECT id FROM studies WHERE id = ? AND kind = 'writing'").get(item.data.paper);
    if (existing) return { id: existing.id, existed: true };
    const syl = parseData(cls.data).syllabus ?? {};
    const goal = Math.max(0, Math.round(Number(req.body?.wordGoal) || 0)) || null;
    return tx(() => {
      const now = Date.now();
      const title = item.title.slice(0, 200);
      const id = Number(db.prepare(`INSERT INTO studies (title, kind, status, description, color, notebook_id, start_date, target_date, data, created_at, updated_at)
        VALUES (?, 'writing', 'active', ?, ?, ?, ?, ?, ?, ?, ?)`).run(title, `For ${syl.code || cls.title}`, cls.color ?? 'blue', cls.notebook_id, today(),
        item.date, JSON.stringify({ wordGoal: goal, forClass: cls.id, forItem: item.id, methods: { writing: 'paper' } }), now, now).lastInsertRowid);
      const noteId = newNote(cls.notebook_id, title, `<p><em>${escapeHtml([syl.code || cls.title, syl.professor, item.date ? `due ${item.date}` : ''].filter(Boolean).join(' · '))}</em></p>${skeletonHtml('paper')}`);
      recordMethod(noteId, 'paper');
      db.prepare(`INSERT INTO study_notes (study_id, note_id, role, added_at, position, status) VALUES (?, ?, 'chapter', ?, 1, 'outline')`).run(id, noteId, now);
      linkNote(cls.id, noteId, 'paper');
      db.prepare('UPDATE study_items SET data = ?, note_id = COALESCE(note_id, ?) WHERE id = ?').run(JSON.stringify({ ...item.data, paper: id }), noteId, item.id);
      syncTask(item.id);
      return { id, note_id: noteId };
    });
  });

  /**
   * What's due in the next `days` days (and anything overdue) across the classes under way. 11.0: with the lectures
   * scheduled in those days (a missed lecture isn't overdue, so past ones stay out).
   */
  app.get('/api/classes/due', async (req) => {
    const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
    const t = today();
    const until = addDays(t, days);
    const out = [];
    for (const s of db.prepare("SELECT * FROM studies WHERE kind = 'class' AND status = 'active'").all()) {
      const syl = parseData(s.data).syllabus ?? {};
      for (const i of itemsOf(s.id)) {
        if (i.done || !i.date || i.date > until || (i.kind === 'session' && i.date < t)) continue;
        out.push({ ...i, study_title: s.title, code: syl.code ?? '', color: s.color, late: i.date < t });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });

  // ---- the syllabus PDF (11.0) ----
  // Kept with the class, not in a note: an attachment with no note, named in data.syllabusPdf ({ id, filename,
  // size, added }). Replacing it removes the old file; deleting the class removes it too (studies.js).
  app.post('/api/classes/:id/syllabus-pdf', async (req) => {
    const s = getClass(intParam(req.params.id));
    const file = await req.file({ limits: { fileSize: config.maxUpload } });
    if (!file) throw httpError(400, 'No file uploaded');
    const storage = crypto.randomBytes(16).toString('hex');
    const dest = path.join(config.filesDir, storage);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
      if (file.file.truncated) throw httpError(413, 'File is too large');
      const head = Buffer.alloc(5);
      const fd = fs.openSync(dest, 'r');
      try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
      if (head.toString('latin1') !== '%PDF-') throw httpError(400, 'That isn’t a PDF. Choose the syllabus as a .pdf file.');
    } catch (err) {
      unlinkStorage([storage]);
      throw err;
    }
    const filename = path.basename(file.filename || 'Syllabus.pdf').slice(0, 255);
    const size = fs.statSync(dest).size;
    const now = Date.now();
    const old = parseData(s.data).syllabusPdf;
    const id = tx(() => {
      const newId = Number(db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (NULL, ?, ?, ?, ?, ?)')
        .run(filename, 'application/pdf', size, storage, now).lastInsertRowid);
      const data = { ...parseData(s.data), syllabusPdf: { id: newId, filename, size, added: now } };
      db.prepare('UPDATE studies SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now, s.id);
      return newId;
    });
    if (old?.id) removeSyllabusFile(old.id);
    return { id, filename, size, added: now };
  });

  app.delete('/api/classes/:id/syllabus-pdf', async (req) => {
    const s = getClass(intParam(req.params.id));
    const { syllabusPdf, ...rest } = parseData(s.data);
    db.prepare('UPDATE studies SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rest), Date.now(), s.id);
    if (syllabusPdf?.id) removeSyllabusFile(syllabusPdf.id);
    return { ok: true };
  });

  /** Puts the class's notebook on the Seminary shelf (only a notebook of its own). */
  app.post('/api/classes/:id/shelve', async (req) => {
    const s = getClass(intParam(req.params.id));
    if (!s.notebook_id) throw httpError(400, 'This class has no notebook.');
    if (!studyNotebook(s)?.own) throw httpError(400, 'Its notebook has other notes in it too, so it stays on its shelf.');
    return { stack_id: shelve(s.notebook_id) };
  });
}
