// Production-build smoke: load a sample by URL, check the backend badge, model card, console, and
// take a screenshot. Usage: node smoke.mjs <gpu|gl2|none> <url> <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, connect, sleep } from './cdp.mjs';

const [mode, url, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { proc, wsUrl } = await launch({ port: 9310, profileDir: path.resolve(outDir, `profile-smoke-${mode}`) });
const cdp = await connect(wsUrl);
const errors = [];
cdp.on('Runtime.consoleAPICalled', (p) => p.type === 'error' && errors.push(p.args.map((a) => a.value ?? a.description).join(' ')));
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
if (mode === 'gl2') await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });" });
if (mode === 'none') await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;" });
await cdp.send('Page.navigate', { url });
let state = null;
for (let i = 0; i < 300; i++) {
  await sleep(100);
  state = await cdp.evaluate(`({ cards: document.querySelectorAll('.model-card').length, meta: document.querySelector('.model-card-meta')?.textContent ?? '', badge: [...document.querySelectorAll('header *')].map((e) => e.childElementCount === 0 ? e.textContent : '').find((t) => /Activo/.test(t)) ?? '', err: document.querySelector('.model-card-error')?.textContent ?? '' })`).catch(() => null);
  if (state && state.cards > 0 && /elem/.test(state.meta)) break;
}
await sleep(1500);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(path.join(outDir, `smoke-${mode}.png`), Buffer.from(data, 'base64'));
const expectBadge = mode === 'gpu' ? /WebGPU/ : /WebGL/;
const ok = state && state.cards === 1 && /elem/.test(state.meta) && !state.err && expectBadge.test(state.badge) && errors.length === 0;
console.log(`${ok ? 'PASS' : 'FAIL'} smoke ${mode} ${JSON.stringify({ ...state, errors: errors.slice(0, 3) })}`);
cdp.close();
proc.kill();
