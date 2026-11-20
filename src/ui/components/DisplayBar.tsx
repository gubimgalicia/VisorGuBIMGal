import React, { useState } from 'react';
import { Focus, EyeOff, Ghost, Eye, Download, X, Map as MapIcon } from 'lucide-react';
import type { ElementRef } from '../../domain/models/ModelRecord';
import {
  describeTarget,
  type ClassCount,
  type DisplayRule,
  type DisplayTarget
} from '../viewer/displayRule';
import { t } from '../i18n';

interface DisplayBarProps {
  classes: ClassCount[];
  rule: DisplayRule;
  selectedRef: ElementRef | null;
  onIsolate: (target: DisplayTarget) => void;
  onHide: (target: DisplayTarget) => void;
  onToggleGhost: () => void;
  onShowAll: () => void;
  onExportGlb?: () => void;
  onCancelGlb?: () => void;
  isExportingGlb?: boolean;
  glbProgress?: { completed: number; total: number } | null;
  /** The floor-plan minimap in the corner of the 3D view. Off by default. */
  showMinimap?: boolean;
  onToggleMinimap?: () => void;
}

export const DisplayBar: React.FC<DisplayBarProps> = ({
  classes,
  rule,
  selectedRef,
  onIsolate,
  onHide,
  onToggleGhost,
  onShowAll,
  onExportGlb,
  onCancelGlb,
  isExportingGlb = false,
  glbProgress = null,
  showMinimap = false,
  onToggleMinimap
}) => {
  const [chosenClass, setChosenClass] = useState('');
  const classType = classes.some((item) => item.type === chosenClass) ? chosenClass : '';
  const classTarget: DisplayTarget | null = classType ? { by: 'class', type: classType } : null;
  const selectionTarget: DisplayTarget | null = selectedRef ? { by: 'element', ref: selectedRef } : null;
  const active = rule.isolate !== null || rule.hidden.length > 0;

  return (
    <div className="display-bar">
      <div className="display-bar-row">
        <select
          className="select display-class"
          value={classType}
          onChange={(event) => setChosenClass(event.target.value)}
          title={t('display.classTitle')}
        >
          <option value="">{t('display.classPlaceholder')}</option>
          {classes.map((item) => (
            <option key={item.type} value={item.type}>
              {t('display.classOption', { type: item.type, count: item.count })}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-isolate-class"
          disabled={!classTarget}
          onClick={() => classTarget && onIsolate(classTarget)}
          title={t('display.isolateClassTitle')}
        >
          <Focus size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-hide-class"
          disabled={!classTarget}
          onClick={() => classTarget && onHide(classTarget)}
          title={t('display.hideClassTitle')}
        >
          <EyeOff size={14} />
        </button>
      </div>

      <div className="display-bar-row">
        <span className="display-bar-label">{t('display.selectionLabel')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-isolate-selection"
          disabled={!selectionTarget}
          onClick={() => selectionTarget && onIsolate(selectionTarget)}
          title={t('display.isolateSelectionTitle')}
        >
          <Focus size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-hide-selection"
          disabled={!selectionTarget}
          onClick={() => selectionTarget && onHide(selectionTarget)}
          title={t('display.hideSelectionTitle')}
        >
          <EyeOff size={14} />
        </button>
        <div className="display-bar-separator" />
        <button
          type="button"
          className={`btn btn-ghost btn-icon display-ghost ${rule.ghost ? 'active' : ''}`}
          aria-pressed={rule.ghost}
          onClick={onToggleGhost}
          title={t('display.ghostTitle')}
        >
          <Ghost size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-show-all"
          disabled={!active}
          onClick={onShowAll}
          title={t('display.showAllTitle')}
        >
          <Eye size={14} />
        </button>
      </div>

      {onExportGlb && (
        <div className="display-bar-row">
          <span className="display-bar-label">
            {isExportingGlb && glbProgress
              ? t('display.glbProgressLabel', {
                  completed: glbProgress.completed,
                  total: glbProgress.total
                })
              : t('display.scene3dLabel')}
          </span>
          {/* In this row, not a row of its own: the panel floats over the model, so it stays short. */}
          {onToggleMinimap && (
            <button
              type="button"
              className={`btn btn-ghost btn-icon minimap-toggle-btn ${showMinimap ? 'active' : ''}`}
              aria-pressed={showMinimap}
              onClick={onToggleMinimap}
              title="Minimapa de planta con la posición y la mirada de la cámara"
            >
              <MapIcon size={14} />
            </button>
          )}
          {isExportingGlb && onCancelGlb ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm gltf-cancel-btn"
              style={{ whiteSpace: 'nowrap' }}
              onClick={onCancelGlb}
              title={t('display.cancelGlbTitle')}
            >
              <X size={12} />
              <span>{t('common.cancel')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm gltf-export-btn"
              style={{ whiteSpace: 'nowrap' }}
              disabled={isExportingGlb}
              onClick={onExportGlb}
              title={t('display.exportGlbTitle')}
            >
              <Download size={12} />
              <span>{t('display.exportGlbLabel')}</span>
            </button>
          )}
        </div>
      )}

      {active && (
        <div className="display-bar-status">
          {rule.isolate && <div>{t('display.isolatedStatus', { target: describeTarget(rule.isolate) })}</div>}
          {rule.hidden.length > 0 && (
            <div>
              {t('display.hiddenStatus', {
                targets: rule.hidden.map(describeTarget).join(', ')
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
