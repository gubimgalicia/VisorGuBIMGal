import {
  INSTANCE_WORDS,
  MESH_RECORD_WORDS,
  TRANSFORM_FLOATS,
  type GeometryBatch,
  type ShapeDef,
  type VertexFormat
} from '../../domain/kernel/GeometryBatch';

/**
 * A model's stream kept in the browser's origin private file system, so reopening the same file
 * with the same kernel replays it instead of parsing and evaluating. One file per model and
 * kernel: a header, then records of a summary, the batches, the `complete` event and the
 * spatial tree, then an end record. The header's length is written last, so a file a crash cut
 * short is never read. See docs/05 section 6.
 */

/** What `FileSystemSyncAccessHandle` offers that the cache uses. Tests give an in-memory one. */
export interface CacheFile {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** Changes whenever the layout below does, so files of an older layout are never read. */
export const CACHE_FORMAT = 2;
const MAGIC = new TextEncoder().encode('GUBIMGC1');
const HEADER_BYTES = 96;
const LAST_USED_AT = 80;
const LENGTH_AT = 88;
const RECORD_HEAD = 8;

/**
 * A batch record's head, 120 bytes: origin (3 f64), box (6 f32), quantBox (6 f32, zeros when
 * absent), a flags word, sequence, processed and total elements, then the lengths of positions,
 * normals, indices, meshTable, instanceTable and instanceTransforms, and the shape count. Then each
 * array in that order, each padded to 4 bytes, then each shape: a 48-byte head (shapeId, flags,
 * box, lengths of positions, normals and indices) and its three arrays, padded the same way.
 */
const BATCH_HEAD = 120;
const BATCH_FLAGS_AT = 72;
const BATCH_COUNTS_AT = 88;
const BATCH_COUNTS = 7;
const SHAPE_HEAD = 48;

/** Flags of a batch or shape head. */
const Flag = { Q16: 1, HasQuantBox: 2, IndicesU16: 4, Closed: 8 } as const;

const Kind = { Summary: 1, Batch: 2, Complete: 3, Tree: 4, End: 5 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

/** The model file's SHA-256 and the kernel's identity, each 32 bytes. */
export interface CacheIdentity {
  file: Uint8Array;
  kernel: Uint8Array;
}

export class CacheCorrupt extends Error {}

/** A batch as the cache holds it: everything but the model, which differs between opens. */
export type CachedBatch = Omit<GeometryBatch, 'modelId'>;

export type CachedStep =
  | { kind: 'batch'; batch: CachedBatch; processedElements: number; totalElements: number }
  | { kind: 'complete'; json: string };

const padded = (length: number) => (length + 3) & ~3;
const bytesOf = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, at) => value === b[at]);

/** Bytes per element of positions, normals and indices, by a head's flags. */
const widths = (flags: number) => {
  const q16 = (flags & Flag.Q16) !== 0;
  return { positions: q16 ? 2 : 4, normals: q16 ? 2 : 4, indices: flags & Flag.IndicesU16 ? 2 : 4 };
};

/** Whether array lengths fit their format: whole vertices, one normal each, whole triangles. */
function vertexShaped(flags: number, positions: number, normals: number, indices: number): boolean {
  const q16 = (flags & Flag.Q16) !== 0;
  const vertices = q16 ? positions / 4 : positions / 3;
  return Number.isInteger(vertices) && normals === vertices * (q16 ? 2 : 3) && indices % 3 === 0;
}

function header(identity: CacheIdentity, lastUsed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(8, CACHE_FORMAT, true);
  bytes.set(identity.file, 16);
  bytes.set(identity.kernel, 48);
  view.setFloat64(LAST_USED_AT, lastUsed, true);
  view.setFloat64(LENGTH_AT, length, true);
  return bytes;
}

/** The bytes of an array followed by zeros up to a multiple of 4. */
function block(view: ArrayBufferView): Uint8Array[] {
  const bytes = bytesOf(view);
  const pad = padded(bytes.length) - bytes.length;
  return pad === 0 ? [bytes] : [bytes, new Uint8Array(pad)];
}

