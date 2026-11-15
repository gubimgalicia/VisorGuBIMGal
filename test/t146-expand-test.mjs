// T-146: the v2 batch expander (scripts/bench/expand-batch.mjs) against batches made here by an
// independent reference encoder from a real v1 batch: 16-bit positions, octahedral normals, and a
// record turned into a shared shape plus an instance under a rotated, non-uniformly scaled matrix.
// node --experimental-strip-types test/t146-expand-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expandBatch } from '../scripts/bench/expand-batch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(REPO, 'src/infrastructure/kernel/pkg');
const { initSync, Model } = await import(pathToFileURL(path.join(pkg, 'wasm_api.js')).href);
initSync({ module: readFileSync(path.join(pkg, 'wasm_api_bg.wasm')) });

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

// ---- One real v1 batch ----
const model = new Model(readFileSync(path.join(REPO, 'public/samples/SimpleWall.ifc')));
model.startStream();
const view = model.nextBatch(65536);
const b = view.bounds();
const v1 = {
  origin: Array.from(view.origin()),
  box: { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] },
  vertexFormat: 'f32',
  positions: view.takePositions(),
  normals: view.takeNormals(),
  indices: view.takeIndices(),
  meshTable: view.takeMeshTable()
};
view.free();
const collect = (batch, shapes = new Map()) => { const out = []; expandBatch(batch, shapes, (r) => out.push(r)); return out; };
const truth = collect(v1);
const maxDiff = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
const angle = (a, b) => {
  let worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    const cross = Math.hypot(a[i + 1] * b[i + 2] - a[i + 2] * b[i + 1], a[i + 2] * b[i] - a[i] * b[i + 2], a[i] * b[i + 1] - a[i + 1] * b[i]);
    worst = Math.max(worst, (Math.atan2(cross, a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2]) * 180) / Math.PI);
  }
  return worst;
};

check('v1 expansion equals origin + positions read straight from the arrays', () => {
  const r = truth[0];
  const [, , , firstIndex] = v1.meshTable;
  const v = v1.indices[firstIndex];
  for (let axis = 0; axis < 3; axis++) assert.equal(r.triangles[axis], v1.origin[axis] + v1.positions[3 * v + axis]);
  assert.equal(truth.length, v1.meshTable.length / 7);
});

// ---- Reference encoder, written from the definitions in docs/09, not from the decoder ----
function encodeQ16(positions, min, max) {
  const q = new Uint16Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3, span = max[axis] - min[axis];
    q[i] = span > 0 ? Math.round(((positions[i] - min[axis]) / span) * 65535) : 0;
  }
  return q;
}
function encodeOct(normals) {
  const out = new Int16Array((normals.length / 3) * 2);
  for (let v = 0; v < normals.length / 3; v++) {
    let [x, y, z] = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]];
    const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
    x /= l1; y /= l1; z /= l1;
    if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
    out[2 * v] = Math.round(x * 32767);
    out[2 * v + 1] = Math.round(y * 32767);
  }
  return out;
}
const halfStep = (box) => Math.max(...[0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 65535)) / 2;

check('q16 positions and octahedral normals decode within half a step and 0.01 degrees', () => {
  const v2 = { ...v1, vertexFormat: 'q16', positions: encodeQ16(v1.positions, v1.box.min, v1.box.max), normals: encodeOct(v1.normals) };
  const got = collect(v2);
  assert.equal(got.length, truth.length);
  const bound = halfStep(v1.box);
  got.forEach((r, i) => {
    assert.ok(maxDiff(r.triangles, truth[i].triangles) <= bound * 1.0001, `record ${i} position`);
    assert.ok(angle(r.normals, truth[i].normals) < 0.01, `record ${i} normal ${angle(r.normals, truth[i].normals)}`);
    assert.ok(Math.abs(r.tolerance - bound) < 1e-12, 'tolerance is half a step');
  });
});

// ---- A record as a shape plus an instance ----
// M = R · S, rotation about a tilted axis and a non-uniform scale, so normals need M^-T.
const R = (() => {
  const [ax, ay, az] = [0.2, 0.3, 0.93].map((v, _, a) => v / Math.hypot(...a));
  const t = 0.7, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return [
    [c + ax * ax * k, ax * ay * k - az * s, ax * az * k + ay * s],
    [ay * ax * k + az * s, c + ay * ay * k, ay * az * k - ax * s],
    [az * ax * k - ay * s, az * ay * k + ax * s, c + az * az * k]
  ];
})();
const S = [2, 0.5, 1.25];
const M = R.map((row) => row.map((v, j) => v * S[j]));
const Minv = (() => { // (R S)^-1 = S^-1 R^T
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[j][i] / S[i]));
})();

