import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';
import type { ClashReport, ClashRequest, ClashResultItem } from '../../domain/clash/ClashTypes';
import type { ElementSnapshot } from '../../domain/compare/modelDiff';
import type { DrawingExportConfig, DrawingOptions } from '../../domain/drawings/DrawingTypes';
import {
  KernelError,
  type DrawingId,
  type ElementDetails,
  type ElementMesh,
  type ElementQuery,
  type ExportedDrawing,
  type GeneratedDrawing,
  type GeometryEvent,
  type KernelDiagnostic,
  type KernelPort,
  type ModelSummary,
  type ProgressHandler,
  type SpatialTree
} from '../../domain/kernel/KernelPort';
import { mapToLatLng } from '../../domain/coordinates/Coordinates';
import type { CoordinateReference } from '../../domain/models/ModelRecord';
import { isFatalWorkerErrorCode } from '../../ui/viewer/modelRetry';
import { drawingRequest, frameExcludesAll, frameModels } from './drawingRequest';
import type { SheetDiagnostic, StreamStep, WorkerRequest, WorkerResponse } from './protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const isClosed = (error: unknown) => error instanceof KernelError && error.code === 'model-not-open';

/**
 * One Worker, with its own WASM instance, per model. A crash stays inside its model, and
 * closing a model returns all its memory, which a shared instance could never do: WASM
 * memory only grows.
 */
class ModelWorker {
  private worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
  private nextRequest = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly onFatalError?: (error: KernelError) => void) {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) {
        pending.resolve(data.value);
      } else {
        const error = new KernelError(data.code, data.message, data.offset);
        pending.reject(error);
        if (!this.closed && isFatalWorkerErrorCode(data.code)) {
          this.onFatalError?.(error);
        }
      }
    };
    this.worker.onerror = (event) => {
      const error = new KernelError('internal', event.message || 'El kernel se ha detenido.');
      this.rejectAll(error);
      if (!this.closed) {
        this.onFatalError?.(error);
      }
    };
  }

  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  call<T>(request: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
    // A terminated Worker never answers: anyone still walking a stream or a relay must hear so.
    if (this.closed) {
      return Promise.reject(new KernelError('model-not-open', 'El modelo se ha cerrado.'));
    }
    const id = this.nextRequest++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.worker.postMessage({ id, request }, transfer);
    });
  }

  /** Simulates or propagates a fatal Worker crash, rejecting pending calls and notifying listeners. */
  crash(error: KernelError): void {
    this.rejectAll(error);
    if (!this.closed) {
      this.onFatalError?.(error);
    }
  }

  /** Stops at once, even in the middle of evaluating an element. */
  terminate(): void {
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(new KernelError('model-not-open', 'El modelo se ha cerrado.'));
  }
}

/** A verified map conversion is surveyed, while IfcSite is often approximate: docs/05 section 2. */
function withMapPosition(reference: CoordinateReference): CoordinateReference {
  const { confidence, crsId, localToMap } = reference;
  if (confidence !== 'verified' || !crsId || !localToMap) return reference;
  const latLng = mapToLatLng(crsId, localToMap[12], localToMap[13]);
  return latLng ? { ...reference, latLng } : reference;
}

const lostModel = (modelId: ModelId): KernelDiagnostic => ({
  severity: 'warning',
  code: 'drawing-model-lost',
  message: 'El modelo no está disponible y se omite del plano.',
  modelId
});

/** Our Rust kernel. Every model and every drawing has its own Worker and WASM instance. */
export class WasmKernelAdapter implements KernelPort {
  private workers = new Map<ModelId, ModelWorker>();
  private references = new Map<ModelId, CoordinateReference>();
  private sheets = new Map<DrawingId, ModelWorker>();
  private crashListeners = new Set<(modelId: ModelId, error: KernelError) => void>();
  private nextDrawing = 0;
  private drawings: Promise<unknown> = Promise.resolve();

  onModelCrash(listener: (modelId: ModelId, error: KernelError) => void): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  private handleWorkerCrash(modelId: ModelId, worker: ModelWorker, error: KernelError): void {
    if (this.workers.get(modelId) !== worker) return;
    worker.terminate();
    this.workers.delete(modelId);
    this.references.delete(modelId);
    for (const listener of this.crashListeners) {
      try {
        listener(modelId, error);
      } catch (err) {
        console.error('Error in model crash listener:', err);
      }
    }
  }

