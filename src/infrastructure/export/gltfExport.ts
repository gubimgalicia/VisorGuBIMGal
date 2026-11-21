import type { ElementMesh, SpatialNode, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ElementDisplay } from '../../domain/kernel/RendererPort';
import type { ModelId } from '../../domain/models/ModelRecord';

export const GLB_MAGIC = 0x46546c67; // 'glTF' in ASCII (little-endian)
export const GLB_VERSION = 2;
export const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON' in ASCII (little-endian)
export const GLB_CHUNK_BIN = 0x004e4942; // 'BIN\0' in ASCII (little-endian)

export const GLTF_COMPONENT_UNSIGNED_INT = 5125;
export const GLTF_COMPONENT_FLOAT = 5126;
export const GLTF_TARGET_ARRAY_BUFFER = 34962;
export const GLTF_TARGET_ELEMENT_ARRAY_BUFFER = 34963;
export const GLTF_MODE_TRIANGLES = 4;

export const DEFAULT_ELEMENT_RGBA = 0xccccccff;

/** MeshRecord layout constants matching `GeometryBatch.ts` without runtime import. */
const MESH_RECORD_WORDS = 7;
const FIELD_EXPRESS_ID = 0;
const FIELD_RGBA = 5;
const FIELD_FLAGS = 6;
const FLAG_HIDDEN_BY_DEFAULT = 1 << 2;

export interface ElementBatchMeta {
  /** Base RGBA color (`0xRRGGBBAA`, non-premultiplied sRGB) from the kernel stream. */
  baseRgba: number;
  /** Bitwise OR of `MeshFlag` bits across the element's records in `meshTable`. */
  flags: number;
}

export interface GlbElementInput {
  expressId: number;
  globalId?: string;
  /** Packed `u32` `0xRRGGBBAA` (non-premultiplied sRGB). Defaults to `DEFAULT_ELEMENT_RGBA`. */
  rgba?: number;
  /** Vertex coordinates in metres, IFC Z-up (`f64` triples: `x, y, z`). */
  positions: Float64Array | Float32Array | readonly number[];
  /** Triangle vertex indices (0-based triples: `i0, i1, i2`). */
  indices: Uint32Array | readonly number[];
}

export interface ModelExportInput {
  id: ModelId;
  visible: boolean;
  status?: 'queued' | 'parsing' | 'rendering' | 'ready' | 'error';
  displayOthers: ElementDisplay;
  displayEntries: ReadonlyMap<number, ElementDisplay>;
  colorOverrides?: ReadonlyMap<number, number>;
  batchMeta?: ReadonlyMap<number, ElementBatchMeta>;
  spatialTree?: SpatialTree;
  knownGuids?: ReadonlyMap<number, string>;
}

export interface VisibleSceneElement {
  modelId: ModelId;
  expressId: number;
  globalId?: string;
  rgba: number;
}

export interface ExportSceneProgress {
  completed: number;
  total: number;
  modelId: ModelId;
  expressId: number;
}

export interface ExportVisibleSceneOptions {
  models: readonly ModelExportInput[];
  getElementMesh: (modelId: ModelId, expressId: number) => Promise<ElementMesh | null>;
  getGlobalId?: (modelId: ModelId, expressId: number) => Promise<string | null | undefined>;
  onProgress?: (progress: ExportSceneProgress) => void;
  signal?: AbortSignal;
  /** Elements processed before yielding to the UI event loop. Defaults to 1. */
  yieldEvery?: number;
}

/** Pads a byte length up to the next 4-byte boundary. */
export function align4(byteLength: number): number {
  return (byteLength + 3) & ~3;
}

function cleanZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Converts a 3D point or offset from IFC Z-up right-handed coordinates (+X East/Right,
 * +Y North/Forward, +Z Up) into glTF 2.0 Y-up right-handed coordinates (+X Right, +Y Up,
 * +Z Forward/South = -Y_IFC).
 *
 * This is a proper rotation of -90 degrees (-pi/2 rad) around the +X axis:
 *
 *   [ x_gltf ]   [ 1   0   0 ] [ x_ifc ]   [  x_ifc ]
 *   [ y_gltf ] = [ 0   0   1 ] [ y_ifc ] = [  z_ifc ]
 *   [ z_gltf ]   [ 0  -1   0 ] [ z_ifc ]   [ -y_ifc ]
 *
 * Because det(R) = +1, counter-clockwise triangle winding is preserved.
 */
export function ifcZUpToGltfYUp(x: number, y: number, z: number): [number, number, number] {
  return [cleanZero(x), cleanZero(z), cleanZero(-y)];
}

