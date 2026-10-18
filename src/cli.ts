#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { extractBlocks } from './markdown.js';
import { loadProject, validateConfig } from './config.js';
import { runCheck, type CheckReport } from './runner.js';

const HELP = `FreshClone — verify your documented setup journey

Usage: freshclone <init|plan|check> [options]

Commands:
  init     Create configuration from marked README blocks (never overwrites)
  plan     Validate configuration and show commands without executing them
  check    Run the selected commands in a disposable Linux Docker container

Options:
  --root <path>     Project directory (default: current directory)
  --config <path>   Config path relative to project (default: .freshclone.yml)
  --json            Emit a machine-readable plan or check report
  --help, -h        Show this help
  --version, -v     Show version

check executes repository code. Review the README and config before running.
Node.js 22+ is required; check also needs Git and a running Linux Docker engine.
`;

function printReport(report: CheckReport): void {
  console.log(`FreshClone — ${report.ok ? 'PASSED' : 'FAILED'} (${report.image})`);
  for (const step of report.steps) {
    console.log(
      `${step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–'} ${step.block}  ${report.readme}:${step.line}`,
    );
    if (step.status === 'failed' && step.output) console.log(step.output.trim());
  }
  if (report.http) console.log(`HTTP ${report.http.status ?? 'unavailable'}: ${report.http.url}`);
  if (report.error) console.error(report.error);
  console.log(`Completed in ${(report.durationMs / 1000).toFixed(1)}s`);
}

export async function main(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    json = values.json ?? false;
    if (values.help || args.length === 0) {
      console.log(HELP);
      return 0;
    }
    if (values.version) {
      console.log('0.1.0');
      return 0;
    }
    const [command] = positionals;
    if (positionals.length !== 1 || !['init', 'plan', 'check'].includes(command ?? ''))
      throw new Error('Choose exactly one command: init, plan, or check. Use --help for usage.');
    const root = await realpath(path.resolve(values.root ?? '.'));
    const configPath = values.config ?? '.freshclone.yml';
    if (command === 'init') {
      if (json) throw new Error('--json is supported by plan and check only.');
      if (
        path.isAbsolute(configPath) ||
        path.win32.isAbsolute(configPath) ||
        configPath.includes('\\') ||
        configPath.split('/').includes('..')
      )
        throw new Error('--config must be a relative path inside the project.');
      const target = path.resolve(root, configPath);
      const parent = await realpath(path.dirname(target));
      const relative = path.relative(root, parent);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Config directory must remain inside the project.');
      const blocks = extractBlocks(await readFile(path.join(root, 'README.md'), 'utf8'));
      if (!blocks.size)
        throw new Error(
          'Mark README shell blocks first, for example <!-- freshclone:install --> before a fenced sh block.',
        );
      const steps = [...blocks.keys()].map((block) => ({ block }));
      const config = validateConfig({ version: 1, steps });
      const note =
        '# Generated setup-only recipe. To test a server, mark the last step background: true\n# and add expect.http (see docs/configuration.md).\n';
      await writeFile(target, note + stringify(config), { flag: 'wx' });
      console.log(
        `Created ${configPath}. Review the selected commands with freshclone plan before checking.`,
      );
      return 0;
    }
    const project = await loadProject(root, configPath);
    if (command === 'plan') {
      const plan = {
        image: project.config.image,
        readme: project.readmePath,
        timeout: project.config.timeout,
        steps: project.blocks.map((block, index) => ({
          block: block.id,
          line: block.line,
          command: block.command,
          background: project.config.steps[index]?.background ?? false,
        })),
        expect: project.config.expect,
      };
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`FreshClone plan — ${plan.image}`);
        for (const step of plan.steps)
          console.log(
            `\n${step.block}${step.background ? ' (background)' : ''} — ${plan.readme}:${step.line}\n${step.command}`,
          );
        if (plan.expect)
          console.log(`\nExpect HTTP ${plan.expect.http.status}: ${plan.expect.http.url}`);
        console.log('\nNo commands executed.');
      }
      return 0;
    }
    const report = await runCheck(root, project.config, project.blocks, project.readmePath);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = (error as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`FreshClone: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
