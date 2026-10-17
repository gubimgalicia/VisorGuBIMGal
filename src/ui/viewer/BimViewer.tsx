import React, { useEffect, useRef, useState, type DragEvent } from 'react';
import { bimEngine } from '../../infrastructure/ifclite/BimEngine';
import { RefreshCw, Box, Compass, Eye, UploadCloud } from 'lucide-react';
import type { ModelId } from '../../domain/models/ModelRecord';

interface BimViewerProps {
  onOpenFile: (file: File) => void;
  onSelectElement: (modelId: ModelId | null, expressId: number | null) => void;
  statusText: string;
  isWorking: boolean;
}

export const BimViewer: React.FC<BimViewerProps> = ({
  onOpenFile,
  onSelectElement,
  statusText,
  isWorking
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    bimEngine.setHandlers({
      onSelectElement: (mId, eId) => onSelectElement(mId, eId)
    });

    bimEngine
      .initialize(canvasRef.current)
      .catch((err) => {
        console.error('Error initializing BimEngine:', err);
        setInitError(err instanceof Error ? err.message : 'Error al inicializar WebGPU');
      });

    return () => {
      bimEngine.destroy();
    };
  }, []);

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

      {/* Floating viewport controls */}
      <div className="viewport-overlay-toolbar">
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => bimEngine.setViewPreset('iso')}
          title="Vista Isométrica"
        >
          <Box size={15} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => bimEngine.setViewPreset('top')}
          title="Vista Planta (Superior)"
        >
          <Compass size={15} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => bimEngine.setViewPreset('front')}
          title="Vista Frontal"
        >
          <Eye size={15} />
        </button>
        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)' }} />
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => bimEngine.fitToView()}
          title="Encuadrar modelo"
        >
          <RefreshCw size={14} />
        </button>
      </div>

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
            Suelta el archivo IFC aquí
          </h3>
          <p style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
            Se procesará localmente en el navegador mediante WebAssembly
          </p>
        </div>
      )}

      {/* WebGPU Error Banner */}
      {initError && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid #ef4444',
            padding: '24px',
            borderRadius: '8px',
            maxWidth: '440px',
            textAlign: 'center',
            zIndex: 30
          }}
        >
          <h3 style={{ color: '#ef4444', fontSize: '16px', marginBottom: '8px' }}>
            Aviso de compatibilidad
          </h3>
          <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.5' }}>{initError}</p>
        </div>
      )}
    </div>
  );
};
