// T-159 (C13): the pure model comparison behind "compare two versions". Elements are matched by
// GlobalId only (expressIds are reassigned by every export); duplicates are reported rather than
// guessed at, and a geometry hash on one side only is not evidence of a change.
// node --experimental-strip-types test/t159-model-diff-test.mjs
import assert from 'node:assert/strict';
import { diffModels } from '../src/domain/compare/modelDiff.ts';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

/** A snapshot with only the fields a case cares about. */
const el = (globalId, fields = {}) => ({ globalId, expressId: 1, ifcType: 'IfcWall', properties: {}, ...fields });

/** Freezing makes any in-place sort or write throw in module (strict) code. */
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

check('empty inputs give an empty diff', () => {
  assert.deepEqual(diffModels([], []), { added: [], removed: [], changed: [], unchanged: 0, duplicates: [] });
});

check('an element only in after is added', () => {
  const after = el('A', { expressId: 2 });
  const diff = diffModels([], [after]);
  assert.deepEqual(diff.added, [after]);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.unchanged, 0);
});

check('an element only in before is removed', () => {
  const before = el('A', { expressId: 1 });
  const diff = diffModels([before], []);
  assert.deepEqual(diff.removed, [before]);
  assert.deepEqual(diff.added, []);
  assert.equal(diff.unchanged, 0);
});

check('identical matched pairs count as unchanged', () => {
  const before = [el('A', { expressId: 1 }), el('B', { expressId: 2, properties: { 'Pset_X.Y': 'z' } })];
  const after = [el('A', { expressId: 1 }), el('B', { expressId: 2, properties: { 'Pset_X.Y': 'z' } })];
  const diff = diffModels(before, after);
  assert.equal(diff.unchanged, 2);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

check('a changed ifcType is a type change', () => {
  const diff = diffModels([el('G', { expressId: 1, ifcType: 'IfcWall' })], [el('G', { expressId: 1, ifcType: 'IfcDoor' })]);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0].changes, ['type']);
  assert.deepEqual(diff.changed[0].properties, []);
  assert.equal(diff.unchanged, 0);
});

check('a changed name is a name change, including a name that appears or disappears', () => {
  const renamed = diffModels([el('G', { expressId: 1, name: 'Wall 1' })], [el('G', { expressId: 1, name: 'Wall 2' })]);
  assert.deepEqual(renamed.changed[0].changes, ['name']);

  const appeared = diffModels([el('H', { expressId: 2 })], [el('H', { expressId: 2, name: 'Wall 1' })]);
  assert.deepEqual(appeared.changed[0].changes, ['name']);
  assert.equal(appeared.unchanged, 0);
});

check('a changed property value is a properties change, listed and sorted by key', () => {
  const before = el('G', {
    expressId: 1,
    properties: { 'Pset_WallCommon.Reference': 'A', 'Pset_Alpha.X': '1' }
  });
  const after = el('G', {
    expressId: 1,
    properties: { 'Pset_WallCommon.Reference': 'B', 'Pset_Alpha.X': '2' }
  });
  const diff = diffModels([before], [after]);
  assert.deepEqual(diff.changed[0].changes, ['properties']);
  assert.deepEqual(diff.changed[0].properties, [
    { key: 'Pset_Alpha.X', before: '1', after: '2' },
    { key: 'Pset_WallCommon.Reference', before: 'A', after: 'B' }
  ]);
});

check('a property present on one side only is a properties change with one side filled in', () => {
  const before = el('G', { expressId: 1, properties: { 'Pset_A.Alpha': '1', 'Pset_B.Beta': '2' } });
  const after = el('G', { expressId: 1, properties: { 'Pset_B.Beta': '2', 'Pset_C.Gamma': '3' } });
  const diff = diffModels([before], [after]);
  assert.deepEqual(diff.changed[0].changes, ['properties']);
  assert.deepEqual(diff.changed[0].properties, [
    { key: 'Pset_A.Alpha', before: '1' },
    { key: 'Pset_C.Gamma', after: '3' }
  ]);
});

check('two different geometry hashes are a geometry change', () => {
  const diff = diffModels([el('G', { expressId: 1, geometryHash: 'h1' })], [el('G', { expressId: 1, geometryHash: 'h2' })]);
  assert.deepEqual(diff.changed[0].changes, ['geometry']);
  assert.equal(diff.unchanged, 0);
});

