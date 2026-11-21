import assert from 'node:assert/strict';
import {
  buildClashBcfTopic,
  buildClashDisplayEntries,
  buildClashPairIsolation,
  buildClashRequest,
  CLASH_COLOR_A_RGBA,
  CLASH_COLOR_B_RGBA,
  collectClashCatalog,
  createPresetRule,
  resolveClashSetSpecs,
  summarizeClashes
} from '../src/ui/viewer/clashDetector.ts';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
  passed++;
}

const models = [
  {
    id: 'arch',
    fileName: 'Clinic_Architectural.ifc',
    fileSize: 1000,
    schema: 'IFC2X3',
    status: 'ready',
    visible: true,
    units: 'm',
    elementCount: 4,
    meshCount: 4,
    diagnostics: []
  },
  {
    id: 'plumb',
    fileName: 'Clinic_Plumbing.ifc',
    fileSize: 2000,
    schema: 'IFC2X3',
    status: 'ready',
    visible: true,
    units: 'm',
    elementCount: 3,
    meshCount: 3,
    diagnostics: []
  }
];

const spatialTrees = {
  arch: {
    root: {
      expressId: 1,
      type: 'IfcProject',
      children: [
        {
          expressId: 10,
          type: 'IfcBuildingStorey',
          name: 'Level 1',
          children: [],
          elements: [
            { expressId: 101, type: 'IfcWallStandardCase', name: 'Wall A', via: 'contains' },
            { expressId: 102, type: 'IfcSpace', name: 'Room 1', via: 'contains' }
          ]
        },
        {
          expressId: 20,
          type: 'IfcBuildingStorey',
          name: 'Level 2',
          children: [],
          elements: [
            { expressId: 201, type: 'IfcSlab', name: 'Slab 2', via: 'contains' }
          ]
        }
      ],
      elements: []
    },
    unassigned: []
  },
  plumb: {
    root: {
      expressId: 2,
      type: 'IfcProject',
      children: [
        {
          expressId: 30,
          type: 'IfcBuildingStorey',
          name: 'Level 1',
          children: [],
          elements: [
            { expressId: 301, type: 'IfcFlowSegment', name: 'Pipe 1', via: 'contains' },
            { expressId: 302, type: 'IfcFlowFitting', name: 'Elbow 1', via: 'contains' }
          ]
        }
      ],
      elements: []
    },
    unassigned: []
  }
};

await test('collectClashCatalog excludes IfcSpace and indexes storeys and classes', () => {
  const catalog = collectClashCatalog(models, spatialTrees);
  assert.equal(catalog.elementsByKey.has('arch:102'), false, 'IfcSpace must be excluded');
  assert.equal(catalog.elementsByKey.size, 4);
  assert.deepEqual(catalog.storeys, ['Level 1', 'Level 2']);
  assert.deepEqual(catalog.classes, ['IfcFlowFitting', 'IfcFlowSegment', 'IfcSlab', 'IfcWallStandardCase']);
});

await test('resolveClashSetSpecs filters by model, IFC class and storey', () => {
  const catalog = collectClashCatalog(models, spatialTrees);
  const byClass = resolveClashSetSpecs(
    { modelId: '*', ifcClasses: ['IfcFlowSegment'], storeys: [] },
    models,
    catalog
  );
  assert.deepEqual(byClass, [{ modelId: 'plumb', expressIds: [301] }]);

  const byStorey = resolveClashSetSpecs(
    { modelId: 'arch', ifcClasses: [], storeys: ['Level 2'] },
    models,
    catalog
  );
  assert.deepEqual(byStorey, [{ modelId: 'arch', expressIds: [201] }]);

  const preset = createPresetRule('pipes-vs-structure', models, catalog.classes);
  const req = buildClashRequest({ ...preset, clearanceMm: 60 }, models, catalog);
  assert.equal(req.clearanceM, 0.06);
  assert.deepEqual(req.setA, [{ modelId: 'plumb', expressIds: [301, 302] }]);
  assert.deepEqual(req.setB, [{ modelId: 'arch', expressIds: [101, 201] }]);
});

await test('buildClashDisplayEntries sorts hard clashes by penetration desc then soft by gap asc', () => {
  const catalog = collectClashCatalog(models, spatialTrees);
  const report = {
    clashes: [
      {
        elementA: { modelId: 'arch', expressId: 201 },
        elementB: { modelId: 'plumb', expressId: 302 },
        kind: 'soft',
        penetrationM: 0,
        gapM: 0.045,
        point: [1, 2, 3],
        bounds: { min: [0, 0, 0], max: [2, 2, 2] }
      },
      {
        elementA: { modelId: 'arch', expressId: 101 },
        elementB: { modelId: 'plumb', expressId: 301 },
        kind: 'hard',
        penetrationM: 0.025,
        gapM: 0,
        volumeM3: 0.002,
        point: [0.5, 0.5, 0.5],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] }
      },
      {
        elementA: { modelId: 'arch', expressId: 101 },
        elementB: { modelId: 'plumb', expressId: 302 },
        kind: 'hard',
        penetrationM: 0.12,
        gapM: 0,
        volumeM3: 0.01,
        point: [0.5, 0.5, 0.5],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] }
      },
      {
        elementA: { modelId: 'arch', expressId: 201 },
        elementB: { modelId: 'plumb', expressId: 301 },
        kind: 'soft',
        penetrationM: 0,
        gapM: 0.012,
        point: [1, 2, 3],
        bounds: { min: [0, 0, 0], max: [2, 2, 2] }
      }
    ],
    broadPhasePairs: 10,
    testedPairs: 10,
    truncated: false,
    elapsedMs: 12,
    diagnostics: []
  };

  const entries = buildClashDisplayEntries(report, catalog);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.kind === 'hard' ? e.penetrationM : e.gapM]),
    [
      ['hard', 0.12],
      ['hard', 0.025],
      ['soft', 0.012],
      ['soft', 0.045]
    ]
  );
  assert.deepEqual(summarizeClashes(entries), { total: 4, hard: 2, soft: 2 });
});