/** Writes a stream as it is made. `finish` makes the file readable; until then it is not. */
export class CacheWriter {
  private at = HEADER_BYTES;
  private readonly file: CacheFile;
  private readonly identity: CacheIdentity;

  constructor(file: CacheFile, identity: CacheIdentity) {
    this.file = file;
    this.identity = identity;
    this.put(header(identity, 0, 0), 0);
  }

  private put(bytes: Uint8Array, at: number): void {
    if (this.file.write(bytes, { at }) !== bytes.length) throw new Error('short write');
  }

  private record(kind: Kind, parts: Uint8Array[]): void {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const head = new DataView(new ArrayBuffer(RECORD_HEAD));
    head.setUint32(0, kind, true);
    head.setUint32(4, length, true);
    this.put(new Uint8Array(head.buffer), this.at);
    let at = this.at + RECORD_HEAD;
    for (const part of parts) {
      this.put(part, at);
      at += part.length;
    }
    // Every record starts on a multiple of 4, so its arrays can be read in place.
    const end = this.at + RECORD_HEAD + padded(length);
    if (end > at) this.put(new Uint8Array(end - at), at);
    this.at = end;
  }

  private text(kind: Kind, json: string): void {
    this.record(kind, [new TextEncoder().encode(json)]);
  }

  summary(json: string): void {
    this.text(Kind.Summary, json);
  }

  batch(batch: CachedBatch, processedElements: number, totalElements: number): void {
    const head = new DataView(new ArrayBuffer(BATCH_HEAD));
    batch.origin.forEach((value, axis) => head.setFloat64(axis * 8, value, true));
    [...batch.box.min, ...batch.box.max].forEach((value, at) => head.setFloat32(24 + at * 4, value, true));
    if (batch.quantBox) {
      [...batch.quantBox.min, ...batch.quantBox.max].forEach((value, at) => head.setFloat32(48 + at * 4, value, true));
    }
    let flags = 0;
    if (batch.vertexFormat === 'q16') flags |= Flag.Q16;
    if (batch.quantBox) flags |= Flag.HasQuantBox;
    if (batch.indices instanceof Uint16Array) flags |= Flag.IndicesU16;
    head.setUint32(BATCH_FLAGS_AT, flags, true);
    [batch.sequence, processedElements, totalElements].forEach((value, at) => head.setUint32(76 + at * 4, value, true));
    const arrays = [
      batch.positions,
      batch.normals,
      batch.indices,
      batch.meshTable,
      batch.instanceTable,
      batch.instanceTransforms
    ];
    [...arrays.map((array) => array.length), batch.shapes.length].forEach((value, at) =>
      head.setUint32(BATCH_COUNTS_AT + at * 4, value, true)
    );
    const parts = [new Uint8Array(head.buffer), ...arrays.flatMap(block)];
    for (const shape of batch.shapes) {
      const shapeHead = new DataView(new ArrayBuffer(SHAPE_HEAD));
      let shapeFlags = 0;
      if (shape.vertexFormat === 'q16') shapeFlags |= Flag.Q16;
      if (shape.indices instanceof Uint16Array) shapeFlags |= Flag.IndicesU16;
      if (shape.closed) shapeFlags |= Flag.Closed;
      shapeHead.setUint32(0, shape.shapeId, true);
      shapeHead.setUint32(4, shapeFlags, true);
      [...shape.box.min, ...shape.box.max].forEach((value, at) => shapeHead.setFloat32(8 + at * 4, value, true));
      [shape.positions.length, shape.normals.length, shape.indices.length].forEach((value, at) =>
        shapeHead.setUint32(32 + at * 4, value, true)
      );
      parts.push(new Uint8Array(shapeHead.buffer), ...[shape.positions, shape.normals, shape.indices].flatMap(block));
    }
    this.record(Kind.Batch, parts);
  }

  complete(json: string): void {
    this.text(Kind.Complete, json);
  }

