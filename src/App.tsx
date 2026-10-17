import React, { useState, useCallback } from 'react';
import { Header } from './ui/components/Header';
import { ModelsPanel } from './ui/components/ModelsPanel';
import { SpatialTreePanel } from './ui/components/SpatialTreePanel';
import { PropertiesPanel } from './ui/components/PropertiesPanel';
import { SectionDxfPanel } from './ui/components/SectionDxfPanel';
import { GisMapPanel } from './ui/components/GisMapPanel';
import { BimViewer } from './ui/viewer/BimViewer';

import type {
  ModelRecord,
  ModelId,
  SelectedElementDetails
} from './domain/models/ModelRecord';
import { ifcParserService } from './infrastructure/ifclite/IfcParserService';
import { bimEngine } from './infrastructure/ifclite/BimEngine';
import { leafletService } from './infrastructure/gis/LeafletService';

import { Layers, FolderTree, Sliders, Scissors } from 'lucide-react';

export default function App() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedElement, setSelectedElement] = useState<SelectedElementDetails | null>(null);
  const [statusText, setStatusText] = useState<string>('Listo. Abre un archivo IFC para comenzar.');
  const [isWorking, setIsWorking] = useState<boolean>(false);

  // Tab state
  const [leftTab, setLeftTab] = useState<'models' | 'tree'>('models');
  const [rightTab, setRightTab] = useState<'props' | 'dxf'>('props');
  const [isGisExpanded, setIsGisExpanded] = useState<boolean>(false);

  // Load IFC file handler (local File or static fetch)
  const loadIfcFile = useCallback(
    async (fileInput: File | { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }) => {
      const modelId: ModelId = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setIsWorking(true);
      setStatusText(`Cargando ${fileInput.name}...`);

      try {
        // 1. Parse IFC columnar store and metadata
        const { modelRecord } = await ifcParserService.parseModel(
          modelId,
          fileInput,
          (phase, pct) => {
            setStatusText(`${phase} (${pct}%)`);
          }
        );

        // 2. Stream geometry to WebGPU renderer
        setStatusText('Procesando geometría 3D en WebGPU...');
        const bytes = modelRecord.originalBytes!;
        const { meshCount, bounds } = await bimEngine.loadModelGeometry(
          modelId,
          bytes,
          (loadedMeshes) => {
            setStatusText(`Cargadas ${loadedMeshes} mallas 3D...`);
          }
        );

        const newModel: ModelRecord = {
          id: modelId,
          fileName: fileInput.name,
          fileSize: fileInput.size,
          schema: modelRecord.schema,
          status: 'ready',
          visible: true,
          units: modelRecord.units || 'm',
          elementCount: modelRecord.elementCount || 0,
          meshCount,
          coordinateReference: modelRecord.coordinateReference,
          bounds
        };

        setModels((prev) => [...prev, newModel]);
        setStatusText(`${fileInput.name} cargado con ${meshCount} mallas.`);
      } catch (err) {
        console.error('Error loading IFC:', err);
        setStatusText(`Error al cargar ${fileInput.name}: ${err instanceof Error ? err.message : 'Error'}`);
      } finally {
        setIsWorking(false);
      }
    },
    []
  );

  // Sample model loader
  const handleLoadSample = useCallback(
    async (sampleUrl: string, sampleName: string) => {
      try {
        setIsWorking(true);
        setStatusText(`Descargando muestra ${sampleName}...`);
        const resp = await fetch(sampleUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const file = new File([blob], sampleName.split(' ')[0] + '.ifc', { type: 'application/octet-stream' });
        await loadIfcFile(file);
      } catch (err) {
        console.error(err);
        setStatusText(`Error al descargar muestra: ${err instanceof Error ? err.message : 'Error'}`);
        setIsWorking(false);
      }
    },
    [loadIfcFile]
  );

  // Selection handler
  const handleSelectElement = useCallback(
    async (modelId: ModelId | null, expressId: number | null) => {
      bimEngine.setSelectedExpressId(expressId);

      if (!modelId || !expressId) {
        setSelectedElement(null);
        return;
      }

      const model = models.find((m) => m.id === modelId) || models[0];
      if (!model) return;

      const details = await ifcParserService.getElementDetails(
        model.id,
        model.fileName,
        expressId
      );

      setSelectedElement(details);
      setRightTab('props');
    },
    [models]
  );

  // Model visibility toggle
  const handleToggleVisibility = useCallback((id: ModelId) => {
    setModels((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const next = !m.visible;
          bimEngine.setModelVisibility(id, next);
          return { ...m, visible: next };
        }
        return m;
      })
    );
  }, []);

  // Remove model
  const handleRemoveModel = useCallback((id: ModelId) => {
    bimEngine.removeModel(id);
    ifcParserService.removeStore(id);
    setModels((prev) => prev.filter((m) => m.id !== id));
    setSelectedElement((prev) => (prev?.modelId === id ? null : prev));
  }, []);

  // Locate model on GIS map
  const handleLocateOnGis = useCallback((model: ModelRecord) => {
    setIsGisExpanded(true);
    if (model.coordinateReference?.latLng) {
      const [lat, lng] = model.coordinateReference.latLng;
      setTimeout(() => {
        leafletService.setCenter(lat, lng, 16);
      }, 100);
    }
  }, []);

  return (
    <div className="app-container">
      <Header
        onOpenFile={(file) => void loadIfcFile(file)}
        onLoadSample={handleLoadSample}
        onSetPreset={(p) => bimEngine.setViewPreset(p)}
        onFitView={() => bimEngine.fitToView()}
        isGisExpanded={isGisExpanded}
        onToggleGis={() => setIsGisExpanded((prev) => !prev)}
        isWorking={isWorking}
      />

      <div className="workspace">
        {/* Left Sidebar */}
        <aside className="panel sidebar-left">
          <div className="panel-tabs">
            <button
              className={`tab-btn ${leftTab === 'models' ? 'active' : ''}`}
              onClick={() => setLeftTab('models')}
            >
              <Layers size={13} />
              <span>Modelos</span>
            </button>
            <button
              className={`tab-btn ${leftTab === 'tree' ? 'active' : ''}`}
              onClick={() => setLeftTab('tree')}
            >
              <FolderTree size={13} />
              <span>Árbol espacial</span>
            </button>
          </div>

          <div className="panel-body">
            {leftTab === 'models' ? (
              <ModelsPanel
                models={models}
                onToggleVisibility={handleToggleVisibility}
                onRemoveModel={handleRemoveModel}
                onLocateOnGis={handleLocateOnGis}
              />
            ) : (
              <SpatialTreePanel
                models={models}
                onSelectElement={(mId, eId) => void handleSelectElement(mId, eId)}
                selectedExpressId={selectedElement?.expressId}
              />
            )}
          </div>
        </aside>

        {/* Center Viewport */}
        <main className="viewport-center">
          <BimViewer
            onOpenFile={(file) => void loadIfcFile(file)}
            onSelectElement={(mId, eId) => void handleSelectElement(mId, eId)}
            statusText={statusText}
            isWorking={isWorking}
          />

          {/* GIS Split Panel (Bottom) */}
          {isGisExpanded && (
            <GisMapPanel
              models={models}
              onClose={() => setIsGisExpanded(false)}
            />
          )}
        </main>

        {/* Right Sidebar */}
        <aside className="panel sidebar-right">
          <div className="panel-tabs">
            <button
              className={`tab-btn ${rightTab === 'props' ? 'active' : ''}`}
              onClick={() => setRightTab('props')}
            >
              <Sliders size={13} />
              <span>Propiedades</span>
            </button>
            <button
              className={`tab-btn ${rightTab === 'dxf' ? 'active' : ''}`}
              onClick={() => setRightTab('dxf')}
            >
              <Scissors size={13} />
              <span>Planos y DXF</span>
            </button>
          </div>

          <div className="panel-body">
            {rightTab === 'props' ? (
              <PropertiesPanel element={selectedElement} />
            ) : (
              <SectionDxfPanel models={models} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
