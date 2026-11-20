// Browser check for T-165 (C13 step 3: model comparison UI) on one backend.
// Opens two modified versions of public/samples/ManySimpleWalls.ifc:
//   - ManySimpleWalls_v1.ifc (before): removes door #759 (GlobalId 3h37bI$YfB8OJnFE62T1hD).
//   - ManySimpleWalls_v2.ifc (after):  removes door #856 (GlobalId 3h37bI$YfB8OJnFE62T1hk) and
//     renames wall #219 from 'Basic Wall:Outside wall:346660' to 'Basic Wall:Outside wall:346660-v2'.
// Checks:
//   C1 panel counts and change-kind breakdown equal diffModels(beforeSnapshots, afterSnapshots);
//   C2 grouped list entries match diffModels and bind removed -> before, added/changed -> after;
//   C3 clicking a removed entry selects & frames it in before; clicking an added entry selects & frames it in after;
//   C4 view is coloured by status through ColorByBar / setElementColors (green, red, amber, faded);
//   C5 clearing the comparison restores the previous colour-by mode and renderer colour overrides;
//   C6 no console errors.
// Usage: node compare-check.mjs <gpu|gl2|none> <baseUrl> <outDir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffModels } from '../../src/domain/compare/modelDiff.ts';
import { launch, connect, sleep, applyMode } from './cdp.mjs';