  tree(json: string | null): void {
    this.text(Kind.Tree, json ?? 'null');
  }

  /** Ends the file and writes its length, which is what makes it readable. */
  finish(now: number): void {
    this.record(Kind.End, []);
    this.file.flush();
    this.put(header(this.identity, now, this.at), 0);
    this.file.flush();
  }
}

interface RecordAt {
  kind: Kind;
  at: number;
  length: number;
}

/**
 * Checks a batch record's heads and lengths against its length, reading only the heads.
 * Throws `CacheCorrupt` when they do not add up.
 */
function checkBatchRecord(file: CacheFile, start: number, length: number): void {
  if (length < BATCH_HEAD) throw new CacheCorrupt('a batch without its head');
  const head = new DataView(new ArrayBuffer(BATCH_HEAD));
  file.read(new Uint8Array(head.buffer), { at: start });
  const flags = head.getUint32(BATCH_FLAGS_AT, true);
  const [positions, normals, indices, table, instances, transforms, shapeCount] = Array.from(
    { length: BATCH_COUNTS },
    (_, k) => head.getUint32(BATCH_COUNTS_AT + k * 4, true)
  );
  const width = widths(flags);
  const shaped =
    vertexShaped(flags, positions, normals, indices) &&
    table % MESH_RECORD_WORDS === 0 &&
    instances % INSTANCE_WORDS === 0 &&
    transforms === (instances / INSTANCE_WORDS) * TRANSFORM_FLOATS &&
    ((flags & Flag.HasQuantBox) !== 0) === positions > 0;
  if (!shaped) throw new CacheCorrupt('a batch whose arrays do not add up');
  let at =
    BATCH_HEAD +
    padded(positions * width.positions) +
    padded(normals * width.normals) +
    padded(indices * width.indices) +
    4 * (table + instances + transforms);
  const shapeHead = new DataView(new ArrayBuffer(SHAPE_HEAD));
  for (let s = 0; s < shapeCount; s++) {
    if (at + SHAPE_HEAD > length) throw new CacheCorrupt('a shape runs past its batch');
    file.read(new Uint8Array(shapeHead.buffer), { at: start + at });
    const shapeFlags = shapeHead.getUint32(4, true);
    const [p, n, i] = [0, 1, 2].map((k) => shapeHead.getUint32(32 + k * 4, true));
    if (!vertexShaped(shapeFlags, p, n, i)) throw new CacheCorrupt('a shape whose arrays do not add up');
    const w = widths(shapeFlags);
    at += SHAPE_HEAD + padded(p * w.positions) + padded(n * w.normals) + padded(i * w.indices);
  }
  if (at !== length) throw new CacheCorrupt('a batch whose arrays do not add up');
}

/**
 * Reads a finished file back. Opening checks the header against the identity and walks every
 * record's head, so a short, foreign or reshaped file is refused before anything is replayed.
 */
export class CacheReader {
  private next = 1;
  private readonly file: CacheFile;
  private readonly records: RecordAt[];

  private constructor(file: CacheFile, records: RecordAt[]) {
    this.file = file;
    this.records = records;
  }

