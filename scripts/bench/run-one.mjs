// One benchmark workload against one kernel package, in this fresh process (as a Worker holds it).
// usage: node --experimental-strip-types scripts/bench/run-one.mjs <pkgDir> <workload.json>
// Prints one JSON line: { ms: {...}, out: {...}, wasmMB }.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeBatch } from '../lib/take-batch.mjs';
import { drawingRequest } from '../../src/infrastructure/kernel/drawingRequest.ts';

const [pkgDir, workloadFile] = process.argv.slice(2);
const workload = JSON.parse(readFileSync(workloadFile, 'utf8'));
const { initSync, Model, Sheet } = await import(pathToFileURL(path.join(pkgDir, 'wasm_api.js')).href);
const exports_ = initSync({ module: readFileSync(path.join(pkgDir, 'wasm_api_bg.wasm')) });
const memoryMB = () => exports_.memory.buffer.byteLength / 1048576;

const ms = {};
const out = {};
const add = (key, value) => (ms[key] = (ms[key] ?? 0) + value);
const count = (key, value) => (out[key] = (out[key] ?? 0) + value);
const time = (key, fn) => {
  const t = performance.now();
  const result = fn();
  add(key, performance.now() - t);
  return result;
};

let lastBounds = null;
function loadAndStream(bytes) {
  const model = time('open', () => new Model(bytes));
  const summary = time('summary', () => JSON.parse(model.summaryJson()));
  time('tree', () => model.spatialTreeJson());
  time('stream', () => {
    model.startStream();
    for (;;) {
      const view = model.nextBatch(65536);
      if (!view) break;
      const { indices } = takeBatch(view);
      count('triangles', indices.length / 3);
      count('batches', 1);
    }
    lastBounds = JSON.parse(model.finishStream()).bounds ?? null;
  });
  count('elements', summary.elementCount ?? 0);
  return model;
}

function draw(model, options) {
  // elevation 'mid': halfway up the model, from the bounds the stream reported.
  const cut =
    options.cut.elevation === 'mid'
      ? { ...options.cut, elevation: lastBounds ? (lastBounds.min.z + lastBounds.max.z) / 2 : 1 }
      : options.cut;
  const request = drawingRequest({ ...options, cut });
  const sheet = time('drawing', () => {
    model.startDrawing(new Float64Array(request));
    const s = new Sheet(new Float64Array(request));
    for (;;) {
      const chunk = model.nextDrawingChunk(65536);
      if (!chunk) break;
      s.addChunk(0, chunk);
    }
    model.finishDrawing();
    s.generate();
    return s;
  });
  const svg = time('export', () => sheet.export(true, 1, true, true, null));
  const dxf = time('export', () => sheet.export(false, 1, true, true, null));
  count('svgBytes', svg?.length ?? 0);
  count('dxfBytes', dxf?.length ?? 0);
  sheet.free();
}

const cpu0 = process.cpuUsage();
for (let r = 0; r < (workload.repeat ?? 1); r++) {
  for (const file of workload.files) {
    const bytes = readFileSync(file);
    const model = loadAndStream(bytes);
    if (workload.drawing) draw(model, workload.drawing);
    model.free();
  }
}
for (const key of Object.keys(ms)) ms[key] = Math.round(ms[key] * 10) / 10;
ms.total = Math.round(Object.values(ms).reduce((a, b) => a + b, 0) * 10) / 10;
// CPU time of this process: unlike wall time, it barely moves when other work shares the machine.
const cpu = process.cpuUsage(cpu0);
ms.cpu = Math.round((cpu.user + cpu.system) / 100) / 10;
console.log(JSON.stringify({ ms, out, wasmMB: Math.round(memoryMB()) }));
