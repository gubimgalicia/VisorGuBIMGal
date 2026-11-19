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
import { takeBatch } from '../lib/take-batch.mjs';

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

/** One BatchView as a plain batch, from either kernel API. Shapes and instances come with A13. */
function readView(view) {
  return takeBatch(view);
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

// Closed (bit 3) is left out of the key: an instance takes it from its shape, and a copy that
// rounding closes or opens once placed may differ (docs/09 section 2). Those are counted apart.
const CLOSED = 1 << 3;
const key = (r) => `${r.rgba}:${r.flags & 0x7}`;

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
  const closedOf = (records) => records.filter((r) => r.flags & CLOSED).length;
  if (closedOf(a) !== closedOf(b)) worst.closedDiffers = (worst.closedDiffers ?? 0) + 1;
  const keys = new Set([...ga.keys(), ...gb.keys()]);
  for (const k of keys) {
    let ra = ga.get(k) ?? [], rb = gb.get(k) ?? [];
    let ta = ra.reduce((n, r) => n + r.triangles.length, 0), tb = rb.reduce((n, r) => n + r.triangles.length, 0);
    if (ta !== tb) {
      // A shape drops a triangle of exactly zero area that rounding gives a sliver of area once
      // placed (A13): one that draws nothing. Compare again without slivers (SLIVER_HEIGHT).
      [ra, rb] = [ra.map(withoutSlivers), rb.map(withoutSlivers)];
      ta = ra.reduce((n, r) => n + r.triangles.length, 0);
      tb = rb.reduce((n, r) => n + r.triangles.length, 0);
      if (ta !== tb) return `colour/flags ${k}: ${ta / 9} triangles against ${tb / 9}`;
      worst.slivers = (worst.slivers ?? 0) + 1;
    }
    // Each side may be off by its own quantisation error, so both count.
    // f32 positions relative to a batch origin round by up to half an ulp of their size, and an
    // instance's matrix product a few more: allow 4 ulps of the farthest coordinate per side.
    const rounding = (records) => Math.max(0, ...records.map((r) => r.extent ?? 0)) * 4 * 2 ** -24;
    const tolerance = TOL + rounding(ra) + rounding(rb) + Math.max(0, ...ra.map((r) => r.tolerance)) + Math.max(0, ...rb.map((r) => r.tolerance));
    // Per axis too: rounding moves each coordinate by at most half that axis's step (docs/05).
    // Instances rotate their shape's axes, so they have no per-axis bound and fall back to the distance.
    const axisOf = (records) => [0, 1, 2].map((a) => Math.max(0, ...records.map((r) => (r.axisTolerance ? r.axisTolerance[a] : r.tolerance))));
    const [axa, axb] = [axisOf(ra), axisOf(rb)];
    const axisTolerance = [0, 1, 2].map((a) => TOL + rounding(ra) + rounding(rb) + axa[a] + axb[a]);
    const flat = (records) => records.map((r) => ({ t: r.triangles, n: r.normals }));
    const result =
      compareTriangles(flat(ra), flat(rb), tolerance, axisTolerance, false) ??
      compareTriangles(...matched(ra, rb, tolerance), tolerance, axisTolerance, true);
    if (result.error) return `colour/flags ${k}: ${result.error}`;
    worst.position = Math.max(worst.position, result.position);
    worst.degrees = Math.max(worst.degrees, result.degrees);
  }
  return null;
}

/**
 * Metres: a triangle thinner than this, its height over its longest side, draws nothing at any
 * zoom. A shape drops a triangle of exactly zero area that rounding gives a height of about
 * 1e-11 m once placed; f32 positions relative to a batch origin move heights by up to about
 * 5e-6 m, well under this. A sliver's normal is noise from its source, so it is not compared.
 */
const SLIVER_HEIGHT = 1e-4;

