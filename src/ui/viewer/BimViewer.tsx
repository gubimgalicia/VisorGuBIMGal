import React, { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { RefreshCw, Box, Compass, Eye, UploadCloud, Activity, Maximize2, Footprints } from 'lucide-react';
import { PerfMonitor } from '../components/PerfMonitor';
import { ViewCube } from '../components/ViewCube';
import type { ElementRef } from '../../domain/models/ModelRecord';
import type {
  CameraPose,
  CameraProjection,
  NavigationMode,
  RendererEventHandlers,
  RendererPort
} from '../../domain/kernel/RendererPort';
import { t } from '../i18n';

interface BimViewerProps {
  renderer: RendererPort;
  onOpenFile: (file: File) => void;
  onSelectElement: (ref: ElementRef | null) => void;
  onHoverElement?: (ref: ElementRef | null) => void;
  onInitError?: (message: string | null) => void;
  hasSelection?: boolean;
  onZoomToSelection?: () => void;
  /** Measure mode and frames, passed to the renderer as they are. */
  onPoint?: RendererEventHandlers['onPoint'];
  onPointerMove?: RendererEventHandlers['onPointerMove'];
  onFrame?: RendererEventHandlers['onFrame'];
  statusText: string;
  isWorking: boolean;
  /** Drawn over the canvas, in its coordinates. */
  children?: ReactNode;
}

export const BimViewer: React.FC<BimViewerProps> = ({
  renderer,
  onOpenFile,
  onSelectElement,
  onHoverElement,
  onInitError,
  hasSelection = false,
  onZoomToSelection,
  onPoint,
  onPointerMove,
  onFrame,
  statusText,
  isWorking,
  children
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [showPerfMonitor, setShowPerfMonitor] = useState(false);
  const [cameraPose, setCameraPose] = useState<CameraPose | null>(() => renderer.getCameraPose());
  const [projection, setProjection] = useState<CameraProjection>(() => renderer.getProjection());
  const [navMode, setNavMode] = useState<NavigationMode>(() => renderer.getNavigationMode());

  const handleFrame = useCallback(() => {
    const pose = renderer.getCameraPose();
    setCameraPose(pose);
    setProjection(renderer.getProjection());
    onFrame?.();
  }, [renderer, onFrame]);

  useEffect(() => {
    renderer.setHandlers({
      onSelect: (ref) => onSelectElement(ref),
      onHover: (ref) => onHoverElement?.(ref),
      onPoint,
      onPointerMove,
      onFrame: handleFrame
    });
  }, [renderer, onSelectElement, onHoverElement, onPoint, onPointerMove, handleFrame]);

  useEffect(() => {
    if (!canvasRef.current) return;

    renderer
      .initialize(canvasRef.current)
      .then(() => {
        setInitError(null);
        setCameraPose(renderer.getCameraPose());
        setProjection(renderer.getProjection());
        setNavMode(renderer.getNavigationMode());
        onInitError?.(null);
      })
      .catch((err) => {
        console.error('Error initializing renderer:', err);
        const msg = err instanceof Error ? err.message : t('viewer.initWebGpuError');
        setInitError(msg);
        onInitError?.(msg);
      });

    return () => {
      renderer.destroy();
    };
  }, [renderer, onInitError]);

  const handleToggleProjection = () => {
    const next: CameraProjection = projection === 'perspective' ? 'orthographic' : 'perspective';
    renderer.setProjection(next);
    setProjection(next);
  };

  const handleToggleNavMode = () => {
    const next: NavigationMode = navMode === 'orbit' ? 'first-person' : 'orbit';
    renderer.setNavigationMode(next);
    setNavMode(next);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.ifc')) {
      onOpenFile(file);
    }
  };

  return (
    <div
      className="canvas-container"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <canvas ref={canvasRef} className="bim-viewport" tabIndex={0} />
      {children}

      {/* Floating viewport controls */}
      <div className="viewport-overlay-toolbar">
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => renderer.setViewPreset('iso')}
          title={t('viewer.presetIsoTitle')}
        >
          <Box size={15} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => renderer.setViewPreset('top')}
          title={t('viewer.presetTopTitle')}
        >
          <Compass size={15} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => renderer.setViewPreset('front')}
          title={t('viewer.presetFrontTitle')}
        >
          <Eye size={15} />
        </button>
        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)' }} />
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => renderer.fitToView()}
          title={t('viewer.fitTitle')}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon nav-zoom-sel-btn"
          disabled={!hasSelection}
          onClick={() => onZoomToSelection?.()}
          title={t('viewer.zoomSelectionTitle')}
        >
          <Maximize2 size={14} />
        </button>
        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)' }} />
        <button
          className={`btn btn-ghost nav-proj-btn ${projection === 'orthographic' ? 'active' : ''}`}
          aria-pressed={projection === 'orthographic'}
          onClick={handleToggleProjection}
          title={t('viewer.toggleProjectionTitle')}
          style={{ fontSize: '11px', padding: '4px 8px', height: '26px' }}
        >
          {projection === 'orthographic' ? t('common.orthoShort') : t('common.perspShort')}
        </button>
        <button
          className={`btn btn-ghost nav-fp-btn ${navMode === 'first-person' ? 'active' : ''}`}
          aria-pressed={navMode === 'first-person'}
          onClick={handleToggleNavMode}
          title={t('viewer.toggleNavModeTitle')}
          style={{ fontSize: '11px', padding: '4px 8px', height: '26px', gap: '4px' }}
        >
          <Footprints size={13} />
          <span>{navMode === 'first-person' ? t('viewer.navFirstPerson') : t('viewer.navOrbit')}</span>
        </button>
        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)' }} />
        <button
          className={`btn btn-ghost btn-icon perf-toggle-btn ${showPerfMonitor ? 'active' : ''}`}
          aria-pressed={showPerfMonitor}
          onClick={() => setShowPerfMonitor((prev) => !prev)}
          title={t('viewer.perfMonitorTitle')}
        >
          <Activity size={14} />
        </button>
      </div>

      <ViewCube
        pose={cameraPose}
        onSelectPreset={(preset) => renderer.setViewPreset(preset)}
      />

      {showPerfMonitor && <PerfMonitor renderer={renderer} />}

      {/* Status toast */}
      {(statusText || isWorking) && (
        <div
          style={{
            position: 'absolute',
            bottom: '16px',
            left: '16px',
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            color: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 10
          }}
        >
          {isWorking && <RefreshCw size={13} className="spin" color="#38bdf8" />}
          <span>{statusText}</span>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragOver && (
        <div className="dropzone-overlay">
          <UploadCloud size={48} color="#38bdf8" style={{ marginBottom: '12px' }} />
          <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'white' }}>
            {t('viewer.dropTitle')}
          </h3>
          <p style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
            {t('viewer.dropSubtitle')}
          </p>
        </div>
      )}

      {/* Init Error Banner */}
      {initError && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid #ef4444',
            padding: '20px',
            borderRadius: '8px',
            color: '#f8fafc',
            maxWidth: '420px',
            textAlign: 'center',
            zIndex: 30
          }}
        >
          <h4 style={{ color: '#ef4444', marginBottom: '8px', fontWeight: 600 }}>
            {t('viewer.initErrorTitle')}
          </h4>
          <p style={{ fontSize: '12px', color: '#cbd5e1' }}>{initError}</p>
        </div>
      )}
    </div>
  );
};
