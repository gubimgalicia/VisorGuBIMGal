// Acceptance tests TC-001..008 (docs/01) in headless Chrome over CDP, on one backend.
// Usage: node tc.mjs <gpu|gl2|none> <devServerUrl> <outDir>
// Expected values come from the IFC text and from formulas written here, not from the app.
// Screenshots are compared with test/e2e/ref/<platform>-<mode>/<name>.png. A missing reference is
// written to <outDir>/new-refs and reported as NEW (a failure with E2E_REQUIRE_REFS=1);
// E2E_UPDATE_REFS=1 writes it into test/e2e/ref instead.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode = 'gpu', base = 'http://127.0.0.1:5173/', outDir = './out'] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REF_DIR = path.join(HERE, 'ref', `${process.platform}-${mode}`);
const MAX_DIFF = 0.005; // fraction of pixels whose channels differ by more than 24
mkdirSync(outDir, { recursive: true });
const downloads = path.resolve(outDir, `downloads-tc-${mode}`);
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const near = (a, b, t) => Math.abs(a - b) <= t;

// ---------- Oracles from the IFC text ----------
const SIMPLE = `${REPO}/public/samples/SimpleWall.ifc`;
const MANY = `${REPO}/public/samples/ManySimpleWalls.ifc`;
const GEOREF = `${REPO}/test/fixtures/georef-galicia-utm29n.ifc`;
const stepLine = (text, id) => text.match(new RegExp(`^#${id}\\s*=\\s*([A-Z0-9]+)\\(([\\s\\S]*?)\\);\\s*$`, 'm'));
function stepArgs(args) {
  const out = [];
  let depth = 0, cur = '', quoted = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quoted) { cur += c; if (c === "'") { if (args[i + 1] === "'") { cur += "'"; i++; } else quoted = false; } continue; }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
const stepString = (arg) => (arg && arg.startsWith("'") ? arg.slice(1, -1).replace(/''/g, "'") : null);
function elementInfo(text, id) {
  const m = stepLine(text, id);
  const a = stepArgs(m[2]);
  return { type: m[1], globalId: stepString(a[0]), name: stepString(a[2]) };
}
function psetNames(text, id) {
  const names = [];
  for (const m of text.matchAll(/IFCRELDEFINESBYPROPERTIES\(([\s\S]*?)\);/g)) {
    const args = m[1];
    const list = args.match(/\(([^()]*)\)\s*,\s*#(\d+)\s*$/);
    if (!list || !list[1].split(',').map((t) => t.trim()).includes(`#${id}`)) continue;
    const def = stepLine(text, list[2]);
    if (def && def[1] === 'IFCPROPERTYSET') names.push(stepString(stepArgs(def[2])[2]));
  }
  return names;
}
// Inverse transverse Mercator, Snyder (1987) eq. 8-12 to 8-25, GRS80, UTM zone 29N.
function utm29nToLatLng(E, N) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = (-9 * Math.PI) / 180;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const mu = N / k0 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const D = (E - 500000) / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(p1);
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

// ---------- Browser ----------
const port = 9330 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9);
const { proc, wsUrl } = await launch({ port, profileDir: path.resolve(outDir, `profile-tc-${mode}`) });
const cdp = await connect(wsUrl);
const { send, on, evaluate } = cdp;
const consoleErrors = [];
const requests = [];
const sockets = [];
on('Runtime.consoleAPICalled', (p) => p.type === 'error' && consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' ')));
on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
on('Page.javascriptDialogOpening', () => void send('Page.handleJavaScriptDialog', { accept: true }));
on('Network.requestWillBeSent', (p) => requests.push({ url: p.request.url, method: p.request.method, body: !!p.request.hasPostData }));
on('Network.webSocketCreated', (p) => sockets.push(p.url));
on('Log.entryAdded', (p) => {
  const e = p.entry;
  if (e.level !== 'error' && e.level !== 'warning') return;
  // Remote map tiles may fail offline or on CI; a missing favicon is not the app's.
  let local = true;
  try { const h = new URL(e.url ?? '').hostname; local = !h || h === '127.0.0.1' || h === 'localhost'; } catch {}
  if (e.source === 'network' && (!local || /favicon\.ico$/.test(e.url ?? ''))) return;
  consoleErrors.push(`log ${e.level}: ${e.text.slice(0, 300)}${e.url ? ' ' + e.url : ''}`);
});
await send('Log.enable');
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
await applyMode(send, mode);

