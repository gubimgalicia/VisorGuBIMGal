// T-153 (A11): contract v2 on the JS side. findBatchError against a real kernel batch and against
// one deliberate violation of each rule in docs/05 section 3 (docs/09 revision 4), and the OPFS
// cache's format 2 round trip: a q16 batch with an odd number of 16-bit indices, an instance-only
// batch (quantBox null) with a shape, and an f32 batch with 32-bit indices.
// node --experimental-strip-types test/t153-contract-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBatchError, MAX_QUANT_STEP } from '../src/domain/kernel/GeometryBatch.ts';
import { registerHooks } from 'node:module';
import { takeBatch } from '../scripts/lib/take-batch.mjs';

// The app's modules import each other without extensions, as Vite resolves them; so does Node here.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  }
});
const { CacheCorrupt, CacheReader, CacheWriter } = await import('../src/infrastructure/kernel/geometryCache.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(REPO, 'src/infrastructure/kernel/pkg');
const { initSync, Model } = await import(pathToFileURL(path.join(pkg, 'wasm_api.js')).href);
initSync({ module: readFileSync(path.join(pkg, 'wasm_api_bg.wasm')) });

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

const model = new Model(readFileSync(path.join(REPO, 'public/samples/ManySimpleWalls.ifc')));
model.startStream();
const real = { modelId: 'm', sequence: 1, ...takeBatch(model.nextBatch(65536)) };
model.free();

/** A deep copy, so each mutant starts clean. */
const copy = (batch) => ({
  ...batch,
  box: { min: [...batch.box.min], max: [...batch.box.max] },
  quantBox: batch.quantBox && { min: [...batch.quantBox.min], max: [...batch.quantBox.max] },
  positions: batch.positions.slice(),
  normals: batch.normals.slice(),
  indices: batch.indices.slice(),
  meshTable: batch.meshTable.slice(),
  shapes: batch.shapes.map((shape) => ({ ...shape })),
  instanceTable: batch.instanceTable.slice(),
  instanceTransforms: batch.instanceTransforms.slice()
});
const rejects = (batch, pattern, knownShapes) => {
  const error = findBatchError(batch, knownShapes);
  assert.ok(error && pattern.test(error), `expected ${pattern}, got ${error}`);
};

check('a real kernel batch is q16 with 16-bit indices and passes', () => {
  assert.equal(real.vertexFormat, 'q16');
  assert.ok(real.positions instanceof Uint16Array && real.normals instanceof Int16Array && real.indices instanceof Uint16Array);
  assert.deepEqual(real.box, real.quantBox);
  assert.equal(findBatchError(real), null);
});

check('q16 layout: whole vertices of four, two normal components each', () => {
  const b = copy(real);
  b.positions = b.positions.subarray(0, b.positions.length - 1);
  rejects(b, /multiple of 4/);
  const c = copy(real);
  c.normals = c.normals.subarray(0, c.normals.length - 2);
  rejects(c, /two per vertex/);
});

check('q16 grid: each axis with extent reaches 0 and 65535, a flat one stays at 0', () => {
  const b = copy(real);
  for (let at = 0; at < b.positions.length; at += 4) if (b.positions[at] === 65535) b.positions[at] = 65534;
  rejects(b, /exact box/);
  const c = copy(real);
  c.quantBox.max[2] = c.quantBox.min[2];
  c.box.max[2] = c.box.min[2];
  rejects(c, /exact box/);
});

check('q16 grid: a step over MAX_QUANT_STEP is refused', () => {
  const b = copy(real);
  b.quantBox.max[0] = b.quantBox.min[0] + 65535 * MAX_QUANT_STEP * 1.01;
  b.box.max[0] = b.quantBox.max[0];
  rejects(b, /MAX_QUANT_STEP/);
});

check('q16 records: each vertex carries its own record', () => {
  const b = copy(real);
  b.positions[3] += 1;
  rejects(b, /carries record/);
});

check('boxes: quantBox present with vertices, finite, ordered, and equal to box without instances', () => {
  const b = copy(real);
  b.quantBox = null;
  rejects(b, /quantBox is null/);
  const c = copy(real);
  c.box.min[1] = Number.NaN;
  rejects(c, /not finite/);
  const d = copy(real);
  d.box.min[0] = d.box.max[0] + 1;
  rejects(d, /min above max/);
  const e = copy(real);
  e.box.max[0] += 0.5;
  rejects(e, /box differs from quantBox/);
});

check('16-bit indices only up to 65536 vertices', () => {
  const vertices = 65537;
  const positions = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) positions[3 * v] = (v % 100) / 100;
  const normals = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) normals[3 * v + 2] = 1;
  const box = { min: [0, 0, 0], max: [Math.fround(0.99), 0, 0] };
  const batch = {
    modelId: 'm', sequence: 1, origin: [0, 0, 0], box, quantBox: box, vertexFormat: 'f32',
    positions, normals, indices: new Uint16Array([0, 1, 2]),
    meshTable: new Uint32Array([1, 0, vertices, 0, 3, 0xffffffff, 0]),
    shapes: [], instanceTable: new Uint32Array(0), instanceTransforms: new Float32Array(0)
  };
  rejects(batch, /16-bit indices/);
  assert.equal(findBatchError({ ...batch, indices: new Uint32Array([0, 1, 2]) }), null);
});

