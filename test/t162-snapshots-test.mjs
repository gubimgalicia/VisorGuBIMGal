// T-162 (C13): the kernel's element snapshots, and the diff they feed. The snapshots come from
// the same element details the properties panel shows, so the two versions match by GlobalId.
// node --experimental-strip-types test/t162-snapshots-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffModels } from '../src/domain/compare/modelDiff.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(REPO, 'src/infrastructure/kernel/pkg');
const { initSync, Model } = await import(pathToFileURL(path.join(pkg, 'wasm_api.js')).href);
initSync({ module: readFileSync(path.join(pkg, 'wasm_api_bg.wasm')) });

const open = (file) => new Model(readFileSync(file));
const snapshotsOf = (sample) => JSON.parse(open(path.join(REPO, 'public/samples', sample)).elementSnapshotsJson());
const simple = snapshotsOf('SimpleWall.ifc');
const many = snapshotsOf('ManySimpleWalls.ifc');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

check('SimpleWall has the wall and the door, ascending by expressId', () => {
  assert.equal(simple.length, 2, JSON.stringify(simple));
  assert.deepEqual(simple.map((element) => element.expressId), [219, 572]);
  assert.ok(simple.every((element) => element.globalId && element.ifcType.startsWith('Ifc')));
});

check('the wall carries its GlobalId, class, name and panel property values', () => {
  const wall = simple.find((element) => element.expressId === 219);
  assert.ok(wall, 'no wall #219');
  assert.equal(wall.globalId, '1F6umJ5H50aeL3A1As_wTm');
  assert.equal(wall.ifcType, 'IfcWallStandardCase');
  assert.equal(wall.name, 'Basic Wall:Bearing Wall:346660');
  // #228 IFCQUANTITYLENGTH Height 4000, length unit MILLI METRE: the panel shows "4000 mm".
  assert.equal(wall.properties['BaseQuantities.Height'], '4000 mm');
  // #405 Pset_WallCommon IsExternal IFCBOOLEAN(.T.): the panel shows "true".
  assert.equal(wall.properties['Pset_WallCommon.IsExternal'], 'true');
});

check('ManySimpleWalls has one snapshot per drawn product, ascending', () => {
  assert.ok(many.length > simple.length, `only ${many.length} snapshots`);
  const ids = many.map((element) => element.expressId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(many.map((element) => element.globalId)).size, many.length);
  for (const element of many) {
    assert.equal(typeof element.properties, 'object');
  }
});

// The panel's own text (src/ui/components/PropertiesPanel.tsx) from the details it is given, so a
// snapshot cannot drift from what the user reads. A key repeated across sets keeps the last value.
const DUPLEX = path.join(REPO, '../guBIM-wt-claude/test/models/bench/Duplex_A_20110907.ifc');
check('every snapshot reads as the properties panel: SimpleWall, ManySimpleWalls, Duplex', () => {
  let compared = 0;
  for (const file of [path.join(REPO, 'public/samples/SimpleWall.ifc'), path.join(REPO, 'public/samples/ManySimpleWalls.ifc'), DUPLEX]) {
    const model = open(file);
    const snapshots = JSON.parse(model.elementSnapshotsJson());
    assert.ok(snapshots.length > 0, file);
    for (const snapshot of snapshots) {
      const details = JSON.parse(model.elementDetailsJson(snapshot.expressId));
      assert.equal(snapshot.globalId, details.globalId ?? '');
      assert.equal(snapshot.ifcType, details.type);
      assert.equal(snapshot.name, details.name ?? undefined);
      const expected = {};
      for (const set of details.propertySets) {
        for (const prop of set.properties) {
          const hasValue = prop.value !== null && prop.value !== undefined;
          expected[set.name + '.' + prop.name] = hasValue ? [prop.value, prop.unit].filter((part) => part !== undefined).join(' ') : '-';
          compared++;
        }
      }
      assert.deepEqual(snapshot.properties, expected, `#${snapshot.expressId} in ${path.basename(file)}`);
    }
  }
  console.log(`       ${compared} property values compared`);
});

check('a model against itself has no changes', () => {
  const diff = diffModels(simple, simple);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.duplicates, []);
  assert.equal(diff.unchanged, simple.length);
});

check('SimpleWall against ManySimpleWalls matches by GlobalId and the counts add up', () => {
  const diff = diffModels(simple, many);
  console.log(
    `       added ${diff.added.length}, removed ${diff.removed.length}, changed ${diff.changed.length}, ` +
      `unchanged ${diff.unchanged}, duplicates ${diff.duplicates.length}`
  );
  assert.deepEqual(diff.duplicates, []);
  // Every element of each side is in exactly one bucket; a changed pair counts once per side.
  assert.equal(simple.length, diff.removed.length + diff.changed.length + diff.unchanged);
  assert.equal(many.length, diff.added.length + diff.changed.length + diff.unchanged);
  assert.equal(
    diff.added.length + diff.removed.length + diff.changed.length + diff.unchanged,
    new Set([...simple, ...many].map((element) => element.globalId)).size
  );
  // The wall and the door keep their GlobalIds across the two exports, as the sample intends.
  const shared = new Set(diff.changed.map((pair) => pair.before.globalId));
  assert.ok(shared.has('1F6umJ5H50aeL3A1As_wTm') && shared.has('1F6umJ5H50aeL3A1As_wUF'));
});

console.log(`\nt162-snapshots-test: ${passed}/6 pass`);
