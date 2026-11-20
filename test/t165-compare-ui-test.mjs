// T-165 (C13 step 3): unit tests for the model comparison UI logic (counts, grouping, sorting,
// status-to-colour mapping, and before/after model pair defaults).
// node --experimental-strip-types test/t165-compare-ui-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !path.extname(specifier)) {
        try {
          return next(specifier + '.ts', context);
        } catch {
          return next(specifier + '/index.ts', context);
        }
      }
      throw error;
    }
  }
});

const { diffModels } = await import('../src/domain/compare/modelDiff.ts');
const {
  COMPARE_STATUS_HEX,
  COMPARE_STATUS_RGBA,
  buildCompareColorScheme,
  buildCompareView,
  defaultComparePair,
  groupCompareEntries,
  sortCompareEntries,
  summarizeCompareCounts
} = await import('../src/ui/viewer/compareView.ts');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

const snap = (globalId, fields = {}) => ({
  globalId,
  expressId: 1,
  ifcType: 'IfcWall',
  properties: {},
  ...fields
});

check('summarizeCompareCounts counts categories and breaks down every change kind', () => {
  const before = [
    snap('G-removed', { expressId: 10, ifcType: 'IfcDoor', name: 'Door 1' }),
    snap('G-name', { expressId: 11, ifcType: 'IfcWall', name: 'Wall A' }),
    snap('G-multi', {
      expressId: 12,
      ifcType: 'IfcWall',
      name: 'Wall B',
      properties: { 'Pset_WallCommon.IsExternal': 'true' },
      geometryHash: 'h1'
    }),
    snap('G-same', { expressId: 13, ifcType: 'IfcSlab', name: 'Slab 1' }),
    snap('G-dup', { expressId: 14 }),
    snap('G-dup', { expressId: 15 })
  ];
  const after = [
    snap('G-added', { expressId: 20, ifcType: 'IfcWindow', name: 'Window 1' }),
    snap('G-name', { expressId: 21, ifcType: 'IfcWall', name: 'Wall A renamed' }),
    snap('G-multi', {
      expressId: 22,
      ifcType: 'IfcBeam',
      name: 'Beam B',
      properties: { 'Pset_WallCommon.IsExternal': 'false' },
      geometryHash: 'h2'
    }),
    snap('G-same', { expressId: 23, ifcType: 'IfcSlab', name: 'Slab 1' })
  ];
  const diff = diffModels(before, after);
  const counts = summarizeCompareCounts(diff);

  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
  assert.equal(counts.changed, 2);
  assert.equal(counts.unchanged, 1);
  assert.equal(counts.duplicates, 1);
  assert.deepEqual(counts.byChangeKind, {
    type: 1,
    name: 2,
    properties: 1,
    geometry: 1
  });
});

check('groupCompareEntries binds removed elements to beforeModelId and added/changed to afterModelId', () => {
  const before = [
    snap('G-rem', { expressId: 101, ifcType: 'IfcDoor', name: 'Old Door' }),
    snap('G-chg', { expressId: 102, ifcType: 'IfcWall', name: 'Before Wall' })
  ];
  const after = [
    snap('G-add', { expressId: 201, ifcType: 'IfcWindow', name: 'New Window' }),
    snap('G-chg', { expressId: 202, ifcType: 'IfcWall', name: 'After Wall' })
  ];
  const diff = diffModels(before, after);
  const groups = groupCompareEntries(diff, 'model-before', 'model-after');

  assert.deepEqual(
    groups.map((g) => g.category),
    ['added', 'removed', 'changed']
  );

  const [added, removed, changed] = groups;
  assert.equal(added.entries.length, 1);
  assert.deepEqual(added.entries[0].ref, {
    modelId: 'model-after',
    expressId: 201,
    globalId: 'G-add'
  });

  assert.equal(removed.entries.length, 1);
  assert.deepEqual(removed.entries[0].ref, {
    modelId: 'model-before',
    expressId: 101,
    globalId: 'G-rem'
  });

  assert.equal(changed.entries.length, 1);
  assert.deepEqual(changed.entries[0].ref, {
    modelId: 'model-after',
    expressId: 202,
    globalId: 'G-chg'
  });
  assert.deepEqual(changed.entries[0].beforeRef, {
    modelId: 'model-before',
    expressId: 102,
    globalId: 'G-chg'
  });
  assert.equal(changed.entries[0].beforeName, 'Before Wall');
  assert.equal(changed.entries[0].name, 'After Wall');
});

check('sortCompareEntries sorts by ifcType, then name case-insensitively, then GlobalId', () => {
  const entries = [
    { category: 'added', globalId: 'G-3', ref: { modelId: 'm', expressId: 3 }, ifcType: 'IfcWall', name: 'Beta', changes: [], properties: [] },
    { category: 'added', globalId: 'G-1', ref: { modelId: 'm', expressId: 1 }, ifcType: 'IfcDoor', name: 'Zeta', changes: [], properties: [] },
    { category: 'added', globalId: 'G-4', ref: { modelId: 'm', expressId: 4 }, ifcType: 'IfcWall', name: 'alpha', changes: [], properties: [] },
    { category: 'added', globalId: 'G-2', ref: { modelId: 'm', expressId: 2 }, ifcType: 'IfcWall', name: 'Alpha', changes: [], properties: [] }
  ];
  const sorted = sortCompareEntries(entries);
  assert.deepEqual(
    sorted.map((e) => e.globalId),
    ['G-1', 'G-2', 'G-4', 'G-3']
  );
  // Original array is untouched.
  assert.equal(entries[0].globalId, 'G-3');
});