/**
 * Converts a packed `u32` `0xRRGGBBAA` into a glTF 2.0 `baseColorFactor` tuple `[r, g, b, a]`
 * with each component in `[0, 1]`.
 */
export function rgbaU32ToBaseColorFactor(rgba: number): [number, number, number, number] {
  const u = rgba >>> 0;
  const r = ((u >>> 24) & 0xff) / 255;
  const g = ((u >>> 16) & 0xff) / 255;
  const b = ((u >>> 8) & 0xff) / 255;
  const a = (u & 0xff) / 255;
  return [r, g, b, a];
}

/**
 * Computes the effective packed `u32` `0xRRGGBBAA` for an exported element: when a color-by-property
 * or BCF color override is active, its RGB replaces the base RGB while preserving the base alpha byte.
 */
export function effectiveExportRgba(
  baseRgba: number | undefined,
  overrideRgba: number | undefined
): number {
  const base = (baseRgba ?? DEFAULT_ELEMENT_RGBA) >>> 0;
  if (overrideRgba === undefined) return base;
  return (((overrideRgba & 0xffffff00) | (base & 0xff)) >>> 0);
}

/**
 * Extracts per-element base RGBA color and kernel flags from a `GeometryBatch.meshTable`
 * (`7` `u32` words per record) into a `Map<expressId, ElementBatchMeta>`.
 */
/**
 * Each element's base colour and flags, from a batch's records and, since A13, its instances
 * (four words each: expressId, shapeId, rgba, flags): an element drawn only by instances, a
 * repeated door or fitting, would otherwise be left out of the GLB (docs/09 section 2).
 */
export function extractBatchElementMeta(
  meshTable: Uint32Array,
  target: Map<number, ElementBatchMeta> = new Map(),
  instanceTable: Uint32Array = new Uint32Array(0)
): Map<number, ElementBatchMeta> {
  const add = (expressId: number, rgba: number, flags: number) => {
    if (expressId === 0) return;
    const existing = target.get(expressId);
    if (!existing) {
      target.set(expressId, { baseRgba: rgba, flags });
    } else {
      existing.flags = (existing.flags | flags) >>> 0;
    }
  };
  for (let base = 0; base + MESH_RECORD_WORDS <= meshTable.length; base += MESH_RECORD_WORDS) {
    add(meshTable[base + FIELD_EXPRESS_ID] >>> 0, meshTable[base + FIELD_RGBA] >>> 0, meshTable[base + FIELD_FLAGS] >>> 0);
  }
  for (let base = 0; base + 4 <= instanceTable.length; base += 4) {
    add(instanceTable[base] >>> 0, instanceTable[base + 2] >>> 0, instanceTable[base + 3] >>> 0);
  }
  return target;
}

/**
 * Determines whether an element is visible for glTF export under the current display state:
 * - `'hidden'` and `'ghost'` elements are skipped (so hidden elements are excluded and active
 *   isolation is respected even when ghost mode is toggled on).
 * - `HiddenByDefault` elements (e.g. `IfcSpace`) are skipped unless explicitly made `'visible'`.
 */
export function isElementVisibleForExport(
  display: ElementDisplay,
  kernelFlags = 0,
  ifcType?: string
): boolean {
  if (display === 'hidden' || display === 'ghost') return false;
  const hiddenByDefault = (kernelFlags & FLAG_HIDDEN_BY_DEFAULT) !== 0 || ifcType === 'IfcSpace';
  if (hiddenByDefault && display !== 'visible') return false;
  return true;
}

function collectSpatialTreeTypes(tree: SpatialTree | undefined): Map<number, string> {
  const types = new Map<number, string>();
  if (!tree) return types;
  const stack: SpatialNode[] = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node !== tree.root) {
      types.set(node.expressId, node.type);
    }
    for (const elem of node.elements) {
      types.set(elem.expressId, elem.type);
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  for (const elem of tree.unassigned) {
    types.set(elem.expressId, elem.type);
  }
  return types;
}

/**
 * Collects the ordered list of visible elements across all ready, visible models,
 * respecting model visibility, element isolation, hidden targets, `HiddenByDefault` flags,
 * and active color overrides. Section planes are intentionally ignored so whole elements export.
 */