// ---- Shapes and instances (A13 sends them; the contract defines them now) ----
const shapeQ16 = {
  shapeId: 1,
  vertexFormat: 'q16',
  positions: new Uint16Array([0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 65535, 0]),
  normals: new Int16Array([0, 0, 0, 0, 0, 0]),
  indices: new Uint16Array([0, 1, 2]),
  box: { min: [0, 0, 0], max: [1, 1, 1] },
  closed: false
};
const identityAt = (x) => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, x, 5000, 0]);
/** Instances only: no vertices of its own, so quantBox is null and box holds the shapes. */
const instanceOnly = () => ({
  modelId: 'm', sequence: 2, origin: [0, 0, 0],
  box: { min: [10, 5000, 0], max: [21, 5001, 1] }, quantBox: null, vertexFormat: 'f32',
  positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
  meshTable: new Uint32Array(0),
  shapes: [{ ...shapeQ16 }],
  instanceTable: new Uint32Array([7, 1, 0xffffffff, 0, 8, 1, 0xffffffff, 0]),
  instanceTransforms: new Float32Array([...identityAt(10), ...identityAt(20)])
});

check('an instance-only batch whose box leaves out its origin passes; quantBox must be null', () => {
  assert.equal(findBatchError(instanceOnly()), null);
  rejects({ ...instanceOnly(), quantBox: { min: [0, 0, 0], max: [0, 0, 0] } }, /quantBox must be null/);
});

check('an instance must fit inside box, with half a step of slack in q16', () => {
  const b = instanceOnly();
  b.box = { min: [10, 5000, 0], max: [20.5, 5001, 1] };
  rejects(b, /shape leaves box/);
});

check('determinant normal and positive in f32: 1e-40 and a mirror are refused', () => {
  const tiny = instanceOnly();
  tiny.instanceTransforms.set([1e-20, 0, 0, 0, 1e-20, 0, 0, 0, 1], 0);
  rejects(tiny, /determinant/);
  const mirror = instanceOnly();
  mirror.instanceTransforms.set([-1, 0, 0], 0);
  rejects(mirror, /determinant/);
});

check('shapes: unknown without knownShapes and accepted with them; defined twice refused', () => {
  const later = { ...instanceOnly(), shapes: [] };
  rejects(later, /unknown shape/);
  assert.equal(findBatchError(later, new Map([[1, shapeQ16]])), null);
  rejects(instanceOnly(), /defined twice/, new Map([[1, shapeQ16]]));
});

check('a q16 shape: grid exact and fourth component 0', () => {
  const b = instanceOnly();
  b.shapes[0] = { ...shapeQ16, positions: shapeQ16.positions.map((q, i) => (q === 65535 && i % 4 === 0 ? 65534 : q)) };
  rejects(b, /exact box/);
  const c = instanceOnly();
  c.shapes[0] = { ...shapeQ16, positions: shapeQ16.positions.map((q, i) => (i === 3 ? 1 : q)) };
  rejects(c, /fourth component/);
});

