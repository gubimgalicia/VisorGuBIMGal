// T-158 (A13): the renderers' instance helpers (src/infrastructure/renderer/instances.ts) against
// values worked out here: ranges by shape and transparency, matrix rows from the contract's
// column-major layout, inverse-transpose normal rows, and the packed layouts of both backends.
// node --experimental-strip-types test/t158-instances-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';

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
const { planInstances, instanceRows, packInstances } = await import('../src/infrastructure/renderer/instances.ts');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

// Instances: [expressId, shapeId, rgba, flags]. Shape 7 opaque, shape 3 transparent by alpha, shape
// 7 transparent by flag, shape 3 opaque.
const table = new Uint32Array([
  10, 7, 0xffffffff, 0,
  11, 3, 0xff000080, 0,
  12, 7, 0xffffffff, 1,
  13, 3, 0x00ff00ff, 0,
  14, 7, 0x0000ffff, 0
]);

check('ranges group by shape, opaque before transparent, stable inside', () => {
  const plan = planInstances(table);
  assert.deepEqual(Array.from(plan.order), [3, 1, 0, 4, 2]);
  assert.deepEqual(plan.ranges, [
    { shapeId: 3, transparent: false, first: 0, count: 1 },
    { shapeId: 3, transparent: true, first: 1, count: 1 },
    { shapeId: 7, transparent: false, first: 2, count: 2 },
    { shapeId: 7, transparent: true, first: 4, count: 1 }
  ]);
});

// Column-major contract matrix: columns c0, c1, c2 (linear) and c3 (translation).
// L = [[2, 0, 0], [0, 3, 0], [0, 0, 5]] rotated 90 degrees about Z: L = Rz * S.
const m = new Float32Array([0, 2, 0, -3, 0, 0, 0, 0, 5, 10, 20, 30]);

check('rows are the transpose of the columns, translation last', () => {
  const { rows } = instanceRows(m, 0);
  assert.deepEqual(rows, [0, -3, 0, 10, 2, 0, 0, 20, 0, 0, 5, 30]);
  // p = (1, 1, 1): x = -3 + 10, y = 2 + 20, z = 5 + 30.
  const p = [1, 1, 1, 1];
  const dot = (r) => r.reduce((s, v, i) => s + v * p[i], 0);
  assert.deepEqual([dot(rows.slice(0, 4)), dot(rows.slice(4, 8)), dot(rows.slice(8, 12))], [7, 22, 35]);
});

check('normal rows are the inverse transpose: a face keeps facing out under a stretch', () => {
  const { normalRows } = instanceRows(m, 0);
  // inverse(L)^T for L = Rz S is Rz S^-1: rows [[0, -1/3, 0], [1/2, 0, 0], [0, 0, 1/5]].
  assert.ok(near(normalRows, [0, -1 / 3, 0, 1 / 2, 0, 0, 0, 0, 1 / 5]), JSON.stringify(normalRows));
  // A plane x + y = 1 in shape space has normal (1, 1, 0); placed, its points satisfy
  // n_world . p = const for n_world = N (1, 1, 0).
  const n = [0 * 1 + -1 / 3 * 1, 1 / 2 * 1 + 0, 0];
  const place = (q) => [0 * q[0] - 3 * q[1], 2 * q[0] + 0 * q[1], 5 * q[2]];
  const a = place([1, 0, 0]), b = place([0, 1, 0]), c = place([1, 0, 4]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  assert.ok(Math.abs(dot(n, a) - dot(n, b)) < 1e-9 && Math.abs(dot(n, a) - dot(n, c)) < 1e-9);
});

check('a mirrored or flat matrix has no rows', () => {
  assert.equal(instanceRows(new Float32Array([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 0), null);
  assert.equal(instanceRows(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), 0), null);
});

const transforms = new Float32Array(5 * 12);
for (let i = 0; i < 5; i++) transforms.set([1, 0, 0, 0, 1, 0, 0, 0, 1, i, 0, 0], i * 12);

check('WebGPU layout: 16-byte header, 96 bytes per instance, record at 92', () => {
  const plan = planInstances(table);
  const buffer = packInstances({ instanceTable: table, instanceTransforms: transforms }, plan, 40, 'webgpu', 16);
  assert.equal(buffer.byteLength, 16 + 5 * 96);
  const f32 = new Float32Array(buffer), u32 = new Uint32Array(buffer);
  plan.order.forEach((index, at) => {
    const base = (16 + at * 96) / 4;
    assert.equal(f32[base + 3], index, 'translation x of row 0');
    assert.ok(near(Array.from(f32.subarray(base + 12, base + 15)), [1, 0, 0]), 'normal row 0');
    assert.ok(near(Array.from(f32.subarray(base + 16, base + 19)), [0, 1, 0]), 'normal row 1 at 64');
    assert.ok(near(Array.from(f32.subarray(base + 20, base + 23)), [0, 0, 1]), 'normal row 2 at 80');
    assert.equal(u32[base + 23], 40 + at, 'record at 92');
  });
});

check('WebGL2 layout: 88 bytes per instance, normal rows at 48, 60, 72, record at 84', () => {
  const plan = planInstances(table);
  const buffer = packInstances({ instanceTable: table, instanceTransforms: transforms }, plan, 0, 'webgl2');
  assert.equal(buffer.byteLength, 5 * 88);
  const f32 = new Float32Array(buffer), u32 = new Uint32Array(buffer);
  plan.order.forEach((index, at) => {
    const base = (at * 88) / 4;
    assert.equal(f32[base + 3], index);
    assert.ok(near(Array.from(f32.subarray(base + 12, base + 21)), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    assert.equal(u32[base + 21], at);
  });
});

console.log(`\nt158-instances-test: ${passed}/6 pass`);