  /** `null` when the file is not a finished cache for this identity. Throws `CacheCorrupt` on a damaged one. */
  static open(file: CacheFile, identity: CacheIdentity, now: number): CacheReader | null {
    const size = file.getSize();
    if (size < HEADER_BYTES) return null;
    const head = new Uint8Array(HEADER_BYTES);
    file.read(head, { at: 0 });
    const view = new DataView(head.buffer);
    if (!same(head.subarray(0, 8), MAGIC) || view.getUint32(8, true) !== CACHE_FORMAT) return null;
    if (!same(head.subarray(16, 48), identity.file) || !same(head.subarray(48, 80), identity.kernel)) return null;
    if (view.getFloat64(LENGTH_AT, true) !== size) return null;

    const records: RecordAt[] = [];
    const recordHead = new DataView(new ArrayBuffer(RECORD_HEAD));
    let at = HEADER_BYTES;
    for (;;) {
      if (at + RECORD_HEAD > size) throw new CacheCorrupt('a record runs past the end');
      file.read(new Uint8Array(recordHead.buffer), { at });
      const kind = recordHead.getUint32(0, true) as Kind;
      const length = recordHead.getUint32(4, true);
      const start = at + RECORD_HEAD;
      if (start + padded(length) > size) throw new CacheCorrupt('a record runs past the end');
      if (kind === Kind.Batch) {
        checkBatchRecord(file, start, length);
      } else if (kind < Kind.Summary || kind > Kind.End) {
        throw new CacheCorrupt(`a record of unknown kind ${kind}`);
      }
      records.push({ kind, at: start, length });
      at = start + padded(length);
      if (kind === Kind.End) break;
    }
    const kinds = records.map((record) => record.kind);
    const batches = kinds.slice(1, -3);
    const ordered =
      at === size &&
      kinds[0] === Kind.Summary &&
      batches.every((kind) => kind === Kind.Batch) &&
      kinds.slice(-3).join() === [Kind.Complete, Kind.Tree, Kind.End].join();
    if (!ordered) throw new CacheCorrupt('records out of order');

    // Marks the file used, for eviction by age.
    const stamp = new DataView(new ArrayBuffer(8));
    stamp.setFloat64(0, now, true);
    file.write(new Uint8Array(stamp.buffer), { at: LAST_USED_AT });
    return new CacheReader(file, records);
  }

  private text(record: RecordAt): string {
    const bytes = new Uint8Array(record.length);
    this.file.read(bytes, { at: record.at });
    return new TextDecoder().decode(bytes);
  }

  summary(): string {
    return this.text(this.records[0]);
  }

  /** The spatial tree's JSON, `null` when the model has none. */
  tree(): string | null {
    const json = this.text(this.records[this.records.length - 2]);
    return json === 'null' ? null : json;
  }

  /** From the first batch again. */
  rewind(): void {
    this.next = 1;
  }

