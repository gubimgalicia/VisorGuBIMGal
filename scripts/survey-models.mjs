// Quality survey of the WASM kernel over public buildingSMART IFC models (T-145).
// Usage:
//   node --experimental-strip-types scripts/survey-models.mjs [--out <dir>] [--filter <substr>] [--timeout <ms>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { takeBatch } from './lib/take-batch.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(THIS_FILE);
const REPO = path.resolve(HERE, '..');
const PKG_DIR = path.join(REPO, 'src/infrastructure/kernel/pkg');
const MAX_TRIANGLES_PER_BATCH = 65536;
const MAX_TRIANGLES_PER_CHUNK = 65536;

function groupDiagnostics(list) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of list ?? []) {
    if (item && typeof item.code === 'string') {
      counts[item.code] = (counts[item.code] ?? 0) + 1;
    }
  }
  return counts;
}

function groupDiagnosticDetails(list) {
  /** @type {Record<string, Record<string, number>>} */
  const details = {};
  for (const item of list ?? []) {
    if (!item || typeof item.code !== 'string') continue;
    const rawMsg = typeof item.message === 'string' ? item.message : '';
    const normMsg = rawMsg
      .replace(/^#\d+:?\s*/, '')
      .replace(/\d+ degenerate or corrupt triangles dropped/, 'N degenerate or corrupt triangles dropped')
      .replace(/segments end [\d.]+ m apart/, 'segments end >0.01 m apart');
    if (!details[item.code]) details[item.code] = {};
    details[item.code][normMsg] = (details[item.code][normMsg] ?? 0) + 1;
  }
  return details;
}

function cleanErrorText(err) {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ---------- Child mode: one fresh process per IFC file ----------
if (process.argv[2] === '--child') {
  const [, , , filePath, stateFile] = process.argv;
  const { drawingRequest } = await import(
    pathToFileURL(path.join(REPO, 'src/infrastructure/kernel/drawingRequest.ts')).href
  );
  const { initSync, allocationFailed, Model, Sheet } = await import(
    pathToFileURL(path.join(PKG_DIR, 'wasm_api.js')).href
  );
  const wasmExports = initSync({ module: readFileSync(path.join(PKG_DIR, 'wasm_api_bg.wasm')) });
  const wasmBytes = () => wasmExports.memory.buffer.byteLength;

  let peakWasmBytes = wasmBytes();
  let peakRssBytes = process.memoryUsage().rss;
  const sampleMemory = () => {
    const wb = wasmBytes();
    if (wb > peakWasmBytes) peakWasmBytes = wb;
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  };

  const state = {
    stage: 'open',
    status: 'running',
    openResult: 'pending',
    schema: null,
    schemaIdentifier: null,
    entityCount: null,
    elementCount: null,
    meshCount: null,
    triangles: 0,
    batches: 0,
    bounds: null,
    summaryDiagnostics: {},
    streamDiagnostics: {},
    diagnostics: {},
    diagnosticDetails: {},
    timesMs: {
      open: null,
      spatialTree: null,
      stream: null,
      drawing: null
    },
    peakWasmBytes,
    peakWasmMB: Number((peakWasmBytes / 1048576).toFixed(2)),
    peakRssMB: Number((peakRssBytes / 1048576).toFixed(2)),
    memoryNote: null,
    drawing: null,
    crashPhase: null,
    outOfMemory: false,
    error: null
  };

  const saveState = () => {
    sampleMemory();
    state.peakWasmBytes = peakWasmBytes;
    state.peakWasmMB = Number((peakWasmBytes / 1048576).toFixed(2));
    state.peakRssMB = Number((peakRssBytes / 1048576).toFixed(2));
    state.memoryNote = `peak WASM ${(peakWasmBytes / 1048576).toFixed(1)} MB, RSS ${(peakRssBytes / 1048576).toFixed(1)} MB`;
    writeFileSync(stateFile, JSON.stringify(state));
  };

  saveState();
  const bytes = readFileSync(filePath);
  sampleMemory();

  let model = null;
  let rawSummaryDiags = [];
  try {
    const tOpen0 = performance.now();
    model = new Model(bytes);
    const openMs = performance.now() - tOpen0;
    sampleMemory();

    const summary = JSON.parse(model.summaryJson());
    sampleMemory();

    rawSummaryDiags = summary.diagnostics ?? [];
    state.openResult = 'ok';
    state.schema = summary.schema ?? null;
    state.schemaIdentifier = summary.schemaIdentifier ?? null;
    state.entityCount = summary.entityCount ?? 0;
    state.elementCount = summary.elementCount ?? 0;
    state.summaryDiagnostics = groupDiagnostics(rawSummaryDiags);
    state.diagnostics = { ...state.summaryDiagnostics };
    state.diagnosticDetails = groupDiagnosticDetails(rawSummaryDiags);
    state.timesMs.open = Number(openMs.toFixed(2));
    state.stage = 'tree';
    saveState();
  } catch (err) {
    const msg = cleanErrorText(err);
    const oom = Boolean(
      allocationFailed() || err instanceof RangeError || /out of memory|memory/i.test(msg)
    );
    const isTrap = err instanceof WebAssembly.RuntimeError || oom;
    if (isTrap) {
      state.status = 'crashed';
      state.crashPhase = 'open';
      state.outOfMemory = oom;
      state.openResult = oom ? `out-of-memory: ${msg}`.slice(0, 200) : `trap: ${msg}`.slice(0, 200);
      state.error = state.openResult;
      saveState();
      process.exit(1);
    } else {
      state.status = 'failed-to-open';
      state.openResult = msg;
      state.error = msg;
      saveState();
      process.exit(0);
    }
  }

  // Spatial tree
  try {
    const tTree0 = performance.now();
    model.spatialTreeJson();
    state.timesMs.spatialTree = Number((performance.now() - tTree0).toFixed(2));
    state.stage = 'stream';
    saveState();
  } catch (err) {
    const msg = cleanErrorText(err);
    const oom = Boolean(
      allocationFailed() || err instanceof RangeError || /out of memory|memory/i.test(msg)
    );
    state.status = 'crashed';
    state.crashPhase = 'spatialTree';
    state.outOfMemory = oom;
    state.error = msg;
    saveState();
    process.exit(1);
  }

  // Geometry stream
  try {
    const tStream0 = performance.now();
    model.startStream();
    let triangles = 0;
    let batches = 0;
    for (;;) {
      const view = model.nextBatch(MAX_TRIANGLES_PER_BATCH);
      if (!view) break;
      const { indices } = takeBatch(view);
      triangles += indices.length / 3;
      batches += 1;
      sampleMemory();
    }
    const finishedJson = model.finishStream();
    const streamMs = performance.now() - tStream0;
    sampleMemory();

    const finished = JSON.parse(finishedJson);
    const rawStreamDiags = finished.diagnostics ?? [];
    state.meshCount = finished.meshCount ?? 0;
    state.triangles = triangles;
    state.batches = batches;
    state.bounds = finished.bounds ?? null;
    state.streamDiagnostics = groupDiagnostics(rawStreamDiags);

    const allModelDiags = [...rawSummaryDiags, ...rawStreamDiags];
    state.diagnostics = groupDiagnostics(allModelDiags);
    state.diagnosticDetails = groupDiagnosticDetails(allModelDiags);
    state.timesMs.stream = Number(streamMs.toFixed(2));
    state.stage = 'drawing';
    saveState();
  } catch (err) {
    const msg = cleanErrorText(err);
    const oom = Boolean(
      allocationFailed() || err instanceof RangeError || /out of memory|memory/i.test(msg)
    );
    state.status = 'crashed';
    state.crashPhase = 'stream';
    state.outOfMemory = oom;
    state.error = msg;
    saveState();
    process.exit(1);
  }

  // 2D plan drawing at mid-height
  try {
    const tDraw0 = performance.now();
    const bounds = state.bounds;
    const z = bounds ? (bounds.min.z + bounds.max.z) / 2 : 1;
    const options = {
      cut: { kind: 'plan', elevation: z },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    };
    const reqWords = new Float64Array(drawingRequest(options));
    model.startDrawing(reqWords);
    const sheet = new Sheet(reqWords);
    for (;;) {
      const chunk = model.nextDrawingChunk(MAX_TRIANGLES_PER_CHUNK);
      if (!chunk) break;
      sheet.addChunk(0, chunk);
      sampleMemory();
    }
    const modelDrawDiags = JSON.parse(model.finishDrawing());
    const sheetDrawDiags = JSON.parse(sheet.generate());
    sampleMemory();

    const svgBytes = sheet.export(true, 1, true, true, undefined);
    const dxfBytes = sheet.export(false, 1, true, true, undefined);
    sampleMemory();
    sheet.free();

    const drawMs = performance.now() - tDraw0;
    state.timesMs.drawing = Number(drawMs.toFixed(2));

    if (!svgBytes || !dxfBytes) {
      state.drawing = {
        status: 'error',
        elevation: z,
        error: 'sheet.export returned undefined',
        loops: 0,
        sheetDiagnostics: groupDiagnostics(sheetDrawDiags),
        modelDiagnostics: groupDiagnostics(modelDrawDiags),
        diagnostics: groupDiagnostics([...modelDrawDiags, ...sheetDrawDiags])
      };
    } else {
      const svgText = new TextDecoder().decode(svgBytes);
      const loops = (svgText.match(/ Z/g) ?? []).length;
      state.drawing = {
        status: 'ok',
        elevation: z,
        error: null,
        loops,
        svgBytes: svgBytes.length,
        dxfBytes: dxfBytes.length,
        sheetDiagnostics: groupDiagnostics(sheetDrawDiags),
        modelDiagnostics: groupDiagnostics(modelDrawDiags),
        diagnostics: groupDiagnostics([...modelDrawDiags, ...sheetDrawDiags])
      };
    }
    model.free();
    state.stage = 'done';
    state.status = 'ok';
    saveState();
    process.exit(0);
  } catch (err) {
    const msg = cleanErrorText(err);
    const oom = Boolean(
      allocationFailed() || err instanceof RangeError || /out of memory|memory/i.test(msg)
    );
    state.drawing = {
      status: 'error',
      error: oom ? `out-of-memory: ${msg}`.slice(0, 200) : msg,
      outOfMemory: oom,
      loops: null,
      sheetDiagnostics: {},
      modelDiagnostics: {},
      diagnostics: {}
    };
    state.stage = 'done';
    state.status = 'ok';
    saveState();
    process.exit(0);
  }
}

// ---------- Parent orchestrator ----------
const args = process.argv.slice(2);
let outDir = path.join(os.tmpdir(), 'gubim-survey');
let timeoutMs = 60_000;
/** @type {string[]} */
const filters = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out' && args[i + 1]) {
    outDir = args[++i];
  } else if (a.startsWith('--out=')) {
    outDir = a.slice('--out='.length);
  } else if (a === '--filter' && args[i + 1]) {
    filters.push(args[++i]);
  } else if (a.startsWith('--filter=')) {
    filters.push(a.slice('--filter='.length));
  } else if (a === '--timeout' && args[i + 1]) {
    timeoutMs = Number(args[++i]);
  } else if (a.startsWith('--timeout=')) {
    timeoutMs = Number(a.slice('--timeout='.length));
  }
}

