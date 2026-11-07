import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * A small reader for zip files (EPUBs are zips): returns a Map of entry name -> Buffer, read from the central
 * directory. Only stored and deflated entries are supported, which is all EPUBs use. Sizes are capped so a
 * crafted file can't fill memory.
 */
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

export function readZip(buf) {
  const bad = (why) => Object.assign(new Error(`Not a readable zip/EPUB file (${why}).`), { statusCode: 400 });
  // End of central directory: the last 0x06054b50 within the final 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('no directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('broken directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('broken entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    let out;
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    else continue; // other methods aren't used in EPUBs
    if (size > MAX_ENTRY || (total += out.length) > MAX_TOTAL) throw bad('too large');
    files.set(name, out);
  }
  return files;
}

/** MS-DOS date and time for a zip entry. */
function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Streams a zip of files to `out` (a writable): entries are { name, file, mtime }, { name, data } for a Buffer, or
 * { name, chunks } for a function giving an (async) iterable of Buffers/strings, made as it's written. Files are stored as they are
 * (photos, PDFs and audio don't shrink), each followed by a data descriptor so nothing is read twice. No ZIP64,
 * so the whole archive must stay under 4 GB; callers check that first.
 */
export async function writeZip(out, entries) {
  let offset = 0;
  const central = [];
  const write = async (buf) => {
    offset += buf.length;
    if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
  };
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.mtime ?? Date.now());
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes in the descriptor; bit 11: UTF-8 name
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([local, name]));
    let crc = 0;
    let size = 0;
    for await (let chunk of e.data ? [e.data] : e.chunks ? e.chunks() : fs.createReadStream(e.file)) {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8');
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      await write(chunk);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, name]));
  }
  const dirStart = offset;
  const dir = Buffer.concat(central);
  await write(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(dirStart, 16);
  await write(end);
  out.end();
}

/**
 * The entries of a zip file on disk, read from its central directory without loading the file: [{ name, method,
 * csize, size, local }]. For files too large for readZip (a .selahnb with its attachments); extractEntry streams one out.
 */
export function zipEntries(file) {
  const bad = (why) => Object.assign(new Error(`Not a readable zip file (${why}).`), { statusCode: 400 });
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw bad('no directory');
    const count = tail.readUInt16LE(eocd + 10);
    const dirLen = tail.readUInt32LE(eocd + 12);
    const dirAt = tail.readUInt32LE(eocd + 16);
    if (dirAt + dirLen > size) throw bad('broken directory');
    const dir = Buffer.alloc(dirLen);
    fs.readSync(fd, dir, 0, dirLen, dirAt);
    const out = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw bad('broken directory');
      const nameLen = dir.readUInt16LE(p + 28);
      const entry = {
        name: dir.toString('utf8', p + 46, p + 46 + nameLen), method: dir.readUInt16LE(p + 10),
        csize: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24), local: dir.readUInt32LE(p + 42),
      };
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
      if (!entry.name.endsWith('/')) out.push(entry);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Streams one entry (from zipEntries) of `file` to `dest`. Stored and deflated entries only. */
export async function extractEntry(file, entry, dest) {
  const fd = fs.openSync(file, 'r');
  let start;
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.local);
    if (head.readUInt32LE(0) !== 0x04034b50) throw Object.assign(new Error('Not a readable zip file (broken entry).'), { statusCode: 400 });
    start = entry.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  if (entry.method !== 0 && entry.method !== 8) throw Object.assign(new Error('That zip uses a kind of compression Selah can’t read.'), { statusCode: 400 });
  const { pipeline } = await import('node:stream/promises');
  if (entry.csize === 0) { fs.writeFileSync(dest, ''); return; }
  const src = fs.createReadStream(file, { start, end: start + entry.csize - 1 });
  await (entry.method === 8 ? pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(dest)) : pipeline(src, fs.createWriteStream(dest)));
}
