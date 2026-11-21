// Checks the pure part of the drawing path, with no browser or kernel.
// usage: node --experimental-strip-types scripts/check-drawing-request.mjs
import assert from 'node:assert/strict';
import {
  drawingRequest,
  frameExcludesAll,
  frameModels
} from '../src/infrastructure/kernel/drawingRequest.ts';

const plan = (depth) => ({
  cut: { kind: 'plan', elevation: 1.2, depth },
  frame: { kind: 'project' },
  includeProjection: true,
  includeHiddenLines: true,
  includeHatching: false
});
const DEPTH = 3;

assert.ok(Number.isNaN(drawingRequest(plan(undefined))[DEPTH]), 'no depth stays NaN');
assert.equal(drawingRequest(plan(4))[DEPTH], 4);
assert.equal(drawingRequest(plan(Number.NaN))[DEPTH], -1, 'a depth of NaN must reach bad-depth');
assert.equal(drawingRequest(plan(-5))[DEPTH], -5);
assert.equal(drawingRequest(plan(Infinity))[DEPTH], Infinity);

const map = { kind: 'map' };
const reference = { localToMap: [1], crsId: 'EPSG:25829', confidence: 'verified' };

// A closed model has no reference left: it is lost, not ungeoreferenced.
const closed = frameModels(map, [{ modelId: 'a', open: false }]);
assert.deepEqual(closed.included, [{ index: 0, modelId: 'a' }]);
assert.deepEqual(closed.diagnostics, []);

const plain = frameModels(map, [{ modelId: 'a', open: true }]);
assert.deepEqual(plain.included, []);
assert.equal(plain.diagnostics[0].code, 'map-frame-no-georeference');

// Positions in the list number the models, so a skipped model must not shift the others.
const mixed = frameModels(map, [
  { modelId: 'a', open: true },
  { modelId: 'b', open: true, reference }
]);
assert.deepEqual(mixed.included.map(({ index, modelId }) => [index, modelId]), [[1, 'b']]);
assert.equal(mixed.crsId, 'EPSG:25829');

// One open model the frame excludes, one closed model: the open one decides the error.
const both = [
  { modelId: 'a', open: true },
  { modelId: 'b', open: false }
];
assert.equal(frameExcludesAll(both, frameModels(map, both).included), true);
assert.equal(frameExcludesAll([{ modelId: 'b', open: false }], [{ index: 0, modelId: 'b' }]), false);
const fine = [
  { modelId: 'a', open: true, reference },
  { modelId: 'b', open: false }
];
assert.equal(frameExcludesAll(fine, frameModels(map, fine).included), false);

console.log('drawing requests pass');
