import type { ElementRef, ModelBounds, ModelId } from '../../domain/models/ModelRecord';
import {
  MESH_RECORD_WORDS,
  MeshField,
  findBatchError,
  type GeometryBatch
} from '../../domain/kernel/GeometryBatch';
import type {
  CameraPose,
  CameraProjection,
  ElementDisplay,
  NavigationMode,
  PointerMode,
  RendererEventHandlers,
  RendererPort,
  SectionPlane,
  ViewPreset
} from '../../domain/kernel/RendererPort';
import type { Ray, Vec3 } from '../../domain/measure/geometry';
import { Camera, pickBatchOrbitPivot } from './Camera';
import { attachCanvasInput } from './canvasInput';
import { canvasPoint, canvasRay } from './canvasView';
import { boxMayShow, markBatchesInView, pixelWindow } from './frustum';
import { groupIndices } from './indexGroups';
import { RENDERER_WGSL } from './shaders';
import { SECTION_FLOATS, keptSectionPlanes, writeSectionPlanes } from './sectionPlanes';
import {
  FLAG_SELECTED,
  displayFlags,
  effectiveRgba,
  refreshDisplayFlags,
  setColors,
  setDisplay,
  type DisplayState
} from './recordDisplay';
/** Geometry uploaded per frame; a batch is never split, so one always goes. */
const UPLOAD_BYTES_PER_FRAME = 2 * 1024 * 1024;

interface GpuBatchEntry {
  origin: readonly [number, number, number];
  /** The kernel's box, absolute: origin plus its least and greatest position. */
  min: Vec3;
  max: Vec3;
  /** Set each frame by markBatchesInView. */
  inView: boolean;
  recordOffsetInModel: number;
  recordCount: number;
  opaqueIndexCount: number;
  /** The first of the opaque indices, which belong to closed meshes: see `groupIndices`. */
  closedIndexCount: number;
  transparentIndexCount: number;
  positionBuffer: GPUBuffer;
  normalBuffer: GPUBuffer;
  recordIndexBuffer: GPUBuffer;
  opaqueIndexBuffer: GPUBuffer | null;
  transparentIndexBuffer: GPUBuffer | null;
  gpuBytes: number;
}

interface ModelEntry extends DisplayState {
  modelId: ModelId;
  numericId: number;
  visible: boolean;
  batches: GpuBatchEntry[];
  /** Maps expressId -> list of record indices (0..recordCount-1) within this model. */
  expressIdToRecords: Map<number, number[]>;
  /** Starting record index in the global GPU record buffer. */
  recordBaseOffset: number;
  /** The kernel's 'complete' bounds, set by finishModel; not valid while the model streams. */
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    valid: boolean;
  };
}

interface PreInitOp {
  kind: 'batch';
  batch: GeometryBatch;
}

export interface RendererDebugStats {
  modelCount: number;
  batchCount: number;
  recordCount: number;
  liveGpuBuffers: number;
  allocatedGpuBytes: number;
  renderCount: number;
  lastFrameCpuMs: number;
  /** Batches the last frame drew, out of batchCount: the rest were out of view or hidden. */
  drawnBatches: number;
  /** Batches the last pick drew: those whose box reaches the pixel. */
  pickedBatches: number;
}

export class WebGpuRenderer implements RendererPort {
  private canvas: HTMLCanvasElement | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private canvasFormat: GPUTextureFormat = 'bgra8unorm';

  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sceneBindGroup: GPUBindGroup | null = null;
  private opaquePipeline: GPURenderPipeline | null = null;
  private transparentPipeline: GPURenderPipeline | null = null;
  private ghostPipeline: GPURenderPipeline | null = null;
  private pickPipeline: GPURenderPipeline | null = null;
  private closedPipeline: GPURenderPipeline | null = null;
  private closedPickPipeline: GPURenderPipeline | null = null;

  private sceneUniformBuffer: GPUBuffer | null = null;
  private batchGpuBuffer: GPUBuffer | null = null;
  private batchGpuCapacity = 0; // in batches
  private recordGpuBuffer: GPUBuffer | null = null;
  private recordGpuCapacity = 0; // in records
  private pickReadBuffer: GPUBuffer | null = null;

  private depthTexture: GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private idTexture: GPUTexture | null = null;
  private idTextureView: GPUTextureView | null = null;

  private readonly camera = new Camera();
  /** Projection, view, then the section planes relative to the eye. */
  private readonly sceneUniformData = new Float32Array(32 + SECTION_FLOATS);
  private sectionPlanes: SectionPlane[] = [];

  private batchCpuBuffer = new ArrayBuffer(64 * 16);
  private batchF32 = new Float32Array(this.batchCpuBuffer);
  private batchU32 = new Uint32Array(this.batchCpuBuffer);

  private recordCpuWords = new Uint32Array(64 * 4);
  private recordLayoutDirty = true;
  /** Records in the GPU table, and the first of them not uploaded yet. */
  private recordTotal = 0;
  private recordAppendFrom = 0;
  /** The table's last model: its new records go on the end without moving any other model. */
  private recordTail: ModelEntry | null = null;

  private models: Map<ModelId, ModelEntry> = new Map();
  private numToModelId: Map<number, ModelId> = new Map();
  private nextModelNumericId = 1;

  private preInitQueue: PreInitOp[] = [];
  /** Batches waiting for a frame: uploading each as it arrives can hold the GPU process up. */
  private uploadQueue: GeometryBatch[] = [];
  private pendingFinishBounds: Map<ModelId, ModelBounds | undefined> = new Map();

  private selectedRef: ElementRef | null = null;
  private handlers: RendererEventHandlers = {};
  private hasFramedInitialModel = false;

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cleanupListeners: (() => void) | null = null;
  private deviceLostBanner: HTMLDivElement | null = null;
  private isDestroyed = false;
  private isPicking = false;
  private pickQueue: Promise<unknown> = Promise.resolve();
  private pointerMode: PointerMode = 'select';
  private navigationMode: NavigationMode = 'orbit';
  private initGeneration = 0;

  // Telemetry for verification and performance checks
  private renderCount = 0;
  private lastFrameCpuMs = 0;
  private drawnBatches = 0;
  private pickedBatches = 0;

