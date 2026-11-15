// Do two kernel builds give the same bytes? For optimisations that must not change the output.
// usage: node --experimental-strip-types scripts/bench/check-identical.mjs <basePkgDir> [<headPkgDir>] [--extra file.ifc ...]
// Streams every committed fixture and the stress models (from scripts/bench/bench.mjs's work
// folder, if present) through both builds, each in its own process, and compares a SHA-256 of
// every batch's positions, normals, indices and mesh table, plus a hatched plan's SVG and DXF.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

if (process.argv[2] === '--child') {
  // One build, one file: print the hashes.
  const [, , , pkgDir, file] = process.argv;
  const { drawingRequest } = await import(pathToFileURL(path.join(REPO, 'src/infrastructure/kernel/drawingRequest.ts')).href);
  const { initSync, Model, Sheet } = await import(pathToFileURL(path.join(pkgDir, 'wasm_api.js')).href);
  initSync({ module: readFileSync(path.join(pkgDir, 'wasm_api_bg.wasm')) });
  const stream = createHash('sha256');
  const model = new Model(readFileSync(file));
  model.startStream();
  for (;;) {
    const view = model.nextBatch(65536);
    if (!view) break;
    for (const part of [view.takePositions(), view.takeNormals(), view.takeIndices(), view.takeMeshTable(), view.origin()]) {
      stream.update(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    }
    view.free();
  }
  const finished = model.finishStream();
  stream.update(finished);
  // The model's bounds come with the end of the stream: cut the plan at mid-height.
  const bounds = JSON.parse(finished).bounds;
  const z = bounds ? (bounds.min.z + bounds.max.z) / 2 : 1;
  const request = drawingRequest({ cut: { kind: 'plan', elevation: z }, frame: { kind: 'project' }, includeProjection: true, includeHiddenLines: true, includeHatching: true });
  model.startDrawing(new Float64Array(request));
  const sheet = new Sheet(new Float64Array(request));
  for (;;) {
    const chunk = model.nextDrawingChunk(65536);
    if (!chunk) break;
    sheet.addChunk(0, chunk);
  }
  model.finishDrawing();
  const drawing = createHash('sha256');
  drawing.update(sheet.generate());
  for (const svg of [true, false]) drawing.update(sheet.export(svg, 1, true, true, null) ?? new Uint8Array());
  console.log(JSON.stringify({ stream: stream.digest('hex'), drawing: drawing.digest('hex') }));
  process.exit(0);
}

const args = process.argv.slice(2);
const extras = args.flatMap((a, i) => (a === '--extra' ? [args[i + 1]] : []));
const pkgs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--extra');
const basePkg = path.resolve(pkgs[0]);
const headPkg = path.resolve(pkgs[1] ?? path.join(REPO, 'src/infrastructure/kernel/pkg'));
const ifcIn = (dir) => readdirSync(path.join(REPO, dir)).filter((f) => f.toLowerCase().endsWith('.ifc')).sort().map((f) => path.join(REPO, dir, f));
const work = path.join(os.tmpdir(), 'gubim-bench');
const files = [
  ...ifcIn('public/samples'), ...ifcIn('test/fixtures'), ...ifcIn('test/fixtures/authored'),
  ...['stress-5000.ifc', 'stress-20000.ifc'].map((f) => path.join(work, f)).filter(existsSync),
  ...extras.map((f) => path.resolve(f))
];
const run = (pkg, file) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--child', pkg, file], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) return { error: r.stderr.trim().split('\n').slice(-3).join(' ') };
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
let differ = 0;
for (const file of files) {
  const a = run(basePkg, file), b = run(headPkg, file);
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) differ++;
  const what = same ? 'same' : a.error || b.error ? `error: ${a.error ?? b.error}` : [a.stream !== b.stream && 'stream', a.drawing !== b.drawing && 'drawing'].filter(Boolean).join(' and ') + ' differ';
  console.log(`${same ? 'SAME' : 'DIFF'} ${path.relative(REPO, file).replace(/\\/g, '/').padEnd(52)} ${what}`);
}
console.log(differ ? `\n${differ} of ${files.length} files differ` : `\nall ${files.length} files identical`);
process.exit(differ ? 1 : 0);