const HELPERS = String.raw`
window.__t = (() => {
  const R = () => window.__gubim_dev__.renderer;
  const K = () => window.__gubim_kernel__;
  const rect = () => { const r = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const frames = (n = 3) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const bbox = (m) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], m.positions[i + k]); mx[k] = Math.max(mx[k], m.positions[i + k]); } return { min: mn, max: mx }; };
  const card = (name) => [...document.querySelectorAll('.model-card')].find((c) => c.querySelector('.model-card-name').textContent.trim() === name);
  const btnByText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
  const models = () => [...window.__gubim_dev__.activeRenderer.models.keys()];
  async function diff(a, b) {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { sameSize: false, a: [ia.width, ia.height], b: [ib.width, ib.height] };
    const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const da = px(ia), db = px(ib);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 24 || Math.abs(da[i + 1] - db[i + 1]) > 24 || Math.abs(da[i + 2] - db[i + 2]) > 24) bad++;
    return { sameSize: true, fraction: bad / (da.length / 4) };
  }
  return { R, K, rect, frames, bbox, card, btnByText, models, diff };
})(); true`;

async function waitFor(expr, timeout = 30000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await evaluate(expr); if (v) return v; } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
async function canvasClick(cx, cy) {
  const r = await evaluate('__t.rect()');
  const x = r.left + cx, y = r.top + cy;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function openLocal(file, expectedCards) {
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(file)] });
  await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length === ${expectedCards}`, 60000, `${expectedCards} ready models`);
  // Settled: no new records for 1 s.
  let last = -1, since = Date.now();
  while (Date.now() - since < 1000) {
    const s = await evaluate('__t.R().getDebugStats().recordCount');
    if (s !== last) { last = s; since = Date.now(); }
    await sleep(100);
  }
}
const stats = () => evaluate('__t.R().getDebugStats()');
const fit = () => evaluate(`__t.R().fitToView(), __t.R().setViewPreset('iso'), __t.frames(5)`);

async function shot(name, selector) {
  await evaluate(`(() => { let s = document.getElementById('__e2e_hide'); if (!s) { s = document.createElement('style'); s.id = '__e2e_hide'; document.head.appendChild(s); } s.textContent = 'body * { visibility: hidden !important; transition: none !important; animation: none !important; } canvas.bim-viewport, .drawing-preview, .drawing-preview * { visibility: visible !important; }'; })()`);
  await evaluate('__t.frames(4)');
  const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  await evaluate(`document.getElementById('__e2e_hide').textContent = ''`);
  writeFileSync(path.join(outDir, `tc-${mode}-${name}.png`), Buffer.from(data, 'base64'));
  const refPath = path.join(REF_DIR, `${name}.png`);
  if (!existsSync(refPath)) {
    const target = process.env.E2E_UPDATE_REFS === '1' ? REF_DIR : path.join(outDir, 'new-refs', `${process.platform}-${mode}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, `${name}.png`), Buffer.from(data, 'base64'));
    const required = process.env.E2E_REQUIRE_REFS === '1';
    check(`SHOT ${name}`, !required, `NEW reference written to ${target}`);
    return;
  }
  const ref = readFileSync(refPath).toString('base64');
  const d = await evaluate(`__t.diff('data:image/png;base64,${ref}', 'data:image/png;base64,${data}')`);
  check(`SHOT ${name}`, d.sameSize && d.fraction <= MAX_DIFF, d);
}