const resolvedOut = path.resolve(outDir);
const resolvedRepo = path.resolve(REPO);
if (resolvedOut === resolvedRepo || resolvedOut.startsWith(resolvedRepo + path.sep)) {
  console.error(`Output directory must be outside the repository: ${resolvedOut}`);
  process.exit(1);
}
if (!existsSync(path.join(PKG_DIR, 'wasm_api_bg.wasm'))) {
  console.error('Kernel WASM package not found. Run: npm run kernel');
  process.exit(2);
}

const modelsDir = path.resolve(process.env.GUBIM_MODELS_DIR ?? path.join(REPO, 'test/models'));
const manifestPath = path.join(modelsDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found at ${manifestPath}`);
  process.exit(2);
}

function matchesFilter(entryPath, filter) {
  const norm = filter.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return (
    entryPath === norm ||
    entryPath.startsWith(norm + '/') ||
    entryPath.split('/').includes(norm)
  );
}

/** @type {Array<{ path: string; bytes: number; lfsPointer?: boolean }>} */
const manifestAll = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestFiltered =
  filters.length > 0
    ? manifestAll.filter((entry) => filters.some((f) => matchesFilter(entry.path, f)))
    : manifestAll;

mkdirSync(resolvedOut, { recursive: true });
const tempStateFile = path.join(resolvedOut, `.child-state-${process.pid}.json`);

/**
 * Independently of the kernel, counts IFCMAPPEDITEM and IFCREPRESENTATIONMAP in the STEP text,
 * and reads the header's FILE_SCHEMA identifier as a fallback when the kernel rejects or crashes.
 */
function inspectStepText(absPath) {
  const text = readFileSync(absPath, 'latin1');
  const mappedItems = (text.match(/=\s*IFCMAPPEDITEM\s*\(/gi) ?? []).length;
  const representationMaps = (text.match(/=\s*IFCREPRESENTATIONMAP\s*\(/gi) ?? []).length;
  const head = text.slice(0, 4096);
  const schemaMatch = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i);
  const headerSchema = schemaMatch ? schemaMatch[1].trim() : null;
  return { mappedItems, representationMaps, headerSchema };
}

const startedAll = performance.now();
const skipped = [];
const results = [];

console.log(
  `Surveying ${manifestFiltered.length} manifest entries from ${modelsDir} (timeout ${timeoutMs} ms, out ${resolvedOut})`
);

for (let idx = 0; idx < manifestFiltered.length; idx++) {
  const entry = manifestFiltered[idx];
  const ext = path.extname(entry.path).toLowerCase();
  if (ext === '.ifczip' || ext === '.ifcxml') {
    skipped.push({
      path: entry.path,
      bytes: entry.bytes,
      extension: ext,
      reason: `Kernel step-parser only reads uncompressed ISO 10303-21 STEP (.ifc); ${ext} is not supported`
    });
    console.log(
      `[${String(idx + 1).padStart(3)}/${manifestFiltered.length}] SKIP ${entry.path} (${ext} not supported by kernel)`
    );
    continue;
  }
  if (entry.lfsPointer) {
    skipped.push({
      path: entry.path,
      bytes: entry.bytes,
      extension: ext,
      reason: 'Unfetched Git LFS pointer'
    });
    console.log(
      `[${String(idx + 1).padStart(3)}/${manifestFiltered.length}] SKIP ${entry.path} (LFS pointer)`
    );
    continue;
  }

  const fullPath = path.join(modelsDir, entry.path);
  const fileBytes = existsSync(fullPath) ? statSync(fullPath).size : entry.bytes;
  const textStats = existsSync(fullPath)
    ? inspectStepText(fullPath)
    : { mappedItems: 0, representationMaps: 0, headerSchema: null };

  try {
    rmSync(tempStateFile, { force: true });
  } catch {
    // ignore
  }

  const t0 = performance.now();
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', THIS_FILE, '--child', fullPath, tempStateFile],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024
    }
  );
  const wallMs = Number((performance.now() - t0).toFixed(2));

  let childState = null;
  if (existsSync(tempStateFile)) {
    try {
      childState = JSON.parse(readFileSync(tempStateFile, 'utf8'));
    } catch {
      childState = null;
    }
  }

  const timedOut = Boolean(
    child.error && /** @type {any} */ (child.error).code === 'ETIMEDOUT'
  );
  const stderrSnippet = (child.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-200);

  let record;
  if (timedOut) {
    const stage = childState?.stage ?? 'open';
    const openedOk = childState?.openResult === 'ok';
    record = {
      path: entry.path,
      bytes: fileBytes,
      mb: Number((fileBytes / 1048576).toFixed(3)),
      status: stage === 'drawing' && openedOk ? 'drawing-timeout' : 'timeout',
      openResult: openedOk ? 'ok' : `timeout after ${timeoutMs} ms in ${stage}`,
      schema: childState?.schema ?? textStats.headerSchema,
      schemaIdentifier: childState?.schemaIdentifier ?? textStats.headerSchema,
      entityCount: childState?.entityCount ?? null,
      elementCount: childState?.elementCount ?? null,
      meshCount: childState?.meshCount ?? null,
      triangles: childState?.triangles ?? 0,
      batches: childState?.batches ?? 0,
      summaryDiagnostics: childState?.summaryDiagnostics ?? {},
      streamDiagnostics: childState?.streamDiagnostics ?? {},
      diagnostics: childState?.diagnostics ?? {},
      diagnosticDetails: childState?.diagnosticDetails ?? {},
      timesMs: {
        open: childState?.timesMs?.open ?? null,
        spatialTree: childState?.timesMs?.spatialTree ?? null,
        stream: childState?.timesMs?.stream ?? null,
        drawing: childState?.timesMs?.drawing ?? null,
        wall: wallMs
      },
      peakWasmBytes: childState?.peakWasmBytes ?? null,
      peakWasmMB: childState?.peakWasmMB ?? null,
      peakRssMB: childState?.peakRssMB ?? null,
      memoryNote:
        childState?.memoryNote ?? `timed out at ${timeoutMs} ms during stage=${stage}`,
      drawing:
        stage === 'drawing'
          ? {
              status: 'error',
              error: `timeout after ${timeoutMs} ms during drawing`,
              loops: null,
              sheetDiagnostics: {},
              modelDiagnostics: {},
              diagnostics: {}
            }
          : null,
      mappedItems: textStats.mappedItems,
      representationMaps: textStats.representationMaps,
      mappedToRepMapRatio:
        textStats.representationMaps > 0
          ? Number((textStats.mappedItems / textStats.representationMaps).toFixed(2))
          : null,
      crashPhase: stage,
      outOfMemory: false,
      error: `timeout after ${timeoutMs} ms in ${stage}`
    };
  } else if (child.status !== 0 || !childState || childState.status === 'crashed') {
    const stage = childState?.crashPhase ?? childState?.stage ?? 'unknown';
    const oom = Boolean(
      childState?.outOfMemory || /out of memory|allocation failed/i.test(stderrSnippet)
    );
    const errText = (
      childState?.error ||
      stderrSnippet ||
      `child exited with status ${child.status} signal ${child.signal}`
    ).slice(0, 200);
    record = {
      path: entry.path,
      bytes: fileBytes,
      mb: Number((fileBytes / 1048576).toFixed(3)),
      status: 'crashed',
      openResult: childState?.openResult === 'ok' ? 'ok' : errText,
      schema: childState?.schema ?? textStats.headerSchema,
      schemaIdentifier: childState?.schemaIdentifier ?? textStats.headerSchema,
      entityCount: childState?.entityCount ?? null,
      elementCount: childState?.elementCount ?? null,
      meshCount: childState?.meshCount ?? null,
      triangles: childState?.triangles ?? 0,
      batches: childState?.batches ?? 0,
      summaryDiagnostics: childState?.summaryDiagnostics ?? {},
      streamDiagnostics: childState?.streamDiagnostics ?? {},
      diagnostics: childState?.diagnostics ?? {},
      diagnosticDetails: childState?.diagnosticDetails ?? {},
      timesMs: {
        open: childState?.timesMs?.open ?? null,
        spatialTree: childState?.timesMs?.spatialTree ?? null,
        stream: childState?.timesMs?.stream ?? null,
        drawing: childState?.timesMs?.drawing ?? null,
        wall: wallMs
      },
      peakWasmBytes: childState?.peakWasmBytes ?? null,
      peakWasmMB: childState?.peakWasmMB ?? null,
      peakRssMB: childState?.peakRssMB ?? null,
      memoryNote:
        childState?.memoryNote ?? `crashed in ${stage}${oom ? ' (OOM)' : ''}`,
      drawing: childState?.drawing ?? null,
      mappedItems: textStats.mappedItems,
      representationMaps: textStats.representationMaps,
      mappedToRepMapRatio:
        textStats.representationMaps > 0
          ? Number((textStats.mappedItems / textStats.representationMaps).toFixed(2))
          : null,
      crashPhase: stage,
      outOfMemory: oom,
      error: errText
    };
  } else {
    record = {
      path: entry.path,
      bytes: fileBytes,
      mb: Number((fileBytes / 1048576).toFixed(3)),
      status: childState.status,
      openResult: childState.openResult,
      schema: childState.schema ?? textStats.headerSchema,
      schemaIdentifier: childState.schemaIdentifier ?? textStats.headerSchema,
      entityCount: childState.entityCount,
      elementCount: childState.elementCount,
      meshCount: childState.meshCount,
      triangles: childState.triangles,
      batches: childState.batches,
      summaryDiagnostics: childState.summaryDiagnostics,
      streamDiagnostics: childState.streamDiagnostics,
      diagnostics: childState.diagnostics,
      diagnosticDetails: childState.diagnosticDetails ?? {},
      timesMs: {
        ...childState.timesMs,
        wall: wallMs
      },
      peakWasmBytes: childState.peakWasmBytes,
      peakWasmMB: childState.peakWasmMB,
      peakRssMB: childState.peakRssMB,
      memoryNote: childState.memoryNote,
      drawing: childState.drawing,
      mappedItems: textStats.mappedItems,
      representationMaps: textStats.representationMaps,
      mappedToRepMapRatio:
        textStats.representationMaps > 0
          ? Number((textStats.mappedItems / textStats.representationMaps).toFixed(2))
          : null,
      crashPhase: null,
      outOfMemory: false,
      error: childState.error
    };
  }

  results.push(record);
  const tag =
    record.status === 'ok'
      ? record.drawing?.status === 'ok'
        ? 'OK  '
        : 'DRAW'
      : record.status === 'failed-to-open'
        ? 'OPEN'
        : 'CRSH';
  console.log(
    `[${String(idx + 1).padStart(3)}/${manifestFiltered.length}] ${tag} ${entry.path} (${record.mb.toFixed(2)} MB, ${wallMs.toFixed(0)} ms, wasm ${record.peakWasmMB ?? '?'} MB)`
  );
}

try {
  rmSync(tempStateFile, { force: true });
} catch {
  // ignore
}

const totalDurationSec = Number(((performance.now() - startedAll) / 1000).toFixed(2));

// Compute aggregate totals
const opened = results.filter((r) => r.openResult === 'ok');
const failedToOpen = results.filter((r) => r.status === 'failed-to-open');
const crashedOrTimedOut = results.filter(
  (r) => r.status === 'crashed' || r.status === 'timeout' || r.status === 'drawing-timeout'
);
const drawingsFailed = results.filter(
  (r) => r.openResult === 'ok' && (!r.drawing || r.drawing.status !== 'ok')
);

/** @type {Record<string, { count: number; files: number }>} */
const diagnosticTotals = {};
for (const r of results) {
  for (const [code, count] of Object.entries(r.diagnostics ?? {})) {
    if (!diagnosticTotals[code]) diagnosticTotals[code] = { count: 0, files: 0 };
    diagnosticTotals[code].count += count;
    diagnosticTotals[code].files += 1;
  }
}

/** @type {Record<string, { count: number; files: number }>} */
const drawingDiagnosticTotals = {};
for (const r of results) {
  for (const [code, count] of Object.entries(r.drawing?.sheetDiagnostics ?? {})) {
    if (!drawingDiagnosticTotals[code]) drawingDiagnosticTotals[code] = { count: 0, files: 0 };
    drawingDiagnosticTotals[code].count += count;
    drawingDiagnosticTotals[code].files += 1;
  }
}

const totals = {
  manifestEntries: manifestFiltered.length,
  skippedCount: skipped.length,
  surveyedIfcFiles: results.length,
  opened: opened.length,
  failedToOpen: failedToOpen.length,
  crashedOrTimedOut: crashedOrTimedOut.length,
  drawingsFailed: drawingsFailed.length,
  durationSeconds: totalDurationSec
};

const outputPayload = {
  generatedAt: new Date().toISOString(),
  modelsDir,
  filters,
  timeoutMs,
  totals,
  diagnosticTotals,
  drawingDiagnosticTotals,
  skipped,
  results
};

const jsonPath = path.join(resolvedOut, 'survey.json');
writeFileSync(jsonPath, JSON.stringify(outputPayload, null, 2), 'utf8');

// Build Markdown summary
const mdLines = [
  '# Model Survey Summary',
  '',
  `- **Models directory:** \`${modelsDir}\``,
  `- **Manifest entries matching filter:** ${totals.manifestEntries}`,
  `- **Skipped (.ifczip / .ifcxml / LFS):** ${totals.skippedCount}`,
  `- **IFC files surveyed:** ${totals.surveyedIfcFiles}`,
  `- **Opened:** ${totals.opened}`,
  `- **Failed to open:** ${totals.failedToOpen}`,
  `- **Crashed or timed out:** ${totals.crashedOrTimedOut}`,
  `- **Drawings failed:** ${totals.drawingsFailed}`,
  `- **Total run time:** ${totals.durationSeconds} s`,
  '',
  '## Failures & Crashes',
  '',
  '| File | Schema | Status | Detail |',
  '|---|---|---|---|'
];

