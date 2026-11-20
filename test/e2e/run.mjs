// Runs the browser suites against a Vite dev server it starts itself.
// E2E_MODES: comma-separated backends (default gpu,gl2,none). E2E_SUITES: tc,e2e,glb (default all).
// E2E_OUT: output folder, outside the repo (default <tmp>/gubim-e2e). Exit code 1 if any suite fails.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PORT = Number(process.env.E2E_PORT ?? 5173);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.E2E_OUT ?? path.join(os.tmpdir(), 'gubim-e2e');
const MODES = (process.env.E2E_MODES ?? 'gpu,gl2,none').split(',').map((m) => m.trim()).filter(Boolean);
const SUITES = { tc: 'tc.mjs', e2e: 'e2e.mjs', glb: 'glb-check.mjs', fmt: 'formats-check.mjs', inst: 'instances-check.mjs', edge: 'edges-check.mjs', walk: 'walk-check.mjs' };
const chosen = (process.env.E2E_SUITES ?? 'tc,e2e,glb,fmt,inst,edge,walk').split(',').map((s) => s.trim()).filter(Boolean);
if (path.resolve(OUT).startsWith(REPO)) throw new Error('E2E_OUT must be outside the repo: Chrome profiles there crash the Vite watcher');
mkdirSync(OUT, { recursive: true });

try { await fetch(BASE); console.error(`Port ${PORT} is already in use: stop that server or set E2E_PORT`); process.exit(1); } catch {}
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] });
let viteExited = false;
vite.on('exit', () => { viteExited = true; });
const stop = () => { try { vite.kill(); } catch {} };
process.on('exit', stop);

let up = false;
for (let i = 0; i < 300 && !up && !viteExited; i++) {
  try { up = (await fetch(BASE)).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) { console.error('Vite did not start'); process.exit(1); }

const run = (script, mode) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, script), mode, BASE, OUT], { stdio: 'inherit' });
  child.on('exit', (code) => resolve(code ?? 1));
});

const summary = [];
for (const mode of MODES) {
  for (const suite of chosen) {
    if (!SUITES[suite]) throw new Error(`unknown suite ${suite}`);
    console.log(`\n=== ${suite} on ${mode} ===`);
    const code = await run(SUITES[suite], mode);
    summary.push({ suite, mode, ok: code === 0 });
  }
}
stop();
console.log('\nSummary');
for (const s of summary) console.log(`${s.ok ? 'PASS' : 'FAIL'} ${s.suite} ${s.mode}`);
console.log(`Output: ${OUT}`);
process.exit(summary.every((s) => s.ok) ? 0 : 1);
