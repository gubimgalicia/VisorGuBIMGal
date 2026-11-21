import type { SectionPlane } from '../kernel/RendererPort';

/** A point or vector in absolute model coordinates: metres, IFC Z-up, f64. */
export type Vec3 = readonly [number, number, number];

/** From the eye through a point of the view. `direction` has unit length. */
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export interface Distance {
  length: number;
  /** In the XY plane. */
  horizontal: number;
  /** `b` minus `a`, per axis. */
  dx: number;
  dy: number;
  dz: number;
}

export function distanceBetween(a: Vec3, b: Vec3): Distance {
  const [dx, dy, dz] = sub(b, a);
  return { length: Math.hypot(dx, dy, dz), horizontal: Math.hypot(dx, dy), dx, dy, dz };
}

/**
 * Area of the polygon through the points in order, closed back to the first, measured on the
 * plane that fits it best (Newell's method): exact for a planar polygon in any orientation.
 * Null below three points.
 */
export function polygonArea(points: readonly Vec3[]): { area: number; perimeter: number } | null {
  if (points.length < 3) return null;
  // Relative to the first point, so coordinates far from the origin keep their precision.
  const base = points[0];
  let normal: Vec3 = [0, 0, 0];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    normal = add(normal, cross(sub(p, base), sub(q, base)));
    perimeter += length(sub(q, p));
  }
  return { area: length(normal) / 2, perimeter };
}

/** Angle at `vertex` between the legs to `a` and `c`, in degrees; null if a leg has no length. */
export function angleAt(a: Vec3, vertex: Vec3, c: Vec3): number | null {
  const u = sub(a, vertex);
  const v = sub(c, vertex);
  if (length(u) === 0 || length(v) === 0) return null;
  // atan2 keeps precision near 0 and 180 degrees, where acos does not.
  return (Math.atan2(length(cross(u, v)), dot(u, v)) * 180) / Math.PI;
}

/** Whether every plane keeps the point: the same test the renderer cuts with. */
export function keptBy(planes: readonly SectionPlane[], p: Vec3): boolean {
  return planes.every((plane) => dot(plane.normal, p) <= plane.offset);
}
