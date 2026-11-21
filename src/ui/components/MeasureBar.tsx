import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Download, Trash2, X } from 'lucide-react';
import { getMeasureKinds, canClose, measurementText, type MeasureKind } from '../viewer/measure';
import type { MeasureController } from '../viewer/MeasureController';
import type { CsvGroupBy } from '../viewer/csvExport';
import { t } from '../i18n';

interface MeasureBarProps {
  controller: MeasureController;
  onExportCsv?: (groupBy: CsvGroupBy) => void;
  isExportingCsv?: boolean;
}

export const MeasureBar: React.FC<MeasureBarProps> = ({
  controller,
  onExportCsv,
  isExportingCsv = false
}) => {
  const { kind, draft, measurements } = useSyncExternalStore(controller.subscribe, controller.getState);
  const [groupBy, setGroupBy] = useState<CsvGroupBy>('class');
  const measureKinds = getMeasureKinds();
  const labels = Object.fromEntries(measureKinds.map(({ kind: k, label }) => [k, label])) as Record<
    MeasureKind,
    string
  >;
  const hint = measureKinds.find((item) => item.kind === kind)?.hint;

  // Escape starts the measurement in hand again; Enter closes an area.
  useEffect(() => {
    if (!kind) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Escape') controller.cancelDraft();
      if (event.key === 'Enter') controller.closeDraft();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, kind]);

  return (
    <div className="measure-bar">
      <div className="display-bar-row">
        <span className="display-bar-label">{t('measure.label')}</span>
        <select
          className="select measure-mode"
          value={kind ?? ''}
          onChange={(event) => controller.setKind((event.target.value || null) as MeasureKind | null)}
          title={t('measure.label')}
        >
          <option value="">{t('measure.noneOption')}</option>
          {measureKinds.map((item) => (
            <option key={item.kind} value={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
        {draft && canClose(draft) && (
          <button
            type="button"
            className="btn btn-ghost btn-icon measure-close"
            onClick={() => controller.closeDraft()}
            title={t('measure.closeAreaTitle')}
          >
            <Check size={14} />
          </button>
        )}
        {measurements.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-icon measure-clear"
            onClick={() => controller.clear()}
            title={t('measure.clearAllTitle')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {onExportCsv && (
        <div className="display-bar-row">
          <span className="display-bar-label">{t('measure.csvLabel')}</span>
          <select
            className="select csv-group-select"
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as CsvGroupBy)}
            title={t('measure.csvGroupTitle')}
          >
            <option value="class">{t('measure.csvByClass')}</option>
            <option value="storey">{t('measure.csvByStorey')}</option>
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-sm csv-export-btn"
            style={{ whiteSpace: 'nowrap' }}
            disabled={isExportingCsv}
            onClick={() => onExportCsv(groupBy)}
            title={t('measure.csvExportTitle')}
          >
            <Download size={12} />
            <span>{isExportingCsv ? t('measure.csvExporting') : t('measure.csvLabel')}</span>
          </button>
        </div>
      )}

      {hint && (
        <div className="display-bar-status measure-hint">
          {hint}
          {draft && draft.points.length > 0 && t('measure.draftHintSuffix', { count: draft.points.length })}
        </div>
      )}

      {measurements.length > 0 && (
        <ul className="measure-list">
          {measurements.map((measurement) => {
            const { value, detail } = measurementText(measurement);
            return (
              <li
                key={measurement.id}
                className="measure-result"
                data-kind={measurement.kind}
                data-id={measurement.id}
                title={detail}
              >
                <span className="measure-kind">{labels[measurement.kind]}</span>
                <span className="measure-value">{value}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon measure-delete"
                  onClick={() => controller.remove(measurement.id)}
                  title={t('measure.deleteOneTitle')}
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
