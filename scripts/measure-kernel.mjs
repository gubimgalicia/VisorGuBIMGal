// One model in one fresh instance, as a Worker holds it. Run npm run kernel first.
// usage: node scripts/measure-kernel.mjs <file.ifc>
import { readFileSync, statSync } from 'node:fs';
import { takeBatch } from './lib/take-batch.mjs';

const pkg = new URL('../src/infrastructure/kernel/pkg/', import.meta.url).href;
const { initSync, Model } = await import(pkg + 'wasm_api.js');
const wasm = readFileSync(new URL(pkg + 'wasm_api_bg.wasm'));
const exports_ = initSync({ module: wasm });
const memory = () => Math.round(exports_.memory.buffer.byteLength / 1048576);

const file = process.argv[2];
const mb = statSync(file).size / 1048576;
const bytes = readFileSync(file);
const at = {};
let t = performance.now();
const lap = (name) => {
  const now = performance.now();
  at[name] = Math.round(now - t);
  t = now;
};

const model = new Model(bytes);
lap('open');
const openMem = memory();
const summary = JSON.parse(model.summaryJson());
lap('summary');
const tree = model.spatialTreeJson();
lap('tree');
const treeMem = memory();
model.startStream();
let first = null;
let triangles = 0;
let batches = 0;
let gpuBytes = 0;
const started = performance.now();
for (;;) {
  const view = model.nextBatch(65536);
  if (!view) break;
  const { positions, normals, indices, meshTable: table } = takeBatch(view);
  if (first === null) first = Math.round(performance.now() - started);
  triangles += indices.length / 3;
  gpuBytes += positions.byteLength + normals.byteLength + indices.byteLength + table.byteLength;
  batches += 1;
}
lap('stream');
const streamMem = memory();
const complete = JSON.parse(model.finishStream());
lap('finish');
console.log(JSON.stringify({
  fileMB: +mb.toFixed(1), elements: summary.elementCount, triangles, batches, meshes: complete.meshCount,
  diag: complete.diagnostics.length, treeKB: Math.round(tree.length / 1024), ms: at, firstBatchMs: first,
  wasmMB: { afterOpen: openMem, afterTree: treeMem, afterStream: streamMem, end: memory() },
  batchMB: +(gpuBytes / 1048576).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1048576)
}));
