import type { ModelId } from '../../domain/models/ModelRecord';
import type { GeometryBatch } from '../../domain/kernel/GeometryBatch';
import type {
  ElementMesh,
  KernelDiagnostic,
  KernelErrorCode,
  ModelSummary
} from '../../domain/kernel/KernelPort';
import type { StreamStep, WorkerRequest, WorkerResponse } from './protocol';
import { batchTransfer, readBatchView } from './batchView';
import init, { allocationFailed, Model, Sheet } from './pkg/wasm_api';
import {
  CACHE_FORMAT,
  CacheCorrupt,
  CacheReader,
  CacheWriter,
  cacheFolder,
  cacheKey,
  cacheName,
  evict,
  seenBefore,
  sha256,
  syncHandle,
  type CacheIdentity,
  type SyncAccessHandle
} from './geometryCache';

/** Large enough to avoid chatter, small enough that the app stays responsive. */
const MAX_TRIANGLES_PER_BATCH = 65536;

class RequestError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
    readonly offset?: number
  ) {
    super(message);
  }
}

/** A chunk that keeps the relay light. An element is never split, so some run larger. */
const MAX_TRIANGLES_PER_CHUNK = 65536;

/**
 * The kernel's identity for the geometry cache: its WASM binary, the cache layout and the batch
 * size, hashed, so any change to what a stream would hold misses. `null` turns the cache off.
 */
let kernelIdentity: Uint8Array | null = null;

const ready = (async () => {
  const response = await fetch(new URL('./pkg/wasm_api_bg.wasm', import.meta.url));
  // A copy to hash: the response itself compiles as it streams, which keeps the browser's cache
  // of the compiled code.
  const binary = response.clone().arrayBuffer();
  await init({ module_or_path: response });
  try {
    const wasm = await binary;
    const salt = new TextEncoder().encode(`cache ${CACHE_FORMAT}, batch ${MAX_TRIANGLES_PER_BATCH}`);
    const salted = new Uint8Array(wasm.byteLength + salt.length);
    salted.set(new Uint8Array(wasm));
    salted.set(salt, wasm.byteLength);
    kernelIdentity = await sha256(salted);
  } catch {
    kernelIdentity = null;
  }
})();

/** A model replayed from the cache has no `Model` until something needs one: then its bytes open it. */
let open: { modelId: ModelId; model: Model | null; bytes: Uint8Array | null } | null = null;
let sheet: Sheet | null = null;
let sequence = 0;
/** The cache being replayed, until its stream ends. */
let replay: { reader: CacheReader; handle: SyncAccessHandle; folder: FileSystemDirectoryHandle; name: string } | null =
  null;
/**
 * The cache being written, until the spatial tree ends it. `streamed` once its one stream has
 * begun, `complete` once that stream has ended.
 */
let writing: {
  writer: CacheWriter;
  handle: SyncAccessHandle;
  folder: FileSystemDirectoryHandle;
  name: string;
  streamed: boolean;
  complete: boolean;
} | null = null;
/** The spatial tree's JSON, kept from the cache or from the stream's end; `undefined` until then. */
let tree: string | null | undefined;

function current(): { modelId: ModelId; model: Model } {
  if (!open) throw new RequestError('model-not-open', 'El modelo no está abierto.');
  if (!open.model) {
    open.model = new Model(open.bytes ?? new Uint8Array());
    open.bytes = null;
  }
  return { modelId: open.modelId, model: open.model };
}

/** Drops a cache file this Worker holds, after a failure. Loading carries on without it. */
function abandon(cache: { handle: SyncAccessHandle; folder: FileSystemDirectoryHandle; name: string }): void {
  try {
    cache.handle.close();
  } catch {
    // Already closed.
  }
  void cache.folder.removeEntry(cache.name).catch(() => undefined);
}

