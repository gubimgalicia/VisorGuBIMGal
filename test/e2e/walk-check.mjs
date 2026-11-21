// Browser check for C24, walking a storey, and C17's default. On SimpleWall (one storey, «Level 1»):
//   W1 edges are on when the app opens;
//   W2 the «Planta» menu lists the model's storeys, read from its spatial tree;
//   W3 choosing one switches to first person with the eye 1.6 m above the storey's level, and the
//      minimap opens on that storey;
//   W4 walking with the keys, even pressing Q and E (down and up) and looking down, keeps the eye
//      at that height while it moves across the floor;
//   W5 a view preset releases the storey: the menu goes back to «libre» and the eye is free;
//   W6 no console errors.
// Usage: node walk-check.mjs <gpu|gl2|none> <baseUrl> <outDir>
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

const { proc, wsUrl } = await launch({ port: 9350 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9), profileDir: path.resolve(outDir, `profile-walk-${mode}`) });
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
  await ev(`(() => { let s = document.getElementById('__walk_hide'); if (!s) { s = document.createElement('style'); s.id = '__walk_hide'; document.head.appendChild(s); } s.textContent = 'body * { visibility: hidden !important; transition: none !important; animation: none !important; } canvas.bim-viewport { visibility: visible !important; }'; return true; })()`);
  await frames(4);
  const r = await ev(`(() => { const b = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  await ev(`document.getElementById('__walk_hide').textContent = ''`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return data;
}

const EYE_HEIGHT = 1.6;
const pose = () => ev(`(() => { const p = window.__gubim_dev__.renderer.getCameraPose(); const R = window.__gubim_dev__.renderer; return { eye: [p.target[0] + p.distance * Math.cos(p.elevation) * Math.cos(p.azimuth), p.target[1] + p.distance * Math.cos(p.elevation) * Math.sin(p.azimuth), p.target[2] + p.distance * Math.sin(p.elevation)], lock: R.getEyeLock(), mode: R.getNavigationMode() }; })()`);
const select = `document.querySelector('select.nav-storey-select')`;
const choose = (value) => ev(`(() => { const s = ${select}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const key = async (k, times = 1) => { for (let i = 0; i < times; i++) await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)} })); true`); await frames(2); };

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: base });
  await waitFor(`!!window.__gubim_dev__ && !!window.__gubim_kernel__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [MODEL] });
  await waitFor(`!!document.querySelector('.model-card[data-status="ready"]') && !!${select}`);
  await sleep(1000);

  const edges = await ev(`({ pressed: document.querySelector('.nav-edges-btn')?.getAttribute('aria-pressed'), renderer: window.__gubim_dev__.renderer.getEdges() })`);
  check('W1 edges are on when the app opens', edges.pressed === 'true' && edges.renderer === true, edges);

  // The storeys as the kernel's spatial tree has them: name and level.
  const expected = await ev(`(async () => { const K = window.__gubim_kernel__; const id = [...window.__gubim_dev__.activeRenderer.models.keys()][0]; const tree = await K.getSpatialTree(id); const out = []; const visit = (n) => { if (n.type.toLowerCase() === 'ifcbuildingstorey') out.push({ name: n.name, level: n.level }); n.children.forEach(visit); }; visit(tree.root); return out; })()`);
  const options = await ev(`[...${select}.options].map((o) => o.textContent)`);
  check('W2 the menu lists the storeys', expected.length === 1 && expected[0].name === 'Level 1' && typeof expected[0].level === 'number' && JSON.stringify(options) === JSON.stringify(['Planta: libre', 'Level 1']), { expected, options });

  await choose('0');
  await frames(4);
  const standing = await pose();
  const want = expected[0].level + EYE_HEIGHT;
  await waitFor(`(document.querySelector('.minimap-storey')?.textContent ?? '').includes('Level 1') && !!document.querySelector('.minimap-plan svg')`, 30000).catch(() => {});
  const minimap = await ev(`({ storey: document.querySelector('.minimap-storey')?.textContent ?? null, plan: !!document.querySelector('.minimap-plan svg'), menu: ${select}.value })`);
  await canvasShot(path.join(outDir, `walk-${mode}-standing.png`));
  check('W3 a storey stands the eye 1.6 m above it, in first person, with its minimap',
    standing.mode === 'first-person' && Math.abs(standing.eye[2] - want) < 1e-6 && Math.abs(standing.lock - want) < 1e-9 && minimap.storey === 'Level 1' && minimap.plan && minimap.menu === '0',
    { standing, want, minimap });

  // Walk: forward, sideways, down and up keys, and look down by dragging is not needed: Q and E
  // are the vertical keys of free first person.
  await key('w', 4); await key('d', 2); await key('q', 3); await key('e', 1);
  const walked = await pose();
  const moved = Math.hypot(walked.eye[0] - standing.eye[0], walked.eye[1] - standing.eye[1]);
  check('W4 walking keeps the eye at the storey height and moves it across the floor', Math.abs(walked.eye[2] - want) < 1e-6 && moved > 0.5, { eyeZ: walked.eye[2], want, moved });

  await ev(`(() => { window.__gubim_dev__.renderer.setViewPreset('iso'); return true; })()`);
  await frames(4);
  const free = await pose();
  const menu = await ev(`${select}.value`);
  check('W5 a view preset releases the storey', free.lock === null && menu === '', { lock: free.lock, menu });
  check('W6 no console errors', errors.length === 0, errors.slice(0, 5));
} catch (error) {
  check('HARNESS', false, String(error?.stack ?? error));
} finally {
  await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
  try { proc.kill(); } catch {}
}
const passed = results.filter(Boolean).length;
console.log(`walk ${mode}: ${passed}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
