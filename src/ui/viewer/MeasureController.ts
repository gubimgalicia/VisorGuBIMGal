import type { KernelPort } from '../../domain/kernel/KernelPort';
import type { RendererPort, SectionPlane } from '../../domain/kernel/RendererPort';
import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';
import { snap, snapMesh, VERTEX_RADIUS, type Snap, type SnapMesh } from '../../domain/measure/snap';
import {
  addPoint,
  canClose,
  closeArea,
  startMeasurement,
  type MeasureKind,
  type Measurement
} from './measure';

export interface MeasureState {
  /** The tool in use; null while clicks select. */
  kind: MeasureKind | null;
  /** The measurement being marked, with the points so far. */
  draft: Measurement | null;
  measurements: readonly Measurement[];
  /** Where a click would put the next point. */
  hover: Snap | null;
}

/** Element meshes kept for snapping, most recent last. */
const CACHED_MESHES = 8;

/** Offsets in CSS pixels tried in turn when nothing is drawn right under the pointer. */
const PROBES: readonly (readonly [number, number])[] = [
  [0, 0],
  [VERTEX_RADIUS / 2, 0],
  [-VERTEX_RADIUS / 2, 0],
  [0, VERTEX_RADIUS / 2],
  [0, -VERTEX_RADIUS / 2]
];

type Position = { x: number; y: number };

/**
 * The measuring tool, outside React so the overlay can redraw every frame on its own. Points
 * snap to what the renderer draws under the pointer, through the kernel's mesh of that element.
 */
export class MeasureController {
  private readonly renderer: RendererPort;
  private readonly kernel: KernelPort;
  private state: MeasureState = { kind: null, draft: null, measurements: [], hover: null };
  private readonly listeners = new Set<() => void>();
  private readonly frameListeners = new Set<() => void>();
  private readonly meshes = new Map<string, Promise<SnapMesh | null>>();
  private planes: readonly SectionPlane[] = [];
  private nextId = 1;
  /** Bumped whenever the tool changes, so answers that arrive late are dropped. */
  private generation = 0;
  private hovering = false;
  /** The latest position asked for while a hover ran; undefined when none. */
  private pendingHover: Position | null | undefined = undefined;
  /** Clicks in order: a second must not land before the first. */
  private clicks: Promise<void> = Promise.resolve();

  constructor(renderer: RendererPort, kernel: KernelPort) {
    this.renderer = renderer;
    this.kernel = kernel;
  }

  getState = (): MeasureState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called after every drawn frame. */
  subscribeFrame = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  frame = (): void => {
    for (const listener of this.frameListeners) listener();
  };

  private set(patch: Partial<MeasureState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  setKind(kind: MeasureKind | null): void {
    this.generation += 1;
    this.renderer.setPointerMode(kind ? 'measure' : 'select');
    this.set({ kind, draft: kind ? startMeasurement(kind, this.nextId++) : null, hover: null });
  }

  setPlanes(planes: readonly SectionPlane[]): void {
    this.planes = planes;
  }

  /** Drops the meshes of a closed model. Measurements stay: they are only points. */
  forgetModel(modelId: ModelId): void {
    for (const key of [...this.meshes.keys()]) {
      if (key.startsWith(`${modelId}#`)) this.meshes.delete(key);
    }
  }

  remove(id: number): void {
    this.set({ measurements: this.state.measurements.filter((m) => m.id !== id) });
  }

  clear(): void {
    this.generation += 1;
    const { kind } = this.state;
    this.set({ measurements: [], draft: kind ? startMeasurement(kind, this.nextId++) : null, hover: null });
  }

  /** Starts the measurement in hand again, keeping the tool. */
  cancelDraft(): void {
    const { kind } = this.state;
    if (kind) this.set({ draft: startMeasurement(kind, this.nextId++) });
  }

  /** Finishes an area from the points marked so far, if there are enough. */
  closeDraft(): void {
    const { draft, kind } = this.state;
    const closed = draft && closeArea(draft);
    if (!closed || !kind) return;
    this.set({
      measurements: [...this.state.measurements, closed],
      draft: startMeasurement(kind, this.nextId++)
    });
  }

  /** A click in measure mode. */
  point = (x: number, y: number): Promise<void> => {
    this.clicks = this.clicks.then(() => this.addAt(x, y)).catch((error) => {
      console.error('Error al medir:', error);
    });
    return this.clicks;
  };

  private async addAt(x: number, y: number): Promise<void> {
    const { draft } = this.state;
    if (!draft) return;
    // Clicking the first corner again closes an area.
    if (canClose(draft)) {
      const first = this.renderer.project(draft.points[0]);
      if (first && Math.hypot(first.x - x, first.y - y) <= VERTEX_RADIUS) {
        this.closeDraft();
        return;
      }
    }
    const generation = this.generation;
    const found = await this.resolve(x, y);
    const current = this.state.draft;
    if (!found || generation !== this.generation || !current || current.id !== draft.id) return;
    const step = addPoint(current, found.point);
    if (step.done) {
      this.set({
        measurements: [...this.state.measurements, step.done],
        draft: startMeasurement(step.done.kind, this.nextId++)
      });
    } else {
      this.set({ draft: step.draft });
    }
  }

  /** The mouse in measure mode; positions that arrive while one is worked out wait their turn. */
  hover = (at: Position | null): void => {
    if (this.hovering) {
      this.pendingHover = at;
      return;
    }
    void this.runHover(at);
  };

  private async runHover(at: Position | null): Promise<void> {
    this.hovering = true;
    try {
      let next: Position | null | undefined = at;
      while (next !== undefined) {
        this.pendingHover = undefined;
        const generation = this.generation;
        const found = next ? await this.resolve(next.x, next.y) : null;
        if (generation === this.generation && this.state.kind) this.set({ hover: found });
        next = this.pendingHover;
      }
    } catch (error) {
      console.error('Error al medir:', error);
    } finally {
      this.hovering = false;
    }
  }

  private async resolve(x: number, y: number): Promise<Snap | null> {
    let ref: ElementRef | null = null;
    if (this.renderer.pickFirst) {
      // One pick pass for every probe (A15).
      ref = (await this.renderer.pickFirst(x, y, PROBES))?.ref ?? null;
    } else {
      for (const [dx, dy] of PROBES) {
        ref = await this.renderer.pick(x + dx, y + dy);
        if (ref) break;
      }
    }
    if (!ref) return null;
    const mesh = await this.mesh(ref);
    if (!mesh) return null;
    const viewport = {
      project: (point: Snap['point']) => this.renderer.project(point),
      rayAt: (px: number, py: number) => this.renderer.rayAt(px, py)
    };
    return snap(mesh, viewport, { x, y }, this.planes);
  }

  private mesh({ modelId, expressId }: ElementRef): Promise<SnapMesh | null> {
    const key = `${modelId}#${expressId}`;
    let entry = this.meshes.get(key);
    if (entry) {
      this.meshes.delete(key);
    } else {
      entry = this.kernel.elementMesh(modelId, expressId).then(
        (mesh) => mesh && snapMesh(mesh),
        () => {
          this.meshes.delete(key);
          return null;
        }
      );
    }
    this.meshes.set(key, entry);
    while (this.meshes.size > CACHED_MESHES) {
      this.meshes.delete(this.meshes.keys().next().value as string);
    }
    return entry;
  }
}
