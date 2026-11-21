import {
  TRANSFORM_FLOATS,
  vertexCountOf,
  type Box3,
  type ShapeDef
} from '../../domain/kernel/GeometryBatch';
import type { Vec3 } from '../../domain/measure/geometry';
import type { InstancePlan } from './instances';

/**
 * A14 (docs/10_lod.md): renderer-side Levels of Detail for dense instanced shapes.
 *
 * Uses adaptive 3D spatial vertex clustering on each `ShapeDef` with at least `LOD_MIN_SHAPE_TRIS`
 * triangles, snapping each occupied cubic grid cell to the existing vertex nearest the cell centre.
 * Every coarse level therefore reuses the shape's already-uploaded vertex and normal GPU buffers
 * and only uploads a smaller index buffer, with zero contract changes (R4).
 */

/** Minimum triangle count of a ShapeDef before building coarse LoD index buffers. */
export const LOD_MIN_SHAPE_TRIS = 128;

/** A coarse level must drop at least 40% of its parent level's triangles to be kept. */
export const LOD_MAX_KEEP_RATIO = 0.6;

/** Minimum triangles a coarse level must retain so distant silhouettes do not vanish. */
export const LOD_MIN_KEPT_TRIS = 4;

/** Maximum projected geometric error (pixels) to switch down to a coarser LoD. */
export const LOD_ENTER_ERROR_PX = 1.5;

/** Projected geometric error (pixels) above which an active coarse LoD switches back finer. */
export const LOD_EXIT_ERROR_PX = 1.75;

const HALF_SQRT3 = Math.sqrt(3) * 0.5;

export interface ShapeLodIndices {
  indices: Uint16Array | Uint32Array;
  /** Analytical upper bound on vertex displacement in the shape's local coordinates (metres). */
  errorLocal: number;
}

export interface RangeLodBounds {
  /** World-space AABB enclosing every instance in this `(batch, shapeId, transparent)` range. */
  min: Vec3;
  max: Vec3;
  /** Maximum column norm of the linear part across instances in this range. */
  maxStretch: number;
}

export interface LodPixelScale {
  /** Perspective: `heightPx / (2 * tan(fovY / 2))`. Orthographic: `heightPx / (2 * halfH)`. */
  scale: number;
  perspective: boolean;
}

/**
 * Builds up to two coarse index buffers (LOD1, LOD2) for a dense `ShapeDef`, ordered finest to
 * coarsest (`[LOD1, LOD2]`). Returns an empty array for shapes below `LOD_MIN_SHAPE_TRIS` or when
 * clustering cannot reduce triangles by at least 40%.
 */