const [mode = 'gpu', base = 'http://127.0.0.1:5173/', outDir = './out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = path.resolve(REPO, 'public/samples/ManySimpleWalls.ifc');

/** Removes a single IFC product `#id` and its direct relationship references from a STEP text. */
function removeIfcElement(ifcText, id) {
  const tokenRe = new RegExp(`#${id}\\b`);
  const defRe = new RegExp(`^#${id}\\s*=`);
  const singleRelRe = new RegExp(`\\(\\s*#${id}\\s*\\)|,\\s*#${id}\\s*\\)`);
  const listItemLeadingRe = new RegExp(`#${id}\\s*,\\s*`, 'g');
  const listItemTrailingRe = new RegExp(`,\\s*#${id}\\b`, 'g');
  const lines = ifcText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (defRe.test(line)) continue;
    if (tokenRe.test(line)) {
      if (singleRelRe.test(line)) continue;
      out.push(line.replace(listItemLeadingRe, '').replace(listItemTrailingRe, ''));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// Create the two modified versions outside the repository in outDir.
const baseText = readFileSync(SAMPLE, 'utf8');
const v1Path = path.join(outDir, `ManySimpleWalls_v1_${mode}.ifc`);
const v2Path = path.join(outDir, `ManySimpleWalls_v2_${mode}.ifc`);
const v1Text = removeIfcElement(baseText, 759);
const v2Text = removeIfcElement(baseText, 856).replace(
  "'Basic Wall:Outside wall:346660'",
  "'Basic Wall:Outside wall:346660-v2'"
);
writeFileSync(v1Path, v1Text, 'utf8');
writeFileSync(v2Path, v2Text, 'utf8');

const results = [];
const check = (id, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`);
};

const port = 9360 + ({ gpu: 1, gl2: 2, none: 3 }[mode] ?? 9);
const { proc, wsUrl } = await launch({
  port,
  profileDir: path.resolve(outDir, `profile-compare-${mode}`)
});
const cdp = await connect(wsUrl);
const errors = [];
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '));
});
cdp.on('Runtime.exceptionThrown', (p) => {
  errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
});
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry;
  if (e.level !== 'error' && e.level !== 'warning') return;
  let local = true;
  try {
    const h = new URL(e.url ?? '').hostname;
    local = !h || h === '127.0.0.1' || h === 'localhost';
  } catch {}
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
    try {
      const v = await ev(expr);
      if (v) return v;
    } catch {}
    await sleep(100);
  }
  throw new Error('timeout ' + expr);
}
const frames = (n = 4) =>
  ev(
    `new Promise((res) => { let i = 0; const f = () => (++i >= ${n} ? res(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`
  );
const setSelect = (selector, value) =>
  ev(
    `(() => { const s = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
  );

async function openLocal(filePath, expectedReady) {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file][accept=".ifc"]'
  });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(filePath)] });
  await waitFor(`document.querySelectorAll('.model-card[data-status="ready"]').length === ${expectedReady}`);
  await sleep(600);
}

async function fullShot(name) {
  await frames(4);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(outDir, `compare-${mode}-${name}.png`), Buffer.from(data, 'base64'));
}

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send('Page.navigate', { url: base });
  await waitFor(
    `!!window.__gubim_dev__ && !!window.__gubim_kernel__ && !!document.querySelector('input[type=file][accept=".ifc"]')`
  );

  // Load both versions: v1 (before) and v2 (after).
  await openLocal(v1Path, 1);
  await openLocal(v2Path, 2);
  await ev(`window.__gubim_dev__.renderer.setViewPreset('iso'), window.__gubim_dev__.renderer.fitToView(), true`);
  await frames(4);

  const modelIds = await ev(`[...window.__gubim_dev__.activeRenderer.models.keys()]`);
  const [beforeModelId, afterModelId] = modelIds;

  // Compute expected diff independently in Node from the kernel's snapshots.
  const [beforeSnaps, afterSnaps] = await ev(
    `(async () => { const K = window.__gubim_kernel__; return [await K.getElementSnapshots(${JSON.stringify(beforeModelId)}), await K.getElementSnapshots(${JSON.stringify(afterModelId)})]; })()`
  );
  const expected = diffModels(beforeSnaps, afterSnaps);
  const expectedByKind = { type: 0, name: 0, properties: 0, geometry: 0 };
  for (const pair of expected.changed) {
    for (const kind of pair.changes) expectedByKind[kind]++;
  }

  // Enable colour-by-class BEFORE comparison so C5 verifies restoring a non-default colour mode.
  await setSelect('.color-by-select', 'class');
  await waitFor(`document.querySelectorAll('.color-legend-item').length > 0`);
  await frames(3);
  const preCompareClassColors = await ev(
    `(() => { const m = window.__gubim_dev__.activeRenderer.models; return Object.fromEntries([...m.entries()].map(([id, st]) => [id, [...(st.colorOverrides?.entries() ?? [])]])); })()`
  );

  // Open Compare tab, choose v1 -> v2, run diff.
  await ev(`document.querySelector('.tab-compare').click(), true`);
  await waitFor(`!!document.querySelector('.compare-run-btn')`);
  await setSelect('.compare-before-select', beforeModelId);
  await setSelect('.compare-after-select', afterModelId);
  await ev(`document.querySelector('.compare-run-btn').click(), true`);
  await waitFor(`!!document.querySelector('.compare-summary')`);
  await frames(5);

  const uiCounts = await ev(`(() => {
    const read = (sel) => Number(document.querySelector(sel)?.getAttribute('data-count'));
    const byKind = {};
    for (const el of document.querySelectorAll('.compare-kind-badge')) {
      byKind[el.getAttribute('data-change-kind')] = Number(el.getAttribute('data-count'));
    }
    return {
      added: read('.compare-count-added'),
      removed: read('.compare-count-removed'),
      changed: read('.compare-count-changed'),
      unchanged: read('.compare-count-unchanged'),
      byKind
    };
  })()`);

  check(
    'C1 panel counts and change-kind breakdown equal diffModels result',
    expected.added.length === 1 &&
      expected.removed.length === 1 &&
      expected.changed.length === 1 &&
      uiCounts.added === expected.added.length &&
      uiCounts.removed === expected.removed.length &&
      uiCounts.changed === expected.changed.length &&
      uiCounts.unchanged === expected.unchanged &&
      JSON.stringify(uiCounts.byKind) === JSON.stringify(expectedByKind),
    { uiCounts, expected: { added: expected.added.length, removed: expected.removed.length, changed: expected.changed.length, unchanged: expected.unchanged, byKind: expectedByKind } }
  );

  const uiEntries = await ev(`[...document.querySelectorAll('.compare-entry')].map((el) => ({
    category: el.getAttribute('data-category'),
    globalId: el.getAttribute('data-global-id'),
    modelId: el.getAttribute('data-model-id'),
    expressId: Number(el.getAttribute('data-express-id'))
  }))`);
  const addedEntry = uiEntries.find((e) => e.category === 'added');
  const removedEntry = uiEntries.find((e) => e.category === 'removed');
  const changedEntry = uiEntries.find((e) => e.category === 'changed');
  check(
    'C2 grouped entries bind removed to before and added/changed to after',
    uiEntries.length === expected.added.length + expected.removed.length + expected.changed.length &&
      addedEntry?.globalId === expected.added[0].globalId &&
      addedEntry?.modelId === afterModelId &&
      addedEntry?.expressId === expected.added[0].expressId &&
      removedEntry?.globalId === expected.removed[0].globalId &&
      removedEntry?.modelId === beforeModelId &&
      removedEntry?.expressId === expected.removed[0].expressId &&
      changedEntry?.globalId === expected.changed[0].after.globalId &&
      changedEntry?.modelId === afterModelId &&
      changedEntry?.expressId === expected.changed[0].after.expressId,
    { uiEntries }
  );

  // Screenshot of the comparison panel and coloured view before zooming into one element.
  await fullShot('panel-and-coloured-view');

  // C4: check ColorByBar mode, legend and renderer colorOverrides.
  const colorState = await ev(`(() => {
    const sel = document.querySelector('.color-by-select')?.value;
    const legend = [...document.querySelectorAll('.color-legend-item')].map((li) => ({
      label: li.getAttribute('data-label'),
      count: Number(li.querySelector('.color-legend-count')?.textContent?.trim())
    }));
    const models = window.__gubim_dev__.activeRenderer.models;
    const beforeMap = models.get(${JSON.stringify(beforeModelId)})?.colorOverrides;
    const afterMap = models.get(${JSON.stringify(afterModelId)})?.colorOverrides;
    return {
      sel,
      legend,
      removedRgba: beforeMap?.get(${expected.removed[0].expressId}) ?? null,
      addedRgba: afterMap?.get(${expected.added[0].expressId}) ?? null,
      changedBeforeRgba: beforeMap?.get(${expected.changed[0].before.expressId}) ?? null,
      changedAfterRgba: afterMap?.get(${expected.changed[0].after.expressId}) ?? null,
      unchangedCountBefore: [...(beforeMap?.values() ?? [])].filter((v) => v === 0x64748bff).length,
      unchangedCountAfter: [...(afterMap?.values() ?? [])].filter((v) => v === 0x64748bff).length
    };
  })()`);
  check(
    'C4 view coloured by status via ColorByBar and setElementColors',
    colorState.sel === 'compare' &&
      colorState.legend.length === 4 &&
      colorState.addedRgba === 0x22c55eff &&
      colorState.removedRgba === 0xef4444ff &&
      colorState.changedBeforeRgba === 0xf59e0bff &&
      colorState.changedAfterRgba === 0xf59e0bff &&
      colorState.unchangedCountBefore === expected.unchanged &&
      colorState.unchangedCountAfter === expected.unchanged,
    colorState
  );

  // C3: click removed entry (in before) and added entry (in after), verify selection and camera framing.
  const poseBefore = await ev(`window.__gubim_dev__.renderer.getCameraPose()`);
  await ev(`document.querySelector('.compare-entry[data-category="removed"]').click(), true`);
  await waitFor(`document.querySelector('.compare-entry[data-category="removed"].selected') !== null`);
  await sleep(400);
  await frames(4);
  const poseAfterRemoved = await ev(`window.__gubim_dev__.renderer.getCameraPose()`);
  const removedPropsHeading = await ev(`document.querySelector('.sidebar-right .panel-body')?.textContent ?? ''`);

  await ev(`document.querySelector('.compare-entry[data-category="added"]').click(), true`);
  await waitFor(`document.querySelector('.compare-entry[data-category="added"].selected') !== null`);
  await sleep(400);
  await frames(4);
  const poseAfterAdded = await ev(`window.__gubim_dev__.renderer.getCameraPose()`);
  const addedPropsHeading = await ev(`document.querySelector('.sidebar-right .panel-body')?.textContent ?? ''`);
  await fullShot('selected-added');

  const dist = (a, b) => Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]);
  check(
    'C3 clicking removed/added entries selects and frames each in its model',
    dist(poseBefore, poseAfterRemoved) > 0.1 &&
      dist(poseAfterRemoved, poseAfterAdded) > 0.1 &&
      removedPropsHeading.includes(expected.removed[0].globalId) &&
      addedPropsHeading.includes(expected.added[0].globalId),
    {
      movedToRemoved: dist(poseBefore, poseAfterRemoved).toFixed(3),
      movedToAdded: dist(poseAfterRemoved, poseAfterAdded).toFixed(3),
      removedMatched: removedPropsHeading.includes(expected.removed[0].globalId),
      addedMatched: addedPropsHeading.includes(expected.added[0].globalId)
    }
  );

  // C5: clearing the comparison restores the previous colours (class mode).
  await ev(`document.querySelector('.compare-clear-btn').click(), true`);
  await waitFor(`!document.querySelector('.compare-summary') && document.querySelector('.color-by-select')?.value !== 'compare'`);
  await frames(5);
  await fullShot('cleared-restored');
  const restoredMode = await ev(`document.querySelector('.color-by-select')?.value`);
  const restoredColors = await ev(
    `(() => { const m = window.__gubim_dev__.activeRenderer.models; return Object.fromEntries([...m.entries()].map(([id, st]) => [id, [...(st.colorOverrides?.entries() ?? [])]])); })()`
  );
  check(
    'C5 clearing comparison restores previous colours',
    restoredMode === 'class' && JSON.stringify(restoredColors) === JSON.stringify(preCompareClassColors),
    {
      restoredMode,
      beforeKeys: Object.keys(preCompareClassColors).length,
      restoredMatches: JSON.stringify(restoredColors) === JSON.stringify(preCompareClassColors)
    }
  );

  check('C6 no console errors', errors.length === 0, errors.slice(0, 5));
} catch (error) {
  check('HARNESS', false, String(error?.stack ?? error));
} finally {
  await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
  try {
    proc.kill();
  } catch {}
}

const passed = results.filter(Boolean).length;
console.log(`compare ${mode}: ${passed}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
