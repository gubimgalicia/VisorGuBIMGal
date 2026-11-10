/**
 * A ZIP reader and writer for small archives such as BCF files, on the browser's own deflate
 * streams. Stored and deflated entries only; no ZIP64, no encryption, no spanning. Every entry's
 * size and CRC-32 are checked, and the total a reader inflates is capped, so a hostile archive
 * fails with a message instead of filling the memory.
 */

export class ZipError extends Error {}

/** What a reader inflates at most, all entries together. */
export const MAX_UNZIPPED_BYTES = 512 * 1024 ** 2;
const MAX_ENTRIES = 65535;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
/** General purpose flag: names and comments are UTF-8. */
const UTF8_NAMES = 1 << 11;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError('Una entrada del archivo comprimido ocupa más de lo que declara.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Every file in the archive by its path; folders are left out. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last thing in the file, after a comment of at most 65535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError('No es un archivo ZIP.');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralAt = view.getUint32(end + 16, true);
  if (count === 0xffff || centralAt === 0xffffffff) throw new ZipError('Los archivos ZIP64 no están admitidos.');
  if (count > MAX_ENTRIES || centralAt + centralSize > end) throw new ZipError('El directorio del archivo ZIP está dañado.');

  const files = new Map<string, Uint8Array>();
  let total = 0;
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_HEADER) throw new ZipError('El directorio del archivo ZIP está dañado.');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder(flags & UTF8_NAMES ? 'utf-8' : 'latin1').decode(rawName).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`«${name}» está cifrado.`);
    if (packed === 0xffffffff || size === 0xffffffff) throw new ZipError('Los archivos ZIP64 no están admitidos.');
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new ZipError('El archivo descomprimido sería demasiado grande.');

    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL_HEADER) {
      throw new ZipError(`La entrada «${name}» está dañada.`);
    }
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + packed > bytes.length) throw new ZipError(`La entrada «${name}» está cortada.`);
    const data = bytes.subarray(dataAt, dataAt + packed);
    let content: Uint8Array;
    if (method === STORED) {
      content = data.slice();
    } else if (method === DEFLATED) {
      try {
        content = await through(data, new DecompressionStream('deflate-raw'), size);
      } catch (error) {
        if (error instanceof ZipError) throw error;
        throw new ZipError(`La entrada «${name}» está dañada.`);
      }
    } else {
      throw new ZipError(`La entrada «${name}» usa una compresión no admitida (${method}).`);
    }
    if (content.length !== size || crc32(content) !== crc) throw new ZipError(`La entrada «${name}» está dañada.`);
    files.set(name, content);
  }
  return files;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** MS-DOS time and date, which ZIP stores, of a moment in local time. */
function dosTime(date: Date): [number, number] {
  const year = Math.max(1980, date.getFullYear());
  return [
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  ];
}

/** An archive of the entries in order, each deflated unless that would not make it smaller. */
export async function writeZip(entries: readonly ZipEntry[], modified = new Date()): Promise<Uint8Array> {
  const [time, date] = dosTime(modified);
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const deflated = await through(entry.data, new CompressionStream('deflate-raw'), Number.MAX_SAFE_INTEGER);
    const method = deflated.length < entry.data.length ? DEFLATED : STORED;
    const data = method === DEFLATED ? deflated : entry.data;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, END_OF_CENTRAL, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, endRecord]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
