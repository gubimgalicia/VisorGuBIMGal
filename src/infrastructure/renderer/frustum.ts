import type { Vec3 } from '../../domain/measure/geometry';

/**
 * Six planes, four numbers each, `[nx, ny, nz, d]` in absolute model coordinates, f64: a
 * point p is in view when n·p + d >= 0 for every plane. See `Camera.frustum`.
 */
export type Frustum = Float64Array;

/** A rectangle of the view in normalised device coordinates, x right and y up, -1 to 1. */
export interface ViewWindow {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export const WHOLE_VIEW: ViewWindow = { left: -1, right: 1, bottom: -1, top: 1 };

/** What one pixel of a width × height view covers; x and y count from the top left. */
export function pixelWindow(x: number, y: number, width: number, height: number): ViewWindow {
  return {
    left: (2 * x) / width - 1,
    right: (2 * (x + 1)) / width - 1,
    bottom: 1 - (2 * (y + 1)) / height,
    top: 1 - (2 * y) / height
  };
}

/** The view window of a rectangle of pixels, top-left at (x, y), w by h. */
export function rectWindow(x: number, y: number, w: number, h: number, width: number, height: number): ViewWindow {
  return {
    left: (2 * x) / width - 1,
    right: (2 * (x + w)) / width - 1,
    bottom: 1 - (2 * (y + h)) / height,
    top: 1 - (2 * y) / height
  };
}

/**
 * Room left around a box, in metres. The GPU adds `origin − eye` and a position in f32, which
 * rounds by some 6e-8 of the distance to the eye; this is far more, and still under 1 mm per
 * 100 m.
 */
const ABSOLUTE_SLACK = 1e-3;
const RELATIVE_SLACK = 1e-5;

/** Whether any of the box, grown by the slack, is in view. False only when none of it shows. */
export function boxMayShow(frustum: Frustum, min: Vec3, max: Vec3, eye: Vec3): boolean {
  let reach = 0;
  for (let axis = 0; axis < 3; axis++) {
    reach = Math.max(reach, Math.abs(min[axis] - eye[axis]), Math.abs(max[axis] - eye[axis]));
  }
  const slack = ABSOLUTE_SLACK + RELATIVE_SLACK * reach;
  for (let at = 0; at < frustum.length; at += 4) {
    // The corner furthest along the plane's normal: if even it is behind, all of the box is.
    const nx = frustum[at];
    const ny = frustum[at + 1];
    const nz = frustum[at + 2];
    const x = nx >= 0 ? max[0] + slack : min[0] - slack;
    const y = ny >= 0 ? max[1] + slack : min[1] - slack;
    const z = nz >= 0 ? max[2] + slack : min[2] - slack;
    if (nx * x + ny * y + nz * z + frustum[at + 3] < 0) return false;
  }
  return true;
}

interface CullableModel {
  visible: boolean;
  batches: { min: Vec3; max: Vec3; inView: boolean }[];
}

/** Marks every batch in view or not, and returns how many are. A hidden model has none. */
export function markBatchesInView(models: Iterable<CullableModel>, frustum: Frustum, eye: Vec3): number {
  let inView = 0;
  for (const model of models) {
    for (const batch of model.batches) {
      batch.inView = model.visible && boxMayShow(frustum, batch.min, batch.max, eye);
      if (batch.inView) inView++;
    }
  }
  return inView;
}