export function collectVisibleSceneElements(
  models: readonly ModelExportInput[]
): VisibleSceneElement[] {
  const result: VisibleSceneElement[] = [];

  for (const model of models) {
    if (!model.visible) continue;
    if (model.status !== undefined && model.status !== 'ready') continue;

    const treeTypes = collectSpatialTreeTypes(model.spatialTree);
    const candidateIds = new Set<number>();

    if (model.batchMeta && model.batchMeta.size > 0) {
      for (const expressId of model.batchMeta.keys()) {
        if (expressId > 0) candidateIds.add(expressId);
      }
    } else {
      for (const expressId of treeTypes.keys()) {
        if (expressId > 0) candidateIds.add(expressId);
      }
    }

    const sortedIds = [...candidateIds].sort((a, b) => a - b);
    for (const expressId of sortedIds) {
      const display = model.displayEntries.get(expressId) ?? model.displayOthers;
      const meta = model.batchMeta?.get(expressId);
      const ifcType = treeTypes.get(expressId);
      if (!isElementVisibleForExport(display, meta?.flags ?? 0, ifcType)) {
        continue;
      }
      const rgba = effectiveExportRgba(meta?.baseRgba, model.colorOverrides?.get(expressId));
      const globalId = model.knownGuids?.get(expressId);
      result.push({
        modelId: model.id,
        expressId,
        globalId: globalId && globalId.trim().length > 0 ? globalId.trim() : undefined,
        rgba
      });
    }
  }

  return result;
}

interface PreparedGlbElement {
  name: string;
  translation: [number, number, number];
  positionsF32: Float32Array;
  indicesU32: Uint32Array;
  posMin: [number, number, number];
  posMax: [number, number, number];
  materialIndex: number;
}

interface GltfMaterialJson {
  name: string;
  pbrMetallicRoughness: {
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
  };
  alphaMode: 'OPAQUE' | 'BLEND';
  doubleSided: boolean;
}

/**
 * Builds a binary glTF 2.0 (`.glb`) container from a list of elements:
 * - One node and one mesh per valid element, named after `globalId` (or `String(expressId)`).
 * - IFC Z-up coordinates in metres rotated to glTF Y-up via `ifcZUpToGltfYUp` (`(x, y, z) -> (x, z, -y)`).
 * - Large coordinates handled by subtracting the element's `f64` bounding-box centre before casting
 *   vertex positions to `f32`, storing the rotated centre in `node.translation`.
 * - Indexed triangles (`UNSIGNED_INT` 5125) and `POSITION` (`FLOAT` 5126 `VEC3`) with exact `f32` `min`/`max`.
 * - Per-element PBR materials (`baseColorFactor` and `alphaMode`), deduplicated by `rgba`.
 * - 4-byte alignment on all `bufferView`s and on the `JSON` (`0x20`) and `BIN` (`0x00`) chunks.
 */
