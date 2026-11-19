// GPU time per frame for one model in the real app (backlog A11, docs/09 section 5). Starts Vite
// on this tree, opens the model through the file input in headless Chrome on one backend, frames
// it in the iso view and renders the same frame N times:
//   - WebGL2: GPU time from EXT_disjoint_timer_query_webgl2 around each frame;
//   - WebGPU: time from the frame's start to queue.onSubmittedWorkDone, CPU encoding included,
//     since the device is not created with timestamp-query.
// Prints the median and quartiles. To compare formats, run it with each kernel package in
// src/infrastructure/kernel/pkg.
//
//   node scripts/bench/frame-time.mjs <gpu|gl2> <file.ifc> [--frames 60] [--port 5180] [--out <dir>]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from '../../test/e2e/cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const [mode, file] = args;
const FRAMES = Number(opt('--frames', 60));
const PORT = Number(opt('--port', 5180));
const OUT = opt('--out', path.join(os.tmpdir(), 'gubim-frame-time'));
if (!['gpu', 'gl2'].includes(mode) || !file) {
  console.error('usage: frame-time.mjs <gpu|gl2> <file.ifc> [--frames 60]');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = `http://127.0.0.1:${PORT}/`;

const vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
const stop = () => { try { vite.kill(); } catch {} };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 300 && !up; i++) {
  try { up = (await fetch(BASE)).ok; } catch {}
  if (!up) await sleep(200);
}
if (!up) { console.error('Vite did not start'); process.exit(1); }

const { proc, wsUrl } = await launch({ port: 9350 + (mode === 'gpu' ? 1 : 2), profileDir: path.join(OUT, `profile-${mode}`) });
const cdp = await connect(wsUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await applyMode(cdp.send, mode);
const ev = cdp.evaluate;
async function waitFor(expr, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await ev(expr); if (v) return v; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + expr);
}

try {
  await cdp.send('Page.navigate', { url: BASE });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(file)] });
  await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length === 1`);
  // Settled: no new records for 2 s, so every batch is on the GPU.
  let last = -1, since = Date.now();
  while (Date.now() - since < 2000) {
    const s = await ev('window.__gubim_dev__.activeRenderer.getDebugStats().recordCount');
    if (s !== last) { last = s; since = Date.now(); }
    await sleep(200);
  }
  const result = await ev(`(async () => {
    const R = window.__gubim_dev__.activeRenderer;
    R.fitToView();
    R.setViewPreset('iso');
    const stats = R.getDebugStats();
    const formats = {};
    for (const m of R.models.values()) for (const b of m.batches) formats[b.vertexFormat] = (formats[b.vertexFormat] ?? 0) + 1;
    const times = [];
    const settle = () => new Promise((res) => setTimeout(res, 4));
    if (R.gl) {
      const gl = R.gl;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };
      for (let i = 0; i < ${FRAMES} + 5; i++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        R.renderFrame();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.flush();
        while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await settle();
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (!disjoint && i >= 5) times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      return { backend: 'WebGL2, timer query', times, formats, stats };
    }
    for (let i = 0; i < ${FRAMES} + 5; i++) {
      await R.device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      R.renderFrame();
      await R.device.queue.onSubmittedWorkDone();
      if (i >= 5) times.push(performance.now() - t0);
    }
    return { backend: 'WebGPU, start to onSubmittedWorkDone', times, formats, stats };
  })()`);
  if (result.error) throw new Error(result.error);
  const sorted = [...result.times].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(JSON.stringify({
    model: path.basename(file),
    backend: result.backend,
    batches: result.formats,
    gpuBytes: result.stats.allocatedGpuBytes,
    frames: sorted.length,
    p25: +q(0.25).toFixed(2),
    median: +q(0.5).toFixed(2),
    p75: +q(0.75).toFixed(2)
  }));
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  try { proc.kill(); } catch {}
  stop();
}
process.exit(0);
