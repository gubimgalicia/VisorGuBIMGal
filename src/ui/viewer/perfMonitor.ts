import type { RendererDebugStats } from '../../domain/kernel/RendererPort';
import { formatBytes, formatFixed, t } from '../i18n';

export interface PerfDisplay {
  frameCpu: string;
  fps: string;
  batches: string;
  pickedBatches: string;
  records: string;
  gpuMemory: string;
  models: string;
  frames: string;
}

export function formatGpuBytes(bytes: number): string {
  return formatBytes(bytes, { minimumFractionDigits: 1 });
}

export function computeFps(deltaFrames: number, deltaTimeMs: number): number | null {
  if (
    !Number.isFinite(deltaFrames) ||
    !Number.isFinite(deltaTimeMs) ||
    deltaFrames < 0 ||
    deltaTimeMs <= 0
  ) {
    return null;
  }
  if (deltaFrames === 0) return 0;
  return Math.round((deltaFrames * 1000) / deltaTimeMs);
}

export function formatPerfStats(stats: RendererDebugStats, fps: number | null = null): PerfDisplay {
  const cpuMs = Number.isFinite(stats.lastFrameCpuMs) ? Math.max(0, stats.lastFrameCpuMs) : 0;
  return {
    frameCpu: `${formatFixed(cpuMs, 2)} ms`,
    fps: fps === null ? t('perf.fpsDash') : fps === 0 ? t('perf.fpsIdle') : t('perf.fpsValue', { fps }),
    batches: `${stats.drawnBatches} / ${stats.batchCount}`,
    pickedBatches: `${stats.pickedBatches} / ${stats.batchCount}`,
    records: String(stats.recordCount),
    gpuMemory: t('perf.gpuMemoryValue', {
      size: formatGpuBytes(stats.allocatedGpuBytes),
      buffers: stats.liveGpuBuffers
    }),
    models: String(stats.modelCount),
    frames: String(stats.renderCount)
  };
}
