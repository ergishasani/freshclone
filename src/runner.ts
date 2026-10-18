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
import type { FreshcloneConfig } from './config.js';
import type { ReadmeBlock } from './markdown.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;

export interface CheckReport {
  ok: boolean;
  image: string;
  readme: string;
  steps: Array<{
    block: string;
    line: number;
    status: 'passed' | 'failed' | 'skipped';
    exitCode?: number;
    output: string;
  }>;
  http?: { url: string; status?: number; ok: boolean };
  error?: string;
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
    '--entrypoint',
    'node',
    image,
    '/freshclone/container-runner.mjs',
  ];
}

export async function runCheck(
  root: string,
  config: FreshcloneConfig,
  blocks: ReadmeBlock[],
  readme: string,
): Promise<CheckReport> {
  const started = Date.now();
  const base: CheckReport = {
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
  const temporary = await mkdtemp(path.join(tmpdir(), 'freshclone-'));
  const name = `freshclone-${randomUUID()}`;
  const cleanupContainer = () =>
    exec('docker', ['rm', '--force', name], { timeout: 10000 }).catch(() => undefined);
  let interrupted = false;
  let dockerProcess: ReturnType<typeof spawn> | undefined;
  const interrupt = () => {
    interrupted = true;
    dockerProcess?.kill();
    void cleanupContainer();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await exec('docker', ['info', '--format', '{{.OSType}}'], { timeout: 10000 })
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
    const helper = await readFile(
      new URL('../../assets/container-runner.mjs', import.meta.url),
      'utf8',
    );
    await writeFile(path.join(control, 'container-runner.mjs'), helper);
    await writeFile(path.join(control, 'plan.json'), JSON.stringify({ config, blocks, readme }));
    await Promise.all(
      blocks.map((block, index) =>
        writeFile(path.join(control, `step-${index}.sh`), `${block.command}\n`),
      ),
    );
    const args = dockerArguments(workspace, control, config.image, name);
    if (interrupted) throw new Error('Check interrupted.');
    const timeoutMs =
      (config.timeout * blocks.length + (config.expect?.http.timeout ?? 0) + 180) * 1000;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('docker', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        dockerProcess = child;
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          void cleanupContainer();
          reject(new Error('Docker execution exceeded its overall time limit.'));
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
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
    // Do not claim success if the container itself reported failure.
    if (result.code !== 0) report.ok = false;
    return { ...report, durationMs: Date.now() - started };
  } catch (error) {
    return { ...base, error: (error as Error).message, durationMs: Date.now() - started };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await cleanupContainer();
    // The path is created by mkdtemp above and is never derived from repository input.
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
