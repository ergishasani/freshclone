// Runs inside the disposable Node container. This file uses Node built-ins only.
import { open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const { config, blocks, readme } = JSON.parse(await readFile('/freshclone/plan.json', 'utf8'));
const started = Date.now();
const report = {
  ok: false,
  image: config.image,
  readme,
  steps: blocks.map((block) => ({
    block: block.id,
    line: block.line,
    status: 'skipped',
    output: '',
  })),
  durationMs: 0,
};
let active = -1;
let finished = false;
let stepTimer;
let child;

async function finish(ok, error) {
  if (finished) return;
  finished = true;
  clearTimeout(stepTimer);
  report.ok = ok;
  if (error) report.error = error;
  if (!ok && active >= 0 && report.steps[active].status !== 'passed')
    report.steps[active].status = 'failed';
  report.durationMs = Date.now() - started;
  child?.kill('SIGTERM');
  for (let index = 0; index < report.steps.length; index++) {
    let file;
    try {
      file = await open(`/tmp/freshclone-step-${index}.log`, 'r');
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, 65536));
      await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      report.steps[index].output = buffer.toString('utf8');
    } catch {
      // Skipped steps never create a log file.
    } finally {
      await file?.close();
    }
  }
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(ok ? 0 : 1));
}

function requestStatus(url, remainingMs) {
  return new Promise((resolve) => {
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(url, { timeout: 1000, family: 4 }, (response) => {
      clearTimeout(deadline);
      response.resume();
      resolve(response.statusCode);
    });
    const deadline = setTimeout(() => request.destroy(), Math.min(1000, remainingMs));
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
  });
}

async function readiness() {
  const expected = config.expect.http;
  const until = Date.now() + expected.timeout * 1000;
  report.http = { url: expected.url, ok: false };
  while (!finished && Date.now() < until) {
    const status = await requestStatus(expected.url, until - Date.now());
    if (status !== undefined) report.http.status = status;
    if (finished) return;
    if (status === expected.status) {
      report.http.ok = true;
      report.steps[active].status = 'passed';
      finish(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!finished)
    finish(
      false,
      `Application did not return HTTP ${expected.status} within ${expected.timeout}s.`,
    );
}

const script = ['set -e', 'umask 022'];
for (let index = 0; index < blocks.length; index++) {
  script.push(`printf '%s\\n' '{"event":"start","index":${index}}' >&3`);
  if (config.steps[index].background) {
    script.push(
      `. /freshclone/step-${index}.sh > /tmp/freshclone-step-${index}.log 2>&1 &`,
      'freshclone_service_pid=$!',
      `printf '%s\\n' '{"event":"background","index":${index}}' >&3`,
      'wait "$freshclone_service_pid"',
    );
  } else {
    script.push(
      `. /freshclone/step-${index}.sh > /tmp/freshclone-step-${index}.log 2>&1`,
      `printf '%s\\n' '{"event":"passed","index":${index}}' >&3`,
    );
  }
}
await writeFile('/tmp/freshclone-run.sh', script.join('\n') + '\n');
child = spawn('sh', ['/tmp/freshclone-run.sh'], {
  cwd: '/workspace',
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
// Shell wrapper errors are distinct from command logs; drain their bounded tail.
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
    const event = JSON.parse(line);
    if (event.event === 'start') {
      active = event.index;
      report.steps[active].status = 'failed';
      clearTimeout(stepTimer);
      stepTimer = setTimeout(
        () => finish(false, `Step "${blocks[active].id}" exceeded ${config.timeout}s.`),
        config.timeout * 1000,
      );
    } else if (event.event === 'passed') {
      report.steps[event.index].status = 'passed';
      report.steps[event.index].exitCode = 0;
      clearTimeout(stepTimer);
    } else if (event.event === 'background') {
      clearTimeout(stepTimer);
      void readiness();
    }
  }
});
child.on('error', (error) => finish(false, error.message));
child.on('close', (code) => {
  if (finished) return;
  const background = config.steps.at(-1).background;
  if (active >= 0 && (code !== 0 || background)) report.steps[active].exitCode = code;
  const passed =
    code === 0 && !background && report.steps.every((step) => step.status === 'passed');
  finish(
    passed,
    passed
      ? undefined
      : `Step "${blocks[Math.max(0, active)].id}" exited before onboarding completed (exit ${code}).${shellOutput ? ` ${shellOutput.trim()}` : ''}`,
  );
});
process.on('SIGTERM', () => finish(false, 'Check interrupted.'));
process.on('SIGINT', () => finish(false, 'Check interrupted.'));
