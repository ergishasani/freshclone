import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  lstat,
  copyFile,
  writeFile,
  rm,
  readFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { FreshcloneConfig } from './config.js';
import type { ReadmeBlock } from './markdown.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;

export interface CheckReport {
  schemaVersion?: 1;
  ok: boolean;
  image: string;
  readme: string;
  steps: Array<{
    block: string;
    line: number;
    status: 'passed' | 'failed' | 'skipped';
    exitCode?: number;
    output: string;
    durationMs?: number;
  }>;
  http?: { url: string; status?: number; ok: boolean };
  error?: string;
  failureKind?:
    | 'configuration'
    | 'infrastructure'
    | 'setup'
    | 'application-exit'
    | 'readiness-timeout'
    | 'expectation'
    | 'interrupted'
    | 'service-readiness';
  scenario?: string;
  assertions?: Array<{ name: string; ok: boolean; error?: string }>;
  durationMs: number;
}

/** Snapshot tracked working-tree files only; never mount the caller's repository. */
export async function snapshotTrackedFiles(root: string, destination: string): Promise<void> {
  // Git can expand Windows 8.3 paths or resolve directory aliases. Compare paths
  // in the same canonical form without resolving individual tracked symlinks.
  const projectRoot = await realpath(root);
  const { stdout: top } = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectRoot,
  });
  const repository = await realpath(path.resolve(top.trim()));
  const { stdout } = await exec('git', ['ls-files', '--cached', '--deduplicate', '-z'], {
    cwd: repository,
    maxBuffer: 8 * MAX_OUTPUT,
  });
  let copied = 0;
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const source = path.resolve(repository, entry);
    const relative = path.relative(projectRoot, source);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
      continue;
    const segments = relative.split(path.sep);
    if (segments.some((part) => part === '.git' || part === 'node_modules')) continue;
    if (
      segments.some(
        (part) => /^\.env(?:\.|$)/.test(part) && !/^\.env\.(example|sample|template)$/.test(part),
      )
    )
      continue;
    // Check every component so an ancestor directory symlink cannot escape the project.
    let component = projectRoot;
    let missing = false;
    for (const segment of segments) {
      component = path.join(component, segment);
      try {
        if ((await lstat(component)).isSymbolicLink()) {
          throw new Error(`Symbolic links are not supported in snapshots: ${relative}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing = true;
          break;
        }
        throw error;
      }
    }
    if (missing) continue;
    if (!(await lstat(source)).isFile()) throw new Error(`Unsupported tracked entry: ${relative}`);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    copied++;
  }
  if (!copied)
    throw new Error('No tracked project files found. Add the project files to Git first.');
}

export function dockerArguments(
  workspace: string,
  control: string,
  image: string,
  name: string,
  runtime: 'node' | 'python' = 'node',
  network?: string,
): string[] {
  if ([workspace, control].some((value) => value.includes(','))) {
    throw new Error(
      'Docker bind mount paths cannot contain commas. Choose a different temporary directory.',
    );
  }
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--user',
    `${uid}:${gid}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    '--env',
    'HOME=/tmp',
    '--env',
    'npm_config_cache=/tmp/npm-cache',
    '--mount',
    `type=bind,source=${workspace},target=/workspace`,
    '--mount',
    `type=bind,source=${control},target=/freshclone,readonly`,
    '--workdir',
    '/workspace',
    ...(network ? ['--network', network] : []),
    '--entrypoint',
    runtime === 'python' ? 'python3' : 'node',
    image,
    runtime === 'python' ? '/freshclone/container-runner.py' : '/freshclone/container-runner.mjs',
  ];
}

export async function runCheck(
  root: string,
  config: FreshcloneConfig,
  blocks: ReadmeBlock[],
  readme: string,
  onProgress?: (message: string) => void,
): Promise<CheckReport> {
  const started = Date.now();
  const base: CheckReport = {
    schemaVersion: 1,
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
    ...(config.scenario ? { scenario: config.scenario } : {}),
  };
  let temporary: string | undefined;
  const name = `freshclone-${randomUUID()}`;
  const network = Object.keys(config.services ?? {}).length ? `${name}-network` : undefined;
  const containers = [name];
  const cleanupContainer = async () => {
    await Promise.all(
      containers.map((container) =>
        exec('docker', ['rm', '--force', container], { timeout: 10000 }).catch(() => undefined),
      ),
    );
  };
  let interrupted = false;
  const controller = new AbortController();
  let dockerProcess: ReturnType<typeof spawn> | undefined;
  const interrupt = () => {
    interrupted = true;
    controller.abort();
    dockerProcess?.kill();
    void cleanupContainer();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    temporary = await mkdtemp(path.join(tmpdir(), 'freshclone-'));
    await exec('docker', ['info', '--format', '{{.OSType}}'], {
      timeout: 10000,
      signal: controller.signal,
    })
      .then(({ stdout }) => {
        if (stdout.trim() !== 'linux')
          throw new Error('FreshClone requires Docker in Linux-container mode.');
      })
      .catch((error: Error) => {
        throw new Error(
          `Docker is unavailable. Start the Linux Docker engine and retry. ${error.message}`,
        );
      });
    const workspace = path.join(temporary, 'workspace');
    const control = path.join(temporary, 'control');
    await mkdir(workspace);
    await mkdir(control);
    await snapshotTrackedFiles(root, workspace);
    const helperName = config.runtime === 'python' ? 'container-runner.py' : 'container-runner.mjs';
    const helper = await readFile(new URL(`../../assets/${helperName}`, import.meta.url), 'utf8');
    await writeFile(path.join(control, helperName), helper);
    await writeFile(path.join(control, 'plan.json'), JSON.stringify({ config, blocks, readme }));
    await Promise.all(
      blocks.map((block, index) =>
        writeFile(path.join(control, `step-${index}.sh`), `${block.command}\n`),
      ),
    );
    if (network) {
      onProgress?.('Creating disposable service network');
      await exec('docker', ['network', 'create', network], {
        timeout: 10000,
        signal: controller.signal,
      });
      for (const [alias, service] of Object.entries(config.services ?? {})) {
        if (interrupted) throw new Error('Check interrupted.');
        const serviceName = `${name}-${alias}`;
        containers.push(serviceName);
        onProgress?.(`Starting service ${alias}`);
        await exec('docker', serviceArguments(serviceName, network, alias, service), {
          timeout: 180000,
          signal: controller.signal,
        });
        if (interrupted) throw new Error('Check interrupted.');
      }
    }
    const args = dockerArguments(workspace, control, config.image, name, config.runtime, network);
    if (interrupted) throw new Error('Check interrupted.');
    const timeoutMs =
      (config.timeout * blocks.length +
        (config.expect?.http?.timeout ?? 0) +
        Object.values(config.services ?? {}).reduce((sum, service) => sum + service.timeout, 0) +
        180) *
      1000;
    onProgress?.(`Starting ${config.image}`);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('docker', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        dockerProcess = child;
        let stdout = '';
        const decoder = new StringDecoder('utf8');
        // JSON can escape a retained log byte into six characters. Size transport
        // for every step instead of truncating a valid multi-step report at 1 MiB.
        const maxReport = MAX_OUTPUT + blocks.length * 65536 * 6;
        let stderr = '';
        let progress = '';
        const timer = setTimeout(() => {
          child.kill();
          void cleanupContainer();
          reject(new Error('Docker execution exceeded its overall time limit.'));
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = (stdout + decoder.write(chunk)).slice(-maxReport);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT);
          progress = (progress + chunk.toString()).slice(-MAX_OUTPUT);
          let boundary: number;
          while ((boundary = progress.indexOf('\n')) !== -1) {
            const line = progress.slice(0, boundary);
            progress = progress.slice(boundary + 1);
            if (line.startsWith('FRESHCLONE_EVENT ')) {
              try {
                const event = JSON.parse(line.slice('FRESHCLONE_EVENT '.length)) as {
                  message?: unknown;
                };
                if (typeof event.message === 'string') onProgress?.(event.message);
              } catch {
                /* Ignore malformed progress without corrupting the report. */
              }
            }
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          stdout += decoder.end();
          resolve({ code, stdout, stderr });
        });
      },
    );
    if (interrupted) throw new Error('Check interrupted.');
    if (!result.stdout.trim())
      throw new Error(
        `Docker did not return a report (exit ${result.code}): ${result.stderr.trim()}`,
      );
    const report = JSON.parse(result.stdout) as CheckReport;
    if (typeof report.ok !== 'boolean' || !Array.isArray(report.steps))
      throw new Error('Docker returned an invalid report.');
    // Do not claim success if the container itself reported failure.
    if (result.code !== 0) report.ok = false;
    if (!report.ok && !report.failureKind) report.failureKind = 'infrastructure';
    return { ...report, readme, scenario: config.scenario, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ...base,
      failureKind: interrupted ? 'interrupted' : 'infrastructure',
      error: (error as Error).message,
      durationMs: Date.now() - started,
    };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await cleanupContainer();
    if (network)
      await exec('docker', ['network', 'rm', network], { timeout: 10000 }).catch(() => undefined);
    // The path is created by mkdtemp above and is never derived from repository input.
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function serviceArguments(
  name: string,
  network: string,
  alias: string,
  service: import('./config.js').ServiceConfig,
): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--network',
    network,
    '--network-alias',
    alias,
    '--security-opt=no-new-privileges',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '256',
    ...Object.entries(service.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    service.image,
  ];
}
