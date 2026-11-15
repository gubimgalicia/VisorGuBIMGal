// T-138 (C14): Tests for visible scene glTF 2.0 (.glb) export.
// Usage: node test/t138-gltf-test.mjs
import assert from 'node:assert/strict';
import {
  GLB_CHUNK_BIN,
  GLB_CHUNK_JSON,
  GLB_MAGIC,
  GLB_VERSION,
  GLTF_COMPONENT_FLOAT,
  GLTF_COMPONENT_UNSIGNED_INT,
  GLTF_MODE_TRIANGLES,
  GLTF_TARGET_ARRAY_BUFFER,
  GLTF_TARGET_ELEMENT_ARRAY_BUFFER,
  align4,
  buildGlb,
  collectVisibleSceneElements,
  effectiveExportRgba,
  exportVisibleSceneToGlb,
  extractBatchElementMeta,
  ifcZUpToGltfYUp,
  isElementVisibleForExport,
  rgbaU32ToBaseColorFactor
} from '../src/infrastructure/export/gltfExport.ts';

/**
 * Independent GLB 2.0 binary parser for test verification.
 */
function parseGlbIndependent(bytes) {
  assert.ok(bytes instanceof Uint8Array, 'GLB must be a Uint8Array');
  assert.ok(bytes.byteLength >= 20, 'GLB must be at least 20 bytes');
  assert.equal(bytes.byteLength % 4, 0, 'Total GLB byteLength must be 4-byte aligned');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  assert.equal(magic, 0x46546c67, 'GLB magic must be 0x46546C67 ("glTF")');
  assert.equal(version, 2, 'GLB version must be 2');
  assert.equal(totalLength, bytes.byteLength, 'GLB header length must equal total byte length');

  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);
  assert.equal(jsonChunkLength % 4, 0, 'JSON chunk length must be a multiple of 4');
  assert.equal(jsonChunkType, 0x4e4f534a, 'Chunk 0 type must be 0x4E4F534A ("JSON")');

  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonChunkLength;
  assert.ok(jsonEnd <= bytes.byteLength, 'JSON chunk must fit within GLB');

  const jsonSlice = bytes.subarray(jsonStart, jsonEnd);
  // Verify trailing padding bytes (if any) are ASCII space (0x20)
  let trimEnd = jsonSlice.length;
  while (trimEnd > 0 && jsonSlice[trimEnd - 1] === 0x20) {
    trimEnd--;
  }
  assert.ok(jsonSlice.length - trimEnd < 4, 'At most 3 trailing 0x20 padding bytes in JSON chunk');
  const jsonText = new TextDecoder().decode(jsonSlice.subarray(0, trimEnd));
  const json = JSON.parse(jsonText);

  let bin = null;
  if (jsonEnd < bytes.byteLength) {
    assert.ok(jsonEnd + 8 <= bytes.byteLength, 'BIN chunk header must fit within GLB');
    const binChunkLength = view.getUint32(jsonEnd, true);
    const binChunkType = view.getUint32(jsonEnd + 4, true);
    assert.equal(binChunkLength % 4, 0, 'BIN chunk length must be a multiple of 4');
    assert.equal(binChunkType, 0x004e4942, 'Chunk 1 type must be 0x004E4942 ("BIN\\0")');
    assert.equal(
      jsonEnd + 8 + binChunkLength,
      bytes.byteLength,
      'Header + JSON chunk + BIN chunk must equal total GLB length'
    );
    bin = bytes.subarray(jsonEnd + 8, jsonEnd + 8 + binChunkLength);
  }

  return {
    header: { magic, version, totalLength },
    jsonChunkLength,
    binChunkLength: bin ? bin.byteLength : 0,
    json,
    bin
  };
}

// 1. Coordinate conversion (IFC Z-up -> glTF Y-up)
{
  // Rotation -90 deg around +X: (x, y, z)_IFC -> (x, z, -y)_glTF
  assert.deepEqual(ifcZUpToGltfYUp(1, 0, 0), [1, 0, 0], '+X IFC stays +X glTF');
  assert.deepEqual(ifcZUpToGltfYUp(0, 1, 0), [0, 0, -1], '+Y IFC (North) becomes -Z glTF');
  assert.deepEqual(ifcZUpToGltfYUp(0, 0, 1), [0, 1, 0], '+Z IFC (Up) becomes +Y glTF');
  assert.deepEqual(ifcZUpToGltfYUp(12.5, -30.25, 8.75), [12.5, 8.75, 30.25]);
  assert.equal(Object.is(ifcZUpToGltfYUp(0, 0, 0)[2], -0), false, 'Must not produce -0');
}