/**
 * Where this open's cache would be, by the file's key, and the whole file's hash, taken only for
 * a cache to read or to write: it holds this thread about a fifth of a second per 77 MB, which a
 * file opened once never pays.
 */
interface CacheSlot {
  folder: FileSystemDirectoryHandle;
  name: string;
  identity: () => Promise<CacheIdentity | null>;
}

async function cacheSlot(data: Uint8Array<ArrayBuffer>): Promise<CacheSlot | null> {
  const kernel = kernelIdentity;
  const folder = kernel && (await cacheFolder());
  if (!kernel || !folder) return null;
  let name: string;
  try {
    name = cacheName(await cacheKey(data), kernel);
  } catch {
    return null;
  }
  let hashing: Promise<CacheIdentity | null> | null = null;
  const identity = () =>
    (hashing ??= sha256(data).then(
      (file) => ({ file, kernel }),
      () => null
    ));
  return { folder, name, identity };
}

/** The finished cache of this file for this kernel, if there is one and it reads. */
async function cached({ folder, name, identity: hashing }: CacheSlot): Promise<typeof replay> {
  let handle: SyncAccessHandle;
  try {
    handle = await syncHandle(await folder.getFileHandle(name));
  } catch {
    // None, or another Worker has it open.
    return null;
  }
  const identity = await hashing();
  if (!identity) {
    handle.close();
    return null;
  }
  try {
    const reader = CacheReader.open(handle, identity, Date.now());
    if (reader) return { reader, handle, folder, name };
  } catch {
    // Damaged: dropped below, and the model loads in full.
  }
  // Damaged, unfinished, or another file's of the same key.
  abandon({ handle, folder, name });
  return null;
}

/** Starts writing this file's cache the second time it is opened, or `null`: see `seenBefore`. */
async function startCache({ folder, name, identity: hashing }: CacheSlot, summary: string): Promise<typeof writing> {
  if (!(await seenBefore(folder, name))) return null;
  const identity = await hashing();
  if (!identity) return null;
  let handle: SyncAccessHandle;
  try {
    handle = await syncHandle(await folder.getFileHandle(name, { create: true }));
  } catch {
    return null;
  }
  try {
    handle.truncate(0);
    const writer = new CacheWriter(handle, identity);
    writer.summary(summary);
    return { writer, handle, folder, name, streamed: false, complete: false };
  } catch {
    abandon({ handle, folder, name });
    return null;
  }
}

/** Kernel errors arrive as `code|offset|message`. See `open_error` in wasm-api. */
function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const text = error instanceof Error ? error.message : String(error);
  // A trap leaves the instance unusable: later calls must not reach it.
  if (error instanceof WebAssembly.RuntimeError) {
    open = null;
    sheet = null;
    return allocationFailed()
      ? new RequestError('out-of-memory', 'El modelo no cabe en la memoria disponible.')
      : new RequestError('internal', `El kernel se ha detenido: ${text}`);
  }
  const [code, offset, ...message] = text.split('|');
  if ((code === 'parse' || code === 'unsupported-schema') && message.length > 0) {
    return new RequestError(code, message.join('|'), offset ? Number(offset) : undefined);
  }
  if (error instanceof RangeError || /memory/i.test(text)) {
    return new RequestError('out-of-memory', text);
  }
  return new RequestError('internal', text);
}

function withModelId(diagnostics: KernelDiagnostic[], modelId: ModelId): KernelDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, modelId }));
}

function summaryOf(json: string, modelId: ModelId): ModelSummary {
  const summary = JSON.parse(json) as ModelSummary;
  return { ...summary, diagnostics: withModelId(summary.diagnostics, modelId) };
}