  setHandlers(handlers: RendererEventHandlers): void {
    this.handlers = handlers;
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    const gen = ++this.initGeneration;
    this.releaseGpuDeviceAndListeners();
    this.isDestroyed = false;
    this.canvas = canvas;

    try {
      if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
        throw new Error(
          'WebGPU no está disponible en este navegador o equipo. Por favor, utiliza un navegador compatible (Chrome o Edge) con aceleración gráfica habilitada.'
        );
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error(
          'No se pudo obtener un adaptador gráfico WebGPU compatible en este equipo. Verifica que los controladores de tu tarjeta gráfica estén actualizados.'
        );
      }

      let device: GPUDevice;
      try {
        device = await adapter.requestDevice();
      } catch (err) {
        throw new Error(
          `No se pudo inicializar el dispositivo gráfico WebGPU: ${err instanceof Error ? err.message : 'Error desconocido'}`
        );
      }

      if (this.isDestroyed || gen !== this.initGeneration) {
        device.destroy();
        return;
      }

      const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) {
        device.destroy();
        throw new Error('No se pudo crear el contexto WebGPU en el lienzo 3D.');
      }

      this.device = device;
      this.context = context;
      this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

      context.configure({
        device,
        format: this.canvasFormat,
        alphaMode: 'opaque'
      });

      void device.lost.then((info) => {
        if (this.isDestroyed || info.reason === 'destroyed') return;
        const msg = `Se perdió la conexión con el dispositivo gráfico WebGPU${info.message ? ` (${info.message})` : ''}. Recarga la página para restaurar el visor 3D.`;
        console.error(msg);
        this.showDeviceLostBanner(msg);
      });

      this.createPipelinesAndBuffers(device);
      this.setupListeners(canvas);
      this.syncCanvasSize();

      if (import.meta.env.DEV && typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__gubim_dev__ = {
          renderer: this,
          findBatchError
        };
      }

      // Drain any batches and finishModel calls that arrived before initialize resolved
      if (this.preInitQueue.length > 0) {
        const queued = this.preInitQueue.splice(0, this.preInitQueue.length);
        for (const op of queued) {
          if (op.kind === 'batch' && this.models.has(op.batch.modelId)) {
            this.uploadBatchInternal(op.batch);
          }
        }
      }

      if (this.pendingFinishBounds.size > 0) {
        const entries = Array.from(this.pendingFinishBounds.entries());
        this.pendingFinishBounds.clear();
        for (const [modelId, bounds] of entries) {
          this.finishModel(modelId, bounds);
        }
      }

