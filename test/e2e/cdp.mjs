// Minimal CDP client over Node's global WebSocket, plus Chrome launch helpers.
// CHROME_PATH overrides the browser; E2E_CHROME_FLAGS adds flags (space-separated), e.g. on a
// Linux CI runner without a GPU: --no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const DEFAULT_CHROME = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  linux: '/usr/bin/google-chrome',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port, profileDir }) {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(profileDir, { recursive: true });
  const cleanupProfile = () => {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  };
  const chrome = process.env.CHROME_PATH || DEFAULT_CHROME[process.platform];
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-default-apps',
    '--window-size=1400,900',
    '--force-device-scale-factor=1',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []),
    ...(process.env.E2E_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean),
    'about:blank'
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  proc.once('exit', cleanupProfile);
  process.once('exit', () => {
    try { proc.kill(); } catch {}
    cleanupProfile();
  });
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { proc, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await sleep(100);
  }
  proc.kill();
  cleanupProfile();
  throw new Error(`Chrome did not start: ${chrome}`);
}

/** gpu: as the browser is. gl2: no navigator.gpu. none: WebGPU present but no adapter. */
export async function applyMode(send, mode) {
  if (mode === 'gl2') {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });"
    });
  } else if (mode === 'none') {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;'
    });
  } else if (mode !== 'gpu') {
    throw new Error(`unknown mode ${mode}`);
  }
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(
        `eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}\n${expression.slice(0, 300)}`
      );
    }
    return res.result.value;
  };
  return { ws, send, on, evaluate, close: () => ws.close() };
}

export { sleep };
