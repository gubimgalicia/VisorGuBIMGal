import type { ModelId } from '../models/ModelRecord';

/** Bump on any breaking change to this file or to KernelPort/RendererPort. */
export const CONTRACT_VERSION = 2;

/** Number of u32 words per record in GeometryBatch.meshTable. */
export const MESH_RECORD_WORDS = 7;

/** Word offsets inside one meshTable record. */
export const MeshField = {
  expressId: 0,
  firstVertex: 1,
  vertexCount: 2,
  firstIndex: 3,
  indexCount: 4,
  /** 0xRRGGBBAA, non-premultiplied sRGB. */
  rgba: 5,
  flags: 6
} as const;

/** Number of u32 words per instance in GeometryBatch.instanceTable. */
export const INSTANCE_WORDS = 4;

/** Word offsets inside one instanceTable entry. */
export const InstanceField = {
  expressId: 0,
  shapeId: 1,
  /** 0xRRGGBBAA, non-premultiplied sRGB. */
  rgba: 2,
  flags: 3
} as const;

/** Floats per instance in GeometryBatch.instanceTransforms: a 3x4 matrix, column by column. */
export const TRANSFORM_FLOATS = 12;

export const MeshFlag = {
  /** Alpha below 255: draw in the transparent pass. */
  Transparent: 1 << 0,
  /** Kernel could not evaluate it fully (a void was not cut, say). The 'complete' event names it. */
  Degraded: 1 << 1,
  /** Pickable, but starts hidden. Only IfcSpace today. Left out of 'complete' bounds. */
  HiddenByDefault: 1 << 2,
  /**
   * The mesh is closed and winds outward: every side is shared by two of its triangles running
   * opposite ways, and every part, its triangles joined across those sides, encloses a positive
   * volume. Seen from outside, its back faces never show, so renderers may cull them. Pieces of
   * a split mesh keep it.
   */
  Closed: 1 << 3
} as const;

/** Largest vertex distance from a batch origin, in metres. f32 keeps about 0.5 mm here. */
export const MAX_BATCH_RADIUS = 4096;

/** Largest step of a q16 grid on any axis, in metres; a coarser batch or shape travels as f32. */
export const MAX_QUANT_STEP = 0.001;

/** Highest value on a q16 grid: q = 0 is the box's min, q = 65535 its max. */
export const Q16_GRID = 65535;

/** Most records a q16 batch may hold: each vertex carries its record index in 16 bits. */
export const MAX_Q16_RECORDS = 65535;

/** How far a normal's length may stray from 1. */
const NORMAL_TOLERANCE = 1e-3;

/** Smallest normal f32, so a determinant below it would be subnormal in a shader. */
const F32_MIN_NORMAL = 1.1754943508222875e-38;

/**
 * - `f32`: positions are xyz as Float32Array, normals xyz as Float32Array.
 * - `q16`: positions are four Uint16 per vertex, x, y and z on the grid of the batch's
 *   `quantBox` (or the shape's `box`), position = min + q / 65535 * (max - min), and in a batch
 *   the vertex's record index in meshTable as the fourth (0 in a shape). Normals are two Int16
 *   per vertex, octahedral, read as snorm (value / 32767, at least -1).
 */
export type VertexFormat = 'f32' | 'q16';

