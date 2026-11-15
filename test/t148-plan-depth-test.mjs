// T-148: a plan's default projection depth, down to the storey the cut stands in.
// node --experimental-strip-types test/t148-plan-depth-test.mjs
import assert from 'node:assert/strict';
import { defaultPlanDepth, FALLBACK_PLAN_DEPTH, FLOOR_MARGIN } from '../src/ui/viewer/planDepth.ts';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const node = (type, name, level, children = []) => ({ expressId: 1, type, name, level, children, elements: [] });
const tree = (...storeys) => ({ root: node('IfcProject', 'p', undefined, [node('IfcSite', 's', undefined, [node('IfcBuilding', 'b', undefined, storeys)])]), unassigned: [] });
const near = (a, b) => Math.abs(a - b) < 1e-12;

// Levels 17.4 and 20.4 m, as in the placement test of crates/wasm-api/tests/storey_levels.rs.
const offsetBuilding = tree(node('IfcBuildingStorey', 'A', 17.4), node('IfcBuildingStorey', 'B', 20.4));

check('the cut in storey A projects down to A plus the floor margin', () => {
  const got = defaultPlanDepth(18.6, [offsetBuilding]);
  assert.equal(got.storey.name, 'A');
  assert.ok(near(got.depth, 18.6 - 17.4 + FLOOR_MARGIN), String(got.depth));
});

check('the cut in the upper storey stops at that storey, not the lowest', () => {
  const got = defaultPlanDepth(21.6, [offsetBuilding]);
  assert.equal(got.storey.name, 'B');
  assert.ok(near(got.depth, 1.2 + FLOOR_MARGIN), String(got.depth));
});

check('a cut exactly at a level belongs to that storey', () => {
  const got = defaultPlanDepth(20.4, [offsetBuilding]);
  assert.equal(got.storey.name, 'B');
  assert.ok(near(got.depth, FLOOR_MARGIN));
});

check('below every storey, or without storeys or levels, the fallback depth', () => {
  assert.deepEqual(defaultPlanDepth(10, [offsetBuilding]), { depth: FALLBACK_PLAN_DEPTH, storey: null });
  assert.deepEqual(defaultPlanDepth(10, [tree()]), { depth: FALLBACK_PLAN_DEPTH, storey: null });
  assert.deepEqual(defaultPlanDepth(10, [tree(node('IfcBuildingStorey', 'no level', undefined))]), { depth: FALLBACK_PLAN_DEPTH, storey: null });
  assert.deepEqual(defaultPlanDepth(10, [null, undefined]), { depth: FALLBACK_PLAN_DEPTH, storey: null });
  assert.deepEqual(defaultPlanDepth(Number.NaN, [offsetBuilding]), { depth: FALLBACK_PLAN_DEPTH, storey: null });
});

check('storeys of several models count together, and only storeys count', () => {
  const other = tree(node('IfcBuildingStorey', 'C', 19.0), node('IfcSpace', 'a room at 19.9', 19.9));
  const got = defaultPlanDepth(20.0, [offsetBuilding, other]);
  assert.equal(got.storey.name, 'C');
  assert.ok(near(got.depth, 1.0 + FLOOR_MARGIN));
});

console.log(`\nt148-plan-depth-test: ${passed}/5 pass`);