/** Replays the file's cache if there is one; otherwise parses it, and caches what it streams. */
async function openModel(modelId: ModelId, bytes: ArrayBuffer): Promise<ModelSummary> {
  const data = new Uint8Array(bytes);
  const slot = await cacheSlot(data);
  const hit = slot && (await cached(slot));
  if (hit) {
    replay = hit;
    open = { modelId, model: null, bytes: data };
    tree = hit.reader.tree();
    return summaryOf(hit.reader.summary(), modelId);
  }
  const model = new Model(data);
  open = { modelId, model, bytes: null };
  tree = undefined;
  const json = model.summaryJson();
  if (slot) writing = await startCache(slot, json);
  return summaryOf(json, modelId);
}

/** A step of the replayed stream. The replay ends with it, so a later stream parses the file. */
function replayStep(modelId: ModelId, cache: NonNullable<typeof replay>): { value: StreamStep; transfer: Transferable[] } {
  let step;
  try {
    step = cache.reader.step();
  } catch (error) {
    replay = null;
    abandon(cache);
    if (error instanceof CacheCorrupt) {
      throw new RequestError('internal', 'La caché de geometría de este modelo estaba dañada y se ha borrado: vuelve a abrirlo.');
    }
    throw error;
  }
  if (step.kind === 'complete') {
    replay = null;
    cache.handle.close();
    const complete = JSON.parse(step.json);
    return {
      value: { complete: { type: 'complete', ...complete, diagnostics: withModelId(complete.diagnostics, modelId) } },
      transfer: []
    };
  }
  const batch = { ...step.batch, modelId };
  return {
    value: { batch, processedElements: step.processedElements, totalElements: step.totalElements },
    transfer: batchTransfer(batch)
  };
}

/** Runs a write to the cache. A failure drops the cache, never the stream. */
function toCache(write: (cache: NonNullable<typeof writing>) => void): void {
  if (!writing) return;
  const cache = writing;
  try {
    write(cache);
  } catch {
    writing = null;
    abandon(cache);
  }
}

/**
 * Ends the cache with the spatial tree, which the app asks for once the stream is done: built
 * then, as without a cache, so the model shows as loaded no later than before. Its flushes take
 * about a second on a large model, so it runs after the tree is answered.
 */
function finishCache(json: string | null): void {
  toCache((cache) => {
    if (!cache.complete) return;
    cache.writer.tree(json);
    cache.writer.finish(Date.now());
    cache.handle.close();
    writing = null;
    void evict(cache.folder, cache.name, Date.now()).catch(() => undefined);
  });
}

/** Each `take` hands over a fresh buffer, so transferring it leaves WASM memory alone. */
function readBatch(modelId: ModelId, model: Model): GeometryBatch | null {
  const view = model.nextBatch(MAX_TRIANGLES_PER_BATCH);
  if (!view) return null;
  try {
    sequence += 1;
    return readBatchView(view, modelId, sequence);
  } finally {
    view.free();
  }
}

function nextBatch(): { value: StreamStep; transfer: Transferable[] } {
  if (open && replay) return replayStep(open.modelId, replay);
  const { modelId, model } = current();
  const batch = readBatch(modelId, model);
  if (batch) {
    const value = { batch, processedElements: model.processedElements(), totalElements: model.totalElements() };
    // Before the transfer, which leaves the arrays empty here.
    toCache((cache) => cache.writer.batch(batch, value.processedElements, value.totalElements));
    return { value, transfer: batchTransfer(batch) };
  }
  const json = model.finishStream();
  const complete = JSON.parse(json);
  const diagnostics = withModelId(complete.diagnostics, modelId);
  const value: StreamStep = { complete: { type: 'complete', ...complete, diagnostics } };
  toCache((cache) => {
    cache.writer.complete(json);
    cache.complete = true;
  });
  return { value, transfer: [] };
}

function elementMesh(expressId: number): { value: ElementMesh | null; transfer: Transferable[] } {
  const view = current().model.elementMesh(expressId);
  if (!view) return { value: null, transfer: [] };
  try {
    const mesh = { positions: view.takePositions(), indices: view.takeIndices(), edges: view.takeEdges() };
    const transfer = [mesh.positions.buffer, mesh.indices.buffer, mesh.edges.buffer] as Transferable[];
    return { value: mesh, transfer };
  } finally {
    view.free();
  }
}

