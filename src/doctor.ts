import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProject } from './config.js';

const exec = promisify(execFile);
export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }>;
}

/** Read-only prerequisite checks; never executes README commands or pulls images. */
export async function doctor(
  root: string,
  configPath: string,
  scenario?: string,
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [
    {
      name: 'Node.js',
      ok: Number(process.versions.node.split('.')[0]) >= 22,
      detail: process.version,
      fix: 'Install Node.js 22 or newer.',
    },
  ];
  const results = await Promise.allSettled([
    exec('git', ['ls-files', '--cached', '-z', '--', '.'], { cwd: root, timeout: 10000 }),
    exec('docker', ['info', '--format', '{{.OSType}}'], { timeout: 10000 }),
    loadProject(root, configPath, scenario),
  ]);
  const [git, docker, project] = results;
  checks.push(
    git.status === 'fulfilled'
      ? {
          name: 'Git snapshot',
          ok: Boolean(git.value.stdout),
          detail: git.value.stdout
            ? 'Tracked project files are available.'
            : 'No tracked files in this project.',
          fix: 'Track the setup files with Git before running check.',
        }
      : {
          name: 'Git snapshot',
          ok: false,
          detail: 'Git is unavailable or this directory is outside a working tree.',
          fix: 'Install Git and select a Git working tree with --root.',
        },
  );
  checks.push(
    docker.status === 'fulfilled'
      ? {
          name: 'Docker',
          ok: docker.value.stdout.trim() === 'linux',
          detail: `Container mode: ${docker.value.stdout.trim()}`,
          fix: 'Select Linux containers in Docker Desktop.',
        }
      : {
          name: 'Docker',
          ok: false,
          detail: 'Cannot reach the Docker engine.',
          fix: 'Install Docker, start its daemon, and select Linux containers.',
        },
  );
  checks.push(
    project.status === 'fulfilled'
      ? {
          name: 'Configuration and README',
          ok: true,
          detail: `${project.value.blocks.length} selected blocks; ${project.value.config.runtime ?? 'node'} / ${project.value.config.shell ?? 'sh'}; image ${project.value.config.image}.`,
        }
      : {
          name: 'Configuration and README',
          ok: false,
          detail: (project.reason as Error).message,
          fix: 'Run init, add the missing markers, or correct the configuration / --scenario selection.',
        },
  );
  return { schemaVersion: 1, ok: checks.every((check) => check.ok), checks };
}
