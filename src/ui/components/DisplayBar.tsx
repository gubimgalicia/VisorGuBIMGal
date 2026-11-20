import React, { useState } from 'react';
import { Focus, EyeOff, Ghost, Eye, Download, X, Map as MapIcon } from 'lucide-react';
import type { ElementRef } from '../../domain/models/ModelRecord';
import {
  describeTarget,
  type ClassCount,
  type DisplayRule,
  type DisplayTarget
} from '../viewer/displayRule';

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
          title="Clase IFC"
        >
          <option value="">Clase IFC…</option>
          {classes.map((item) => (
            <option key={item.type} value={item.type}>
              {item.type} ({item.count})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-isolate-class"
          disabled={!classTarget}
          onClick={() => classTarget && onIsolate(classTarget)}
          title="Aislar la clase"
        >
          <Focus size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-hide-class"
          disabled={!classTarget}
          onClick={() => classTarget && onHide(classTarget)}
          title="Ocultar la clase"
        >
          <EyeOff size={14} />
        </button>
      </div>

      <div className="display-bar-row">
        <span className="display-bar-label">Selección</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-isolate-selection"
          disabled={!selectionTarget}
          onClick={() => selectionTarget && onIsolate(selectionTarget)}
          title="Aislar la selección"
        >
          <Focus size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-hide-selection"
          disabled={!selectionTarget}
          onClick={() => selectionTarget && onHide(selectionTarget)}
          title="Ocultar la selección"
        >
          <EyeOff size={14} />
        </button>
        <div className="display-bar-separator" />
        <button
          type="button"
          className={`btn btn-ghost btn-icon display-ghost ${rule.ghost ? 'active' : ''}`}
          aria-pressed={rule.ghost}
          onClick={onToggleGhost}
          title="Modo fantasma: lo que queda fuera del aislamiento se ve translúcido"
        >
          <Ghost size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon display-show-all"
          disabled={!active}
          onClick={onShowAll}
          title="Mostrar todo"
        >
          <Eye size={14} />
        </button>
      </div>

      {onExportGlb && (
        <div className="display-bar-row">
          <span className="display-bar-label">
            {isExportingGlb && glbProgress
              ? `GLB (${glbProgress.completed}/${glbProgress.total})`
              : 'Escena 3D'}
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
              title="Cancelar exportación GLB"
            >
              <X size={12} />
              <span>Cancelar</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm gltf-export-btn"
              style={{ whiteSpace: 'nowrap' }}
              disabled={isExportingGlb}
              onClick={onExportGlb}
              title="Exportar la escena visible a glTF binario (.glb)"
            >
              <Download size={12} />
              <span>Exportar GLB</span>
            </button>
          )}
        </div>
      )}

      {active && (
        <div className="display-bar-status">
          {rule.isolate && <div>Aislado: {describeTarget(rule.isolate)}</div>}
          {rule.hidden.length > 0 && (
            <div>Oculto: {rule.hidden.map(describeTarget).join(', ')}</div>
          )}
        </div>
      )}
    </div>
  );
};
