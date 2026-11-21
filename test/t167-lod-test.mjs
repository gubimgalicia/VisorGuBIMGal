// T-167 (A14): unit tests for renderer-side ShapeDef vertex-clustering LoD and per-range
// screen-error selection with hysteresis.
// Usage: node --experimental-strip-types test/t167-lod-test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && context.parentURL && !path.extname(specifier)) {
        const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + '.ts');
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
      }
      throw err;
    }
  }
});

const {
  buildShapeLods,
  chooseLodLevel,
  computeRangeLodBounds,
  LOD_ENTER_ERROR_PX,
  LOD_EXIT_ERROR_PX,
  LOD_MAX_KEEP_RATIO,
  LOD_MIN_SHAPE_TRIS,
  pointToBoxDistance
} = await import('../src/infrastructure/renderer/lodSimplify.ts');
const { planInstances } = await import('../src/infrastructure/renderer/instances.ts');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

/** Builds a UV-sphere ShapeDef of `rings x segments` (~2 * rings * segments triangles). */
function makeSphereShape(rings, segments, radius = 1, format = 'f32') {
  const rawPos = [];
  const rawNorm = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      const nx = sinP * Math.cos(theta);
      const ny = sinP * Math.sin(theta);
      const nz = cosP;
      rawPos.push(nx * radius, ny * radius, nz * radius);
      rawNorm.push(nx, ny, nz);
    }
  }
  const indices = [];
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      if (r > 0) indices.push(a, b, d);
      if (r < rings - 1) indices.push(b, c, d);
    }
  }
  const vertexCount = rawPos.length / 3;
  const box = { min: [-radius, -radius, -radius], max: [radius, radius, radius] };
  if (format === 'q16') {
    const qPos = new Uint16Array(vertexCount * 4);
    const qNorm = new Int16Array(vertexCount * 2);
    for (let v = 0; v < vertexCount; v++) {
      for (let axis = 0; axis < 3; axis++) {
        const val = rawPos[v * 3 + axis];
        qPos[v * 4 + axis] = Math.round(((val + radius) / (2 * radius)) * 65535);
      }
      qPos[v * 4 + 3] = 0;
    }
    return {
      shapeId: 1,
      vertexFormat: 'q16',
      positions: qPos,
      normals: qNorm,
      indices: new Uint16Array(indices),
      box,
      closed: true
    };
  }
  return {
    shapeId: 1,
    vertexFormat: 'f32',
    positions: new Float32Array(rawPos),
    normals: new Float32Array(rawNorm),
    indices: new Uint32Array(indices),
    box,
    closed: true
  };
}

check('shapes below LOD_MIN_SHAPE_TRIS produce no coarse LoD', () => {
  const small = makeSphereShape(8, 8, 0.5, 'q16'); // 112 tris < 128
  assert.ok(small.indices.length / 3 < LOD_MIN_SHAPE_TRIS);
  assert.deepEqual(buildShapeLods(small), []);
});

check('dense q16 and f32 shapes produce valid strictly coarser LoD index buffers reusing vertex ranges', () => {
  for (const format of ['q16', 'f32']) {
    const shape = makeSphereShape(40, 64, 0.2, format); // ~5,000 tris
    const baseTris = shape.indices.length / 3;
    const vertexCount = format === 'q16' ? shape.positions.length / 4 : shape.positions.length / 3;
    const lods = buildShapeLods(shape);
    assert.equal(lods.length, 2, `${format}: expected 2 coarse levels`);

    let prevTris = baseTris;
    let prevErr = 0;
    for (const lod of lods) {
      assert.equal(lod.indices.constructor, shape.indices.constructor, 'must preserve u16/u32 index type');
      assert.equal(lod.indices.length % 3, 0);
      const tris = lod.indices.length / 3;
      assert.ok(tris <= prevTris * LOD_MAX_KEEP_RATIO, `expected <= 60% of ${prevTris}, got ${tris}`);
      assert.ok(tris >= 4, `too few surviving triangles: ${tris}`);
      assert.ok(lod.errorLocal > prevErr, 'coarser level must have strictly larger errorLocal');
      for (let i = 0; i < lod.indices.length; i += 3) {
        const a = lod.indices[i];
        const b = lod.indices[i + 1];
        const c = lod.indices[i + 2];
        assert.ok(a < vertexCount && b < vertexCount && c < vertexCount, 'index out of vertex range');
        assert.ok(a !== b && b !== c && a !== c, 'degenerate triangle emitted');
      }
      prevTris = tris;
      prevErr = lod.errorLocal;
    }
  }
});

