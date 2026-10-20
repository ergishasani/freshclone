import { readFile, realpath, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { extractBlocks, type ReadmeBlock } from './markdown.js';
import { validateConfig, type FreshcloneConfig } from './config.js';

export interface InitOptions {
  blocks?: string;
  start?: string;
  url?: string;
  runtime?: string;
  shell?: string;
  image?: string;
}
export type Prompt = (question: string, defaultValue: string) => Promise<string>;

export async function initProject(
  root: string,
  configPath: string,
  options: InitOptions,
  prompt?: Prompt,
): Promise<void> {
  if (
    path.isAbsolute(configPath) ||
    path.win32.isAbsolute(configPath) ||
    configPath.includes('\\') ||
    configPath.split('/').includes('..')
  )
    throw new Error('--config must be a relative path inside the project.');
  const target = path.resolve(root, configPath);
  const parent = await realpath(path.dirname(target));
  assertInside(root, parent);
  try {
    await access(target);
    throw new Error(`${configPath} already exists; init never overwrites.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const readme = await realpath(path.join(root, 'README.md'));
  assertInside(root, readme);
  const blocks = extractBlocks(await readFile(readme, 'utf8'));
  if (!blocks.size)
    throw new Error(
      'Mark README shell blocks first, for example <!-- freshclone:install --> before a fenced sh block.',
    );
  const selected = { ...options };
  if (prompt) {
    console.error('Available README blocks: ' + [...blocks.keys()].join(', '));
    selected.blocks ??= await prompt(
      'Blocks to execute, in order (comma-separated)',
      [...blocks.keys()].join(','),
    );
    selected.runtime ??= await prompt('Application runtime (node or python)', 'node');
    selected.shell ??= await prompt('Shell (sh or bash)', 'sh');
    selected.image ??= await prompt(
      'Container image',
      selected.runtime === 'python' ? 'python:3.13-slim' : 'node:24-bookworm-slim',
    );
    selected.start ??= await prompt('Server block (leave empty for setup only)', '');
    if (selected.start)
      selected.url ??= await prompt('Readiness URL inside the container', 'http://127.0.0.1:3000/');
  }
  const config = initialConfig(blocks, selected);
  await writeFile(
    target,
    '# Generated from explicitly selected README blocks. Review with freshclone plan.\n' +
      stringify(config),
    { flag: 'wx' },
  );
}

export function initialConfig(
  blocks: Map<string, ReadmeBlock>,
  options: InitOptions,
): FreshcloneConfig {
  const ids =
    options.blocks === undefined
      ? [...blocks.keys()]
      : options.blocks.split(',').map((id) => id.trim());
  for (const id of ids)
    if (!blocks.has(id))
      throw new Error(`Unknown README block "${id}". Choose: ${[...blocks.keys()].join(', ')}.`);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate selected blocks.');
  if (options.url && !options.start) throw new Error('--url requires --start.');
  if (options.start && !ids.includes(options.start))
    throw new Error('The server block must be selected in --blocks.');
  const ordered = options.start
    ? [...ids.filter((id) => id !== options.start), options.start]
    : ids;
  return validateConfig({
    version: 1,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.shell ? { shell: options.shell } : {}),
    ...(options.image ? { image: options.image } : {}),
    steps: ordered.map((block) =>
      options.start === block ? { block, background: true } : { block },
    ),
    ...(options.start
      ? { expect: { http: { url: options.url ?? 'http://127.0.0.1:3000/' } } }
      : {}),
  });
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(
      'Config directory and README must remain inside the project, including symlink targets.',
    );
}
