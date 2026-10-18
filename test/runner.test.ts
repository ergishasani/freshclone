import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { dockerArguments, snapshotTrackedFiles } from '../src/runner.js';

const exec = promisify(execFile);

async function fixture(
  run: (root: string, destination: string, base: string) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'freshclone-snapshot-'));
  const root = path.join(base, 'repository');
  const destination = path.join(base, 'snapshot');
  await Promise.all([mkdir(root), mkdir(destination)]);
  try {
    await exec('git', ['init', '--quiet', '--template='], { cwd: root });
    await run(root, destination, base);
  } finally {
    // Only remove this fixture's generated temporary directory.
    await rm(base, { recursive: true, force: true });
  }
}

async function file(root: string, name: string, contents = name): Promise<void> {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function track(root: string): Promise<void> {
  // Force tracking test fixtures even if the host has a global ignore file.
  await exec('git', ['add', '--force', '--', '.'], { cwd: root });
}

test('snapshots tracked working-tree edits and omits untracked and deleted files', async () => {
  await fixture(async (root, destination) => {
    await file(root, 'README.md', 'original');
    await file(root, 'deleted.txt');
    await track(root);
    await file(root, 'README.md', 'local tracked edit');
    await rm(path.join(root, 'deleted.txt'));
    await file(root, 'untracked.txt', 'must stay out');

    await snapshotTrackedFiles(root, destination);

    assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), 'local tracked edit');
    for (const name of ['untracked.txt', 'deleted.txt', '.git']) {
      await assert.rejects(access(path.join(destination, name)), { code: 'ENOENT' });
    }
    await writeFile(path.join(destination, 'README.md'), 'container-side edit');
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'local tracked edit');
  });
});

test('filters tracked secrets and dependencies while preserving safe environment examples', async () => {
  await fixture(async (root, destination) => {
    const excluded = [
      '.env',
      '.env.local',
      'nested/.env.production',
      'node_modules/package/index.js',
      'nested/node_modules/package.json',
    ];
    const included = ['README.md', '.env.example', '.env.sample', 'nested/.env.template'];
    for (const name of [...excluded, ...included]) await file(root, name);
    await track(root);

    await snapshotTrackedFiles(root, destination);

    for (const name of excluded) {
      await assert.rejects(access(path.join(destination, name)), { code: 'ENOENT' });
    }
    for (const name of included) {
      assert.equal(await readFile(path.join(destination, name), 'utf8'), name);
    }
  });
});

test('a subdirectory project cannot copy tracked sibling project files', async () => {
  await fixture(async (root, destination) => {
    await file(root, 'README.md', 'repository root');
    await file(root, 'apps/demo/README.md', 'demo app');
    await file(root, 'apps/demo/src/index.js', 'demo code');
    await file(root, 'apps/private/secrets.txt', 'sibling project');
    await track(root);

    await snapshotTrackedFiles(path.join(root, 'apps', 'demo'), destination);

    assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), 'demo app');
    assert.equal(await readFile(path.join(destination, 'src/index.js'), 'utf8'), 'demo code');
    await assert.rejects(access(path.join(destination, 'apps')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(destination, 'secrets.txt')), { code: 'ENOENT' });
  });
});

test('rejects tracked paths redirected through an ancestor symlink', async (context) => {
  await fixture(async (root, destination, base) => {
    await file(root, 'docs/setup.md', 'tracked documentation');
    await track(root);
    await rename(path.join(root, 'docs'), path.join(root, 'original-docs'));
    const outside = path.join(base, 'outside');
    await file(outside, 'setup.md', 'outside data');
    try {
      await symlink(outside, path.join(root, 'docs'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip(
          'This host does not permit directory symlinks; Linux CI exercises this check.',
        );
        return;
      }
      throw error;
    }

    await assert.rejects(
      snapshotTrackedFiles(root, destination),
      /Symbolic links are not supported/,
    );
    await assert.rejects(access(path.join(destination, 'docs/setup.md')), { code: 'ENOENT' });
  });
});

test('an empty tracked project fails instead of reporting a successful empty check', async () => {
  await fixture(async (root, destination) => {
    await file(root, 'untracked.txt');
    await assert.rejects(snapshotTrackedFiles(root, destination), /No tracked project files/);
  });
});

test('Docker arguments mount only the temporary workspace and read-only control files', () => {
  const workspace = path.resolve('temporary workspace');
  const control = path.resolve('temporary control');
  const args = dockerArguments(workspace, control, 'node:24-bookworm-slim', 'freshclone-test');
  const valuesFor = (flag: string) =>
    args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));

  assert.deepEqual(valuesFor('--mount'), [
    `type=bind,source=${workspace},target=/workspace`,
    `type=bind,source=${control},target=/freshclone,readonly`,
  ]);
  assert.deepEqual(valuesFor('--env'), ['HOME=/tmp', 'npm_config_cache=/tmp/npm-cache']);
  assert.deepEqual(valuesFor('--workdir'), ['/workspace']);
  assert.deepEqual(valuesFor('--entrypoint'), ['node']);
  assert.equal(args.at(-2), 'node:24-bookworm-slim');
  assert.equal(args.at(-1), '/freshclone/container-runner.mjs');
  for (const forbidden of ['--privileged', '--env-file', '--volumes-from', '-v', '-e']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not be forwarded`);
  }
  assert.ok(!args.some((value) => value.includes('docker.sock')));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.deepEqual(valuesFor('--memory'), ['1g']);
  assert.deepEqual(valuesFor('--pids-limit'), ['256']);
});

test('rejects commas in bind paths rather than changing Docker mount options', () => {
  assert.throws(
    () => dockerArguments('/tmp/with,comma', '/tmp/control', 'node:24', 'test'),
    /bind mount paths cannot contain commas/,
  );
});