check('buildCompareColorScheme maps added green, removed red, changed amber and unchanged faded across both models', () => {
  const before = [
    snap('G-rem', { expressId: 10 }),
    snap('G-chg', { expressId: 11, name: 'v1' }),
    snap('G-same', { expressId: 12 })
  ];
  const after = [
    snap('G-add', { expressId: 20 }),
    snap('G-chg', { expressId: 21, name: 'v2' }),
    snap('G-same', { expressId: 22 })
  ];
  const diff = diffModels(before, after);
  const scheme = buildCompareColorScheme(diff, 'before-id', 'after-id', before, after, {
    added: 'Añadidos',
    removed: 'Eliminados',
    changed: 'Cambiados',
    unchanged: 'Sin cambios'
  });

  const beforeColors = scheme.colorsByModel.get('before-id');
  const afterColors = scheme.colorsByModel.get('after-id');
  assert.ok(beforeColors && afterColors);

  // Before model: removed = red, changed = amber, unchanged = faded
  assert.equal(beforeColors.get(10), COMPARE_STATUS_RGBA.removed);
  assert.equal(beforeColors.get(11), COMPARE_STATUS_RGBA.changed);
  assert.equal(beforeColors.get(12), COMPARE_STATUS_RGBA.unchanged);
  assert.equal(beforeColors.size, 3);

  // After model: added = green, changed = amber, unchanged = faded
  assert.equal(afterColors.get(20), COMPARE_STATUS_RGBA.added);
  assert.equal(afterColors.get(21), COMPARE_STATUS_RGBA.changed);
  assert.equal(afterColors.get(22), COMPARE_STATUS_RGBA.unchanged);
  assert.equal(afterColors.size, 3);

  // Distinct RGB colours: green, red, amber, faded
  assert.equal(new Set(Object.values(COMPARE_STATUS_RGBA)).size, 4);

  // Legend order and counts
  assert.deepEqual(scheme.legend, [
    { label: 'Añadidos', hex: COMPARE_STATUS_HEX.added, rgba: COMPARE_STATUS_RGBA.added, count: 1 },
    { label: 'Eliminados', hex: COMPARE_STATUS_HEX.removed, rgba: COMPARE_STATUS_RGBA.removed, count: 1 },
    { label: 'Cambiados', hex: COMPARE_STATUS_HEX.changed, rgba: COMPARE_STATUS_RGBA.changed, count: 1 },
    { label: 'Sin cambios', hex: COMPARE_STATUS_HEX.unchanged, rgba: COMPARE_STATUS_RGBA.unchanged, count: 1 }
  ]);
});

check('buildCompareView omits zero-count statuses from legend and keeps all three groups', () => {
  const before = [snap('G-1', { expressId: 1 }), snap('G-2', { expressId: 2 })];
  const after = [snap('G-1', { expressId: 1 }), snap('G-2', { expressId: 2 })];
  const view = buildCompareView('m1', 'm2', before, after);
  assert.equal(view.counts.added, 0);
  assert.equal(view.counts.removed, 0);
  assert.equal(view.counts.changed, 0);
  assert.equal(view.counts.unchanged, 2);
  assert.equal(view.colorScheme.legend.length, 1);
  assert.equal(view.colorScheme.legend[0].count, 2);
  assert.equal(view.colorScheme.legend[0].hex, COMPARE_STATUS_HEX.unchanged);
});

check('defaultComparePair keeps valid selections and picks distinct ready models on open/remove', () => {
  const ready = (id) => ({ id, status: 'ready' });
  const failed = (id) => ({ id, status: 'error' });

  assert.deepEqual(defaultComparePair([], '', ''), { beforeId: '', afterId: '' });
  assert.deepEqual(defaultComparePair([ready('a')], '', ''), { beforeId: 'a', afterId: '' });
  assert.deepEqual(defaultComparePair([ready('a'), failed('e'), ready('b')], '', ''), {
    beforeId: 'a',
    afterId: 'b'
  });
  // Keeps existing distinct choice.
  assert.deepEqual(defaultComparePair([ready('a'), ready('b'), ready('c')], 'c', 'a'), {
    beforeId: 'c',
    afterId: 'a'
  });
  // Falls back cleanly when one model is removed.
  assert.deepEqual(defaultComparePair([ready('a'), ready('c')], 'b', 'c'), {
    beforeId: 'a',
    afterId: 'c'
  });
  // Never returns the same model on both sides when 2+ ready models exist.
  assert.deepEqual(defaultComparePair([ready('a'), ready('b')], 'a', 'a'), {
    beforeId: 'a',
    afterId: 'b'
  });
});

console.log(`\nt165-compare-ui-test: ${passed}/${passed} pass`);
