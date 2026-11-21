// Browser check for T-153 (A11): both vertex formats and both index widths draw and pick on each
// backend. One model whose batch is q16 with 16-bit indices, one f32 with 32-bit indices, one f32
// with 16-bit indices, all open at once, so WebGL2 switches programs and vertex arrays between
// batches. For each model shown alone: the renderer holds its batch in the format the kernel sent,
// the model draws (pixels other than the background) and a pick finds one of its elements.
// Usage: node formats-check.mjs <gpu|gl2|none> <baseUrl> <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODELS = [
  { file: 'public/samples/SimpleWall.ifc', vertexFormat: 'q16', indexBytes: 2 },
  { file: 'test/fixtures/bspline-surface.ifc', vertexFormat: 'f32', indexBytes: 4 },
  { file: 'test/fixtures/ifc4x3-infra-road.ifc', vertexFormat: 'f32', indexBytes: 2 }
];

const results = [];
const check = (id, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`);
};

const { proc, wsUrl } = await launch({ port: 9330 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9), profileDir: path.resolve(outDir, `profile-fmt-${mode}`) });
const cdp = await connect(wsUrl);
const errors = [];
cdp.on('Runtime.consoleAPICalled', (p) => p.type === 'error' && errors.push(p.args.map((a) => a.value ?? a.description).join(' ')));
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry;
  if (e.level !== 'error' && e.level !== 'warning') return;
  let local = true;
  try { const h = new URL(e.url ?? '').hostname; local = !h || h === '127.0.0.1' || h === 'localhost'; } catch {}
  if (e.source === 'network' && (!local || /favicon\.ico$/.test(e.url ?? ''))) return;
  // A GL driver's performance note (Mesa on CI: «GPU stall due to ReadPixels») is advice.
  if (e.level === 'warning' && /GL Driver Message \([^,]*, Performance,/.test(e.text)) return;
  errors.push(`log ${e.level}: ${e.text.slice(0, 300)}${e.url ? ' ' + e.url : ''}`);
});
await cdp.send('Log.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await applyMode(cdp.send, mode);
const ev = cdp.evaluate;
async function waitFor(expr, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await ev(expr); if (v) return v; } catch {}
    await sleep(100);
  }
  throw new Error('timeout ' + expr);
}
const frames = (n) => ev(`new Promise((res) => { let i = 0; const f = () => (++i >= ${n} ? res(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);

/**
 * The canvas alone, with the UI that floats over it hidden as tc.mjs does, saved to `file`, and
 * the fraction of its pixels that differ from the background colour (0.06, 0.07, 0.09).
 */
async function canvasLit(file) {
  await ev(`(() => { let s = document.getElementById('__fmt_hide'); if (!s) { s = document.createElement('style'); s.id = '__fmt_hide'; document.head.appendChild(s); } s.textContent = 'body * { visibility: hidden !important; transition: none !important; animation: none !important; } canvas.bim-viewport { visibility: visible !important; }'; return true; })()`);
  await frames(4);
  const r = await ev(`(() => { const b = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  await ev(`document.getElementById('__fmt_hide').textContent = ''`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return ev(`(async () => {
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,${data}'; });
    const k = document.createElement('canvas'); k.width = img.width; k.height = img.height;
    const g = k.getContext('2d'); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, k.width, k.height).data;
    let lit = 0;
    for (let p = 0; p < px.length; p += 4) if (Math.abs(px[p] - 15) + Math.abs(px[p + 1] - 18) + Math.abs(px[p + 2] - 23) > 30) lit++;
    return lit / (px.length / 4);
  })()`);
}

try {
  await cdp.send('Page.navigate', { url: base });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  for (let i = 0; i < MODELS.length; i++) {
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(REPO, MODELS[i].file)] });
    await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length === ${i + 1}`);
  }
  await sleep(1500);

  // Model ids in open order, and what each holds on the GPU side.
  const held = await ev(`(() => {
    const R = window.__gubim_dev__.activeRenderer;
    return [...R.models.entries()].map(([id, m]) => ({
      id,
      batches: m.batches.map((b) => ({ vertexFormat: b.vertexFormat, indexBytes: b.indexBytes ?? (b.indexFormat === 'uint16' ? 2 : 4) })),
      bounds: m.bounds
    }));
  })()`);
  check('F0 three models held', held.length === MODELS.length, held.map((m) => m.batches));

  for (let i = 0; i < MODELS.length && i < held.length; i++) {
    const want = MODELS[i];
    const model = held[i];
    const name = path.basename(want.file);
    check(`F1 ${name} held as ${want.vertexFormat}, ${want.indexBytes * 8}-bit indices`,
      model.batches.length > 0 && model.batches.every((b) => b.vertexFormat === want.vertexFormat && b.indexBytes === want.indexBytes),
      model.batches);

    // Only this model, framed.
    await ev(`(() => {
      const R = window.__gubim_dev__.renderer;
      ${JSON.stringify(held.map((m) => m.id))}.forEach((id) => R.setModelVisibility(id, id === ${JSON.stringify(model.id)}));
      const b = ${JSON.stringify(model.bounds)};
      R.fitToBounds({ min: { x: b.minX, y: b.minY, z: b.minZ }, max: { x: b.maxX, y: b.maxY, z: b.maxZ } });
      R.setViewPreset('iso');
      return true;
    })()`);
    await frames(6);

    const png = path.join(outDir, `fmt-${mode}-${i}-${name}.png`);
    const drawn = await canvasLit(png);
    check(`F2 ${name} draws`, drawn > 0.002, { litFraction: drawn, screenshot: png });

    // Picked: a grid over the canvas finds an element of this model.
    const hit = await ev(`(async () => {
      const R = window.__gubim_dev__.renderer;
      const c = document.querySelector('canvas.bim-viewport').getBoundingClientRect();
      for (let fy = 0.1; fy < 0.95; fy += 0.05) for (let fx = 0.1; fx < 0.95; fx += 0.05) {
        const ref = await R.pick(c.width * fx, c.height * fy);
        if (ref) return ref;
      }
      return null;
    })()`);
    check(`F3 ${name} picks one of its own elements`, !!hit && hit.modelId === model.id && hit.expressId > 0, hit);
  }
  // Control: with every model hidden the same measure finds nothing, so F2 measures the models.
  await ev(`(() => { const R = window.__gubim_dev__.renderer; ${JSON.stringify(held.map((m) => m.id))}.forEach((id) => R.setModelVisibility(id, false)); return true; })()`);
  await frames(6);
  const empty = await canvasLit(path.join(outDir, `fmt-${mode}-empty.png`));
  check('F2c nothing shown, nothing lit', empty < 0.0005, { litFraction: empty });
  check('F4 no console errors', errors.length === 0, errors.slice(0, 5));
} catch (error) {
  check('HARNESS', false, String(error?.stack ?? error));
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  try { proc.kill(); } catch {}
}
const passed = results.filter(Boolean).length;
console.log(`fmt ${mode}: ${passed}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
