import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const command = `node -e "require('node:fs').writeFileSync('executed.txt', 'commands ran')"`;
const readme = [
  '# CLI fixture',
  '',
  '<!-- freshclone:install -->',
  '```sh',
  command,
  '```',
  '',
  '<!-- freshclone:verify -->',
  '```sh',
  'echo ready',
  '```',
  '',
].join('\n');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      timeout: 10000,
      // plan and init must work without Git, Docker, or a shell on PATH.
      env: { ...process.env, PATH: '' },
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code !== 'number') throw error;
    return {
      code: failure.code,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const directory = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(directory, 'freshclone-cli-with space-'));
  try {
    await writeFile(path.join(root, 'README.md'), readme);
    await run(root);
  } finally {
    // Delete only the temporary directory this test created.
    assert.equal(path.dirname(path.resolve(root)), directory);
    await rm(root, { recursive: true, force: true });
  }
}

test('plan shows selected README commands without executing them or needing Git and Docker', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, '.freshclone.yml'), 'version: 1\nsteps:\n  - block: install\n');
    const result = await runCli(['plan', '--root', root, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.readme, 'README.md');
    assert.deepEqual(plan.steps, [{ block: 'install', line: 5, command, background: false }]);
    await assert.rejects(access(path.join(root, 'executed.txt')), { code: 'ENOENT' });

    const text = await runCli(['plan', '--root', root]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /install.*README\.md:5/);
    assert.match(text.stdout, /No commands executed\./);
    await assert.rejects(access(path.join(root, 'executed.txt')), { code: 'ENOENT' });
  });
});

test('init creates a usable custom config and refuses to overwrite it', async () => {
  await fixture(async (root) => {
    const args = ['init', '--root', root, '--config', 'setup.yml'];
    const created = await runCli(args);
    assert.equal(created.code, 0, created.stderr);
    const configFile = path.join(root, 'setup.yml');
    const original = await readFile(configFile, 'utf8');
    const config = parse(original);
    assert.equal(config.version, 1);
    assert.deepEqual(config.steps, [{ block: 'install' }, { block: 'verify' }]);
    assert.equal(config.expect, undefined);

    const plan = await runCli(['plan', '--root', root, '--config', 'setup.yml', '--json']);
    assert.equal(plan.code, 0, plan.stderr);
    assert.deepEqual(
      JSON.parse(plan.stdout).steps.map((step: { block: string }) => step.block),
      ['install', 'verify'],
    );

    const duplicate = await runCli(args);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /EEXIST|already exists/);
    assert.equal(await readFile(configFile, 'utf8'), original);
    await assert.rejects(access(path.join(root, 'executed.txt')), { code: 'ENOENT' });
  });
});

test('JSON mode emits a structured failure for missing project config', async () => {
  await fixture(async (root) => {
    const result = await runCli(['plan', '--root', root, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /ENOENT|no such file/);
  });
});

test('JSON mode preserves structured errors when command-line parsing fails', async () => {
  const result = await runCli(['plan', '--json', '--unknown-option']);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.error, /Unknown option/);
});

test('init rejects JSON mode without creating a configuration', async () => {
  await fixture(async (root) => {
    const result = await runCli(['init', '--root', root, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /--json is supported by plan and check only/);
    await assert.rejects(access(path.join(root, '.freshclone.yml')), { code: 'ENOENT' });
  });
});
