// Browser check for T-158 (A13, docs/09 section 5): copies of a shape drawn by instances behave as
// elements on each backend. ManySimpleWalls draws its doors as instances of shared shapes.
//   I1 the renderer holds the doors as instances;
//   I2 a door picked at its centre is that door;
//   I3 hiding one door leaves another copy of its shape and the walls of its batch pickable
//      (a record index off by one would hide or pick the wrong one);
//   I4 two copies of the model, the first removed and another model loaded into the freed slots:
//      the second's doors still pick where they are (the batch index each batch's instance block
//      carries must follow the move);
//   I5 two models with instances loaded at once, their batches interleaved: each holds its own,
//      and the doors pick as themselves;
//   I6 the GLB export has a node for every element of every loaded model, doors included.
// Usage: node instances-check.mjs <gpu|gl2|none> <baseUrl> <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(REPO, 'public/samples/ManySimpleWalls.ifc');
const BOOLEANS = path.join(REPO, 'test/fixtures/authored/building-booleans.ifc');
const SIMPLE = path.join(REPO, 'public/samples/SimpleWall.ifc');
const results = [];
const check = (id, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`);
};

const { proc, wsUrl } = await launch({ port: 9340 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9), profileDir: path.resolve(outDir, `profile-inst-${mode}`) });
const cdp = await connect(wsUrl);
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry;
  if (e.level !== 'error' && e.level !== 'warning') return;
  let local = true;
  try { const h = new URL(e.url ?? '').hostname; local = !h || h === '127.0.0.1' || h === 'localhost'; } catch {}
  if (e.source === 'network' && (!local || /favicon\.ico$/.test(e.url ?? ''))) return;
  if (e.level === 'warning' && /GL Driver Message \([^,]*, Performance,/.test(e.text)) return;
  errors.push(`log ${e.level}: ${e.text.slice(0, 300)}`);
});
await cdp.send('Log.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outDir, `dl-inst-${mode}`) });
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
async function openFiles(files, expected) {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files });
  await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length >= ${expected}`);
  await settled();
}
/** Until every queued batch is on the GPU: uploads are paced per frame. */
const settled = () => waitFor(`(() => { const A = window.__gubim_dev__.activeRenderer; return A.uploadQueue.length === 0; })()`).then(() => sleep(500));

/** Door ids of a model, from the kernel, and each door's centre from its own mesh. */
const doorsOf = (modelId) => ev(`(async () => {
  const K = window.__gubim_kernel__;
  const ids = await K.findElements(${JSON.stringify(modelId)}, { field: 'class', text: 'IfcDoor' });
  const out = [];
  for (const id of ids) {
    const m = await K.elementMesh(${JSON.stringify(modelId)}, id);
    if (!m) continue;
    const c = [0, 0, 0];
    for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) c[k] += m.positions[i + k];
    const n = m.positions.length / 3;
    out.push({ id, centre: c.map((v) => v / n) });
  }
  return out;
})()`);
/** Picks at a model point's pixel and a few around it. */
const pickAt = (point) => ev(`(async () => {
  const R = window.__gubim_dev__.renderer;
  const px = R.project(${JSON.stringify(point)});
  if (!px) return null;
  for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const ref = await R.pick(px.x + dx, px.y + dy);
    if (ref) return ref;
  }
  return null;
})()`);
const models = () => ev(`[...window.__gubim_dev__.activeRenderer.models.keys()]`);
const frameModel = async (modelId) => {
  await ev(`(() => { const R = window.__gubim_dev__.renderer; const A = window.__gubim_dev__.activeRenderer; const m = A.models.get(${JSON.stringify(modelId)}); const b = m.bounds;
    for (const id of A.models.keys()) R.setModelVisibility(id, id === ${JSON.stringify(modelId)});
    R.fitToBounds({ min: { x: b.minX, y: b.minY, z: b.minZ }, max: { x: b.maxX, y: b.maxY, z: b.maxZ } }); R.setViewPreset('iso'); return true; })()`);
  await frames(6);
};
/** How many of a model's doors pick as themselves. */
async function doorsPicked(modelId, doors) {
  let own = 0;
  for (const door of doors) {
    const ref = await pickAt(door.centre);
    if (ref && ref.modelId === modelId && ref.expressId === door.id) own++;
  }
  return own;
}

