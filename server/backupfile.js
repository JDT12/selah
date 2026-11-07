import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

/**
 * Backup files: the one you download (Settings → Data & backup → Download a backup) and restore from with
 * `npm run restore -- --file` or the admin console (Restore… → From a backup file). Nothing here touches the
 * database module, so the restore script and the admin console can use it.
 *
 * Inside is a gzipped tar archive:
 *   selah-backup.json      what it holds (first, so it can be read without unpacking the rest)
 *   README.txt
 *   notes.db               a consistent snapshot of the database
 *   files/<name>           every attachment, under the names notes.db refers to them by
 *   config/wordpress.key   the secrets key: the ESV key, WordPress and Zotero sign-ins in notes.db need it
 *   config/certs/…         a home server's certificates (a tenant has none)
 *
 * Not encrypted, that's the whole file (.tar.gz). Encrypted (.selahbak) it's
 *   "SELAHBK1" · salt (16) · iv (12) · check (16) · AES-256-GCM of the .tar.gz · tag (16)
 * with scrypt(passphrase, salt) giving 64 bytes: the first 32 are the AES key, the last 32 make `check`, an HMAC that
 * says at once whether a passphrase is right. The tag covers the whole archive, so a damaged or altered file is
 * caught; restores unpack into a scratch folder and move nothing into place until it has checked out.
 *
 * Restores also take the .tar.gz backups scripts/backup.js keeps on a home server (notes.db and files/).
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const scrypt = promisify(crypto.scrypt);

const MAGIC = Buffer.from('SELAHBK1');
const HEADER = MAGIC.length + 16 + 12 + 16;
const TAG = 16;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const MANIFEST = 'selah-backup.json';

async function keys(passphrase, salt) {
  const k = await scrypt(String(passphrase).normalize('NFC'), salt, 64, SCRYPT);
  return { key: k.subarray(0, 32), check: crypto.createHmac('sha256', k.subarray(32)).update('selah backup check').digest().subarray(0, 16) };
}

// ---------- writing ----------

const octal = (n, width) => n.toString(8).padStart(width, '0');

/** A ustar header; sizes over 8 GB use the GNU base-256 form, which every tar reads. */
function ustar(name, size, mtime, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (size < 0o77777777777) h.write(`${octal(size, 11)}\0`, 124);
  else {
    h[124] = 0x80;
    let v = BigInt(size);
    for (let i = 135; i > 124; i--) { h[i] = Number(v & 0xffn); v >>= 8n; }
  }
  h.write(`${octal(Math.floor(mtime / 1000), 11)}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${octal(sum, 6)}\0 `, 148);
  return h;
}

