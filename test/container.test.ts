import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadProject, validateConfig } from '../src/config.js';
import { runCheck } from '../src/runner.js';
import type { ReadmeBlock } from '../src/markdown.js';

const exec = promisify(execFile);
const enabled = process.env.FRESHCLONE_DOCKER_TESTS === '1';

for (const runtime of ['node', 'python'] as const) {
  test(
    `${runtime} container: shell state, expectations, readiness, errors, and cleanup`,
    { skip: !enabled, timeout: 480000 },
    async (context) => {
      const base = await mkdtemp(path.join(tmpdir(), 'freshclone-integration-'));
      const root = path.join(base, 'project');
      await mkdir(root);
      await writeFile(path.join(root, 'tracked.txt'), 'original');
      await exec('git', ['init', '--quiet', '--template='], { cwd: root });
      await exec('git', ['add', '--', 'tracked.txt'], { cwd: root });
      const image = runtime === 'node' ? 'node:24-bookworm-slim' : 'python:3.13-slim';
      await exec('docker', ['pull', image], { timeout: 180000 });
      const block = (id: string, command: string): ReadmeBlock => ({ id, command, line: 5 });
      const run = async (blocks: ReadmeBlock[], extra: Record<string, unknown> = {}) => {
        const config = validateConfig({
          version: 1,
          runtime,
          timeout: 5,
          steps: blocks.map((entry) => ({ block: entry.id })),
          ...extra,
        });
        return runCheck(root, config, blocks, 'README.md');
      };
      try {
        await context.test(
          'preserves cd/export, explicit env, Bash, files and output',
          async () => {
            const result = await run(
              [
                block('prepare', 'mkdir generated\ncd generated\nexport MESSAGE=ready'),
                block(
                  'verify',
                  '[[ "$MESSAGE" = ready ]]\n[ "$TEST_VALUE" = sample ]\nprintf ready > result.txt\necho finished',
                ),
              ],
              {
                shell: 'bash',
                env: { TEST_VALUE: 'sample' },
                expect: {
                  files: ['generated/result.txt'],
                  output: [{ block: 'verify', contains: 'finished' }],
                },
              },
            );
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.ok(result.assertions?.every((entry) => entry.ok));
            assert.ok(result.steps.every((step) => typeof step.durationMs === 'number'));
          },
        );
        await context.test('classifies failed file/output expectations', async () => {
          const result = await run([block('setup', 'echo actual')], {
            expect: { files: ['missing.txt'], output: [{ block: 'setup', contains: 'expected' }] },
          });
          assert.equal(result.failureKind, 'expectation', JSON.stringify(result));
          assert.equal(result.ok, false);
        });
        await context.test('classifies setup failures and preserves logs', async () => {
          const result = await run([block('setup', 'echo missing-configuration >&2\nexit 7')]);
          assert.equal(result.failureKind, 'setup', JSON.stringify(result));
          assert.equal(result.steps[0]?.exitCode, 7);
          assert.match(result.steps[0]?.output ?? '', /missing-configuration/);
        });
        await context.test('times out a foreground step', async () => {
          const result = await run([block('setup', 'sleep 5')], { timeout: 1 });
          assert.equal(result.failureKind, 'setup', JSON.stringify(result));
          assert.match(result.error ?? '', /exceeded 1s/);
        });
        await context.test(
          'retains bounded step logs when the complete JSON report exceeds 1 MiB',
          async () => {
            const blocks = Array.from({ length: 18 }, (_, index) =>
              block(`log${index}`, "head -c 70000 /dev/zero | tr '\\000' x"),
            );
            const result = await run(blocks);
            assert.equal(result.ok, true, JSON.stringify({ error: result.error }));
            assert.ok(result.steps.every((step) => step.output.length === 65536));
          },
        );
        const server =
          runtime === 'node'
            ? `node -e 'require("node:http").createServer((q,s)=>{s.setHeader("Content-Type","application/json");s.end(JSON.stringify({ready:true,nested:{state:"ok"}}))}).listen(3000,"0.0.0.0")'`
            : `python3 -u -c 'from http.server import BaseHTTPRequestHandler,HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b"{\\"ready\\":true,\\"nested\\":{\\"state\\":\\"ok\\"}}")\nHTTPServer(("0.0.0.0",3000),Handler).serve_forever()'`;
        const web = {
          steps: [{ block: 'start', background: true }],
          expect: {
            http: {
              url: 'http://127.0.0.1:3000/',
              timeout: 3,
              contains: 'ready',
              json: { ready: true, 'nested.state': 'ok' },
            },
          },
        };
        await context.test('verifies HTTP status, content and nested JSON fields', async () => {
          const result = await run([block('start', server)], web);
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.http?.ok, true);
        });
        await context.test('rejects a 200 response with incorrect JSON', async () => {
          const result = await run([block('start', server)], {
            ...web,
            expect: { http: { url: 'http://127.0.0.1:3000/', timeout: 1, json: { ready: false } } },
          });
          assert.equal(result.failureKind, 'readiness-timeout', JSON.stringify(result));
          assert.equal(result.http?.ok, false);
        });
        await context.test('identifies an application that exits before readiness', async () => {
          const result = await run([block('start', 'echo application-exited\nexit 0')], web);
          assert.equal(result.failureKind, 'application-exit', JSON.stringify(result));
        });
        await context.test('times out an unavailable service', async () => {
          const result = await run([block('setup', 'echo must-not-run')], {
            services: { cache: { image, port: 12345, timeout: 1 } },
          });
          assert.equal(result.failureKind, 'service-readiness', JSON.stringify(result));
          assert.equal(result.steps[0]?.status, 'skipped');
        });
      } finally {
        // base is a fresh mkdtemp path; remove only this fixture.
        await rm(base, { recursive: true, force: true });
      }
    },
  );
}