export interface Box3 {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** A shape drawn by instances, sent once per stream in the first batch that uses it. */
export interface ShapeDef {
  /** Unique in the stream, from 1. */
  shapeId: number;
  vertexFormat: VertexFormat;
  /** In the shape's own coordinates. */
  positions: Float32Array | Uint16Array;
  normals: Float32Array | Int16Array;
  indices: Uint32Array | Uint16Array;
  /** Exact box of its positions, and their grid in q16. */
  box: Box3;
  /** As MeshFlag.Closed, for the shape. */
  closed: boolean;
}

/**
 * One transferable block of triangles. Positions are metres, IFC Z-up, relative to `origin`.
 * Indices are zero-based within this batch. An element may own several records, one per colour
 * for instance, in one batch unless it is wider than MAX_BATCH_RADIUS and the kernel split it
 * into pieces across batches. Triangles run counter-clockwise seen from the side their normal
 * points to. See docs/05 section 3.
 */
export interface GeometryBatch {
  modelId: ModelId;
  /** Starts at 1 in each stream and rises by one. */
  sequence: number;
  /** Absolute model coordinates, as f64. Absolute vertex = origin + position. */
  origin: readonly [number, number, number];
  /**
   * Everything the batch draws, relative to `origin`: its vertices and the boxes of its
   * transformed shapes. Without instances, exactly the least and greatest position (`quantBox`);
   * zeros when the batch draws nothing. Renderers skip a batch whose box is out of view.
   */
  box: Box3;
  vertexFormat: VertexFormat;
  /**
   * The grid of `positions`: the exact least and greatest position on each axis, before
   * quantisation. `null` when the batch has no vertices of its own.
   */
  quantBox: Box3 | null;
  positions: Float32Array | Uint16Array;
  normals: Float32Array | Int16Array;
  /** 16-bit only when the batch has at most 65,536 vertices. Told apart by type. */
  indices: Uint32Array | Uint16Array;
  meshTable: Uint32Array;
  /** Shapes this batch uses for the first time in the stream. */
  shapes: ShapeDef[];
  /** INSTANCE_WORDS per instance: expressId, shapeId, rgba, flags. */
  instanceTable: Uint32Array;
  /** TRANSFORM_FLOATS per instance: shape to batch-local coordinates, column by column. */
  instanceTransforms: Float32Array;
}

/** Vertices per position array of a format. */
export function vertexCountOf(format: VertexFormat, positions: ArrayLike<number>): number {
  return format === 'q16' ? positions.length / 4 : positions.length / 3;
}

function boxError(name: string, box: Box3): string | null {
  for (let axis = 0; axis < 3; axis++) {
    const [least, greatest] = [box.min[axis], box.max[axis]];
    if (!Number.isFinite(least) || !Number.isFinite(greatest)) return `${name} is not finite on axis ${axis}`;
    if (least > greatest) return `${name} has min above max on axis ${axis}`;
  }
  return null;
}

/** Checks one set of vertices against its format and its grid box. */
function verticesError(
  name: string,
  format: VertexFormat,
  positions: Float32Array | Uint16Array,
  normals: Float32Array | Int16Array,
  grid: Box3
): string | null {
  if (format !== 'f32' && format !== 'q16') return `${name}: unknown vertexFormat`;
  if (format === 'f32') {
    if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array)) {
      return `${name}: f32 vertices must be Float32Array`;
    }
    if (positions.length % 3 !== 0) return `${name}: positions length is not a multiple of 3`;
    if (normals.length !== positions.length) return `${name}: normals length differs from positions length`;
    // A lone element above the radius is allowed if Degraded, so this checks only finiteness.
    if (!positions.every(Number.isFinite)) return `${name}: positions contain a non-finite value`;
    // Without vertices there is no grid to match: an instance-only batch has quantBox null.
    for (let axis = 0; axis < 3 && positions.length > 0; axis++) {
      let least = Infinity;
      let greatest = -Infinity;
      for (let at = axis; at < positions.length; at += 3) {
        least = Math.min(least, positions[at]);
        greatest = Math.max(greatest, positions[at]);
      }
      if (grid.min[axis] !== least || grid.max[axis] !== greatest) {
        return `${name}: box differs from the positions on axis ${axis}`;
      }
    }
    for (let at = 0; at < normals.length; at += 3) {
      const length = Math.hypot(normals[at], normals[at + 1], normals[at + 2]);
      if (!(Math.abs(length - 1) <= NORMAL_TOLERANCE)) return `${name}: normal ${at / 3} is not unit length`;
    }
    return null;
  }
  if (!(positions instanceof Uint16Array) || !(normals instanceof Int16Array)) {
    return `${name}: q16 vertices must be Uint16Array positions and Int16Array normals`;
  }
  if (positions.length % 4 !== 0) return `${name}: q16 positions length is not a multiple of 4`;
  if (normals.length !== (positions.length / 4) * 2) return `${name}: q16 normals are not two per vertex`;
  for (let axis = 0; axis < 3; axis++) {
    const step = (grid.max[axis] - grid.min[axis]) / Q16_GRID;
    if (step > MAX_QUANT_STEP) return `${name}: grid step on axis ${axis} exceeds MAX_QUANT_STEP`;
    // Exact without comparing floats: the ends of the grid are vertices, so some q is 0 and
    // some is 65535 on an axis with extent, and every q is 0 on one without.
    let least = Q16_GRID;
    let greatest = 0;
    for (let at = axis; at < positions.length; at += 4) {
      least = Math.min(least, positions[at]);
      greatest = Math.max(greatest, positions[at]);
    }
    const flat = grid.max[axis] === grid.min[axis];
    if (positions.length > 0 && (flat ? greatest !== 0 : least !== 0 || greatest !== Q16_GRID)) {
      return `${name}: q16 grid is not the exact box of the positions on axis ${axis}`;
    }
  }
  return null;
}