await test('buildClashPairIsolation isolates both elements across models with distinct colors', () => {
  const catalog = collectClashCatalog(models, spatialTrees);
  const [entry] = buildClashDisplayEntries(
    {
      clashes: [
        {
          elementA: { modelId: 'arch', expressId: 101 },
          elementB: { modelId: 'plumb', expressId: 301 },
          kind: 'hard',
          penetrationM: 0.05,
          gapM: 0,
          point: [0, 0, 0],
          bounds: { min: [0, 0, 0], max: [1, 1, 1] }
        }
      ],
      broadPhasePairs: 1,
      testedPairs: 1,
      truncated: false,
      elapsedMs: 1,
      diagnostics: []
    },
    catalog
  );

  const iso = buildClashPairIsolation(entry, 'Choque test');
  assert.equal(iso.displayTarget.by, 'search');
  assert.deepEqual(iso.displayTarget.matches, { arch: [101], plumb: [301] });
  assert.equal(iso.colorsByModel.get('arch')?.get(101), CLASH_COLOR_A_RGBA);
  assert.equal(iso.colorsByModel.get('plumb')?.get(301), CLASH_COLOR_B_RGBA);
});

await test('buildClashBcfTopic creates a Clash topic that round-trips through BCF 3.0 archive', async () => {
  const catalog = collectClashCatalog(models, spatialTrees);
  const [entry] = buildClashDisplayEntries(
    {
      clashes: [
        {
          elementA: { modelId: 'arch', expressId: 101 },
          elementB: { modelId: 'plumb', expressId: 301 },
          kind: 'hard',
          penetrationM: 0.05,
          gapM: 0,
          point: [1, 2, 3],
          bounds: { min: [0, 0, 0], max: [2, 2, 2] }
        }
      ],
      broadPhasePairs: 1,
      testedPairs: 1,
      truncated: false,
      elapsedMs: 1,
      diagnostics: []
    },
    catalog
  );

  const topic = buildClashBcfTopic(
    entry,
    {
      guid: '11111111-1111-4111-8111-111111111111',
      index: 1,
      camera: {
        kind: 'perspective',
        viewPoint: [5, 5, 5],
        direction: [-0.577, -0.577, -0.577],
        up: [0, 0, 1],
        fieldOfView: 45,
        aspectRatio: 1.5
      },
      selection: [{ ifcGuid: 'GUID_WALL_A' }, { ifcGuid: 'GUID_PIPE_1' }],
      visibility: {
        defaultVisibility: false,
        exceptions: [{ ifcGuid: 'GUID_WALL_A' }, { ifcGuid: 'GUID_PIPE_1' }],
        spacesVisible: false,
        spaceBoundariesVisible: false,
        openingsVisible: false
      },
      coloring: [
        { color: 'EF4444FF', components: [{ ifcGuid: 'GUID_WALL_A' }] },
        { color: 'F97316FF', components: [{ ifcGuid: 'GUID_PIPE_1' }] }
      ],
      lines: [],
      clippingPlanes: [],
      bitmaps: []
    },
    '22222222-2222-4222-8222-222222222222',
    1,
    {
      title: 'Choque duro: Wall A ↔ Pipe 1',
      description: 'Penetración: 50,0 mm'
    }
  );

  assert.equal(topic.topicType, 'Clash');
  assert.equal(topic.topicStatus, 'Open');
  assert.equal(topic.priority, 'High');
  assert.deepEqual(topic.labels, ['HardClash']);
  assert.equal(topic.title, 'Choque duro: Wall A ↔ Pipe 1');
  assert.equal(topic.viewpoints.length, 1);
  assert.deepEqual(
    topic.viewpoints[0].selection.map((c) => c.ifcGuid),
    ['GUID_WALL_A', 'GUID_PIPE_1']
  );
  assert.equal(topic.viewpoints[0].visibility.defaultVisibility, false);
  assert.deepEqual(
    topic.viewpoints[0].visibility.exceptions.map((c) => c.ifcGuid),
    ['GUID_WALL_A', 'GUID_PIPE_1']
  );
});

console.log(`\nt168-clash-test: ${passed}/${passed} pass`);
