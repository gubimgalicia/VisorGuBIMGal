// Turns a geometry batch into plain triangles in absolute model coordinates, whatever its format:
// contract v1 (f32 positions and normals, u32 indices, meshTable) or v2 (docs/05 section 3: q16
// positions as four u16 per vertex, x, y, z on the grid of the batch's quantBox or the shape's box
// and the record index fourth; octahedral i16 normals; u16 or u32 indices; shared shapes and an
// instance table). For checking that v2 draws what v1 drew.
// Pure functions, no kernel and no browser.

export const MESH_RECORD_WORDS = 7;
export const INSTANCE_WORDS = 4;
export const TRANSFORM_FLOATS = 12;

/** q16 positions, four u16 per vertex: xyz = min + q / 65535 * (max - min). The fourth is skipped. */
export function decodeQ16(q, min, max, out = new Float64Array((q.length / 4) * 3)) {
  for (let v = 0; v < q.length / 4; v++) {
    for (let axis = 0; axis < 3; axis++) {
      out[3 * v + axis] = min[axis] + (q[4 * v + axis] / 65535) * (max[axis] - min[axis]);
    }
  }
  return out;
}

/** Octahedral unit vector from two signed 16-bit values (snorm), as in docs/09 section 3. */
export function decodeOct(sx, sy) {
  let x = Math.max(-1, sx / 32767);
  let y = Math.max(-1, sy / 32767);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** A batch's grid is its quantBox (its box in v1); a shape's is its box. */
const gridOf = (part) => part.quantBox ?? part.box;

function positionsOf(part) {
  if (part.vertexFormat === 'q16') return decodeQ16(part.positions, gridOf(part).min, gridOf(part).max);
  return part.positions;
}

function normalsOf(part) {
  if (part.vertexFormat !== 'q16') return part.normals;
  const out = new Float64Array((part.normals.length / 2) * 3);
  for (let v = 0; v < part.normals.length / 2; v++) {
    const n = decodeOct(part.normals[2 * v], part.normals[2 * v + 1]);
    out.set(n, 3 * v);
  }
  return out;
}

/** 3x3 inverse transpose of the linear part of a column-major 3x4 matrix. */
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // Rows of the inverse, read as the columns of its transpose.
  return {
    det,
    n: [
      (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
    ]
  };
}

/**
 * Calls `emit(element)` once per record or instance, with
 * { expressId, rgba, flags, triangles: Float64Array (9 per triangle, absolute xyz),
 *   normals: Float64Array (9 per triangle, unit) }.
 * `shapes` is the stream's shape registry (Map), filled from each batch's `shapes`.
 */
export function expandBatch(batch, shapes, emit) {
  const origin = batch.origin;
  for (const shape of batch.shapes ?? []) {
    if (shapes.has(shape.shapeId)) throw new Error(`shape ${shape.shapeId} sent twice`);
    shapes.set(shape.shapeId, { ...shape, decoded: positionsOf(shape), decodedNormals: normalsOf(shape) });
  }
  const pos = positionsOf(batch);
  const nor = normalsOf(batch);
  const table = batch.meshTable;
  for (let r = 0; r < table.length; r += MESH_RECORD_WORDS) {
    const [expressId, , , firstIndex, indexCount, rgba, flags] = table.subarray(r, r + MESH_RECORD_WORDS);
    const triangles = new Float64Array(indexCount * 3);
    const normals = new Float64Array(indexCount * 3);
    for (let k = 0; k < indexCount; k++) {
      const v = batch.indices[firstIndex + k];
      for (let axis = 0; axis < 3; axis++) {
        triangles[3 * k + axis] = origin[axis] + pos[3 * v + axis];
        normals[3 * k + axis] = nor[3 * v + axis];
      }
    }
    emit({ expressId, rgba, flags, triangles, normals, tolerance: quantError(batch), axisTolerance: halfSteps(batch) });
  }
  const instances = batch.instanceTable ?? new Uint32Array(0);
  for (let i = 0; i < instances.length / INSTANCE_WORDS; i++) {
    const [expressId, shapeId, rgba, flags] = instances.subarray(i * INSTANCE_WORDS, (i + 1) * INSTANCE_WORDS);
    const shape = shapes.get(shapeId);
    if (!shape) throw new Error(`instance of unknown shape ${shapeId}`);
    const m = batch.instanceTransforms.subarray(i * TRANSFORM_FLOATS, (i + 1) * TRANSFORM_FLOATS);
    const { det, n } = normalMatrix(m);
    if (!(det > 0)) throw new Error(`instance ${i} of element ${expressId} has determinant ${det}`);
    const count = shape.indices.length;
    const triangles = new Float64Array(count * 3);
    const normals = new Float64Array(count * 3);
    for (let k = 0; k < count; k++) {
      const v = shape.indices[k];
      const [x, y, z] = [shape.decoded[3 * v], shape.decoded[3 * v + 1], shape.decoded[3 * v + 2]];
      const [nx, ny, nz] = [shape.decodedNormals[3 * v], shape.decodedNormals[3 * v + 1], shape.decodedNormals[3 * v + 2]];
      for (let axis = 0; axis < 3; axis++) {
        triangles[3 * k + axis] = origin[axis] + m[axis] * x + m[3 + axis] * y + m[6 + axis] * z + m[9 + axis];
        normals[3 * k + axis] = n[axis] * nx + n[3 + axis] * ny + n[6 + axis] * nz;
      }
      const length = Math.hypot(normals[3 * k], normals[3 * k + 1], normals[3 * k + 2]);
      for (let axis = 0; axis < 3; axis++) normals[3 * k + axis] /= length;
    }
    // The shape's quantisation error, stretched by the longest column of the matrix.
    const stretch = Math.max(...[0, 3, 6].map((c) => Math.hypot(m[c], m[c + 1], m[c + 2])));
    emit({ expressId, rgba, flags, triangles, normals, tolerance: quantError(shape) * stretch });
  }
}

/** Half the 16-bit step on each axis, the most rounding moves a coordinate; zeros for f32. */
export function halfSteps(part) {
  if (part.vertexFormat !== 'q16') return [0, 0, 0];
  const grid = gridOf(part);
  return [0, 1, 2].map((axis) => (grid.max[axis] - grid.min[axis]) / 65535 / 2);
}

/**
 * The farthest a q16 vertex may lie from where it was, as a distance: each axis may be off by half
 * its own step, so up to the length of the half-step vector. 0 for f32.
 */
export function quantError(part) {
  return Math.hypot(...halfSteps(part));
}
