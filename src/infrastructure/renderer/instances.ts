import {
  INSTANCE_WORDS,
  InstanceField,
  MeshFlag,
  TRANSFORM_FLOATS,
  type GeometryBatch,
  type ShapeDef
} from '../../domain/kernel/GeometryBatch';

/**
 * What both renderers need to draw a batch's instances (A13, docs/05 section 3): the instances
 * sorted by shape and transparency into contiguous ranges, and their per-instance GPU data.
 */

/** A run of instances of one shape, all opaque or all transparent, drawn in one call. */
export interface InstanceRange {
  shapeId: number;
  transparent: boolean;
  /** Position of the first instance in the sorted order, and the count. */
  first: number;
  count: number;
}

export interface InstancePlan {
  /** Original instance indices, in draw order: by shape, opaque before transparent. */
  order: Uint32Array;
  ranges: InstanceRange[];
}

export function isTransparentInstance(rgba: number, flags: number): boolean {
  return (flags & MeshFlag.Transparent) !== 0 || (rgba & 0xff) < 255;
}

/** Sorts a batch's instances into ranges. Stable within a range, so records keep stream order. */
export function planInstances(instanceTable: Uint32Array): InstancePlan {
  const count = instanceTable.length / INSTANCE_WORDS;
  const keys: { index: number; shapeId: number; transparent: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * INSTANCE_WORDS;
    keys.push({
      index: i,
      shapeId: instanceTable[at + InstanceField.shapeId],
      transparent: isTransparentInstance(instanceTable[at + InstanceField.rgba], instanceTable[at + InstanceField.flags])
    });
  }
  keys.sort((a, b) => a.shapeId - b.shapeId || Number(a.transparent) - Number(b.transparent) || a.index - b.index);
  const order = new Uint32Array(count);
  const ranges: InstanceRange[] = [];
  keys.forEach((key, at) => {
    order[at] = key.index;
    const last = ranges[ranges.length - 1];
    if (last && last.shapeId === key.shapeId && last.transparent === key.transparent) last.count++;
    else ranges.push({ shapeId: key.shapeId, transparent: key.transparent, first: at, count: 1 });
  });
  return { order, ranges };
}

/**
 * Rows of a column-major 3x4 matrix (the contract's layout), as the GPU reads it: row i is
 * (c0[i], c1[i], c2[i], c3[i]), and a position is dot(row_i, (p, 1)). And the rows of the
 * inverse transpose of its linear part, for normals. `null` when the determinant is not positive.
 */
export function instanceRows(m: Float32Array, at: number): { rows: number[]; normalRows: number[] } | null {
  const c = (column: number, row: number) => m[at + column * 3 + row];
  const rows = [0, 1, 2].flatMap((row) => [c(0, row), c(1, row), c(2, row), c(3, row)]);
  // Linear part L with L[row][col] = c(col, row). N = inverse(L)^T, so N[i][j] = cofactor(i, j) / det.
  const a = [0, 1, 2].map((row) => [0, 1, 2].map((col) => c(col, row)));
  const cof = (i: number, j: number) => {
    const r = [0, 1, 2].filter((x) => x !== i);
    const k = [0, 1, 2].filter((x) => x !== j);
    const minor = a[r[0]][k[0]] * a[r[1]][k[1]] - a[r[0]][k[1]] * a[r[1]][k[0]];
    return (i + j) % 2 === 0 ? minor : -minor;
  };
  const det = a[0][0] * cof(0, 0) + a[0][1] * cof(0, 1) + a[0][2] * cof(0, 2);
  if (!(det > 0)) return null;
  const normalRows = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => cof(i, j) / det));
  return { rows, normalRows };
}

/**
 * Per-instance GPU data in draw order. `stride` and `layout` place the fields:
 *   - WebGPU (96 bytes): 3 vec4 rows at 0, 16, 32; 3 vec3 normal rows at 48, 64, 80; u32 record at 92.
 *   - WebGL2 (52 bytes): 3 vec4 rows at 0, 16, 32; u32 record at 48. Its shader derives the normal
 *     matrix from the rows: every vertex reads its instance's data, and this hardware is limited
 *     by vertex fetch (A12, T-158).
 * `firstRecord` is the batch-local record index of the first instance: instances come after the
 * batch's own records.
 */
export function packInstances(
  batch: Pick<GeometryBatch, 'instanceTable' | 'instanceTransforms'>,
  plan: InstancePlan,
  firstRecord: number,
  layout: 'webgpu' | 'webgl2',
  headerBytes = 0
): ArrayBuffer {
  const stride = layout === 'webgpu' ? 96 : 52;
  const normalAt = layout === 'webgpu' ? [48, 64, 80] : null;
  const recordAt = layout === 'webgpu' ? 92 : 48;
  const buffer = new ArrayBuffer(headerBytes + plan.order.length * stride);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  plan.order.forEach((index, at) => {
    const base = headerBytes + at * stride;
    const data = instanceRows(batch.instanceTransforms, index * TRANSFORM_FLOATS);
    // The kernel never sends a matrix without a positive determinant; draw nothing if one comes.
    const rows = data?.rows ?? new Array(12).fill(0);
    const normalRows = data?.normalRows ?? new Array(9).fill(0);
    f32.set(rows, base / 4);
    if (normalAt) for (let r = 0; r < 3; r++) f32.set(normalRows.slice(r * 3, r * 3 + 3), (base + normalAt[r]) / 4);
    u32[(base + recordAt) / 4] = firstRecord + at;
  });
  return buffer;
}

/** Triangles a batch's instances draw, for statistics. */
export function instanceTriangles(plan: InstancePlan, shapes: ReadonlyMap<number, ShapeDef>): number {
  let total = 0;
  for (const range of plan.ranges) total += ((shapes.get(range.shapeId)?.indices.length ?? 0) / 3) * range.count;
  return total;
}
