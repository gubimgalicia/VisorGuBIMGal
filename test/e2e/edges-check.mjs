// Browser check for C17: edges and outlines drawn from the depth buffer (src/infrastructure/renderer/
// edges.ts). On SimpleWall, comparing the canvas with edges off and on:
//   E1 edges darken pixels, never lighten one, and mark creases and steps inside the model, not
//      only its outline;
//   E2 they fall on the model, never on the background;
//   E3 a flat face seen square on stays clean: only its outline and the door opening darken, a small
//      share of the lit pixels (a threshold that ignored the plane's depth slope would darken it all);
//   E4 turning them off gives back the same image;
//   E5 E1 and E3 hold in orthographic projection too;
//   E6 no console errors.
// Usage: node edges-check.mjs <gpu|gl2|none> <baseUrl> <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = path.resolve(REPO, 'public/samples/SimpleWall.ifc');

const results = [];
const check = (id, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`);
};

const { proc, wsUrl } = await launch({ port: 9340 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9), profileDir: path.resolve(outDir, `profile-edge-${mode}`) });
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

/** The canvas alone, with the UI over it hidden, saved to `file`; returns its PNG as base64. */
async function canvasShot(file) {
  await ev(`(() => { let s = document.getElementById('__edge_hide'); if (!s) { s = document.createElement('style'); s.id = '__edge_hide'; document.head.appendChild(s); } s.textContent = 'body * { visibility: hidden !important; transition: none !important; animation: none !important; } canvas.bim-viewport { visibility: visible !important; }'; return true; })()`);
  await frames(4);
  const r = await ev(`(() => { const b = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  await ev(`document.getElementById('__edge_hide').textContent = ''`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return data;
}

/**
 * Pixel by pixel, edges off (`a`) against on (`b`): lit pixels of `a` (not background), pixels
 * `b` darkens or lightens by more than 24 on a channel, and darkened pixels on background.
 */
const compare = (a, b) => ev(`(async () => {
  const load = (d) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + d; });
  const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
  const [ia, ib] = await Promise.all([load('${a}'), load('${b}')]);
  const da = px(ia), db = px(ib);
  let lit = 0, darker = 0, lighter = 0, darkerOnBackground = 0, changed = 0, inner = 0;
  const w = ia.width, h = ia.height;
  const isBackground = (q) => Math.abs(da[q] - 15) + Math.abs(da[q + 1] - 18) + Math.abs(da[q + 2] - 23) <= 30;
  // No background in the 3 x 3 around it: a crease or a step inside the model, not its outline.
  const inside = (p) => { const x = (p / 4) % w, y = Math.floor(p / 4 / w); if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isBackground(p + (dy * w + dx) * 4)) return false; return true; };
  for (let p = 0; p < da.length; p += 4) {
    const background = isBackground(p);
    if (!background) lit++;
    const d = [0, 1, 2].map((k) => db[p + k] - da[p + k]);
    if (d.some((v) => Math.abs(v) > 24)) changed++;
    if (d.some((v) => v < -24) && d.every((v) => v <= 4)) { darker++; if (background) darkerOnBackground++; else if (inside(p)) inner++; }
    else if (d.some((v) => v > 24)) lighter++;
  }
  const n = da.length / 4;
  return { pixels: n, lit: lit / n, darker: darker / n, lighter: lighter / n, darkerOnBackground: darker ? darkerOnBackground / darker : 0, changed: changed / n, darkerPerLit: lit ? darker / lit : 0, inner: inner / n };
})()`);

const edgesButton = `document.querySelector('.nav-edges-btn')`;
const setEdges = async (on) => {
  await ev(`(() => { const b = ${edgesButton}; if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) b.click(); return true; })()`);
  await frames(4);
};
const view = async (preset) => {
  await ev(`(() => { const R = window.__gubim_dev__.renderer; R.fitToView(); R.setViewPreset('${preset}'); return true; })()`);
  await frames(6);
};

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: base });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]') && !!${edgesButton}`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [MODEL] });
  await waitFor(`!!document.querySelector('.model-card[data-status="ready"]')`);
  await sleep(1500);

  const shots = {};
  const shot = async (name) => (shots[name] = await canvasShot(path.join(outDir, `edge-${mode}-${name}.png`)));
  for (const projection of ['perspective', 'orthographic']) {
    const p = projection === 'perspective' ? 'persp' : 'ortho';
    await ev(`(() => { window.__gubim_dev__.renderer.setProjection('${projection}'); return true; })()`);
    await setEdges(false);
    await view('iso');
    await shot(`${p}-iso-off`);
    await setEdges(true);
    await shot(`${p}-iso-on`);
    const iso = await compare(shots[`${p}-iso-off`], shots[`${p}-iso-on`]);
    const id = projection === 'perspective' ? 'E1' : 'E5';
    // Slanted flat faces stay clean too: no hatching from depth rounding (seen in orthographic).
    check(`${id} ${p}: edges darken pixels, lighten none, and leave slanted faces clean`, iso.lit > 0.01 && iso.darker > 0.002 && iso.lighter < 0.0005 && iso.darkerPerLit < 0.1 && iso.inner > 0.001, iso);
    if (projection === 'perspective') check('E2 edges fall on the model, not the background', iso.darkerOnBackground < 0.01, { darkerOnBackground: iso.darkerOnBackground });

    // The wall square on: its face is one plane, so only the outline and the opening darken.
    await setEdges(false);
    await view('front');
    await shot(`${p}-front-off`);
    await setEdges(true);
    await shot(`${p}-front-on`);
    const front = await compare(shots[`${p}-front-off`], shots[`${p}-front-on`]);
    check(`${projection === 'perspective' ? 'E3' : 'E5'} ${p}: a flat face stays clean`, front.lit > 0.01 && front.inner > 0.001 && front.darkerPerLit < 0.15, front);
  }

  // Off again: the same image as before they were turned on.
  await ev(`(() => { window.__gubim_dev__.renderer.setProjection('perspective'); return true; })()`);
  await view('iso');
  await setEdges(false);
  await shot('persp-iso-off-again');
  const again = await compare(shots['persp-iso-off'], shots['persp-iso-off-again']);
  check('E4 turning edges off gives back the image', again.changed < 0.0005, { changed: again.changed });
  const backend = await ev(`window.__gubim_dev__.renderer.activeBackend`);
  check('E6 no console errors', errors.length === 0, { backend, errors: errors.slice(0, 5) });
} catch (error) {
  check('HARNESS', false, String(error?.stack ?? error));
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  try { proc.kill(); } catch {}
}
const passed = results.filter(Boolean).length;
console.log(`edge ${mode}: ${passed}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