try {
  const simpleText = readFileSync(SIMPLE, 'utf8');
  const manyText = readFileSync(MANY, 'utf8');
  const wallA = elementInfo(simpleText, 219);
  const wallB = elementInfo(manyText, 219);

  await send('Page.navigate', { url: base });
  await waitFor('!!(window.__gubim_dev__ && window.__gubim_kernel__)', 30000, 'dev hooks');
  await evaluate(HELPERS);
  await waitFor('!!window.__gubim_dev__.activeRenderer', 15000, 'renderer');
  const stats0 = await stats();
  const pickBuffer = () => evaluate('(() => { const b = window.__gubim_dev__.activeRenderer.pickReadBuffer; return b ? b.size : 0; })()');
  const pick0 = await pickBuffer();

  // ---- TC-001: a local .ifc opens and draws with the chosen backend.
  await openLocal(SIMPLE, 1);
  await fit();
  const s1 = await stats();
  const badge = await evaluate(`[...document.querySelectorAll('header *')].map((e) => (e.childElementCount === 0 ? e.textContent : '')).find((t) => /Activo/.test(t)) ?? ''`);
  const backend = await evaluate("window.__gubim_dev__.activeRenderer?.constructor?.name ?? ''");
  const wantGpu = mode === 'gpu';
  check('TC-001 local file opens and draws', s1.modelCount === 1 && s1.batchCount > 0 && s1.recordCount > 0 && (wantGpu ? /WebGPU/.test(badge) && /Gpu/.test(backend) : /WebGL2/.test(badge) && /Gl2/.test(backend)), { badge, backend, batches: s1.batchCount, records: s1.recordCount });
  await shot('tc001-simplewall', 'canvas.bim-viewport');
  const [idA] = await evaluate('__t.models()');

  // ---- TC-002: two federated models, both with a #219 wall, never confused.
  await openLocal(MANY, 2);
  const s2load = await stats();
  const ids = await evaluate('__t.models()');
  const idB = ids.find((id) => id !== idA);
  check('TC-002a both models federated', ids.length === 2 && !!idB, ids);
  await fit();
  await shot('tc002-federated', 'canvas.bim-viewport');
  const pickWall = async (modelId) => evaluate(`(async () => { const b = __t.bbox(await __t.K().elementMesh(${JSON.stringify(modelId)}, 219)); const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2] + 0.85 * (b.max[2] - b.min[2])]; const s = __t.R().project(c); const ref = s ? await __t.R().pick(s.x, s.y) : null; return { s, ref }; })()`);
  const visibilityBtn = (name) => `[...__t.card(${JSON.stringify(name)}).querySelectorAll('button')].find((b) => /Ocultar modelo|Mostrar modelo/.test(b.title)).click()`;
  const panelText = () => evaluate(`(document.querySelector('.tab-btn.active') && document.body.innerText) || ''`);
  await evaluate(`__t.btnByText('.tab-btn', 'Propiedades')?.click()`);
  // Only B visible: the click selects B's #219.
  await evaluate(visibilityBtn('SimpleWall.ifc'));
  await evaluate('__t.frames(3)');
  const hitB = await pickWall(idB);
  await canvasClick(hitB.s.x, hitB.s.y);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(wallB.name)})`, 5000, 'B wall in panel').catch(() => null);
  const textB = await panelText();
  // Only A visible: the same pixel selects A's #219.
  await evaluate(visibilityBtn('SimpleWall.ifc'));
  await evaluate(visibilityBtn('ManySimpleWalls.ifc'));
  await evaluate('__t.frames(3)');
  const hitA = await pickWall(idA);
  await canvasClick(hitA.s.x, hitA.s.y);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(wallA.name)})`, 5000, 'A wall in panel').catch(() => null);
  const textA = await panelText();
  await evaluate(visibilityBtn('ManySimpleWalls.ifc'));
  await evaluate('__t.frames(3)');
  check('TC-002b same expressId in two models stays apart', hitB.ref?.modelId === idB && hitB.ref?.expressId === 219 && hitA.ref?.modelId === idA && hitA.ref?.expressId === 219 && textB.includes(wallB.name) && !textB.includes(wallA.name) && textA.includes(wallA.name) && !textA.includes(wallB.name), { refA: hitA.ref, refB: hitB.ref, nameA: wallA.name, nameB: wallB.name });

  // ---- TC-003: hide, show and remove, with GPU memory released.
  await evaluate(visibilityBtn('SimpleWall.ifc'));
  await evaluate('__t.frames(3)');
  const hidden = await evaluate(`(async () => { const r = await __t.R().pick(${hitA.s.x}, ${hitA.s.y}); return r && r.modelId === ${JSON.stringify(idA)}; })()`);
  await evaluate(visibilityBtn('SimpleWall.ifc'));
  await evaluate('__t.frames(3)');
  const shown = await evaluate(`(async () => { const r = await __t.R().pick(${hitA.s.x}, ${hitA.s.y}); return !!r; })()`);
  const s2 = await stats();
  await evaluate(`[...__t.card('ManySimpleWalls.ifc').querySelectorAll('button')].find((b) => /Retirar/.test(b.title)).click()`);
  await waitFor(`document.querySelectorAll('.model-card').length === 1`, 5000, 'B removed');
  await evaluate('__t.frames(3)');
  const s3 = await stats();
  check('TC-003a hide and show', hidden === false && shown === true, { hiddenStillPicked: hidden, shownPicked: shown });
  // B's own share is what it added on load; removing B must give back exactly that.
  const addedBytes = s2load.allocatedGpuBytes - s1.allocatedGpuBytes, addedBuffers = s2load.liveGpuBuffers - s1.liveGpuBuffers;
  const freedBytes = s2.allocatedGpuBytes - s3.allocatedGpuBytes, freedBuffers = s2.liveGpuBuffers - s3.liveGpuBuffers;
  // WebGPU's shared batch and record tables keep their grown capacity while any model is open
  // (they shrink when the scene empties), so bytes are checked against the empty scene in TC-003c.
  check('TC-003b removing a model frees its buffers', s2.modelCount === 2 && s3.modelCount === 1 && addedBuffers > 0 && freedBuffers === addedBuffers && freedBytes > 0 && freedBytes <= addedBytes, { added: [addedBuffers, addedBytes], freed: [freedBuffers, freedBytes], beforeRemove: [s2.liveGpuBuffers, s2.allocatedGpuBytes], after: [s3.liveGpuBuffers, s3.allocatedGpuBytes] });

  // ---- TC-004: select the wall and show its attributes and property sets.
  await fit();
  const hitA2 = await pickWall(idA);
  await canvasClick(hitA2.s.x, hitA2.s.y);
  await waitFor(`document.querySelectorAll('.pset-header').length > 0`, 5000, 'property sets');
  const panel = await evaluate(`({ text: document.body.innerText, headers: [...document.querySelectorAll('.pset-header > span:first-child')].map((e) => e.textContent.trim()), guid: [...document.querySelectorAll('.meta-chip')].map((e) => e.title).find((t) => t && t.length === 22) ?? '' })`);
  const expectedPsets = psetNames(simpleText, 219);
  check('TC-004 attributes and property sets', panel.text.toUpperCase().includes(wallA.type) && panel.text.includes(wallA.name) && panel.guid === wallA.globalId && expectedPsets.length > 0 && expectedPsets.every((n) => panel.headers.includes(n)), { guid: panel.guid, expectedGuid: wallA.globalId, expectedPsets, headers: panel.headers });

  // ---- TC-005: plans and sections are reproducible.
  const svgTwice = (cut) => evaluate(`(async () => { const k = __t.K(); const out = []; for (let i = 0; i < 2; i++) { const g = await k.generateDrawing([${JSON.stringify(idA)}], { cut: ${JSON.stringify(cut)}, frame: { kind: 'project' }, includeProjection: true, includeHiddenLines: true, includeHatching: true }); const e = await k.exportDrawing(g.drawingId, { format: 'svg', fileName: 'x', units: 'm', showHiddenLines: true, showHatching: true }); await k.discardDrawing(g.drawingId); out.push(typeof e.content === 'string' ? e.content : new TextDecoder().decode(e.content)); } return out; })()`);
  const plan = await svgTwice({ kind: 'plan', elevation: 1.0 });
  const sect = await svgTwice({ kind: 'section', axis: 'x', position: 0.3, look: 'positive' });
  check('TC-005 plan and section are identical when generated twice', plan[0] === plan[1] && sect[0] === sect[1] && /<(path|polyline|line|polygon)\b/.test(plan[0]) && /<(path|polyline|line|polygon)\b/.test(sect[0]), { planBytes: plan[0].length, sectionBytes: sect[0].length });

  // ---- TC-006: the panel exports DXF R12 and SVG locally.
  await evaluate(`__t.btnByText('.tab-btn', 'Planos').click(), __t.frames(2)`);
  await evaluate(`(() => { const s = document.querySelector('.dxf-cut-preset'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'plan'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.dxf-generate-btn').click()`);
  await waitFor(`!!document.querySelector('.drawing-preview svg')`, 30000, 'preview');
  await shot('tc005-plan-preview', '.drawing-preview');
  await evaluate(`__t.btnByText('.btn', 'Exportar DXF').click()`);
  await evaluate(`__t.btnByText('.btn', 'Exportar SVG').click()`);
  let files = [];
  for (let i = 0; i < 80 && files.filter((f) => /\.(dxf|svg)$/i.test(f)).length < 2; i++) { await sleep(100); files = readdirSync(downloads); }
  const dxf = files.find((f) => /\.dxf$/i.test(f)), svg = files.find((f) => /\.svg$/i.test(f));
  const dxfText = dxf ? readFileSync(path.join(downloads, dxf), 'latin1') : '';
  const svgText = svg ? readFileSync(path.join(downloads, svg), 'utf8') : '';
  check('TC-006 DXF R12 and SVG downloads', /\$ACADVER\s*\r?\n\s*1\s*\r?\nAC1009/.test(dxfText) && /\nEOF\s*$/.test(dxfText) && /<svg[\s>]/.test(svgText) && /<\/svg>\s*$/.test(svgText), { files, dxfBytes: dxfText.length, svgBytes: svgText.length });

  // ---- TC-007: the Galicia model sits on the map at its UTM 29N position.
  const georefText = readFileSync(GEOREF, 'utf8');
  const mc = georefText.match(/IFCMAPCONVERSION\([^,]+,[^,]+,([-\d.E+]+),([-\d.E+]+),/);
  const crs = georefText.match(/IFCPROJECTEDCRS\('([^']+)'/)[1];
  const [expLat, expLng] = utm29nToLatLng(parseFloat(mc[1]), parseFloat(mc[2]));
  await openLocal(GEOREF, 2);
  const crsShown = await evaluate(`__t.card('georef-galicia-utm29n.ifc')?.innerText ?? ''`);
  await evaluate(`[...__t.card('georef-galicia-utm29n.ifc').querySelectorAll('div')].find((d) => /Ver en mapa/.test(d.textContent) && d.childElementCount <= 2).click()`);
  await waitFor(`!!document.querySelector('.gis-drawer .leaflet-marker-icon')`, 10000, 'map marker');
  await sleep(500);
  const layers = await evaluate(`document.querySelector('.leaflet-control-layers')?.textContent ?? ''`);
  const markers = await evaluate(`document.querySelectorAll('.gis-drawer .leaflet-marker-icon').length`);
  // Click every marker until the popup names this model's coordinates.
  let popup = '';
  for (let i = 0; i < markers && !popup; i++) {
    await evaluate(`document.querySelectorAll('.gis-drawer .leaflet-marker-icon')[${i}].click()`);
    await sleep(300);
    const t = await evaluate(`document.querySelector('.leaflet-popup-content')?.textContent ?? ''`);
    if (/georef|Galicia|Obradoiro/i.test(t) || markers === 1) popup = t;
  }
  const coords = popup.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  const got = coords ? [parseFloat(coords[1]), parseFloat(coords[2])] : null;
  check('TC-007 GIS position from UTM 29N', crsShown.includes(crs) && /PNOA/.test(layers) && got && near(got[0], expLat, 2e-5) && near(got[1], expLng, 2e-5), { crs, crsShown: crsShown.includes(crs), expected: [expLat.toFixed(6), expLng.toFixed(6)], got, layers: layers.replace(/\s+/g, ' ').trim() });
  await evaluate(`[...document.querySelectorAll('.gis-drawer button')].find((b) => /Cerrar/.test(b.title))?.click()`);

  // ---- TC-003c: with every model removed, GPU memory is back to the empty scene.
  await evaluate(`(async () => { for (const c of [...document.querySelectorAll('.model-card')]) { [...c.querySelectorAll('button')].find((b) => /Retirar/.test(b.title)).click(); await new Promise((r) => setTimeout(r, 200)); } })()`);
  await waitFor(`document.querySelectorAll('.model-card').length === 0`, 5000, 'all removed');
  await evaluate('__t.frames(3)');
  const sEnd = await stats();
  const pickEnd = await pickBuffer();
  // The 1-pixel pick readback buffer is created on the first pick and kept for reuse.
  const extraBuffers = pickEnd && !pick0 ? 1 : 0, extraBytes = pick0 ? 0 : pickEnd;
  check('TC-003c empty scene frees all GPU memory', sEnd.modelCount === 0 && sEnd.batchCount === 0 && sEnd.liveGpuBuffers === stats0.liveGpuBuffers + extraBuffers && sEnd.allocatedGpuBytes === stats0.allocatedGpuBytes + extraBytes, { start: [stats0.liveGpuBuffers, stats0.allocatedGpuBytes], end: [sEnd.liveGpuBuffers, sEnd.allocatedGpuBytes], pickBuffer: pickEnd });

  // ---- TC-008: no model byte leaves the browser.
  const local = (u) => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch { return true; } };
  const allowedHost = (u) => { try { const h = new URL(u).hostname; return /(^|\.)tile\.openstreetmap\.org$/.test(h) || h === 'www.ign.es'; } catch { return false; } };
  const external = requests.filter((r) => /^https?:/.test(r.url) && !local(r.url));
  const bad = external.filter((r) => r.method !== 'GET' || r.body || !allowedHost(r.url));
  const anyBody = requests.filter((r) => r.body);
  const badSockets = sockets.filter((u) => !local(u.replace(/^ws/, 'http')));
  check('TC-008 no upload, only map tiles leave the page', bad.length === 0 && anyBody.length === 0 && badSockets.length === 0, { requests: requests.length, external: external.length, bad: bad.slice(0, 3), withBody: anyBody.slice(0, 3), badSockets });
} catch (err) {
  check('HARNESS', false, String(err?.stack ?? err));
} finally {
  check('C0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  writeFileSync(path.join(outDir, `results-tc-${mode}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\ntc ${mode}: ${results.length - failed}/${results.length} pass`);
  process.exitCode = failed ? 1 : 0;
  cdp.close();
  proc.kill();
}