  /** Terminates a model's Worker as if it crashed, for E2E verification of Worker crash recovery. */
  crashModelForTest(
    modelId: ModelId,
    message = 'El kernel se ha detenido: fallo inesperado en Worker.'
  ): void {
    const worker = this.workers.get(modelId);
    if (!worker) return;
    worker.crash(new KernelError('internal', message));
  }

  private workerOf(modelId: ModelId): ModelWorker {
    const worker = this.workers.get(modelId);
    if (!worker) throw new KernelError('model-not-open', `El modelo ${modelId} no está abierto.`);
    return worker;
  }

  async openModel(
    modelId: ModelId,
    bytes: ArrayBuffer,
    onProgress?: ProgressHandler
  ): Promise<ModelSummary> {
    if (this.workers.has(modelId)) {
      throw new KernelError('internal', `El modelo ${modelId} ya está abierto.`);
    }
    const worker: ModelWorker = new ModelWorker((error) => {
      this.handleWorkerCrash(modelId, worker, error);
    });
    this.workers.set(modelId, worker);
    onProgress?.('Analizando IFC', 0);
    try {
      const opened = await worker.call<ModelSummary>({ op: 'open', modelId, bytes }, [bytes]);
      const coordinateReference = withMapPosition(opened.coordinateReference);
      this.references.set(modelId, coordinateReference);
      onProgress?.('Analizando IFC', 100);
      return { ...opened, coordinateReference };
    } catch (error) {
      await this.closeModel(modelId);
      throw error;
    }
  }

  async *streamGeometry(modelId: ModelId): AsyncIterable<GeometryEvent> {
    const worker = this.workerOf(modelId);
    try {
      await worker.call({ op: 'start-stream' });
      for (;;) {
        const step = await worker.call<StreamStep>({ op: 'next-batch' });
        if ('complete' in step) {
          yield step.complete;
          return;
        }
        yield { type: 'batch', batch: step.batch };
        yield {
          type: 'progress',
          processedElements: step.processedElements,
          totalElements: step.totalElements
        };
      }
    } catch (error) {
      if (!isClosed(error)) throw error;
    }
  }

  async getElementDetails(ref: ElementRef): Promise<ElementDetails | null> {
    const { modelId, expressId } = ref;
    const worker = this.workers.get(modelId);
    if (!worker) return null;
    try {
      const details = await worker.call<Omit<ElementDetails, 'modelId'> | null>({
        op: 'details',
        expressId
      });
      return details && { ...details, modelId };
    } catch (error) {
      if (isClosed(error)) return null;
      throw error;
    }
  }

  async getElementSnapshots(modelId: ModelId): Promise<ElementSnapshot[]> {
    const worker = this.workers.get(modelId);
    if (!worker) return [];
    try {
      return await worker.call<ElementSnapshot[]>({ op: 'snapshots' });
    } catch (error) {
      if (isClosed(error)) return [];
      throw error;
    }
  }

  async getSpatialTree(modelId: ModelId): Promise<SpatialTree | null> {
    const worker = this.workers.get(modelId);
    if (!worker) return null;
    try {
      return await worker.call<SpatialTree | null>({ op: 'tree' });
    } catch (error) {
      if (isClosed(error)) return null;
      throw error;
    }
  }

  async findElements(modelId: ModelId, query: ElementQuery): Promise<number[]> {
    const worker = this.workers.get(modelId);
    if (!worker) return [];
    try {
      return await worker.call<number[]>({ op: 'find', query });
    } catch (error) {
      if (isClosed(error)) return [];
      throw error;
    }
  }

  async elementMesh(modelId: ModelId, expressId: number): Promise<ElementMesh | null> {
    const worker = this.workers.get(modelId);
    if (!worker) return null;
    try {
      return await worker.call<ElementMesh | null>({ op: 'mesh', expressId });
    } catch (error) {
      if (isClosed(error)) return null;
      throw error;
    }
  }

  /** One at a time: a model holds one drawing state. Failures must not stop the queue. */
  generateDrawing(
    modelIds: readonly ModelId[],
    options: DrawingOptions,
    onProgress?: ProgressHandler
  ): Promise<GeneratedDrawing> {
    const run = this.drawings.then(() => this.draw(modelIds, options, onProgress));
    this.drawings = run.catch(() => undefined);
    return run;
  }

