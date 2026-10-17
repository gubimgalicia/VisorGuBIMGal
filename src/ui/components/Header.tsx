import React, { useRef } from 'react';
import {
  Upload,
  Layers,
  MapPin,
  Box,
  Eye,
  FileDown,
  RefreshCw,
  Compass
} from 'lucide-react';
import { BimEngine } from '../../infrastructure/ifclite/BimEngine';

interface HeaderProps {
  onOpenFile: (file: File) => void;
  onLoadSample: (samplePath: string, name: string) => void;
  onSetPreset: (preset: 'iso' | 'top' | 'front' | 'side') => void;
  onFitView: () => void;
  isGisExpanded: boolean;
  onToggleGis: () => void;
  isWorking: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenFile,
  onLoadSample,
  onSetPreset,
  onFitView,
  isGisExpanded,
  onToggleGis,
  isWorking
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isWebGpu = BimEngine.isWebGpuSupported();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onOpenFile(file);
      e.target.value = '';
    }
  };

  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-icon">
          <Layers size={18} />
        </div>
        <div>
          <span className="brand-title">VisorGuBIMGal</span>
          <span style={{ margin: '0 8px', color: '#475569' }}>|</span>
          <span className="brand-badge">IFClite + GIS</span>
        </div>
      </div>

      <div className="header-actions">
        {/* WebGPU Status Indicator */}
        <span
          className={`status-badge ${isWebGpu ? 'ready' : 'error'}`}
          title={isWebGpu ? 'WebGPU disponible y activo' : 'WebGPU no disponible en este navegador'}
        >
          {isWebGpu ? '● WebGPU Activo' : '● Sin WebGPU'}
        </span>

        {/* View presets */}
        <div style={{ display: 'flex', gap: '2px', background: '#1e293b', padding: '2px', borderRadius: '6px' }}>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('iso')}
            title="Vista Isométrica 3D"
          >
            <Box size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('top')}
            title="Vista Superior / Planta"
          >
            <Compass size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('front')}
            title="Vista Frontal"
          >
            <Eye size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={onFitView}
            title="Encuadrar todo (Fit)"
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Sample models */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="btn btn-secondary"
            disabled={isWorking}
            onClick={() => onLoadSample('/samples/SimpleWall.ifc', 'SimpleWall (39 KB)')}
            title="Cargar modelo de prueba SimpleWall (39 KB)"
          >
            <span>SimpleWall</span>
          </button>
          <button
            className="btn btn-secondary"
            disabled={isWorking}
            onClick={() => onLoadSample('/samples/ManySimpleWalls.ifc', 'ManySimpleWalls (584 KB)')}
            title="Cargar modelo de prueba ManySimpleWalls (584 KB)"
          >
            <span>ManySimpleWalls</span>
          </button>
        </div>

        {/* Upload Button */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".ifc"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          className="btn btn-primary"
          disabled={isWorking}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={15} />
          <span>{isWorking ? 'Cargando…' : 'Abrir IFC'}</span>
        </button>

        {/* GIS Toggle */}
        <button
          className={`btn ${isGisExpanded ? 'btn-primary' : 'btn-secondary'}`}
          onClick={onToggleGis}
          title="Alternar panel GIS Leaflet"
        >
          <MapPin size={15} />
          <span>GIS 2D</span>
        </button>
      </div>
    </header>
  );
};
