// Browser check for T-135 (navigation), T-136 (BCF) and T-137 (face cut) on one backend.
// Usage: node e2e.mjs <gpu|gl2> <baseUrl> <outDir>
// Expected values come from the IFC text and geometry rules, not from the app's own code paths.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode = 'gpu', base = 'http://127.0.0.1:5173/', outDir = './out'] = process.argv.slice(2);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(outDir, { recursive: true });
const downloads = path.resolve(outDir, `downloads-${mode}`);
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const vnear = (a, b, tol) => a.every((v, i) => near(v, b[i], tol));

const port = 9300 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9);
const { proc, wsUrl } = await launch({ port, profileDir: path.resolve(outDir, `profile-${mode}`) });
const cdp = await connect(wsUrl);
const { send, on, evaluate } = cdp;
const consoleErrors = [];
on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
});
on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
on('Page.javascriptDialogOpening', () => void send('Page.handleJavaScriptDialog', { accept: true }));
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
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
await applyMode(send, mode);

const HELPERS = String.raw`
window.__t = (() => {
  const R = () => window.__gubim_dev__.renderer;
  const K = () => window.__gubim_kernel__;
  const look = (p) => [-Math.cos(p.elevation) * Math.cos(p.azimuth), -Math.cos(p.elevation) * Math.sin(p.azimuth), -Math.sin(p.elevation)];
  const eye = (p) => [p.target[0] + p.distance * Math.cos(p.elevation) * Math.cos(p.azimuth), p.target[1] + p.distance * Math.cos(p.elevation) * Math.sin(p.azimuth), p.target[2] + p.distance * Math.sin(p.elevation)];
  const bbox = (m) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], m.positions[i + k]); mx[k] = Math.max(mx[k], m.positions[i + k]); } return { min: mn, max: mx }; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function hit(m, ray, planes = []) {
    let best = null; const P = m.positions, I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const v0 = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]];
      const e1 = sub([P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], v0);
      const e2 = sub([P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]], v0);
      const p = cross(ray.direction, e2); const det = dot(e1, p); if (Math.abs(det) < 1e-15) continue;
      const s = sub(ray.origin, v0); const u = dot(s, p) / det; if (u < 0 || u > 1) continue;
      const q = cross(s, e1); const v = dot(ray.direction, q) / det; if (v < 0 || u + v > 1) continue;
      const d = dot(e2, q) / det;
      if (d > 0 && (best === null || d < best)) {
        const pt = ray.origin.map((o, k) => o + ray.direction[k] * d);
        if (planes.every((pl) => dot(pl.normal, pt) <= pl.offset)) best = d;
      }
    }
    return best === null ? null : ray.origin.map((o, k) => o + ray.direction[k] * best);
  }
  const rect = () => { const r = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const frames = (n = 3) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const btnByText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
  function setInput(el, value) { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value)); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
  return { R, K, look, eye, bbox, hit, rect, frames, btnByText, setInput, dot };
})(); true`;

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}
async function canvasClick(cx, cy) {
  const r = await evaluate('__t.rect()');
  const x = r.left + cx, y = r.top + cy;
  await mouse('mouseMoved', x, y, { button: 'none' });
  await mouse('mousePressed', x, y, { buttons: 1 });
  await mouse('mouseReleased', x, y, { buttons: 0 });
}
async function waitFor(expr, timeout = 20000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await evaluate(expr); if (v) return v; } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
async function load(model) {
  await send('Page.navigate', { url: `${base}?model=${encodeURIComponent(model)}` });
  await waitFor('!!(window.__gubim_dev__ && window.__gubim_kernel__)', 30000, 'dev hooks');
  await evaluate(HELPERS);
  // Loaded when batches arrived and the record count has been stable for 1.5 s.
  let last = -1, stableSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await evaluate('__t.R().getDebugStats()');
    if (s.recordCount !== last) { last = s.recordCount; stableSince = Date.now(); }
    if (s.batchCount > 0 && Date.now() - stableSince > 1500) break;
    await sleep(150);
  }
  await evaluate('__t.R().fitToView(), __t.frames(4)');
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(outDir, `${mode}-${name}.png`), Buffer.from(data, 'base64'));
}
const pose = () => evaluate('__t.R().getCameraPose()');

