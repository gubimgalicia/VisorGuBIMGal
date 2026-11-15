// Kernel benchmark (backlog D2). Each measurement is a fresh Node process with a fresh WASM
// instance, as a Worker holds one model. Times are CPU work in the kernel, no browser or GPU.
//
//   node scripts/bench/bench.mjs                       this tree's kernel, a table of medians
//   node scripts/bench/bench.mjs --base-ref <git-ref>  build <git-ref>'s kernel and compare
//   node scripts/bench/bench.mjs --base-pkg <dir>      compare with an already built package
//
// Options: --runs N (default 5), --threshold 0.10, --min-ms 50, --summary <file> (Markdown,
// e.g. $GITHUB_STEP_SUMMARY), --extra <file.ifc> (repeatable: real models from a local disk,
// never committed). Compared runs alternate base and head (ABBA) so machine drift falls on both.
// A workload regresses when median(head) / median(base) > 1 + threshold and the difference is
// over --min-ms. Exit code 1 on any regression, 0 otherwise (including no comparable base).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const HEAD_PKG = path.join(REPO, 'src/infrastructure/kernel/pkg');
const WORK = path.join(os.tmpdir(), 'gubim-bench');
mkdirSync(WORK, { recursive: true });

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const RUNS = Number(opt('--runs', 5));
const THRESHOLD = Number(opt('--threshold', 0.1));
const MIN_MS = Number(opt('--min-ms', 50));
// cpu: process CPU time, robust when the machine is busy (default). wall: elapsed time.
const METRIC = opt('--metric', 'cpu');
if (!['cpu', 'wall'].includes(METRIC)) throw new Error('--metric is cpu or wall');
const value = (r) => (METRIC === 'cpu' ? r.ms.cpu : r.ms.total);
const SUMMARY = opt('--summary');
const baseRef = opt('--base-ref');
let basePkg = opt('--base-pkg');

const log = (s = '') => console.log(s);
const summary = [];
const md = (s = '') => summary.push(s);
function finish(code) {
  if (SUMMARY) appendFileSync(SUMMARY, summary.join('\n') + '\n');
  process.exit(code);
}

// ---------- Workloads ----------
function stress(walls) {
  const file = path.join(WORK, `stress-${walls}.ifc`);
  if (!existsSync(file)) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/make-stress-ifc.mjs'), String(walls), file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('stress model');
  }
  return file;
}
const ifcIn = (dir) => readdirSync(path.join(REPO, dir)).filter((f) => f.toLowerCase().endsWith('.ifc')).sort().map((f) => path.join(REPO, dir, f));
const plan = (elevation) => ({ cut: { kind: 'plan', elevation }, frame: { kind: 'project' }, includeProjection: true, includeHiddenLines: true, includeHatching: true });
const workloads = [
  { name: 'stress 5k walls', files: [stress(5000)] },
  { name: 'stress 20k walls', files: [stress(20000)] },
  { name: 'fixtures x3', files: [...ifcIn('public/samples'), ...ifcIn('test/fixtures'), ...ifcIn('test/fixtures/authored')], repeat: 3 },
  { name: 'plan drawing 5k walls', files: [stress(5000)], drawing: plan(1.2) },
  ...all('--extra').map((f) => ({ name: path.basename(f), files: [path.resolve(f)] }))
];
workloads.forEach((w, i) => {
  w.file = path.join(WORK, `workload-${i}.json`);
  writeFileSync(w.file, JSON.stringify(w));
});

function measure(pkg, w) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', path.join(HERE, 'run-one.mjs'), pkg, w.file], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`${w.name} failed on ${pkg}:\n${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

// ---------- Base kernel ----------
function buildBase(ref) {
  const sha = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  if (!sha) { log(`Base ${ref} not found.`); return null; }
  const cached = path.join(WORK, `pkg-${sha}`);
  if (existsSync(path.join(cached, 'wasm_api_bg.wasm'))) return { pkg: cached, sha };
  const wt = path.join(WORK, 'base-worktree');
  if (!existsSync(path.join(wt, '.git'))) {
    rmSync(wt, { recursive: true, force: true });
    const add = spawnSync('git', ['worktree', 'add', '--detach', wt, sha], { cwd: REPO, stdio: 'inherit' });
    if (add.status !== 0) return null;
  } else {
    spawnSync('git', ['checkout', '--detach', '--force', sha], { cwd: wt, stdio: 'inherit' });
  }
  if (!existsSync(path.join(wt, 'scripts/build-kernel.mjs')) || !existsSync(path.join(wt, 'crates/wasm-api'))) {
    log(`Base ${sha.slice(0, 7)} has no kernel to build.`);
    return null;
  }
  log(`Building the base kernel at ${sha.slice(0, 7)}...`);
  const b = spawnSync(process.execPath, ['scripts/build-kernel.mjs'], { cwd: wt, stdio: 'inherit' });
  if (b.status !== 0) { log('The base kernel did not build.'); return null; }
  cpSync(path.join(wt, 'src/infrastructure/kernel/pkg'), cached, { recursive: true });
  return { pkg: cached, sha };
}

