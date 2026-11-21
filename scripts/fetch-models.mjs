// Downloads public IFC models into test/models/ (gitignored; never commit them). See scripts/models.json.
//
//   node scripts/fetch-models.mjs --bench   the benchmark's pinned real models, checked by sha256
//   node scripts/fetch-models.mjs --all     every IFC file of every source: a sparse clone per
//                                           repository, IFC files and READMEs only, LFS for IFC only
//
// GUBIM_MODELS_DIR overrides the folder. Needs git for --all; LFS files are fetched over HTTPS and checked by sha256, no git-lfs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(process.env.GUBIM_MODELS_DIR ?? path.join(REPO, 'test/models'));
const config = JSON.parse(readFileSync(path.join(REPO, 'scripts/models.json'), 'utf8'));
const args = process.argv.slice(2);
if (!args.includes('--bench') && !args.includes('--all')) {
  console.error('usage: node scripts/fetch-models.mjs --bench | --all');
  process.exit(2);
}
mkdirSync(DIR, { recursive: true });

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

/** Where a pinned benchmark model lives once fetched. */
export function benchPath(model, dir = DIR) {
  return path.join(dir, 'bench', path.basename(model.path));
}

async function fetchBench() {
  let failed = 0;
  for (const model of config.bench.models) {
    const target = benchPath(model);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target) && statSync(target).size === model.bytes && (await sha256(target)) === model.sha256) {
      console.log(`ok       ${model.name}`);
      continue;
    }
    const url = config.bench.base + model.path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(url);
    if (!res.ok) { console.log(`FAILED   ${model.name}: HTTP ${res.status}`); failed++; continue; }
    const temp = `${target}.download`;
    writeFileSync(temp, Buffer.from(await res.arrayBuffer()));
    const sum = await sha256(temp);
    if (sum !== model.sha256) { rmSync(temp); console.log(`FAILED   ${model.name}: sha256 ${sum}`); failed++; continue; }
    renameSync(temp, target);
    console.log(`fetched  ${model.name} (${(model.bytes / 1048576).toFixed(1)} MB, sha256 checked)`);
  }
  return failed;
}

function git(cwd, gitArgs, env = {}) {
  const r = spawnSync('git', gitArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed in ${cwd}`);
}

const IFC = /\.(ifc|ifczip|ifcxml)$/i;

/** IFC files under `dir` that are still Git LFS pointers: [file, sha256, bytes]. */
function lfsPointers(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSafeEntries(d)) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (IFC.test(e.name) && statSync(p).size < 400) {
        const text = readFileSync(p, 'utf8');
        const oid = text.match(/^oid sha256:([0-9a-f]{64})$/m);
        const size = text.match(/^size (\d+)$/m);
        if (text.startsWith('version https://git-lfs') && oid && size) out.push([p, oid[1], Number(size[1])]);
      }
    }
  };
  walk(dir);
  return out;
}
function readdirSafeEntries(d) {
  try { return readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

async function fetchAll() {
  // Only IFC files and their READMEs: the repositories also keep point clouds and archives.
  const patterns = ['*.ifc', '*.IFC', '*.Ifc', '*.ifczip', '*.IFCZIP', '*.ifcxml', '*.ifcXML', 'README*', 'readme*', 'LICENSE*'];
  let failed = 0;
  for (const source of config.sources) {
    const dir = path.join(DIR, source.name);
    console.log(`\n== ${source.name} (${source.licence})`);
    if (!existsSync(path.join(dir, '.git'))) {
      git(DIR, ['clone', '--filter=blob:none', '--no-checkout', source.repo, source.name], { GIT_LFS_SKIP_SMUDGE: '1' });
    } else {
      git(dir, ['fetch', '--filter=blob:none', 'origin']);
    }
    git(dir, ['sparse-checkout', 'set', '--no-cone', ...patterns]);
    git(dir, ['checkout', '-q', '-B', 'local', 'origin/HEAD'], { GIT_LFS_SKIP_SMUDGE: '1' });
    // git-lfs cannot pull in a blobless clone (it needs trees the clone never fetched), so each
    // pointer is fetched from GitHub's media host at this commit and checked by its sha256.
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const slug = source.repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    const pointers = lfsPointers(dir);
    if (pointers.length) console.log(`${pointers.length} LFS files, ${(pointers.reduce((a, p) => a + p[2], 0) / 1048576).toFixed(0)} MB`);
    for (const [file, oid, bytes] of pointers) {
      const rel = path.relative(dir, file).replace(/\\/g, '/');
      const url = `https://media.githubusercontent.com/media/${slug}/${commit}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const temp = `${file}.download`;
        writeFileSync(temp, Buffer.from(await res.arrayBuffer()));
        const sum = await sha256(temp);
        if (sum !== oid || statSync(temp).size !== bytes) { rmSync(temp); throw new Error('sha256 or size mismatch'); }
        renameSync(temp, file);
        console.log(`fetched  ${(bytes / 1048576).toFixed(1).padStart(6)} MB  ${rel}`);
      } catch (err) {
        failed++;
        console.log(`FAILED   ${rel}: ${err.message}`);
      }
    }
  }
  return failed;
}

// A list of everything fetched, for tools that want to walk the models.
function writeManifest() {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSafe(d)) {
      if (name === '.git') continue;
      const p = path.join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(ifc|ifczip|ifcxml)$/i.test(name)) {
        const head = s.size < 300 ? readFileSync(p, 'utf8') : '';
        files.push({ path: path.relative(DIR, p).replace(/\\/g, '/'), bytes: s.size, lfsPointer: head.startsWith('version https://git-lfs') });
      }
    }
  };
  walk(DIR);
  files.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(files, null, 1));
  const real = files.filter((f) => !f.lfsPointer);
  console.log(`\n${real.length} IFC files, ${(real.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(0)} MB in ${DIR}${files.length - real.length ? `; ${files.length - real.length} still LFS pointers` : ''}`);
}
function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}


let failed = 0;
if (args.includes('--all')) failed += await fetchAll();
if (args.includes('--bench')) failed += await fetchBench();
writeManifest();
process.exit(failed ? 1 : 0);
