import { db, tx, getSetting, setSetting } from './db.js';

/**
 * Calendar categories: each event has one (or none), which gives it its color and icon, can carry default
 * reminders for its events, and can be shown or hidden on the Calendar and the Dashboard. They replaced event
 * colors in 5.7: each color in use became a category named after it. A class (Studies) can put its assignments'
 * tasks in a category too (study data.calendarCategory), so they show and filter with it.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
};
export const CATEGORY_COLORS = ['green', 'blue', 'purple', 'red', 'orange', 'yellow', 'teal', 'pink', 'gray'];
export const CATEGORY_ICONS = ['', 'cross', 'bible', 'book', 'school', 'users', 'home', 'heart', 'briefcase', 'music', 'plane',
  'cake', 'star', 'flag', 'trophy', 'sun', 'globe', 'clock', 'bolt'];
const REMINDER_LEADS = [0, 15, 60, 720, 1440, 10080];
const DEFAULT_KEY = 'eventCategoryDefault';

db.exec(`CREATE TABLE IF NOT EXISTS event_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  reminders TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'category_id')) {
  db.exec('ALTER TABLE events ADD COLUMN category_id INTEGER REFERENCES event_categories(id) ON DELETE SET NULL');
}

// Once: each event color in use becomes a category named after it (most used first), and green (the old default
// for new events) becomes the default category.
if (!getSetting('eventCategoriesMigrated')) {
  tx(() => {
    const used = db.prepare('SELECT color, COUNT(*) AS n FROM events GROUP BY color ORDER BY n DESC, color').all();
    const ins = db.prepare('INSERT INTO event_categories (name, color, icon, position, created_at) VALUES (?, ?, \'\', ?, ?)');
    used.forEach((u, i) => {
      const color = CATEGORY_COLORS.includes(u.color) ? u.color : 'green';
      const id = Number(ins.run(color[0].toUpperCase() + color.slice(1), color, i, Date.now()).lastInsertRowid);
      db.prepare('UPDATE events SET category_id = ? WHERE color = ?').run(id, u.color);
      if (u.color === 'green') setSetting(DEFAULT_KEY, String(id));
    });
    setSetting('eventCategoriesMigrated', '1');
  });
}

const parseReminders = (s) => {
  try { const v = JSON.parse(s ?? 'null'); return Array.isArray(v) ? v : null; } catch { return null; }
};
const row = (c) => ({ id: c.id, name: c.name, color: c.color, icon: c.icon, reminders: parseReminders(c.reminders), position: c.position });

export function listCategories() {
  return db.prepare('SELECT * FROM event_categories ORDER BY position, id').all().map(row);
}
/** id -> category */
export const categoryMap = () => new Map(listCategories().map((c) => [c.id, c]));

/** The category new events get when none is chosen (null: none). */
export function defaultCategory() {
  const id = Number(getSetting(DEFAULT_KEY));
  return id && db.prepare('SELECT 1 FROM event_categories WHERE id = ?').get(id) ? id : null;
}

/** A category id from a request (null for none); unknown ids are refused. */
export function categoryRef(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  const id = intParam(v);
  if (!db.prepare('SELECT 1 FROM event_categories WHERE id = ?').get(id)) throw httpError(404, 'Category not found');
  return id;
}

/** Tasks made by a class's assignments take the category the class shows them in (study data.calendarCategory). */
export function withTaskCategories(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const rows = db.prepare(`SELECT i.task_id, s.data FROM study_items i JOIN studies s ON s.id = i.study_id
    WHERE i.task_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (!rows.length) return tasks;
  const cats = categoryMap();
  const byTask = new Map();
  for (const r of rows) {
    let data = {};
    try { data = JSON.parse(r.data || '{}'); } catch { /* none */ }
    const c = cats.get(Number(data.calendarCategory));
    if (c) byTask.set(r.task_id, c);
  }
  for (const t of tasks) {
    const c = byTask.get(t.id);
    if (c) Object.assign(t, { category_id: c.id, category: c.name, category_color: c.color, category_icon: c.icon });
  }
  return tasks;
}

function fields(b) {
  const f = {};
  if ('name' in b) {
    f.name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!f.name) throw httpError(400, 'Give the category a name.');
  }
  if ('color' in b) f.color = CATEGORY_COLORS.includes(b.color) ? b.color : 'green';
  if ('icon' in b) f.icon = CATEGORY_ICONS.includes(b.icon) ? b.icon : '';
  if ('reminders' in b) {
    if (b.reminders === null) f.reminders = null;
    else if (!Array.isArray(b.reminders)) throw httpError(400, 'Reminders must be a list');
    else f.reminders = JSON.stringify([...new Set(b.reminders.map(Number))].filter((n) => REMINDER_LEADS.includes(n)).sort((x, y) => x - y));
  }
  return f;
}

export default async function categoryRoutes(app) {
  app.get('/api/event-categories', async () => ({ categories: listCategories(), defaultId: defaultCategory() }));

  app.post('/api/event-categories', async (req) => {
    const f = fields({ color: 'blue', icon: '', ...req.body });
    if (!f.name) throw httpError(400, 'Give the category a name.');
    const pos = (db.prepare('SELECT MAX(position) AS p FROM event_categories').get().p ?? -1) + 1;
    const id = Number(db.prepare('INSERT INTO event_categories (name, color, icon, reminders, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.name, f.color, f.icon, f.reminders ?? null, pos, Date.now()).lastInsertRowid);
    return row(db.prepare('SELECT * FROM event_categories WHERE id = ?').get(id));
  });

  app.patch('/api/event-categories/:id', async (req) => {
    const id = categoryRef(req.params.id);
    const f = fields(req.body ?? {});
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE event_categories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    // Events keep a color too (for anything that reads it directly).
    if (f.color) db.prepare('UPDATE events SET color = ? WHERE category_id = ?').run(f.color, id);
    return row(db.prepare('SELECT * FROM event_categories WHERE id = ?').get(id));
  });

  // Its events are kept, without a category (or moved to ?into=ID).
  app.delete('/api/event-categories/:id', async (req) => {
    const id = categoryRef(req.params.id);
    const into = req.query.into ? categoryRef(req.query.into) : null;
    if (into === id) throw httpError(400, 'Choose a different category');
    tx(() => {
      db.prepare('UPDATE events SET category_id = ? WHERE category_id = ?').run(into, id);
      db.prepare('DELETE FROM event_categories WHERE id = ?').run(id);
      if (defaultCategory() === null) setSetting(DEFAULT_KEY, '');
    });
    return { categories: listCategories(), defaultId: defaultCategory() };
  });

  // Body: { ids: [in order] }
  app.put('/api/event-categories/order', async (req) => {
    const ids = (req.body?.ids ?? []).map(intParam);
    const set = db.prepare('UPDATE event_categories SET position = ? WHERE id = ?');
    tx(() => ids.forEach((id, i) => set.run(i, id)));
    return { categories: listCategories() };
  });

  // Body: { id } (null: new events start without a category)
  app.put('/api/event-categories/default', async (req) => {
    setSetting(DEFAULT_KEY, String(categoryRef(req.body?.id) ?? ''));
    return { defaultId: defaultCategory() };
  });
}
