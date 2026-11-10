import type { ElementRef, ModelBounds, ModelId } from '../models/ModelRecord';
import type { GeometryBatch } from './GeometryBatch';
import type { Ray, Vec3 } from '../measure/geometry';

export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'side' | 'right' | 'left';

export type CameraProjection = 'perspective' | 'orthographic';

export type NavigationMode = 'orbit' | 'first-person';

export interface RendererDebugStats {
  modelCount: number;
  batchCount: number;
  recordCount: number;
  liveGpuBuffers: number;
  allocatedGpuBytes: number;
  renderCount: number;
  lastFrameCpuMs: number;
  drawnBatches: number;
  pickedBatches: number;
}

export interface CameraPose {
  target: readonly [number, number, number];
  distance: number;
  azimuth: number;
  elevation: number;
  projection?: CameraProjection;
}

/**
 * How an element is drawn. 'default' is its own state: hidden if HiddenByDefault, else visible.
 * A ghost is drawn faint and cannot be picked; a HiddenByDefault element is never a ghost and
 * stays hidden instead.
 */
export type ElementDisplay = 'default' | 'visible' | 'ghost' | 'hidden';

/**
 * One half-space of a section, in absolute model coordinates (metres, IFC Z-up): it keeps the
 * points p with dot(normal, p) <= offset and cuts away the side the normal points to.
 */
export interface SectionPlane {
  normal: readonly [number, number, number];
  offset: number;
}

/** A section box takes six planes; no more are drawn. */
export const MAX_SECTION_PLANES = 6;

/** 'measure': a click reports a point instead of selecting, and the mouse is followed. */
export type PointerMode = 'select' | 'measure';

/** Canvas positions are CSS pixels from the canvas's top left. */
export interface RendererEventHandlers {
  onSelect?: (ref: ElementRef | null) => void;
  onHover?: (ref: ElementRef | null) => void;
  /** In 'measure' mode, a click; nothing is selected. */
  onPoint?: (x: number, y: number) => void;
  /** In 'measure' mode, a mouse moving over the canvas with no button down; null once it leaves. */
  onPointerMove?: (at: { x: number; y: number } | null) => void;
  /** After each drawn frame, so an overlay can follow the camera and the canvas size. */
  onFrame?: () => void;
}

/**
 * Drawing surface. Knows nothing about IFC: it receives batches and identities only.
 * It keeps no JS copy of a batch once uploaded, so geometry lives in one place, the GPU.
 */
export interface RendererPort {
  /** Rejects with a user-readable message when no supported graphics API exists. */
  initialize(canvas: HTMLCanvasElement): Promise<void>;
  setHandlers(handlers: RendererEventHandlers): void;

  addModel(modelId: ModelId): void;
  addBatch(batch: GeometryBatch): void;
  /** Frames the scene if this is the first visible model. */
  finishModel(modelId: ModelId, bounds: ModelBounds | undefined): void;
  /** Destroys the model's GPU resources. Survivors are not re-uploaded. */
  removeModel(modelId: ModelId): void;

  setModelVisibility(modelId: ModelId, visible: boolean): void;
  setElementVisibility(refs: readonly ElementRef[], visible: boolean): void;
  /**
   * Replaces how every element of the model is drawn, including batches still to come: the
   * elements in `entries`, by expressId, take their entry and the rest take `others`.
   */
  setElementDisplay(
    modelId: ModelId,
    others: ElementDisplay,
    entries: ReadonlyMap<number, ElementDisplay>
  ): void;
  /**
   * Overrides the RGB color of the listed elements in `modelId` (preserving each mesh's alpha).
   * An empty map restores every element's original IFC material color.
   */
  setElementColors(modelId: ModelId, colors: ReadonlyMap<number, number>): void;
  setSelection(ref: ElementRef | null): void;
  /**
   * Cuts every model: only points that all planes keep are drawn or picked, ghosts included.
   * An empty list removes the section. Planes past MAX_SECTION_PLANES are ignored.
   */
  setSectionPlanes(planes: readonly SectionPlane[]): void;

  setViewPreset(preset: ViewPreset): void;
  fitToView(): void;
  fitToBounds(bounds: ModelBounds, keepAngles?: boolean): void;
  getCameraPose(): CameraPose | null;
  setCameraPose(pose: CameraPose): void;
  getProjection(): CameraProjection;
  setProjection(projection: CameraProjection): void;
  getNavigationMode(): NavigationMode;
  setNavigationMode(mode: NavigationMode): void;
  getDebugStats(): RendererDebugStats;

  /** 'select' until changed. */
  setPointerMode(mode: PointerMode): void;
  /**
   * The element drawn at a canvas position, as a click would select it: ghosts and what the
   * section cuts away are passed through. Null over the background or before initialize.
   */
  pick(x: number, y: number): Promise<ElementRef | null>;
  /** The ray from the eye through a canvas position, in absolute model coordinates. */
  rayAt(x: number, y: number): Ray | null;
  /** Where an absolute point shows on the canvas; null behind the eye or before initialize. */
  project(point: Vec3): { x: number; y: number } | null;

  /** Releases GPU resources and removes every listener it added. */
  destroy(): void;
}
