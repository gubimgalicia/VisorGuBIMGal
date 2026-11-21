// One benchmark workload against one kernel package.
// usage:
//   node [--expose-gc] --experimental-strip-types scripts/bench/run-one.mjs <pkgDir> <workload.json>
//   node --expose-gc --experimental-strip-types scripts/bench/run-one.mjs <pkgDir> --worker
//
// Compiles WebAssembly.Module once per process so V8 TurboFan tier-up happens at warm-up,
// instantiates a fresh WebAssembly.Instance (and fresh linear memory / dlmalloc heap) before each
// timed sample, measures thread CPU time (excluding background V8 helper threads), and drops +
// garbage-collects the finished WebAssembly.Instance outside the timed CPU window.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { takeBatch } from '../lib/take-batch.mjs';
import { drawingRequest } from '../../src/infrastructure/kernel/drawingRequest.ts';

const args = process.argv.slice(2);
const workerMode = args.includes('--worker');
const positional = args.filter((a) => a !== '--worker');
const pkgDir = positional[0];

// Allow initSync({ module: wasmMod }) to create a fresh WebAssembly.Instance and fresh
// WebAssembly.Memory from the shared compiled WebAssembly.Module, and expose __resetWasm() so the
// instance and its TypedArray views can be dropped and garbage-collected outside the timed window.
const rawJsSrc = readFileSync(path.join(pkgDir, 'wasm_api.js'), 'utf8');
const cachedReset = [...rawJsSrc.matchAll(/\blet (cached\w+Memory\d+) = null;/g)]
  .map((m) => `${m[1]} = null;`)
  .join(' ');
const resetStmt = `wasm = undefined; wasmInstance = undefined; ${cachedReset}`;
const jsSrc = `${rawJsSrc.replace('if (wasm !== undefined) return wasm;', resetStmt)}\nexport function __resetWasm() { ${resetStmt} }\n`;
const jsDataUrl = `data:text/javascript;base64,${Buffer.from(jsSrc).toString('base64')}`;
const { initSync, Model, Sheet, __resetWasm } = await import(jsDataUrl);
const wasmMod = new WebAssembly.Module(readFileSync(path.join(pkgDir, 'wasm_api_bg.wasm')));
const sab = new Int32Array(new SharedArrayBuffer(4));

// Prefer threadCpuUsage (Node 22.15+ / 23.9+) so background V8 helper threads (concurrent JIT
// compilation, GC sweepers) do not add multi-thread ticks to the main thread's kernel CPU time.
const getCpuUsage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage : process.cpuUsage;

function runPass(workload, fileBuffers) {
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
        // As the worker reads it: native formats, shapes and instances (A11, A13). Frees the view.
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

  for (let r = 0; r < (workload.repeat ?? 1); r++) {
    for (const bytes of fileBuffers) {
      const model = loadAndStream(bytes);
      if (workload.drawing) draw(model, workload.drawing);
      model.free();
    }
  }
  return { ms, out };
}

// Minimum target duration per timed sample so Windows's 15.625 ms GetThreadTimes tick granularity
// is a small fraction of each measurement even on short workloads (Duplex A, ~53 ms warm).
const TARGET_SAMPLE_MS = 450;
let currentWorkload = null;
let currentBuffers = null;
let inner = 1;

function loadWorkload(workloadFile, doWarm = true) {
  currentBuffers = null;
  __resetWasm();
  globalThis.gc?.();
  currentWorkload = JSON.parse(readFileSync(workloadFile, 'utf8'));
  currentBuffers = currentWorkload.files.map((file) => readFileSync(file));
  // Short single-file workloads (Duplex A, 2.3 MB) run 8 inner passes (~430 ms total) so Windows
  // 15.625 ms CPU ticks represent <= 3.5 % per tick instead of ~30 %.
  const totalBytes = currentBuffers.reduce((acc, b) => acc + b.byteLength, 0) * (currentWorkload.repeat ?? 1);
  inner = !currentWorkload.drawing && totalBytes < 4_000_000 ? 8 : 1;
  // Warm short and medium workloads (< 15 MB) on load so any workload-specific WASM functions
  // finish V8 tier-up before the first timed sample.
  if (doWarm && totalBytes < 15_000_000) {
    const singlePassWorkload = { ...currentWorkload, repeat: 1 };
    initSync({ module: wasmMod });
    let elapsed = 0;
    const minWarmMs = inner > 1 ? TARGET_SAMPLE_MS : 1;
    while (elapsed < minWarmMs) {
      const t0 = performance.now();
      runPass(singlePassWorkload, currentBuffers);
      elapsed += performance.now() - t0;
    }
    __resetWasm();
    globalThis.gc?.();
    Atomics.wait(sab, 0, 0, 20);
  }
}

function warmUp(workloadFile) {
  loadWorkload(workloadFile, false);
  const singlePassWorkload = { ...currentWorkload, repeat: 1 };
  initSync({ module: wasmMod });
  let elapsed = 0;
  while (elapsed < TARGET_SAMPLE_MS) {
    const t0 = performance.now();
    runPass(singlePassWorkload, currentBuffers);
    elapsed += performance.now() - t0;
  }
  __resetWasm();
  globalThis.gc?.();
  Atomics.wait(sab, 0, 0, 25);
}

function measureSample() {
  __resetWasm();
  globalThis.gc?.();
  const exports_ = initSync({ module: wasmMod });
  const cpu0 = getCpuUsage();
  const accMs = {};
  let lastOut = null;
  let peakMB = 0;
  for (let k = 0; k < inner; k++) {
    const { ms, out } = runPass(currentWorkload, currentBuffers);
    lastOut = out;
    if (k === 0) peakMB = Math.round(exports_.memory.buffer.byteLength / 1048576);
    for (const [key, val] of Object.entries(ms)) accMs[key] = (accMs[key] ?? 0) + val;
  }
  const cpu = getCpuUsage(cpu0);
  __resetWasm();
  globalThis.gc?.();
  const ms = {};
  for (const key of Object.keys(accMs)) ms[key] = Math.round((accMs[key] / inner) * 10) / 10;
  ms.total = Math.round(Object.values(ms).reduce((a, b) => a + b, 0) * 10) / 10;
  ms.cpu = Math.round((cpu.user + cpu.system) / inner / 100) / 10;
  return { ms, out: lastOut, wasmMB: peakMB };
}

if (!workerMode) {
  warmUp(positional[1]);
  console.log(JSON.stringify(measureSample()));
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('warm ')) {
      warmUp(line.slice(5));
      process.stdout.write('ready\n');
    } else if (line.startsWith('load ')) {
      loadWorkload(line.slice(5), true);
      process.stdout.write('ready\n');
    } else if (line === 'run') {
      process.stdout.write(JSON.stringify(measureSample()) + '\n');
    } else if (line === 'quit') {
      break;
    }
  }
}