for (const r of results.filter(
  (x) => x.status !== 'ok' || (x.drawing && x.drawing.status !== 'ok')
)) {
  const detail = r.error ?? r.drawing?.error ?? r.openResult;
  mdLines.push(`| \`${r.path}\` | \`${r.schema ?? '-'}\` | ${r.status} | \`${detail}\` |`);
}

mdLines.push(
  '',
  '## Diagnostic Codes (summaryJson + finishStream)',
  '',
  '| Code | Total Count | Files |',
  '|---|---:|---:|'
);
for (const [code, info] of Object.entries(diagnosticTotals).sort(
  (a, b) => b[1].count - a[1].count
)) {
  mdLines.push(`| \`${code}\` | ${info.count} | ${info.files} |`);
}

mdLines.push(
  '',
  '## Drawing Diagnostic Codes (sheet.generate)',
  '',
  '| Code | Total Count | Files |',
  '|---|---:|---:|'
);
for (const [code, info] of Object.entries(drawingDiagnosticTotals).sort(
  (a, b) => b[1].count - a[1].count
)) {
  mdLines.push(`| \`${code}\` | ${info.count} | ${info.files} |`);
}

mdLines.push(
  '',
  '## 10 Largest Models by Peak WASM Memory',
  '',
  '| File | Size (MB) | Peak WASM (MB) | Peak RSS (MB) | Triangles | Batches |',
  '|---|---:|---:|---:|---:|---:|'
);
for (const r of [...opened]
  .sort((a, b) => (b.peakWasmBytes ?? 0) - (a.peakWasmBytes ?? 0))
  .slice(0, 10)) {
  mdLines.push(
    `| \`${r.path}\` | ${r.mb.toFixed(2)} | ${(r.peakWasmMB ?? 0).toFixed(2)} | ${(r.peakRssMB ?? 0).toFixed(2)} | ${r.triangles} | ${r.batches} |`
  );
}