/** The header for one file; a name longer than 100 bytes goes in a pax record before it. */
function tarHeader(name, size, mtime) {
  if (Buffer.byteLength(name) <= 100) return ustar(name, size, mtime);
  const body = ` path=${name}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  const rec = Buffer.from(`${len}${body}`);
  return Buffer.concat([ustar('PaxHeader', rec.length, mtime, 'x'), rec, padding(rec.length), ustar(name.slice(-100), size, mtime)]);
}

const padding = (size) => Buffer.alloc((512 - (size % 512)) % 512);

/** Entries are { name, data } (a Buffer) or { name, file } (read at the size it had when listed). */
async function* tarChunks(entries) {
  for (const e of entries) {
    if (e.data) {
      yield tarHeader(e.name, e.data.length, Date.now());
      yield e.data;
      yield padding(e.data.length);
      continue;
    }
    const st = fs.statSync(e.file);
    yield tarHeader(e.name, st.size, st.mtimeMs);
    let sent = 0;
    if (st.size > 0) {
      for await (const c of fs.createReadStream(e.file, { start: 0, end: st.size - 1 })) {
        sent += c.length;
        yield c;
      }
    }
    // A file that shrank while being read still has to fill the size its header promised.
    if (sent < st.size) yield Buffer.alloc(st.size - sent);
    yield padding(st.size);
  }
  yield Buffer.alloc(1024);
}

async function encryptor(passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const { key, check } = await keys(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let head = Buffer.concat([MAGIC, salt, iv, check]);
  return new Transform({
    transform(chunk, _enc, cb) {
      if (head) { this.push(head); head = null; }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (head) this.push(head);
      this.push(cipher.final());
      cb(null, cipher.getAuthTag());
    },
  });
}

/** What a backup made now would hold, for the download dialog. */
export function backupContents({ filesDir, dataDir, certDir, keyData = null }) {
  let count = 0;
  let bytes = 0;
  const files = [];
  try {
    for (const f of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const size = fs.statSync(path.join(filesDir, f.name)).size;
      files.push(f.name);
      count++;
      bytes += size;
    }
  } catch { /* no attachments yet */ }
  const key = path.join(dataDir, 'wordpress.key');
  const certs = certDir && fs.existsSync(certDir) ? fs.readdirSync(certDir).filter((f) => fs.statSync(path.join(certDir, f)).isFile()) : [];
  // Selah Desktop's key isn't a file (it's sealed by Windows); it comes in as keyData.
  return { files, count, bytes, key: fs.existsSync(key) ? key : null, keyData: fs.existsSync(key) ? null : keyData, certs };
}

/**
 * Streams a backup to `out`: the database snapshot at `snapshotDb` (made by the caller), the attachments in
 * `filesDir`, the secrets key and any certificates. With a passphrase it's encrypted. Resolves to the bytes written.
 */
export async function writeBackup(out, { snapshotDb, filesDir, dataDir, certDir = null, keyData = null, manifest, passphrase = null }) {
  const c = backupContents({ filesDir, dataDir, certDir, keyData });
  const full = { ...manifest, format: 1, encrypted: !!passphrase, files: { count: c.count, bytes: c.bytes }, wordpressKey: !!(c.key || c.keyData), certs: c.certs.length > 0 };
  const readme = [
    'A Selah backup',
    '',
    `Made ${full.createdAt}${full.tenant ? ` from ${full.tenant}` : ''}: ${full.notes} notes, ${c.count} attachments.`,
    '',
    'selah-backup.json      what this backup holds',
    'notes.db               every note, notebook, tag, task, event and setting (an SQLite database)',
    'files/                 every attachment, under the names notes.db refers to them by',
    'config/wordpress.key   the key that unlocks the sign-ins stored in notes.db (keep this file private)',
    '',
    'To restore it: npm run restore -- --file <this file> on a Selah server, or ask your Selah host.',
  ].join('\n');
  const entries = [
    { name: MANIFEST, data: Buffer.from(JSON.stringify(full, null, 2)) },
    { name: 'README.txt', data: Buffer.from(`${readme}\n`) },
    { name: 'notes.db', file: snapshotDb },
    ...c.files.map((f) => ({ name: `files/${f}`, file: path.join(filesDir, f) })),
    ...(c.key ? [{ name: 'config/wordpress.key', file: c.key }] : []),
    ...(c.keyData ? [{ name: 'config/wordpress.key', data: c.keyData }] : []),
    ...c.certs.map((f) => ({ name: `config/certs/${f}`, file: path.join(certDir, f) })),
  ];
  let written = 0;
  const count = new Transform({ transform(chunk, _e, cb) { written += chunk.length; cb(null, chunk); } });
  const stages = [Readable.from(tarChunks(entries)), zlib.createGzip({ level: 6 })];
  if (passphrase) stages.push(await encryptor(passphrase));
  await pipeline(...stages, count, out);
  return { bytes: written, manifest: full };
}

// ---------- reading ----------

/** 'encrypted', 'plain' (a .tar.gz), 'zip' (an older "Download all my data") or null. */
export function backupKind(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(8);
    const n = fs.readSync(fd, b, 0, 8, 0);
    if (n === 8 && b.equals(MAGIC)) return 'encrypted';
    if (n >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'plain';
    if (n >= 4 && b.readUInt32LE(0) === 0x04034b50) return 'zip';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const notABackup = (kind) => httpError(400, kind === 'zip'
  ? 'That’s a zip from “Download all my data” in an older Selah. Restoring needs a backup from Download a backup.'
  : 'That isn’t a Selah backup file (.selahbak or .tar.gz).');

/** The decrypted (still gzipped) archive as a stream, after checking the passphrase. */
async function archiveStream(file, passphrase) {
  const kind = backupKind(file);
  if (kind === 'plain') return [fs.createReadStream(file)];
  if (kind !== 'encrypted') throw notABackup(kind);
  if (!passphrase) throw Object.assign(httpError(400, 'This backup is encrypted. Enter its passphrase.'), { needsPassphrase: true });
  const size = fs.statSync(file).size;
  if (size < HEADER + TAG) throw httpError(400, 'The backup file is cut short.');
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fd, head, 0, HEADER, 0);
    fs.readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fd);
  }
  const salt = head.subarray(8, 24);
  const iv = head.subarray(24, 36);
  const { key, check } = await keys(passphrase, salt);
  if (!crypto.timingSafeEqual(check, head.subarray(36, 52))) throw Object.assign(httpError(400, 'That’s not the passphrase this backup was made with.'), { wrongPassphrase: true });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const body = size - TAG - 1 >= HEADER ? fs.createReadStream(file, { start: HEADER, end: size - TAG - 1 }) : Readable.from([]);
  return [body, decipher];
}

/** Is `passphrase` right for this (encrypted) file? Quick: the check value, nothing decrypted. */
export async function passphraseFits(file, passphrase) {
  try {
    await archiveStream(file, passphrase);
    return true;
  } catch (e) {
    if (e.wrongPassphrase) return false;
    throw e;
  }
}

const SAFE = /^[\w.@+-]+$/;
/** Where an archive entry goes inside the scratch folder, or null to skip it. */
function destination(name) {
  const n = name.replace(/^\.\//, '');
  if (n === MANIFEST || n === 'notes.db') return n;
  const m = n.match(/^(files|config\/certs)\/([^/]+)$/);
  if (m && SAFE.test(m[2]) && m[2] !== '.' && m[2] !== '..') return `${m[1]}/${m[2]}`;
  if (n === 'config/wordpress.key') return n;
  return null;
}

const cstr = (b) => { const i = b.indexOf(0); return b.toString('utf8', 0, i < 0 ? b.length : i); };
function tarSize(b) {
  if (b[0] & 0x80) {
    let v = 0n;
    for (let i = 1; i < 12; i++) v = (v << 8n) | BigInt(b[i]);
    return Number(v);
  }
  return parseInt(cstr(b).trim() || '0', 8);
}

/** A writable that unpacks a tar stream into `dir`, taking only the entries a backup has. */
function tarExtractor(dir) {
  let buf = Buffer.alloc(0);
  let entry = null; // { fd, left, pad }
  let longName = null;
  let paxPath = null;
  let collect = null; // { kind: 'L' | 'x', left, pad, parts }
  let ended = false;
  const written = new Set();
  const out = new Writable({
    write(chunk, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (ended) { buf = Buffer.alloc(0); break; }
          if (entry || collect) {
            const cur = entry ?? collect;
            if (cur.left > 0) {
              if (!buf.length) break;
              const take = Math.min(cur.left, buf.length);
              if (entry) { if (entry.fd != null) fs.writeSync(entry.fd, buf, 0, take); } else collect.parts.push(Buffer.from(buf.subarray(0, take)));
              cur.left -= take;
              buf = buf.subarray(take);
              if (cur.left > 0) break;
            }
            if (buf.length < cur.pad) break;
            buf = buf.subarray(cur.pad);
            if (entry) { if (entry.fd != null) fs.closeSync(entry.fd); entry = null; } else {
              const text = Buffer.concat(collect.parts);
              if (collect.kind === 'L') longName = cstr(text);
              else paxPath = text.toString('utf8').match(/\d+ path=([^\n]*)\n/)?.[1] ?? null;
              collect = null;
            }
            continue;
          }
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (h.every((b) => b === 0)) { ended = true; continue; }
          const size = tarSize(h.subarray(124, 136));
          const type = String.fromCharCode(h[156] || 48);
          const pad = (512 - (size % 512)) % 512;
          if (type === 'L' || type === 'x') { collect = { kind: type, left: size, pad, parts: [] }; continue; }
          let name = cstr(h.subarray(0, 100));
          if (cstr(h.subarray(257, 263)) === 'ustar' && h[262] === 0) {
            const prefix = cstr(h.subarray(345, 500));
            if (prefix) name = `${prefix}/${name}`;
          }
          name = paxPath ?? longName ?? name;
          paxPath = null;
          longName = null;
          const dest = type === '0' ? destination(name) : null;
          let fd = null;
          if (dest && !written.has(dest)) {
            const p = path.join(dir, dest);
            fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
            fd = fs.openSync(p, 'w', 0o600);
            written.add(dest);
          }
          entry = { fd, left: size, pad };
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
    final(cb) {
      if (entry?.fd != null) fs.closeSync(entry.fd);
      cb(entry && entry.left > 0 ? new Error('The backup file is cut short.') : null);
    },
    destroy(err, cb) {
      if (entry?.fd != null) { try { fs.closeSync(entry.fd); } catch { /* closed */ } }
      cb(err);
    },
  });
  return out;
}

/**
 * Unpacks a backup file into `dir` (a new scratch folder) and checks it: the passphrase, the encryption tag, the
 * database's integrity and that every attachment it refers to is there. Throws with a readable message; on success
 * returns what it holds. Nothing outside `dir` is touched.
 */
export async function unpackBackup(file, passphrase, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stages = await archiveStream(file, passphrase);
  try {
    await pipeline(...stages, zlib.createGunzip(), tarExtractor(dir));
  } catch (e) {
    if (/unable to authenticate|auth/i.test(e.message)) throw httpError(400, 'The backup file is damaged or was changed after it was made, so it wasn’t restored.');
    if (/incorrect header check|unexpected end|Z_BUF_ERROR|cut short/i.test(e.message)) throw httpError(400, 'The backup file is damaged or cut short (an unfinished download?).');
    throw e;
  }
  return checkUnpacked(dir);
}

/** What an unpacked backup holds; throws if the database is missing or damaged. */
export function checkUnpacked(dir) {
  const dbFile = path.join(dir, 'notes.db');
  if (!fs.existsSync(dbFile)) throw httpError(400, 'The backup has no database in it.');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { /* a home server's tarball has none */ }
  let integrity;
  let notes;
  const needed = new Set();
  try {
    const check = new DatabaseSync(dbFile, { readOnly: true });
    try {
      integrity = Object.values(check.prepare('PRAGMA integrity_check').get())[0];
      notes = check.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL').get().n;
      for (const r of check.prepare('SELECT storage FROM attachments').all()) needed.add(r.storage);
      try {
        const banner = JSON.parse(check.prepare("SELECT value FROM settings WHERE key = 'banner'").get()?.value ?? 'null');
        if (banner?.storage) needed.add(banner.storage);
      } catch { /* no banner */ }
    } finally {
      check.close();
    }
  } catch (e) {
    throw httpError(400, `The backup’s database can’t be opened (${e.message}).`);
  }
  if (integrity !== 'ok') throw httpError(400, 'The backup’s database is damaged.');
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(filesDir);
  const bytes = names.reduce((n, f) => n + fs.statSync(path.join(filesDir, f)).size, 0);
  const missing = [...needed].filter((n) => !names.includes(n));
  return {
    manifest, notes, files: names.length, bytes, missing,
    createdAt: manifest?.createdAt ?? null,
    wordpressKey: fs.existsSync(path.join(dir, 'config', 'wordpress.key')),
    certs: fs.existsSync(path.join(dir, 'config', 'certs')),
  };
}

/** Nobody stays signed in through a restore, and an old setup link or deletion request doesn't come back with it. */
export function scrubRestoredDb(dbFile) {
  const fix = new DatabaseSync(dbFile);
  try {
    fix.exec("DELETE FROM sessions; DELETE FROM settings WHERE key IN ('setup_link', 'account_deletion')");
  } finally {
    fix.close();
  }
}

function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves an unpacked backup into place: target { db, files, data, certs? }. The caller has moved the old data aside;
 * `files` must not exist yet. Renames, or a copy where the data and notes folders are on different disks.
 */
export function installUnpacked(dir, target) {
  fs.mkdirSync(path.dirname(target.db), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(target.files), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target.data, { recursive: true, mode: 0o700 });
  move(path.join(dir, 'files'), target.files);
  for (const x of ['-wal', '-shm']) fs.rmSync(target.db + x, { force: true });
  move(path.join(dir, 'notes.db'), target.db);
  const key = path.join(dir, 'config', 'wordpress.key');
  if (fs.existsSync(key)) {
    move(key, path.join(target.data, 'wordpress.key'));
    fs.chmodSync(path.join(target.data, 'wordpress.key'), 0o600);
  }
  const certs = path.join(dir, 'config', 'certs');
  if (target.certs && fs.existsSync(certs)) {
    fs.mkdirSync(target.certs, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(certs)) {
      move(path.join(certs, f), path.join(target.certs, f));
      if (f.endsWith('.key')) fs.chmodSync(path.join(target.certs, f), 0o600);
    }
  }
}
