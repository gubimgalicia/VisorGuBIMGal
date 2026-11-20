import React from 'react';
import { Eye, EyeOff, Trash2, Globe, Layers, AlertCircle, RotateCcw } from 'lucide-react';
import type { ElementRef, ModelRecord, ModelId } from '../../domain/models/ModelRecord';
import { canRetryModel } from '../viewer/modelRetry';
import { ModelDiagnostics } from './ModelDiagnostics';
import { formatBytes, t } from '../i18n';

interface ModelsPanelProps {
  models: ModelRecord[];
  onToggleVisibility: (id: ModelId) => void;
  onRemoveModel: (id: ModelId) => void;
  onLocateOnGis: (model: ModelRecord) => void;
  onSelectElement: (ref: ElementRef) => void;
  onRetryModel?: (id: ModelId) => void;
  retryableModelIds?: ReadonlySet<ModelId>;
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({
  models,
  onToggleVisibility,
  onRemoveModel,
  onLocateOnGis,
  onSelectElement,
  onRetryModel,
  retryableModelIds
}) => {
  if (models.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b' }}>
        <Layers size={36} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
        <p style={{ fontSize: '13px', fontWeight: 500 }}>{t('models.emptyTitle')}</p>
        <p style={{ fontSize: '11px', marginTop: '4px' }}>
          {t('models.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>
          {t('models.federatedHeading', { count: models.length })}
        </span>
      </div>

      {models.map((model) => {
        const hasSource = retryableModelIds ? retryableModelIds.has(model.id) : true;
        const retryAvailable = Boolean(onRetryModel) && canRetryModel(model, hasSource);

        return (
          <div key={model.id} className="model-card" data-status={model.status}>
            <div className="model-card-header">
              <span className="model-card-name" title={model.fileName}>
                {model.fileName}
              </span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => onToggleVisibility(model.id)}
                  title={model.visible ? t('models.hideModelTitle') : t('models.showModelTitle')}
                >
                  {model.visible ? <Eye size={14} color="#38bdf8" /> : <EyeOff size={14} color="#64748b" />}
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => onRemoveModel(model.id)}
                  title={t('models.removeModelTitle')}
                >
                  <Trash2 size={14} color="#f87171" />
                </button>
              </div>
            </div>

            <div className="model-card-meta">
              <span className="meta-chip">{model.schema || t('models.schemaFallback')}</span>
              <span className="meta-chip">{formatBytes(model.fileSize)}</span>
              <span>{t('common.elementsAbbrev', { count: model.elementCount })}</span>
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
                title={t('models.locateOnGisTitle')}
              >
                <Globe size={12} />
                <span>{t('models.viewOnMap', { crsId: model.coordinateReference.crsId })}</span>
              </div>
            )}

            {(model.errorMessage || model.status === 'error') && (
              <div
                className="model-card-error"
                style={{
                  marginTop: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '6px',
                  color: '#f87171',
                  fontSize: '11px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0, flex: 1 }}>
                  <AlertCircle size={12} style={{ flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {model.errorMessage || t('models.kernelStoppedFallback')}
                  </span>
                </div>
                {retryAvailable && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm model-retry-btn"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() => onRetryModel?.(model.id)}
                    title={t('models.retryModelTitle')}
                  >
                    <RotateCcw size={12} />
                    <span>{t('common.retry')}</span>
                  </button>
                )}
              </div>
            )}

            {model.diagnostics && (
              <ModelDiagnostics
                modelId={model.id}
                diagnostics={model.diagnostics}
                onSelectElement={onSelectElement}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
