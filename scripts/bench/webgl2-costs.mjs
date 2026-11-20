// What backlog A15 and A16 could save on WebGL2, measured in the real app (docs/06, Prio. 4).
//   A15: how long a pick blocks the main thread (before A15, a synchronous 1-pixel readPixels;
//        since, the pass and a readPixels into a pack buffer) and how long its answer takes. Per pick,
//        with the GPU idle and right after a frame was submitted (hovering while the view redraws).
//   A16: per-batch uniforms (offset, record base, model visibility, q16 grid). Calls per frame,
//        the cost of one call, and the frame's CPU time and GPU time (timer query) for scale.
// Starts Vite on this tree and headless Chrome on WebGL2, opens the models through the file input.
//
//   node scripts/bench/webgl2-costs.mjs <file.ifc>... [--port 5181] [--out <dir>]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from '../../test/e2e/cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const files = args.filter((a, i) => !a.startsWith('--') && !['--port', '--out'].includes(args[i - 1]));
const PORT = Number(opt('--port', 5181));
const OUT = opt('--out', path.join(os.tmpdir(), 'gubim-webgl2-costs'));
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

const { proc, wsUrl } = await launch({ port: 9361, profileDir: path.join(OUT, 'profile') });
const cdp = await connect(wsUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await applyMode(cdp.send, 'gl2');
const ev = cdp.evaluate;
async function waitFor(expr, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await ev(expr); if (v) return v; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + expr);
}

const MEASURE = String.raw`(async () => {
  const R = window.__gubim_dev__.activeRenderer;
  const gl = R.gl;
  if (!gl) return { error: 'not WebGL2' };
  R.fitToView();
  R.setViewPreset('iso');
  const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, median: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +s[s.length - 1].toFixed(3) }; };
  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
  for (let i = 0; i < 5; i++) { R.renderFrame(); await frame(); }

  // ---- A16: uniform calls per frame and their cost ----
  const names = ['uniform1i', 'uniform1ui', 'uniform3f', 'uniform4fv', 'uniformMatrix4fv'];
  const orig = {};
  const counts = {};
  for (const n of names) { orig[n] = gl[n].bind(gl); counts[n] = 0; gl[n] = (...a) => { counts[n]++; return orig[n](...a); }; }
  R.renderFrame();
  for (const n of names) gl[n] = orig[n];
  gl.finish();
  const cpu = [];
  for (let i = 0; i < 60; i++) { const t = performance.now(); R.renderFrame(); cpu.push(performance.now() - t); gl.finish(); await frame(); }
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpu = [];
  if (ext) for (let i = 0; i < 30; i++) {
    const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); R.renderFrame(); gl.endQuery(ext.TIME_ELAPSED_EXT); gl.flush();
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await new Promise((r) => setTimeout(r, 2));
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  // One uniform3f call, as the renderer makes it: the main program bound, a real location.
  const program = R.mainProgram;
  gl.useProgram(program);
  R.boundProgram = program;
  const loc = R.mainUniforms.u_batchOffset;
  const N = 200000;
  let t = performance.now();
  for (let i = 0; i < N; i++) gl.uniform3f(loc, i * 1e-3, 1, 2);
  const uniformNs = ((performance.now() - t) / N) * 1e6;
  gl.finish();
  const batches = [...R.models.values()].reduce((n, m) => n + m.batches.length, 0);

  // ---- A15: how long one pick blocks, and the readPixels share ----
  const rp = gl.readPixels.bind(gl);
  let readMs = 0;
  gl.readPixels = (...a) => { const s = performance.now(); rp(...a); readMs += performance.now() - s; };
  const c = document.querySelector('canvas.bim-viewport').getBoundingClientRect();
  const points = [];
  for (let fy = 0.2; fy < 0.85; fy += 0.13) for (let fx = 0.2; fx < 0.85; fx += 0.13) points.push([c.width * fx, c.height * fy]);
  const pickRun = async (afterFrame) => {
    const total = [], read = [], latency = [];
    let hits = 0;
    for (const [x, y] of points) {
      await frame();
      if (afterFrame) R.renderFrame(); else gl.finish();
      readMs = 0;
      const s = performance.now();
      // Since A15 pickOnce is asynchronous: time the part that blocks, then the wait for the answer.
      const pending = R.pickOnce(x, y);
      total.push(performance.now() - s);
      read.push(readMs);
      const hit = await pending;
      latency.push(performance.now() - s);
      if (hit.ref) hits++;
    }
    return { pick: stats(total), readPixels: stats(read), answer: stats(latency), hits };
  };
  const idle = await pickRun(false);
  const busy = await pickRun(true);
  gl.readPixels = rp;
  return {
    batches,
    uniformCallsPerFrame: counts,
    uniformCallNs: +uniformNs.toFixed(1),
    frameCpuMs: stats(cpu),
    frameGpuMs: gpu.length ? stats(gpu) : null,
    pickIdleGpu: idle,
    pickAfterFrame: busy
  };
})()`;

try {
  await cdp.send('Page.navigate', { url: BASE });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  for (const file of files) {
    // One model at a time: remove the previous one.
    await ev(`(() => { const R = window.__gubim_dev__.renderer; for (const id of [...window.__gubim_dev__.activeRenderer.models.keys()]) R.removeModel(id); return true; })()`);
    await ev(`[...document.querySelectorAll('.model-card button[title*=liminar], .model-card button[aria-label*=liminar]')].forEach((b) => b.click()); true`);
    const before = await ev(`document.querySelectorAll('.model-card').length`);
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(file)] });
    await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length >= ${before + 1}`);
    let last = -1, since = Date.now();
    while (Date.now() - since < 2000) {
      const s = await ev('window.__gubim_dev__.activeRenderer.getDebugStats().recordCount');
      if (s !== last) { last = s; since = Date.now(); }
      await sleep(200);
    }
    const result = await ev(MEASURE);
    console.log(JSON.stringify({ model: path.basename(file), ...result }));
  }
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  try { proc.kill(); } catch {}
  stop();
}
process.exit(0);