export function buildGlb(elements: readonly GlbElementInput[]): Uint8Array {
  const materials: GltfMaterialJson[] = [];
  const rgbaToMaterialIndex = new Map<number, number>();
  const prepared: PreparedGlbElement[] = [];

  for (const elem of elements) {
    const rawPos = elem.positions;
    const rawIdx = elem.indices;
    const vertexCount = Math.floor(rawPos.length / 3);
    const rawIndexCount = Math.floor(rawIdx.length / 3) * 3;
    if (vertexCount < 3 || rawIndexCount < 3) continue;

    // Filter or validate triangle indices within [0, vertexCount)
    const validIndices: number[] = [];
    for (let i = 0; i + 2 < rawIndexCount; i += 3) {
      const i0 = rawIdx[i] >>> 0;
      const i1 = rawIdx[i + 1] >>> 0;
      const i2 = rawIdx[i + 2] >>> 0;
      if (i0 < vertexCount && i1 < vertexCount && i2 < vertexCount) {
        validIndices.push(i0, i1, i2);
      }
    }
    if (validIndices.length < 3) continue;

    // Compute element bounding box in f64 IFC Z-up coordinates
    let minIfcX = Infinity;
    let minIfcY = Infinity;
    let minIfcZ = Infinity;
    let maxIfcX = -Infinity;
    let maxIfcY = -Infinity;
    let maxIfcZ = -Infinity;

    for (let v = 0; v < vertexCount; v++) {
      const x = rawPos[v * 3];
      const y = rawPos[v * 3 + 1];
      const z = rawPos[v * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        minIfcX = Infinity;
        break;
      }
      if (x < minIfcX) minIfcX = x;
      if (y < minIfcY) minIfcY = y;
      if (z < minIfcZ) minIfcZ = z;
      if (x > maxIfcX) maxIfcX = x;
      if (y > maxIfcY) maxIfcY = y;
      if (z > maxIfcZ) maxIfcZ = z;
    }
    if (!Number.isFinite(minIfcX)) continue;

    // Element origin in f64 IFC Z-up, subtracted in f64 before converting to f32
    const originIfcX = 0.5 * (minIfcX + maxIfcX);
    const originIfcY = 0.5 * (minIfcY + maxIfcY);
    const originIfcZ = 0.5 * (minIfcZ + maxIfcZ);
    const translation = ifcZUpToGltfYUp(originIfcX, originIfcY, originIfcZ);

    const positionsF32 = new Float32Array(vertexCount * 3);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let v = 0; v < vertexCount; v++) {
      const dx = rawPos[v * 3] - originIfcX;
      const dy = rawPos[v * 3 + 1] - originIfcY;
      const dz = rawPos[v * 3 + 2] - originIfcZ;
      const [gx, gy, gz] = ifcZUpToGltfYUp(dx, dy, dz);
      const base = v * 3;
      positionsF32[base] = gx;
      positionsF32[base + 1] = gy;
      positionsF32[base + 2] = gz;

      // Accessor min/max must match the exact f32 values stored in the buffer
      const fx = cleanZero(positionsF32[base]);
      const fy = cleanZero(positionsF32[base + 1]);
      const fz = cleanZero(positionsF32[base + 2]);
      positionsF32[base] = fx;
      positionsF32[base + 1] = fy;
      positionsF32[base + 2] = fz;

      if (fx < minX) minX = fx;
      if (fy < minY) minY = fy;
      if (fz < minZ) minZ = fz;
      if (fx > maxX) maxX = fx;
      if (fy > maxY) maxY = fy;
      if (fz > maxZ) maxZ = fz;
    }

    const indicesU32 = new Uint32Array(validIndices);

    // Deduplicate PBR material by packed u32 RGBA
    const rgba = (elem.rgba ?? DEFAULT_ELEMENT_RGBA) >>> 0;
    let materialIndex = rgbaToMaterialIndex.get(rgba);
    if (materialIndex === undefined) {
      materialIndex = materials.length;
      rgbaToMaterialIndex.set(rgba, materialIndex);
      const hex = rgba.toString(16).padStart(8, '0').toUpperCase();
      const alphaByte = rgba & 0xff;
      materials.push({
        name: `mat_${hex}`,
        pbrMetallicRoughness: {
          baseColorFactor: rgbaU32ToBaseColorFactor(rgba),
          metallicFactor: 0.1,
          roughnessFactor: 0.8
        },
        alphaMode: alphaByte < 255 ? 'BLEND' : 'OPAQUE',
        doubleSided: true
      });
    }

    const name =
      elem.globalId && elem.globalId.trim().length > 0
        ? elem.globalId.trim()
        : String(elem.expressId);

    prepared.push({
      name,
      translation,
      positionsF32,
      indicesU32,
      posMin: [minX, minY, minZ],
      posMax: [maxX, maxY, maxZ],
      materialIndex
    });
  }

  const nodes: Array<{ name: string; mesh: number; translation: [number, number, number] }> = [];
  const meshes: Array<{
    name: string;
    primitives: Array<{
      attributes: { POSITION: number };
      indices: number;
      material: number;
      mode: number;
    }>;
  }> = [];
  const accessors: Array<{
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: 'VEC3' | 'SCALAR';
    min?: [number, number, number];
    max?: [number, number, number];
  }> = [];
  const bufferViews: Array<{
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target: number;
  }> = [];

  let binByteOffset = 0;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    const posByteOffset = align4(binByteOffset);
    const posByteLength = item.positionsF32.byteLength;
    binByteOffset = posByteOffset + posByteLength;

    const idxByteOffset = align4(binByteOffset);
    const idxByteLength = item.indicesU32.byteLength;
    binByteOffset = idxByteOffset + idxByteLength;

    const posBufferViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: posByteOffset,
      byteLength: posByteLength,
      target: GLTF_TARGET_ARRAY_BUFFER
    });

    const idxBufferViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: idxByteOffset,
      byteLength: idxByteLength,
      target: GLTF_TARGET_ELEMENT_ARRAY_BUFFER
    });

    const posAccessorIndex = accessors.length;
    accessors.push({
      bufferView: posBufferViewIndex,
      byteOffset: 0,
      componentType: GLTF_COMPONENT_FLOAT,
      count: item.positionsF32.length / 3,
      type: 'VEC3',
      min: item.posMin,
      max: item.posMax
    });

    const idxAccessorIndex = accessors.length;
    accessors.push({
      bufferView: idxBufferViewIndex,
      byteOffset: 0,
      componentType: GLTF_COMPONENT_UNSIGNED_INT,
      count: item.indicesU32.length,
      type: 'SCALAR'
    });

    const meshIndex = meshes.length;
    meshes.push({
      name: item.name,
      primitives: [
        {
          attributes: { POSITION: posAccessorIndex },
          indices: idxAccessorIndex,
          material: item.materialIndex,
          mode: GLTF_MODE_TRIANGLES
        }
      ]
    });

    nodes.push({
      name: item.name,
      mesh: meshIndex,
      translation: item.translation
    });
  }

  const binChunkLength = align4(binByteOffset);

  const gltfJson: Record<string, unknown> = {
    asset: {
      version: '2.0',
      generator: 'VisorGuBIMGal'
    },
    scene: 0,
    scenes: [
      {
        name: 'Scene',
        nodes: nodes.map((_, idx) => idx)
      }
    ],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: binChunkLength > 0 ? [{ byteLength: binChunkLength }] : []
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltfJson));
  const jsonChunkLength = align4(jsonBytes.byteLength);

  const totalByteLength =
    12 + 8 + jsonChunkLength + (binChunkLength > 0 ? 8 + binChunkLength : 0);

  const glb = new Uint8Array(totalByteLength);
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  // 12-byte GLB header
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalByteLength, true);

  // Chunk 0: JSON (padded with 0x20 ASCII spaces)
  view.setUint32(12, jsonChunkLength, true);
  view.setUint32(16, GLB_CHUNK_JSON, true);
  glb.set(jsonBytes, 20);
  for (let i = 20 + jsonBytes.byteLength; i < 20 + jsonChunkLength; i++) {
    glb[i] = 0x20;
  }

  // Chunk 1: BIN (padded with 0x00 zeros)
  if (binChunkLength > 0) {
    const binHeaderOffset = 20 + jsonChunkLength;
    const binDataOffset = binHeaderOffset + 8;
    view.setUint32(binHeaderOffset, binChunkLength, true);
    view.setUint32(binHeaderOffset + 4, GLB_CHUNK_BIN, true);

    for (let i = 0; i < prepared.length; i++) {
      const item = prepared[i];
      const posView = bufferViews[i * 2];
      const idxView = bufferViews[i * 2 + 1];

      let outPosOffset = binDataOffset + posView.byteOffset;
      for (let f = 0; f < item.positionsF32.length; f++) {
        view.setFloat32(outPosOffset, item.positionsF32[f], true);
        outPosOffset += 4;
      }

      let outIdxOffset = binDataOffset + idxView.byteOffset;
      for (let k = 0; k < item.indicesU32.length; k++) {
        view.setUint32(outIdxOffset, item.indicesU32[k], true);
        outIdxOffset += 4;
      }
    }
  }

  return glb;
}