  /** The next batch, or the `complete` event after the last. Throws `CacheCorrupt` on bad indices. */
  step(): CachedStep {
    const record = this.records[this.next];
    if (record.kind === Kind.Complete) return { kind: 'complete', json: this.text(record) };
    this.next += 1;
    const head = new DataView(new ArrayBuffer(BATCH_HEAD));
    this.file.read(new Uint8Array(head.buffer), { at: record.at });
    const flags = head.getUint32(BATCH_FLAGS_AT, true);
    const [sequence, processedElements, totalElements] = [0, 1, 2].map((k) => head.getUint32(76 + k * 4, true));
    const counts = Array.from({ length: BATCH_COUNTS }, (_, k) => head.getUint32(BATCH_COUNTS_AT + k * 4, true));
    let at = record.at + BATCH_HEAD;
    const take = <T extends ArrayBufferView>(make: (length: number) => T, length: number): T => {
      const array = make(length);
      this.file.read(bytesOf(array), { at });
      at += padded(array.byteLength);
      return array;
    };
    const vertexArrays = (arrayFlags: number, lengths: number[]) => {
      const q16 = (arrayFlags & Flag.Q16) !== 0;
      const positions = q16 ? take((n) => new Uint16Array(n), lengths[0]) : take((n) => new Float32Array(n), lengths[0]);
      const normals = q16 ? take((n) => new Int16Array(n), lengths[1]) : take((n) => new Float32Array(n), lengths[1]);
      const indices =
        arrayFlags & Flag.IndicesU16
          ? take((n) => new Uint16Array(n), lengths[2])
          : take((n) => new Uint32Array(n), lengths[2]);
      const vertices = q16 ? positions.length / 4 : positions.length / 3;
      // The renderer trusts indices to stay inside their vertices.
      for (const index of indices) if (index >= vertices) throw new CacheCorrupt('an index past the vertices');
      return { vertexFormat: (q16 ? 'q16' : 'f32') as VertexFormat, positions, normals, indices, vertices };
    };
    const { vertexFormat, positions, normals, indices, vertices } = vertexArrays(flags, counts);
    const meshTable = take((n) => new Uint32Array(n), counts[3]);
    const instanceTable = take((n) => new Uint32Array(n), counts[4]);
    const instanceTransforms = take((n) => new Float32Array(n), counts[5]);
    const recordCount = meshTable.length / MESH_RECORD_WORDS;
    for (let r = 0; r < meshTable.length; r += MESH_RECORD_WORDS) {
      const [, firstVertex, vertexCount, firstIndex, indexCount] = meshTable.subarray(r, r + 5);
      if (firstVertex + vertexCount > vertices || firstIndex + indexCount > indices.length || indexCount % 3 !== 0) {
        throw new CacheCorrupt('a record outside its batch');
      }
    }
    if (vertexFormat === 'q16') {
      for (let v = 3; v < positions.length; v += 4) {
        if (positions[v] >= recordCount) throw new CacheCorrupt('a vertex of a record past the table');
      }
    }
    const shapes: ShapeDef[] = [];
    const shapeHead = new DataView(new ArrayBuffer(SHAPE_HEAD));
    for (let s = 0; s < counts[6]; s++) {
      this.file.read(new Uint8Array(shapeHead.buffer), { at });
      at += SHAPE_HEAD;
      const shapeFlags = shapeHead.getUint32(4, true);
      const corner = (k: number) => shapeHead.getFloat32(8 + k * 4, true);
      const shape = vertexArrays(
        shapeFlags,
        [0, 1, 2].map((k) => shapeHead.getUint32(32 + k * 4, true))
      );
      shapes.push({
        shapeId: shapeHead.getUint32(0, true),
        vertexFormat: shape.vertexFormat,
        positions: shape.positions,
        normals: shape.normals,
        indices: shape.indices,
        box: { min: [corner(0), corner(1), corner(2)], max: [corner(3), corner(4), corner(5)] },
        closed: (shapeFlags & Flag.Closed) !== 0
      });
    }
    const read = (k: number) => head.getFloat32(24 + k * 4, true);
    const quant = (k: number) => head.getFloat32(48 + k * 4, true);
    return {
      kind: 'batch',
      batch: {
        sequence,
        origin: [head.getFloat64(0, true), head.getFloat64(8, true), head.getFloat64(16, true)],
        box: { min: [read(0), read(1), read(2)], max: [read(3), read(4), read(5)] },
        vertexFormat,
        quantBox:
          flags & Flag.HasQuantBox
            ? { min: [quant(0), quant(1), quant(2)], max: [quant(3), quant(4), quant(5)] }
            : null,
        positions,
        normals,
        indices,
        meshTable,
        shapes,
        instanceTable,
        instanceTransforms
      },
      processedElements,
      totalElements
    };
  }
}

// ---------------------------------------------------------------- the origin's file system --

/** The folder in the origin private file system that holds every cache file. */
const FOLDER = 'gubim-geometry-cache';
const SUFFIX = '.gbc';
/** The most all cache files may take together. Older ones go first. */
export const MAX_CACHE_BYTES = 2 * 1024 ** 3;

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** How much of each end of a model file its key reads. */
const KEY_SAMPLE_BYTES = 1024 ** 2;

/**
 * A model file's key: the SHA-256 of its length and its two ends, quick to take where the whole
 * file's hash takes a fifth of a second per 77 MB. It only names the cache file: the header holds
 * the whole file's hash, which settles whether the cache is this file's. Two files with one key,
 * such as an edit that keeps the length and both ends, share a name, and the later drops the other.
 */
export async function cacheKey(data: Uint8Array): Promise<Uint8Array> {
  const sample = Math.min(KEY_SAMPLE_BYTES, Math.ceil(data.length / 2));
  const bytes = new Uint8Array(8 + 2 * sample);
  new DataView(bytes.buffer).setFloat64(0, data.length, true);
  bytes.set(data.subarray(0, sample), 8);
  bytes.set(data.subarray(data.length - sample), 8 + sample);
  return sha256(bytes);
}

