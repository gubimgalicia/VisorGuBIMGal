import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  GIS_OFFLINE_ERROR_THRESHOLD,
  initialGisOnlineState,
  reduceGisOnlineState
} from '../src/ui/viewer/gisOnline.ts';
import { WebFilePort } from '../src/infrastructure/files/WebFilePort.ts';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
  passed++;
}

await test('gisOnline marks offline immediately when navigator.onLine is false', () => {
  const s0 = initialGisOnlineState(false);
  assert.equal(s0.status, 'offline');
  const s1 = reduceGisOnlineState(s0, 'browser-online');
  assert.equal(s1.status, 'online');
  const s2 = reduceGisOnlineState(s1, 'browser-offline');
  assert.equal(s2.status, 'offline');
});

await test('gisOnline transitions offline after threshold consecutive tile errors and recovers on load or retry', () => {
  let state = initialGisOnlineState(true);
  assert.equal(state.status, 'online');
  for (let i = 1; i < GIS_OFFLINE_ERROR_THRESHOLD; i++) {
    state = reduceGisOnlineState(state, 'tile-error');
    assert.equal(state.status, 'online', 'single transient error should not flip offline');
  }
  state = reduceGisOnlineState(state, 'tile-error');
  assert.equal(state.status, 'offline');

  // Retrying resets status to online and zeroes consecutive errors.
  const retried = reduceGisOnlineState(state, 'retry');
  assert.equal(retried.status, 'online');
  assert.equal(retried.consecutiveTileErrors, 0);

  // Tile load marks online and records that a tile loaded.
  const loaded = reduceGisOnlineState(state, 'tile-load');
  assert.equal(loaded.status, 'online');
  assert.equal(loaded.anyTileLoaded, true);
});

await test('WebFilePort implements FilePort cleanly for web host', async () => {
  const port = new WebFilePort();
  assert.equal(port.usesNativePicker, false);
  assert.equal(await port.pickIfcFile(), null);
  assert.equal(await port.openPath('C:\\model.ifc'), null);
  assert.deepEqual(await port.consumeInitialFiles(), []);
  const unsub = port.onExternalOpen(() => {});
  assert.equal(typeof unsub, 'function');
  unsub();
});

await test('no desktop/Tauri host branches leak outside composition.ts and TauriFilePort.ts (E2)', () => {
  const root = path.resolve('src');
  const allowed = new Set([
    path.join(root, 'infrastructure', 'composition.ts'),
    path.join(root, 'infrastructure', 'files', 'TauriFilePort.ts')
  ]);
  const violations = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        if (allowed.has(full)) continue;
        const text = readFileSync(full, 'utf8');
        if (/__TAURI__|isTauriHost|@tauri-apps|TauriFilePort/.test(text)) {
          violations.push(path.relative(root, full));
        }
      }
    }
  }
  walk(root);
  assert.deepEqual(violations, [], `Tauri/desktop references found outside composition: ${violations.join(', ')}`);
});

await test('vite.config.ts preserves /VisorGuBIMGal/ for web production and uses ./ for desktop (E3)', () => {
  const cfg = readFileSync(path.resolve('vite.config.ts'), 'utf8');
  assert.match(cfg, /GUBIM_DESKTOP/);
  assert.match(cfg, /'\/VisorGuBIMGal\/'/);
  assert.match(cfg, /'\.\/'/);
});

await test('src-tauri/tauri.conf.json defines a strict non-null Content Security Policy', () => {
  const conf = JSON.parse(readFileSync(path.resolve('src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = conf?.app?.security?.csp;
  assert.equal(typeof csp, 'string', 'CSP must be a non-null policy string');
  assert.ok(csp.includes("default-src 'self'"), 'CSP must restrict default-src to self');
  assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"), 'CSP must allow only self scripts + wasm');
  assert.ok(csp.includes("object-src 'none'"), 'CSP must disallow plugins/objects');
  assert.ok(csp.includes('http://gubim-file.localhost'), 'CSP must allow local gubim-file protocol');
  assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval (only wasm-unsafe-eval)');
});

await test('index.css has balanced braces so .gis-map-stage is never swallowed by a CSS syntax error', () => {
  const css = readFileSync(path.resolve('src', 'ui', 'styles', 'index.css'), 'utf8');
  // Strip comments and check brace balance, and ensure .gis-map-stage starts at brace depth 0.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  const stageIdx = stripped.indexOf('.gis-map-stage');
  assert.ok(stageIdx > 0, '.gis-map-stage selector must exist');
  for (let i = 0; i < stripped.length; i++) {
    if (i === stageIdx) {
      assert.equal(depth, 0, `.gis-map-stage must be at top-level CSS depth (got ${depth})`);
    }
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
    assert.ok(depth >= 0, `unexpected closing brace at offset ${i}`);
  }
  assert.equal(depth, 0, `unbalanced CSS braces: final depth ${depth}`);
});

await test('Header IFC file input supports multi-file upload', () => {
  const header = readFileSync(path.resolve('src', 'ui', 'components', 'Header.tsx'), 'utf8');
  assert.match(header, /type="file"[\s\S]*?accept="\.ifc"[\s\S]*?multiple/);
});

console.log(`\nt169-desktop-test: ${passed}/${passed} pass`);
