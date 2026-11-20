// Visual regression of 2D drawings (SVG and DXF summary against approved references).
// Usage:
//   node --experimental-strip-types scripts/check-drawings.mjs [--update] [--out <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawingRequest, frameModels } from '../src/infrastructure/kernel/drawingRequest.ts';
import { initSync, kernelVersion, Model, Sheet } from '../src/infrastructure/kernel/pkg/wasm_api.js';
import { inspectPdf, paperSizePt, svgToPdf } from '../src/ui/viewer/svgToPdf.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const refDir = join(root, 'test/drawings/ref');
const MAX_TRIANGLES_PER_CHUNK = 65536;

const args = process.argv.slice(2);
const update = args.includes('--update');
let outDir = join(os.tmpdir(), 'gubim-drawings');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outDir = args[++i];
  } else if (args[i].startsWith('--out=')) {
    outDir = args[i].slice('--out='.length);
  }
}
if (resolve(outDir).startsWith(resolve(root))) {
  console.error(`Output directory must be outside the repository: ${outDir}`);
  process.exit(1);
}

const pkg = join(root, 'src/infrastructure/kernel/pkg');
const wasm = readFileSync(join(pkg, 'wasm_api_bg.wasm'));
initSync({ module: wasm });

console.log(`kernel ${kernelVersion()}, ${(wasm.length / 1024 / 1024).toFixed(2)} MB wasm`);

