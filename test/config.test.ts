import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadProject, validateConfig } from '../src/config.js';

const basic = { version: 1, steps: [{ block: 'install' }] };
const app = {
  version: 1,
  steps: [{ block: 'install' }, { block: 'start', background: true }],
  expect: { http: { url: 'http://127.0.0.1:3000/' } },
};

test('normalizes sensible defaults and preserves explicit settings', () => {
  assert.deepEqual(validateConfig(basic), {
    version: 1,
    readme: 'README.md',
    image: 'node:24-bookworm-slim',
    timeout: 60,
    steps: [{ block: 'install' }],
  });
  const config = validateConfig({
    ...app,
    readme: 'docs/SETUP.md',
    image: 'node:22',
    timeout: 120,
  });
  assert.equal(config.readme, 'docs/SETUP.md');
  assert.equal(config.image, 'node:22');
  assert.equal(config.timeout, 120);
  assert.deepEqual(config.expect?.http, {
    url: 'http://127.0.0.1:3000/',
    status: 200,
    timeout: 30,
  });
});

test('rejects misspelled keys at each configuration level', () => {
  const invalid = [
    { ...basic, timeuot: 10 },
    { version: 1, steps: [{ block: 'install', backgound: true }] },
    { ...app, expect: { https: { url: 'http://localhost:3000/' } } },
    { ...app, expect: { http: { url: 'http://localhost:3000/', timeuot: 10 } } },
  ];
  for (const config of invalid) assert.throws(() => validateConfig(config), /Unknown .* key/);
});

test('allows a single final background step only with an HTTP expectation', () => {
  assert.throws(
    () => validateConfig({ version: 1, steps: [{ block: 'start', background: true }] }),
    /requires expect.http/,
  );
  assert.throws(
    () => validateConfig({ ...basic, expect: app.expect }),
    /only allowed with a background/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...app,
        steps: [{ block: 'start', background: true }, { block: 'install' }],
      }),
    /must be the last step/,
  );
  assert.throws(
    () => validateConfig({ ...basic, steps: [{ block: 'install', background: 'yes' }] }),
    /must be a boolean/,
  );
});

test('validates block references before execution', () => {
  assert.throws(() => validateConfig({ ...basic, steps: [] }), /nonempty array/);
  assert.throws(
    () => validateConfig({ ...basic, steps: [{ block: 'install' }, { block: 'install' }] }),
    /Duplicate step/,
  );
  for (const block of ['', 'has space', '--help', '../../escape', 12]) {
    assert.throws(() => validateConfig({ ...basic, steps: [{ block }] }), /block must/);
  }
});

test('requires bounded integer timeouts and HTTP statuses', () => {
  for (const timeout of [0, 601, 1.2, '60', null]) {
    assert.throws(() => validateConfig({ ...basic, timeout }), /timeout must be an integer/);
  }
  for (const timeout of [0, 301, 1.2, '30']) {
    assert.throws(
      () => validateConfig({ ...app, expect: { http: { url: 'http://localhost', timeout } } }),
      /expect.http.timeout must be an integer/,
    );
  }
  for (const status of [99, 100, 101, 199, 600, 200.1, '200']) {
    assert.throws(
      () => validateConfig({ ...app, expect: { http: { url: 'http://localhost', status } } }),
      /expect.http.status must be an integer/,
    );
  }
  assert.equal(validateConfig({ ...basic, timeout: 600 }).timeout, 600);
});

test('accepts only local HTTP checks without credentials or fragments', () => {
  for (const url of [
    'https://localhost:3000/',
    'http://example.com:3000/',
    'http://localhost.example.com/',
    'http://0.0.0.0:3000/',
    'http://[::1]:3000/',
    'http://name:password@localhost/',
    'http://localhost/#section',
    'http://localhost/#',
    'not a URL',
  ]) {
    assert.throws(() => validateConfig({ ...app, expect: { http: { url } } }), /expect.http.url/);
  }
  assert.equal(
    validateConfig({ ...app, expect: { http: { url: 'http://localhost/health?ready=1' } } }).expect
      ?.http.status,
    200,
  );
});

test('rejects paths outside the project and option-like image references', () => {
  for (const readme of [
    '../README.md',
    'docs/../../README.md',
    'docs\\..\\README.md',
    '/etc/passwd',
    'C:\\README.md',
    'C:README.md',
    '\\\\server\\README.md',
  ]) {
    assert.throws(() => validateConfig({ ...basic, readme }), /readme must be a relative/);
  }
  for (const image of ['', '-v', 'node:22 --privileged']) {
    assert.throws(() => validateConfig({ ...basic, image }), /image must/);
  }
});

async function fixture(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'freshclone-config-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  try {
    await run(root, outside);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function linkDirectory(target: string, link: string, context: TestContext): Promise<boolean> {
  try {
    await symlink(target, link, 'junction');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('This host does not permit directory symlinks; Linux CI exercises this check.');
      return false;
    }
    throw error;
  }
}

test('loads selected README blocks in configuration order', async () => {
  await fixture(async (root) => {
    await writeFile(
      path.join(root, '.freshclone.yml'),
      'version: 1\nsteps:\n  - block: second\n  - block: first\n',
    );
    await writeFile(
      path.join(root, 'README.md'),
      '<!-- freshclone:first -->\n```sh\necho one\n```\n\n<!-- freshclone:second -->\n```sh\necho two\n```\n',
    );
    const project = await loadProject(root);
    assert.deepEqual(
      project.blocks.map((block) => block.id),
      ['second', 'first'],
    );
    assert.equal(project.readmePath, 'README.md');
  });
});

test('rejects duplicate YAML keys and missing selected blocks', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, '.freshclone.yml'), 'version: 1\nversion: 1\nsteps: []\n');
    await assert.rejects(loadProject(root), /Invalid FreshClone YAML/);
    await writeFile(path.join(root, '.freshclone.yml'), 'version: 1\nsteps:\n  - block: missing\n');
    await writeFile(path.join(root, 'README.md'), '# No selected commands\n');
    await assert.rejects(loadProject(root), /missing FreshClone block "missing"/);
  });
});

test('rejects configuration paths and symlinked directories escaping the root', async (context) => {
  await fixture(async (root, outside) => {
    await writeFile(path.join(outside, 'config.yml'), 'version: 1\nsteps:\n  - block: install\n');
    await assert.rejects(loadProject(root, path.join(outside, 'config.yml')), /must stay inside/);
    if (!(await linkDirectory(outside, path.join(root, 'linked'), context))) return;
    await assert.rejects(loadProject(root, 'linked/config.yml'), /must stay inside.*symlink/);
  });
});

test('rejects README symlink escapes before parsing their contents', async (context) => {
  await fixture(async (root, outside) => {
    await writeFile(
      path.join(root, '.freshclone.yml'),
      'version: 1\nreadme: linked/README.md\nsteps:\n  - block: install\n',
    );
    await writeFile(
      path.join(outside, 'README.md'),
      '<!-- freshclone:install -->\n```sh\necho outside\n```\n',
    );
    if (!(await linkDirectory(outside, path.join(root, 'linked'), context))) return;
    await assert.rejects(loadProject(root), /README file must stay inside/);
  });
});
