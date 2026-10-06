// ============================================================================
//  A small ZIP reader and writer — just enough for .xlsx files.
//
//  An .xlsx is a ZIP of XML files. We deliberately do not pull in a ZIP or
//  spreadsheet library (the npm build of SheetJS carries unfixed CVEs), so
//  this file does the container by hand and leaves compression to the
//  platform: CompressionStream / DecompressionStream with 'deflate-raw',
//  which every modern browser and Node 24 provide. That is why reading and
//  writing are async.
//
//  What it accepts: entries stored (method 0) or deflated (method 8), each
//  checked against its CRC-32. What it refuses, with a plain error:
//  encrypted entries, other compression methods, ZIP64 archives, and
//  anything that would inflate past the limits below — a small file that
//  expands to gigabytes (a "zip bomb") must not take the tab down with it.
//
//  Runs in the browser and in Node: erasable TypeScript only, no Buffer.
// ============================================================================

/** Refuse archives that inflate past this many bytes in total. */
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
/** Refuse archives with more entries than this. */
export const MAX_ENTRIES = 10_000;

export class ZipError extends Error {}

// ---------------------------------------------------------------------------
//  CRC-32 (the IEEE polynomial ZIP uses), table-driven.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
//  Compression through the platform's streams.
// ---------------------------------------------------------------------------

/**
 * Push bytes through a transform stream and collect what comes out,
 * stopping (and failing) as soon as the output passes `limit` bytes.
 */
async function transform(
  stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> },
  data: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the reading side; these catches only stop an
  // "unhandled rejection" when the reader gives up early.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ZipError('A file inside the archive is larger than it claims to be, or too large to open.');
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  try {
    return await transform(new DecompressionStream('deflate-raw'), data, expected);
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('A file inside the archive is damaged and could not be decompressed.');
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return transform(new CompressionStream('deflate-raw'), data, Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------
//  Reading.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64_LOCATOR = 0x07064b50;

const utf8 = new TextDecoder('utf-8');
const cp437ish = new TextDecoder('latin1');

/**
 * Every file in the archive, by its path inside the archive ("xl/workbook.xml").
 * Folders are skipped. Throws ZipError on anything it cannot or will not read.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const inside = (at: number, len: number) => at >= 0 && len >= 0 && at + len <= bytes.length;

  // The end-of-central-directory record sits in the last 22 bytes plus up to
  // a 64 KB comment. Search backwards for its signature.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new ZipError('This is not a ZIP-based file (no end record found).');
  if (end >= 20 && u32(end - 20) === SIG_END64_LOCATOR) {
    throw new ZipError('ZIP64 archives are not supported.');
  }

  const count = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0) throw new ZipError('Multi-part ZIP archives are not supported.');
  if (count > MAX_ENTRIES) throw new ZipError(`The archive has ${count} files; the limit is ${MAX_ENTRIES}.`);
  if (!inside(cdOffset, cdSize)) throw new ZipError('The archive is truncated or damaged.');

  interface Entry { name: string; method: number; crc: number; csize: number; usize: number; local: number }
  const entries: Entry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (!inside(p, 46) || u32(p) !== SIG_CENTRAL) throw new ZipError('The archive directory is damaged.');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const local = u32(p + 42);
    if (!inside(p + 46, nameLen + extraLen + commentLen)) throw new ZipError('The archive directory is damaged.');
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? utf8 : cp437ish).decode(rawName);
    p += 46 + nameLen + extraLen + commentLen;

    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported.');
    }
    if (name.endsWith('/')) continue; // a folder
    if (flags & 0x1) throw new ZipError(`"${name}" is encrypted; encrypted archives are not supported.`);
    if (method !== 0 && method !== 8) {
      throw new ZipError(`"${name}" uses compression method ${method}; only stored and deflate are supported.`);
    }
    if (method === 0 && csize !== usize) throw new ZipError(`"${name}" has inconsistent sizes.`);
    total += usize;
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new ZipError(`The archive expands past ${MAX_TOTAL_UNCOMPRESSED / 1024 / 1024} MB; refusing to open it.`);
    }
    entries.push({ name, method, crc, csize, usize, local });
  }

  const files = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (!inside(e.local, 30) || u32(e.local) !== SIG_LOCAL) throw new ZipError(`The header of "${e.name}" is damaged.`);
    const start = e.local + 30 + u16(e.local + 26) + u16(e.local + 28);
    if (!inside(start, e.csize)) throw new ZipError(`"${e.name}" is truncated.`);
    const raw = bytes.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw.slice() : await inflate(raw, e.usize);
    if (data.length !== e.usize) throw new ZipError(`"${e.name}" is not the size the archive says it is.`);
    if (crc32(data) !== e.crc) throw new ZipError(`"${e.name}" failed its CRC check; the file is damaged.`);
    files.set(e.name, data);
  }
  return files;
}

// ---------------------------------------------------------------------------
//  Writing.
// ---------------------------------------------------------------------------

/** 1 January 2026 00:00, in MS-DOS format. A fixed stamp keeps output reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const utf8enc = new TextEncoder();

/**
 * Build a ZIP from these files, in this order. Each is deflated unless
 * deflating would not make it smaller, in which case it is stored.
 */
export async function writeZip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  if (files.length > 0xfffe) throw new ZipError('Too many files for a ZIP without ZIP64.');
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = utf8enc.encode(f.name);
    const crc = crc32(f.data);
    const packed = await deflate(f.data);
    const stored = packed.length >= f.data.length;
    const body = stored ? f.data : packed;
    const method = stored ? 0 : 8;
    if (f.data.length > 0xfffffffe || offset > 0xfffffffe) throw new ZipError('Too large for a ZIP without ZIP64.');

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);            // version needed: 2.0
    lv.setUint16(6, 0x800, true);         // flags: names are UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk start, internal attrs, external attrs: all zero
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    parts.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const all = [...parts, ...central, end];
  return concat(all, all.reduce((n, c) => n + c.length, 0));
}
