/**
 * Reading note packages (see server/notepack.js) out of any Selah database, with nothing imported that opens one: the
 * admin console uses this on a tenant's host-backup snapshot, which it never adds to its own database.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const VERSION = 1;
const MAX_NOTES = 20_000;

const hasColumn = (src, table, column) => src.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
const list = (v) => [...new Set((v ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/** A package of `noteIds` and every note in `notebookIds`, read from `src` (a DatabaseSync; templates and trash left out unless asked for by id). */
export function readPackage(src, { noteIds = [], notebookIds = [] } = {}) {
  const ids = list(noteIds);
  const books = list(notebookIds);
  if (!ids.length && !books.length) throw httpError(400, 'Choose notes or notebooks.');
  const template = hasColumn(src, 'notes', 'is_template');
  const where = [
    ids.length && `n.id IN (${ids.map(() => '?').join(',')})`,
    books.length && `(n.notebook_id IN (${books.map(() => '?').join(',')})${template ? ' AND n.is_template = 0' : ''})`,
  ].filter(Boolean).join(' OR ');
  const rows = src.prepare(`SELECT n.id, n.notebook_id, n.title, n.html, n.created_at, n.updated_at, n.pinned${template ? ', n.is_template' : ''}
    FROM notes n WHERE n.deleted_at IS NULL AND (${where}) ORDER BY n.notebook_id, n.created_at, n.id`).all(...ids, ...books);
  if (rows.length > MAX_NOTES) throw httpError(413, `That’s more than ${MAX_NOTES.toLocaleString()} notes; choose fewer.`);
  const tags = src.prepare('SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name');
  const files = src.prepare('SELECT id, filename, mime, size, storage, created_at FROM attachments WHERE note_id = ? ORDER BY id');
  const nb = src.prepare('SELECT nb.id, nb.name, s.name AS stack FROM notebooks nb LEFT JOIN stacks s ON s.id = nb.stack_id WHERE nb.id = ?');
  const notebooks = new Map();
  const notes = rows.map((r) => {
    const key = r.notebook_id ?? 0;
    if (!notebooks.has(key)) {
      const b = r.notebook_id ? nb.get(r.notebook_id) : null;
      notebooks.set(key, { key, id: b?.id ?? null, name: b?.name ?? 'Restored notes', stack: b?.stack ?? null, whole: !!b && books.includes(b.id) });
    }
    return {
      id: r.id, notebook: key, title: r.title, html: r.html, created_at: r.created_at, updated_at: r.updated_at,
      pinned: r.pinned ? 1 : 0, is_template: r.is_template ? 1 : 0,
      tags: tags.all(r.id).map((t) => t.name), attachments: files.all(r.id),
    };
  });
  // A whole notebook with nothing in it still comes back.
  for (const id of books) {
    if (notebooks.has(id)) continue;
    const b = nb.get(id);
    if (b) notebooks.set(id, { key: id, id, name: b.name, stack: b.stack, whole: true });
  }
  return { app: 'Selah', kind: 'notes', version: VERSION, createdAt: new Date().toISOString(), notebooks: [...notebooks.values()], notes };
}

/** Throws unless `pkg` looks like a package this version can read. */
export function checkPackage(pkg) {
  const bad = () => httpError(400, 'That isn’t a Selah notebook file, or it’s damaged.');
  if (!pkg || pkg.app !== 'Selah' || pkg.kind !== 'notes' || !Array.isArray(pkg.notes) || !Array.isArray(pkg.notebooks)) throw bad();
  if (pkg.version > VERSION) throw httpError(400, 'That file is from a newer Selah. Update this one first.');
  if (pkg.notes.length > MAX_NOTES) throw httpError(413, `That file has more than ${MAX_NOTES.toLocaleString()} notes.`);
  for (const n of pkg.notes) {
    if (typeof n.html !== 'string' || typeof n.title !== 'string' || !Array.isArray(n.attachments ?? [])) throw bad();
  }
}

