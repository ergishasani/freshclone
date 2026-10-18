import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { extractBlocks, type ReadmeBlock } from './markdown.js';

export interface FreshcloneStep {
  block: string;
  background?: boolean;
}

export interface HttpExpectation {
  url: string;
  status: number;
  /** Maximum number of seconds to wait for the expected response. */
  timeout: number;
}

export interface FreshcloneConfig {
  version: 1;
  readme: string;
  image: string;
  /** Maximum seconds allowed for each setup step. */
  timeout: number;
  steps: FreshcloneStep[];
  expect?: { http: HttpExpectation };
}

const blockIdPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} key "${key}".`);
  }
}

function nonemptyString(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    throw new Error(`${name} must be a nonempty string without surrounding whitespace.`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

/** Validate and normalize the intentionally small v1 configuration format. */
export function validateConfig(input: unknown): FreshcloneConfig {
  const raw = object(input, 'Configuration');
  knownKeys(raw, ['version', 'readme', 'image', 'timeout', 'steps', 'expect'], 'configuration');
  if (raw.version !== 1) throw new Error('version must be 1.');

  const readme = nonemptyString(raw.readme === undefined ? 'README.md' : raw.readme, 'readme');
  if (
    path.isAbsolute(readme) ||
    path.win32.isAbsolute(readme) ||
    /^[A-Za-z]:/.test(readme) ||
    readme.split(/[\\/]/).includes('..') ||
    readme.startsWith('-')
  ) {
    throw new Error(
      "readme must be a relative file path inside the repository, without '..' segments.",
    );
  }

  const image = nonemptyString(
    raw.image === undefined ? 'node:24-bookworm-slim' : raw.image,
    'image',
  );
  if (image.startsWith('-') || /\s/.test(image)) {
    throw new Error("image must be a Docker image reference without whitespace or a leading '-'.");
  }
  const timeout = integer(raw.timeout === undefined ? 60 : raw.timeout, 1, 600, 'timeout');

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('steps must be a nonempty array.');
  }
  const rawSteps: unknown[] = raw.steps;
  const seen = new Set<string>();
  let hasBackground = false;
  const steps: FreshcloneStep[] = rawSteps.map((entry: unknown, index: number) => {
    const step = object(entry, `steps[${index}]`);
    knownKeys(step, ['block', 'background'], `steps[${index}]`);
    const block = nonemptyString(step.block, `steps[${index}].block`);
    if (!blockIdPattern.test(block)) {
      throw new Error(
        `steps[${index}].block must start with a letter and contain only letters, numbers, '-' or '_'.`,
      );
    }
    if (seen.has(block)) throw new Error(`Duplicate step block reference "${block}".`);
    seen.add(block);
    if (step.background !== undefined && typeof step.background !== 'boolean') {
      throw new Error(`steps[${index}].background must be a boolean.`);
    }
    if (step.background === true) {
      if (hasBackground) throw new Error('Only one background step is allowed.');
      if (index !== rawSteps.length - 1)
        throw new Error('The background step must be the last step.');
      hasBackground = true;
    }
    return step.background === undefined ? { block } : { block, background: step.background };
  });

  const config: FreshcloneConfig = { version: 1, readme, image, timeout, steps };

  if (raw.expect !== undefined) {
    if (!hasBackground) throw new Error('expect.http is only allowed with a background step.');
    const expect = object(raw.expect, 'expect');
    knownKeys(expect, ['http'], 'expect');
    const http = object(expect.http, 'expect.http');
    knownKeys(http, ['url', 'status', 'timeout'], 'expect.http');
    const url = nonemptyString(http.url, 'expect.http.url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('expect.http.url must be a valid HTTP URL.');
    }
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      url.includes('#')
    ) {
      throw new Error(
        'expect.http.url must use http://127.0.0.1 or http://localhost without credentials or a fragment.',
      );
    }
    config.expect = {
      http: {
        url,
        status: integer(
          http.status === undefined ? 200 : http.status,
          200,
          599,
          'expect.http.status',
        ),
        timeout: integer(
          http.timeout === undefined ? 30 : http.timeout,
          1,
          300,
          'expect.http.timeout',
        ),
      },
    };
  } else if (hasBackground) {
    throw new Error('A background step requires expect.http.');
  }

  return config;
}

function assertInside(root: string, file: string, name: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must stay inside the repository (including symlink targets).`);
  }
}

/** Read a project's configuration and return only its selected README blocks. */
export async function loadProject(
  root: string,
  configPath = '.freshclone.yml',
): Promise<{ config: FreshcloneConfig; blocks: ReadmeBlock[]; readmePath: string }> {
  const rootPath = await realpath(root);
  const requestedConfig = path.resolve(rootPath, configPath);
  assertInside(rootPath, requestedConfig, 'Configuration file');
  const configFile = await realpath(requestedConfig);
  assertInside(rootPath, configFile, 'Configuration file');
  const source = await readFile(configFile, 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid FreshClone YAML: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const config = validateConfig(document.toJS({ maxAliasCount: 20 }) as unknown);
  const requestedReadme = path.resolve(rootPath, config.readme.replace(/[\\/]/g, path.sep));
  assertInside(rootPath, requestedReadme, 'README file');
  const readmeFile = await realpath(requestedReadme);
  assertInside(rootPath, readmeFile, 'README file');
  const blocks = extractBlocks(await readFile(readmeFile, 'utf8'));
  const selected = config.steps.map((step) => {
    const block = blocks.get(step.block);
    if (!block)
      throw new Error(`README is missing FreshClone block "${step.block}" referenced in steps.`);
    return block;
  });
  return {
    config,
    blocks: selected,
    readmePath: path.relative(rootPath, requestedReadme).split(path.sep).join('/'),
  };
}