function indicesError(name: string, indices: Uint32Array | Uint16Array, vertexTotal: number): string | null {
  if (!(indices instanceof Uint32Array) && !(indices instanceof Uint16Array)) {
    return `${name}: indices must be Uint32Array or Uint16Array`;
  }
  if (indices instanceof Uint16Array && vertexTotal > 65536) return `${name}: 16-bit indices for over 65536 vertices`;
  if (indices.length % 3 !== 0) return `${name}: indices length is not a multiple of 3`;
  return null;
}

function determinant(m: Float32Array, at: number): number {
  const [a, b, c] = [m[at], m[at + 3], m[at + 6]];
  const [d, e, f] = [m[at + 1], m[at + 4], m[at + 7]];
  const [g, h, i] = [m[at + 2], m[at + 5], m[at + 8]];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** The 8 corners of a box under a column-major 3x4 matrix. */
function transformedCorners(box: Box3, m: Float32Array, at: number): number[][] {
  const corners: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const p = [0, 1, 2].map((axis) => ((k >> axis) & 1 ? box.max[axis] : box.min[axis]));
    corners.push([0, 1, 2].map((r) => m[at + r] * p[0] + m[at + 3 + r] * p[1] + m[at + 6 + r] * p[2] + m[at + 9 + r]));
  }
  return corners;
}

/**
 * Returns the first wire-format violation, or null. For tests, mock data and the kernel check,
 * never per batch on a hot path. `knownShapes` holds the shapes this model's stream has already
 * sent; without it, only shapes defined in this batch can be checked.
 */
