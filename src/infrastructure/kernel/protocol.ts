import type { ModelId } from '../../domain/models/ModelRecord';
import type { GeometryBatch } from '../../domain/kernel/GeometryBatch';
import type { ElementQuery, GeometryEvent, KernelErrorCode } from '../../domain/kernel/KernelPort';

/** A Worker holds one model, opened by its first request, or one drawing's sheet. */
export type WorkerRequest =
  | { op: 'open'; modelId: ModelId; bytes: ArrayBuffer }
  | { op: 'start-stream' }
  | { op: 'next-batch' }
  | { op: 'details'; expressId: number }
  | { op: 'snapshots' }
  | { op: 'tree' }
  | { op: 'find'; query: ElementQuery }
  | { op: 'mesh'; expressId: number }
  | { op: 'draw-start'; request: number[] }
  | { op: 'draw-next' }
  | { op: 'draw-finish' }
  | { op: 'sheet-new'; request: number[] }
  | { op: 'sheet-add'; modelIndex: number; chunk: ArrayBuffer }
  | { op: 'sheet-drop'; modelIndex: number }
  | { op: 'sheet-generate' }
  | {
      op: 'sheet-export';
      svg: boolean;
      scale: number;
      showHidden: boolean;
      showHatching: boolean;
      comment?: string;
    }
  | { op: 'clash-bounds'; expressIds: Uint32Array }
  | { op: 'clash-mesh'; expressId: number }
  | { op: 'clash-new'; maxCacheBytes: number }
  | { op: 'clash-broad'; aFlat: Float64Array; bFlat: Float64Array; clearanceM: number }
  | {
      op: 'clash-cache';
      modelIndex: number;
      expressId: number;
      positions: Float64Array;
      indices: Uint32Array;
    }
  | {
      op: 'clash-set-active';
      modelIndex: number;
      expressId: number;
      positions: Float64Array;
      indices: Uint32Array;
    }
  | {
      op: 'clash-test';
      cachedModel: number;
      cachedId: number;
      clearanceM: number;
    };

/** One pull of a geometry stream. */
export type StreamStep =
  | { batch: GeometryBatch; processedElements: number; totalElements: number }
  | { complete: Extract<GeometryEvent, { type: 'complete' }> };

/** A diagnostic from a sheet: models are numbered by their place in the drawing's list. */
export interface SheetDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  modelIndex?: number;
  expressId?: number;
}

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; code: KernelErrorCode; message: string; offset?: number };