// ---------- Mini readers (independent of the app) ----------
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString('utf8');
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(lstart, lstart + csize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    at += 46 + nlen + xlen + clen;
  }
  return files;
}
function dxfSegments(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  const segs = [];
  let i = 0;
  while (i < pairs.length) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'LINE') {
      const e = { layer: '' }; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { const [k, val] = pairs[i]; if (k === 8) e.layer = val; else e[k] = parseFloat(val); i++; }
      segs.push({ layer: e.layer, a: [e[10], e[20]], b: [e[11], e[21]] });
    } else if (c === 0 && v === 'POLYLINE') {
      let layer = '', flags = 0; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { if (pairs[i][0] === 8) layer = pairs[i][1]; if (pairs[i][0] === 70) flags = parseInt(pairs[i][1], 10); i++; }
      const pts = [];
      while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'SEQEND')) {
        if (pairs[i][0] === 0 && pairs[i][1] === 'VERTEX') {
          const p = {}; i++;
          while (i < pairs.length && pairs[i][0] !== 0) { p[pairs[i][0]] = parseFloat(pairs[i][1]); i++; }
          pts.push([p[10], p[20]]);
        } else i++;
      }
      for (let k = 0; k + 1 < pts.length; k++) segs.push({ layer, a: pts[k], b: pts[k + 1] });
      if (flags & 1 && pts.length > 2) segs.push({ layer, a: pts[pts.length - 1], b: pts[0] });
    } else i++;
  }
  return segs;
}
function dxfStats(text) {
  const segs = dxfSegments(text);
  const byLayer = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    byLayer[s.layer] = (byLayer[s.layer] ?? 0) + len;
    for (const p of [s.a, s.b]) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  }
  const total = Object.values(byLayer).reduce((a, b) => a + b, 0);
  return { total, byLayer, extents: [minX, minY, maxX, maxY], count: segs.length };
}
const kernelDxf = (modelIdExpr, cut) => evaluate(`(async () => {
  const k = __t.K();
  const g = await k.generateDrawing([${modelIdExpr}], { cut: ${JSON.stringify(cut)}, frame: { kind: 'project' }, includeProjection: false, includeHiddenLines: false, includeHatching: false });
  const e = await k.exportDrawing(g.drawingId, { format: 'dxf', fileName: 'x', units: 'm', showHiddenLines: false, showHatching: false });
  await k.discardDrawing(g.drawingId);
  const text = typeof e.content === 'string' ? e.content : new TextDecoder().decode(e.content);
  return { text, diagnostics: g.diagnostics };
})()`);

