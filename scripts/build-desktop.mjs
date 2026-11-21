import { spawnSync } from 'node:child_process';

const env = { ...process.env, GUBIM_DESKTOP: '1' };
const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

run('npm', ['run', 'kernel']);
run('npx', ['tsc', '--noEmit']);
run('npx', ['vite', 'build']);