check('chooseLodLevel always returns LOD0 when eye is inside range AABB and drops to LOD1/LOD2 with distance', () => {
  const lods = [{ errorLocal: 0.01 }, { errorLocal: 0.04 }];
  const bounds = { min: [0, 0, 0], max: [2, 2, 2], maxStretch: 1 };
  const focalPx = 800; // ~700 px canvas at 45 deg FOV
  const persp = { scale: focalPx, perspective: true };

  // Inside AABB -> dMin = 0 -> LOD0 even if previously at LOD2
  assert.equal(pointToBoxDistance([1, 1, 1], bounds.min, bounds.max), 0);
  assert.equal(chooseLodLevel(lods, bounds, [1, 1, 1], persp, 2), 0);

  // Close (dMin = 2 m): LOD1 errorPx = 0.01/2 * 800 = 4.0 px > 1.5 -> LOD0
  assert.equal(chooseLodLevel(lods, bounds, [4, 1, 1], persp, 0), 0);

  // Medium (dMin = 10 m): LOD1 errorPx = 0.8 px <= 1.5, LOD2 errorPx = 3.2 px > 1.5 -> LOD1
  assert.equal(chooseLodLevel(lods, bounds, [12, 1, 1], persp, 0), 1);

  // Far (dMin = 30 m): LOD2 errorPx = 1.07 px <= 1.5 -> LOD2
  assert.equal(chooseLodLevel(lods, bounds, [32, 1, 1], persp, 0), 2);
});

check('chooseLodLevel applies hysteresis band between LOD_ENTER_ERROR_PX and LOD_EXIT_ERROR_PX', () => {
  const lods = [{ errorLocal: 0.01 }];
  const bounds = { min: [0, 0, 0], max: [0, 0, 0], maxStretch: 1 };
  const persp = { scale: 1000, perspective: true };
  // Midpoint error = 1.6 px (between 1.5 enter and 1.75 exit) -> d = 0.01 * 1000 / 1.6 = 6.25 m
  const midErr = (LOD_ENTER_ERROR_PX + LOD_EXIT_ERROR_PX) * 0.5;
  const distMid = (0.01 * 1000) / midErr;
  // Coming from LOD0: 1.6 > 1.5 -> stays LOD0
  assert.equal(chooseLodLevel(lods, bounds, [distMid, 0, 0], persp, 0), 0);
  // Coming from LOD1: 1.6 <= 1.75 -> stays LOD1
  assert.equal(chooseLodLevel(lods, bounds, [distMid, 0, 0], persp, 1), 1);
  // Moving closer (error = 2.0 > 1.75) -> steps back up to LOD0
  assert.equal(chooseLodLevel(lods, bounds, [5.0, 0, 0], persp, 1), 0);
});

check('computeRangeLodBounds computes world AABB and maxStretch for scaled instances', () => {
  // Two instances of shape 1 (box [-1,1]^3): one at (10,0,0) scale 1, one at (20,5,0) scale 2.
  const instanceTable = new Uint32Array([
    101, 1, 0xffffffff, 0,
    102, 1, 0xffffffff, 0
  ]);
  const transforms = new Float32Array([
    1, 0, 0,  0, 1, 0,  0, 0, 1,  10, 0, 0,
    2, 0, 0,  0, 2, 0,  0, 0, 2,  20, 5, 0
  ]);
  const plan = planInstances(instanceTable);
  const boxes = new Map([[1, { min: [-1, -1, -1], max: [1, 1, 1] }]]);
  const ranges = computeRangeLodBounds([100, 0, 0], transforms, plan, (id) => boxes.get(id));
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0].min, [109, -1, -2]);
  assert.deepEqual(ranges[0].max, [122, 7, 2]);
  assert.equal(ranges[0].maxStretch, 2);
});

console.log(`\nt167-lod-test: ${passed}/${passed} pass`);
