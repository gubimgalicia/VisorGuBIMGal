import React from 'react';
import { Eye, EyeOff, Trash2, Globe, Layers, AlertCircle } from 'lucide-react';
import type { ModelRecord, ModelId } from '../../domain/models/ModelRecord';

interface ModelsPanelProps {
  models: ModelRecord[];
  onToggleVisibility: (id: ModelId) => void;
  onRemoveModel: (id: ModelId) => void;
  onLocateOnGis: (model: ModelRecord) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({
  models,
  onToggleVisibility,
  onRemoveModel,
  onLocateOnGis
}) => {
  if (models.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b' }}>
        <Layers size={36} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
        <p style={{ fontSize: '13px', fontWeight: 500 }}>No hay modelos IFC cargados</p>
        <p style={{ fontSize: '11px', marginTop: '4px' }}>
          Arrastra un archivo IFC o pulsa "Abrir IFC" en la barra superior.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>
          Modelos federados ({models.length})
        </span>
      </div>

      {models.map((model) => (
        <div key={model.id} className="model-card">
          <div className="model-card-header">
            <span className="model-card-name" title={model.fileName}>
              {model.fileName}
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => onToggleVisibility(model.id)}
                title={model.visible ? 'Ocultar modelo' : 'Mostrar modelo'}
              >
                {model.visible ? <Eye size={14} color="#38bdf8" /> : <EyeOff size={14} color="#64748b" />}
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => onRemoveModel(model.id)}
                title="Retirar modelo de la federación"
              >
                <Trash2 size={14} color="#f87171" />
              </button>
            </div>
          </div>

          <div className="model-card-meta">
            <span className="meta-chip">{model.schema || 'IFC'}</span>
            <span className="meta-chip">{formatBytes(model.fileSize)}</span>
            <span>{model.elementCount} elem.</span>
          </div>

          {model.coordinateReference?.crsId && (
            <div
              style={{
                marginTop: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                color: '#38bdf8',
                cursor: 'pointer'
              }}
              onClick={() => onLocateOnGis(model)}
              title="Centrar en el mapa GIS"
            >
              <Globe size={12} />
              <span>{model.coordinateReference.crsId} (Ver en mapa)</span>
            </div>
          )}

          {model.errorMessage && (
            <div style={{ marginTop: '6px', display: 'flex', gap: '4px', color: '#f87171', fontSize: '11px' }}>
              <AlertCircle size={12} />
              <span>{model.errorMessage}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