// 2. Single element GLB: header, chunks, alignment, accessors, min/max, Y-up transform & large UTM offset
{
  // 4 vertices in IFC Z-up at large coordinates around (500000, 4700000, 100):
  // v0 = (500000, 4700000, 100)
  // v1 = (500004, 4700000, 100)
  // v2 = (500004, 4700006, 100)
  // v3 = (500000, 4700000, 102)
  // IFC box min = (500000, 4700000, 100), max = (500004, 4700006, 102)
  // IFC centre = (500002, 4700003, 101)
  // glTF Y-up node translation = [500002, 101, -4700003]
  // Local glTF Y-up vertices (dx, dz, -dy):
  // v0: (-2, -1,  3)
  // v1: ( 2, -1,  3)
  // v2: ( 2, -1, -3)
  // v3: (-2,  1,  3)
  // Expected POSITION min = [-2, -1, -3], max = [2, 1, 3]
  const positions = new Float64Array([
    500000, 4700000, 100,
    500004, 4700000, 100,
    500004, 4700006, 100,
    500000, 4700000, 102
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 1, 3]);

  const glb = buildGlb([
    {
      expressId: 101,
      globalId: '2O2Fr$t4X7Zf8NOew3FLOH',
      rgba: 0xff8000ff,
      positions,
      indices
    }
  ]);

  const parsed = parseGlbIndependent(glb);
  const { json, bin } = parsed;

  assert.equal(json.asset.version, '2.0');
  assert.equal(json.scene, 0);
  assert.deepEqual(json.scenes[0].nodes, [0]);
  assert.equal(json.nodes.length, 1);
  assert.equal(json.nodes[0].name, '2O2Fr$t4X7Zf8NOew3FLOH');
  assert.equal(json.nodes[0].mesh, 0);
  assert.deepEqual(json.nodes[0].translation, [500002, 101, -4700003]);

  // Buffer and bufferViews checks
  assert.equal(json.buffers.length, 1);
  assert.equal(json.buffers[0].byteLength, parsed.binChunkLength);
  assert.equal(json.buffers[0].byteLength, 4 * 12 + 6 * 4); // 48 + 24 = 72 bytes
  assert.equal(json.bufferViews.length, 2);

  const posView = json.bufferViews[0];
  const idxView = json.bufferViews[1];
  assert.equal(posView.buffer, 0);
  assert.equal(posView.byteOffset, 0);
  assert.equal(posView.byteLength, 48);
  assert.equal(posView.target, GLTF_TARGET_ARRAY_BUFFER);

  assert.equal(idxView.buffer, 0);
  assert.equal(idxView.byteOffset, 48);
  assert.equal(idxView.byteLength, 24);
  assert.equal(idxView.target, GLTF_TARGET_ELEMENT_ARRAY_BUFFER);

  // Accessors checks
  assert.equal(json.accessors.length, 2);
  const posAcc = json.accessors[0];
  const idxAcc = json.accessors[1];

  assert.equal(posAcc.bufferView, 0);
  assert.equal(posAcc.componentType, GLTF_COMPONENT_FLOAT);
  assert.equal(posAcc.count, 4);
  assert.equal(posAcc.type, 'VEC3');
  assert.deepEqual(posAcc.min, [-2, -1, -3]);
  assert.deepEqual(posAcc.max, [2, 1, 3]);

  assert.equal(idxAcc.bufferView, 1);
  assert.equal(idxAcc.componentType, GLTF_COMPONENT_UNSIGNED_INT);
  assert.equal(idxAcc.count, 6);
  assert.equal(idxAcc.type, 'SCALAR');

  // Read back binary vertex positions and indices from BIN chunk
  const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const readPositions = [];
  for (let i = 0; i < 12; i++) {
    readPositions.push(binView.getFloat32(posView.byteOffset + i * 4, true));
  }
  assert.deepEqual(readPositions, [
    -2, -1, 3,
     2, -1, 3,
     2, -1, -3,
    -2,  1, 3
  ]);

  // Reconstruct world coordinates in glTF Y-up for known vertex v3 = (500000, 4700000, 102)_IFC
  const v3World = [
    json.nodes[0].translation[0] + readPositions[9],
    json.nodes[0].translation[1] + readPositions[10],
    json.nodes[0].translation[2] + readPositions[11]
  ];
  assert.deepEqual(v3World, [500000, 102, -4700000]);

  const readIndices = [];
  for (let i = 0; i < 6; i++) {
    readIndices.push(binView.getUint32(idxView.byteOffset + i * 4, true));
  }
  assert.deepEqual(readIndices, [0, 1, 2, 0, 1, 3]);
}

