import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';
import type { ModelId, ModelBounds } from '../../domain/models/ModelRecord';

export interface ViewportEventHandlers {
  onSelectElement?: (modelId: ModelId | null, expressId: number | null) => void;
  onHoverElement?: (expressId: number | null) => void;
  onStatusChange?: (status: string) => void;
}

export class BimEngine {
  private canvas: HTMLCanvasElement | null = null;
  private renderer: Renderer | null = null;
  private processor: GeometryProcessor | null = null;
  private animFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;

  // Stored meshes per model for 2D section extraction and visibility
  private modelMeshes: Map<ModelId, MeshData[]> = new Map();
  private modelIndexMap: Map<number, ModelId> = new Map();
  private modelIdToIndex: Map<ModelId, number> = new Map();
  private nextModelIndex = 0;

  // Visibility and selection sets
  private hiddenModelIds: Set<ModelId> = new Set();
  private hiddenExpressIds: Set<number> = new Set();
  private selectedExpressId: number | null = null;

  private handlers: ViewportEventHandlers = {};

  static isWebGpuSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  setHandlers(handlers: ViewportEventHandlers) {
    this.handlers = handlers;
  }

  setSelectedExpressId(expressId: number | null) {
    this.selectedExpressId = expressId;
    this.render();
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    this.isDestroyed = false;

    if (!BimEngine.isWebGpuSupported()) {
      throw new Error(
        'WebGPU no está disponible en este navegador o equipo. Por favor, utiliza un navegador compatible (Chrome, Edge) con aceleración gráfica habilitada.'
      );
    }

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (!this.processor) {
      this.processor = new GeometryProcessor();
      await this.processor.init();
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch {
        // ignore teardown
      }
    }

    this.renderer = new Renderer(canvas);
    await this.renderer.init();

    this.setupResize(canvas);
    this.setupControls(canvas);
    this.startRenderLoop();
  }

  private setupResize(canvas: HTMLCanvasElement) {
    const resize = () => {
      if (!this.renderer || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      this.renderer.resize(width, height);
      this.render();
    };

    resize();
    window.addEventListener('resize', resize);

    if (canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => {
        resize();
      });
      this.resizeObserver.observe(canvas.parentElement);
    }
  }