// ---- OPFS cache, format 2 ----
class MemoryFile {
  bytes = new Uint8Array(0);
  read(buffer, { at }) {
    const n = Math.max(0, Math.min(buffer.length, this.bytes.length - at));
    buffer.set(this.bytes.subarray(at, at + n));
    return n;
  }
  write(buffer, { at }) {
    if (at + buffer.length > this.bytes.length) {
      const grown = new Uint8Array(at + buffer.length);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(buffer, at);
    return buffer.length;
  }
  getSize() {
    return this.bytes.length;
  }
  flush() {}
  close() {}
}

const identity = { file: new Uint8Array(32).fill(1), kernel: new Uint8Array(32).fill(2) };
// One q16 triangle: three 16-bit indices, an odd count, so 6 bytes that the cache pads to 8.
const triangle = {
  modelId: 'm', sequence: 1, origin: [500000, 4700000, 12], box: { min: [0, 0, 3], max: [2, 1, 3] },
  quantBox: { min: [0, 0, 3], max: [2, 1, 3] }, vertexFormat: 'q16',
  positions: new Uint16Array([0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 0, 0]),
  normals: new Int16Array([0, 0, 0, 0, 0, 0]), indices: new Uint16Array([0, 1, 2]),
  meshTable: new Uint32Array([9, 0, 3, 0, 3, 0xffffffff, 0]),
  shapes: [], instanceTable: new Uint32Array(0), instanceTransforms: new Float32Array(0)
};
const f32Batch = {
  modelId: 'm', sequence: 3, origin: [1, 2, 3], box: { min: [0, 0, 0], max: [1, 1, 0] },
  quantBox: { min: [0, 0, 0], max: [1, 1, 0] }, vertexFormat: 'f32',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]), meshTable: new Uint32Array([5, 0, 3, 0, 3, 0x808080ff, 0]),
  shapes: [], instanceTable: new Uint32Array(0), instanceTransforms: new Float32Array(0)
};

function roundTrip(batches) {
  const file = new MemoryFile();
  const writer = new CacheWriter(file, identity);
  writer.summary('{"s":1}');
  batches.forEach((batch, i) => {
    const { modelId, ...cached } = batch;
    writer.batch(cached, i + 1, batches.length);
  });
  writer.complete('{"c":1}');
  writer.tree(null);
  writer.finish(1000);
  const reader = CacheReader.open(file, identity, 2000);
  assert.ok(reader, 'the cache opens');
  const out = [];
  for (;;) {
    const step = reader.step();
    if (step.kind === 'complete') break;
    out.push(step.batch);
  }
  return { out, file };
}

const sameArray = (a, b, what) => {
  assert.equal(a.constructor, b.constructor, `${what} type`);
  assert.deepEqual(Array.from(a), Array.from(b), `${what} values`);
};
const sameBatch = (got, want) => {
  assert.equal(got.vertexFormat, want.vertexFormat);
  assert.deepEqual(got.origin, want.origin);
  assert.deepEqual(got.box, { min: [...want.box.min], max: [...want.box.max] });
  assert.deepEqual(got.quantBox, want.quantBox && { min: [...want.quantBox.min], max: [...want.quantBox.max] });
  for (const key of ['positions', 'normals', 'indices', 'meshTable', 'instanceTable', 'instanceTransforms']) {
    sameArray(got[key], want[key], key);
  }
  assert.equal(got.shapes.length, want.shapes.length);
  got.shapes.forEach((shape, i) => {
    const w = want.shapes[i];
    assert.deepEqual([shape.shapeId, shape.vertexFormat, shape.closed, shape.box], [w.shapeId, w.vertexFormat, w.closed, { min: [...w.box.min], max: [...w.box.max] }]);
    for (const key of ['positions', 'normals', 'indices']) sameArray(shape[key], w[key], `shape ${key}`);
  });
};

check('cache round trip: odd 16-bit indices, instance-only with quantBox null and a shape, f32', () => {
  assert.equal(findBatchError(triangle), null);
  const batches = [triangle, instanceOnly(), f32Batch, real];
  const { out } = roundTrip(batches);
  assert.equal(out.length, batches.length);
  out.forEach((got, i) => sameBatch(got, batches[i]));
  assert.equal(out[1].quantBox, null);
  assert.ok(out[0].indices instanceof Uint16Array && out[0].indices.length === 3);
});

check('cache: a batch record cut short is refused as corrupt', () => {
  const { file } = roundTrip([triangle]);
  // Lengthen the batch's declared index count without the bytes to match.
  const view = new DataView(file.bytes.buffer);
  const batchAt = 96 + 8 + new DataView(file.bytes.buffer).getUint32(96 + 4, true);
  const recordStart = ((batchAt + 3) & ~3) + 8;
  view.setUint32(recordStart + 88 + 8, view.getUint32(recordStart + 88 + 8, true) + 3, true);
  assert.throws(() => CacheReader.open(file, identity, 3000), CacheCorrupt);
});

console.log(`\nt153-contract-test: ${passed}/14 pass`);
