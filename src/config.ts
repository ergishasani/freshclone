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
  contains?: string;
  json?: Record<string, unknown>;
}

export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  port: number;
  timeout: number;
}

export interface Expectations {
  http?: HttpExpectation;
  files?: string[];
  output?: Array<{ block: string; contains: string }>;
}

export interface FreshcloneConfig {
  version: 1;
  readme: string;
  image: string;
  /** Maximum seconds allowed for each setup step. */
  timeout: number;
  steps: FreshcloneStep[];
  expect?: Expectations;
  runtime?: 'node' | 'python';
  shell?: 'sh' | 'bash';
  env?: Record<string, string>;
  services?: Record<string, ServiceConfig>;
  scenario?: string;
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
export function validateConfig(input: unknown, scenario?: string): FreshcloneConfig {
  let raw = object(input, 'Configuration');
  const fields = [
    'version',
    'readme',
    'image',
    'timeout',
    'steps',
    'expect',
    'runtime',
    'shell',
    'env',
    'services',
  ];
  knownKeys(raw, [...fields, 'scenarios'], 'configuration');
  if (raw.version !== 1) throw new Error('version must be 1.');
  if (raw.scenarios !== undefined) {
    const scenarios = object(raw.scenarios, 'scenarios');
    if (!Object.keys(scenarios).length) throw new Error('scenarios must not be empty.');
    const { scenarios: _scenarios, ...base } = raw;
    for (const [name, value] of Object.entries(scenarios)) {
      if (!blockIdPattern.test(name)) throw new Error(`Invalid scenario name "${name}".`);
      const overrides = object(value, `scenarios.${name}`);
      knownKeys(
        overrides,
        fields.filter((field) => !['version', 'readme'].includes(field)),
        `scenarios.${name}`,
      );
      validateConfig({ ...base, ...overrides });
    }
    if (scenario !== undefined) {
      if (!Object.hasOwn(scenarios, scenario))
        throw new Error(
          `Unknown scenario "${scenario}". Choose: ${Object.keys(scenarios).join(', ')}.`,
        );
      raw = { ...base, ...object(scenarios[scenario], `scenarios.${scenario}`) };
    } else {
      raw = base;
      if (raw.steps === undefined)
        throw new Error(`Choose --scenario: ${Object.keys(scenarios).join(', ')}.`);
    }
  } else if (scenario !== undefined) {
    throw new Error(`Unknown scenario "${scenario}"; no scenarios are configured.`);
  }
  if (raw.runtime !== undefined && !['node', 'python'].includes(raw.runtime as string))
    throw new Error('runtime must be node or python.');
  if (raw.shell !== undefined && !['sh', 'bash'].includes(raw.shell as string))
    throw new Error('shell must be sh or bash.');

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
    raw.image === undefined
      ? raw.runtime === 'python'
        ? 'python:3.13-slim'
        : 'node:24-bookworm-slim'
      : raw.image,
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
  if (raw.runtime !== undefined) config.runtime = raw.runtime as 'node' | 'python';
  if (raw.shell !== undefined) config.shell = raw.shell as 'sh' | 'bash';
  if (scenario) config.scenario = scenario;
  if (raw.env !== undefined) config.env = environment(raw.env, 'env');
  if (raw.services !== undefined) {
    config.services = {};
    for (const [name, value] of Object.entries(object(raw.services, 'services'))) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || ['localhost', 'host', 'gateway'].includes(name))
        throw new Error(`Invalid service name "${name}".`);
      const service = object(value, `services.${name}`);
      knownKeys(service, ['image', 'env', 'port', 'timeout'], `services.${name}`);
      const serviceImage = nonemptyString(service.image, `services.${name}.image`);
      if (serviceImage.startsWith('-') || /\s/.test(serviceImage))
        throw new Error(`services.${name}.image must be a Docker image reference.`);
      config.services[name] = {
        image: serviceImage,
        port: integer(service.port, 1, 65535, `services.${name}.port`),
        timeout: integer(service.timeout ?? 30, 1, 300, `services.${name}.timeout`),
        ...(service.env === undefined
          ? {}
          : { env: environment(service.env, `services.${name}.env`) }),
      };
    }
  }

  if (raw.expect !== undefined) {
    const expect = object(raw.expect, 'expect');
    knownKeys(expect, ['http', 'files', 'output'], 'expect');
    if (!Object.keys(expect).length) throw new Error('expect must not be empty.');
    config.expect = {};
    if (expect.http !== undefined) {
      if (!hasBackground) throw new Error('expect.http is only allowed with a background step.');
      const http = object(expect.http, 'expect.http');
      knownKeys(http, ['url', 'status', 'timeout', 'contains', 'json'], 'expect.http');
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
      config.expect.http = {
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
      };
      if (http.contains !== undefined)
        config.expect.http.contains = nonemptyString(http.contains, 'expect.http.contains');
      if (http.json !== undefined) {
        const json = object(http.json, 'expect.http.json');
        if (
          !Object.keys(json).length ||
          Object.keys(json).some(
            (key) =>
              !key ||
              key
                .split('.')
                .some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)),
          )
        )
          throw new Error('expect.http.json must contain safe dotted field paths.');
        assertJson(json);
        config.expect.http.json = json;
      }
    }
    if (expect.files !== undefined) {
      if (!Array.isArray(expect.files) || !expect.files.length)
        throw new Error('expect.files must be a nonempty array.');
      config.expect.files = expect.files.map((value: unknown) => {
        const file = nonemptyString(value, 'expect.files entry');
        if (
          path.posix.isAbsolute(file) ||
          path.win32.isAbsolute(file) ||
          /^[A-Za-z]:/.test(file) ||
          file.includes('\\') ||
          file.split('/').includes('..')
        )
          throw new Error('expect.files paths must stay inside the workspace.');
        return file;
      });
    }
    if (expect.output !== undefined) {
      if (!Array.isArray(expect.output) || !expect.output.length)
        throw new Error('expect.output must be a nonempty array.');
      config.expect.output = expect.output.map((value: unknown) => {
        const entry = object(value, 'expect.output entry');
        knownKeys(entry, ['block', 'contains'], 'expect.output');
        const block = nonemptyString(entry.block, 'expect.output.block');
        if (!seen.has(block))
          throw new Error(`expect.output references unselected block "${block}".`);
        if (steps.find((step) => step.block === block)?.background)
          throw new Error(
            'expect.output requires a foreground block; use HTTP content for server readiness.',
          );
        return { block, contains: nonemptyString(entry.contains, 'expect.output.contains') };
      });
    }
  }
  if (hasBackground && !config.expect?.http) {
    throw new Error('A background step requires expect.http.');
  }

  return config;
}

function environment(input: unknown, name: string): Record<string, string> {
  const env = object(input, name);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      [
        'NODE_OPTIONS',
        'NODE_PATH',
        'PYTHONPATH',
        'PYTHONHOME',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'PATH',
        'HOME',
        'BASH_ENV',
        'ENV',
        'SHELLOPTS',
      ].includes(key) ||
      key.startsWith('FRESHCLONE_')
    )
      throw new Error(`${name}.${key} is a reserved or invalid environment variable.`);
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error(`${name}.${key} must be a string without NUL bytes.`);
    result[key] = value;
  }
  return result;
}

function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 30) throw new Error('expect.http.json exceeds the maximum nesting depth of 30.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || ancestors.has(value))
    throw new Error('expect.http.json must contain finite, acyclic JSON values.');
  ancestors.add(value);
  for (const child of Object.values(value)) assertJson(child, ancestors, depth + 1);
  ancestors.delete(value);
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
  scenario?: string,
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
  const config = validateConfig(document.toJS({ maxAliasCount: 20 }) as unknown, scenario);
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
