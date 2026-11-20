import React, { useRef, useState, useCallback } from 'react';
import { CheckCircle2, XCircle, MinusCircle, Upload, RefreshCw, Eye } from 'lucide-react';
import type { KernelPort, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ElementRef, ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import type { DisplayTarget } from '../viewer/displayRule';
import {
  evaluateIdsDocument,
  extractIdsCandidates,
  parseIdsXml,
  type IdsDocument,
  type IdsReport,
  type IdsSpecResult
} from '../viewer/idsChecker';
import { t } from '../i18n';

interface IdsPanelProps {
  models: ModelRecord[];
  spatialTrees: Record<ModelId, SpatialTree>;
  kernel: KernelPort;
  selectedRef: ElementRef | null;
  onSelectElement: (ref: ElementRef) => void;
  onIsolate: (target: DisplayTarget) => void;
}

export const IdsPanel: React.FC<IdsPanelProps> = ({
  models,
  spatialTrees,
  kernel,
  selectedRef,
  onSelectElement,
  onIsolate
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [idsDoc, setIdsDoc] = useState<IdsDocument | null>(null);
  const [idsFileName, setIdsFileName] = useState<string>('');
  const [report, setReport] = useState<IdsReport | null>(null);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const runEvaluation = useCallback(
    async (doc: IdsDocument) => {
      const visibleModels = models.filter((m) => m.visible && m.status === 'ready');
      const targetModels =
        visibleModels.length > 0 ? visibleModels : models.filter((m) => m.status === 'ready');
      setIsEvaluating(true);
      setErrorText(null);
      try {
        const candidates = targetModels.flatMap((model) =>
          extractIdsCandidates(model.id, model.fileName, spatialTrees[model.id])
        );
        for (const candidate of candidates) {
          candidate.details = await kernel.getElementDetails({
            modelId: candidate.modelId,
            expressId: candidate.expressId
          });
        }
        const evaluated = evaluateIdsDocument(doc, candidates);
        setReport(evaluated);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : t('ids.evalError'));
      } finally {
        setIsEvaluating(false);
      }
    },
    [models, spatialTrees, kernel]
  );

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const xmlText = await file.text();
        const doc = parseIdsXml(xmlText);
        if (doc.specifications.length === 0) {
          setErrorText(t('ids.emptySpecsError'));
          return;
        }
        setIdsFileName(file.name);
        setIdsDoc(doc);
        await runEvaluation(doc);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : t('ids.readError'));
      }
    },
    [runEvaluation]
  );

  const handleIsolateSpecFailures = (spec: IdsSpecResult) => {
    if (spec.failures.length === 0) return;
    const matches: Record<ModelId, number[]> = {};
    for (const f of spec.failures) {
      if (!matches[f.modelId]) matches[f.modelId] = [];
      matches[f.modelId].push(f.expressId);
    }
    onIsolate({ by: 'search', label: t('ids.isolateFailuresLabel', { name: spec.name }), matches });
  };

  return (
    <div className="ids-panel" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <input
        ref={fileInputRef}
        className="ids-file-input"
        type="file"
        accept=".ids,.xml"
        style={{ display: 'none' }}
        onChange={(e) => void handleFileChange(e)}
      />

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm ids-open-btn"
          style={{ flex: 1 }}
          disabled={isEvaluating}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={13} />
          <span>{idsFileName ? t('ids.changeFile') : t('ids.openFile')}</span>
        </button>
        {idsDoc && (
          <button
            type="button"
            className="btn btn-secondary btn-icon ids-revalidate-btn"
            disabled={isEvaluating}
            onClick={() => void runEvaluation(idsDoc)}
            title={t('ids.revalidateTitle')}
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      {errorText && (
        <div
          className="ids-error"
          style={{
            padding: '8px',
            borderRadius: '6px',
            backgroundColor: 'rgba(248, 113, 113, 0.12)',
            color: '#f87171',
            fontSize: '11px'
          }}
        >
          {errorText}
        </div>
      )}

      {!report && !errorText && (
        <div style={{ padding: '20px 10px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
          {t('ids.emptyBeforeExt')}
          <strong>{t('ids.emptyExt')}</strong>
          {t('ids.emptyAfterExt')}
        </div>
      )}

      {report && (
        <>
          <div
            className="ids-summary"
            style={{
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'rgba(30, 41, 59, 0.7)',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#f8fafc' }} className="ids-title">
              {report.title}
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{idsFileName}</div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px', fontSize: '11px' }}>
              <span className="ids-passed-count" style={{ color: '#4ade80', fontWeight: 600 }}>
                {t('ids.passedCount', { count: report.passedSpecs })}
              </span>
              <span className="ids-failed-count" style={{ color: '#f87171', fontWeight: 600 }}>
                {t('ids.failedCount', { count: report.failedSpecs })}
              </span>
              <span className="ids-na-count" style={{ color: '#94a3b8' }}>
                {t('ids.naCount', { count: report.notApplicableSpecs })}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {report.specifications.map((spec, idx) => (
              <div
                key={`${spec.name}-${idx}`}
                className="ids-spec-card"
                data-status={spec.status}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(15, 23, 42, 0.65)',
                  border: `1px solid ${
                    spec.status === 'pass'
                      ? 'rgba(74, 222, 128, 0.3)'
                      : spec.status === 'fail'
                        ? 'rgba(248, 113, 113, 0.35)'
                        : 'rgba(148, 163, 184, 0.2)'
                  }`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                    {spec.status === 'pass' && <CheckCircle2 size={14} color="#4ade80" />}
                    {spec.status === 'fail' && <XCircle size={14} color="#f87171" />}
                    {spec.status === 'not-applicable' && <MinusCircle size={14} color="#94a3b8" />}
                    <span
                      className="ids-spec-name"
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#e2e8f0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {spec.name}
                    </span>
                  </div>
                  <span style={{ fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    {t('ids.specRatio', { passed: spec.passedCount, applicable: spec.applicableCount })}
                  </span>
                </div>

                {spec.description && (
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                    {spec.description}
                  </div>
                )}

                {spec.cardinalityNote && (
                  <div style={{ fontSize: '11px', color: '#f87171', marginTop: '4px' }}>
                    {spec.cardinalityNote}
                  </div>
                )}

                {spec.failures.length > 0 && (
                  <div style={{ marginTop: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', color: '#f87171', fontWeight: 600 }}>
                        {t('ids.failuresCount', { count: spec.failures.length })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm ids-isolate-failures-btn"
                        style={{ padding: '2px 6px', fontSize: '10px' }}
                        onClick={() => handleIsolateSpecFailures(spec)}
                        title={t('ids.isolateFailuresTitle')}
                      >
                        <Eye size={11} />
                        <span>{t('ids.isolateFailuresBtn')}</span>
                      </button>
                    </div>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {spec.failures.slice(0, 50).map((f) => {
                        const isSelected =
                          selectedRef?.modelId === f.modelId && selectedRef?.expressId === f.expressId;
                        return (
                          <li
                            key={`${f.modelId}:${f.expressId}`}
                            className={`ids-failure-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => onSelectElement({ modelId: f.modelId, expressId: f.expressId })}
                            style={{
                              padding: '5px 7px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              backgroundColor: isSelected
                                ? 'rgba(56, 189, 248, 0.18)'
                                : 'rgba(30, 41, 59, 0.6)',
                              border: isSelected
                                ? '1px solid rgba(56, 189, 248, 0.5)'
                                : '1px solid rgba(255, 255, 255, 0.05)',
                              fontSize: '11px'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f1f5f9', fontWeight: 500 }}>
                              <span>{f.name}</span>
                              <span style={{ color: '#94a3b8', fontSize: '10px' }}>
                                {f.ifcClass} #{f.expressId}
                              </span>
                            </div>
                            {f.reasons.map((reason, rIdx) => (
                              <div key={rIdx} style={{ color: '#fca5a5', fontSize: '10px', marginTop: '2px' }}>
                                • {reason}
                              </div>
                            ))}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