/** @type {Array<{ name: string; fixture: string; options: import('../src/domain/drawings/DrawingTypes.ts').DrawingOptions }>} */
export const CASES = [
  // SimpleWall (public/samples): plans and sections on X and Y, both look directions
  {
    name: 'simple-wall-plan',
    fixture: 'public/samples/SimpleWall.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.2 },
      frame: { kind: 'project' },
      includeProjection: false,
      includeHiddenLines: false,
      includeHatching: false
    }
  },
  {
    name: 'simple-wall-plan-hatched-hidden',
    fixture: 'public/samples/SimpleWall.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.2 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'simple-wall-plan-top',
    fixture: 'public/samples/SimpleWall.ifc',
    options: {
      cut: { kind: 'plan', elevation: 3.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  {
    name: 'simple-wall-section-y-pos',
    fixture: 'public/samples/SimpleWall.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: -0.05, look: 'positive' },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'simple-wall-section-x-neg',
    fixture: 'public/samples/SimpleWall.ifc',
    options: {
      cut: { kind: 'section', axis: 'x', position: 1.0, look: 'negative', depth: 2.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: false
    }
  },

  // ManySimpleWalls (public/samples): plans and sections on X and Y, with depth, hatching, hidden lines
  {
    name: 'many-walls-plan-hatched',
    fixture: 'public/samples/ManySimpleWalls.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.2 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  {
    name: 'many-walls-plan-depth-hidden',
    fixture: 'public/samples/ManySimpleWalls.ifc',
    options: {
      cut: { kind: 'plan', elevation: 5.0, depth: 2.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: false
    }
  },
  {
    name: 'many-walls-section-x-pos',
    fixture: 'public/samples/ManySimpleWalls.ifc',
    options: {
      cut: { kind: 'section', axis: 'x', position: 2.0, look: 'positive', depth: 10.0 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'many-walls-section-y-neg',
    fixture: 'public/samples/ManySimpleWalls.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: 4.0, look: 'negative' },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },

  // Hatching fixtures (test/fixtures)
  {
    name: 'hatching-materials-plan',
    fixture: 'test/fixtures/hatching-materials.ifc',
    options: {
      cut: { kind: 'plan', elevation: 0.5 },
      frame: { kind: 'project' },
      includeProjection: false,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  {
    name: 'hatching-materials-section-y',
    fixture: 'test/fixtures/hatching-materials.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: 1.0, look: 'positive' },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'hatching-materials-ifc2x3-plan',
    fixture: 'test/fixtures/hatching-materials-ifc2x3.ifc',
    options: {
      cut: { kind: 'plan', elevation: 0.5 },
      frame: { kind: 'project' },
      includeProjection: false,
      includeHiddenLines: false,
      includeHatching: true
    }
  },

  // Boolean / clipping fixture (test/fixtures)
  {
    name: 'boolean-clipping-plan',
    fixture: 'test/fixtures/boolean-clipping-halfspace.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'boolean-clipping-section-y',
    fixture: 'test/fixtures/boolean-clipping-halfspace.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: 0.0, look: 'positive' },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },

  // Authored building-booleans (test/fixtures/authored)
  {
    name: 'building-booleans-plan-l1',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'building-booleans-plan-l2-depth',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: { kind: 'plan', elevation: 4.8, depth: 1.8 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  {
    name: 'building-booleans-section-x-pos',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: { kind: 'section', axis: 'x', position: 5.5, look: 'positive' },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'building-booleans-section-y-neg',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: 4.0, look: 'negative', depth: 5.0 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: false
    }
  },

  // Authored bridge (test/fixtures/authored)
  {
    name: 'bridge-plan',
    fixture: 'test/fixtures/authored/bridge.ifc',
    options: {
      cut: { kind: 'plan', elevation: -0.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: false
    }
  },
  {
    name: 'bridge-section-x-pier1',
    fixture: 'test/fixtures/authored/bridge.ifc',
    options: {
      cut: { kind: 'section', axis: 'x', position: 100.0, look: 'positive', depth: 25.0 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },

  // Four plane cuts (kind: 'plane', backlog C21)
  // 1. Vertical oblique face of the bridge at Pier 2 (station 200, heading 0.25 rad)
  {
    name: 'bridge-plane-oblique-pier2',
    fixture: 'test/fixtures/authored/bridge.ifc',
    options: {
      cut: {
        kind: 'plane',
        origin: [198.961584, 12.435031, -4.0],
        normal: [0.96891242, 0.24740396, 0.0],
        depth: 30.0
      },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  // 2. Tilted plane cutting through the two-storey building
  {
    name: 'building-plane-tilted',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: {
        kind: 'plane',
        origin: [5.0, 4.0, 3.0],
        normal: [0.6, 0.0, -0.8]
      },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  // 3. Plane looking almost straight down whose normal is a few thousandths off -Z (must read like a plan: north up)
  {
    name: 'units-mm-plane-near-horizontal',
    fixture: 'test/fixtures/authored/units-mm-georef.ifc',
    options: {
      cut: {
        kind: 'plane',
        origin: [4.0, 2.5, 1.5],
        normal: [0.003, -0.002, -1.0]
      },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  // 4. Plane looking straight up
  {
    name: 'building-plane-looking-up',
    fixture: 'test/fixtures/authored/building-booleans.ifc',
    options: {
      cut: {
        kind: 'plane',
        origin: [5.0, 4.0, 1.5],
        normal: [0.0, 0.0, 1.0],
        depth: 2.0
      },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },

  // Authored units-mm-georef and map frame (localToMap words)
  {
    name: 'units-mm-georef-plan-project',
    fixture: 'test/fixtures/authored/units-mm-georef.ifc',
    options: {
      cut: { kind: 'plan', elevation: 1.5 },
      frame: { kind: 'project' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'units-mm-georef-plan-map',
    fixture: 'test/fixtures/authored/units-mm-georef.ifc',
    options: {
      cut: { kind: 'plan', elevation: 261.5 },
      frame: { kind: 'map' },
      includeProjection: true,
      includeHiddenLines: true,
      includeHatching: true
    }
  },
  {
    name: 'galicia-georef-section-map',
    fixture: 'test/fixtures/georef-galicia-utm29n.ifc',
    options: {
      cut: { kind: 'section', axis: 'y', position: 4747000.0, look: 'positive' },
      frame: { kind: 'map' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  },
  {
    name: 'geographic-referencing-plan-map',
    fixture: 'test/fixtures/geographic-referencing.ifc',
    options: {
      cut: { kind: 'plan', elevation: 114.2 },
      frame: { kind: 'map' },
      includeProjection: true,
      includeHiddenLines: false,
      includeHatching: true
    }
  }
];

function parseDxf(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const lines = text.split('\r\n');
  let extMin = [0, 0];
  let extMax = [0, 0];
  const layers = {};
  let i = 0;
  let section = '';
  while (i + 1 < lines.length) {
    const code = Number(lines[i].trim());
    const val = lines[i + 1];
    i += 2;
    if (code === 0 && val === 'SECTION' && i + 1 < lines.length && Number(lines[i].trim()) === 2) {
      section = lines[i + 1];
      i += 2;
      continue;
    }
    if (code === 0 && val === 'ENDSEC') {
      section = '';
      continue;
    }
    if (section === 'HEADER' && code === 9 && (val === '$EXTMIN' || val === '$EXTMAX')) {
      let x = 0;
      let y = 0;
      while (i + 1 < lines.length) {
        const c = Number(lines[i].trim());
        if (c === 9 || c === 0) break;
        const v = Number(lines[i + 1].trim());
        if (c === 10) x = v;
        else if (c === 20) y = v;
        i += 2;
      }
      if (val === '$EXTMIN') extMin = [x, y];
      else extMax = [x, y];
    } else if (section === 'ENTITIES' && code === 0 && val === 'LINE') {
      let layer = '0';
      let x0 = 0;
      let y0 = 0;
      let x1 = 0;
      let y1 = 0;
      while (i + 1 < lines.length) {
        const c = Number(lines[i].trim());
        if (c === 0) break;
        const raw = lines[i + 1];
        if (c === 8) layer = raw;
        else if (c === 10) x0 = Number(raw.trim());
        else if (c === 20) y0 = Number(raw.trim());
        else if (c === 11) x1 = Number(raw.trim());
        else if (c === 21) y1 = Number(raw.trim());
        i += 2;
      }
      const length = Math.hypot(x1 - x0, y1 - y0);
      layers[layer] = (layers[layer] ?? 0) + length;
    }
  }
  const roundedLayers = {};
  for (const key of Object.keys(layers).sort()) {
    roundedLayers[key] = Number(layers[key].toFixed(6));
  }
  return {
    extents: [
      Number(extMin[0].toFixed(6)),
      Number(extMin[1].toFixed(6)),
      Number(extMax[0].toFixed(6)),
      Number(extMax[1].toFixed(6))
    ],
    layers: roundedLayers
  };
}

function parseSvg(svgText) {
  const svgElements = {};
  for (const match of svgText.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)\b/g)) {
    const tag = match[1];
    svgElements[tag] = (svgElements[tag] ?? 0) + 1;
  }
  const loops = (svgText.match(/ Z/g) ?? []).length;
  return { svgElements, loops };
}

function buildSummary(svgText, dxfBytes, diagnostics) {
  const { svgElements, loops } = parseSvg(svgText);
  const { extents, layers } = parseDxf(dxfBytes);
  return {
    svgElements,
    loops,
    layers,
    extents,
    diagnostics: diagnostics.map((d) => d.code)
  };
}

function attrValues(svg, attr) {
  return Array.from(svg.matchAll(new RegExp(`\\b${attr}="([^"]*)"`, 'g')), (m) => m[1]);
}

function describeChanges(expectedSummary, actualSummary, expectedSvg, actualSvg) {
  const changes = [];

  const allLayers = new Set([
    ...Object.keys(expectedSummary.layers ?? {}),
    ...Object.keys(actualSummary.layers ?? {})
  ]);
  for (const layer of Array.from(allLayers).sort()) {
    const oldLen = expectedSummary.layers?.[layer];
    const newLen = actualSummary.layers?.[layer];
    if (oldLen === undefined) {
      changes.push(`layer ${layer} added (total length ${newLen.toFixed(3)})`);
    } else if (newLen === undefined) {
      changes.push(`layer ${layer} removed (was ${oldLen.toFixed(3)})`);
    } else if (Math.abs(newLen - oldLen) >= 1e-4) {
      changes.push(`layer ${layer} total length ${oldLen.toFixed(3)} to ${newLen.toFixed(3)}`);
    }
  }

  if (actualSummary.loops !== expectedSummary.loops) {
    const delta = actualSummary.loops - expectedSummary.loops;
    const abs = Math.abs(delta);
    const noun = abs === 1 ? 'loop' : 'loops';
    changes.push(
      delta < 0
        ? `${abs} ${noun} fewer (${expectedSummary.loops} to ${actualSummary.loops})`
        : `${abs} ${noun} more (${expectedSummary.loops} to ${actualSummary.loops})`
    );
  }

  const allTags = new Set([
    ...Object.keys(expectedSummary.svgElements ?? {}),
    ...Object.keys(actualSummary.svgElements ?? {})
  ]);
  for (const tag of Array.from(allTags).sort()) {
    const oldCount = expectedSummary.svgElements?.[tag] ?? 0;
    const newCount = actualSummary.svgElements?.[tag] ?? 0;
    if (oldCount !== newCount) {
      changes.push(`svg <${tag}> ${oldCount} to ${newCount}`);
    }
  }

  const oldExt = expectedSummary.extents ?? [0, 0, 0, 0];
  const newExt = actualSummary.extents ?? [0, 0, 0, 0];
  if (oldExt.some((v, idx) => Math.abs(v - newExt[idx]) >= 1e-4)) {
    const fmt = (arr) => `[${arr.map((n) => n.toFixed(3)).join(', ')}]`;
    changes.push(`extents ${fmt(oldExt)} to ${fmt(newExt)}`);
  }

  const oldDiag = (expectedSummary.diagnostics ?? []).join(', ');
  const newDiag = (actualSummary.diagnostics ?? []).join(', ');
  if (oldDiag !== newDiag) {
    changes.push(`diagnostics [${oldDiag}] to [${newDiag}]`);
  }

  if (expectedSvg !== actualSvg) {
    for (const attr of ['stroke-width', 'stroke-dasharray', 'stroke', 'viewBox']) {
      const oldVals = attrValues(expectedSvg, attr).join(', ');
      const newVals = attrValues(actualSvg, attr).join(', ');
      if (oldVals !== newVals) {
        changes.push(`svg ${attr} "${oldVals}" to "${newVals}"`);
      }
    }
    if (changes.length === 0) {
      changes.push(`svg path coordinates differ (${expectedSvg.length} to ${actualSvg.length} bytes)`);
    }
  }

  return changes;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function writeHtmlReport(entries, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const cards = entries
    .map(({ name, fixture, options, status, changes, oldSvg, newSvg, summary }) => {
      const badgeColor = status === 'PASS' ? '#1b7f37' : status === 'UPDATED' ? '#0969da' : '#cf222e';
      const changeHtml =
        changes.length > 0
          ? `<div class="changes">${changes.map((c) => `<code>${escapeHtml(c)}</code>`).join(' &middot; ')}</div>`
          : '';
      const hasOld = Boolean(oldSvg && oldSvg !== newSvg);
      return `<section class="card" id="${escapeHtml(name)}">
  <header>
    <h2><span class="badge" style="background:${badgeColor}">${escapeHtml(status)}</span> ${escapeHtml(name)}</h2>
    <div class="meta">${escapeHtml(fixture)} &mdash; <code>${escapeHtml(JSON.stringify(options.cut))}</code> &mdash; frame: ${escapeHtml(options.frame.kind)}, proj: ${options.includeProjection}, hidden: ${options.includeHiddenLines}, hatch: ${options.includeHatching}</div>
    <div class="meta">loops: ${summary.loops} &mdash; extents: [${summary.extents.join(', ')}] &mdash; layers: ${escapeHtml(JSON.stringify(summary.layers))} &mdash; diag: [${summary.diagnostics.join(', ')}]</div>
    ${changeHtml}
  </header>
  <div class="side-by-side">
    ${
      hasOld
        ? `<div class="pane"><h3>Reference (old)</h3><div class="svg-box">${oldSvg}</div></div>
           <div class="pane"><h3>Current (new)</h3><div class="svg-box">${newSvg}</div></div>`
        : `<div class="pane full"><h3>SVG (${escapeHtml(name)}.svg)</h3><div class="svg-box">${newSvg}</div></div>`
    }
  </div>
</section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>guBIM 2D Drawing Checks</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #f6f8fa; color: #1f2328; }
  h1 { margin-top: 0; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .card h2 { margin: 0 0 6px 0; font-size: 18px; display: flex; align-items: center; gap: 8px; }
  .badge { color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 4px; }
  .meta { font-size: 13px; color: #57606a; margin-bottom: 4px; word-break: break-all; }
  .changes { margin-top: 8px; padding: 8px; background: #ffebe9; border: 1px solid #ff818266; border-radius: 4px; font-size: 13px; }
  .side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
  .pane.full { grid-column: 1 / -1; }
  .pane h3 { margin: 0 0 6px 0; font-size: 14px; color: #57606a; }
  .svg-box { background: #fff; border: 1px solid #d8dee4; padding: 12px; display: flex; justify-content: center; align-items: center; overflow: auto; }
  .svg-box svg { width: 100%; height: auto; max-height: 460px; }
</style>
</head>
<body>
<h1>guBIM 2D Drawing Regression Report (${entries.length} cases)</h1>
${cards}
</body>
</html>`;

  const htmlPath = join(targetDir, 'index.html');
  writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

// Cache open models by fixture path so multiple cases on the same file do not re-parse STEP.
const modelCache = new Map();
function getModel(fixture) {
  let cached = modelCache.get(fixture);
  if (!cached) {
    const model = new Model(readFileSync(join(root, fixture)));
    const summary = JSON.parse(model.summaryJson());
    cached = { model, summary };
    modelCache.set(fixture, cached);
  }
  return cached;
}

if (update) {
  mkdirSync(refDir, { recursive: true });
}

let failures = 0;
const reportEntries = [];

for (const { name, fixture, options } of CASES) {
  const started = performance.now();
  const { model, summary: modelSummary } = getModel(fixture);
  const framed = frameModels(options.frame, [
    { modelId: name, open: true, reference: modelSummary.coordinateReference }
  ]);
  const localToMap = framed.included[0]?.localToMap;

  const sheet = new Sheet(new Float64Array(drawingRequest(options)));
  model.startDrawing(new Float64Array(drawingRequest(options, localToMap)));
  for (;;) {
    const chunk = model.nextDrawingChunk(MAX_TRIANGLES_PER_CHUNK);
    if (!chunk) break;
    sheet.addChunk(0, chunk);
  }
  const modelDiagnostics = JSON.parse(model.finishDrawing());
  const sheetDiagnostics = JSON.parse(sheet.generate());

  const showHidden = options.includeProjection && options.includeHiddenLines;
  const showHatching = options.includeHatching;
  const svgBytes = sheet.export(true, 1, showHidden, showHatching, undefined);
  const dxfBytes = sheet.export(false, 1, showHidden, showHatching, undefined);
  sheet.free();

  if (!svgBytes || !dxfBytes) {
    console.error(`FAIL ${name}: sheet.export returned undefined`);
    failures += 1;
    continue;
  }

  const actualSvg = new TextDecoder().decode(svgBytes);
  const diagnostics = [...framed.diagnostics, ...modelDiagnostics, ...sheetDiagnostics];
  const actualSummary = buildSummary(actualSvg, dxfBytes, diagnostics);
  const actualSummaryJson = `${JSON.stringify(actualSummary, null, 2)}\n`;

  const svgRefPath = join(refDir, `${name}.svg`);
  const jsonRefPath = join(refDir, `${name}.json`);
  const ms = (performance.now() - started).toFixed(0);
  const totalLen = Object.values(actualSummary.layers).reduce((a, b) => a + b, 0);

  if (update) {
    const oldSvg = existsSync(svgRefPath) ? readFileSync(svgRefPath, 'utf8') : null;
    writeFileSync(svgRefPath, actualSvg, 'utf8');
    writeFileSync(jsonRefPath, actualSummaryJson, 'utf8');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.svg`), actualSvg, 'utf8');
    reportEntries.push({
      name,
      fixture,
      options,
      status: 'UPDATED',
      changes: [],
      oldSvg,
      newSvg: actualSvg,
      summary: actualSummary
    });
    console.log(
      `UPD  ${name.padEnd(34)} ${String(actualSummary.loops).padStart(4)} loops ` +
        `${String(Object.keys(actualSummary.layers).length).padStart(2)} layers ` +
        `${totalLen.toFixed(2).padStart(9)} m ${ms.padStart(4)} ms`
    );
    continue;
  }

  if (!existsSync(svgRefPath) || !existsSync(jsonRefPath)) {
    console.error(`FAIL ${name}: missing reference in test/drawings/ref/ (run with --update)`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.svg`), actualSvg, 'utf8');
    reportEntries.push({
      name,
      fixture,
      options,
      status: 'FAIL',
      changes: ['missing reference file'],
      oldSvg: null,
      newSvg: actualSvg,
      summary: actualSummary
    });
    failures += 1;
    continue;
  }

  const expectedSvg = readFileSync(svgRefPath, 'utf8');
  const expectedSummary = JSON.parse(readFileSync(jsonRefPath, 'utf8'));
  const svgSame = actualSvg === expectedSvg;
  const changes = describeChanges(expectedSummary, actualSummary, expectedSvg, actualSvg);

  if (!svgSame || changes.length > 0) {
    const detail = changes.length > 0 ? changes.join(', ') : 'svg text differs';
    console.error(`FAIL ${name}: ${detail}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.svg`), actualSvg, 'utf8');
    reportEntries.push({
      name,
      fixture,
      options,
      status: 'FAIL',
      changes,
      oldSvg: expectedSvg,
      newSvg: actualSvg,
      summary: actualSummary
    });
    failures += 1;
  } else {
    console.log(
      `PASS ${name.padEnd(34)} ${String(actualSummary.loops).padStart(4)} loops ` +
        `${String(Object.keys(actualSummary.layers).length).padStart(2)} layers ` +
        `${totalLen.toFixed(2).padStart(9)} m ${ms.padStart(4)} ms`
    );
  }
}

for (const { model } of modelCache.values()) {
  // Keep cached models open until C15 checks finish below.
  void model;
}

// ---------- C15 checks (T-166): space labels, overall dimensions, vector PDF ----------
function extractSvgTexts(svgText) {
  return Array.from(svgText.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g), (m) => m[1]);
}

function extractDxfDimensionTexts(dxfBytes) {
  const lines = new TextDecoder('latin1').decode(dxfBytes).split('\r\n');
  const dims = [];
  let inEntities = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    const val = lines[i + 1];
    if (code === 0 && val === 'SECTION' && lines[i + 3] === 'ENTITIES') {
      inEntities = true;
      i += 2;
      continue;
    }
    if (code === 0 && val === 'ENDSEC') {
      inEntities = false;
      continue;
    }
    if (inEntities && code === 0 && val === 'DIMENSION') {
      let layer = '';
      let text = '';
      let block = '';
      let j = i + 2;
      while (j + 1 < lines.length && Number(lines[j].trim()) !== 0) {
        const c = Number(lines[j].trim());
        const v = lines[j + 1];
        if (c === 8) layer = v;
        else if (c === 1) text = v;
        else if (c === 2) block = v;
        j += 2;
      }
      dims.push({ layer, text, block });
    }
  }
  return dims;
}

function generateAnnotatedPlan(fixture, elevation, extra = {}) {
  const { model } = getModel(fixture);
  const options = {
    cut: { kind: 'plan', elevation },
    frame: { kind: 'project' },
    includeProjection: false,
    includeHiddenLines: false,
    includeHatching: false,
    ...extra
  };
  const sheet = new Sheet(new Float64Array(drawingRequest(options)));
  model.startDrawing(new Float64Array(drawingRequest(options)));
  for (;;) {
    const chunk = model.nextDrawingChunk(MAX_TRIANGLES_PER_CHUNK);
    if (!chunk) break;
    sheet.addChunk(0, chunk);
  }
  model.finishDrawing();
  sheet.generate();
  const svgBytes = sheet.export(true, 1, false, false, undefined);
  const dxfBytes = sheet.export(false, 1, false, false, undefined);
  sheet.free();
  return {
    svg: new TextDecoder().decode(svgBytes),
    dxfBytes
  };
}

let c15Checks = 0;
function checkC15(name, fn) {
  c15Checks += 1;
  try {
    const detail = fn();
    console.log(`PASS ${name.padEnd(34)} ${detail}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!update) {
  const expectedBb = JSON.parse(
    readFileSync(join(root, 'test/fixtures/authored/building-booleans.expected.json'), 'utf8')
  );
  const bbL1 = generateAnnotatedPlan('test/fixtures/authored/building-booleans.ifc', 1.5, {
    includeSpaceLabels: true,
    includeDimensions: true
  });
  const bbL2 = generateAnnotatedPlan('test/fixtures/authored/building-booleans.ifc', 4.8, {
    includeSpaceLabels: true,
    includeDimensions: false
  });

  // Independent space calculation from building-booleans.expected.json:
  // outer walls sit on [0..10] x [0..8] with 0.30 m thickness -> clear internal box is
  // [0.30..9.70] x [0.30..7.70] = 9.40 m x 7.40 m = 69.56 m² per storey, 2 IfcSpace total.
  checkC15('c15-space-labels-building-booleans', () => {
    const expectedTotalSpaces = expectedBb.counts.IfcSpace.value;
    const expectedSpace1 = expectedBb.elements.spaces[0];
    const clearW = expectedSpace1.bbox.x_max.value - expectedSpace1.bbox.x_min.value;
    const clearH = expectedSpace1.bbox.y_max.value - expectedSpace1.bbox.y_min.value;
    const independentArea = clearW * clearH;

    const l1Texts = extractSvgTexts(bbL1.svg);
    const l2Texts = extractSvgTexts(bbL2.svg);
    const l1Areas = l1Texts.filter((s) => s.endsWith(' m²'));
    const l2Areas = l2Texts.filter((s) => s.endsWith(' m²'));
    const totalCutSpaces = l1Areas.length + l2Areas.length;
    if (totalCutSpaces !== expectedTotalSpaces) {
      throw new Error(`expected ${expectedTotalSpaces} spaces across L1+L2, got ${totalCutSpaces}`);
    }
    if (!l1Texts.includes(expectedSpace1.name)) {
      throw new Error(`missing space name "${expectedSpace1.name}" in SVG texts: ${JSON.stringify(l1Texts)}`);
    }
    const parsedArea = parseFloat(l1Areas[0]);
    if (!Number.isFinite(parsedArea) || Math.abs(parsedArea - independentArea) > 0.01) {
      throw new Error(
        `area ${l1Areas[0]} differs by more than 0.01 m² from independent ${independentArea.toFixed(4)} m²`
      );
    }
    const dxfLatin1 = new TextDecoder('latin1').decode(bbL1.dxfBytes);
    if (!dxfLatin1.includes('SPACES\r\n') || !dxfLatin1.includes(`${expectedSpace1.name}\r\n`)) {
      throw new Error('DXF missing SPACES layer or space name TEXT entity');
    }
    if (!dxfLatin1.includes('69.56 m\u00b2\r\n')) {
      throw new Error('DXF missing CP1252 "69.56 m²" TEXT entity');
    }
    return `spaces=${totalCutSpaces} (L1:${l1Areas.length}, L2:${l2Areas.length}) "${expectedSpace1.name}"=${parsedArea.toFixed(2)} m² (expected ${independentArea.toFixed(2)} m²)`;
  });

  const duplexFixture = 'test/models/bench/Duplex_A_20110907.ifc';
  if (existsSync(join(root, duplexFixture))) {
    checkC15('c15-space-labels-duplex-quantity', () => {
      // Independent check directly from STEP text: locate IfcSpace ('A101' / 'Foyer'), follow
      // IFCRELDEFINESBYPROPERTIES -> IFCELEMENTQUANTITY -> IFCQUANTITYAREA.
      const stepText = readFileSync(join(root, duplexFixture), 'utf8');
      const spaceMatch = /^#(\d+)\s*=\s*IFCSPACE\([^;]*'A101'[^;]*'Foyer'[^;]*\);/m.exec(stepText);
      if (!spaceMatch) throw new Error('could not locate IfcSpace A101 Foyer in Duplex STEP');
      const spaceId = spaceMatch[1];
      let expectedArea = null;
      for (const rel of stepText.matchAll(/IFCRELDEFINESBYPROPERTIES\([^;]*\(([^()]*)\)\s*,\s*#(\d+)\s*\);/g)) {
        const targets = rel[1].split(',').map((s) => s.trim());
        if (!targets.includes(`#${spaceId}`)) continue;
        const defRe = new RegExp(`^#${rel[2]}\\s*=\\s*IFCELEMENTQUANTITY\\([^;]*\\(([^()]*)\\)\\s*\\);`, 'm');
        const defMatch = defRe.exec(stepText);
        if (!defMatch) continue;
        for (const qRef of defMatch[1].split(',').map((s) => s.trim().replace(/^#/, ''))) {
          const qRe = new RegExp(`^#${qRef}\\s*=\\s*IFCQUANTITYAREA\\([^,]*,[^,]*,[^,]*,\\s*([0-9.]+)`, 'm');
          const qMatch = qRe.exec(stepText);
          if (qMatch) {
            expectedArea = Number(qMatch[1]);
            break;
          }
        }
        if (expectedArea !== null) break;
      }
      if (expectedArea === null) throw new Error(`could not locate IFCQUANTITYAREA for #${spaceId} in Duplex STEP`);
      const duplexPlan = generateAnnotatedPlan(duplexFixture, 1.5, {
        includeSpaceLabels: true,
        includeDimensions: false
      });
      const texts = extractSvgTexts(duplexPlan.svg);
      const areaLabels = texts.filter((s) => s.endsWith(' m²'));
      if (areaLabels.length < 10) {
        throw new Error(`expected >= 10 ground-floor spaces in Duplex, got ${areaLabels.length}`);
      }
      const foyerIdx = texts.indexOf('A101 Foyer');
      if (foyerIdx < 0) throw new Error('missing "A101 Foyer" in Duplex SVG');
      const gotArea = parseFloat(texts[foyerIdx + 1] ?? '');
      if (!Number.isFinite(gotArea) || Math.abs(gotArea - expectedArea) > 0.01) {
        throw new Error(`A101 Foyer area ${gotArea} differs from STEP IfcQuantityArea ${expectedArea}`);
      }
      return `spaces=${areaLabels.length} "A101 Foyer"=${gotArea.toFixed(2)} m² (STEP #${spaceId} ${expectedArea.toFixed(4)} m²)`;
    });
  }

  checkC15('c15-overall-dimensions-bbox', () => {
    const walls = expectedBb.elements.walls;
    const minX = Math.min(...walls.map((w) => w.bbox.x_min.value));
    const maxX = Math.max(...walls.map((w) => w.bbox.x_max.value));
    const minY = Math.min(...walls.map((w) => w.bbox.y_min.value));
    const maxY = Math.max(...walls.map((w) => w.bbox.y_max.value));
    const wantW = `${(maxX - minX).toFixed(2)} m`;
    const wantH = `${(maxY - minY).toFixed(2)} m`;

    const svgTexts = extractSvgTexts(bbL1.svg);
    if (!bbL1.svg.includes('<line ')) throw new Error('SVG missing <line> elements for dimensions');
    if (!svgTexts.includes(wantW) || !svgTexts.includes(wantH)) {
      throw new Error(`SVG missing expected dimensions ${wantW} / ${wantH}, got ${JSON.stringify(svgTexts)}`);
    }
    const dxfDims = extractDxfDimensionTexts(bbL1.dxfBytes);
    if (dxfDims.length !== 2) {
      throw new Error(`expected 2 DXF DIMENSION entities, got ${dxfDims.length}`);
    }
    const dimTexts = dxfDims.map((d) => d.text);
    if (!dimTexts.includes(wantW) || !dimTexts.includes(wantH)) {
      throw new Error(`DXF DIMENSION texts ${JSON.stringify(dimTexts)} do not match ${wantW}, ${wantH}`);
    }
    const dxfLatin1 = new TextDecoder('latin1').decode(bbL1.dxfBytes);
    if (!dxfLatin1.includes('*D0\r\n') || !dxfLatin1.includes('*D1\r\n')) {
      throw new Error('DXF missing *D0 / *D1 dimension blocks');
    }
    return `SVG & DXF DIMENSION = ${wantW} x ${wantH} (blocks ${dxfDims.map((d) => d.block).join(', ')})`;
  });

  checkC15('c15-pdf-vector-a4-and-a3', () => {
    const results = [];
    for (const [paper, scale] of [
      ['A4', 100],
      ['A3', 50]
    ]) {
      const pdfBytes = svgToPdf(bbL1.svg, {
        scale,
        paper,
        title: 'building-booleans-plan',
        footerLabel: `Escala 1:${scale} · ${paper} horizontal`
      });
      const parsed = inspectPdf(pdfBytes);
      if (!parsed.hasPdfHeader) throw new Error(`${paper}: missing %PDF- header (${parsed.header})`);
      if (!parsed.hasXref || !parsed.xrefValid) throw new Error(`${paper}: invalid or missing xref table`);
      if (!parsed.hasEof) throw new Error(`${paper}: missing %%EOF`);
      if (!parsed.mediaBox) throw new Error(`${paper}: missing /MediaBox`);
      const want = paperSizePt(paper);
      if (
        Math.abs(parsed.mediaBox[2] - want.widthPt) > 0.05 ||
        Math.abs(parsed.mediaBox[3] - want.heightPt) > 0.05
      ) {
        throw new Error(
          `${paper}: MediaBox ${parsed.mediaBox.join(' ')} does not match ${want.widthPt.toFixed(2)}x${want.heightPt.toFixed(2)} pt`
        );
      }
      if (!parsed.contentStream.includes('(guBIM space 1) Tj')) {
        throw new Error(`${paper}: missing space label in PDF stream`);
      }
      if (!parsed.contentStream.includes('(10.00 m) Tj') || !parsed.contentStream.includes('(8.00 m) Tj')) {
        throw new Error(`${paper}: missing overall dimensions in PDF stream`);
      }
      results.push(`${paper} 1:${scale} (${parsed.mediaBox[2].toFixed(1)}x${parsed.mediaBox[3].toFixed(1)} pt, ${pdfBytes.length} B)`);
    }
    return results.join('; ');
  });
}

for (const { model } of modelCache.values()) {
  model.free();
}

if (reportEntries.length > 0) {
  const htmlPath = writeHtmlReport(reportEntries, outDir);
  console.log(`HTML report written to ${htmlPath}`);
}

const totalChecks = CASES.length + c15Checks;
console.log(
  failures === 0
    ? update
      ? `updated all ${CASES.length} drawing references`
      : `all ${CASES.length} drawing cases + ${c15Checks} C15 checks (${totalChecks} total) pass`
    : `${failures} of ${totalChecks} drawing checks failed`
);
process.exit(failures === 0 ? 0 : 1);
