// Builds the Rust kernel and generates its JS bindings into src/infrastructure/kernel/pkg.
// Needs cargo, the wasm32-unknown-unknown target and wasm-bindgen 0.2.130, the exact version
// pinned in Cargo.toml. Set WASM_BINDGEN to its path if it is not on PATH.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args) {
  const { status, error } = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

run('cargo', ['build', '-p', 'wasm-api', '--release', '--target', 'wasm32-unknown-unknown']);
run(process.env.WASM_BINDGEN ?? 'wasm-bindgen', [
  'target/wasm32-unknown-unknown/release/wasm_api.wasm',
  '--target',
  'web',
  '--out-dir',
  'src/infrastructure/kernel/pkg'
]);
