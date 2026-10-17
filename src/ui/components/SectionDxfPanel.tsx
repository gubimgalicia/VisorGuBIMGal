import React, { useState } from 'react';
import { Scissors, Download, FileCode, CheckCircle, RefreshCw } from 'lucide-react';
import type { DrawingCutType, SectionCutOptions } from '../../domain/drawings/DrawingTypes';
import { ifcDrawingService } from '../../infrastructure/ifclite/IfcDrawingService';
import { bimEngine } from '../../infrastructure/ifclite/BimEngine';
import type { ModelRecord } from '../../domain/models/ModelRecord';

interface SectionDxfPanelProps {
  models: ModelRecord[];
}

export const SectionDxfPanel: React.FC<SectionDxfPanelProps> = ({ models }) => {
  const [cutType, setCutType] = useState<DrawingCutType>('floorplan');
  const [position, setPosition] = useState<number>(1.2); // 1.2m typical floor cut
  const [includeHidden, setIncludeHidden] = useState<boolean>(true);
  const [includeHatching, setIncludeHatching] = useState<boolean>(true);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);

  const handleGenerate = async () => {
    const meshes = bimEngine.getModelMeshes();
    if (meshes.length === 0) {
      alert('No hay mallas IFC cargadas para generar el plano 2D.');
      return;
    }

    setIsGenerating(true);
    setStatusMessage('Calculando corte 2D...');

    try {
      const options: SectionCutOptions = {
        cutType,
        position,
        includeHiddenLines: includeHidden,
        includeProjection: true,
        includeEdges: true,
        mergeLines: true
      };

      const drawing = await ifcDrawingService.generateDrawing(meshes, options, (stage, pct) => {
        setStatusMessage(`${stage} (${pct}%)`);
      });

      // Generate SVG preview
      const svgRes = ifcDrawingService.exportDrawing(drawing, {
        format: 'svg',
        fileName: 'preview',
        units: 'm',
        showHiddenLines: includeHidden,
        showHatching: includeHatching
      });

      setPreviewSvg(svgRes.content);
      setStatusMessage('Plano 2D generado correctamente.');
    } catch (err) {
      console.error(err);
      setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = (format: 'dxf' | 'svg') => {
    try {
      const activeModel = models[0];
      const crs = activeModel?.coordinateReference?.crsId;
      const baseName = activeModel ? activeModel.fileName.replace(/\.ifc$/i, '') : 'plano-ifc';
      const fileName = `${baseName}-${cutType}`;

      const res = ifcDrawingService.exportDrawing(null, {
        format,
        fileName,
        crsComment: crs,
        units: 'm',
        showHiddenLines: includeHidden,
        showHatching: includeHatching
      });

      ifcDrawingService.downloadFile(res.content, res.mimeType, res.filename);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al exportar');
    }
  };

  return (
    <div style={{ fontSize: '13px' }}>
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
          TIPO DE DIBUJO 2D
        </label>
        <select
          className="select"
          style={{ width: '100%' }}
          value={cutType}
          onChange={(e) => setCutType(e.target.value as DrawingCutType)}
        >
          <option value="floorplan">Planta arquitectónica a cota (Z horizontal)</option>
          <option value="section-x">Sección vertical (Plano X)</option>
          <option value="section-z">Sección transversal (Plano Z)</option>
        </select>
      </div>

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
        className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', padding: '8px' }}
        disabled={isGenerating || models.length === 0}
        onClick={handleGenerate}
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
            style={{
              width: '100%',
              height: '180px',
              backgroundColor: '#090d16',
              border: '1px solid #334155',
              borderRadius: '6px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px'
            }}
            dangerouslySetInnerHTML={{ __html: previewSvg }}
          />

          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => handleExport('dxf')}
            >
              <Download size={14} />
              <span>Exportar DXF (R12)</span>
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => handleExport('svg')}
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
