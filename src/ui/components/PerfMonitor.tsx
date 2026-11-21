import React, { useEffect, useRef, useState } from 'react';
import type { RendererPort } from '../../domain/kernel/RendererPort';
import { computeFps, formatPerfStats, type PerfDisplay } from '../viewer/perfMonitor';
import { t } from '../i18n';

interface PerfMonitorProps {
  renderer: RendererPort;
}

export const PerfMonitor: React.FC<PerfMonitorProps> = ({ renderer }) => {
  const [display, setDisplay] = useState<PerfDisplay>(() =>
    formatPerfStats(renderer.getDebugStats(), null)
  );
  const lastSampleRef = useRef<{ frames: number; time: number } | null>(null);

  useEffect(() => {
    const initial = renderer.getDebugStats();
    const now = performance.now();
    lastSampleRef.current = { frames: initial.renderCount, time: now };
    setDisplay(formatPerfStats(initial, 0));

    const timer = window.setInterval(() => {
      const stats = renderer.getDebugStats();
      const t = performance.now();
      const prev = lastSampleRef.current;
      const fps = prev ? computeFps(stats.renderCount - prev.frames, t - prev.time) : null;
      lastSampleRef.current = { frames: stats.renderCount, time: t };
      setDisplay(formatPerfStats(stats, fps));
    }, 250);

    return () => window.clearInterval(timer);
  }, [renderer]);

  return (
    <div className="perf-monitor-hud" aria-label={t('perf.ariaLabel')}>
      <div className="perf-monitor-title">{t('perf.title')}</div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.fpsLabel')}</span>
        <span className="perf-monitor-val perf-fps">{display.fps}</span>
      </div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.cpuLabel')}</span>
        <span className="perf-monitor-val perf-cpu">{display.frameCpu}</span>
      </div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.batchesLabel')}</span>
        <span className="perf-monitor-val perf-batches">{display.batches}</span>
      </div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.pickedLabel')}</span>
        <span className="perf-monitor-val perf-picked">{display.pickedBatches}</span>
      </div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.gpuMemoryLabel')}</span>
        <span className="perf-monitor-val perf-gpu">{display.gpuMemory}</span>
      </div>
      <div className="perf-monitor-row">
        <span className="perf-monitor-label">{t('perf.recordsModelsLabel')}</span>
        <span className="perf-monitor-val perf-records">
          {display.records} / {display.models}
        </span>
      </div>
    </div>
  );
};