  private setupControls(canvas: HTMLCanvasElement) {
    if (!this.renderer) return;
    const camera = this.renderer.getCamera();

    let isDragging = false;
    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let hasMoved = false;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      hasMoved = false;
      isPanning = e.button === 1 || e.button === 2 || e.shiftKey;
      startX = e.clientX;
      startY = e.clientY;
      canvas.style.cursor = isPanning ? 'move' : 'grabbing';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging || !this.renderer) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
      }

      startX = e.clientX;
      startY = e.clientY;

      if (isPanning) {
        camera.pan(dx, dy);
      } else {
        camera.orbit(dx, dy);
      }
      this.render();
    };

    const onMouseUp = async (e: MouseEvent) => {
      const wasClick = !hasMoved && e.button === 0;
      isDragging = false;
      isPanning = false;
      canvas.style.cursor = 'grab';

      if (wasClick && this.renderer) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        try {
          const pickResult = await this.renderer.pick(x, y);
          if (pickResult && pickResult.expressId) {
            const modelId =
              (pickResult.modelIndex !== undefined
                ? this.modelIndexMap.get(pickResult.modelIndex)
                : undefined) || this.getFirstModelId();
            this.selectedExpressId = pickResult.expressId;
            this.handlers.onSelectElement?.(modelId, pickResult.expressId);
          } else {
            this.selectedExpressId = null;
            this.handlers.onSelectElement?.(null, null);
          }
          this.render();
        } catch (err) {
          console.warn('Pick error:', err);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!this.renderer) return;
      camera.zoom(e.deltaY);
      this.render();
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.style.cursor = 'grab';
  }

  private startRenderLoop() {
    const loop = () => {
      if (this.isDestroyed || !this.renderer) return;
      this.render();
      this.animFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  private render() {
    if (!this.renderer) return;
    this.renderer.render({
      hiddenIds: this.hiddenExpressIds,
      selectedId: this.selectedExpressId ?? null
    });
  }

  async loadModelGeometry(
    modelId: ModelId,
    bytes: Uint8Array,
    onProgress?: (loadedMeshes: number) => void
  ): Promise<{ meshCount: number; bounds?: ModelBounds }> {
    if (!this.processor || !this.renderer) {
      throw new Error('El motor de renderizado no está inicializado.');
    }

    const modelIndex = this.nextModelIndex++;
    this.modelIndexMap.set(modelIndex, modelId);
    this.modelIdToIndex.set(modelId, modelIndex);

    const accumulatedMeshes: MeshData[] = [];
    let totalMeshes = 0;

    for await (const event of this.processor.processStreaming(bytes)) {
      if (event.type === 'batch') {
        accumulatedMeshes.push(...event.meshes);
        this.renderer.addMeshes(event.meshes, false);
        totalMeshes = event.totalSoFar;
        this.render();
        onProgress?.(totalMeshes);
      }

      if (event.type === 'complete') {
        totalMeshes = event.totalMeshes;
        this.renderer.fitToView();
        this.render();
      }
    }

    this.modelMeshes.set(modelId, accumulatedMeshes);

    const rawBounds = this.renderer.getModelBounds();
    const bounds: ModelBounds | undefined = rawBounds
      ? {
          min: { x: rawBounds.min.x, y: rawBounds.min.y, z: rawBounds.min.z },
          max: { x: rawBounds.max.x, y: rawBounds.max.y, z: rawBounds.max.z }
        }
      : undefined;

    return { meshCount: totalMeshes, bounds };
  }

  setModelVisibility(modelId: ModelId, visible: boolean): void {
    if (visible) {
      this.hiddenModelIds.delete(modelId);
    } else {
      this.hiddenModelIds.add(modelId);
    }

    this.updateHiddenIds();
    this.render();
  }

  private updateHiddenIds(): void {
    this.hiddenExpressIds.clear();
    for (const modelId of this.hiddenModelIds) {
      const meshes = this.modelMeshes.get(modelId);
      if (meshes) {
        for (const m of meshes) {
          if (m.expressId) {
            this.hiddenExpressIds.add(m.expressId);
          }
        }
      }
    }
  }

  removeModel(modelId: ModelId): void {
    this.modelMeshes.delete(modelId);
    this.hiddenModelIds.delete(modelId);
    const idx = this.modelIdToIndex.get(modelId);
    if (idx !== undefined) {
      this.modelIndexMap.delete(idx);
      this.modelIdToIndex.delete(modelId);
    }

    this.rebuildScene();
  }

  private rebuildScene(): void {
    if (!this.renderer) return;

    // Purge GPU scene and re-upload surviving models
    this.renderer.getScene().clear();
    this.updateHiddenIds();

    for (const meshes of this.modelMeshes.values()) {
      if (meshes.length > 0) {
        this.renderer.addMeshes(meshes, false);
      }
    }

    this.renderer.fitToView();
    this.render();
  }

  getModelMeshes(modelId?: ModelId): MeshData[] {
    if (modelId) {
      return this.modelMeshes.get(modelId) || [];
    }
    const all: MeshData[] = [];
    for (const meshes of this.modelMeshes.values()) {
      all.push(...meshes);
    }
    return all;
  }

  fitToView(): void {
    if (!this.renderer) return;
    this.renderer.fitToView();
    this.render();
  }

  setViewPreset(preset: 'iso' | 'top' | 'front' | 'side'): void {
    if (!this.renderer) return;
    const camera = this.renderer.getCamera();
    const bounds = this.renderer.getModelBounds();
    if (!bounds) return;

    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const maxDim = Math.max(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    );
    const dist = maxDim * 2 || 20;

    camera.setTarget(cx, cy, cz);

    switch (preset) {
      case 'iso':
        camera.setPosition(cx + dist, cy + dist, cz + dist);
        camera.setUp(0, 1, 0);
        break;
      case 'top':
        camera.setPosition(cx, cy + dist * 1.5, cz);
        camera.setUp(0, 0, -1);
        break;
      case 'front':
        camera.setPosition(cx, cy, cz + dist * 1.5);
        camera.setUp(0, 1, 0);
        break;
      case 'side':
        camera.setPosition(cx + dist * 1.5, cy, cz);
        camera.setUp(0, 1, 0);
        break;
    }
    this.render();
  }

  private getFirstModelId(): ModelId | null {
    const keys = Array.from(this.modelMeshes.keys());
    return keys.length > 0 ? keys[0] : null;
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.processor?.dispose();
    this.processor = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.modelMeshes.clear();
    this.modelIndexMap.clear();
    this.hiddenModelIds.clear();
    this.hiddenExpressIds.clear();
  }
}

export const bimEngine = new BimEngine();
