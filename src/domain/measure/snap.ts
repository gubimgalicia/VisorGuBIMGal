import type { ElementMesh } from '../kernel/KernelPort';
import type { SectionPlane } from '../kernel/RendererPort';
import { add, cross, dot, keptBy, length, scale, sub, type Ray, type Vec3 } from './geometry';

/** How close, in CSS pixels, the pointer must come to a corner or an edge to snap to it. */
export const VERTEX_RADIUS = 10;
export const EDGE_RADIUS = 8;

/** The kernel's mesh, with the corners a user can see: the ends of its edges. */
export interface SnapMesh extends ElementMesh {
  /** Vertex indices on at least one edge, ascending. */
  corners: Uint32Array;
}

/** What the view can tell about a point: where it shows, and the ray through a pixel. */
export interface Viewport {
  /** CSS pixels from the canvas's top left; null behind the eye. */
  project(point: Vec3): { x: number; y: number } | null;
  rayAt(x: number, y: number): Ray | null;
}

export interface Snap {
  kind: 'vertex' | 'edge' | 'surface';
  point: Vec3;
}

function vertex(positions: Float64Array, index: number): Vec3 {
  const at = index * 3;
  return [positions[at], positions[at + 1], positions[at + 2]];
}

export function snapMesh(mesh: ElementMesh): SnapMesh {
  const used = new Uint8Array(mesh.positions.length / 3);
  for (const index of mesh.edges) used[index] = 1;
  const corners: number[] = [];
  used.forEach((flag, index) => {
    if (flag) corners.push(index);
  });
  return { ...mesh, corners: new Uint32Array(corners) };
}

/** Smallest positive distance along the ray to a triangle at a point the planes keep. */
function firstHit(mesh: SnapMesh, origin: Vec3, direction: Vec3, planes: readonly SectionPlane[]): number | null {
  const { positions, indices } = mesh;
  let best: number | null = null;
  for (let t = 0; t * 3 < indices.length; t++) {
    const v0 = vertex(positions, indices[t * 3]);
    const e1 = sub(vertex(positions, indices[t * 3 + 1]), v0);
    const e2 = sub(vertex(positions, indices[t * 3 + 2]), v0);
    // Möller and Trumbore, from either side.
    const p = cross(direction, e2);
    const det = dot(e1, p);
    if (det === 0) continue;
    const s = sub(origin, v0);
    const u = dot(s, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(direction, q) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(e2, q) / det;
    if (distance <= 0 || (best !== null && distance >= best)) continue;
    if (!keptBy(planes, add(origin, scale(direction, distance)))) continue;
    best = distance;
  }
  return best;
}

/** Nothing of the mesh lies between the origin of the view ray and the point. */
function visible(mesh: SnapMesh, viewport: Viewport, point: Vec3, planes: readonly SectionPlane[]): boolean {
  const projected = viewport.project(point);
  const ray = projected && viewport.rayAt(projected.x, projected.y);
  if (!ray) return false;
  const toPoint = sub(point, ray.origin);
  const distance = length(toPoint);
  if (distance === 0) return true;
  const hit = firstHit(mesh, ray.origin, scale(toPoint, 1 / distance), planes);
  // Triangles through the point itself hit at its distance, give or take rounding.
  return hit === null || hit >= distance - Math.max(1e-6, distance * 1e-6);
}

/** The part of the segment from a to b, as parameters 0 to 1, that every plane keeps. */
function clipSegment(a: Vec3, b: Vec3, planes: readonly SectionPlane[]): [number, number] | null {
  let start = 0;
  let end = 1;
  for (const { normal, offset } of planes) {
    const fa = dot(normal, a) - offset;
    const fb = dot(normal, b) - offset;
    if (fa > 0 && fb > 0) return null;
    if (fa > 0) start = Math.max(start, fa / (fa - fb));
    else if (fb > 0) end = Math.min(end, fa / (fa - fb));
  }
  return start <= end ? [start, end] : null;
}

/** The point of the segment's kept part nearest the ray's line. */
function nearestOnSegment(a: Vec3, b: Vec3, range: [number, number], ray: Ray): Vec3 {
  const u = sub(b, a);
  const w = sub(a, ray.origin);
  const uu = dot(u, u);
  const ud = dot(u, ray.direction);
  const denominator = uu - ud * ud;
  // Parallel to the ray: every point is as near, so take the start.
  let s = denominator > 1e-12 * uu ? (ud * dot(ray.direction, w) - dot(u, w)) / denominator : 0;
  s = Math.min(range[1], Math.max(range[0], s));
  return add(a, scale(u, s));
}

interface Candidate {
  pixels: number;
  point: Vec3;
}

function byPixels(a: Candidate, b: Candidate): number {
  return a.pixels - b.pixels;
}

/**
 * The point to measure under the pointer: a visible corner within VERTEX_RADIUS, else a visible
 * edge within EDGE_RADIUS, else the nearest surface under the pointer. Only what the planes keep
 * counts, and only this mesh hides things. Null when there is nothing.
 */
export function snap(
  mesh: SnapMesh,
  viewport: Viewport,
  pointer: { x: number; y: number },
  planes: readonly SectionPlane[]
): Snap | null {
  const ray = viewport.rayAt(pointer.x, pointer.y);
  if (!ray) return null;
  const pixelsTo = (point: Vec3): number | null => {
    const at = viewport.project(point);
    return at ? Math.hypot(at.x - pointer.x, at.y - pointer.y) : null;
  };

  const corners: Candidate[] = [];
  for (const index of mesh.corners) {
    const point = vertex(mesh.positions, index);
    if (!keptBy(planes, point)) continue;
    const pixels = pixelsTo(point);
    if (pixels !== null && pixels <= VERTEX_RADIUS) corners.push({ pixels, point });
  }
  for (const { point } of corners.sort(byPixels)) {
    if (visible(mesh, viewport, point, planes)) return { kind: 'vertex', point };
  }

  const edges: Candidate[] = [];
  for (let e = 0; e < mesh.edges.length; e += 2) {
    const a = vertex(mesh.positions, mesh.edges[e]);
    const b = vertex(mesh.positions, mesh.edges[e + 1]);
    const range = clipSegment(a, b, planes);
    if (!range) continue;
    const point = nearestOnSegment(a, b, range, ray);
    const pixels = pixelsTo(point);
    if (pixels !== null && pixels <= EDGE_RADIUS) edges.push({ pixels, point });
  }
  for (const { point } of edges.sort(byPixels)) {
    if (visible(mesh, viewport, point, planes)) return { kind: 'edge', point };
  }

  const hit = firstHit(mesh, ray.origin, ray.direction, planes);
  return hit === null ? null : { kind: 'surface', point: add(ray.origin, scale(ray.direction, hit)) };
}
