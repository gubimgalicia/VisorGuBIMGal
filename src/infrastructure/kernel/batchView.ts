import type { GeometryBatch, ShapeDef, VertexFormat } from '../../domain/kernel/GeometryBatch';
import type { ModelId } from '../../domain/models/ModelRecord';

/** What this reads of wasm-bindgen's `BatchView` (`crates/wasm-api/src/lib.rs`). */
export interface BatchViewLike {
  origin(): ArrayLike<number>;
  bounds(): ArrayLike<number>;
  quantBox(): ArrayLike<number> | undefined;
  vertexFormat(): string;
  takePositions(): Float32Array;
  takePositionsQ16(): Uint16Array;
  takeNormals(): Float32Array;
  takeNormalsOct(): Int16Array;
  indicesAreU16(): boolean;
  takeIndices(): Uint32Array;
  takeIndicesU16(): Uint16Array;
  takeMeshTable(): Uint32Array;
  takeInstanceTable(): Uint32Array;
  takeInstanceTransforms(): Float32Array;
  shapeCount(): number;
  shapeId(at: number): number;
  shapeBox(at: number): ArrayLike<number>;
  shapeClosed(at: number): boolean;
  shapeVertexFormat(at: number): string;
  takeShapePositions(at: number): Float32Array;
  takeShapePositionsQ16(at: number): Uint16Array;
  takeShapeNormals(at: number): Float32Array;
  takeShapeNormalsOct(at: number): Int16Array;
  shapeIndicesAreU16(at: number): boolean;
  takeShapeIndices(at: number): Uint32Array;
  takeShapeIndicesU16(at: number): Uint16Array;
}

/** The shapes a view sends first (A13), each array taken in its own width. */
function readShapes(view: BatchViewLike): ShapeDef[] {
  const shapes: ShapeDef[] = [];
  for (let at = 0; at < view.shapeCount(); at++) {
    const vertexFormat = view.shapeVertexFormat(at) as VertexFormat;
    const q16 = vertexFormat === 'q16';
    shapes.push({
      shapeId: view.shapeId(at),
      vertexFormat,
      positions: q16 ? view.takeShapePositionsQ16(at) : view.takeShapePositions(at),
      normals: q16 ? view.takeShapeNormalsOct(at) : view.takeShapeNormals(at),
      indices: view.shapeIndicesAreU16(at) ? view.takeShapeIndicesU16(at) : view.takeShapeIndices(at),
      box: box(view.shapeBox(at)),
      closed: view.shapeClosed(at)
    });
  }
  return shapes;
}

const box = (values: ArrayLike<number>) => ({
  min: [values[0], values[1], values[2]] as const,
  max: [values[3], values[4], values[5]] as const
});

/** Every buffer of a batch, to transfer it rather than clone it (RSK-06). Each is its own. */
export function batchTransfer(batch: Omit<GeometryBatch, 'modelId'>): Transferable[] {
  const views: ArrayBufferView[] = [
    batch.positions,
    batch.normals,
    batch.indices,
    batch.meshTable,
    batch.instanceTable,
    batch.instanceTransforms,
    ...batch.shapes.flatMap((shape) => [shape.positions, shape.normals, shape.indices])
  ];
  return [...new Set(views.map((view) => view.buffer))] as Transferable[];
}

/**
 * One `BatchView` as a `GeometryBatch` (contract v2). Each `take` hands over a fresh buffer, so
 * transferring it leaves WASM memory alone. The caller frees the view.
 */
export function readBatchView(view: BatchViewLike, modelId: ModelId, sequence: number): GeometryBatch {
  const [x, y, z] = Array.from(view.origin());
  const vertexFormat = view.vertexFormat() as VertexFormat;
  if (vertexFormat !== 'f32' && vertexFormat !== 'q16') throw new Error(`unknown vertex format ${vertexFormat}`);
  const quant = view.quantBox();
  const q16 = vertexFormat === 'q16';
  return {
    modelId,
    sequence,
    origin: [x, y, z],
    box: box(view.bounds()),
    vertexFormat,
    quantBox: quant ? box(quant) : null,
    positions: q16 ? view.takePositionsQ16() : view.takePositions(),
    normals: q16 ? view.takeNormalsOct() : view.takeNormals(),
    indices: view.indicesAreU16() ? view.takeIndicesU16() : view.takeIndices(),
    meshTable: view.takeMeshTable(),
    shapes: readShapes(view),
    instanceTable: view.takeInstanceTable(),
    instanceTransforms: view.takeInstanceTransforms()
  };
}
