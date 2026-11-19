// One wasm-bindgen BatchView as a plain batch, from either kernel API: contract v1 (f32 only) or
// v2 (q16 positions, octahedral normals, 16-bit indices). The scripts that compare two builds of
// the kernel (bench, check-equivalent, check-identical) run both, so they read through this.
// The worker reads v2 only, through src/infrastructure/kernel/batchView.ts, which builds the same
// fields. Frees the view.

const box = (v) => ({ min: [v[0], v[1], v[2]], max: [v[3], v[4], v[5]] });

export function takeBatch(view) {
  const v2 = typeof view.vertexFormat === 'function';
  const vertexFormat = v2 ? view.vertexFormat() : 'f32';
  const q16 = vertexFormat === 'q16';
  const quant = v2 ? view.quantBox() : view.bounds();
  const batch = {
    origin: Array.from(view.origin()),
    box: box(view.bounds()),
    vertexFormat,
    quantBox: quant ? box(quant) : null,
    positions: q16 ? view.takePositionsQ16() : view.takePositions(),
    normals: q16 ? view.takeNormalsOct() : view.takeNormals(),
    indices: v2 && view.indicesAreU16() ? view.takeIndicesU16() : view.takeIndices(),
    meshTable: view.takeMeshTable(),
    shapes: [],
    instanceTable: new Uint32Array(0),
    instanceTransforms: new Float32Array(0)
  };
  view.free();
  return batch;
}