check('a geometry hash on one side only is not a change', () => {
  const addedLater = diffModels([el('G', { expressId: 1 })], [el('G', { expressId: 1, geometryHash: 'h1' })]);
  assert.equal(addedLater.unchanged, 1);
  assert.deepEqual(addedLater.changed, []);

  const lostLater = diffModels([el('G', { expressId: 1, geometryHash: 'h1' })], [el('G', { expressId: 1 })]);
  assert.equal(lostLater.unchanged, 1);
  assert.deepEqual(lostLater.changed, []);
});

check('the same globalId with a different expressId is unchanged', () => {
  const diff = diffModels(
    [el('G', { expressId: 10, ifcType: 'IfcWall', properties: { 'Pset_X.Y': 'z' } })],
    [el('G', { expressId: 99, ifcType: 'IfcWall', properties: { 'Pset_X.Y': 'z' } })]
  );
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

check('a globalId repeated on one side is reported in duplicates and left out of the diff', () => {
  const diff = diffModels(
    [
      el('X', { expressId: 10 }),
      el('X', { expressId: 11 }),
      el('Y', { expressId: 20 }),
      el('Z', { expressId: 30 })
    ],
    [
      el('X', { expressId: 12 }),
      el('Y', { expressId: 21 }),
      el('Y', { expressId: 22 }),
      el('W', { expressId: 40 })
    ]
  );
  assert.deepEqual(diff.duplicates, [
    { side: 'before', globalId: 'X', expressIds: [10, 11] },
    { side: 'after', globalId: 'Y', expressIds: [21, 22] }
  ]);
  assert.deepEqual(diff.added, [el('W', { expressId: 40 })]);
  assert.deepEqual(diff.removed, [el('Z', { expressId: 30 })]);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.unchanged, 0);
});

check('added, removed and changed are sorted by globalId', () => {
  const diff = diffModels(
    [el('d', { expressId: 4 }), el('b', { expressId: 2 }), el('a', { expressId: 1, ifcType: 'IfcWall' })],
    [el('c', { expressId: 3 }), el('a', { expressId: 1, ifcType: 'IfcSlab' }), el('e', { expressId: 5 })]
  );
  assert.deepEqual(diff.added.map((element) => element.globalId), ['c', 'e']);
  assert.deepEqual(diff.removed.map((element) => element.globalId), ['b', 'd']);
  assert.deepEqual(diff.changed.map((pair) => pair.before.globalId), ['a']);
});

check('the inputs are not modified', () => {
  const before = deepFreeze([el('b', { expressId: 2 }), el('a', { expressId: 1, properties: { 'Pset_X.Y': '1' } })]);
  const after = deepFreeze([el('c', { expressId: 3 }), el('a', { expressId: 1, properties: { 'Pset_X.Y': '2' } })]);
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  diffModels(before, after);
  assert.equal(JSON.stringify(before), beforeJson);
  assert.equal(JSON.stringify(after), afterJson);
  assert.deepEqual(before.map((element) => element.globalId), ['b', 'a']);
});

check('twenty thousand elements per side compare in under a second', () => {
  const before = [];
  const after = [];
  for (let i = 0; i < 20000; i++) {
    // ExpressIds deliberately differ between the two exports.
    before.push(el(`G${i}`, { expressId: i + 1, geometryHash: `h${i % 1000}` }));
  }
  for (let i = 1000; i < 21000; i++) {
    after.push(
      el(`G${i}`, {
        expressId: i + 100000,
        ifcType: i % 500 === 0 ? 'IfcDoor' : 'IfcWall',
        geometryHash: `h${i % 1000}`
      })
    );
  }
  const started = performance.now();
  const diff = diffModels(before, after);
  const elapsed = performance.now() - started;

  assert.equal(diff.added.length, 1000);
  assert.equal(diff.removed.length, 1000);
  assert.equal(diff.changed.length, 38);
  assert.equal(diff.unchanged, 18962);
  assert.equal(diff.added[0].globalId, 'G20000');
  assert.equal(diff.removed[0].globalId, 'G0');
  assert.ok(elapsed < 1000, `diffModels took ${elapsed.toFixed(1)} ms`);
});

console.log(`\nt159-model-diff-test: ${passed}/15 pass`);
