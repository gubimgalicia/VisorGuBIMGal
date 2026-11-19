// GPU memory a model's stream takes in the renderers, for one or two kernel builds (backlog A11,
// docs/09 section 1): vertex buffers as sent, a 4-byte record index per vertex where the batch is
// f32 (q16 carries it in the position), index buffers padded to 4 bytes as WebGPU needs, and 16
// bytes per record in the record table. Also counts batches by format.
//
//   node --experimental-strip-types scripts/bench/gpu-bytes.mjs <pkg> [<pkg2>] <file.ifc>...
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeBatch } from '../lib/take-batch.mjs';

const args = process.argv.slice(2);
const pkgs = args.filter((a) => { try { return statSync(a).isDirectory(); } catch { return false; } });
const files = args.filter((a) => !pkgs.includes(a));

async function load(pkg) {
  const url = pathToFileURL(path.join(path.resolve(pkg), 'wasm_api.js')).href + `?build=${encodeURIComponent(pkg)}`;
  const mod = await import(url);
  mod.initSync({ module: readFileSync(path.join(path.resolve(pkg), 'wasm_api_bg.wasm')) });
  return mod;
}

function measure(mod, bytes) {
  const model = new mod.Model(bytes);
  model.startStream();
  const total = { bytes: 0, q16: 0, f32: 0, triangles: 0 };
  for (;;) {
    const view = model.nextBatch(65536);
    if (!view) break;
    const b = takeBatch(view);
    const q16 = b.vertexFormat === 'q16';
    const vertices = q16 ? b.positions.length / 4 : b.positions.length / 3;
    total.bytes += b.positions.byteLength + b.normals.byteLength + (q16 ? 0 : 4 * vertices);
    total.bytes += (b.indices.byteLength + 3) & ~3;
    total.bytes += 16 * (b.meshTable.length / 7);
    total[q16 ? 'q16' : 'f32'] += 1;
    total.triangles += b.indices.length / 3;
  }
  model.finishStream();
  model.free();
  return total;
}

const mods = await Promise.all(pkgs.map(load));
const mb = (n) => (n / 1e6).toFixed(1);
console.log(`| Model | Triangles | ${pkgs.map((p) => path.basename(p)).join(' | ')} | Batches q16 / f32 (last) |`);
console.log(`|---|---|${pkgs.map(() => '---|').join('')}---|`);
for (const file of files) {
  const bytes = readFileSync(file);
  const results = mods.map((mod) => measure(mod, bytes));
  const last = results.at(-1);
  const cells = results.map((r, i) => (i === 0 ? `${mb(r.bytes)} MB` : `${mb(r.bytes)} MB (${((r.bytes / results[0].bytes - 1) * 100).toFixed(1)} %)`));
  console.log(`| ${path.basename(file)} | ${last.triangles} | ${cells.join(' | ')} | ${last.q16} / ${last.f32} |`);
}
