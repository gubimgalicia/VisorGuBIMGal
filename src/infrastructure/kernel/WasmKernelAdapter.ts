import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';
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
}
