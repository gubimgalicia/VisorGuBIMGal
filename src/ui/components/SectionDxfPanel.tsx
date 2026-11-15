import React, { useEffect, useRef, useState } from 'react';
import {
  Scissors,
  Download,
  FileCode,
  CheckCircle,
  RefreshCw,
  MousePointerClick,
  FlipVertical2
} from 'lucide-react';
import type { DrawingCut, DrawingOptions } from '../../domain/drawings/DrawingTypes';
import type {
  ExportedDrawing,
  GeneratedDrawing,
  KernelDiagnostic,
  KernelPort,
  SpatialTree
} from '../../domain/kernel/KernelPort';
import type { ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import { faceCutPlane, type SectionState } from '../viewer/section';
import { defaultPlanDepth } from '../viewer/planDepth';
import { widenForPreview } from './drawingPreview';

interface SectionDxfPanelProps {
  models: ModelRecord[];
  kernel: KernelPort;
  section: SectionState;
  onChangeSection: (next: SectionState) => void;
  isPickingFace?: boolean;
  onTogglePickFace?: (active?: boolean) => void;
  /** Spatial trees by model id: storey levels give a plan its default projection depth. */
  spatialTrees?: Record<string, SpatialTree | null | undefined>;
}

/**
 * 'auto': plans down to their storey (defaultPlanDepth), sections and face cuts without limit.
 * 'none': no limit. 'custom': the depth typed in the field.
 */
type DepthMode = 'auto' | 'none' | 'custom';

type CutPreset = 'plan' | 'section-x' | 'section-y' | 'face';

function downloadExportedDrawing(res: ExportedDrawing): void {
  const part: BlobPart =
    typeof res.content === 'string' ? res.content : new Uint8Array(res.content);
  const blob = new Blob([part], { type: res.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = res.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Diagnostics that mean a whole model is not in the drawing. */
const OMITS_MODEL = new Set([
  'drawing-model-lost',
  'map-frame-no-georeference',
  'map-frame-crs-mismatch',
  'bad-drawing-chunk'
]);

/** A drawing that lost lines must not read as a success. */
function drawingStatus(diagnostics: readonly KernelDiagnostic[]): string {
  const warnings = diagnostics.filter((item) => item.severity !== 'info');
  if (warnings.length === 0) return 'Plano 2D generado correctamente.';
  const summary = `Plano 2D generado con ${warnings.length} ${warnings.length === 1 ? 'aviso' : 'avisos'}.`;
  const incomplete = warnings.some(
    (item) => item.code === 'projection-truncated' || item.code === 'projection-skipped'
  );
  return incomplete
    ? `${summary} Faltan líneas proyectadas: indica una profundidad de proyección menor.`
    : summary;
}

export const SectionDxfPanel: React.FC<SectionDxfPanelProps> = ({
  models,
  kernel,
  section,
  onChangeSection,
  isPickingFace = false,
  onTogglePickFace,
  spatialTrees = {}
}) => {
  const [cutPreset, setCutPreset] = useState<CutPreset>('plan');
  const [position, setPosition] = useState<number>(1.2); // 1.2m typical floor cut
  const [depthStr, setDepthStr] = useState<string>(''); // Projection depth when depthMode is 'custom'
  const [depthMode, setDepthMode] = useState<DepthMode>('auto');
  const [includeHidden, setIncludeHidden] = useState<boolean>(true);
  const [includeHatching, setIncludeHatching] = useState<boolean>(true);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const [currentDrawing, setCurrentDrawing] = useState<GeneratedDrawing | null>(null);
  const [drawingModelIds, setDrawingModelIds] = useState<ModelId[]>([]);
  const [drawingFirstModelFileName, setDrawingFirstModelFileName] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Automatically switch preset to 'face' when the user picks a 3D face section
  useEffect(() => {
    if (section.mode === 'face' && section.face) {
      setCutPreset('face');
    }
  }, [section.mode, section.face]);

  // Discard drawing on unmount or when drawing changes
  useEffect(() => {
    return () => {
      if (currentDrawing) {
        void kernel.discardDrawing(currentDrawing.drawingId);
      }
    };
  }, [currentDrawing, kernel]);

  // When a model that a shown drawing came from is closed, clear preview, status, and discard drawing
  useEffect(() => {
    if (!currentDrawing || drawingModelIds.length === 0) return;
    const currentModelIds = new Set(models.map((m) => m.id));
    const anyClosed = drawingModelIds.some((id) => !currentModelIds.has(id));
    if (anyClosed) {
      void kernel.discardDrawing(currentDrawing.drawingId);
      setCurrentDrawing(null);
      setPreviewSvg(null);
      setStatusMessage('');
      setDrawingModelIds([]);
      setDrawingFirstModelFileName(null);
    }
  }, [models, currentDrawing, drawingModelIds, kernel]);

  const visibleTrees = models.filter((m) => m.visible).map((m) => spatialTrees[m.id]);
  const planDepth = defaultPlanDepth(position, visibleTrees.length ? visibleTrees : models.map((m) => spatialTrees[m.id]));

  const handleGenerate = async () => {
    const visibleIds = models.filter((m) => m.visible).map((m) => m.id);
    const modelIds = visibleIds.length > 0 ? visibleIds : models.map((m) => m.id);
    if (modelIds.length === 0) {
      alert('No hay mallas IFC cargadas para generar el plano 2D.');
      return;
    }

    setIsGenerating(true);
    setStatusMessage('Calculando corte 2D...');

    let generated: GeneratedDrawing | null = null;
    try {
      const parsedDepth = depthStr.trim() !== '' ? parseFloat(depthStr) : undefined;
      const typed =
        parsedDepth !== undefined && !Number.isNaN(parsedDepth) ? parsedDepth : undefined;
      const depth =
        depthMode === 'custom'
          ? typed
          : depthMode === 'auto' && cutPreset === 'plan'
            ? planDepth.depth
            : undefined;

      let cut: DrawingCut;
      if (cutPreset === 'face') {
        const resolvedFace = faceCutPlane(section);
        if (!resolvedFace) {
          setStatusMessage('Selecciona primero una cara del modelo 3D.');
          setIsGenerating(false);
          return;
        }
        cut = {
          kind: 'plane',
          origin: resolvedFace.origin,
          normal: resolvedFace.normal,
          ...(depth !== undefined ? { depth } : {})
        };
      } else if (cutPreset === 'plan') {
        cut = { kind: 'plan', elevation: position, ...(depth !== undefined ? { depth } : {}) };
      } else {
        cut = {
          kind: 'section',
          axis: cutPreset === 'section-x' ? 'x' : 'y',
          position,
          look: 'positive',
          ...(depth !== undefined ? { depth } : {})
        };
      }

      const options: DrawingOptions = {
        cut,
        frame: { kind: 'project' },
        includeProjection: true,
        includeHiddenLines: includeHidden,
        includeHatching
      };

      generated = await kernel.generateDrawing(modelIds, options, (stage, pct) => {
        if (mountedRef.current) {
          setStatusMessage(`${stage} (${pct}%)`);
        }
      });

      if (!mountedRef.current) {
        void kernel.discardDrawing(generated.drawingId);
        return;
      }

      const svgRes = await kernel.exportDrawing(generated.drawingId, {
        format: 'svg',
        fileName: 'preview',
        units: 'm',
        showHiddenLines: includeHidden,
        showHatching: includeHatching
      });

      if (!mountedRef.current) {
        void kernel.discardDrawing(generated.drawingId);
        return;
      }

      const svgText =
        typeof svgRes.content === 'string'
          ? svgRes.content
          : new TextDecoder().decode(svgRes.content);

      if (currentDrawing) {
        void kernel.discardDrawing(currentDrawing.drawingId);
      }

      // A model left out is not in this drawing, so closing it must not clear the drawing.
      const omitted = generated.diagnostics
        .filter((item) => OMITS_MODEL.has(item.code))
        .map((item) => item.modelId);
      const drawnIds = modelIds.filter((id) => !omitted.includes(id));
      const firstModel = models.find((m) => m.id === drawnIds[0]);
      setDrawingFirstModelFileName(firstModel ? firstModel.fileName : null);
      setDrawingModelIds(drawnIds);
      setCurrentDrawing(generated);
      setPreviewSvg(svgText);
      setStatusMessage(drawingStatus(generated.diagnostics));
    } catch (err) {
      if (generated && !mountedRef.current) {
        void kernel.discardDrawing(generated.drawingId);
      }
      if (mountedRef.current) {
        console.error(err);
        setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Error desconocido'}`);
      }
    } finally {
      if (mountedRef.current) {
        setIsGenerating(false);
      }
    }
  };

  const handleExport = async (format: 'dxf' | 'svg') => {
    if (!currentDrawing) {
      alert('No hay ningún dibujo 2D generado para exportar.');
      return;
    }
    try {
      const baseName = drawingFirstModelFileName
        ? drawingFirstModelFileName.replace(/\.ifc$/i, '')
        : 'plano-ifc';
      const fileName = `${baseName}-${cutPreset}`;

      const res = await kernel.exportDrawing(currentDrawing.drawingId, {
        format,
        fileName,
        crsComment: currentDrawing.crsId,
        units: 'm',
        showHiddenLines: includeHidden,
        showHatching: includeHatching
      });

      downloadExportedDrawing(res);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al exportar');
    }
  };

  const resolvedFace = faceCutPlane(section);

  return (
    <div style={{ fontSize: '13px' }}>
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
          TIPO DE DIBUJO 2D
        </label>
        <select
          className="select dxf-cut-preset"
          style={{ width: '100%' }}
          value={cutPreset}
          onChange={(e) => {
            const next = e.target.value as CutPreset;
            setCutPreset(next);
            if (next === 'face' && section.mode !== 'face') {
              onChangeSection({ ...section, mode: 'face' });
              if (!section.face) {
                onTogglePickFace?.(true);
              }
            }
          }}
        >
          <option value="plan">Planta arquitectónica a cota (Z horizontal)</option>
          <option value="section-x">Sección vertical (Eje X)</option>
          <option value="section-y">Sección transversal (Eje Y)</option>
          <option value="face">Corte por una cara (cualquier dirección)</option>
        </select>
      </div>

      {cutPreset !== 'face' ? (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
              POSICIÓN DE CORTE (metros)
            </label>
            <span style={{ fontFamily: 'var(--font-mono)', color: '#38bdf8' }}>{position.toFixed(2)} m</span>
          </div>
          <input
            type="number"
            step="0.1"
            className="select"
            style={{ width: '100%' }}
            value={position}
            onChange={(e) => setPosition(parseFloat(e.target.value) || 0)}
          />
        </div>
      ) : (
        <div style={{ marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              className={`btn btn-secondary dxf-pick-face-btn ${isPickingFace ? 'active' : ''}`}
              style={{ flex: 1, justifyContent: 'center', padding: '7px 10px' }}
              disabled={models.length === 0}
              onClick={() => onTogglePickFace?.(!isPickingFace)}
            >
              <MousePointerClick size={14} />
              <span>
                {isPickingFace
                  ? 'Haz clic sobre una cara 3D…'
                  : section.face
                    ? 'Elegir otra cara en 3D'
                    : 'Elegir cara en 3D'}
              </span>
            </button>
            {section.face && (
              <button
                type="button"
                className={`btn btn-secondary dxf-face-flip ${section.flip ? 'active' : ''}`}
                aria-pressed={section.flip}
                onClick={() =>
                  onChangeSection({
                    ...section,
                    mode: 'face',
                    flip: !section.flip
                  })
                }
                title="Invertir sentido del corte y de la mirada"
              >
                <FlipVertical2 size={14} />
                <span>Invertir</span>
              </button>
            )}
          </div>

          {section.face && resolvedFace ? (
            <>
              <div
                className="dxf-face-summary"
                style={{
                  padding: '6px 8px',
                  background: 'rgba(15, 23, 42, 0.5)',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: '#cbd5e1',
                  lineHeight: 1.4
                }}
              >
                <div>
                  Origen: ({resolvedFace.origin[0].toFixed(2)}, {resolvedFace.origin[1].toFixed(2)},{' '}
                  {resolvedFace.origin[2].toFixed(2)}) m
                </div>
                <div>
                  Mirada: ({resolvedFace.normal[0].toFixed(3)}, {resolvedFace.normal[1].toFixed(3)},{' '}
                  {resolvedFace.normal[2].toFixed(3)})
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
                    Desplazamiento desde la cara (m)
                  </label>
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#38bdf8' }}>
                    {section.face.offset.toFixed(2)} m
                  </span>
                </div>
                <input
                  type="number"
                  step="0.1"
                  className="select dxf-face-offset"
                  style={{ width: '100%' }}
                  value={section.face.offset}
                  onChange={(e) => {
                    const nextOffset = parseFloat(e.target.value);
                    onChangeSection({
                      ...section,
                      mode: 'face',
                      face: {
                        ...section.face!,
                        offset: Number.isFinite(nextOffset) ? nextOffset : 0
                      }
                    });
                  }}
                />
              </div>
            </>
          ) : (
            <div
              style={{
                padding: '6px 8px',
                background: 'rgba(15, 23, 42, 0.5)',
                borderRadius: '4px',
                fontSize: '11px',
                color: '#94a3b8'
              }}
            >
              Pulsa «Elegir cara en 3D» y haz clic sobre cualquier cara del modelo para cortar en su plano.
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
          Profundidad de proyección
        </label>
        <select
          className="select dxf-depth-mode"
          style={{ width: '100%', marginBottom: depthMode === 'custom' ? '6px' : 0 }}
          value={depthMode}
          onChange={(e) => setDepthMode(e.target.value as DepthMode)}
        >
          <option value="auto">{cutPreset === 'plan' ? 'Hasta la planta (automática)' : 'Sin límite (automática)'}</option>
          <option value="none">Sin límite</option>
          <option value="custom">Personalizada</option>
        </select>
        {depthMode === 'custom' && (
          <input
            type="number"
            step="0.1"
            min="0"
            placeholder="Metros desde el corte"
            className="select dxf-depth"
            style={{ width: '100%' }}
            value={depthStr}
            onChange={(e) => setDepthStr(e.target.value)}
          />
        )}
        {depthMode === 'auto' && cutPreset === 'plan' && (
          <div className="dxf-depth-hint" style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
            {planDepth.storey
              ? `${planDepth.depth.toFixed(2)} m, hasta «${planDepth.storey.name}» (${planDepth.storey.level.toFixed(2)} m)`
              : `${planDepth.depth.toFixed(2)} m: no hay ninguna planta bajo el corte`}
          </div>
        )}
      </div>

      <div style={{ marginBottom: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#cbd5e1' }}>
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={(e) => setIncludeHidden(e.target.checked)}
          />
          <span>Incluir líneas ocultas (trazos discontinuos)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#cbd5e1' }}>
          <input
            type="checkbox"
            checked={includeHatching}
            onChange={(e) => setIncludeHatching(e.target.checked)}
          />
          <span>Generar sombreados / tramas de materiales</span>
        </label>
      </div>

      <button
        className="btn btn-primary dxf-generate-btn"
        style={{ width: '100%', justifyContent: 'center', padding: '8px' }}
        disabled={isGenerating || models.length === 0 || (cutPreset === 'face' && !resolvedFace)}
        onClick={() => void handleGenerate()}
      >
        {isGenerating ? <RefreshCw size={15} className="spin" /> : <Scissors size={15} />}
        <span>{isGenerating ? 'Generando plano...' : 'Generar plano 2D'}</span>
      </button>

      {statusMessage && (
        <div
          style={{
            marginTop: '10px',
            padding: '8px',
            background: 'rgba(15, 23, 42, 0.5)',
            borderRadius: '4px',
            fontSize: '11px',
            color: '#94a3b8',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <CheckCircle size={13} color="#38bdf8" />
          <span>{statusMessage}</span>
        </div>
      )}

      {/* SVG Preview container */}
      {previewSvg && (
        <div style={{ marginTop: '14px' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '6px', fontWeight: 600 }}>
            VISTA PREVIA 2D
          </div>
          <div
            className="drawing-preview"
            style={{
              width: '100%',
              height: '180px',
              backgroundColor: '#ffffff',
              border: '1px solid #334155',
              borderRadius: '6px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px'
            }}
            dangerouslySetInnerHTML={{ __html: widenForPreview(previewSvg) }}
          />

          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => void handleExport('dxf')}
            >
              <Download size={14} />
              <span>Exportar DXF (R12)</span>
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => void handleExport('svg')}
            >
              <FileCode size={14} />
              <span>Exportar SVG</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