export function buildShapeLods(shape: ShapeDef): ShapeLodIndices[] {
  const triCount = Math.floor(shape.indices.length / 3);
  if (triCount < LOD_MIN_SHAPE_TRIS) return [];

  const vertexCount = vertexCountOf(shape.vertexFormat, shape.positions);
  if (vertexCount < 4) return [];

  const minX = shape.box.min[0];
  const minY = shape.box.min[1];
  const minZ = shape.box.min[2];
  const ex = shape.box.max[0] - minX;
  const ey = shape.box.max[1] - minY;
  const ez = shape.box.max[2] - minZ;
  const maxExtent = Math.max(ex, ey, ez);
  if (!(maxExtent > 1e-9) || !Number.isFinite(maxExtent)) return [];

  // Decode local positions once into a flat f32 buffer for clustering.
  let localPos: Float32Array;
  if (shape.vertexFormat === 'q16') {
    const q = shape.positions as Uint16Array;
    localPos = new Float32Array(vertexCount * 3);
    const sx = ex / 65535;
    const sy = ey / 65535;
    const sz = ez / 65535;
    for (let v = 0; v < vertexCount; v++) {
      const qBase = v * 4;
      const pBase = v * 3;
      localPos[pBase] = minX + q[qBase] * sx;
      localPos[pBase + 1] = minY + q[qBase + 1] * sy;
      localPos[pBase + 2] = minZ + q[qBase + 2] * sz;
    }
  } else {
    localPos = shape.positions as Float32Array;
  }

  const u16 = shape.indices instanceof Uint16Array;
  // Surface triangle count in an N^3 cubic grid scales as O(N^2); adapt N to triCount so both
  // 200-tri elbows and 18,000-tri faucets hit ~20-30% (LOD1) and ~3-8% (LOD2).
  const n1 = Math.max(6, Math.min(24, Math.round(Math.sqrt(triCount / 20))));
  const n2 = Math.max(3, Math.min(Math.floor(n1 / 2), Math.round(Math.sqrt(triCount / 90))));
  const gridLevels = n2 < n1 ? [n1, n2] : [n1];
  const results: ShapeLodIndices[] = [];
  let prevTris = triCount;

  for (const n of gridLevels) {
    const clustered = clusterIndices(
      localPos,
      vertexCount,
      shape.indices,
      minX,
      minY,
      minZ,
      maxExtent,
      n,
      u16
    );
    const keptTris = clustered.length / 3;
    if (keptTris >= LOD_MIN_KEPT_TRIS && keptTris <= prevTris * LOD_MAX_KEEP_RATIO) {
      const cellSize = maxExtent / n;
      results.push({
        indices: clustered,
        errorLocal: HALF_SQRT3 * cellSize
      });
      prevTris = keptTris;
    }
  }

  return results;
}