function asInstance(source, recordIndex, transform, inverse) {
  const rec = source.meshTable.subarray(recordIndex * 7, recordIndex * 7 + 7);
  const [expressId, firstVertex, vertexCount, firstIndex, indexCount, rgba, flags] = rec;
  // Shape coordinates: absolute vertex = origin + M · local + t, with t the record's first vertex.
  const t = [0, 1, 2].map((a) => source.positions[3 * firstVertex + a]);
  const local = new Float32Array(vertexCount * 3), localNormals = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const p = [0, 1, 2].map((a) => source.positions[3 * (firstVertex + v) + a] - t[a]);
    const n = [0, 1, 2].map((a) => source.normals[3 * (firstVertex + v) + a]);
    for (let i = 0; i < 3; i++) {
      local[3 * v + i] = inverse[i][0] * p[0] + inverse[i][1] * p[1] + inverse[i][2] * p[2];
      // n_local ∝ M^T n_world, so that M^-T n_local ∝ n_world.
      localNormals[3 * v + i] = transform[0][i] * n[0] + transform[1][i] * n[1] + transform[2][i] * n[2];
    }
    const l = Math.hypot(localNormals[3 * v], localNormals[3 * v + 1], localNormals[3 * v + 2]);
    for (let i = 0; i < 3; i++) localNormals[3 * v + i] /= l;
  }
  const indices = Uint32Array.from(source.indices.subarray(firstIndex, firstIndex + indexCount), (i) => i - firstVertex);
  const matrix = new Float32Array([transform[0][0], transform[1][0], transform[2][0], transform[0][1], transform[1][1], transform[2][1], transform[0][2], transform[1][2], transform[2][2], t[0], t[1], t[2]]);
  const meshTable = new Uint32Array([...source.meshTable.subarray(0, recordIndex * 7), ...source.meshTable.subarray(recordIndex * 7 + 7)]);
  return {
    batch: {
      ...source,
      meshTable,
      shapes: [{ shapeId: 7, vertexFormat: 'f32', box: { min: [0, 0, 0], max: [0, 0, 0] }, positions: local, normals: localNormals, indices }],
      instanceTable: new Uint32Array([expressId, 7, rgba, flags]),
      instanceTransforms: matrix
    },
    rec: { expressId, rgba, flags }
  };
}

check('an instance under a rotated, non-uniformly scaled matrix expands to the original record', () => {
  const { batch, rec } = asInstance(v1, 0, M, Minv);
  const got = collect(batch);
  assert.equal(got.length, truth.length);
  const inst = got[got.length - 1];
  assert.deepEqual([inst.expressId, inst.rgba, inst.flags], [rec.expressId, rec.rgba, rec.flags]);
  assert.ok(maxDiff(inst.triangles, truth[0].triangles) < 2e-6, `position ${maxDiff(inst.triangles, truth[0].triangles)}`);
  assert.ok(angle(inst.normals, truth[0].normals) < 0.01, `normal ${angle(inst.normals, truth[0].normals)}`);
  // The other records are untouched.
  got.slice(0, -1).forEach((r, i) => assert.equal(maxDiff(r.triangles, truth[i + 1].triangles), 0));
});

check('a q16 shape under a scaled matrix stays within its stretched tolerance', () => {
  const { batch } = asInstance(v1, 0, M, Minv);
  const shape = batch.shapes[0];
  const min = [0, 1, 2].map((a) => Math.min(...shape.positions.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...shape.positions.filter((_, i) => i % 3 === a)));
  batch.shapes[0] = { ...shape, vertexFormat: 'q16', box: { min, max }, positions: encodeQ16(shape.positions, min, max), normals: encodeOct(shape.normals) };
  const inst = collect(batch).at(-1);
  const err = maxDiff(inst.triangles, truth[0].triangles);
  assert.ok(err <= inst.tolerance + 2e-6, `error ${err} above tolerance ${inst.tolerance}`);
  // R is a rotation, so the columns of R · S have the lengths of S: the stretch is max(S).
  const expected = halfStep({ min, max }) * Math.max(...S);
  assert.ok(Math.abs(inst.tolerance - expected) <= expected * 1e-5, `tolerance ${inst.tolerance}, expected ${expected}`);
  assert.ok(angle(inst.normals, truth[0].normals) < 0.02);
});

check('a mirrored instance, an unknown shape and a shape sent twice are refused', () => {
  const mirror = M.map((row) => [row[0], row[1], -row[2]]);
  const mirrorInv = Minv.map((row, i) => (i === 2 ? row.map((v) => -v) : row));
  assert.throws(() => collect(asInstance(v1, 0, mirror, mirrorInv).batch), /determinant/);
  const { batch } = asInstance(v1, 0, M, Minv);
  assert.throws(() => collect({ ...batch, instanceTable: new Uint32Array([1, 99, 0, 0]) }), /unknown shape/);
  const shapes = new Map();
  collect(batch, shapes);
  assert.throws(() => collect(batch, shapes), /sent twice/);
});

console.log(`\nt146-expand-test: ${passed}/5 pass`);