test(
  'database services are reachable by alias and all Docker resources are removed',
  { skip: !enabled, timeout: 240000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'freshclone-services-'));
    try {
      await writeFile(path.join(root, 'tracked.txt'), 'service fixture');
      await exec('git', ['init', '--quiet', '--template='], { cwd: root });
      await exec('git', ['add', '--', 'tracked.txt'], { cwd: root });
      const config = validateConfig({
        version: 1,
        runtime: 'python',
        timeout: 15,
        services: {
          cache: { image: 'redis:7-alpine', port: 6379 },
          database: {
            image: 'postgres:17-alpine',
            port: 5432,
            env: { POSTGRES_PASSWORD: 'freshclone-test-only' },
          },
        },
        steps: [{ block: 'verify' }],
        expect: { output: [{ block: 'verify', contains: 'services-ready' }] },
      });
      const command = `python3 -c 'import socket,struct\ns=socket.create_connection(("cache",6379));s.sendall(b"PING\\r\\n");assert b"PONG" in s.recv(1024);s.close()\ns=socket.create_connection(("database",5432));s.sendall(struct.pack("!II",8,80877103));assert s.recv(1) in (b"S",b"N");s.close()\nprint("services-ready")'`;
      const result = await runCheck(
        root,
        config,
        [{ id: 'verify', command, line: 5 }],
        'README.md',
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      // No host ports or workspace/socket mounts are passed to service containers.
      const containers = await exec('docker', [
        'ps',
        '-a',
        '--filter',
        'name=freshclone-',
        '--format',
        '{{.Names}}',
      ]);
      const networks = await exec('docker', [
        'network',
        'ls',
        '--filter',
        'name=freshclone-',
        '--format',
        '{{.Name}}',
      ]);
      assert.equal(containers.stdout.trim(), '');
      assert.equal(networks.stdout.trim(), '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'bundled examples and documented fixes match their advertised results',
  { skip: !enabled, timeout: 240000 },
  async (context) => {
    const cases = [
      ['hello-node', undefined, undefined],
      ['hello-node', 'production', undefined],
      ['hello-python', undefined, undefined],
      ['services-python', undefined, undefined],
      ['broken-node', undefined, 'application-exit'],
      ['broken-config', undefined, 'application-exit'],
      ['broken-migration', undefined, 'application-exit'],
      ['never-ready', undefined, 'readiness-timeout'],
    ] as const;
    for (const [example, scenario, failure] of cases) {
      await context.test(`${example}${scenario ? ` / ${scenario}` : ''}`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'freshclone-example-'));
        try {
          await cp(new URL(`../../examples/${example}/`, import.meta.url), root, {
            recursive: true,
          });
          await exec('git', ['init', '--quiet', '--template='], { cwd: root });
          await exec('git', ['add', '--force', '--', '.'], { cwd: root });
          const run = async () => {
            const project = await loadProject(root, '.freshclone.yml', scenario);
            return runCheck(root, project.config, project.blocks, project.readmePath);
          };
          const result = await run();
          assert.equal(result.ok, failure === undefined, JSON.stringify(result));
          if (failure) assert.equal(result.failureKind, failure, JSON.stringify(result));
          if (example === 'broken-config' || example === 'broken-migration') {
            const readme = await readFile(path.join(root, 'README.md'), 'utf8');
            const from =
              example === 'broken-config'
                ? 'node --check server.mjs'
                : 'python3 -m py_compile app.py migrate.py';
            const fix = example === 'broken-config' ? 'cp .env.example .env' : 'python3 migrate.py';
            await writeFile(path.join(root, 'README.md'), readme.replace(from, from + '\n' + fix));
            const repaired = await run();
            assert.equal(repaired.ok, true, JSON.stringify(repaired));
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  },
);
