// Runs the built kernel with its memory capped, so a real allocation failure happens: an IFC
// too big for WASM memory must be named as that, not as a meaningless trap. Run after
// `npm run kernel`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocationFailed, initSync, Model } from '../src/infrastructure/kernel/pkg/wasm_api.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PAGE = 65536;
const CAP_PAGES = 48;

const uleb = (bytes, at) => {
  let value = 0;
  let length = 0;
  let byte;
  do {
    byte = bytes[at + length];
    value += (byte & 0x7f) * 2 ** (7 * length);
    length += 1;
  } while (byte & 0x80);
  return [value, length];
};

function toUleb(value) {
  const out = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    out.push(value > 0 ? low | 0x80 : low);
  } while (value > 0);
  return out;
}

/** Gives the memory section a maximum. Nothing else in the binary changes. */
function capMemory(wasm, pages) {
  const parts = [wasm.subarray(0, 8)];
  let at = 8;
  while (at < wasm.length) {
    const [size, width] = uleb(wasm, at + 1);
    const start = at + 1 + width;
    if (wasm[at] === 5) {
      const [initial] = uleb(wasm, start + 2);
      const body = [1, 1, ...toUleb(initial), ...toUleb(pages)];
      parts.push(Uint8Array.from([5, ...toUleb(body.length), ...body]));
    } else {
      parts.push(wasm.subarray(at, start + size));
    }
    at = start + size;
  }
  return Buffer.concat(parts);
}

const wasm = readFileSync(join(root, 'src/infrastructure/kernel/pkg/wasm_api_bg.wasm'));
const { memory } = initSync({ module: capMemory(wasm, CAP_PAGES) });
const bytes = readFileSync(join(root, 'public/samples/ManySimpleWalls.ifc'));

function run() {
  const model = new Model(bytes);
  model.startStream();
  for (;;) {
    const view = model.nextBatch(65536);
    if (!view) return;
    view.free();
  }
}

if (allocationFailed()) {
  console.error('allocationFailed is set before anything ran');
  process.exit(1);
}

let trapped = null;
try {
  run();
} catch (error) {
  trapped = error;
}

const used = memory.buffer.byteLength / PAGE;
if (!(trapped instanceof WebAssembly.RuntimeError)) {
  console.error(`expected a trap, got ${trapped}, with ${used} of ${CAP_PAGES} pages`);
  process.exit(1);
}
if (!allocationFailed()) {
  console.error(`trapped with '${trapped.message}', but allocationFailed is false`);
  process.exit(1);
}
console.log(`trap at ${used} of ${CAP_PAGES} pages named as an allocation failure`);