function createAbortError(): Error {
  const err = new Error('Exportación GLB cancelada.');
  err.name = 'AbortError';
  return err;
}

/**
 * Exports the currently visible 3D scene to a binary glTF 2.0 (`.glb`), fetching exact element
 * meshes (`KernelPort.elementMesh`) and optional `GlobalId`s, yielding between elements so the
 * browser UI stays responsive, and supporting progress reporting and `AbortSignal` cancellation.
 */
export async function exportVisibleSceneToGlb(
  options: ExportVisibleSceneOptions
): Promise<{ glb: Uint8Array; elementCount: number }> {
  const { models, getElementMesh, getGlobalId, onProgress, signal } = options;
  const yieldEvery = Math.max(1, options.yieldEvery ?? 1);

  if (signal?.aborted) {
    throw createAbortError();
  }

  const visibleElements = collectVisibleSceneElements(models);
  const glbInputs: GlbElementInput[] = [];
  const total = visibleElements.length;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const item = visibleElements[i];
    const [mesh, resolvedGuid] = await Promise.all([
      getElementMesh(item.modelId, item.expressId),
      item.globalId !== undefined
        ? Promise.resolve(item.globalId)
        : getGlobalId
        ? getGlobalId(item.modelId, item.expressId)
        : Promise.resolve(undefined)
    ]);

    if (signal?.aborted) {
      throw createAbortError();
    }

    if (mesh && mesh.positions.length >= 9 && mesh.indices.length >= 3) {
      glbInputs.push({
        expressId: item.expressId,
        globalId: resolvedGuid && resolvedGuid.trim().length > 0 ? resolvedGuid.trim() : undefined,
        rgba: item.rgba,
        positions: mesh.positions,
        indices: mesh.indices
      });
    }

    onProgress?.({
      completed: i + 1,
      total,
      modelId: item.modelId,
      expressId: item.expressId
    });

    if ((i + 1) % yieldEvery === 0 && i + 1 < total) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const glb = buildGlb(glbInputs);
  return { glb, elementCount: glbInputs.length };
}
