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

async function runCli(
  args: string[],
  environment: Record<string, string> = {},
): Promise<CliResult> {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      timeout: 10000,
      // plan and init must work without Git, Docker, or a shell on PATH.
      env: { ...process.env, PATH: '', ...environment },
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
    assert.match(report.error, /--json is supported by plan, doctor, and check only/);
    await assert.rejects(access(path.join(root, '.freshclone.yml')), { code: 'ENOENT' });
  });
});

test('scripted init supports server selection and Python without Docker', async () => {
  await fixture(async (root) => {
    const result = await runCli([
      'init',
      '--root',
      root,
      '--no-interactive',
      '--blocks',
      'install,verify',
      '--start',
      'verify',
      '--url',
      'http://localhost:8000/',
      '--runtime',
      'python',
      '--shell',
      'bash',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const plan = await runCli(['plan', '--root', root, '--json']);
    assert.equal(plan.code, 0, plan.stderr);
    const value = JSON.parse(plan.stdout);
    assert.equal(value.runtime, 'python');
    assert.equal(value.shell, 'bash');
    assert.equal(value.steps.at(-1).background, true);
    assert.equal(value.expect.http.url, 'http://localhost:8000/');
  });
});

test('doctor collects failures and actionable fixes without running README commands', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, '.freshclone.yml'), 'version: 1\nsteps:\n  - block: install\n');
    const result = await runCli(['doctor', '--root', root, '--json']);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.ok(
      report.checks.some(
        (check: { name: string; ok: boolean }) =>
          check.name === 'Configuration and README' && check.ok,
      ),
    );
    assert.ok(
      report.checks.some(
        (check: { name: string; fix?: string }) => check.name === 'Docker' && check.fix,
      ),
    );
    await assert.rejects(access(path.join(root, 'executed.txt')), { code: 'ENOENT' });
  });
});

test('CLI selects named scenarios and rejects init flags on other commands', async () => {
  await fixture(async (root) => {
    await writeFile(
      path.join(root, '.freshclone.yml'),
      'version: 1\nscenarios:\n  minimal:\n    steps:\n      - block: verify\n',
    );
    const result = await runCli(['plan', '--root', root, '--scenario', 'minimal', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).scenario, 'minimal');
    assert.deepEqual(
      JSON.parse(result.stdout).steps.map((step: { block: string }) => step.block),
      ['verify'],
    );
    const invalid = await runCli(['plan', '--root', root, '--runtime', 'python', '--json']);
    assert.equal(invalid.code, 1);
    assert.match(JSON.parse(invalid.stdout).error, /only supported by init/);
  });
});

test('configuration failures still produce GitHub summaries without corrupting JSON', async () => {
  await fixture(async (root) => {
    const summary = path.join(root, 'summary.md');
    const result = await runCli(['check', '--root', root, '--json', '--github'], {
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).failureKind, 'configuration');
    assert.match(result.stderr, /::error title=FreshClone::/);
    assert.match(await readFile(summary, 'utf8'), /FAILED/);
    await assert.rejects(access(path.join(root, 'executed.txt')), { code: 'ENOENT' });
  });
});