function clusterIndices(
  pos: Float32Array,
  vertexCount: number,
  indices: Uint16Array | Uint32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxExtent: number,
  n: number,
  u16: boolean
): Uint16Array | Uint32Array {
  const cellCount = n * n * n;
  const cellRep = new Int32Array(cellCount).fill(-1);
  const cellBestDist2 = new Float32Array(cellCount).fill(Infinity);
  const vertexCell = new Int32Array(vertexCount);

  const cellSize = maxExtent / n;
  const invCell = n / maxExtent;
  const maxIdx = n - 1;

  for (let v = 0; v < vertexCount; v++) {
    const p = v * 3;
    const x = pos[p];
    const y = pos[p + 1];
    const z = pos[p + 2];
    const cx = Math.min(maxIdx, Math.max(0, Math.floor((x - minX) * invCell)));
    const cy = Math.min(maxIdx, Math.max(0, Math.floor((y - minY) * invCell)));
    const cz = Math.min(maxIdx, Math.max(0, Math.floor((z - minZ) * invCell)));
    const cell = (cx * n + cy) * n + cz;
    vertexCell[v] = cell;

    const dx = x - (minX + (cx + 0.5) * cellSize);
    const dy = y - (minY + (cy + 0.5) * cellSize);
    const dz = z - (minZ + (cz + 0.5) * cellSize);
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 < cellBestDist2[cell]) {
      cellBestDist2[cell] = dist2;
      cellRep[cell] = v;
    }
  }

  const out: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const r0 = cellRep[vertexCell[indices[i]]];
    const r1 = cellRep[vertexCell[indices[i + 1]]];
    const r2 = cellRep[vertexCell[indices[i + 2]]];
    if (r0 === r1 || r1 === r2 || r0 === r2) continue;

    // Canonical unordered triple for deduplication while preserving surviving triangle winding.
    let a = r0;
    let b = r1;
    let c = r2;
    if (a > b) { const t = a; a = b; b = t; }
    if (b > c) { const t = b; b = c; c = t; }
    if (a > b) { const t = a; a = b; b = t; }
    const key = `${a},${b},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r0, r1, r2);
  }

  return u16 ? Uint16Array.from(out) : Uint32Array.from(out);
}

/**
 * Computes world-space AABB and maximum linear stretch for each `InstanceRange` in a batch.
 * Called once at batch upload time so per-frame LoD selection does zero matrix transforms.
 */
export function computeRangeLodBounds(
  origin: readonly [number, number, number],
  instanceTransforms: Float32Array,
  plan: InstancePlan,
  getShapeBox: (shapeId: number) => Box3 | null | undefined
): Array<RangeLodBounds | null> {
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];

  return plan.ranges.map((range) => {
    const box = getShapeBox(range.shapeId);
    if (!box) return null;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let maxStretch = 0;

    for (let k = range.first; k < range.first + range.count; k++) {
      const idx = plan.order[k];
      const at = idx * TRANSFORM_FLOATS;
      const c0x = instanceTransforms[at];
      const c0y = instanceTransforms[at + 1];
      const c0z = instanceTransforms[at + 2];
      const c1x = instanceTransforms[at + 3];
      const c1y = instanceTransforms[at + 4];
      const c1z = instanceTransforms[at + 5];
      const c2x = instanceTransforms[at + 6];
      const c2y = instanceTransforms[at + 7];
      const c2z = instanceTransforms[at + 8];
      const tx = instanceTransforms[at + 9];
      const ty = instanceTransforms[at + 10];
      const tz = instanceTransforms[at + 11];

      const s0 = Math.hypot(c0x, c0y, c0z);
      const s1 = Math.hypot(c1x, c1y, c1z);
      const s2 = Math.hypot(c2x, c2y, c2z);
      const stretch = Math.max(s0, s1, s2);
      if (stretch > maxStretch) maxStretch = stretch;

      for (let corner = 0; corner < 8; corner++) {
        const lx = (corner & 1) !== 0 ? box.max[0] : box.min[0];
        const ly = (corner & 2) !== 0 ? box.max[1] : box.min[1];
        const lz = (corner & 4) !== 0 ? box.max[2] : box.min[2];
        const wx = ox + c0x * lx + c1x * ly + c2x * lz + tx;
        const wy = oy + c0y * lx + c1y * ly + c2y * lz + ty;
        const wz = oz + c0z * lx + c1z * ly + c2z * lz + tz;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }
    }

    if (!Number.isFinite(minX) || !(maxStretch > 0)) return null;
    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      maxStretch
    };
  });
}

/** Euclidean distance from `point` to axis-aligned box `[min, max]` (0 when inside). */
export function pointToBoxDistance(point: Vec3, min: Vec3, max: Vec3): number {
  const dx = point[0] < min[0] ? min[0] - point[0] : point[0] > max[0] ? point[0] - max[0] : 0;
  const dy = point[1] < min[1] ? min[1] - point[1] : point[1] > max[1] ? point[1] - max[1] : 0;
  const dz = point[2] < min[2] ? min[2] - point[2] : point[2] > max[2] ? point[2] - max[2] : 0;
  return Math.hypot(dx, dy, dz);
}

/**
 * Selects the active LoD index (`0` = full LOD0, `1..lods.length` = coarser levels) for one
 * `InstanceRange` using projected geometric error with hysteresis.
 */
export function chooseLodLevel(
  lods: ReadonlyArray<{ errorLocal: number }>,
  bounds: RangeLodBounds | null | undefined,
  eye: Vec3,
  pixelScale: LodPixelScale,
  prevLevel: number
): number {
  if (lods.length === 0 || !bounds) return 0;

  let pxPerLocalMetre: number;
  if (pixelScale.perspective) {
    const dMin = pointToBoxDistance(eye, bounds.min, bounds.max);
    if (dMin <= 1e-6) return 0;
    pxPerLocalMetre = (bounds.maxStretch / dMin) * pixelScale.scale;
  } else {
    pxPerLocalMetre = bounds.maxStretch * pixelScale.scale;
  }

  // Test coarsest level first; use stricter threshold to step down (coarser) and wider threshold
  // to stay at or below prevLevel (hysteresis prevents popping while orbiting near the boundary).
  for (let level = lods.length; level >= 1; level--) {
    const errorPx = lods[level - 1].errorLocal * pxPerLocalMetre;
    const limit = level > prevLevel ? LOD_ENTER_ERROR_PX : LOD_EXIT_ERROR_PX;
    if (errorPx <= limit) return level;
  }
  return 0;
}
