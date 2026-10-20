import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProject, validateConfig } from '../src/config.js';
import { initProject } from '../src/init.js';
import { githubAnnotations, githubSummary, writeGithubReport } from '../src/reporting.js';
import { dockerArguments, serviceArguments, type CheckReport } from '../src/runner.js';

const basic = { version: 1, steps: [{ block: 'install' }] };

test('scenarios inherit common settings and replace steps/expectations explicitly', () => {
  const config = {
    ...basic,
    timeout: 90,
    scenarios: {
      python: {
        runtime: 'python',
        steps: [{ block: 'pip' }],
        expect: { files: ['generated.txt'] },
      },
      production: { steps: [{ block: 'build' }] },
    },
  };
  const python = validateConfig(config, 'python');
  assert.equal(python.image, 'python:3.13-slim');
  assert.equal(python.timeout, 90);
  assert.equal(python.scenario, 'python');
  assert.deepEqual(python.steps, [{ block: 'pip' }]);
  assert.deepEqual(validateConfig(config).steps, basic.steps);
  assert.throws(() => validateConfig(config, 'unknown'), /Unknown scenario/);
  assert.throws(
    () => validateConfig({ version: 1, scenarios: config.scenarios }),
    /Choose --scenario/,
  );
  assert.throws(() => validateConfig({ ...basic, scenarios: { bad: { timout: 5 } } }), /Unknown/);
  assert.throws(
    () => validateConfig({ ...basic, scenarios: { bad: { steps: [] } } }),
    /nonempty array/,
  );
});

test('rejects unsafe expectation paths, unknown output blocks and reserved environment variables', () => {
  for (const file of ['../secret', '/etc/passwd', 'C:secret', 'a\\b', 'C:\\secret'])
    assert.throws(
      () => validateConfig({ ...basic, expect: { files: [file] } }),
      /inside the workspace/,
    );
  assert.throws(
    () =>
      validateConfig({ ...basic, expect: { output: [{ block: 'missing', contains: 'ready' }] } }),
    /unselected block/,
  );
  assert.throws(() => validateConfig({ ...basic, env: { PATH: 'override' } }), /reserved/);
  assert.throws(() => validateConfig({ ...basic, env: { VALUE: 42 } }), /must be a string/);
  assert.throws(() => validateConfig({ ...basic, shell: 'powershell' }), /shell must/);
  assert.throws(() => validateConfig({ ...basic, runtime: 'ruby' }), /runtime must/);
  assert.throws(
    () => validateConfig({ ...basic, services: { '--bad': { image: 'redis', port: 6379 } } }),
    /Invalid service/,
  );
  assert.throws(
    () => validateConfig({ ...basic, services: { cache: { image: 'redis', port: 0 } } }),
    /port must/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...basic,
        services: { cache: { image: 'redis --privileged', port: 6379 } },
      }),
    /image must/,
  );
  const http = {
    version: 1,
    steps: [{ block: 'start', background: true }],
    expect: { http: { url: 'http://localhost:3000/', json: { 'constructor.prototype': true } } },
  };
  assert.throws(() => validateConfig(http), /safe dotted/);
});

test('guided init creates a runnable server recipe using only selected blocks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'freshclone-guided-'));
  try {
    await writeFile(
      path.join(root, 'README.md'),
      '<!-- freshclone:install -->\n```sh\necho installed\n```\n\n<!-- freshclone:start -->\n```sh\npython3 app.py\n```\n\n<!-- freshclone:other -->\n```sh\necho unused\n```\n',
    );
    const answers = [
      'install,start',
      'python',
      'bash',
      'python:3.13-slim',
      'start',
      'http://127.0.0.1:8000/',
    ];
    await initProject(root, '.freshclone.yml', {}, async () => answers.shift()!);
    const project = await loadProject(root);
    assert.equal(project.config.runtime, 'python');
    assert.equal(project.config.shell, 'bash');
    assert.equal(project.config.expect?.http?.url, 'http://127.0.0.1:8000/');
    assert.deepEqual(project.config.steps, [
      { block: 'install' },
      { block: 'start', background: true },
    ]);
    await assert.rejects(initProject(root, '.freshclone.yml', {}), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub reports escape repository output and preserve README locations', async () => {
  const report: CheckReport = {
    ok: false,
    image: 'node:24',
    readme: 'docs/a,b.md',
    durationMs: 1000,
    failureKind: 'setup',
    error: 'bad\n::notice::injected',
    steps: [
      {
        block: 'install',
        line: 12,
        status: 'failed',
        durationMs: 500,
        output: '</pre><script>bad()</script>\n::error::raw',
      },
    ],
  };
  const annotations = githubAnnotations(report);
  assert.equal(annotations.length, 1);
  assert.match(annotations[0]!, /file=docs\/a%2Cb.md,line=12/);
  assert.ok(!annotations[0]!.includes('\n'));
  assert.match(annotations[0]!, /%0A/);
  const summary = githubSummary(report);
  assert.ok(!summary.includes('<script>'));
  assert.match(summary, /0\.5s/);
  const root = await mkdtemp(path.join(tmpdir(), 'freshclone-summary-'));
  try {
    const file = path.join(root, 'summary.md');
    await writeGithubReport({ ...report, ok: true }, file);
    assert.match(await readFile(file, 'utf8'), /PASSED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Python uses its own helper and services do not publish ports or mount host files', () => {
  const args = dockerArguments(
    '/workspace-temp',
    '/control-temp',
    'python:3.13-slim',
    'example',
    'python',
    'network',
  );
  assert.equal(args.at(-1), '/freshclone/container-runner.py');
  assert.ok(args.includes('python3'));
  assert.ok(args.includes('network'));
  const services = serviceArguments('test', 'network', 'database', {
    image: 'postgres:17-alpine',
    port: 5432,
    timeout: 30,
    env: { POSTGRES_PASSWORD: 'test-only' },
  });
  assert.ok(services.includes('POSTGRES_PASSWORD=test-only'));
  for (const flag of ['--publish', '-p', '-v', '--mount', '--privileged'])
    assert.ok(!services.includes(flag));
});

test('HTTP JSON expectations reject cyclic and non-finite YAML values before execution', () => {
  const config = (json: unknown) => ({
    version: 1,
    steps: [{ block: 'start', background: true }],
    expect: { http: { url: 'http://localhost:3000/', json } },
  });
  assert.throws(() => validateConfig(config({ count: Infinity })), /finite, acyclic/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => validateConfig(config(cycle)), /finite, acyclic/);
  assert.throws(() => validateConfig(config({ 'field..name': true })), /safe dotted/);
});

test('GitHub annotations point into the checkout when checking a subproject', async () => {
  const { repositoryReport } = await import('../src/reporting.js');
  const workspace = path.resolve('checkout');
  const root = path.join(workspace, 'apps', 'demo');
  const report: CheckReport = {
    ok: false,
    image: 'node:24',
    readme: 'docs/SETUP.md',
    durationMs: 0,
    steps: [{ block: 'start', line: 9, status: 'failed', output: '' }],
  };
  const relative = repositoryReport(report, root, workspace);
  assert.equal(relative.readme, 'apps/demo/docs/SETUP.md');
  assert.match(githubAnnotations(relative)[0]!, /file=apps\/demo\/docs\/SETUP.md,line=9/);
  const outside = repositoryReport(report, path.resolve('outside'), workspace);
  assert.ok(!githubAnnotations(outside)[0]!.includes('file='));
});
