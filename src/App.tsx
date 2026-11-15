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
import { BcfPanel } from './ui/components/BcfPanel';
import { MeasureBar } from './ui/components/MeasureBar';
import { SavedViewsBar } from './ui/components/SavedViewsBar';
import { ColorByBar } from './ui/components/ColorByBar';
import type { BcfViewpoint } from './ui/viewer/bcf';
import {
  buildBcfViewpoint,
  collectDisplayExceptionRefs,
  interpretBcfViewpoint,
  rgbaU32ToBcfHex
} from './ui/viewer/bcfViewpoint';
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
import { pickFace, VERTEX_RADIUS } from './domain/measure/snap';
import { NO_SECTION, sceneBounds, sectionPlanes, type SectionState } from './ui/viewer/section';
import { BimViewer } from './ui/viewer/BimViewer';
import { computeElementMeshBounds } from './infrastructure/renderer/Camera';
import {
  extractBatchElementMeta,
  exportVisibleSceneToGlb,
  type ElementBatchMeta,
  type ModelExportInput
} from './infrastructure/export/gltfExport';
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

import { Layers, FolderTree, Sliders, Scissors, Search, ShieldCheck, MessageSquareWarning } from 'lucide-react';

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
  const [isExportingGlb, setIsExportingGlb] = useState<boolean>(false);
  const [glbProgress, setGlbProgress] = useState<{ completed: number; total: number } | null>(null);
  const [colorByMode, setColorByMode] = useState<ColorByMode>('none');
  const [colorByPropName, setColorByPropName] = useState<string>('Name');
  const [colorLegend, setColorLegend] = useState<ColorLegendItem[]>([]);
  const [availableColorProps, setAvailableColorProps] = useState<string[]>([]);
  const activeColorsByModelRef = useRef<Map<ModelId, Map<number, number>>>(new Map());
  const bcfColorsByModelRef = useRef<Map<ModelId, Map<number, number>>>(new Map());
  const elementBatchMetaByModelRef = useRef<Map<ModelId, Map<number, ElementBatchMeta>>>(new Map());
  const glbAbortControllerRef = useRef<AbortController | null>(null);
  const refKeyToGuidRef = useRef<Map<string, string>>(new Map());
  const guidToRefRef = useRef<Map<string, ElementRef>>(new Map());
  const snapshotWaitersRef = useRef<Array<() => void>>([]);

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
  const [isPickingFace, setIsPickingFace] = useState<boolean>(false);
  const bounds = useMemo(() => sceneBounds(models), [models]);
  useEffect(() => {
    const planes = sectionPlanes(section, bounds);
    renderer.setSectionPlanes(planes);
    measure.setPlanes(planes);
  }, [section, bounds, measure]);

  useEffect(() => {
    return measure.subscribe(() => {
      if (measure.getState().kind !== null) {
        setIsPickingFace(false);
      }
    });
  }, [measure]);

  const handleTogglePickFace = useCallback(
    (active?: boolean) => {
      const next = active ?? !isPickingFace;
      if (next) {
        measure.setKind(null);
        renderer.setPointerMode('measure');
        setIsPickingFace(true);
        setStatusText('Haz clic sobre una cara del modelo 3D para fijar el plano de corte.');
      } else {
        setIsPickingFace(false);
        renderer.setPointerMode(measure.getState().kind ? 'measure' : 'select');
      }
    },
    [isPickingFace, measure]
  );

  const handleCanvasPoint = useCallback(
    async (x: number, y: number): Promise<void> => {
      if (!isPickingFace) {
        await measure.point(x, y);
        return;
      }
      const probes: readonly (readonly [number, number])[] = [
        [0, 0],
        [VERTEX_RADIUS / 2, 0],
        [-VERTEX_RADIUS / 2, 0],
        [0, VERTEX_RADIUS / 2],
        [0, -VERTEX_RADIUS / 2]
      ];
      let ref: ElementRef | null = null;
      let hitX = x;
      let hitY = y;
      for (const [dx, dy] of probes) {
        ref = await renderer.pick(x + dx, y + dy);
        if (ref) {
          hitX = x + dx;
          hitY = y + dy;
          break;
        }
      }
      const ray = renderer.rayAt(hitX, hitY) ?? renderer.rayAt(x, y);
      if (!ref || !ray) {
        setStatusText('Ninguna cara bajo el cursor. Haz clic sobre un elemento 3D.');
        return;
      }
      const mesh = await kernel.elementMesh(ref.modelId, ref.expressId);
      if (!mesh) return;
      const activePlanes = sectionPlanes(section, bounds);
      const hit = pickFace(mesh, ray, activePlanes) ?? pickFace(mesh, ray, []);
      if (!hit) {
        setStatusText('No se pudo determinar la cara en ese punto. Inténtalo en otra zona.');
        return;
      }
      setSection((prev) => ({
        ...prev,
        mode: 'face',
        flip: false,
        face: {
          origin: [hit.point[0], hit.point[1], hit.point[2]],
          normal: [hit.normal[0], hit.normal[1], hit.normal[2]],
          offset: 0
        }
      }));
      setIsPickingFace(false);
      renderer.setPointerMode(measure.getState().kind ? 'measure' : 'select');
      setStatusText('Plano de corte fijado sobre la cara seleccionada.');
    },
    [isPickingFace, measure, section, bounds]
  );

  // With no model left there is nothing to measure on
  useEffect(() => {
    if (models.length === 0) {
      setIsPickingFace(false);
      measure.setKind(null);
      measure.clear();
      setSavedViews([]);
      setNextSavedViewIndex(1);
      setColorByMode('none');
      setColorLegend([]);
      activeColorsByModelRef.current.clear();
      bcfColorsByModelRef.current.clear();
      elementBatchMetaByModelRef.current.clear();
      glbAbortControllerRef.current?.abort();
      glbAbortControllerRef.current = null;
    }
  }, [models.length, measure]);

  useEffect(() => {
    let cancelled = false;
    if (colorByMode === 'none' || models.length === 0) {
      setColorLegend([]);
      const nextColors = new Map<ModelId, Map<number, number>>();
      for (const m of models) {
        const bcfMap = bcfColorsByModelRef.current.get(m.id) ?? new Map<number, number>();
        if (bcfMap.size > 0) nextColors.set(m.id, bcfMap);
        renderer.setElementColors(m.id, bcfMap);
      }
      activeColorsByModelRef.current = nextColors;
      return;
    }
    bcfColorsByModelRef.current.clear();
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
      activeColorsByModelRef.current = scheme.colorsByModel;
      for (const m of models) {
        renderer.setElementColors(m.id, scheme.colorsByModel.get(m.id) ?? new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [colorByMode, colorByPropName, models, spatialTrees]);

  const handleChangeColorByMode = useCallback((nextMode: ColorByMode) => {
    bcfColorsByModelRef.current.clear();
    setColorByMode(nextMode);
  }, []);

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
  const [rightTab, setRightTab] = useState<'props' | 'dxf' | 'ids' | 'bcf'>('props');
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
        const batchMetaMap = new Map<number, ElementBatchMeta>();

        for await (const event of kernel.streamGeometry(modelId)) {
          if (event.type === 'batch') {
            extractBatchElementMeta(event.batch.meshTable, batchMetaMap);
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

        elementBatchMetaByModelRef.current.set(modelId, batchMetaMap);
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
      if (details?.globalId) {
        refKeyToGuidRef.current.set(`${model.id}:${ref.expressId}`, details.globalId);
        guidToRefRef.current.set(details.globalId, {
          modelId: model.id,
          expressId: ref.expressId,
          globalId: details.globalId
        });
      }

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
    activeColorsByModelRef.current.delete(id);
    bcfColorsByModelRef.current.delete(id);
    elementBatchMetaByModelRef.current.delete(id);
    for (const [k, guid] of refKeyToGuidRef.current.entries()) {
      if (k.startsWith(`${id}:`)) {
        refKeyToGuidRef.current.delete(k);
        guidToRefRef.current.delete(guid);
      }
    }
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

  const handleViewportFrame = useCallback(() => {
    measure.frame();
    if (snapshotWaitersRef.current.length > 0) {
      const waiters = snapshotWaitersRef.current.splice(0);
      for (const w of waiters) w();
    }
  }, [measure]);

  const resolveRefToGuid = useCallback(async (ref: ElementRef): Promise<string | null> => {
    const key = `${ref.modelId}:${ref.expressId}`;
    if (ref.globalId) {
      refKeyToGuidRef.current.set(key, ref.globalId);
      guidToRefRef.current.set(ref.globalId, ref);
      return ref.globalId;
    }
    const cached = refKeyToGuidRef.current.get(key);
    if (cached) return cached;
    try {
      const details = await kernel.getElementDetails(ref);
      const guid = details?.globalId?.trim();
      if (guid) {
        refKeyToGuidRef.current.set(key, guid);
        guidToRefRef.current.set(guid, { modelId: ref.modelId, expressId: ref.expressId, globalId: guid });
        return guid;
      }
    } catch {
      // ignore missing element details
    }
    return null;
  }, []);

  const handleCancelGlb = useCallback(() => {
    glbAbortControllerRef.current?.abort();
    glbAbortControllerRef.current = null;
  }, []);

  const handleExportGlb = useCallback(async () => {
    const visibleModels = models.filter((m) => m.status === 'ready' && m.visible);
    if (visibleModels.length === 0) {
      setStatusText('No hay modelos visibles para exportar a GLB.');
      return;
    }

    glbAbortControllerRef.current?.abort();
    const controller = new AbortController();
    glbAbortControllerRef.current = controller;

    setIsExportingGlb(true);
    setGlbProgress({ completed: 0, total: 0 });
    setStatusText('Preparando exportación GLB de la escena visible...');

    try {
      const exportInputs: ModelExportInput[] = visibleModels.map((model) => {
        const { others, entries } = modelDisplay(displayRule, model.id, spatialTrees[model.id]);
        return {
          id: model.id,
          visible: model.visible,
          status: model.status,
          displayOthers: others,
          displayEntries: entries,
          colorOverrides: activeColorsByModelRef.current.get(model.id),
          batchMeta: elementBatchMetaByModelRef.current.get(model.id),
          spatialTree: spatialTrees[model.id]
        };
      });

      const { glb, elementCount } = await exportVisibleSceneToGlb({
        models: exportInputs,
        getElementMesh: (modelId, expressId) => kernel.elementMesh(modelId, expressId),
        getGlobalId: (modelId, expressId) => resolveRefToGuid({ modelId, expressId }),
        onProgress: ({ completed, total }) => {
          setGlbProgress({ completed, total });
          setStatusText(`Exportando GLB (${completed}/${total})...`);
        },
        signal: controller.signal,
        yieldEvery: 1
      });

      const filename = 'escena-visible.glb';
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__gubim_last_glb__ = {
          filename,
          bytes: glb,
          byteLength: glb.byteLength,
          elementCount
        };
        const blob = new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
      setStatusText(`Escena exportada a ${filename} (${elementCount} elementos).`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusText('Exportación GLB cancelada.');
      } else {
        console.error('Error exporting GLB:', err);
        setStatusText(
          `Error al exportar GLB: ${err instanceof Error ? err.message : 'Error'}`
        );
      }
    } finally {
      if (glbAbortControllerRef.current === controller) {
        glbAbortControllerRef.current = null;
      }
      setIsExportingGlb(false);
      setGlbProgress(null);
    }
  }, [models, displayRule, spatialTrees, resolveRefToGuid]);

  const resolveGuidToRef = useCallback(
    async (ifcGuid: string): Promise<ElementRef | null> => {
      const trimmed = ifcGuid.trim();
      if (!trimmed) return null;
      const readyModels = models.filter((m) => m.status === 'ready');
      const cached = guidToRefRef.current.get(trimmed);
      if (cached && readyModels.some((m) => m.id === cached.modelId)) {
        return cached;
      }
      for (const model of readyModels) {
        try {
          const ids = await kernel.findElements(model.id, { field: 'globalId', text: trimmed });
          for (const expressId of ids) {
            const details = await kernel.getElementDetails({ modelId: model.id, expressId });
            if (details?.globalId === trimmed) {
              const found: ElementRef = { modelId: model.id, expressId, globalId: trimmed };
              refKeyToGuidRef.current.set(`${model.id}:${expressId}`, trimmed);
              guidToRefRef.current.set(trimmed, found);
              return found;
            }
          }
        } catch {
          // ignore search failure on model
        }
      }
      return null;
    },
    [models]
  );

  const captureCanvasSnapshot = useCallback((): Promise<
    { bytes: Uint8Array; format: 'png'; aspectRatio: number } | undefined
  > => {
    if (typeof document === 'undefined') return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const grab = () => {
        if (settled) return;
        settled = true;
        try {
          const canvas = document.querySelector<HTMLCanvasElement>('.bim-viewport');
          if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
            resolve(undefined);
            return;
          }
          const aspectRatio = canvas.width / canvas.height;
          const maxDim = Math.max(canvas.width, canvas.height);
          const scale = maxDim > 1500 ? 1500 / maxDim : 1;
          const targetW = Math.max(1, Math.round(canvas.width * scale));
          const targetH = Math.max(1, Math.round(canvas.height * scale));
          const offscreen = document.createElement('canvas');
          offscreen.width = targetW;
          offscreen.height = targetH;
          const ctx = offscreen.getContext('2d');
          if (!ctx) {
            resolve(undefined);
            return;
          }
          ctx.drawImage(canvas, 0, 0, targetW, targetH);
          const dataUrl = offscreen.toDataURL('image/png');
          const commaIdx = dataUrl.indexOf(',');
          if (commaIdx < 0) {
            resolve(undefined);
            return;
          }
          const bin = atob(dataUrl.slice(commaIdx + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
          }
          resolve({ bytes, format: 'png', aspectRatio });
        } catch {
          resolve(undefined);
        }
      };

      snapshotWaitersRef.current.push(grab);
      const pose = renderer.getCameraPose();
      if (pose) {
        renderer.setCameraPose(pose);
      }
      setTimeout(grab, 180);
    });
  }, []);

  const handleCaptureBcfViewpoint = useCallback(
    async (index: number): Promise<BcfViewpoint | null> => {
      const camera = renderer.getCameraPose();
      const snapshotResult = await captureCanvasSnapshot();

      const selectedGuids: string[] = [];
      if (selectedRef) {
        const g = await resolveRefToGuid(selectedRef);
        if (g) selectedGuids.push(g);
      }

      const { mode: visMode, refs: exceptionRefs } = collectDisplayExceptionRefs(
        displayRule,
        models,
        spatialTrees
      );
      const exceptionGuids: string[] = [];
      for (const ref of exceptionRefs) {
        const g = await resolveRefToGuid(ref);
        if (g && !exceptionGuids.includes(g)) exceptionGuids.push(g);
      }

      const colorGroupMap = new Map<string, string[]>();
      for (const [modelId, modelColorMap] of activeColorsByModelRef.current.entries()) {
        for (const [expressId, rgba] of modelColorMap.entries()) {
          const g = await resolveRefToGuid({ modelId, expressId });
          if (!g) continue;
          const hex = rgbaU32ToBcfHex(rgba);
          let list = colorGroupMap.get(hex);
          if (!list) {
            list = [];
            colorGroupMap.set(hex, list);
          }
          if (!list.includes(g)) list.push(g);
        }
      }
      const coloring = [...colorGroupMap.entries()].map(([color, ifcGuids]) => ({ color, ifcGuids }));
      const activePlanes = sectionPlanes(section, bounds);

      return buildBcfViewpoint({
        index,
        camera,
        aspectRatio: snapshotResult?.aspectRatio,
        selectedGuids,
        visibility: { mode: visMode, exceptionGuids },
        coloring,
        sectionPlanes: activePlanes,
        snapshot: snapshotResult
          ? { bytes: snapshotResult.bytes, format: snapshotResult.format }
          : undefined
      });
    },
    [captureCanvasSnapshot, selectedRef, resolveRefToGuid, displayRule, models, spatialTrees, section, bounds]
  );

  const handleApplyBcfViewpoint = useCallback(
    async (viewpoint: BcfViewpoint): Promise<void> => {
      const candidateGuids = new Set<string>();
      for (const c of viewpoint.selection) {
        if (c.ifcGuid) candidateGuids.add(c.ifcGuid);
      }
      for (const c of viewpoint.visibility?.exceptions ?? []) {
        if (c.ifcGuid) candidateGuids.add(c.ifcGuid);
      }
      for (const group of viewpoint.coloring) {
        for (const c of group.components) {
          if (c.ifcGuid) candidateGuids.add(c.ifcGuid);
        }
      }

      const resolvedMap = new Map<string, ElementRef>();
      for (const guid of candidateGuids) {
        const resolved = await resolveGuidToRef(guid);
        if (resolved) resolvedMap.set(guid, resolved);
      }

      const currentPose = renderer.getCameraPose();
      const interpreted = interpretBcfViewpoint(viewpoint, (guid) => resolvedMap.get(guid) ?? null, {
        fallbackDistance: currentPose?.distance ?? 12,
        referenceTarget: currentPose?.target,
        ghost: displayRule.ghost
      });

      if (interpreted.camera) {
        renderer.setCameraPose(interpreted.camera);
      }
      setDisplayRule(interpreted.displayRule);
      setSection(interpreted.sectionState);
      renderer.setSectionPlanes(interpreted.sectionPlanes);
      measure.setPlanes(interpreted.sectionPlanes);

      bcfColorsByModelRef.current = interpreted.colorsByModel;
      activeColorsByModelRef.current = interpreted.colorsByModel;
      setColorByMode('none');
      setColorLegend([]);
      for (const m of models) {
        renderer.setElementColors(m.id, interpreted.colorsByModel.get(m.id) ?? new Map());
      }

      await handleSelectElement(interpreted.selectedRef, true);
    },
    [resolveGuidToRef, displayRule.ghost, measure, models, handleSelectElement]
  );

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
            onPoint={handleCanvasPoint}
            onPointerMove={measure.hover}
            onFrame={handleViewportFrame}
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
                onExportGlb={() => void handleExportGlb()}
                onCancelGlb={handleCancelGlb}
                isExportingGlb={isExportingGlb}
                glbProgress={glbProgress}
              />
              <SectionBar
                section={section}
                bounds={bounds}
                onChange={setSection}
                isPickingFace={isPickingFace}
                onTogglePickFace={handleTogglePickFace}
              />
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
                onChangeMode={handleChangeColorByMode}
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
            <button
              className={`tab-btn tab-bcf ${rightTab === 'bcf' ? 'active' : ''}`}
              onClick={() => setRightTab('bcf')}
            >
              <MessageSquareWarning size={13} />
              <span>BCF</span>
            </button>
          </div>

          <div className="panel-body">
            {rightTab === 'props' && <PropertiesPanel element={selectedElement} />}
            {rightTab === 'dxf' && (
              <SectionDxfPanel
                models={models}
                kernel={kernel}
                section={section}
                onChangeSection={setSection}
                isPickingFace={isPickingFace}
                onTogglePickFace={handleTogglePickFace}
              />
            )}
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
            <div style={{ display: rightTab === 'bcf' ? 'block' : 'none' }}>
              <BcfPanel
                onCaptureViewpoint={handleCaptureBcfViewpoint}
                onApplyViewpoint={handleApplyBcfViewpoint}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
