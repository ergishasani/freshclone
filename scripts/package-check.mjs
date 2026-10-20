// Smoke-test the exact tarball in an independent temporary installation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run package:check.');
const npm = (args) => exec(process.execPath, [npmCli, ...args], { cwd: root, timeout: 120000 });
const temporary = await mkdtemp(path.join(tmpdir(), 'freshclone-package-'));
try {
  await npm(['run', 'build']);
  const result = await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]);
  const packed = JSON.parse(result.stdout);
  const [metadata] = Array.isArray(packed) ? packed : Object.values(packed);
  const names = metadata.files.map((file) => file.path);
  for (const file of [
    'dist/src/cli.js',
    'assets/container-runner.mjs',
    'assets/container-runner.py',
  ])
    assert.ok(names.includes(file), `Missing ${file}`);
  assert.ok(
    !names.some((name) => /^(test|src|node_modules|docs\/outreach)\//.test(name)),
    'Unexpected development/private files in package.',
  );
  const installation = path.join(temporary, 'installation');
  await mkdir(installation);
  await exec(
    process.execPath,
    [
      npmCli,
      'install',
      '--prefix',
      installation,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(temporary, metadata.filename),
    ],
    { timeout: 120000 },
  );
  const packageRoot = path.join(installation, 'node_modules', '@ergishasani', 'freshclone');
  const cli = path.join(packageRoot, 'dist', 'src', 'cli.js');
  assert.ok((await readFile(cli, 'utf8')).startsWith('#!/usr/bin/env node'));
  await access(
    path.join(
      installation,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'freshclone.cmd' : 'freshclone',
    ),
  );
  const expectedVersion = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ).version;
  const version = await exec(process.execPath, [cli, '--version']);
  assert.equal(version.stdout.trim(), expectedVersion);
  const plan = await exec(process.execPath, [
    cli,
    'plan',
    '--root',
    path.join(root, 'examples', 'hello-python'),
    '--json',
  ]);
  assert.equal(JSON.parse(plan.stdout).runtime, 'python');
  if (process.env.FRESHCLONE_DOCKER_TESTS === '1') {
    const check = await exec(
      process.execPath,
      [cli, 'check', '--root', path.join(root, 'examples', 'hello-node'), '--json'],
      { timeout: 180000 },
    );
    assert.equal(JSON.parse(check.stdout).ok, true, check.stdout);
  }
  console.log(
    `Verified ${metadata.name}@${expectedVersion}: package contents, installation, executable, version, plan${process.env.FRESHCLONE_DOCKER_TESTS === '1' ? ', and Docker check' : ''}.`,
  );
} finally {
  // Remove only this freshly created temporary directory.
  await rm(temporary, { recursive: true, force: true });
}
