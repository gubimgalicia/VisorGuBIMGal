// Do two kernel builds draw the same thing? For changes that may not keep the bytes (A11 vertex
// compression, A13 instancing, docs/09): both builds stream the same file in one process, every
// batch is expanded to absolute triangles (expand-batch.mjs), and each element's triangles are
// compared within a tolerance: --tol-mm (default 0.05) plus half a 16-bit step for q16 batches.
//
//   node --experimental-strip-types scripts/bench/check-equivalent.mjs <basePkg> <headPkg> <file.ifc>... [--tol-mm 0.05] [--max-deg 0.5]
//
// Exit code 1 if any element differs in triangle count, record colour or flags, position beyond
// the tolerance, or normal beyond --max-deg degrees.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandBatch } from './expand-batch.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const TOL = opt('--tol-mm', 0.05) / 1000;
const MAX_DEG = opt('--max-deg', 0.5);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--tol-mm', '--max-deg'].includes(args[i - 1]));
const [basePkg, headPkg, ...files] = positional;
if (!basePkg || !headPkg || files.length === 0) {
  console.error('usage: check-equivalent.mjs <basePkg> <headPkg> <file.ifc>...');
  process.exit(2);
}

async function load(pkg) {
  // A query string gives each build its own module instance.
  const url = pathToFileURL(path.join(path.resolve(pkg), 'wasm_api.js')).href + `?build=${encodeURIComponent(pkg)}`;
  const mod = await import(url);
  mod.initSync({ module: readFileSync(path.join(path.resolve(pkg), 'wasm_api_bg.wasm')) });
  return mod;
}

/** One BatchView as a plain batch. v1 now; v2 by the method names of docs/09 section 4. */
function readView(view) {
  const bounds = view.bounds();
  const batch = {
    origin: Array.from(view.origin()),
    box: { min: [bounds[0], bounds[1], bounds[2]], max: [bounds[3], bounds[4], bounds[5]] },
    vertexFormat: typeof view.vertexFormat === 'function' ? view.vertexFormat() : 'f32',
    positions: view.takePositions(),
    normals: view.takeNormals(),
    indices: view.takeIndices(),
    meshTable: view.takeMeshTable()
  };
  if (typeof view.takeInstanceTable === 'function') {
    batch.instanceTable = view.takeInstanceTable();
    batch.instanceTransforms = view.takeInstanceTransforms();
    batch.shapes = view.takeShapes();
  }
  view.free();
  return batch;
}

/** Streams a file, yielding { elements: Map<expressId, records[]> } per batch. */
function* stream(mod, bytes) {
  const model = new mod.Model(bytes);
  const shapes = new Map();
  model.startStream();
  for (;;) {
    const view = model.nextBatch(65536);
    if (!view) break;
    const batch = readView(view);
    const elements = new Map();
    expandBatch(batch, shapes, (record) => {
      if (!elements.has(record.expressId)) elements.set(record.expressId, []);
      elements.get(record.expressId).push(record);
    });
    yield elements;
  }
  model.finishStream();
  model.free();
}

const key = (r) => `${r.rgba}:${r.flags & 0xf}`;

/** Compares two lists of records of one element. Returns null or a description. */
function compareElement(a, b, worst) {
  const group = (records) => {
    const g = new Map();
    for (const r of records) {
      if (!g.has(key(r))) g.set(key(r), []);
      g.get(key(r)).push(r);
    }
    return g;
  };
  const ga = group(a), gb = group(b);
  const keys = new Set([...ga.keys(), ...gb.keys()]);
  for (const k of keys) {
    const ra = ga.get(k) ?? [], rb = gb.get(k) ?? [];
    const ta = ra.reduce((n, r) => n + r.triangles.length, 0), tb = rb.reduce((n, r) => n + r.triangles.length, 0);
    if (ta !== tb) return `colour/flags ${k}: ${ta / 9} triangles against ${tb / 9}`;
    // Each side may be off by its own quantisation error, so both count.
    const tolerance = TOL + Math.max(0, ...ra.map((r) => r.tolerance)) + Math.max(0, ...rb.map((r) => r.tolerance));
    const flat = (records) => records.map((r) => ({ t: r.triangles, n: r.normals }));
    const result =
      compareTriangles(flat(ra), flat(rb), tolerance, false) ?? compareTriangles(sorted(ra), sorted(rb), tolerance, true);
    if (result.error) return `colour/flags ${k}: ${result.error}`;
    worst.position = Math.max(worst.position, result.position);
    worst.degrees = Math.max(worst.degrees, result.degrees);
  }
  return null;
}