      this.requestRender();
    } catch (err) {
      this.releaseGpuDeviceAndListeners();
      throw err;
    }
  }

  private createPipelinesAndBuffers(device: GPUDevice): void {
    const shaderModule = device.createShaderModule({
      label: 'gubim-renderer-shader',
      code: RENDERER_WGSL
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'gubim-scene-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' }
        }
      ]
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'gubim-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout]
    });

    const vertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }]
      },
      {
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 1 }]
      },
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ format: 'uint32', offset: 0, shaderLocation: 2 }]
      }
    ];

    // Closed meshes draw without their back faces, which never show from outside them.
    const opaquePipeline = (label: string, cullMode: 'none' | 'back'): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
          buffers: vertexBuffers
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.canvasFormat }]
        },
        primitive: {
          topology: 'triangle-list',
          cullMode
        },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'greater'
        }
      });
    this.opaquePipeline = opaquePipeline('gubim-opaque-pipeline', 'none');
    this.closedPipeline = opaquePipeline('gubim-closed-pipeline', 'back');

    // Transparent elements and ghosts blend over the opaque pass without writing depth.
    const blendedPipeline = (label: string, vertexEntryPoint: string): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: vertexEntryPoint,
          buffers: vertexBuffers
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [
            {
              format: this.canvasFormat,
              blend: {
                color: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add'
                },
                alpha: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add'
                }
              }
            }
          ]
        },
        primitive: {
          topology: 'triangle-list',
          cullMode: 'none'
        },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: false,
          depthCompare: 'greater'
        }
      });
    this.transparentPipeline = blendedPipeline('gubim-transparent-pipeline', 'vs_main');
    this.ghostPipeline = blendedPipeline('gubim-ghost-pipeline', 'vs_ghost');

    // Picking culls what drawing culls, so a click finds what shows.
    const pickPipeline = (label: string, cullMode: 'none' | 'back'): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_pick',
          buffers: vertexBuffers
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_pick',
          targets: [{ format: 'rg32uint' }]
        },
        primitive: {
          topology: 'triangle-list',
          cullMode
        },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'greater'
        }
      });
    this.pickPipeline = pickPipeline('gubim-pick-pipeline', 'none');
    this.closedPickPipeline = pickPipeline('gubim-closed-pick-pipeline', 'back');

    this.sceneUniformBuffer = device.createBuffer({
      label: 'gubim-scene-uniforms',
      size: this.sceneUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.batchGpuCapacity = 64;
    this.batchGpuBuffer = device.createBuffer({
      label: 'gubim-batch-buffer',
      size: this.batchGpuCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    this.recordGpuCapacity = 64;
    this.recordGpuBuffer = device.createBuffer({
      label: 'gubim-record-buffer',
      size: this.recordGpuCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    this.pickReadBuffer = device.createBuffer({
      label: 'gubim-pick-read-buffer',
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    this.recreateBindGroup();
    this.recordLayoutDirty = true;
  }

  private recreateBindGroup(): void {
    if (
      !this.device ||
      !this.bindGroupLayout ||
      !this.sceneUniformBuffer ||
      !this.batchGpuBuffer ||
      !this.recordGpuBuffer
    ) {
      return;
    }

    this.sceneBindGroup = this.device.createBindGroup({
      label: 'gubim-scene-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.sceneUniformBuffer } },
        { binding: 1, resource: { buffer: this.batchGpuBuffer } },
        { binding: 2, resource: { buffer: this.recordGpuBuffer } }
      ]
    });
  }

  private syncCanvasSize(): void {
    if (!this.canvas || !this.device) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor((rect.width || this.canvas.clientWidth || 800) * dpr));
    const height = Math.max(1, Math.floor((rect.height || this.canvas.clientHeight || 600) * dpr));

    if (
      this.canvas.width === width &&
      this.canvas.height === height &&
      this.depthTexture &&
      this.idTexture
    ) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.camera.setAspect(width / height);

    this.depthTexture?.destroy();
    this.idTexture?.destroy();

    this.depthTexture = this.device.createTexture({
      label: 'gubim-depth-texture',
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.depthTextureView = this.depthTexture.createView();

    this.idTexture = this.device.createTexture({
      label: 'gubim-id-texture',
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rg32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    this.idTextureView = this.idTexture.createView();

    this.requestRender();
  }

  private setupListeners(canvas: HTMLCanvasElement): void {
    const onResize = () => {
      this.syncCanvasSize();
    };

    window.addEventListener('resize', onResize);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncCanvasSize();
      });
      this.resizeObserver.observe(canvas);
      if (canvas.parentElement) {
        this.resizeObserver.observe(canvas.parentElement);
      }
    }

    const stopInput = attachCanvasInput(canvas, this.camera, {
      onViewChange: () => this.requestRender(),
      onHover: (at) => {
        if (this.pointerMode === 'measure') this.handlers.onPointerMove?.(at);
      },
      idleCursor: () => this.idleCursor(),
      getNavigationMode: () => this.navigationMode,
      getOrbitPivot: (cssX, cssY) =>
        pickBatchOrbitPivot(this.rayAt(cssX, cssY), this.models.values(), this.sectionPlanes),
      onClick: (cssX, cssY) => {
        if (this.pointerMode === 'measure') {
          this.handlers.onPoint?.(cssX, cssY);
          return;
        }
        void this.pick(cssX, cssY).then((hit) => {
          this.setSelection(hit);
          this.handlers.onSelect?.(hit);
        });
      }
    });

    this.cleanupListeners = () => {
      window.removeEventListener('resize', onResize);
      stopInput();
    };
  }

  private showDeviceLostBanner(message: string): void {
    const parent = this.canvas?.parentElement;
    if (!parent) return;
    if (this.deviceLostBanner) {
      this.deviceLostBanner.textContent = message;
      return;
    }
    const div = document.createElement('div');
    div.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(15,23,42,0.95);border:1px solid #ef4444;padding:20px;border-radius:8px;color:#f8fafc;font-size:13px;max-width:420px;text-align:center;z-index:40;';
    div.textContent = message;
    parent.appendChild(div);
    this.deviceLostBanner = div;
  }

  private getOrCreateModel(modelId: ModelId): ModelEntry {
    let model = this.models.get(modelId);
    if (!model) {
      const numericId = this.nextModelNumericId++;
      model = {
        modelId,
        numericId,
        visible: true,
        batches: [],
        recordWords: [],
        baseRgba: [],
        colorOverrides: new Map(),
        expressIdToRecords: new Map(),
        displayEntries: new Map(),
        displayOthers: 'default',
        displayMayGhost: false,
        recordBaseOffset: 0,
        bounds: {
          minX: Infinity,
          minY: Infinity,
          minZ: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          maxZ: -Infinity,
          valid: false
        }
      };
      this.models.set(modelId, model);
      this.numToModelId.set(numericId, modelId);
    }
    return model;
  }

  addModel(modelId: ModelId): void {
    this.getOrCreateModel(modelId);
  }

  addBatch(batch: GeometryBatch): void {
    this.getOrCreateModel(batch.modelId);
    if (!this.device) {
      this.preInitQueue.push({ kind: 'batch', batch });
      return;
    }
    this.uploadQueue.push(batch);
    this.requestRender();
  }

  /** Uploads queued batches up to the frame's budget, and asks for another frame if some are left. */
  private uploadQueuedBatches(): void {
    let bytes = 0;
    while (this.uploadQueue.length > 0 && bytes < UPLOAD_BYTES_PER_FRAME) {
      const batch = this.uploadQueue.shift()!;
      this.uploadBatchInternal(batch);
      bytes += batch.positions.byteLength + batch.normals.byteLength + batch.indices.byteLength;
    }
    if (this.uploadQueue.length > 0) this.requestRender();
  }

  private uploadBatchInternal(batch: GeometryBatch): void {
    if (!this.device) return;
    const model = this.getOrCreateModel(batch.modelId);
    const { positions, normals, indices, meshTable, origin } = batch;

    const vertexCount = positions.length / 3;
    const recordCount = meshTable.length / MESH_RECORD_WORDS;
    if (vertexCount === 0 || indices.length === 0 || recordCount === 0) {
      return;
    }

    const recordOffsetInModel = model.recordWords.length / 4;
    const localRecordIndexArray = new Uint32Array(vertexCount);

    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];

    for (let r = 0; r < recordCount; r++) {
      const base = r * MESH_RECORD_WORDS;
      const expressId = meshTable[base + MeshField.expressId] >>> 0;
      const firstVertex = meshTable[base + MeshField.firstVertex] >>> 0;
      const vCount = meshTable[base + MeshField.vertexCount] >>> 0;
      const rgba = meshTable[base + MeshField.rgba] >>> 0;
      const rawFlags = meshTable[base + MeshField.flags] >>> 0;

      localRecordIndexArray.fill(r, firstVertex, firstVertex + vCount);

      const isSelected =
        this.selectedRef !== null &&
        this.selectedRef.modelId === model.modelId &&
        this.selectedRef.expressId === expressId;

      const stateFlags =
        ((rawFlags & 0x7) |
          displayFlags(model, expressId, rawFlags) |
          (isSelected ? FLAG_SELECTED : 0)) >>>
        0;

      const recIdxInModel = recordOffsetInModel + r;
      model.baseRgba!.push(rgba);
      model.recordWords.push(expressId, model.numericId >>> 0, effectiveRgba(model, expressId, rgba), stateFlags);

      let list = model.expressIdToRecords.get(expressId);
      if (!list) {
        list = [];
        model.expressIdToRecords.set(expressId, list);
      }
      list.push(recIdxInModel);
    }

    const posByteLen = Math.max(4, positions.byteLength);
    const positionBuffer = this.device.createBuffer({
      size: posByteLen,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(
      positionBuffer,
      0,
      positions.buffer,
      positions.byteOffset,
      positions.byteLength
    );

    const normByteLen = Math.max(4, normals.byteLength);
    const normalBuffer = this.device.createBuffer({
      size: normByteLen,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(
      normalBuffer,
      0,
      normals.buffer,
      normals.byteOffset,
      normals.byteLength
    );

    const recIdxByteLen = Math.max(4, localRecordIndexArray.byteLength);
    const recordIndexBuffer = this.device.createBuffer({
      size: recIdxByteLen,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(
      recordIndexBuffer,
      0,
      localRecordIndexArray.buffer,
      localRecordIndexArray.byteOffset,
      localRecordIndexArray.byteLength
    );

    const groups = groupIndices(indices, meshTable);
    const indexBuffer = (values: Uint32Array): GPUBuffer | null => {
      if (values.length === 0 || !this.device) return null;
      const buffer = this.device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(buffer, 0, values.buffer, values.byteOffset, values.byteLength);
      return buffer;
    };
    const opaqueIndexBuffer = indexBuffer(groups.opaque);
    const transparentIndexBuffer = indexBuffer(groups.transparent);
    const indexGpuBytes = (opaqueIndexBuffer?.size ?? 0) + (transparentIndexBuffer?.size ?? 0);

    const gpuBytes = positionBuffer.size + normalBuffer.size + recordIndexBuffer.size + indexGpuBytes;

    const { min, max } = batch.box;
    model.batches.push({
      origin: [ox, oy, oz],
      min: [ox + min[0], oy + min[1], oz + min[2]],
      max: [ox + max[0], oy + max[1], oz + max[2]],
      inView: true,
      recordOffsetInModel,
      recordCount,
      opaqueIndexCount: groups.opaque.length,
      closedIndexCount: groups.closedCount,
      transparentIndexCount: groups.transparent.length,
      positionBuffer,
      normalBuffer,
      recordIndexBuffer,
      opaqueIndexBuffer,
      transparentIndexBuffer,
      gpuBytes
    });

    // Records of the table's last model are appended; anything else moves models, so rebuild.
    if (
      !this.recordLayoutDirty &&
      model === this.recordTail &&
      model.recordBaseOffset + recordOffsetInModel === this.recordTotal
    ) {
      this.recordTotal += recordCount;
    } else {
      this.recordLayoutDirty = true;
    }
  }

  finishModel(modelId: ModelId, bounds: ModelBounds | undefined): void {
    if (!this.device) {
      this.pendingFinishBounds.set(modelId, bounds);
      return;
    }

    const model = this.models.get(modelId);
    if (model && bounds) {
      model.bounds.minX = bounds.min.x;
      model.bounds.minY = bounds.min.y;
      model.bounds.minZ = bounds.min.z;
      model.bounds.maxX = bounds.max.x;
      model.bounds.maxY = bounds.max.y;
      model.bounds.maxZ = bounds.max.z;
      model.bounds.valid = true;
    }

    if (!this.hasFramedInitialModel && model && model.visible && model.bounds.valid) {
      this.hasFramedInitialModel = true;
      this.fitToView();
    } else {
      this.requestRender();
    }
  }

  removeModel(modelId: ModelId): void {
    this.preInitQueue = this.preInitQueue.filter(
      (op) => !(op.kind === 'batch' && op.batch.modelId === modelId)
    );
    this.uploadQueue = this.uploadQueue.filter((batch) => batch.modelId !== modelId);
    this.pendingFinishBounds.delete(modelId);

    const model = this.models.get(modelId);
    if (!model) return;

    for (const b of model.batches) {
      b.positionBuffer.destroy();
      b.normalBuffer.destroy();
      b.recordIndexBuffer.destroy();
      b.opaqueIndexBuffer?.destroy();
      b.transparentIndexBuffer?.destroy();
    }
    model.batches.length = 0;

    this.numToModelId.delete(model.numericId);
    this.models.delete(modelId);

    if (this.selectedRef?.modelId === modelId) {
      this.selectedRef = null;
    }

    if (this.models.size === 0) {
      this.hasFramedInitialModel = false;
      this.shrinkDynamicBuffersIfEmpty();
    }

    this.recordLayoutDirty = true;
    this.requestRender();
  }

  private shrinkDynamicBuffersIfEmpty(): void {
    if (!this.device) return;
    let rebind = false;

    if (this.batchGpuCapacity > 64) {
      this.batchGpuBuffer?.destroy();
      this.batchGpuCapacity = 64;
      this.batchGpuBuffer = this.device.createBuffer({
        label: 'gubim-batch-buffer',
        size: this.batchGpuCapacity * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.batchCpuBuffer = new ArrayBuffer(64 * 16);
      this.batchF32 = new Float32Array(this.batchCpuBuffer);
      this.batchU32 = new Uint32Array(this.batchCpuBuffer);
      rebind = true;
    }

    if (this.recordGpuCapacity > 64) {
      this.recordGpuBuffer?.destroy();
      this.recordGpuCapacity = 64;
      this.recordGpuBuffer = this.device.createBuffer({
        label: 'gubim-record-buffer',
        size: this.recordGpuCapacity * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.recordCpuWords = new Uint32Array(64 * 4);
      rebind = true;
    }

    if (rebind) {
      this.recreateBindGroup();
    }
  }

  setModelVisibility(modelId: ModelId, visible: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (model.visible === visible) return;
    model.visible = visible;
    this.requestRender();
  }

  setElementVisibility(refs: readonly ElementRef[], visible: boolean): void {
    let anyChanged = false;
    for (const ref of refs) {
      const model = this.models.get(ref.modelId);
      if (!model) continue;
      model.displayEntries.set(ref.expressId, visible ? 'visible' : 'hidden');
      const recIndices = model.expressIdToRecords.get(ref.expressId);
      if (!recIndices || recIndices.length === 0) continue;

      for (const rIdx of recIndices) {
        if (refreshDisplayFlags(model, rIdx)) {
          this.writeSingleRecordStateToGpu(model.recordBaseOffset + rIdx, model, rIdx);
          anyChanged = true;
        }
      }
    }

    if (anyChanged) {
      this.requestRender();
    }
  }

  setElementDisplay(
    modelId: ModelId,
    others: ElementDisplay,
    entries: ReadonlyMap<number, ElementDisplay>
  ): void {
    const model = this.models.get(modelId);
    if (!model) return;
    setDisplay(model, others, entries);

    let anyChanged = false;
    const recordCount = model.recordWords.length / 4;
    for (let rIdx = 0; rIdx < recordCount; rIdx++) {
      if (refreshDisplayFlags(model, rIdx)) anyChanged = true;
    }
    // One upload of the whole table next frame, not one write per record.
    if (anyChanged) {
      this.recordLayoutDirty = true;
      this.requestRender();
    }
  }

  setElementColors(modelId: ModelId, colors: ReadonlyMap<number, number>): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (setColors(model, colors)) {
      this.recordLayoutDirty = true;
      this.requestRender();
    }
  }

  setSectionPlanes(planes: readonly SectionPlane[]): void {
    this.sectionPlanes = keptSectionPlanes(planes);
    this.requestRender();
  }

  /** Whether any record may be a ghost, so the ghost pass has something to draw. */
  private mayHaveGhosts(): boolean {
    for (const model of this.models.values()) {
      if (model.visible && model.displayMayGhost) return true;
    }
    return false;
  }

  setSelection(ref: ElementRef | null): void {
    const prev = this.selectedRef;
    if (
      prev === ref ||
      (prev !== null &&
        ref !== null &&
        prev.modelId === ref.modelId &&
        prev.expressId === ref.expressId)
    ) {
      return;
    }

    this.selectedRef = ref ? { modelId: ref.modelId, expressId: ref.expressId, globalId: ref.globalId } : null;

    if (prev) {
      this.updateElementSelectionFlag(prev.modelId, prev.expressId, false);
    }
    if (ref) {
      this.updateElementSelectionFlag(ref.modelId, ref.expressId, true);
    }

    this.requestRender();
  }

  private updateElementSelectionFlag(modelId: ModelId, expressId: number, selected: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    const recIndices = model.expressIdToRecords.get(expressId);
    if (!recIndices) return;

    for (const rIdx of recIndices) {
      const wordIdx = rIdx * 4 + 3;
      const prevFlags = model.recordWords[wordIdx];
      const nextFlags = selected
        ? ((prevFlags | FLAG_SELECTED) >>> 0)
        : ((prevFlags & ~FLAG_SELECTED) >>> 0);
      if (prevFlags !== nextFlags) {
        model.recordWords[wordIdx] = nextFlags;
        this.writeSingleRecordStateToGpu(model.recordBaseOffset + rIdx, model, rIdx);
      }
    }
  }

  private writeSingleRecordStateToGpu(
    globalRecordIndex: number,
    model: ModelEntry,
    modelRecordIndex: number
  ): void {
    if (!this.device || !this.recordGpuBuffer || this.recordLayoutDirty) return;
    const cpuBase = globalRecordIndex * 4;
    const modelBase = modelRecordIndex * 4;
    if (cpuBase + 4 > this.recordCpuWords.length) return;

    this.recordCpuWords[cpuBase] = model.recordWords[modelBase];
    this.recordCpuWords[cpuBase + 1] = model.recordWords[modelBase + 1];
    this.recordCpuWords[cpuBase + 2] = model.recordWords[modelBase + 2];
    this.recordCpuWords[cpuBase + 3] = model.recordWords[modelBase + 3];

    this.device.queue.writeBuffer(
      this.recordGpuBuffer,
      globalRecordIndex * 16,
      this.recordCpuWords.buffer,
      cpuBase * 4,
      16
    );
  }

  private computeVisibleBounds(): ModelBounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let found = false;

    for (const model of this.models.values()) {
      if (!model.visible || !model.bounds.valid) continue;
      if (model.bounds.minX < minX) minX = model.bounds.minX;
      if (model.bounds.minY < minY) minY = model.bounds.minY;
      if (model.bounds.minZ < minZ) minZ = model.bounds.minZ;
      if (model.bounds.maxX > maxX) maxX = model.bounds.maxX;
      if (model.bounds.maxY > maxY) maxY = model.bounds.maxY;
      if (model.bounds.maxZ > maxZ) maxZ = model.bounds.maxZ;
      found = true;
    }

    if (!found) {
      for (const model of this.models.values()) {
        if (!model.bounds.valid) continue;
        if (model.bounds.minX < minX) minX = model.bounds.minX;
        if (model.bounds.minY < minY) minY = model.bounds.minY;
        if (model.bounds.minZ < minZ) minZ = model.bounds.minZ;
        if (model.bounds.maxX > maxX) maxX = model.bounds.maxX;
        if (model.bounds.maxY > maxY) maxY = model.bounds.maxY;
        if (model.bounds.maxZ > maxZ) maxZ = model.bounds.maxZ;
        found = true;
      }
    }

    if (!found) return null;
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ }
    };
  }

  setViewPreset(preset: ViewPreset): void {
    const bounds = this.computeVisibleBounds();
    this.camera.setPreset(preset, bounds);
    this.requestRender();
  }

  fitToView(): void {
    const bounds = this.computeVisibleBounds();
    if (bounds) {
      this.camera.fitToBounds(bounds);
    }
    this.requestRender();
  }

  fitToBounds(bounds: ModelBounds, keepAngles = false): void {
    this.camera.fitToBounds(bounds, keepAngles);
    this.requestRender();
  }

  getCameraPose(): CameraPose {
    return this.camera.getPose();
  }

  setCameraPose(pose: CameraPose): void {
    this.camera.setPose(pose);
    this.requestRender();
  }

  getProjection(): CameraProjection {
    return this.camera.getProjection();
  }

  setProjection(projection: CameraProjection): void {
    if (this.camera.getProjection() === projection) return;
    this.camera.setProjection(projection);
    this.requestRender();
  }

  getNavigationMode(): NavigationMode {
    return this.navigationMode;
  }

  setNavigationMode(mode: NavigationMode): void {
    if (mode !== 'orbit' && mode !== 'first-person') return;
    this.navigationMode = mode;
    if (this.canvas) this.canvas.style.cursor = this.idleCursor();
  }

  private requestRender(): void {
    if (this.isDestroyed || !this.device || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.renderFrame();
    });
  }

  private updateGpuSceneTables(): number {
    if (!this.device || !this.sceneUniformBuffer) return 0;

    // 1. Upload records appended to the last model, or rebuild the table if models moved
    if (!this.recordLayoutDirty && this.recordAppendFrom < this.recordTotal) {
      const tail = this.recordTail;
      if (!tail || !this.recordGpuBuffer || this.recordTotal > this.recordGpuCapacity) {
        this.recordLayoutDirty = true;
      } else {
        const from = this.recordAppendFrom;
        const words = tail.recordWords;
        const dstStart = tail.recordBaseOffset * 4;
        for (let i = (from - tail.recordBaseOffset) * 4; i < words.length; i++) {
          this.recordCpuWords[dstStart + i] = words[i];
        }
        this.device.queue.writeBuffer(
          this.recordGpuBuffer,
          from * 16,
          this.recordCpuWords.buffer,
          from * 16,
          (this.recordTotal - from) * 16
        );
        this.recordAppendFrom = this.recordTotal;
      }
    }

    if (this.recordLayoutDirty) {
      let totalRecords = 0;
      let tail: ModelEntry | null = null;
      for (const model of this.models.values()) {
        model.recordBaseOffset = totalRecords;
        totalRecords += model.recordWords.length / 4;
        tail = model;
      }

      const requiredCapacity = Math.max(64, totalRecords);
      if (requiredCapacity > this.recordGpuCapacity || !this.recordGpuBuffer) {
        let nextCap = Math.max(64, this.recordGpuCapacity);
        while (nextCap < requiredCapacity) nextCap *= 2;
        this.recordGpuBuffer?.destroy();
        this.recordGpuCapacity = nextCap;
        this.recordGpuBuffer = this.device.createBuffer({
          label: 'gubim-record-buffer',
          size: this.recordGpuCapacity * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.recordCpuWords = new Uint32Array(this.recordGpuCapacity * 4);
        this.recreateBindGroup();
      } else if (this.recordCpuWords.length < requiredCapacity * 4) {
        this.recordCpuWords = new Uint32Array(this.recordGpuCapacity * 4);
      }

      for (const model of this.models.values()) {
        const dstStart = model.recordBaseOffset * 4;
        const words = model.recordWords;
        for (let i = 0; i < words.length; i++) {
          this.recordCpuWords[dstStart + i] = words[i];
        }
      }

      if (totalRecords > 0 && this.recordGpuBuffer) {
        this.device.queue.writeBuffer(
          this.recordGpuBuffer,
          0,
          this.recordCpuWords.buffer,
          0,
          totalRecords * 16
        );
      }
      this.recordTotal = totalRecords;
      this.recordAppendFrom = totalRecords;
      this.recordTail = tail;
      this.recordLayoutDirty = false;
    }

    // 2. Write camera projection + rotation-only view matrix, and the sections for this eye
    const eye = this.camera.getEye();
    this.camera.writeUniforms(this.sceneUniformData);
    writeSectionPlanes(this.sectionPlanes, eye, this.sceneUniformData, 32);
    this.device.queue.writeBuffer(
      this.sceneUniformBuffer,
      0,
      this.sceneUniformData.buffer,
      0,
      this.sceneUniformData.byteLength
    );

    // 3. Compute (batch.origin - camera.eye) in f64 on CPU, convert to f32, and write in ONE writeBuffer
    let totalBatches = 0;
    for (const model of this.models.values()) {
      totalBatches += model.batches.length;
    }

    if (totalBatches === 0) return 0;

    if (totalBatches > this.batchGpuCapacity || !this.batchGpuBuffer) {
      let nextCap = Math.max(64, this.batchGpuCapacity);
      while (nextCap < totalBatches) nextCap *= 2;
      this.batchGpuBuffer?.destroy();
      this.batchGpuCapacity = nextCap;
      this.batchGpuBuffer = this.device.createBuffer({
        label: 'gubim-batch-buffer',
        size: this.batchGpuCapacity * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.batchCpuBuffer = new ArrayBuffer(this.batchGpuCapacity * 16);
      this.batchF32 = new Float32Array(this.batchCpuBuffer);
      this.batchU32 = new Uint32Array(this.batchCpuBuffer);
      this.recreateBindGroup();
    }

    const eyeX = eye[0];
    const eyeY = eye[1];
    const eyeZ = eye[2];

    let bIdx = 0;
    for (const model of this.models.values()) {
      const visMask = model.visible ? 0x80000000 : 0;
      const modelRecBase = model.recordBaseOffset;

      for (const batch of model.batches) {
        const base = bIdx * 4;
        // Subtract in f64 on CPU, then store as f32
        this.batchF32[base] = batch.origin[0] - eyeX;
        this.batchF32[base + 1] = batch.origin[1] - eyeY;
        this.batchF32[base + 2] = batch.origin[2] - eyeZ;

        const recordBase = (modelRecBase + batch.recordOffsetInModel) & 0x7fffffff;
        this.batchU32[base + 3] = (recordBase | visMask) >>> 0;
        bIdx++;
      }
    }

    this.device.queue.writeBuffer(this.batchGpuBuffer, 0, this.batchCpuBuffer, 0, totalBatches * 16);
    return totalBatches;
  }

  renderFrame(): void {
    if (
      this.isDestroyed ||
      !this.device ||
      !this.context ||
      !this.opaquePipeline ||
      !this.closedPipeline ||
      !this.transparentPipeline ||
      !this.sceneBindGroup ||
      !this.depthTextureView
    ) {
      return;
    }

    const t0 = performance.now();
    this.uploadQueuedBatches();
    this.updateGpuSceneTables();
    this.drawnBatches = markBatchesInView(this.models.values(), this.camera.frustum(), this.camera.getEye());

    const colorView = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      label: 'gubim-main-render-pass',
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.06, g: 0.07, b: 0.09, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: this.depthTextureView,
        depthClearValue: 0.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });

    pass.setBindGroup(0, this.sceneBindGroup);

    // Pass 1: Opaque geometry
    let batchIdx = 0;
    let hasTransparent = false;

    for (const model of this.models.values()) {
      if (!model.visible) {
        batchIdx += model.batches.length;
        continue;
      }
      for (const batch of model.batches) {
        if (!batch.inView) {
          batchIdx++;
          continue;
        }
        if (batch.transparentIndexCount > 0) {
          hasTransparent = true;
        }
        if (batch.opaqueIndexCount > 0 && batch.opaqueIndexBuffer) {
          pass.setVertexBuffer(0, batch.positionBuffer);
          pass.setVertexBuffer(1, batch.normalBuffer);
          pass.setVertexBuffer(2, batch.recordIndexBuffer);
          this.drawOpaque(pass, batch, batchIdx, this.closedPipeline, this.opaquePipeline);
        }
        batchIdx++;
      }
    }

    // Pass 2: Transparent geometry
    if (hasTransparent) {
      pass.setPipeline(this.transparentPipeline);
      batchIdx = 0;
      for (const model of this.models.values()) {
        if (!model.visible) {
          batchIdx += model.batches.length;
          continue;
        }
        for (const batch of model.batches) {
          if (batch.inView && batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            pass.setVertexBuffer(0, batch.positionBuffer);
            pass.setVertexBuffer(1, batch.normalBuffer);
            pass.setVertexBuffer(2, batch.recordIndexBuffer);
            pass.setIndexBuffer(batch.transparentIndexBuffer, 'uint32');
            pass.drawIndexed(batch.transparentIndexCount, 1, 0, 0, batchIdx);
          }
          batchIdx++;
        }
      }
    }

    // Pass 3: Ghosts, faint over everything else, whether their element is opaque or not
    if (this.ghostPipeline && this.mayHaveGhosts()) {
      pass.setPipeline(this.ghostPipeline);
      batchIdx = 0;
      for (const model of this.models.values()) {
        if (!model.visible) {
          batchIdx += model.batches.length;
          continue;
        }
        for (const batch of model.batches) {
          if (!batch.inView) {
            batchIdx++;
            continue;
          }
          pass.setVertexBuffer(0, batch.positionBuffer);
          pass.setVertexBuffer(1, batch.normalBuffer);
          pass.setVertexBuffer(2, batch.recordIndexBuffer);
          if (batch.opaqueIndexCount > 0 && batch.opaqueIndexBuffer) {
            pass.setIndexBuffer(batch.opaqueIndexBuffer, 'uint32');
            pass.drawIndexed(batch.opaqueIndexCount, 1, 0, 0, batchIdx);
          }
          if (batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            pass.setIndexBuffer(batch.transparentIndexBuffer, 'uint32');
            pass.drawIndexed(batch.transparentIndexCount, 1, 0, 0, batchIdx);
          }
          batchIdx++;
        }
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.renderCount++;
    this.lastFrameCpuMs = performance.now() - t0;
    this.handlers.onFrame?.();
  }

  /**
   * Draws a batch's opaque indices, its vertex buffers already set: those of closed meshes
   * through `closed`, which culls back faces, and the rest through `open`. A section plane may
   * open a closed mesh up, so while one is set every index goes through `open`.
   */
  private drawOpaque(
    pass: GPURenderPassEncoder,
    batch: GpuBatchEntry,
    batchIdx: number,
    closed: GPURenderPipeline,
    open: GPURenderPipeline
  ): void {
    if (batch.opaqueIndexCount === 0 || !batch.opaqueIndexBuffer) return;
    const culled = this.sectionPlanes.length === 0 ? batch.closedIndexCount : 0;
    pass.setIndexBuffer(batch.opaqueIndexBuffer, 'uint32');
    if (culled > 0) {
      pass.setPipeline(closed);
      pass.drawIndexed(culled, 1, 0, 0, batchIdx);
    }
    if (batch.opaqueIndexCount > culled) {
      pass.setPipeline(open);
      pass.drawIndexed(batch.opaqueIndexCount - culled, 1, culled, 0, batchIdx);
    }
  }

  /** One at a time, in order: each waits for the last to read back. */
  pick(cssX: number, cssY: number): Promise<ElementRef | null> {
    const result = this.pickQueue.then(() => this.pickOnce(cssX, cssY));
    this.pickQueue = result.catch(() => null);
    return result;
  }

  setPointerMode(mode: PointerMode): void {
    this.pointerMode = mode;
    if (this.canvas) this.canvas.style.cursor = this.idleCursor();
  }

  private idleCursor(): string {
    return this.pointerMode === 'measure' ? 'crosshair' : 'grab';
  }

  rayAt(x: number, y: number): Ray | null {
    return this.canvas && this.device ? canvasRay(this.camera, this.canvas, x, y) : null;
  }

  project(point: Vec3): { x: number; y: number } | null {
    return this.canvas && this.device ? canvasPoint(this.camera, this.canvas, point) : null;
  }

  /**
   * Offscreen GPU ID-texture picking at CSS coordinates (cssX, cssY) relative to the canvas.
   * Returns the picked ElementRef { modelId, expressId }, or null on background.
   */
  private async pickOnce(cssX: number, cssY: number): Promise<ElementRef | null> {
    if (
      this.isDestroyed ||
      this.isPicking ||
      !this.device ||
      !this.canvas ||
      !this.pickPipeline ||
      !this.closedPickPipeline ||
      !this.sceneBindGroup ||
      !this.idTexture ||
      !this.idTextureView ||
      !this.depthTextureView ||
      !this.pickReadBuffer
    ) {
      return null;
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
    const px = Math.max(0, Math.min(this.canvas.width - 1, Math.floor(cssX * scaleX)));
    const py = Math.max(0, Math.min(this.canvas.height - 1, Math.floor(cssY * scaleY)));

    this.isPicking = true;
    try {
      this.updateGpuSceneTables();

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        label: 'gubim-pick-render-pass',
        colorAttachments: [
          {
            view: this.idTextureView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store'
          }
        ],
        depthStencilAttachment: {
          view: this.depthTextureView,
          depthClearValue: 0.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store'
        }
      });

      pass.setScissorRect(px, py, 1, 1);
      pass.setBindGroup(0, this.sceneBindGroup);

      // Only batches whose box reaches the pixel can draw in it.
      const pixelView = this.camera.frustum(pixelWindow(px, py, this.canvas.width, this.canvas.height));
      const eye = this.camera.getEye();
      this.pickedBatches = 0;
      let batchIdx = 0;
      for (const model of this.models.values()) {
        if (!model.visible) {
          batchIdx += model.batches.length;
          continue;
        }
        for (const batch of model.batches) {
          if (!boxMayShow(pixelView, batch.min, batch.max, eye)) {
            batchIdx++;
            continue;
          }
          this.pickedBatches++;
          pass.setVertexBuffer(0, batch.positionBuffer);
          pass.setVertexBuffer(1, batch.normalBuffer);
          pass.setVertexBuffer(2, batch.recordIndexBuffer);
          this.drawOpaque(pass, batch, batchIdx, this.closedPickPipeline, this.pickPipeline);
          if (batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            pass.setPipeline(this.pickPipeline);
            pass.setIndexBuffer(batch.transparentIndexBuffer, 'uint32');
            pass.drawIndexed(batch.transparentIndexCount, 1, 0, 0, batchIdx);
          }
          batchIdx++;
        }
      }

      pass.end();

      encoder.copyTextureToBuffer(
        { texture: this.idTexture, origin: { x: px, y: py, z: 0 } },
        { buffer: this.pickReadBuffer, offset: 0, bytesPerRow: 256 },
        { width: 1, height: 1, depthOrArrayLayers: 1 }
      );

      this.device.queue.submit([encoder.finish()]);

      await this.pickReadBuffer.mapAsync(GPUMapMode.READ, 0, 16);
      const u32 = new Uint32Array(this.pickReadBuffer.getMappedRange(0, 16));
      const modelNum = u32[0];
      const expressId = u32[1];
      this.pickReadBuffer.unmap();

      if (modelNum === 0 || expressId === 0) {
        return null;
      }

      const modelId = this.numToModelId.get(modelNum);
      if (!modelId) return null;

      return { modelId, expressId };
    } catch (err) {
      console.warn('Pick error:', err);
      return null;
    } finally {
      this.isPicking = false;
    }
  }

  /** Used by dev-only harness tests to orbit/inspect camera and GPU resource metrics. */
  orbitCamera(dx: number, dy: number): void {
    this.camera.orbit(dx, dy);
    this.renderFrame();
  }

  async waitForGpuIdle(): Promise<void> {
    if (this.device) {
      await this.device.queue.onSubmittedWorkDone();
    }
  }

  getDebugStats(): RendererDebugStats {
    let batchCount = 0;
    let recordCount = 0;
    let liveGpuBuffers = 0;
    let allocatedGpuBytes = 0;

    if (this.sceneUniformBuffer) {
      liveGpuBuffers++;
      allocatedGpuBytes += this.sceneUniformBuffer.size;
    }
    if (this.batchGpuBuffer) {
      liveGpuBuffers++;
      allocatedGpuBytes += this.batchGpuBuffer.size;
    }
    if (this.recordGpuBuffer) {
      liveGpuBuffers++;
      allocatedGpuBytes += this.recordGpuBuffer.size;
    }
    if (this.pickReadBuffer) {
      liveGpuBuffers++;
      allocatedGpuBytes += this.pickReadBuffer.size;
    }

    for (const model of this.models.values()) {
      batchCount += model.batches.length;
      recordCount += model.recordWords.length / 4;
      for (const b of model.batches) {
        liveGpuBuffers += 3; // position, normal, recordIndex
        if (b.opaqueIndexBuffer) liveGpuBuffers++;
        if (b.transparentIndexBuffer) liveGpuBuffers++;
        allocatedGpuBytes += b.gpuBytes;
      }
    }

    return {
      modelCount: this.models.size,
      batchCount,
      recordCount,
      liveGpuBuffers,
      allocatedGpuBytes,
      renderCount: this.renderCount,
      lastFrameCpuMs: this.lastFrameCpuMs,
      drawnBatches: this.drawnBatches,
      pickedBatches: this.pickedBatches
    };
  }

  private releaseGpuDeviceAndListeners(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.deviceLostBanner) {
      this.deviceLostBanner.remove();
      this.deviceLostBanner = null;
    }

    for (const model of this.models.values()) {
      for (const b of model.batches) {
        b.positionBuffer.destroy();
        b.normalBuffer.destroy();
        b.recordIndexBuffer.destroy();
        b.opaqueIndexBuffer?.destroy();
        b.transparentIndexBuffer?.destroy();
      }
      model.batches.length = 0;
      model.recordWords.length = 0;
      model.expressIdToRecords.clear();
    }

    this.sceneUniformBuffer?.destroy();
    this.sceneUniformBuffer = null;

    this.batchGpuBuffer?.destroy();
    this.batchGpuBuffer = null;
    this.batchGpuCapacity = 0;

    this.recordGpuBuffer?.destroy();
    this.recordGpuBuffer = null;
    this.recordGpuCapacity = 0;

    this.pickReadBuffer?.destroy();
    this.pickReadBuffer = null;

    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthTextureView = null;

    this.idTexture?.destroy();
    this.idTexture = null;
    this.idTextureView = null;

    try {
      this.context?.unconfigure();
    } catch {
      // ignore unconfigure errors on teardown
    }
    this.context = null;

    try {
      this.device?.destroy();
    } catch {
      // ignore device destroy errors
    }
    this.device = null;

    this.bindGroupLayout = null;
    this.sceneBindGroup = null;
    this.opaquePipeline = null;
    this.transparentPipeline = null;
    this.ghostPipeline = null;
    this.pickPipeline = null;
    this.closedPipeline = null;
    this.closedPickPipeline = null;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.initGeneration++;
    this.preInitQueue.length = 0;
    this.uploadQueue.length = 0;
    this.pendingFinishBounds.clear();
    this.hasFramedInitialModel = false;
    this.releaseGpuDeviceAndListeners();
    this.models.clear();
    this.numToModelId.clear();
  }
}
