// Built-in-only supervisor for Node application images. Optional paths support integration tests.
import { open, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const control = process.argv[2] ?? '/freshclone';
const workspace = process.argv[3] ?? '/workspace';
const temporary = process.argv[4] ?? '/tmp';
const { config, blocks, readme } = JSON.parse(
  await readFile(path.join(control, 'plan.json'), 'utf8'),
);
const started = Date.now();
const report = {
  schemaVersion: 1,
  ok: false,
  image: config.image,
  readme,
  scenario: config.scenario,
  steps: blocks.map((block) => ({
    block: block.id,
    line: block.line,
    status: 'skipped',
    output: '',
    durationMs: 0,
  })),
  assertions: [],
  durationMs: 0,
};
let active = -1;
let finished = false;
let stepTimer;
let child;
let stepStarted = 0;
const logPath = (index) => path.join(temporary, `freshclone-step-${index}.log`);
const progress = (message) =>
  process.stderr.write(`FRESHCLONE_EVENT ${JSON.stringify({ message })}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function output(index) {
  let file;
  try {
    file = await open(logPath(index), 'r');
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 65536));
    await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    await file?.close();
  }
}

async function finish(ok, error, failureKind) {
  if (finished) return;
  finished = true;
  clearTimeout(stepTimer);
  report.ok = ok;
  if (error) report.error = error;
  if (failureKind) report.failureKind = failureKind;
  if (active >= 0 && report.steps[active].status !== 'passed') {
    report.steps[active].status = 'failed';
    report.steps[active].durationMs = Date.now() - stepStarted;
  }
  report.durationMs = Date.now() - started;
  if (child?.pid) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
  for (let index = 0; index < blocks.length; index++)
    report.steps[index].output = await output(index);
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(ok ? 0 : 1));
}

async function assertions() {
  for (const file of config.expect?.files ?? []) {
    let ok = false;
    try {
      const resolved = await realpath(path.resolve(workspace, file));
      const relative = path.relative(await realpath(workspace), resolved);
      ok =
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        (await stat(resolved)).isFile();
    } catch {
      /* Missing files fail the expectation. */
    }
    report.assertions.push({ name: `file: ${file}`, ok });
  }
  for (const expected of config.expect?.output ?? []) {
    const index = blocks.findIndex((block) => block.id === expected.block);
    report.assertions.push({
      name: `output: ${expected.block}`,
      ok: (await output(index)).includes(expected.contains),
    });
  }
  const failed = report.assertions.filter((assertion) => !assertion.ok);
  await finish(
    !failed.length,
    failed.length
      ? `Expectations failed: ${failed.map((entry) => entry.name).join(', ')}.`
      : undefined,
    failed.length ? 'expectation' : undefined,
  );
}

function request(url, remainingMs) {
  return new Promise((resolve) => {
    let done = false;
    let request;
    const complete = (value) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        resolve(value);
      }
    };
    const deadline = setTimeout(
      () => {
        request?.destroy();
        complete(undefined);
      },
      Math.min(1000, remainingMs),
    );
    request = http.get(url, { family: 4 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          request.destroy();
          complete(undefined);
        } else chunks.push(chunk);
      });
      response.on('end', () =>
        complete({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
      response.on('error', () => complete(undefined));
    });
    request.on('error', () => complete(undefined));
  });
}

async function readiness() {
  const expected = config.expect.http;
  const until = Date.now() + expected.timeout * 1000;
  report.http = { url: expected.url, ok: false };
  progress(`Waiting for ${expected.url}`);
  while (!finished && Date.now() < until) {
    const response = await request(expected.url, until - Date.now());
    if (response) report.http.status = response.status;
    let matches = response?.status === expected.status;
    if (matches && expected.contains !== undefined)
      matches = response.body.includes(expected.contains);
    if (matches && expected.json) {
      try {
        const body = JSON.parse(response.body);
        matches = Object.entries(expected.json).every(([key, value]) => {
          let field = body;
          for (const part of key.split('.')) {
            if (field === null || typeof field !== 'object' || !Object.hasOwn(field, part))
              return false;
            field = field[part];
          }
          return isDeepStrictEqual(field, value);
        });
      } catch {
        matches = false;
      }
    }
    if (finished) return;
    if (matches) {
      report.http.ok = true;
      report.steps[active].status = 'passed';
      report.steps[active].durationMs = Date.now() - stepStarted;
      await assertions();
      return;
    }
    await delay(200);
  }
  if (!finished)
    await finish(
      false,
      `Application did not satisfy HTTP ${expected.status}${expected.contains !== undefined || expected.json ? ' and response content expectations' : ''} within ${expected.timeout}s.`,
      'readiness-timeout',
    );
}

function portOpen(host, port, remaining) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(
      () => {
        socket.destroy();
        resolve(false);
      },
      Math.min(1000, remaining),
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

process.on('SIGTERM', () => void finish(false, 'Check interrupted.', 'interrupted'));
process.on('SIGINT', () => void finish(false, 'Check interrupted.', 'interrupted'));

try {
  for (const [name, service] of Object.entries(config.services ?? {})) {
    progress(`Waiting for service ${name}:${service.port}`);
    const until = Date.now() + service.timeout * 1000;
    let ready = false;
    while (!finished && Date.now() < until) {
      if (await portOpen(name, service.port, until - Date.now())) {
        ready = true;
        break;
      }
      await delay(200);
    }
    if (finished) break;
    if (!ready) {
      await finish(
        false,
        `Service ${name}:${service.port} was not ready within ${service.timeout}s.`,
        'service-readiness',
      );
      break;
    }
  }
  if (!finished) {
    const script = ['set -e', 'umask 022'];
    for (let index = 0; index < blocks.length; index++) {
      const log = quote(logPath(index));
      const step = quote(path.join(control, `step-${index}.sh`));
      script.push(`printf '%s\\n' '{"event":"start","index":${index}}' >&3`);
      if (config.steps[index].background) {
        script.push(
          `. ${step} > ${log} 2>&1 &`,
          'freshclone_service_pid=$!',
          `printf '%s\\n' '{"event":"background","index":${index}}' >&3`,
          'wait "$freshclone_service_pid"',
        );
      } else {
        script.push(
          `. ${step} > ${log} 2>&1`,
          `printf '%s\\n' '{"event":"passed","index":${index}}' >&3`,
        );
      }
    }
    const scriptPath = path.join(temporary, 'freshclone-run.sh');
    await writeFile(scriptPath, script.join('\n') + '\n');
    child = spawn(config.shell ?? 'sh', [scriptPath], {
      cwd: workspace,
      env: { ...process.env, ...config.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let shellOutput = '';
    const append = (chunk) => {
      shellOutput = (shellOutput + chunk.toString()).slice(-65536);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let events = '';
    child.stdio[3].on('data', (chunk) => {
      events += chunk.toString();
      let boundary;
      while ((boundary = events.indexOf('\n')) !== -1) {
        const line = events.slice(0, boundary);
        events = events.slice(boundary + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!Number.isInteger(event.index) || !report.steps[event.index] || finished) continue;
        if (event.event === 'start') {
          active = event.index;
          stepStarted = Date.now();
          report.steps[active].status = 'failed';
          progress(`Running ${blocks[active].id} (${readme}:${blocks[active].line})`);
          clearTimeout(stepTimer);
          stepTimer = setTimeout(
            () =>
              void finish(
                false,
                `Step "${blocks[active].id}" exceeded ${config.timeout}s.`,
                'setup',
              ),
            config.timeout * 1000,
          );
        } else if (event.event === 'passed') {
          report.steps[event.index].status = 'passed';
          report.steps[event.index].exitCode = 0;
          report.steps[event.index].durationMs = Date.now() - stepStarted;
          clearTimeout(stepTimer);
        } else if (event.event === 'background') {
          clearTimeout(stepTimer);
          void readiness().catch((error) => finish(false, error.message, 'infrastructure'));
        }
      }
    });
    child.on(
      'error',
      (error) =>
        void finish(
          false,
          `Cannot launch ${config.shell ?? 'sh'}: ${error.message}`,
          'infrastructure',
        ),
    );
    child.on('close', (code) => {
      if (finished) return;
      const background = config.steps.at(-1).background;
      if (active >= 0 && (code !== 0 || background)) report.steps[active].exitCode = code;
      if (code === 0 && !background && report.steps.every((step) => step.status === 'passed'))
        void assertions().catch((error) => finish(false, error.message, 'infrastructure'));
      else
        void finish(
          false,
          `Step "${blocks[Math.max(0, active)].id}" exited before onboarding completed (exit ${code}).${shellOutput ? ` ${shellOutput.trim()}` : ''}`,
          background && active === blocks.length - 1 ? 'application-exit' : 'setup',
        );
    });
  }
} catch (error) {
  await finish(false, error.message, 'infrastructure');
}