// Triangles in record order; on a mismatch, again with records and triangles sorted, since a
// format may group an element's records differently.
function sorted(records) {
  const tris = [];
  for (const r of records) for (let i = 0; i < r.triangles.length; i += 9) tris.push({ t: r.triangles.subarray(i, i + 9), n: r.normals.subarray(i, i + 9) });
  const sortKey = (x) => [0, 1, 2].map((a) => Math.round(((x.t[a] + x.t[3 + a] + x.t[6 + a]) / 3) * 1000));
  tris.sort((p, q) => { const kp = sortKey(p), kq = sortKey(q); return kp[0] - kq[0] || kp[1] - kq[1] || kp[2] - kq[2]; });
  return tris;
}

/** null means «try again sorted»; only the last try reports an error. */
function compareTriangles(a, b, tolerance, lastTry) {
  const flatten = (list) => {
    const n = list.reduce((s, x) => s + x.t.length, 0);
    const t = new Float64Array(n), nn = new Float64Array(n);
    let at = 0;
    for (const x of list) { t.set(x.t, at); nn.set(x.n, at); at += x.t.length; }
    return { t, n: nn };
  };
  const fa = flatten(a), fb = flatten(b);
  let position = 0, degrees = 0;
  for (let i = 0; i < fa.t.length; i += 3) {
    const d = Math.hypot(fa.t[i] - fb.t[i], fa.t[i + 1] - fb.t[i + 1], fa.t[i + 2] - fb.t[i + 2]);
    position = Math.max(position, d);
    // atan2(|a × b|, a · b): exact for equal vectors, which acos of a dot near 1 is not.
    const [ax, ay, az, bx, by, bz] = [fa.n[i], fa.n[i + 1], fa.n[i + 2], fb.n[i], fb.n[i + 1], fb.n[i + 2]];
    const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    degrees = Math.max(degrees, (Math.atan2(cross, ax * bx + ay * by + az * bz) * 180) / Math.PI);
  }
  if (position > tolerance || degrees > MAX_DEG) {
    if (!lastTry) return null;
    return { error: position > tolerance ? `position off by ${(position * 1000).toFixed(3)} mm (tolerance ${(tolerance * 1000).toFixed(3)} mm)` : `normal off by ${degrees.toFixed(2)} degrees` };
  }
  return { position, degrees };
}

const base = await load(basePkg);
const head = await load(headPkg);
let failures = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  const sa = stream(base, bytes), sb = stream(head, bytes);
  const pending = [new Map(), new Map()];
  const done = [false, false];
  const seenBatches = [new Map(), new Map()];
  const worst = { position: 0, degrees: 0 };
  let elements = 0;
  const problems = [];
  const take = (side) => {
    const next = (side === 0 ? sa : sb).next();
    if (next.done) { done[side] = true; return; }
    for (const [id, records] of next.value) {
      seenBatches[side].set(id, (seenBatches[side].get(id) ?? 0) + 1);
      pending[side].set(id, [...(pending[side].get(id) ?? []), ...records]);
    }
  };
  const settle = (final) => {
    for (const [id, a] of pending[0]) {
      const b = pending[1].get(id);
      if (!b) continue;
      // An element split over batches may still have pieces to come: compare it at the end.
      if (!final && ((seenBatches[0].get(id) ?? 0) > 1 || (seenBatches[1].get(id) ?? 0) > 1)) continue;
      const problem = compareElement(a, b, worst);
      if (problem) problems.push(`#${id}: ${problem}`);
      elements++;
      pending[0].delete(id);
      pending[1].delete(id);
    }
  };
  while (!done[0] || !done[1]) {
    if (!done[0] && (pending[0].size <= pending[1].size || done[1])) take(0);
    else take(1);
    settle(false);
  }
  settle(true);
  for (const id of pending[0].keys()) problems.push(`#${id}: only in the base build`);
  for (const id of pending[1].keys()) problems.push(`#${id}: only in the new build`);
  const name = path.basename(file);
  if (problems.length) {
    failures++;
    console.log(`DIFF ${name}: ${problems.length} of ${elements + problems.length} elements`);
    for (const p of problems.slice(0, 5)) console.log(`     ${p}`);
  } else {
    console.log(`SAME ${name.padEnd(48)} ${String(elements).padStart(6)} elements, worst ${(worst.position * 1000).toFixed(4)} mm, ${worst.degrees.toFixed(3)}°`);
  }
}
process.exit(failures ? 1 : 0);