/** Where a model's cache lives: by its file's key, then by the kernel, so a new kernel misses. */
export const cacheName = (key: Uint8Array, kernel: Uint8Array) => `${hex(key)}-${hex(kernel).slice(0, 16)}${SUFFIX}`;

/** An empty file that says a model was opened once, with no cache yet. */
const SEEN = '.seen';
/** Marks older than this are dropped: a file opened once a month ago is not worth a cache. */
const SEEN_DAYS = 30;

/**
 * Whether this file was opened before with this kernel, marking it if not. Writing a cache costs
 * about as much as a fifth of a load, so only a file opened a second time gets one.
 */
export async function seenBefore(folder: FileSystemDirectoryHandle, cache: string): Promise<boolean> {
  const name = cache.replace(SUFFIX, SEEN);
  try {
    await folder.getFileHandle(name);
    return true;
  } catch {
    await folder.getFileHandle(name, { create: true }).catch(() => undefined);
    return false;
  }
}

/** A `FileSystemSyncAccessHandle`, which only Workers have, so the DOM types leave it out. */
export interface SyncAccessHandle extends CacheFile {
  truncate(size: number): void;
}

/** Opens a file for synchronous access, holding it until closed: a second open fails. */
export function syncHandle(file: FileSystemFileHandle): Promise<SyncAccessHandle> {
  return (file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
}

/** The cache folder, or `null` where the browser has no origin private file system. */
export async function cacheFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(FOLDER, { create: true });
  } catch {
    return null;
  }
}

interface Entry {
  name: string;
  bytes: number;
  lastModified: number;
}

/**
 * Every cache file the folder holds now, or with `marks` every mark too. Files another Worker is
 * writing may be missing.
 */
async function entries(folder: FileSystemDirectoryHandle, marks = false): Promise<Entry[]> {
  const found: Entry[] = [];
  for await (const [name, handle] of (folder as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !(name.endsWith(SUFFIX) || (marks && name.endsWith(SEEN)))) continue;
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      found.push({ name, bytes: file.size, lastModified: file.lastModified });
    } catch {
      // Open in another Worker: it will be counted next time.
    }
  }
  return found;
}

/**
 * Keeps the folder under `MAX_CACHE_BYTES`, dropping the least recently used files first, and
 * drops every file of another kernel, which can never be read again by this one.
 */
export async function evict(folder: FileSystemDirectoryHandle, keep: string, now: number): Promise<void> {
  const kernel = keep.slice(65, 65 + 16);
  const found = (await entries(folder, true)).sort((a, b) => b.lastModified - a.lastModified);
  let total = 0;
  for (const entry of found) {
    const stale = entry.name.slice(65, 65 + 16) !== kernel;
    if (entry.name.endsWith(SEEN)) {
      // The kept file's mark has done its job; old marks are not worth keeping.
      const done = entry.name === keep.replace(SUFFIX, SEEN);
      if (done || stale || now - entry.lastModified > SEEN_DAYS * 86400000) {
        await folder.removeEntry(entry.name).catch(() => undefined);
      }
      continue;
    }
    total += entry.bytes;
    if (entry.name !== keep && (stale || total > MAX_CACHE_BYTES)) {
      total -= entry.bytes;
      await folder.removeEntry(entry.name).catch(() => undefined);
    }
  }
}

/** How many models the cache holds and how much it takes. */
export async function cacheUsage(): Promise<{ models: number; bytes: number }> {
  const folder = await cacheFolder();
  if (!folder) return { models: 0, bytes: 0 };
  const found = await entries(folder);
  return { models: found.length, bytes: found.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** Removes every cache file and mark not in use. Models open now keep theirs until closed. */
export async function clearCache(): Promise<void> {
  const folder = await cacheFolder();
  if (!folder) return;
  for (const entry of await entries(folder, true)) {
    await folder.removeEntry(entry.name).catch(() => undefined);
  }
}