try {
  // =================== T-135 / T-136 on ManySimpleWalls ===================
  const manyIfc = readFileSync(`${REPO}/public/samples/ManySimpleWalls.ifc`, 'utf8');
  await load('/samples/ManySimpleWalls.ifc');
  const backend = await evaluate("window.__gubim_dev__.activeRenderer?.constructor?.name ?? ''");
  check('B0 backend', mode === 'gpu' ? /Gpu/i.test(backend) : /Gl2/i.test(backend), backend);
  await shot('many-loaded');

  // N1: each view cube face looks along the direction its compass name says.
  const faces = {
    top: [0, 0, -1], bottom: [0, 0, 1], front: [0, 1, 0], back: [0, -1, 0], right: [-1, 0, 0], left: [1, 0, 0]
  };
  for (const [face, expected] of Object.entries(faces)) {
    await evaluate(`document.querySelector('.view-cube-face-${face}').click(), __t.frames(3)`);
    const p = await pose();
    const l = await evaluate(`__t.look(${JSON.stringify(p)})`);
    check(`N1 cube ${face}`, vnear(l, expected, 1e-6), l.map((v) => v.toFixed(6)));
  }
  await evaluate(`document.querySelector('.vc-btn-iso').click(), __t.frames(3)`);
  {
    const l = await evaluate(`__t.look(__t.R().getCameraPose())`);
    check('N2 iso looks down and diagonal', l[2] < -0.1 && Math.abs(l[0]) > 0.1 && Math.abs(l[1]) > 0.1, l);
  }

  // N3: orthographic rays are parallel at opposite corners; perspective ones are not.
  const raysParallel = async () => evaluate(`(() => { const r = __t.rect(); const a = __t.R().rayAt(5, 5), b = __t.R().rayAt(r.width - 5, r.height - 5); return __t.dot(a.direction, b.direction) / Math.hypot(...a.direction) / Math.hypot(...b.direction); })()`);
  const cosPersp = await raysParallel();
  await evaluate(`document.querySelector('.nav-proj-btn').click(), __t.frames(3)`);
  const proj = await evaluate(`[__t.R().getProjection(), document.querySelector('.nav-proj-btn').textContent.trim()]`);
  const cosOrtho = await raysParallel();
  check('N3 ortho toggle', proj[0] === 'orthographic' && proj[1] === 'Orto' && cosOrtho > 1 - 1e-12 && cosPersp < 0.999, { proj, cosOrtho, cosPersp });
  await shot('many-ortho');

  // N4: a saved view keeps the projection.
  const hasSaved = await evaluate(`!!document.querySelector('.saved-view-add')`);
  if (hasSaved) {
    await evaluate(`document.querySelector('.saved-view-add').click(), __t.frames(2)`);
    await evaluate(`document.querySelector('.nav-proj-btn').click(), __t.frames(2)`);
    const mid = await evaluate(`__t.R().getProjection()`);
    await evaluate(`[...document.querySelectorAll('.saved-view-apply')].pop().click(), __t.frames(3)`);
    const after = await evaluate(`__t.R().getProjection()`);
    check('N4 saved view restores ortho', mid === 'perspective' && after === 'orthographic', { mid, after });
  } else check('N4 saved view restores ortho', false, 'no .saved-view-add on the page');
  // Back to perspective iso.
  if ((await evaluate(`__t.R().getProjection()`)) === 'orthographic') await evaluate(`document.querySelector('.nav-proj-btn').click()`);
  await evaluate(`__t.R().setViewPreset('iso'), __t.R().fitToView(), __t.frames(3)`);

  // Find an element under the canvas: scan a grid with pick.
  const target = await evaluate(`(async () => { const r = __t.rect(); for (let fy = 0.5; fy < 0.9; fy += 0.05) for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) { const x = r.width * fx, y = r.height * fy; const ref = await __t.R().pick(x, y); if (ref) return { x, y, ref }; } return null; })()`);
  check('N5a found an element under the cursor', !!target, target);
  const ref = target.ref;
  const mid = `{ modelId: ${JSON.stringify(ref.modelId)}, expressId: ${ref.expressId} }`;

  // N6: orbit around the picked point: the point stays on the same pixel.
  {
    const W = await evaluate(`(async () => { const m = await __t.K().elementMesh(${JSON.stringify(ref.modelId)}, ${ref.expressId}); return __t.hit(m, __t.R().rayAt(${target.x}, ${target.y})); })()`);
    const r = await evaluate('__t.rect()');
    const before = await evaluate(`__t.R().project(${JSON.stringify(W)})`);
    const Bx = await evaluate(`(() => { const ray = __t.R().rayAt(${target.x}, ${target.y}); let best = Infinity; for (const m of window.__gubim_dev__.activeRenderer.models.values()) { if (m.visible === false) continue; for (const b of m.batches) { let t0 = -Infinity, t1 = Infinity; for (let k = 0; k < 3; k++) { const o = ray.origin[k], d = ray.direction[k]; if (Math.abs(d) < 1e-15) { if (o < b.min[k] || o > b.max[k]) { t0 = Infinity; break; } continue; } let a = (b.min[k] - o) / d, c = (b.max[k] - o) / d; if (a > c) [a, c] = [c, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, c); } if (t0 <= t1 && t1 >= 0) { const t = Math.max(0, t0); if (t < best) best = t; } } } return best === Infinity ? null : ray.origin.map((o, k) => o + ray.direction[k] * best); })()`);
    const before0Box = await evaluate(`__t.R().project(${JSON.stringify(Bx)})`);
    const p0 = await pose();
    await mouse('mouseMoved', r.left + target.x, r.top + target.y, { button: 'none' });
    await mouse('mousePressed', r.left + target.x, r.top + target.y, { buttons: 1 });
    for (let k = 1; k <= 8; k++) await mouse('mouseMoved', r.left + target.x + k * 10, r.top + target.y + k * 3, { buttons: 1 });
    await mouse('mouseReleased', r.left + target.x + 80, r.top + target.y + 24, { buttons: 0 });
    await evaluate('__t.frames(3)');
    const after = await evaluate(`__t.R().project(${JSON.stringify(W)})`);
    const afterBox = await evaluate(`__t.R().project(${JSON.stringify(Bx)})`);
    const p1 = await pose();
    const moved = Math.abs(p1.azimuth - p0.azimuth) > 0.1;
    const drift = Math.hypot(after.x - before.x, after.y - before.y);
    const boxDrift = Math.hypot(afterBox.x - before0Box.x, afterBox.y - before0Box.y);
    check('N6 orbit keeps clicked surface point on its pixel', moved && drift < 1, { drift: drift.toFixed(3), boxDrift: boxDrift.toFixed(3), dAz: (p1.azimuth - p0.azimuth).toFixed(3) });
    console.log(`INFO N6 clicked surface point drift ${drift.toFixed(1)} px, pivot ${Bx.map((v) => v.toFixed(2))} vs surface ${W.map((v) => v.toFixed(2))}`);
    await evaluate(`__t.R().setViewPreset('iso'), __t.R().fitToView(), __t.frames(3)`);

    // N6b: with a section plane through the model, the orbit pivot is on the cut-revealed surface, not the removed part.
    const cutCase = await evaluate(`(async () => {
      const r = __t.rect();
      const ray0 = __t.R().rayAt(${target.x}, ${target.y});
      const n = ray0.direction.map((v) => -v);
      const w0 = ${JSON.stringify(W)};
      for (const step of [1.5, 0.5, 0.08]) {
        const plane = { normal: n, offset: __t.dot(n, w0) - step };
        __t.R().setSectionPlanes([plane]);
        await __t.frames(2);
        for (const [fx, fy] of [[${target.x} / r.width, ${target.y} / r.height], [0.5, 0.55], [0.5, 0.6], [0.45, 0.55], [0.55, 0.55], [0.5, 0.5], [0.45, 0.6], [0.55, 0.6]]) {
          const x = r.width * fx, y = r.height * fy;
          const hitRef = await __t.R().pick(x, y);
          if (!hitRef) continue;
          const ray = __t.R().rayAt(x, y);
          const m = await __t.K().elementMesh(hitRef.modelId, hitRef.expressId);
          const wCut = __t.hit(m, ray, [plane]);
          if (!wCut) continue;
          const m0 = hitRef.expressId === ${ref.expressId} ? m : await __t.K().elementMesh(${JSON.stringify(ref.modelId)}, ${ref.expressId});
          const wFront = __t.hit(m0, ray) ?? w0;
          const sep = Math.hypot(wCut[0] - wFront[0], wCut[1] - wFront[1], wCut[2] - wFront[2]);
          if (sep > 0.15) return { x, y, plane, hitRef, wCut, wFront, sep };
        }
      }
      return null;
    })()`);
    if (cutCase) {
      const beforeCut = await evaluate(`__t.R().project(${JSON.stringify(cutCase.wCut)})`);
      const beforeRemoved = await evaluate(`__t.R().project(${JSON.stringify(cutCase.wFront)})`);
      const pCut0 = await pose();
      await mouse('mouseMoved', r.left + cutCase.x, r.top + cutCase.y, { button: 'none' });
      await mouse('mousePressed', r.left + cutCase.x, r.top + cutCase.y, { buttons: 1 });
      for (let k = 1; k <= 8; k++) await mouse('mouseMoved', r.left + cutCase.x + k * 10, r.top + cutCase.y + k * 3, { buttons: 1 });
      await mouse('mouseReleased', r.left + cutCase.x + 80, r.top + cutCase.y + 24, { buttons: 0 });
      await evaluate('__t.frames(3)');
      const afterCut = await evaluate(`__t.R().project(${JSON.stringify(cutCase.wCut)})`);
      const afterRemoved = await evaluate(`__t.R().project(${JSON.stringify(cutCase.wFront)})`);
      const pCut1 = await pose();
      const cutMoved = Math.abs(pCut1.azimuth - pCut0.azimuth) > 0.1;
      const cutDrift = Math.hypot(afterCut.x - beforeCut.x, afterCut.y - beforeCut.y);
      const removedDrift = beforeRemoved && afterRemoved ? Math.hypot(afterRemoved.x - beforeRemoved.x, afterRemoved.y - beforeRemoved.y) : Infinity;
      check('N6b sectioned orbit keeps cut-revealed surface point on its pixel', cutMoved && cutDrift < 1 && removedDrift > 2, { cutDrift: cutDrift.toFixed(3), removedDrift: removedDrift.toFixed(3), sep: cutCase.sep.toFixed(2) });
    } else {
      check('N6b sectioned orbit keeps cut-revealed surface point on its pixel', false, 'no cut-revealed surface found');
    }
    await evaluate(`__t.R().setSectionPlanes([]), __t.R().setViewPreset('iso'), __t.R().fitToView(), __t.frames(3)`);
  }

  // Select with a real click.
  await canvasClick(target.x, target.y);
  await waitFor(`!document.querySelector('.nav-zoom-sel-btn').disabled`, 5000, 'selection');

  // N5: zoom to selection centres the element and fits it inside the canvas.
  {
    const box = await evaluate(`(async () => __t.bbox(await __t.K().elementMesh(${JSON.stringify(ref.modelId)}, ${ref.expressId})))()`);
    const d0 = (await pose()).distance;
    await evaluate(`document.querySelector('.nav-zoom-sel-btn').click(), __t.frames(4)`);
    const p = await pose();
    const centre = box.min.map((v, k) => (v + box.max[k]) / 2);
    const size = Math.hypot(...box.max.map((v, k) => v - box.min[k]));
    const inside = await evaluate(`(() => { const b = ${JSON.stringify(box)}; const r = __t.rect(); let ok = true; for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) { const s = __t.R().project([x, y, z]); if (!s || s.x < 0 || s.y < 0 || s.x > r.width || s.y > r.height) ok = false; } return ok; })()`);
    check('N5 zoom to selection', vnear(p.target, centre, 1e-6 * Math.max(1, size)) && p.distance < d0 && inside, { d0: d0.toFixed(2), d1: p.distance.toFixed(2), inside });
  }

  // N7: first person, one W press walks forward horizontally by max(0.35, min(25, 0.06 d)).
  {
    await evaluate(`document.querySelector('.nav-fp-btn').click(), __t.frames(2)`);
    const navMode = await evaluate(`__t.R().getNavigationMode()`);
    const p0 = await pose();
    const e0 = await evaluate(`__t.eye(${JSON.stringify(p0)})`);
    const step = Math.max(0.35, Math.min(25, p0.distance * 0.06));
    await evaluate(`document.activeElement && document.activeElement.blur(), document.querySelector('canvas.bim-viewport').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    await evaluate('__t.frames(3)');
    const p1 = await pose();
    const e1 = await evaluate(`__t.eye(${JSON.stringify(p1)})`);
    const d = e1.map((v, k) => v - e0[k]);
    const l = await evaluate(`__t.look(${JSON.stringify(p0)})`);
    const lh = Math.hypot(l[0], l[1]);
    const along = (d[0] * l[0] + d[1] * l[1]) / lh;
    const expected = l.map((v) => v * step);
    check('N7 first-person W moves one step along the view', navMode === 'first-person' && vnear(d, expected, 1e-6 * step), { navMode, d, expected, horizontalAlong: along });
    await evaluate(`document.querySelector('.nav-fp-btn').click(), __t.frames(2)`);
  }

  // =================== T-136 BCF ===================
  {
    await evaluate(`__t.R().setViewPreset('iso'), __t.R().fitToView(), __t.frames(3)`);
    // Re-select (zoom/fp changed view): use the known element directly from a fresh pick.
    const t2 = await evaluate(`(async () => { const r = __t.rect(); for (let fy = 0.5; fy < 0.9; fy += 0.05) for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6]) { const ref = await __t.R().pick(r.width * fx, r.height * fy); if (ref) return { x: r.width * fx, y: r.height * fy, ref }; } return null; })()`);
    await canvasClick(t2.x, t2.y);
    await waitFor(`!document.querySelector('.nav-zoom-sel-btn').disabled`, 5000, 'selection 2');
    const lineRe = new RegExp(`^#${t2.ref.expressId}=\\s*IFC[A-Z]+\\('([^']+)'`, 'm');
    const expectedGuid = manyIfc.match(lineRe)?.[1];
    check('B1 element GlobalId from IFC text', !!expectedGuid, { expressId: t2.ref.expressId, expectedGuid });

    await evaluate(`__t.btnByText('.tab-btn', 'BCF').click(), __t.frames(2)`);
    await waitFor(`!!document.querySelector('.bcf-new-topic-title')`, 5000, 'bcf panel');
    await evaluate(`__t.setInput(document.querySelector('.bcf-new-topic-title'), 'Prueba E2E muro'), __t.frames(2)`);
    await evaluate(`document.querySelector('.bcf-add-topic-btn').click(), __t.frames(2)`);
    const cards = await evaluate(`document.querySelectorAll('.bcf-topic-card').length`);
    const createdTitle = await evaluate(`document.querySelector('.bcf-topic-title')?.textContent ?? ''`);
    check('B2 topic created', cards === 1 && createdTitle.includes('Prueba E2E muro'), { cards, createdTitle });
    await evaluate(`document.querySelector('.bcf-topic-card').click(), __t.frames(2)`);
    const P1 = await pose();
    await evaluate(`document.querySelector('.bcf-capture-viewpoint-btn').click()`);
    await waitFor(`!!document.querySelector('.bcf-viewpoint-card')`, 8000, 'viewpoint card');
    const thumb = await evaluate(`(async () => { const img = document.querySelector('.bcf-viewpoint-thumb'); if (!img) return null; await img.decode().catch(() => {}); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return { w: img.naturalWidth, h: img.naturalHeight, colours: seen.size, png: img.src.startsWith('data:image/png') || img.src.startsWith('blob:') }; })()`);
    check('B3 snapshot is a real image', thumb && thumb.png && thumb.w > 0 && Math.max(thumb.w, thumb.h) <= 1500 && thumb.colours > 8, thumb);
    const selCount = await evaluate(`document.querySelector('.bcf-vp-sel-count')?.textContent ?? ''`);
    check('B3b viewpoint lists 1 selected', /\b1\b/.test(selCount), selCount);

    // Restore: move away, apply, pose returns.
    await evaluate(`__t.R().setViewPreset('top'), __t.frames(2)`);
    await evaluate(`document.querySelector('.bcf-apply-viewpoint-btn').click(), __t.frames(4)`);
    const P2 = await pose();
    const e1 = await evaluate(`__t.eye(${JSON.stringify(P1)})`), e2 = await evaluate(`__t.eye(${JSON.stringify(P2)})`);
    const l1 = await evaluate(`__t.look(${JSON.stringify(P1)})`), l2 = await evaluate(`__t.look(${JSON.stringify(P2)})`);
    check('B4 viewpoint restores the camera', vnear(e1, e2, 1e-3) && vnear(l1, l2, 1e-5), { eyeErr: Math.max(...e1.map((v, k) => Math.abs(v - e2[k]))), lookErr: Math.max(...l1.map((v, k) => Math.abs(v - l2[k]))) });

    // Export and read the archive independently.
    await evaluate(`document.querySelector('.bcf-export-btn').click()`);
    await waitFor(`!!window.__gubim_last_bcf__`, 8000, 'bcf export');
    const b64 = await evaluate(`(() => { const b = window.__gubim_last_bcf__.bytes; let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
    const bcfPath = path.join(downloads, 'roundtrip.bcf');
    writeFileSync(bcfPath, Buffer.from(b64, 'base64'));
    const files = unzip(Buffer.from(b64, 'base64'));
    const names = Object.keys(files);
    const version = files['bcf.version']?.toString('utf8') ?? '';
    const vpName = names.find((n) => n.endsWith('.bcfv'));
    const markupName = names.find((n) => n.endsWith('markup.bcf'));
    const png = names.find((n) => n.endsWith('.png'));
    const vp = vpName ? files[vpName].toString('utf8') : '';
    const guidInVp = [...vp.matchAll(/IfcGuid="([^"]+)"/g)].map((m) => m[1]);
    const num = (tag) => { const m = vp.match(new RegExp(`<${tag}>\\s*<X>([^<]+)</X>\\s*<Y>([^<]+)</Y>\\s*<Z>([^<]+)</Z>`)); return m ? [+m[1], +m[2], +m[3]] : null; };
    const camPoint = num('CameraViewPoint'), camDir = num('CameraDirection');
    const dirN = camDir ? camDir.map((v) => v / Math.hypot(...camDir)) : null;
    check('B5 archive is BCF 3.0', /VersionId="3\.0"/.test(version) && !!markupName && !!vpName && !!png, { names });
    check('B6 viewpoint selection is the element GlobalId', guidInVp.includes(expectedGuid), { guidInVp, expectedGuid });
    check('B7 viewpoint camera matches the pose', camPoint && vnear(camPoint, e1, 1e-3) && vnear(dirN, l1, 1e-5), { camPoint, eye: e1 });
    if (png) check('B7b snapshot PNG signature', files[png].subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), png);

    // Delete, then import the file back.
    await evaluate(`document.querySelector('.bcf-delete-topic-btn').click(), __t.frames(2)`);
    await sleep(300);
    const afterDelete = await evaluate(`document.querySelectorAll('.bcf-topic-card').length`);
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.bcf-file-input' });
    await send('DOM.setFileInputFiles', { nodeId, files: [bcfPath.replace(/\//g, '\\')] });
    await waitFor(`document.querySelectorAll('.bcf-topic-card').length === 1`, 8000, 'bcf import');
    const title = await evaluate(`document.querySelector('.bcf-topic-title')?.textContent ?? ''`);
    check('B8 delete then re-import', afterDelete === 0 && title.includes('Prueba E2E muro'), { afterDelete, title });
    await shot('many-bcf');
  }

  // =================== T-137 face cut on SimpleWall ===================
  {
    await load('/samples/SimpleWall.ifc');
    // The wall is #219: a 4000 x 200 profile extruded 4000 mm. Its plan cut is a 4 x 0.2 m ring.
    const probe = await evaluate(`(async () => { const r = __t.rect(); for (let fy = 0.3; fy < 0.8; fy += 0.05) for (let fx = 0.3; fx < 0.8; fx += 0.05) { const ref = await __t.R().pick(r.width * fx, r.height * fy); if (ref && ref.expressId === 219) return ref; } return null; })()`);
    check('F0 wall #219 pickable', !!probe, probe);
    const MID = JSON.stringify(probe.modelId);
    const box = await evaluate(`(async () => __t.bbox(await __t.K().elementMesh(${MID}, 219)))()`);
    const ext = box.max.map((v, k) => v - box.min[k]);
    const thin = ext[0] < ext[1] ? 0 : 1;
    check('F0b wall extents 4 x 0.2 x 4 m', near(Math.max(ext[0], ext[1]), 4, 1e-6) && near(Math.min(ext[0], ext[1]), 0.2, 1e-6) && near(ext[2], 4, 1e-6), ext);
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;

    // Wrap generateDrawing to record what the panel asks for.
    await evaluate(`(() => { const k = __t.K(); if (!k.__wrapped) { const orig = k.generateDrawing.bind(k); k.generateDrawing = (ids, opts, prog) => { window.__lastDrawing = JSON.parse(JSON.stringify(opts)); return orig(ids, opts, prog); }; k.__wrapped = true; } })()`);

    // F1: top view, ortho, pick the top face.
    await evaluate(`__t.R().fitToView(), __t.R().setViewPreset('top'), __t.R().setProjection('orthographic'), __t.frames(3)`);
    await evaluate(`__t.btnByText('.tab-btn', 'Planos').click(), __t.frames(2)`);
    await evaluate(`document.querySelector('.section-pick-face-btn').click(), __t.frames(2)`);
    const topPx = await evaluate(`__t.R().project([${cx}, ${cy}, ${box.max[2]}])`);
    await canvasClick(topPx.x, topPx.y);
    await waitFor(`!!document.querySelector('.dxf-face-summary')`, 5000, 'face summary');
    const summary = await evaluate(`document.querySelector('.dxf-face-summary').textContent`);
    const preset = await evaluate(`document.querySelector('.dxf-cut-preset').value`);
    const m = summary.match(/Origen: \(([-\d.]+), ([-\d.]+), ([-\d.]+)\) m.*Mirada: \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)/s);
    const sOrigin = m ? [+m[1], +m[2], +m[3]] : null, sLook = m ? [+m[4], +m[5], +m[6]] : null;
    check('F1 top face picked', preset === 'face' && sOrigin && near(sOrigin[2], box.max[2], 0.006) && vnear(sLook, [0, 0, -1], 1e-9), { preset, summary });

    // F2: 3D clipping, seen from the front. Points on the wall's front face 0.05 m and 0.5 m below the top.
    const lookPreset = thin === 1 ? 'front' : 'left';
    const faceCoord = thin === 1 ? box.min[1] : box.min[0];
    const pt = (dz) => (thin === 1 ? [cx, faceCoord, box.max[2] - dz] : [faceCoord, cy, box.max[2] - dz]);
    await evaluate(`__t.R().fitToView(), __t.R().setViewPreset('${lookPreset}'), __t.frames(3)`);
    const pickAt = async (p) => evaluate(`(async () => { const s = __t.R().project(${JSON.stringify(p)}); const r = await __t.R().pick(s.x, s.y); return r ? r.expressId : null; })()`);
    const offsetInput = `document.querySelector('.dxf-face-offset')`;
    await evaluate(`__t.setInput(${offsetInput}, 0.1), __t.frames(3)`);
    const cutHigh = await pickAt(pt(0.05)), cutLow = await pickAt(pt(0.5));
    await evaluate(`document.querySelector('.dxf-face-flip').click(), __t.frames(3)`);
    const flipHigh = await pickAt(pt(0.05)), flipLow = await pickAt(pt(0.5));
    await evaluate(`document.querySelector('.dxf-face-flip').click(), __t.frames(3)`);
    check('F2 3D clip follows the face plane', cutHigh !== 219 && cutLow === 219 && flipHigh === 219 && flipLow !== 219, { cutHigh, cutLow, flipHigh, flipLow });
    await shot('wall-clipped-front');

    // F3: generate from the panel; the cut sent is the face plane 0.1 m into the wall.
    await evaluate(`document.querySelector('.dxf-generate-btn').click()`);
    await waitFor(`!!document.querySelector('.drawing-preview svg')`, 20000, 'drawing preview');
    const sent = await evaluate(`window.__lastDrawing`);
    const cut = sent?.cut;
    check('F3 panel sends a plane cut 0.1 m below the top', cut?.kind === 'plane' && near(cut.origin[2], box.max[2] - 0.1, 1e-9) && vnear(cut.normal, [0, 0, -1], 1e-12), cut);
    const planeDxf = dxfStats((await kernelDxf(MID, cut)).text);
    const planDxf = dxfStats((await kernelDxf(MID, { kind: 'plan', elevation: box.max[2] - 0.1 })).text);
    check('F3b face cut = plan cut, ring 8.4 m', near(planeDxf.total, 8.4, 1e-6) && near(planDxf.total, 8.4, 1e-6) && vnear(planeDxf.extents, planDxf.extents, 1e-9), { plane: planeDxf.total, plan: planDxf.total, ext: planeDxf.extents });

    // F4: the panel's DXF and SVG downloads.
    await evaluate(`__t.btnByText('.btn', 'Exportar DXF').click()`);
    await evaluate(`__t.btnByText('.btn', 'Exportar SVG').click()`);
    let dl = [];
    for (let i = 0; i < 50 && dl.filter((f) => /\.(dxf|svg)$/i.test(f)).length < 2; i++) { await sleep(100); dl = readdirSync(downloads); }
    const dxfFile = dl.find((f) => /\.dxf$/i.test(f)), svgFile = dl.find((f) => /\.svg$/i.test(f));
    const dxfText = dxfFile ? readFileSync(path.join(downloads, dxfFile), 'latin1') : '';
    const svgText = svgFile ? readFileSync(path.join(downloads, svgFile), 'utf8') : '';
    const dl3 = dxfText ? dxfStats(dxfText) : null;
    check('F4 downloads', /^\s*0\s*\r?\nSECTION/.test(dxfText) && /<svg[\s>]/.test(svgText) && dl3 && dl3.count > 0, { dl, dxfSegs: dl3?.count, svgBytes: svgText.length });

    // F5: a vertical face, picked from the front, cut through the middle of the wall.
    await evaluate(`__t.R().fitToView(), __t.R().setViewPreset('${lookPreset}'), __t.frames(3)`);
    await evaluate(`document.querySelector('.dxf-pick-face-btn').click(), __t.frames(2)`);
    const facePt = thin === 1 ? [cx, faceCoord, box.min[2] + 3] : [faceCoord, cy, box.min[2] + 3];
    const fpx = await evaluate(`__t.R().project(${JSON.stringify(facePt)})`);
    await canvasClick(fpx.x, fpx.y);
    await sleep(300);
    await evaluate(`__t.setInput(${offsetInput}, 0.1), __t.frames(2)`);
    await evaluate(`document.querySelector('.dxf-generate-btn').click()`);
    await waitFor(`window.__lastDrawing && window.__lastDrawing.cut.normal[2] === 0`, 20000, 'vertical drawing');
    const vcut = (await evaluate(`window.__lastDrawing`)).cut;
    const expectedLook = thin === 1 ? [0, 1, 0] : [1, 0, 0];
    const along = vcut.origin[thin];
    check('F5 vertical face cut', vnear(vcut.normal, expectedLook, 1e-9) && near(along, faceCoord + 0.1, 1e-9), vcut);
    const vd = dxfStats((await kernelDxf(MID, vcut)).text);
    const w = vd.extents[2] - vd.extents[0], h = vd.extents[3] - vd.extents[1];
    // Elevation of the wall: 4 x 4 m, Z up on the sheet. Ring with the door notch 0.915 x 2.134:
    // 16 + 2 x 2.134 = 20.268 m on the wall's layer.
    const wallLayer = Object.entries(vd.byLayer).find(([k]) => /wall/i.test(k));
    check('F5b elevation sheet 4 x 4 m, wall ring 20.268 m', near(w, 4, 1e-6) && near(h, 4, 1e-6) && wallLayer && near(wallLayer[1], 20.268, 1e-6), { w, h, byLayer: vd.byLayer });
    await shot('wall-elevation');

    // ---- T-148: a plan's view range, top (the cut) and bottom ----
    const setValue = (selector, value) => evaluate(`__t.setInput(document.querySelector('${selector}'), ${JSON.stringify(String(value))}), __t.frames(2)`);
    const topInput = `[...document.querySelectorAll('.dxf-cut-preset ~ * input, input.select')].find((i) => i.closest('div') && i.closest('div').textContent.includes('ARRIBA'))`;
    await setValue('.dxf-cut-preset', 'plan');
    await evaluate(`__t.setInput(${topInput}, '2'), __t.frames(2)`);
    // V1: a typed bottom reaches the kernel as top minus bottom.
    await setValue('.dxf-bottom-mode', 'height');
    await setValue('.dxf-bottom', '0.5');
    const summaryV1 = await evaluate(`document.querySelector('.dxf-range-summary').textContent`);
    await evaluate(`window.__lastDrawing = null; document.querySelector('.dxf-generate-btn').click()`);
    await waitFor(`window.__lastDrawing && window.__lastDrawing.cut.kind === 'plan'`, 20000, 'plan with a range');
    const sentV1 = (await evaluate('window.__lastDrawing')).cut;
    check('V1 typed bottom sends depth = top - bottom', sentV1.elevation === 2 && near(sentV1.depth, 1.5, 1e-12) && /de 2\.00 m a 0\.50 m \(1\.50 m\)/.test(summaryV1), { sentV1, summaryV1 });
    // V2: a bottom at or above the top is refused before the kernel is asked.
    await setValue('.dxf-bottom', '2.5');
    const summaryV2 = await evaluate(`document.querySelector('.dxf-range-summary').textContent`);
    await evaluate(`window.__lastDrawing = null; document.querySelector('.dxf-generate-btn').click()`);
    await sleep(800);
    const sentV2 = await evaluate('window.__lastDrawing');
    check('V2 a bottom above the top is refused', sentV2 === null && /por debajo del corte/.test(summaryV2), { summaryV2, sentV2 });
    // V3: the default bottom is the floor of the storey the cut stands in.
    await setValue('.dxf-bottom-mode', 'storey');
    const level = await evaluate(`(async () => { const t = await __t.K().getSpatialTree(${MID}); const out = []; const walk = (n) => { if (n.type === 'IfcBuildingStorey' && typeof n.level === 'number') out.push(n.level); n.children.forEach(walk); }; walk(t.root); return out.filter((l) => l <= 2).sort((a, b) => b - a)[0] ?? null; })()`);
    await evaluate(`window.__lastDrawing = null; document.querySelector('.dxf-generate-btn').click()`);
    await waitFor(`window.__lastDrawing && window.__lastDrawing.cut.kind === 'plan'`, 20000, 'plan with the storey range');
    const sentV3 = (await evaluate('window.__lastDrawing')).cut;
    check('V3 default bottom is the storey floor', level !== null && near(sentV3.depth, 2 - level + 0.05, 1e-9), { level, sentV3 });
    // V4: the top picked on the wall's top face, seen from above.
    await evaluate(`__t.R().fitToView(), __t.R().setViewPreset('top'), __t.frames(3)`);
    await evaluate(`document.querySelector('.dxf-pick-top').click(), __t.frames(2)`);
    const topPick = await evaluate(`__t.R().project([${cx}, ${cy}, ${box.max[2]}])`);
    await canvasClick(topPick.x, topPick.y);
    await waitFor(`Math.abs(parseFloat(${topInput}.value) - ${box.max[2]}) < 1e-3`, 5000, 'top picked').catch(() => null);
    const pickedTop = await evaluate(`parseFloat(${topInput}.value)`);
    check('V4 top picked on the model', near(pickedTop, box.max[2], 1e-3), { pickedTop, wallTop: box.max[2] });
    // V5: the range shown in 3D as a section box from the bottom to the top.
    await setValue('.dxf-bottom-mode', 'height');
    await setValue('.dxf-bottom', '1');
    await evaluate(`document.querySelector('.dxf-show-range').click(), __t.frames(3)`);
    const planes = await evaluate(`JSON.parse(JSON.stringify(window.__gubim_dev__.activeRenderer.sectionPlanes ?? []))`);
    const up = planes.find((p) => near(p.normal[2], 1, 1e-9)), down = planes.find((p) => near(p.normal[2], -1, 1e-9));
    check('V5 the range shown in 3D clips from the bottom to the top', planes.length === 6 && up && down && near(up.offset, pickedTop, 1e-9) && near(down.offset, -1, 1e-9), { planes: planes.length, up, down });
    await setValue('.section-mode', 'off');
  }
} catch (err) {
  check('HARNESS', false, String(err?.stack ?? err));
} finally {
  check('C0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  writeFileSync(path.join(outDir, `results-${mode}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${mode}: ${results.length - failed}/${results.length} pass`);
  process.exitCode = failed ? 1 : 0;
  cdp.close();
  proc.kill();
}