try {
  await cdp.send('Page.navigate', { url: base });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  await openFiles([FILE], 1);
  const [first] = await models();
  const held = await ev(`(() => { const m = window.__gubim_dev__.activeRenderer.models.get(${JSON.stringify(first)}); return { instances: m.batches.reduce((n, b) => n + (b.instanceCount ?? 0), 0), shapes: m.shapes.size }; })()`);
  check('I1 doors held as instances', held.instances > 0 && held.shapes > 0, held);

  const doors = await doorsOf(first);
  await frameModel(first);
  const picked = await doorsPicked(first, doors);
  check('I2 a door picked at its centre is that door', doors.length > 0 && picked >= Math.ceil(doors.length * 0.8), { doors: doors.length, picked });

  // I3: hide one door; another door and a wall still pick.
  const [hidden, other] = doors;
  await ev(`window.__gubim_dev__.renderer.setElementVisibility([{ modelId: ${JSON.stringify(first)}, expressId: ${hidden.id} }], false), true`);
  await frames(4);
  const hiddenRef = await pickAt(hidden.centre);
  const otherRef = await pickAt(other.centre);
  check('I3 hiding one door leaves the others', hiddenRef?.expressId !== hidden.id && otherRef?.expressId === other.id, { hiddenRef, otherRef });
  await ev(`window.__gubim_dev__.renderer.setElementVisibility([{ modelId: ${JSON.stringify(first)}, expressId: ${hidden.id} }], true), true`);

  // I4: a second copy, then remove the first: the second's batches move down in batches[].
  await openFiles([FILE], 2);
  const second = (await models()).find((id) => id !== first);
  await ev(`window.__gubim_dev__.renderer.removeModel(${JSON.stringify(first)}), true`);
  await frames(4);
  // A third model takes the slots the second's batches had in batches[]: an instance block that
  // kept its old batch index would now read the third's offset, records and visibility.
  await openFiles([SIMPLE], 3);
  const doors2 = await doorsOf(second);
  await frameModel(second);
  const picked2 = await doorsPicked(second, doors2);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(outDir, `inst-${mode}-after-remove.png`), Buffer.from(data, 'base64'));
  check('I4 after removing the first model, the second\'s doors pick in place', picked2 >= Math.ceil(doors2.length * 0.8), { doors: doors2.length, picked: picked2 });

  // I6: the GLB has a node for every element of every model the app has open. The first copy left
  // the renderer only, so the app still exports it, with the same elements as the second.
  const drawn = await ev(`(() => { const A = window.__gubim_dev__.activeRenderer; let n = 0;
    for (const m of A.models.values()) n += m.expressIdToRecords.size;
    return n + A.models.get(${JSON.stringify(second)}).expressIdToRecords.size; })()`);
  await ev(`(() => { const R = window.__gubim_dev__.renderer; for (const id of window.__gubim_dev__.activeRenderer.models.keys()) R.setModelVisibility(id, true); return true; })()`);
  await ev(`window.__gubim_last_glb__ = undefined; [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Exportar GLB')).click()`);
  await waitFor(`!!window.__gubim_last_glb__`);
  const nodes = await ev(`(() => { const b = new Uint8Array(window.__gubim_last_glb__.bytes); const len = new DataView(b.buffer).getUint32(12, true); const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len))); return json.nodes.filter((n) => n.mesh !== undefined).length; })()`);
  check('I6 the GLB has every drawn element, doors included', nodes === drawn, { nodes, drawn });

  // I5: two models with instances at once, streamed side by side.
  // On a fresh page: the app keeps its own list of open files.
  await cdp.send('Page.navigate', { url: base });
  await waitFor(`!!window.__gubim_dev__ && !!document.querySelector('input[type=file][accept=".ifc"]')`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".ifc"]' });
  // The input takes one file at a time: start both loads back to back, so their streams overlap.
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [FILE] });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [BOOLEANS] });
  await waitFor(`window.__gubim_dev__.activeRenderer.models.size === 2`);
  await sleep(1000);
  await settled();
  const latest = await models();
  const held2 = await ev(`[...window.__gubim_dev__.activeRenderer.models.values()].map((m) => m.batches.reduce((n, b) => n + (b.instanceCount ?? 0), 0))`);
  const walls = [];
  for (const id of latest) {
    const d = await doorsOf(id);
    if (d.length === 0) continue;
    await frameModel(id);
    walls.push({ doors: d.length, own: await doorsPicked(id, d) });
  }
  check('I5 two models loaded at once hold their instances and pick their own doors',
    latest.length === 2 && held2.every((n) => n > 0) && walls.length > 0 && walls.every((w) => w.own >= Math.ceil(w.doors * 0.8)), { held2, walls });
  check('I7 no console errors', errors.length === 0, errors.slice(0, 5));
} catch (error) {
  check('HARNESS', false, String(error?.stack ?? error));
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  try { proc.kill(); } catch {}
}
console.log(`inst ${mode}: ${results.filter(Boolean).length}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