export function findBatchError(batch: GeometryBatch, knownShapes?: ReadonlyMap<number, ShapeDef>): string | null {
  const { origin, positions, normals, indices, meshTable } = batch;
  if (origin.length !== 3 || !origin.every(Number.isFinite)) return 'origin is not three finite numbers';
  const boxProblem = boxError('box', batch.box);
  if (boxProblem) return boxProblem;

  const instanceTable = batch.instanceTable ?? new Uint32Array(0);
  const instanceTransforms = batch.instanceTransforms ?? new Float32Array(0);
  const shapes = batch.shapes ?? [];
  if (instanceTable.length % INSTANCE_WORDS !== 0) return `instanceTable length is not a multiple of ${INSTANCE_WORDS}`;
  const instanceCount = instanceTable.length / INSTANCE_WORDS;
  if (instanceTransforms.length !== instanceCount * TRANSFORM_FLOATS) {
    return 'instanceTransforms length differs from the instance count';
  }

  const vertexTotal = vertexCountOf(batch.vertexFormat, positions);
  if (positions.length === 0) {
    if (batch.quantBox !== null) return 'quantBox must be null when the batch has no vertices';
  } else {
    if (batch.quantBox === null) return 'quantBox is null but the batch has vertices';
    const quantProblem = boxError('quantBox', batch.quantBox);
    if (quantProblem) return quantProblem;
  }
  const grid = batch.quantBox ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const vertexProblem = verticesError('batch', batch.vertexFormat, positions, normals, grid);
  if (vertexProblem) return vertexProblem;
  const indexProblem = indicesError('batch', indices, vertexTotal);
  if (indexProblem) return indexProblem;
  if (meshTable.length % MESH_RECORD_WORDS !== 0) {
    return `meshTable length is not a multiple of ${MESH_RECORD_WORDS}`;
  }
  const recordCount = meshTable.length / MESH_RECORD_WORDS;
  if (batch.vertexFormat === 'q16' && recordCount > MAX_Q16_RECORDS) return 'q16 batch with over 65535 records';

  for (let at = 0; at < meshTable.length; at += MESH_RECORD_WORDS) {
    const record = at / MESH_RECORD_WORDS;
    const expressId = meshTable[at + MeshField.expressId];
    const firstVertex = meshTable[at + MeshField.firstVertex];
    const vertexCount = meshTable[at + MeshField.vertexCount];
    const firstIndex = meshTable[at + MeshField.firstIndex];
    const indexCount = meshTable[at + MeshField.indexCount];

    if (expressId === 0) return `record ${record}: expressId is 0`;
    if (firstVertex + vertexCount > vertexTotal) return `record ${record}: vertices out of range`;
    if (firstIndex + indexCount > indices.length) return `record ${record}: indices out of range`;
    if (indexCount % 3 !== 0) return `record ${record}: indexCount is not a multiple of 3`;

    for (let i = firstIndex; i < firstIndex + indexCount; i++) {
      const vertex = indices[i];
      if (vertex < firstVertex || vertex >= firstVertex + vertexCount) {
        return `record ${record}: index ${i} leaves the record's vertex range`;
      }
    }
    if (batch.vertexFormat === 'q16') {
      for (let v = firstVertex; v < firstVertex + vertexCount; v++) {
        if (positions[4 * v + 3] !== record) return `record ${record}: vertex ${v} carries record ${positions[4 * v + 3]}`;
      }
    }
  }

  // Shapes defined here, then the instances that use them.
  const defined = new Map<number, ShapeDef>();
  for (const shape of shapes) {
    const name = `shape ${shape.shapeId}`;
    if (!Number.isInteger(shape.shapeId) || shape.shapeId < 1) return `${name}: shapeId must be an integer from 1`;
    if (defined.has(shape.shapeId) || knownShapes?.has(shape.shapeId)) return `${name}: defined twice`;
    const shapeBoxProblem = boxError(`${name} box`, shape.box);
    if (shapeBoxProblem) return shapeBoxProblem;
    const problem = verticesError(name, shape.vertexFormat, shape.positions, shape.normals, shape.box);
    if (problem) return problem;
    const shapeVertices = vertexCountOf(shape.vertexFormat, shape.positions);
    if (shapeVertices === 0) return `${name}: no vertices`;
    const shapeIndexProblem = indicesError(name, shape.indices, shapeVertices);
    if (shapeIndexProblem) return shapeIndexProblem;
    for (const index of shape.indices) if (index >= shapeVertices) return `${name}: index out of range`;
    if (shape.vertexFormat === 'q16') {
      for (let at = 3; at < shape.positions.length; at += 4) {
        if (shape.positions[at] !== 0) return `${name}: fourth component is not 0`;
      }
    }
    defined.set(shape.shapeId, shape);
  }

  const contains = (point: number[], slack: number) =>
    [0, 1, 2].every((axis) => point[axis] >= batch.box.min[axis] - slack && point[axis] <= batch.box.max[axis] + slack);
  for (let i = 0; i < instanceCount; i++) {
    const expressId = instanceTable[i * INSTANCE_WORDS + InstanceField.expressId];
    const shapeId = instanceTable[i * INSTANCE_WORDS + InstanceField.shapeId];
    if (expressId === 0) return `instance ${i}: expressId is 0`;
    const shape = defined.get(shapeId) ?? knownShapes?.get(shapeId);
    if (!shape) return `instance ${i}: unknown shape ${shapeId}`;
    const at = i * TRANSFORM_FLOATS;
    for (let k = at; k < at + TRANSFORM_FLOATS; k++) {
      if (!Number.isFinite(instanceTransforms[k])) return `instance ${i}: matrix is not finite`;
    }
    // Normal and positive in f32 too: 1e-40 is a normal f64 but a subnormal f32.
    const det = determinant(instanceTransforms, at);
    if (!(det >= F32_MIN_NORMAL)) return `instance ${i}: determinant ${det} is not normal and positive`;
    let slack = 0;
    if (shape.vertexFormat === 'q16') {
      let stretch = 0;
      for (let c = 0; c < 3; c++) {
        const k = at + 3 * c;
        stretch = Math.max(stretch, Math.hypot(instanceTransforms[k], instanceTransforms[k + 1], instanceTransforms[k + 2]));
      }
      for (let axis = 0; axis < 3; axis++) {
        slack = Math.max(slack, ((shape.box.max[axis] - shape.box.min[axis]) / Q16_GRID / 2) * stretch);
      }
    }
    // f32 rounding of the transform itself.
    const corners = transformedCorners(shape.box, instanceTransforms, at);
    const rounding = 1e-6 * Math.max(1, ...corners.flat().map(Math.abs));
    if (!corners.every((corner) => contains(corner, slack + rounding))) return `instance ${i}: shape leaves box`;
  }

  if (instanceCount === 0) {
    const expected = batch.quantBox ?? { min: [0, 0, 0], max: [0, 0, 0] };
    for (let axis = 0; axis < 3; axis++) {
      if (batch.box.min[axis] !== expected.min[axis] || batch.box.max[axis] !== expected.max[axis]) {
        return `box differs from quantBox on axis ${axis} in a batch without instances`;
      }
    }
  } else if (batch.quantBox) {
    if (!contains([...batch.quantBox.min], 0) || !contains([...batch.quantBox.max], 0)) return 'box does not contain quantBox';
  }
  return null;
}
