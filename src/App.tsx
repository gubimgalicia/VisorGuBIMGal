import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Header } from './ui/components/Header';
import { ModelsPanel } from './ui/components/ModelsPanel';
import { SpatialTreePanel } from './ui/components/SpatialTreePanel';
import { PropertiesPanel } from './ui/components/PropertiesPanel';
import { SectionDxfPanel } from './ui/components/SectionDxfPanel';
import { GisMapPanel } from './ui/components/GisMapPanel';
import { DisplayBar } from './ui/components/DisplayBar';
import { SectionBar } from './ui/components/SectionBar';
import { SearchPanel } from './ui/components/SearchPanel';
import { IdsPanel } from './ui/components/IdsPanel';
import { MeasureBar } from './ui/components/MeasureBar';
import { SavedViewsBar } from './ui/components/SavedViewsBar';
import { ColorByBar } from './ui/components/ColorByBar';
import {
  buildColorScheme,
  collectAvailablePropertyNames,
  type ColorByMode,
  type ColorLegendItem,
  type ColorableElement
} from './ui/viewer/colorByProperty';
import { parseModelUrlParam } from './ui/viewer/urlModel';
import {
  createFailedModelRecord,
  markModelCrashed,
  upsertModelRecord,
  type ModelFileSource
} from './ui/viewer/modelRetry';
import {
  buildMedicionesCsv,
  extractSpatialElements,
  resolveElementQuantities,
  type CsvGroupBy,
  type ElementQuantityRow
} from './ui/viewer/csvExport';
import { applySavedView, captureSavedView, savedViewWithoutModel, type SavedView } from './ui/viewer/savedViews';
import { MeasureOverlay } from './ui/components/MeasureOverlay';
import { MeasureController } from './ui/viewer/MeasureController';
import { NO_SECTION, sceneBounds, sectionPlanes, type SectionState } from './ui/viewer/section';
import { BimViewer } from './ui/viewer/BimViewer';
import { computeElementMeshBounds } from './infrastructure/renderer/Camera';
import {
  SHOW_ALL,
  classCounts,
  modelDisplay,
  sameTarget,
  withoutModel,
  type DisplayRule,
  type DisplayTarget
} from './ui/viewer/displayRule';

import type {
  ElementRef,
  ModelBounds,
  ModelId,
  ModelRecord,
  SelectedElementDetails
} from './domain/models/ModelRecord';
import type { KernelDiagnostic, SpatialTree } from './domain/kernel/KernelPort';
import { kernel, renderer } from './infrastructure/composition';
import { leafletService } from './infrastructure/gis/LeafletService';

import { Layers, FolderTree, Sliders, Scissors, Search, ShieldCheck } from 'lucide-react';