  /** Pulls a model's chunks into the sheet. A failure on the model's side loses that model only. */
  private async relay(
    worker: ModelWorker,
    sheet: ModelWorker,
    index: number,
    request: number[]
  ): Promise<KernelDiagnostic[] | null> {
    try {
      await worker.call({ op: 'draw-start', request });
    } catch {
      return null;
    }
    for (;;) {
      let chunk: ArrayBuffer | null;
      try {
        chunk = await worker.call<ArrayBuffer | null>({ op: 'draw-next' });
      } catch {
        await sheet.call({ op: 'sheet-drop', modelIndex: index });
        return null;
      }
      if (!chunk) break;
      // Waiting here is the backpressure: nothing piles up in the message queue.
      await sheet.call({ op: 'sheet-add', modelIndex: index, chunk }, [chunk]);
    }
    try {
      return await worker.call<KernelDiagnostic[]>({ op: 'draw-finish' });
    } catch {
      await sheet.call({ op: 'sheet-drop', modelIndex: index });
      return null;
    }
  }

  private async draw(
    modelIds: readonly ModelId[],
    options: DrawingOptions,
    onProgress?: ProgressHandler
  ): Promise<GeneratedDrawing> {
    const listed = modelIds.length > 0 ? modelIds : Array.from(this.workers.keys());
    const models = listed.map((modelId) => ({
      modelId,
      open: this.workers.has(modelId),
      reference: this.references.get(modelId)
    }));
    const { included, crsId, diagnostics } = frameModels(options.frame, models);
    if (frameExcludesAll(models, included)) {
      const reason = diagnostics[0]?.message ?? 'Ningún modelo encaja en el marco del plano.';
      throw new KernelError('drawing-frame-empty', reason);
    }

    const sheet = new ModelWorker();
    try {
      await sheet.call({ op: 'sheet-new', request: drawingRequest(options) });
      const kept = new Map<number, ModelId>();
      for (const [done, { index, modelId, localToMap }] of included.entries()) {
        onProgress?.('Cortando modelos', Math.round((done / included.length) * 90));
        const worker = this.workers.get(modelId);
        const request = drawingRequest(options, localToMap);
        const found = worker ? await this.relay(worker, sheet, index, request) : null;
        if (found) {
          kept.set(index, modelId);
          diagnostics.push(...found.map((diagnostic) => ({ ...diagnostic, modelId })));
        } else {
          diagnostics.push(lostModel(modelId));
        }
      }
      // A model that finished its relay can still close while the next one runs.
      for (const [index, modelId] of kept) {
        if (!this.workers.has(modelId)) {
          await sheet.call({ op: 'sheet-drop', modelIndex: index });
          kept.delete(index);
          diagnostics.push(lostModel(modelId));
        }
      }
      if (kept.size === 0) {
        throw new KernelError('model-not-open', 'Ningún modelo disponible para el plano.');
      }

      onProgress?.('Generando plano', 95);
      const report = await sheet.call<SheetDiagnostic[]>({ op: 'sheet-generate' });
      for (const { modelIndex, ...diagnostic } of report) {
        const modelId = modelIndex === undefined ? undefined : kept.get(modelIndex);
        diagnostics.push(modelId ? { ...diagnostic, modelId } : diagnostic);
      }
      onProgress?.('Generando plano', 100);

      const drawingId = `drawing-${this.nextDrawing++}`;
      this.sheets.set(drawingId, sheet);
      return { drawingId, frame: options.frame, crsId, diagnostics };
    } catch (error) {
      sheet.terminate();
      throw error;
    }
  }

  async exportDrawing(drawingId: DrawingId, config: DrawingExportConfig): Promise<ExportedDrawing> {
    const sheet = this.sheets.get(drawingId);
    if (!sheet) throw new KernelError('drawing-not-found', 'El plano ya no existe.');
    const svg = config.format === 'svg';
    const bytes = await sheet.call<Uint8Array>({
      op: 'sheet-export',
      svg,
      scale: config.units === 'mm' ? 1000 : 1,
      showHidden: config.showHiddenLines,
      showHatching: config.showHatching,
      comment: config.crsComment
    });
    return svg
      ? {
          content: new TextDecoder().decode(bytes),
          mimeType: 'image/svg+xml',
          filename: `${config.fileName}.svg`
        }
      : { content: bytes, mimeType: 'application/dxf', filename: `${config.fileName}.dxf` };
  }

