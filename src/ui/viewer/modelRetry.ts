import type { KernelErrorCode } from '../../domain/kernel/KernelPort';
import type { ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import { t } from '../i18n';

export interface ModelFileSource {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * Builds a `ModelRecord` in `'error'` state after an open, stream, or Worker crash failure.
 * When `existing` is supplied (for an already-loaded model whose Worker crashed or a retry that
 * failed again), its metadata and federation settings are preserved.
 */
export function createFailedModelRecord(
  modelId: ModelId,
  source: { name: string; size: number },
  errorMessage: string,
  existing?: ModelRecord
): ModelRecord {
  const message = errorMessage.trim() || t('viewer.kernelStopped');
  if (existing) {
    return {
      ...existing,
      id: modelId,
      fileName: existing.fileName || source.name,
      fileSize: existing.fileSize || source.size,
      status: 'error',
      errorMessage: message
    };
  }
  return {
    id: modelId,
    fileName: source.name,
    fileSize: source.size,
    status: 'error',
    visible: false,
    units: 'unknown',
    elementCount: 0,
    meshCount: 0,
    errorMessage: message
  };
}

/**
 * Replaces an existing `ModelRecord` with the same `id` in place (preserving federation order),
 * or appends `next` when no record with `next.id` exists yet.
 */
export function upsertModelRecord(
  models: readonly ModelRecord[],
  next: ModelRecord
): ModelRecord[] {
  const index = models.findIndex((m) => m.id === next.id);
  if (index === -1) {
    return [...models, next];
  }
  return models.map((m, idx) => (idx === index ? next : m));
}

/**
 * Marks a loaded model as `'error'` with `errorMessage` when its Worker crashes after open.
 */
export function markModelCrashed(
  models: readonly ModelRecord[],
  modelId: ModelId,
  errorMessage: string
): ModelRecord[] {
  const message = errorMessage.trim() || t('viewer.kernelStopped');
  return models.map((m) =>
    m.id === modelId
      ? {
          ...m,
          status: 'error',
          errorMessage: message
        }
      : m
  );
}

/**
 * Whether a model card should offer the "Reintentar" action.
 */
export function canRetryModel(model: ModelRecord, hasSource: boolean): boolean {
  if (!hasSource) return false;
  return model.status === 'error' || Boolean(model.errorMessage);
}

/**
 * Whether a `KernelErrorCode` indicates that a model's Worker trapped or ran out of WASM memory.
 */
export function isFatalWorkerErrorCode(code: KernelErrorCode): boolean {
  return code === 'internal' || code === 'out-of-memory';
}