export default function App() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [spatialTrees, setSpatialTrees] = useState<Record<ModelId, SpatialTree>>({});
  const [selectedRef, setSelectedRef] = useState<ElementRef | null>(null);
  const [, setHoveredRef] = useState<ElementRef | null>(null);
  const [selectedElement, setSelectedElement] = useState<SelectedElementDetails | null>(null);
  const [statusText, setStatusText] = useState<string>('Listo. Abre un archivo IFC para comenzar.');
  const [isWorking, setIsWorking] = useState<boolean>(false);
  const [, setRendererError] = useState<string | null>(null);
  const [activeBackend, setActiveBackend] = useState<'webgpu' | 'webgl2' | null>(null);
  const [displayRule, setDisplayRule] = useState<DisplayRule>(SHOW_ALL);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [nextSavedViewIndex, setNextSavedViewIndex] = useState<number>(1);
  const [isExportingCsv, setIsExportingCsv] = useState<boolean>(false);
  const [colorByMode, setColorByMode] = useState<ColorByMode>('none');
  const [colorByPropName, setColorByPropName] = useState<string>('Name');
  const [colorLegend, setColorLegend] = useState<ColorLegendItem[]>([]);
  const [availableColorProps, setAvailableColorProps] = useState<string[]>([]);

  // Every model follows the display rule, including one loaded after the rule was set
  useEffect(() => {
    for (const model of models) {
      const { others, entries } = modelDisplay(displayRule, model.id, spatialTrees[model.id]);
      renderer.setElementDisplay(model.id, others, entries);
    }
  }, [displayRule, models, spatialTrees]);

  const ifcClasses = useMemo(() => classCounts(Object.values(spatialTrees)), [spatialTrees]);

  const measure = useMemo(() => new MeasureController(renderer, kernel), []);

  const [section, setSection] = useState<SectionState>(NO_SECTION);
  const bounds = useMemo(() => sceneBounds(models), [models]);
  useEffect(() => {
    const planes = sectionPlanes(section, bounds);
    renderer.setSectionPlanes(planes);
    measure.setPlanes(planes);
  }, [section, bounds, measure]);

  // With no model left there is nothing to measure on
  useEffect(() => {
    if (models.length === 0) {
      measure.setKind(null);
      measure.clear();
      setSavedViews([]);
      setNextSavedViewIndex(1);
      setColorByMode('none');
      setColorLegend([]);
    }
  }, [models.length, measure]);

  useEffect(() => {
    let cancelled = false;
    if (colorByMode === 'none' || models.length === 0) {
      setColorLegend([]);
      for (const m of models) {
        renderer.setElementColors(m.id, new Map());
      }
      return;
    }
    void (async () => {
      const readyModels = models.filter((m) => m.status === 'ready');
      const elements: ColorableElement[] = readyModels.flatMap((m) =>
        extractSpatialElements(m.id, m.fileName, spatialTrees[m.id])
      );
      if (colorByMode === 'material' || colorByMode === 'property') {
        for (const el of elements) {
          if (cancelled) return;
          el.details = await kernel.getElementDetails({ modelId: el.modelId, expressId: el.expressId });
        }
        if (!cancelled) {
          setAvailableColorProps(collectAvailablePropertyNames(elements));
        }
      }
      if (cancelled) return;
      const scheme = buildColorScheme(elements, colorByMode, colorByPropName);
      setColorLegend(scheme.legend);
      for (const m of models) {
        renderer.setElementColors(m.id, scheme.colorsByModel.get(m.id) ?? new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [colorByMode, colorByPropName, models, spatialTrees]);

  const handleIsolate = useCallback((target: DisplayTarget) => {
    setDisplayRule((prev) => ({ ...prev, isolate: target }));
  }, []);

  const handleHide = useCallback((target: DisplayTarget) => {
    setDisplayRule((prev) =>
      prev.hidden.some((hidden) => sameTarget(hidden, target))
        ? prev
        : { ...prev, hidden: [...prev.hidden, target] }
    );
  }, []);

  // Subscribe to renderer backend changes
  useEffect(() => {
    const stop = renderer.onBackendChange(setActiveBackend);
    return () => void stop();
  }, []);

  // Keep lightweight File/Blob handles by modelId so a model whose Worker crashes can be retried
  const modelSourcesRef = useRef<Map<ModelId, ModelFileSource>>(new Map());

  // Subscribe to model Worker crashes and expose kernel for E2E crash recovery tests
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__gubim_kernel__ = kernel;
    }
    const stop = kernel.onModelCrash?.((modelId, error) => {
      setModels((prev) => markModelCrashed(prev, modelId, error.message));
      setStatusText(error.message);
    });
    return () => void stop?.();
  }, []);

  // Tab state
  const [leftTab, setLeftTab] = useState<'models' | 'tree' | 'search'>('models');
  const [rightTab, setRightTab] = useState<'props' | 'dxf' | 'ids'>('props');
  const [isGisExpanded, setIsGisExpanded] = useState<boolean>(false);

  // Load IFC file handler (local File, static fetch, or retry of an existing modelId)
  const loadIfcFile = useCallback(
    async (fileInput: ModelFileSource, existingModelId?: ModelId) => {
      const modelId: ModelId =
        existingModelId ?? `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      modelSourcesRef.current.set(modelId, fileInput);
      let opened = false;
      setIsWorking(true);
      setStatusText(`Cargando ${fileInput.name}...`);

      try {
        if (existingModelId) {
          renderer.removeModel(modelId);
          try {
            await kernel.closeModel(modelId);
          } catch {
            // ignore close error
          }
        }

        const buffer = await fileInput.arrayBuffer();

        // 1. Open model in kernel
        const summary = await kernel.openModel(modelId, buffer, (phase, pct) => {
          setStatusText(`${phase} (${pct}%)`);
        });
        opened = true;

        // 2. Stream geometry from kernel to renderer
        setStatusText(`Procesando geometría 3D (${activeBackend === 'webgl2' ? 'WebGL2' : 'WebGPU'})...`);
        renderer.addModel(modelId);

        let meshCount = 0;
        let bounds: ModelBounds | undefined;
        let streamDiagnostics: KernelDiagnostic[] = [];
        let completed = false;

        for await (const event of kernel.streamGeometry(modelId)) {
          if (event.type === 'batch') {
            renderer.addBatch(event.batch);
          } else if (event.type === 'progress') {
            setStatusText(`Cargadas ${event.processedElements} mallas 3D...`);
          } else if (event.type === 'complete') {
            completed = true;
            meshCount = event.meshCount;
            bounds = event.bounds;
            streamDiagnostics = event.diagnostics;
          }
        }

        if (!completed) {
          renderer.removeModel(modelId);
          return;
        }

        renderer.finishModel(modelId, bounds);

        // 3. Load spatial tree for the model
        const tree = await kernel.getSpatialTree(modelId);
        if (tree) {
          setSpatialTrees((prev) => ({ ...prev, [modelId]: tree }));
        }

        const units: 'm' | 'mm' = summary.lengthUnitScale < 0.01 ? 'mm' : 'm';
        const newModel: ModelRecord = {
          id: modelId,
          fileName: fileInput.name,
          fileSize: fileInput.size,
          schema: summary.schemaIdentifier || summary.schema,
          status: 'ready',
          visible: true,
          units,
          elementCount: summary.elementCount,
          meshCount,
          coordinateReference: summary.coordinateReference,
          bounds,
          diagnostics: [...summary.diagnostics, ...streamDiagnostics],
          errorMessage: undefined
        };

        setModels((prev) => upsertModelRecord(prev, newModel));
        setStatusText(`${fileInput.name} cargado con ${meshCount} mallas.`);
      } catch (err) {
        if (opened) {
          renderer.removeModel(modelId);
          try {
            await kernel.closeModel(modelId);
          } catch {
            // ignore close error
          }
        }
        const message = err instanceof Error ? err.message : 'Error';
        console.error('Error loading IFC:', err);
        setModels((prev) => {
          const existing = prev.find((m) => m.id === modelId);
          const failed = createFailedModelRecord(modelId, fileInput, message, existing);
          return upsertModelRecord(prev, failed);
        });
        setStatusText(`Error al cargar ${fileInput.name}: ${message}`);
      } finally {
        setIsWorking(false);
      }
    },
    [activeBackend]
  );

  const handleRetryModel = useCallback(
    (modelId: ModelId) => {
      const source = modelSourcesRef.current.get(modelId);
      if (!source) return;
      void loadIfcFile(source, modelId);
    },
    [loadIfcFile]
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

  // Load public model from ?model= or ?ifc= URL parameter once renderer is ready
  const urlModelLoadedRef = useRef(false);
  useEffect(() => {
    if (!activeBackend || urlModelLoadedRef.current || typeof window === 'undefined') return;
    const target = parseModelUrlParam(window.location.search, window.location.href);
    if (!target) return;
    urlModelLoadedRef.current = true;
    void (async () => {
      try {
        setIsWorking(true);
        setStatusText(`Descargando ${target.fileName}...`);
        const resp = await fetch(target.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const file = new File([blob], target.fileName, { type: 'application/octet-stream' });
        await loadIfcFile(file);
      } catch (err) {
        console.error(err);
        setStatusText(
          `Error al descargar ${target.fileName}: ${err instanceof Error ? err.message : 'Error'}`
        );
        setIsWorking(false);
      }
    })();
  }, [activeBackend, loadIfcFile]);

  // Selection handler keyed by ElementRef
  const handleSelectElement = useCallback(
    async (ref: ElementRef | null, keepRightTab = false) => {
      setSelectedRef(ref);
      renderer.setSelection(ref);

      if (!ref) {
        setSelectedElement(null);
        return;
      }

      const model = models.find((m) => m.id === ref.modelId) || models[0];
      if (!model) return;

      const resolvedRef: ElementRef = { modelId: model.id, expressId: ref.expressId, globalId: ref.globalId };
      const details = await kernel.getElementDetails(resolvedRef);

      setSelectedElement(details ? { ...details, modelName: model.fileName } : null);
      if (!keepRightTab) {
        setRightTab('props');
      }
    },
    [models]
  );

  // Model visibility toggle
  const handleToggleVisibility = useCallback((id: ModelId) => {
    setModels((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const next = !m.visible;
          renderer.setModelVisibility(id, next);
          return { ...m, visible: next };
        }
        return m;
      })
    );
  }, []);

  // Remove model
  const handleRemoveModel = useCallback((id: ModelId) => {
    modelSourcesRef.current.delete(id);
    renderer.removeModel(id);
    void kernel.closeModel(id);
    setModels((prev) => prev.filter((m) => m.id !== id));
    setSpatialTrees((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedRef((prev) => {
      if (prev?.modelId === id) {
        renderer.setSelection(null);
        return null;
      }
      return prev;
    });
    setSelectedElement((prev) => (prev?.modelId === id ? null : prev));
    setDisplayRule((prev) => withoutModel(prev, id));
    setSavedViews((prev) => prev.map((view) => savedViewWithoutModel(view, id)));
    measure.forgetModel(id);
  }, [measure]);

  const handleSaveView = useCallback(
    (name: string) => {
      const camera = renderer.getCameraPose();
      if (!camera) return;
      const view = captureSavedView({
        id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        index: nextSavedViewIndex,
        camera,
        models,
        displayRule,
        section,
        selectedRef
      });
      setSavedViews((prev) => [...prev, view]);
      setNextSavedViewIndex((prev) => prev + 1);
    },
    [nextSavedViewIndex, models, displayRule, section, selectedRef]
  );

  const handleApplySavedView = useCallback(
    (view: SavedView) => {
      const applied = applySavedView(view, models);
      renderer.setCameraPose(applied.camera);
      setModels((prev) =>
        prev.map((model) => {
          const nextVisible = applied.modelVisibilities.get(model.id) ?? model.visible;
          if (nextVisible !== model.visible) {
            renderer.setModelVisibility(model.id, nextVisible);
          }
          return nextVisible === model.visible ? model : { ...model, visible: nextVisible };
        })
      );
      setDisplayRule(applied.displayRule);
      setSection(applied.section);
      void handleSelectElement(applied.selectedRef);
    },
    [models, handleSelectElement]
  );

  const handleDeleteSavedView = useCallback((id: string) => {
    setSavedViews((prev) => prev.filter((view) => view.id !== id));
  }, []);

  const handleExportCsv = useCallback(
    async (groupBy: CsvGroupBy) => {
      const visibleModels = models.filter((m) => m.visible);
      const targetModels = visibleModels.length > 0 ? visibleModels : models;
      if (targetModels.length === 0) return;

      setIsExportingCsv(true);
      setStatusText('Calculando mediciones para exportar CSV...');
      try {
        const entries = targetModels.flatMap((model) =>
          extractSpatialElements(model.id, model.fileName, spatialTrees[model.id])
        );
        const rows: ElementQuantityRow[] = [];
        for (const entry of entries) {
          const ref: ElementRef = { modelId: entry.modelId, expressId: entry.expressId };
          const [details, mesh] = await Promise.all([
            kernel.getElementDetails(ref),
            kernel.elementMesh(entry.modelId, entry.expressId)
          ]);
          const q = resolveElementQuantities(details, mesh);
          rows.push({ ...entry, ...q });
        }

        const csv = buildMedicionesCsv(rows, groupBy);
        const filename = `mediciones-por-${groupBy === 'class' ? 'clase' : 'planta'}.csv`;
        if (typeof window !== 'undefined') {
          (window as unknown as Record<string, unknown>).__gubim_last_csv__ = {
            filename,
            content: csv,
            groupBy,
            rowCount: rows.length
          };
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }
        setStatusText(`Mediciones exportadas a ${filename} (${rows.length} elementos).`);
      } catch (err) {
        console.error('Error exporting CSV:', err);
        setStatusText(
          `Error al exportar CSV: ${err instanceof Error ? err.message : 'Error'}`
        );
      } finally {
        setIsExportingCsv(false);
      }
    },
    [models, spatialTrees]
  );

  const handleZoomToSelection = useCallback(async () => {
    if (!selectedRef) return;
    try {
      const mesh = await kernel.elementMesh(selectedRef.modelId, selectedRef.expressId);
      const elemBounds = mesh ? computeElementMeshBounds(mesh.positions) : null;
      if (elemBounds) {
        renderer.fitToBounds(elemBounds, true);
      }
    } catch (err) {
      console.error('Error al encuadrar elemento seleccionado:', err);
    }
  }, [selectedRef]);

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
        onSetPreset={(p) => renderer.setViewPreset(p)}
        onFitView={() => renderer.fitToView()}
        isGisExpanded={isGisExpanded}
        onToggleGis={() => setIsGisExpanded((prev) => !prev)}
        isWorking={isWorking}
        activeBackend={activeBackend}
        isWebGpuAvailable={activeBackend === 'webgpu'}
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
              <span>Árbol</span>
            </button>
            <button
              className={`tab-btn tab-search ${leftTab === 'search' ? 'active' : ''}`}
              onClick={() => setLeftTab('search')}
            >
              <Search size={13} />
              <span>Buscar</span>
            </button>
          </div>

          <div className="panel-body">
            {leftTab === 'models' && (
              <ModelsPanel
                models={models}
                onToggleVisibility={handleToggleVisibility}
                onRemoveModel={handleRemoveModel}
                onLocateOnGis={handleLocateOnGis}
                onSelectElement={(ref) => void handleSelectElement(ref)}
                onRetryModel={handleRetryModel}
              />
            )}
            {leftTab === 'tree' && (
              <SpatialTreePanel
                models={models}
                spatialTrees={spatialTrees}
                onSelectElement={(ref) => void handleSelectElement(ref)}
                selectedRef={selectedRef}
                onIsolate={handleIsolate}
                onHide={handleHide}
              />
            )}
            {/* Kept mounted, so the search and its results survive a change of tab */}
            <div style={{ display: leftTab === 'search' ? 'block' : 'none' }}>
              <SearchPanel
                models={models}
                spatialTrees={spatialTrees}
                kernel={kernel}
                selectedRef={selectedRef}
                onSelectElement={(ref) => void handleSelectElement(ref)}
                onIsolate={handleIsolate}
                onHide={handleHide}
              />
            </div>
          </div>
        </aside>

        {/* Center Viewport */}
        <main className="viewport-center">
          <BimViewer
            renderer={renderer}
            onOpenFile={(file) => void loadIfcFile(file)}
            onSelectElement={(ref) => void handleSelectElement(ref)}
            onHoverElement={setHoveredRef}
            onInitError={setRendererError}
            hasSelection={selectedRef !== null}
            onZoomToSelection={() => void handleZoomToSelection()}
            onPoint={measure.point}
            onPointerMove={measure.hover}
            onFrame={measure.frame}
            statusText={statusText}
            isWorking={isWorking}
          >
            <MeasureOverlay controller={measure} renderer={renderer} />
          </BimViewer>

          {models.length > 0 && (
            <div className="viewport-tools">
              <DisplayBar
                classes={ifcClasses}
                rule={displayRule}
                selectedRef={selectedRef}
                onIsolate={handleIsolate}
                onHide={handleHide}
                onToggleGhost={() => setDisplayRule((prev) => ({ ...prev, ghost: !prev.ghost }))}
                onShowAll={() => setDisplayRule((prev) => ({ ...SHOW_ALL, ghost: prev.ghost }))}
              />
              <SectionBar section={section} bounds={bounds} onChange={setSection} />
              <MeasureBar
                controller={measure}
                onExportCsv={(groupBy) => void handleExportCsv(groupBy)}
                isExportingCsv={isExportingCsv}
              />
              <ColorByBar
                mode={colorByMode}
                propertyName={colorByPropName}
                availableProperties={availableColorProps}
                legend={colorLegend}
                onChangeMode={setColorByMode}
                onChangePropertyName={setColorByPropName}
              />
              <SavedViewsBar
                views={savedViews}
                nextIndex={nextSavedViewIndex}
                onSave={handleSaveView}
                onApply={handleApplySavedView}
                onDelete={handleDeleteSavedView}
              />
            </div>
          )}

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
            <button
              className={`tab-btn tab-ids ${rightTab === 'ids' ? 'active' : ''}`}
              onClick={() => setRightTab('ids')}
            >
              <ShieldCheck size={13} />
              <span>IDS</span>
            </button>
          </div>

          <div className="panel-body">
            {rightTab === 'props' && <PropertiesPanel element={selectedElement} />}
            {rightTab === 'dxf' && <SectionDxfPanel models={models} kernel={kernel} />}
            <div style={{ display: rightTab === 'ids' ? 'block' : 'none' }}>
              <IdsPanel
                models={models}
                spatialTrees={spatialTrees}
                kernel={kernel}
                selectedRef={selectedRef}
                onSelectElement={(ref) => void handleSelectElement(ref, true)}
                onIsolate={handleIsolate}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