mdLines.push(
  '',
  '## 15 Slowest Models per MB (Kernel open + tree + stream)',
  '',
  '| File | Size (MB) | Open (ms) | Tree (ms) | Stream (ms) | Kernel ms/MB |',
  '|---|---:|---:|---:|---:|---:|'
);
for (const r of [...opened]
  .filter((x) => x.bytes > 0)
  .map((x) => {
    const kMs = (x.timesMs.open ?? 0) + (x.timesMs.spatialTree ?? 0) + (x.timesMs.stream ?? 0);
    const mb = x.bytes / 1048576;
    return { ...x, kMs, kMsPerMb: kMs / mb };
  })
  .sort((a, b) => b.kMsPerMb - a.kMsPerMb)
  .slice(0, 15)) {
  mdLines.push(
    `| \`${r.path}\` | ${r.mb.toFixed(3)} | ${r.timesMs.open} | ${r.timesMs.spatialTree} | ${r.timesMs.stream} | ${r.kMsPerMb.toFixed(1)} |`
  );
}

mdLines.push(
  '',
  '## Top Models by Mapped-Item Repetition',
  '',
  '| File | IFCMAPPEDITEM | IFCREPRESENTATIONMAP | Ratio | Triangles |',
  '|---|---:|---:|---:|---:|'
);
for (const r of [...results]
  .filter((x) => x.mappedItems > 0 || x.representationMaps > 0)
  .sort(
    (a, b) =>
      b.mappedItems - b.representationMaps - (a.mappedItems - a.representationMaps) ||
      b.mappedItems - a.mappedItems
  )
  .slice(0, 15)) {
  mdLines.push(
    `| \`${r.path}\` | ${r.mappedItems} | ${r.representationMaps} | ${r.mappedToRepMapRatio ?? '-'} | ${r.triangles} |`
  );
}

const mdPath = path.join(resolvedOut, 'survey.md');
writeFileSync(mdPath, mdLines.join('\n') + '\n', 'utf8');

console.log(`\nSurvey finished in ${totalDurationSec} s`);
console.log(`JSON written to: ${jsonPath}`);
console.log(`Markdown written to: ${mdPath}`);
console.log(JSON.stringify(totals));