function currentSheet(): Sheet {
  if (!sheet) throw new RequestError('drawing-not-found', 'El plano no existe.');
  return sheet;
}

function nextChunk(): { value: unknown; transfer: Transferable[] } {
  const chunk = current().model.nextDrawingChunk(MAX_TRIANGLES_PER_CHUNK);
  return chunk
    ? { value: chunk.buffer, transfer: [chunk.buffer as ArrayBuffer] }
    : { value: null, transfer: [] };
}

function exportSheet(
  request: Extract<WorkerRequest, { op: 'sheet-export' }>
): { value: unknown; transfer: Transferable[] } {
  const { svg, scale, showHidden, showHatching, comment } = request;
  const bytes = currentSheet().export(svg, scale, showHidden, showHatching, comment);
  if (!bytes) throw new RequestError('drawing-not-found', 'El plano aún no está generado.');
  return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
}

async function handle(request: WorkerRequest): Promise<{ value: unknown; transfer: Transferable[] }> {
  switch (request.op) {
    case 'draw-start':
      current().model.startDrawing(new Float64Array(request.request));
      return { value: undefined, transfer: [] };
    case 'draw-next':
      return nextChunk();
    case 'draw-finish':
      return { value: JSON.parse(current().model.finishDrawing()), transfer: [] };
    case 'sheet-new':
      sheet = new Sheet(new Float64Array(request.request));
      return { value: undefined, transfer: [] };
    case 'sheet-add':
      currentSheet().addChunk(request.modelIndex, new Uint8Array(request.chunk));
      return { value: undefined, transfer: [] };
    case 'sheet-drop':
      currentSheet().dropModel(request.modelIndex);
      return { value: undefined, transfer: [] };
    case 'sheet-generate':
      return { value: JSON.parse(currentSheet().generate()), transfer: [] };
    case 'sheet-export':
      return exportSheet(request);
    case 'open':
      return { value: await openModel(request.modelId, request.bytes), transfer: [] };
    case 'start-stream':
      sequence = 0;
      if (replay) {
        replay.reader.rewind();
        return { value: undefined, transfer: [] };
      }
      // A second stream of one open would write its batches again: only the first is cached.
      if (writing?.streamed) {
        abandon(writing);
        writing = null;
      } else if (writing) {
        writing.streamed = true;
      }
      current().model.startStream();
      return { value: undefined, transfer: [] };
    case 'next-batch':
      return nextBatch();
    case 'details': {
      const json = current().model.elementDetailsJson(request.expressId);
      return { value: json ? JSON.parse(json) : null, transfer: [] };
    }
    case 'snapshots':
      return { value: JSON.parse(current().model.elementSnapshotsJson()), transfer: [] };
    case 'tree': {
      if (tree === undefined) {
        const json = current().model.spatialTreeJson() ?? null;
        tree = json;
        setTimeout(() => finishCache(json), 0);
      }
      return { value: tree ? JSON.parse(tree) : null, transfer: [] };
    }
    case 'find': {
      const { field, text, propertyName } = request.query;
      const ids = current().model.findElements(field, text, propertyName);
      return { value: Array.from(ids), transfer: [] };
    }
    case 'mesh':
      return elementMesh(request.expressId);
  }
}

self.onmessage = async (event: MessageEvent<{ id: number; request: WorkerRequest }>) => {
  const { id, request } = event.data;
  try {
    await ready;
    const { value, transfer } = await handle(request);
    const response: WorkerResponse = { id, ok: true, value };
    self.postMessage(response, { transfer });
  } catch (error) {
    const { code, message, offset } = toRequestError(error);
    const response: WorkerResponse = { id, ok: false, code, message, offset };
    self.postMessage(response);
  }
};