/** Height over the longest side of the triangle at offset i of a flat triangle array. */
function heightAt(t, i) {
  const u = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
  const v = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
  const w = [t[i + 6] - t[i + 3], t[i + 7] - t[i + 4], t[i + 8] - t[i + 5]];
  const twiceArea = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  const longest = Math.max(Math.hypot(...u), Math.hypot(...v), Math.hypot(...w));
  return longest > 0 ? twiceArea / longest : 0;
}

/** A record without its sliver triangles (SLIVER_HEIGHT). */
function withoutSlivers(record) {
  const keep = [];
  const t = record.triangles;
  for (let i = 0; i < t.length; i += 9) if (heightAt(t, i) >= SLIVER_HEIGHT) keep.push(i);
  const pick = (array) => {
    const out = new Float64Array(keep.length * 9);
    keep.forEach((i, k) => out.set(array.subarray(i, i + 9), k * 9));
    return out;
  };
  return { ...record, triangles: pick(record.triangles), normals: pick(record.normals) };
}

/**
 * The triangles of both sides paired by nearest centroid, as two lists in pair order: a format
 * may group an element's records differently (instances come after records), and sorting by a
 * rounded centroid pairs back-to-back faces and neighbouring small triangles wrongly. A grid of
 * cells a few tolerances wide finds candidates; among those within reach, the nearest centroid
 * wins, then the closest normal. An unpaired triangle is paired with what is left, in order, so
 * the comparison reports it.
 */
function matched(ra, rb, tolerance) {
  const split = (records) => {
    const tris = [];
    for (const r of records) for (let i = 0; i < r.triangles.length; i += 9) tris.push({ t: r.triangles.subarray(i, i + 9), n: r.normals.subarray(i, i + 9) });
    return tris;
  };
  const a = split(ra), b = split(rb);
  const centroid = (x) => [0, 1, 2].map((k) => (x.t[k] + x.t[3 + k] + x.t[6 + k]) / 3);
  const cell = Math.max(tolerance * 4, 1e-4);
  const keyOf = (c) => c.map((v) => Math.floor(v / cell));
  const grid = new Map();
  b.forEach((x, i) => {
    x.c = centroid(x);
    const k = keyOf(x.c).join(',');
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const used = new Uint8Array(b.length);
  const left = [], right = [], unpaired = [];
  for (const x of a) {
    const c = centroid(x);
    const [kx, ky, kz] = keyOf(c);
    let best = -1, bestDistance = Infinity, bestDot = -Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(`${kx + dx},${ky + dy},${kz + dz}`) ?? []) {
        if (used[i]) continue;
        const d = Math.hypot(c[0] - b[i].c[0], c[1] - b[i].c[1], c[2] - b[i].c[2]);
        const dot = x.n[0] * b[i].n[0] + x.n[1] * b[i].n[1] + x.n[2] * b[i].n[2];
        // Within reach, the closest normal wins: back-to-back faces share a centroid.
        const reach = d <= 2 * tolerance;
        const bestReach = bestDistance <= 2 * tolerance;
        const better = reach ? !bestReach || dot > bestDot + 1e-9 || (Math.abs(dot - bestDot) <= 1e-9 && d < bestDistance) : !bestReach && d < bestDistance;
        if (better) {
          best = i; bestDistance = d; bestDot = dot;
        }
      }
    }
    if (best < 0) { unpaired.push(x); continue; }
    used[best] = 1;
    left.push(x);
    right.push(b[best]);
  }
  const rest = b.filter((_, i) => !used[i]);
  unpaired.forEach((x, i) => { left.push(x); right.push(rest[i] ?? x); });
  return [left, right];
}

// Triangles in record order; on a mismatch, again paired by nearest centroid (matched).
function sorted(records) {
  const tris = [];
  for (const r of records) for (let i = 0; i < r.triangles.length; i += 9) tris.push({ t: r.triangles.subarray(i, i + 9), n: r.normals.subarray(i, i + 9) });
  const sortKey = (x) => [0, 1, 2].map((a) => Math.round(((x.t[a] + x.t[3 + a] + x.t[6 + a]) / 3) * 1000));
  tris.sort((p, q) => { const kp = sortKey(p), kq = sortKey(q); return kp[0] - kq[0] || kp[1] - kq[1] || kp[2] - kq[2]; });
  return tris;
}