  async discardDrawing(drawingId: DrawingId): Promise<void> {
    this.sheets.get(drawingId)?.terminate();
    this.sheets.delete(drawingId);
  }

  async closeModel(modelId: ModelId): Promise<void> {
    this.workers.get(modelId)?.terminate();
    this.workers.delete(modelId);
    this.references.delete(modelId);
  }

  async detectClashes(
    request: ClashRequest,
    onProgress?: ProgressHandler
  ): Promise<ClashReport> {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const clearanceM =
      Number.isFinite(request.clearanceM) && request.clearanceM > 0 ? request.clearanceM : 0;
    const maxResults =
      request.maxResults !== undefined && request.maxResults > 0
        ? Math.floor(request.maxResults)
        : 5000;
    const diagnostics: KernelDiagnostic[] = [];

    // Collect deduplicated requested expressIds per open model.
    const modelIndexById = new Map<ModelId, number>();
    const modelIds: ModelId[] = [];
    const wantedByModel = new Map<ModelId, Set<number>>();
    const registerSpec = (modelId: ModelId, expressIds: readonly number[]) => {
      if (expressIds.length === 0) return;
      if (!this.workers.has(modelId)) {
        if (!diagnostics.some((d) => d.code === 'clash-model-not-open' && d.modelId === modelId)) {
          diagnostics.push({
            severity: 'warning',
            code: 'clash-model-not-open',
            message: 'El modelo no está disponible y se omite del análisis de interferencias.',
            modelId
          });
        }
        return;
      }
      if (!modelIndexById.has(modelId)) {
        modelIndexById.set(modelId, modelIds.length);
        modelIds.push(modelId);
      }
      let set = wantedByModel.get(modelId);
      if (!set) {
        set = new Set<number>();
        wantedByModel.set(modelId, set);
      }
      for (const id of expressIds) set.add(id);
    };

    for (const s of request.setA) registerSpec(s.modelId, s.expressIds);
    for (const s of request.setB) registerSpec(s.modelId, s.expressIds);

    if (modelIds.length === 0) {
      return {
        clashes: [],
        broadPhasePairs: 0,
        testedPairs: 0,
        truncated: false,
        elapsedMs: 0,
        diagnostics
      };
    }

    // Phase 1: compact f64 AABBs per open model (52 B/element).
    onProgress?.('Calculando cajas envolventes', 5);
    const boundsByModel = new Map<ModelId, Map<number, [number, number, number, number, number, number]>>();
    for (const [idx, modelId] of modelIds.entries()) {
      const worker = this.workers.get(modelId);
      if (!worker) continue;
      const ids = Array.from(wantedByModel.get(modelId) ?? []).sort((a, b) => a - b);
      const idBuf = new Uint32Array(ids);
      let flat: Float64Array;
      try {
        flat = await worker.call<Float64Array>(
          { op: 'clash-bounds', expressIds: idBuf },
          [idBuf.buffer]
        );
      } catch (err) {
        if (isClosed(err)) continue;
        throw err;
      }
      const map = new Map<number, [number, number, number, number, number, number]>();
      for (let i = 0; i + 6 < flat.length; i += 7) {
        map.set(flat[i], [
          flat[i + 1],
          flat[i + 2],
          flat[i + 3],
          flat[i + 4],
          flat[i + 5],
          flat[i + 6]
        ]);
      }
      boundsByModel.set(modelId, map);
      onProgress?.('Calculando cajas envolventes', 5 + Math.round(((idx + 1) / modelIds.length) * 20));
    }

    interface BroadRef {
      modelId: ModelId;
      modelIdx: number;
      expressId: number;
      box: [number, number, number, number, number, number];
    }

    const packSide = (specs: readonly { modelId: ModelId; expressIds: readonly number[] }[]) => {
      const items: BroadRef[] = [];
      const seen = new Set<string>();
      for (const spec of specs) {
        const modelIdx = modelIndexById.get(spec.modelId);
        const boxes = boundsByModel.get(spec.modelId);
        if (modelIdx === undefined || !boxes) continue;
        for (const expressId of spec.expressIds) {
          const box = boxes.get(expressId);
          if (!box) continue;
          const key = `${modelIdx}:${expressId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ modelId: spec.modelId, modelIdx, expressId, box });
        }
      }
      const flat = new Float64Array(items.length * 8);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const o = i * 8;
        flat[o] = it.modelIdx;
        flat[o + 1] = it.expressId;
        flat[o + 2] = it.box[0];
        flat[o + 3] = it.box[1];
        flat[o + 4] = it.box[2];
        flat[o + 5] = it.box[3];
        flat[o + 6] = it.box[4];
        flat[o + 7] = it.box[5];
      }
      return { items, flat };
    };

    const sideA = packSide(request.setA);
    const sideB = packSide(request.setB);
    if (sideA.items.length === 0 || sideB.items.length === 0) {
      const elapsedMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
      );
      return {
        clashes: [],
        broadPhasePairs: 0,
        testedPairs: 0,
        truncated: false,
        elapsedMs,
        diagnostics
      };
    }

    // Phase 2 & 3: dedicated short-lived ClashWorker (16 MiB bounded LRU cache), terminated in finally.
    const clashWorker = new ModelWorker();
    const MAX_CACHE_BYTES = 16 * 1024 * 1024;
    try {
      await clashWorker.call({ op: 'clash-new', maxCacheBytes: MAX_CACHE_BYTES });
      onProgress?.('Fase ancha (BVH)', 30);
      const rawPairs = await clashWorker.call<Uint32Array>(
        { op: 'clash-broad', aFlat: sideA.flat, bFlat: sideB.flat, clearanceM },
        [sideA.flat.buffer, sideB.flat.buffer]
      );
      const broadPhasePairs = rawPairs.length / 2;
      if (broadPhasePairs === 0) {
        const elapsedMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
        );
        return {
          clashes: [],
          broadPhasePairs: 0,
          testedPairs: 0,
          truncated: false,
          elapsedMs,
          diagnostics
        };
      }

      // Choose the larger unique side as the outer streaming loop, and cache the smaller side.
      const uniqueA = new Set<number>();
      const uniqueB = new Set<number>();
      for (let i = 0; i < rawPairs.length; i += 2) {
        uniqueA.add(rawPairs[i]);
        uniqueB.add(rawPairs[i + 1]);
      }
      const outerIsA = uniqueA.size > uniqueB.size;

      interface GroupedPair {
        refA: BroadRef;
        refB: BroadRef;
        cached: BroadRef;
      }
      const groups = new Map<string, { outer: BroadRef; pairs: GroupedPair[] }>();
      for (let i = 0; i < rawPairs.length; i += 2) {
        const refA = sideA.items[rawPairs[i]];
        const refB = sideB.items[rawPairs[i + 1]];
        const outer = outerIsA ? refA : refB;
        const cached = outerIsA ? refB : refA;
        const key = `${outer.modelIdx}:${outer.expressId}`;
        let group = groups.get(key);
        if (!group) {
          group = { outer, pairs: [] };
          groups.set(key, group);
        }
        group.pairs.push({ refA, refB, cached });
      }

      type RawMeshPayload = { positions: Float64Array; indices: Uint32Array } | null;
      type TestReply =
        | { status: 'miss' }
        | { status: 'none' }
        | { status: 'hit'; data: Float64Array };

      const fetchRawMesh = async (ref: BroadRef): Promise<RawMeshPayload> => {
        const w = this.workers.get(ref.modelId);
        if (!w) return null;
        try {
          return await w.call<RawMeshPayload>({ op: 'clash-mesh', expressId: ref.expressId });
        } catch (err) {
          if (isClosed(err)) return null;
          throw err;
        }
      };

      const sentToCache = new Set<string>();
      const emptyMeshes = new Set<string>();
      const clashes: ClashResultItem[] = [];
      let testedPairs = 0;
      let truncated = false;

      const ensureCached = async (ref: BroadRef, forceRefetch = false): Promise<boolean> => {
        const key = `${ref.modelIdx}:${ref.expressId}`;
        if (emptyMeshes.has(key)) return false;
        if (!forceRefetch && sentToCache.has(key)) return true;
        const raw = await fetchRawMesh(ref);
        if (!raw || raw.indices.length === 0) {
          emptyMeshes.add(key);
          return false;
        }
        const ok = await clashWorker.call<boolean>(
          {
            op: 'clash-cache',
            modelIndex: ref.modelIdx,
            expressId: ref.expressId,
            positions: raw.positions,
            indices: raw.indices
          },
          [raw.positions.buffer, raw.indices.buffer]
        );
        if (ok) {
          sentToCache.add(key);
        } else {
          emptyMeshes.add(key);
        }
        return ok;
      };

      let donePairs = 0;
      let lastPct = 30;
      for (const { outer, pairs } of groups.values()) {
        if (truncated) break;
        const outerKey = `${outer.modelIdx}:${outer.expressId}`;
        if (emptyMeshes.has(outerKey)) {
          donePairs += pairs.length;
          continue;
        }
        const outerRaw = await fetchRawMesh(outer);
        if (!outerRaw || outerRaw.indices.length === 0) {
          emptyMeshes.add(outerKey);
          donePairs += pairs.length;
          continue;
        }
        const activeOk = await clashWorker.call<boolean>(
          {
            op: 'clash-set-active',
            modelIndex: outer.modelIdx,
            expressId: outer.expressId,
            positions: outerRaw.positions,
            indices: outerRaw.indices
          },
          [outerRaw.positions.buffer, outerRaw.indices.buffer]
        );
        if (!activeOk) {
          donePairs += pairs.length;
          continue;
        }

        for (const pair of pairs) {
          if (clashes.length >= maxResults) {
            truncated = true;
            break;
          }
          const ok = await ensureCached(pair.cached, false);
          if (!ok) {
            donePairs++;
            continue;
          }
          let reply = await clashWorker.call<TestReply>({
            op: 'clash-test',
            cachedModel: pair.cached.modelIdx,
            cachedId: pair.cached.expressId,
            clearanceM
          });
          if (reply.status === 'miss') {
            // LRU evicted this entry: re-fetch once and retry.
            const recached = await ensureCached(pair.cached, true);
            if (!recached) {
              donePairs++;
              continue;
            }
            reply = await clashWorker.call<TestReply>({
              op: 'clash-test',
              cachedModel: pair.cached.modelIdx,
              cachedId: pair.cached.expressId,
              clearanceM
            });
          }
          testedPairs++;
          donePairs++;
          if (reply.status === 'hit') {
            const d = reply.data;
            const kind = d[0] === 1 ? 'hard' : 'soft';
            const volumeM3 = Number.isFinite(d[3]) ? d[3] : undefined;
            clashes.push({
              elementA: { modelId: pair.refA.modelId, expressId: pair.refA.expressId },
              elementB: { modelId: pair.refB.modelId, expressId: pair.refB.expressId },
              kind,
              penetrationM: d[1],
              gapM: d[2],
              volumeM3,
              point: [d[4], d[5], d[6]],
              bounds: {
                min: { x: d[7], y: d[8], z: d[9] },
                max: { x: d[10], y: d[11], z: d[12] }
              }
            });
          }
        }

        const pct = 30 + Math.round((donePairs / broadPhasePairs) * 69);
        if (pct > lastPct) {
          lastPct = pct;
          onProgress?.('Comprobando interferencias', pct);
        }
      }

      clashes.sort((x, y) => {
        if (x.kind !== y.kind) return x.kind === 'hard' ? -1 : 1;
        if (x.kind === 'hard') {
          if (y.penetrationM !== x.penetrationM) return y.penetrationM - x.penetrationM;
        } else if (x.gapM !== y.gapM) {
          return x.gapM - y.gapM;
        }
        return (
          x.elementA.modelId.localeCompare(y.elementA.modelId) ||
          x.elementA.expressId - y.elementA.expressId ||
          x.elementB.modelId.localeCompare(y.elementB.modelId) ||
          x.elementB.expressId - y.elementB.expressId
        );
      });

      onProgress?.('Comprobando interferencias', 100);
      const elapsedMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
      );
      return {
        clashes,
        broadPhasePairs,
        testedPairs,
        truncated,
        elapsedMs,
        diagnostics
      };
    } finally {
      clashWorker.terminate();
    }
  }
}
