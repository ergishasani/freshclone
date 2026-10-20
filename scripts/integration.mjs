import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--test', 'dist/test/container.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, FRESHCLONE_DOCKER_TESTS: '1' },
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