if (!existsSync(path.join(HEAD_PKG, 'wasm_api_bg.wasm'))) { console.error('Build this kernel first: npm run kernel'); process.exit(2); }
let baseLabel = basePkg ? path.basename(basePkg) : null;
if (baseRef) {
  const built = buildBase(baseRef);
  if (!built) {
    md('### Kernel benchmark\n\nNo comparable base kernel; nothing compared.');
    finish(0);
  }
  basePkg = built.pkg;
  baseLabel = built.sha.slice(0, 7);
}

// ---------- Runs ----------
const results = workloads.map(() => ({ base: [], head: [] }));
for (let run = 0; run < RUNS; run++) {
  workloads.forEach((w, i) => {
    // ABBA: alternate which build goes first, so drift does not favour one.
    const order = basePkg ? (run % 2 === 0 ? ['base', 'head'] : ['head', 'base']) : ['head'];
    for (const which of order) results[i][which].push(measure(which === 'base' ? basePkg : HEAD_PKG, w));
  });
  log(`run ${run + 1}/${RUNS} done`);
}

// A workload that looks slower is measured again with twice the runs before it counts, so a
// noisy moment on a shared runner does not fail the build on its own.
if (basePkg) {
  workloads.forEach((w, i) => {
    const h = median(results[i].head.map(value));
    const b = median(results[i].base.map(value));
    if (!(h / b > 1 + THRESHOLD && h - b > MIN_MS)) return;
    log(`${w.name} looks ${((h / b - 1) * 100).toFixed(1)} % slower: measuring again`);
    for (let run = 0; run < 2 * RUNS; run++) {
      for (const which of run % 2 === 0 ? ['head', 'base'] : ['base', 'head']) {
        results[i][which].push(measure(which === 'base' ? basePkg : HEAD_PKG, w));
      }
    }
  });
}

let regressions = 0;
md(basePkg ? `### Kernel benchmark: this commit against ${baseLabel}` : '### Kernel benchmark');
md('');
md(`Median of ${RUNS} fresh-process runs per build${basePkg ? ', alternating ABBA' : ''}. Metric: ${METRIC === 'cpu' ? 'process CPU time' : 'elapsed time'}. Fails above +${Math.round(THRESHOLD * 100)} % and ${MIN_MS} ms.`);
md('');
md(basePkg ? '| Workload | Base | This | Change | Spread | Peak WASM | Output |' : '| Workload | Median | Spread | Peak WASM | Breakdown |');
md(basePkg ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|');
workloads.forEach((w, i) => {
  const head = results[i].head;
  const h = median(head.map(value));
  const hMem = Math.max(...head.map((r) => r.wasmMB));
  if (!basePkg) {
    const parts = Object.keys(head[0].ms).filter((k) => k !== 'total' && k !== 'cpu').map((k) => `${k} ${fmt(median(head.map((r) => r.ms[k])))}`).join(', ');
    md(`| ${w.name} | ${fmt(h)} | ${(spread(head.map(value)) * 100).toFixed(1)} % | ${hMem} MB | ${parts} |`);
    return;
  }
  const base = results[i].base;
  const b = median(base.map(value));
  const bMem = Math.max(...base.map((r) => r.wasmMB));
  const ratio = h / b;
  const slower = ratio > 1 + THRESHOLD && h - b > MIN_MS;
  const memWorse = hMem > bMem * (1 + THRESHOLD) && hMem - bMem > 8;
  if (slower || memWorse) regressions++;
  const sameOut = JSON.stringify(base[0].out) === JSON.stringify(head[0].out);
  const change = `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)} %${slower ? ' **slower**' : ''}`;
  const spr = Math.max(spread(base.map(value)), spread(head.map(value)));
  md(`| ${w.name} | ${fmt(b)} | ${fmt(h)} | ${change} | ${(spr * 100).toFixed(1)} % | ${bMem} → ${hMem} MB${memWorse ? ' **more**' : ''} | ${sameOut ? 'same' : 'changed: ' + Object.keys(head[0].out).filter((k) => head[0].out[k] !== base[0].out[k]).join(', ')} |`);
});
md('');
if (basePkg) md(regressions ? `**${regressions} regression(s).**` : 'No regression.');
log(summary.join('\n'));
finish(regressions ? 1 : 0);