/** null means «try again sorted»; only the last try reports an error. */
function compareTriangles(a, b, tolerance, axisTolerance, lastTry) {
  const flatten = (list) => {
    const n = list.reduce((s, x) => s + x.t.length, 0);
    const t = new Float64Array(n), nn = new Float64Array(n);
    let at = 0;
    for (const x of list) { t.set(x.t, at); nn.set(x.n, at); at += x.t.length; }
    return { t, n: nn };
  };
  const fa = flatten(a), fb = flatten(b);
  let position = 0, degrees = 0, axisExcess = null;
  for (let i = 0; i < fa.t.length; i += 3) {
    const d = Math.hypot(fa.t[i] - fb.t[i], fa.t[i + 1] - fb.t[i + 1], fa.t[i + 2] - fb.t[i + 2]);
    position = Math.max(position, d);
    for (let axis = 0; axis < 3; axis++) {
      const off = Math.abs(fa.t[i + axis] - fb.t[i + axis]);
      if (off > axisTolerance[axis] && !axisExcess) axisExcess = { axis, off, limit: axisTolerance[axis] };
    }
    // A sliver's normal is noise from its source triangle: skip it (SLIVER_HEIGHT).
    const corner = i - (i % 9);
    if (heightAt(fa.t, corner) < SLIVER_HEIGHT || heightAt(fb.t, corner) < SLIVER_HEIGHT) continue;
    // atan2(|a × b|, a · b): exact for equal vectors, which acos of a dot near 1 is not.
    const [ax, ay, az, bx, by, bz] = [fa.n[i], fa.n[i + 1], fa.n[i + 2], fb.n[i], fb.n[i + 1], fb.n[i + 2]];
    const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    degrees = Math.max(degrees, (Math.atan2(cross, ax * bx + ay * by + az * bz) * 180) / Math.PI);
  }
  if (position > tolerance || degrees > MAX_DEG || axisExcess) {
    if (!lastTry) return null;
    if (position > tolerance) return { error: `position off by ${(position * 1000).toFixed(3)} mm (tolerance ${(tolerance * 1000).toFixed(3)} mm)` };
    if (axisExcess) return { error: `axis ${'xyz'[axisExcess.axis]} off by ${(axisExcess.off * 1000).toFixed(3)} mm (tolerance ${(axisExcess.limit * 1000).toFixed(3)} mm)` };
    return { error: `normal off by ${degrees.toFixed(2)} degrees` };
  }
  return { position, degrees };
}

const base = await load(basePkg);
const head = await load(headPkg);
let failures = 0;
/** The error opening a file raises, or null when it opens. */
function openError(mod, bytes) {
  try {
    new mod.Model(bytes).free();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

let skipped = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  // A file both builds refuse alike, an unsupported schema say, has nothing to compare.
  const [refusedA, refusedB] = [openError(base, bytes), openError(head, bytes)];
  if (refusedA !== null || refusedB !== null) {
    if (refusedA === refusedB) {
      skipped++;
      console.log(`SKIP ${path.basename(file)}: both refuse it: ${refusedA.slice(0, 100)}`);
    } else {
      failures++;
      console.log(`DIFF ${path.basename(file)}: base ${refusedA ?? 'opens'}, new ${refusedB ?? 'opens'}`);
    }
    continue;
  }
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
    console.log(`SAME ${name.padEnd(48)} ${String(elements).padStart(6)} elements, worst ${(worst.position * 1000).toFixed(4)} mm, ${worst.degrees.toFixed(3)}°${worst.closedDiffers ? `, Closed differs on ${worst.closedDiffers}` : ''}${worst.slivers ? `, slivers on ${worst.slivers}` : ''}`);
  }
}
console.log(`${files.length - skipped - failures} same, ${failures} different, ${skipped} refused by both`);
process.exit(failures ? 1 : 0);
