// Browser check for T-138: export the visible scene to GLB and read it back independently.
// Usage: node glb-check.mjs <gpu|gl2> <baseUrl> <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const results = [];
const check = (id, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`); };
const near = (a, b, t) => Math.abs(a - b) <= t;

const { proc, wsUrl } = await launch({ port: 9320 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9), profileDir: path.resolve(outDir, `profile-glb-${mode}`) });
const cdp = await connect(wsUrl);
const errors = [];
cdp.on('Runtime.consoleAPICalled', (p) => p.type === 'error' && errors.push(p.args.map((a) => a.value ?? a.description).join(' ')));
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry;
  if (e.level !== 'error' && e.level !== 'warning') return;
  // Remote map tiles may fail offline or on CI; a missing favicon is not the app's.
  let local = true;
  try { const h = new URL(e.url ?? '').hostname; local = !h || h === '127.0.0.1' || h === 'localhost'; } catch {}
  if (e.source === 'network' && (!local || /favicon\.ico$/.test(e.url ?? ''))) return;
  errors.push(`log ${e.level}: ${e.text.slice(0, 300)}${e.url ? ' ' + e.url : ''}`);
});
await cdp.send('Log.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outDir, `dl-glb-${mode}`) });
await applyMode(cdp.send, mode);
const ev = cdp.evaluate;
async function waitFor(expr, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const v = await ev(expr); if (v) return v; } catch {} await sleep(100); } throw new Error('timeout ' + expr); }

function readGlb(buf) {
  const magic = buf.toString('ascii', 0, 4), version = buf.readUInt32LE(4), length = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12), jsonType = buf.readUInt32LE(16);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binAt = 20 + jsonLen, binLen = buf.readUInt32LE(binAt), binType = buf.readUInt32LE(binAt + 4);
  const bin = buf.subarray(binAt + 8, binAt + 8 + binLen);
  return { magic, version, length, jsonLen, jsonType, binLen, binType, json, bin };
}
// World box of one node in IFC Z-up: glTF (x, y, z) = IFC (x, z, -y), so IFC = (x, -z, y).
function nodeIfcBox(g, node) {
  const t = node.translation ?? [0, 0, 0];
  const mesh = g.json.meshes[node.mesh];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.primitives) {
    const acc = g.json.accessors[prim.attributes.POSITION];
    const view = g.json.bufferViews[acc.bufferView];
    const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride = view.byteStride ?? 12;
    for (let i = 0; i < acc.count; i++) {
      const x = g.bin.readFloatLE(off + i * stride) + t[0], y = g.bin.readFloatLE(off + i * stride + 4) + t[1], z = g.bin.readFloatLE(off + i * stride + 8) + t[2];
      const ifc = [x, -z, y];
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], ifc[k]); mx[k] = Math.max(mx[k], ifc[k]); }
    }
  }
  return { min: mn, max: mx };
}
async function exportGlb() {
  await ev(`window.__gubim_last_glb__ = undefined; [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Exportar GLB')).click()`);
  await waitFor(`!!window.__gubim_last_glb__`);
  const b64 = await ev(`(() => { const b = new Uint8Array(window.__gubim_last_glb__.bytes); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  return Buffer.from(b64, 'base64');
}

try {
  await cdp.send('Page.navigate', { url: `${base}?model=/samples/SimpleWall.ifc` });
  await waitFor(`!!document.querySelector('.model-card-meta') && /elem/.test(document.querySelector('.model-card-meta').textContent)`);
  await sleep(1500);
  // Wall #219 box from the kernel, through the renderer's pick of its model.
  const wallBox = await ev(`(async () => { const R = window.__gubim_dev__.renderer; const c = document.querySelector('canvas.bim-viewport').getBoundingClientRect(); for (let fy = 0.3; fy < 0.8; fy += 0.05) for (let fx = 0.3; fx < 0.8; fx += 0.05) { const ref = await R.pick(c.width * fx, c.height * fy); if (ref && ref.expressId === 219) { const m = await window.__gubim_kernel__.elementMesh(ref.modelId, 219); const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], m.positions[i + k]); mx[k] = Math.max(mx[k], m.positions[i + k]); } return { min: mn, max: mx }; } } return null; })()`);

  const buf = await exportGlb();
  writeFileSync(path.join(outDir, `simplewall-${mode}.glb`), buf);
  const g = readGlb(buf);
  check('G1 GLB header and chunks', g.magic === 'glTF' && g.version === 2 && g.length === buf.length && g.jsonType === 0x4e4f534a && g.binType === 0x004e4942 && g.jsonLen % 4 === 0 && g.binLen % 4 === 0 && g.json.asset?.version === '2.0', { length: g.length, file: buf.length, jsonLen: g.jsonLen, binLen: g.binLen });
  const named = g.json.nodes.filter((n) => n.mesh !== undefined);
  const names = named.map((n) => n.name);
  // SimpleWall: wall 1F6umJ5H50aeL3A1As_wTm and door 1F6umJ5H50aeL3A1As_wUF have geometry; the opening is not drawn.
  check('G2 nodes are the wall and the door by GlobalId', named.length === 2 && names.some((n) => n?.includes('1F6umJ5H50aeL3A1As_wTm')) && names.some((n) => n?.includes('1F6umJ5H50aeL3A1As_wUF')), names);
  const wallNode = named.find((n) => n.name?.includes('1F6umJ5H50aeL3A1As_wTm'));
  const box = wallNode ? nodeIfcBox(g, wallNode) : null;
  check('G3 wall box after Y-up round trip equals the kernel box (1 mm)', box && wallBox && box.min.every((v, k) => near(v, wallBox.min[k], 1e-3)) && box.max.every((v, k) => near(v, wallBox.max[k], 1e-3)), { glb: box, kernel: wallBox });
  const accOk = g.json.accessors.every((a) => a.componentType === 5126 ? (!a.type || a.type !== 'VEC3' || (a.min && a.max)) : true);
  const viewAligned = g.json.bufferViews.every((v) => (v.byteOffset ?? 0) % 4 === 0 && v.byteOffset + v.byteLength <= g.binLen);
  check('G4 accessors and buffer views valid', accOk && viewAligned && g.json.buffers?.[0]?.byteLength <= g.binLen, { views: g.json.bufferViews.length });

  // Hide the walls class, export again: only the door remains.
  await ev(`(() => { const s = document.querySelector('.display-class'); const opt = [...s.options].find((o) => /Wall/i.test(o.value)); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, opt.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  await ev(`document.querySelector('.display-hide-class').click()`);
  await sleep(300);
  const g2 = readGlb(await exportGlb());
  const names2 = g2.json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name);
  check('G5 hidden class is left out', names2.length === 1 && names2[0]?.includes('1F6umJ5H50aeL3A1As_wUF'), names2);
  await ev(`document.querySelector('.display-show-all').click()`);
  await sleep(200);
  // Isolate the walls class: only the wall.
  await ev(`document.querySelector('.display-isolate-class').click()`);
  await sleep(300);
  const g3 = readGlb(await exportGlb());
  const names3 = g3.json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name);
  check('G6 isolated class only', names3.length === 1 && names3[0]?.includes('1F6umJ5H50aeL3A1As_wTm'), names3);
} catch (e) {
  check('HARNESS', false, String(e?.stack ?? e));
} finally {
  check('C0 console errors', errors.length === 0, errors.slice(0, 3));
  console.log(`${mode}: ${results.filter(Boolean).length}/${results.length} pass`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
  cdp.close();
  proc.kill();
}