// 3. Sub-millimetre precision at large georeferenced coordinates (5 mm thin slab at 4745 km North)
{
  // Without subtracting the element origin in f64 before casting to f32, 4745678.901 and
  // 4745678.906 both round to 4745679.0 in f32, collapsing the 5 mm thickness to 0.
  const y0 = 4745678.901;
  const y1 = 4745678.906; // 5 mm apart in IFC +Y
  const positions = new Float64Array([
    548123.456, y0, 254.321,
    548124.456, y0, 254.321,
    548123.456, y1, 254.321
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const glb = buildGlb([{ expressId: 55, positions, indices }]);
  const { json, bin } = parseGlbIndependent(glb);
  const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const zLocal0 = binView.getFloat32(2 * 4, true); // vertex 0 glTF Z
  const zLocal2 = binView.getFloat32(8 * 4, true); // vertex 2 glTF Z
  const worldZ0 = json.nodes[0].translation[2] + zLocal0;
  const worldZ2 = json.nodes[0].translation[2] + zLocal2;
  const deltaZ = worldZ2 - worldZ0; // should be -(y1 - y0) = -0.005 m
  assert.ok(
    Math.abs(deltaZ - -0.005) < 1e-6,
    `Expected -0.005 m glTF Z separation at UTM scale, got ${deltaZ}`
  );
}

// 4. Material deduplication, alphaMode ('OPAQUE' vs 'BLEND'), and node naming fallback
{
  const triPos = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const triIdx = new Uint32Array([0, 1, 2]);

  const glb = buildGlb([
    { expressId: 10, globalId: 'GUID_A', rgba: 0x38bdf8ff, positions: triPos, indices: triIdx },
    { expressId: 20, globalId: undefined, rgba: 0x38bdf8ff, positions: triPos, indices: triIdx },
    { expressId: 30, globalId: '   ', rgba: 0x4ade8080, positions: triPos, indices: triIdx }
  ]);

  const { json } = parseGlbIndependent(glb);
  assert.equal(json.nodes.length, 3);
  assert.equal(json.nodes[0].name, 'GUID_A');
  assert.equal(json.nodes[1].name, '20', 'Missing globalId must fall back to expressId string');
  assert.equal(json.nodes[2].name, '30', 'Blank globalId must fall back to expressId string');

  // 3 elements with 2 distinct colors -> 2 deduplicated materials
  assert.equal(json.materials.length, 2, 'Identical RGBA materials must be deduplicated');
  assert.equal(json.meshes[0].primitives[0].material, 0);
  assert.equal(json.meshes[1].primitives[0].material, 0);
  assert.equal(json.meshes[2].primitives[0].material, 1);
  assert.equal(json.meshes[0].primitives[0].mode, GLTF_MODE_TRIANGLES);

  assert.equal(json.materials[0].alphaMode, 'OPAQUE');
  assert.deepEqual(
    json.materials[0].pbrMetallicRoughness.baseColorFactor,
    [0x38 / 255, 0xbd / 255, 0xf8 / 255, 1]
  );

  assert.equal(json.materials[1].alphaMode, 'BLEND');
  assert.deepEqual(
    json.materials[1].pbrMetallicRoughness.baseColorFactor,
    [0x4a / 255, 0xde / 255, 0x80 / 255, 0x80 / 255]
  );
}

// 5. Visibility, isolate, ghost, HiddenByDefault (IfcSpace), color overrides, and cancellation
{
  // 5a. extractBatchElementMeta from 7-word meshTable records
  const meshTable = new Uint32Array([
    // expressId, firstVertex, vertexCount, firstIndex, indexCount, rgba, flags
    100, 0, 4, 0, 6, 0xaabbccff, 0,
    200, 4, 4, 6, 6, 0x11223380, 1, // Transparent
    300, 8, 4, 12, 6, 0x445566ff, 4 // HiddenByDefault (IfcSpace)
  ]);
  const batchMeta = extractBatchElementMeta(meshTable);
  assert.equal(batchMeta.size, 3);
  assert.deepEqual(batchMeta.get(100), { baseRgba: 0xaabbccff, flags: 0 });
  assert.deepEqual(batchMeta.get(200), { baseRgba: 0x11223380, flags: 1 });
  assert.deepEqual(batchMeta.get(300), { baseRgba: 0x445566ff, flags: 4 });

  // 5b. Default display ('default' others, no overrides): 100 and 200 visible, 300 (HiddenByDefault) skipped
  const defaultVisible = collectVisibleSceneElements([
    {
      id: 'm1',
      visible: true,
      status: 'ready',
      displayOthers: 'default',
      displayEntries: new Map(),
      batchMeta
    },
    {
      id: 'm2-hidden',
      visible: false,
      status: 'ready',
      displayOthers: 'default',
      displayEntries: new Map(),
      batchMeta
    }
  ]);
  assert.deepEqual(
    defaultVisible.map((e) => `${e.modelId}:${e.expressId}`),
    ['m1:100', 'm1:200']
  );

  // 5c. Hide element 100 + override color of element 200 (preserving its 0x80 alpha)
  const withHideAndColor = collectVisibleSceneElements([
    {
      id: 'm1',
      visible: true,
      status: 'ready',
      displayOthers: 'default',
      displayEntries: new Map([[100, 'hidden']]),
      colorOverrides: new Map([[200, 0xef4444ff]]),
      batchMeta
    }
  ]);
  assert.equal(withHideAndColor.length, 1);
  assert.equal(withHideAndColor[0].expressId, 200);
  assert.equal(withHideAndColor[0].rgba, 0xef444480, 'Color override must preserve base alpha');

  // 5d. Isolate element 100 with ghost mode ON (displayOthers = 'ghost'): only 100 is exported
  const isolatedGhost = collectVisibleSceneElements([
    {
      id: 'm1',
      visible: true,
      status: 'ready',
      displayOthers: 'ghost',
      displayEntries: new Map([[100, 'visible']]),
      batchMeta
    }
  ]);
  assert.deepEqual(
    isolatedGhost.map((e) => e.expressId),
    [100],
    'Ghost elements outside isolation must be excluded so isolate is respected'
  );

  // 5e. Explicitly isolating IfcSpace (300 -> 'visible') exports it; storey isolation (300 -> 'default') skips it
  assert.equal(isElementVisibleForExport('default', 4, 'IfcSpace'), false);
  assert.equal(isElementVisibleForExport('visible', 4, 'IfcSpace'), true);
}

// 6. Async exportVisibleSceneToGlb: progress reporting and AbortSignal cancellation
{
  const triPos = new Float64Array([1, 2, 3, 4, 2, 3, 1, 5, 3]);
  const triIdx = new Uint32Array([0, 1, 2]);
  const batchMeta = new Map([
    [11, { baseRgba: 0xff0000ff, flags: 0 }],
    [22, { baseRgba: 0x00ff00ff, flags: 0 }]
  ]);

  const progressSteps = [];
  const res = await exportVisibleSceneToGlb({
    models: [
      {
        id: 'm1',
        visible: true,
        status: 'ready',
        displayOthers: 'default',
        displayEntries: new Map(),
        batchMeta
      }
    ],
    getElementMesh: async (_modelId, expressId) => ({
      positions: triPos,
      indices: triIdx,
      edges: new Uint32Array()
    }),
    getGlobalId: async (_modelId, expressId) => `GUID_${expressId}`,
    onProgress: (p) => progressSteps.push(`${p.completed}/${p.total}:${p.expressId}`),
    yieldEvery: 1
  });

  assert.equal(res.elementCount, 2);
  assert.deepEqual(progressSteps, ['1/2:11', '2/2:22']);
  const parsed = parseGlbIndependent(res.glb);
  assert.deepEqual(
    parsed.json.nodes.map((n) => n.name),
    ['GUID_11', 'GUID_22']
  );

  // Cancellation via AbortController
  const controller = new AbortController();
  await assert.rejects(
    async () => {
      await exportVisibleSceneToGlb({
        models: [
          {
            id: 'm1',
            visible: true,
            status: 'ready',
            displayOthers: 'default',
            displayEntries: new Map(),
            batchMeta
          }
        ],
        getElementMesh: async (_modelId, expressId) => {
          if (expressId === 11) controller.abort();
          return { positions: triPos, indices: triIdx, edges: new Uint32Array() };
        },
        signal: controller.signal
      });
    },
    (err) => err instanceof Error && err.name === 'AbortError'
  );
}

console.log('t138-gltf-test: all assertions passed');
