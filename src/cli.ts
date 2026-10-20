#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadProject } from './config.js';
import { runCheck, type CheckReport } from './runner.js';
import { doctor } from './doctor.js';
import { initProject } from './init.js';
import { repositoryReport, writeGithubReport } from './reporting.js';

const HELP = `FreshClone — verify your documented setup journey

Usage: freshclone <init|plan|doctor|check> [options]

Commands:
  init     Create configuration from explicitly marked README blocks
  plan     Validate configuration and show commands without executing them
  doctor   Diagnose Git, Docker, configuration, and README prerequisites
  check    Run setup and expectations in disposable Linux containers

Options:
  --root <path>       Project directory (default: current directory)
  --config <path>     Config path relative to project (default: .freshclone.yml)
  --scenario <name>   Select a named setup scenario (plan, doctor, check)
  --json              Emit machine-readable output (plan, doctor, check)
  --github            Write GitHub summary and failure annotations (check)
  --quiet             Suppress live progress (check)
  --interactive       Guided initialization (also automatic in a terminal)
  --no-interactive    Generate init config without prompts
  --blocks <a,b>      Select ordered README blocks (init)
  --start <block>     Move selected server block last and run in background (init)
  --url <url>         Server readiness URL (init; default http://127.0.0.1:3000/)
  --runtime <name>    node or python (init; default node)
  --shell <name>      sh or bash (init; default sh)
  --image <image>     Override runtime image (init)
  --help, -h          Show this help
  --version, -v       Show version

check executes repository code. Review the README and config before running.
Node.js 22+ is required on the host; check also needs Git and Linux Docker.
`;

function printReport(report: CheckReport, includeOutput: boolean): void {
  console.log(`FreshClone — ${report.ok ? 'PASSED' : 'FAILED'} (${report.image})`);
  for (const step of report.steps) {
    console.log(
      `${step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–'} ${step.block}  ${report.readme}:${step.line}  ${((step.durationMs ?? 0) / 1000).toFixed(1)}s`,
    );
    if (includeOutput && step.status === 'failed' && step.output) console.log(step.output.trim());
  }
  if (report.http)
    console.log(
      `HTTP ${report.http.status ?? 'unavailable'}: ${report.http.url} (${report.http.ok ? 'passed' : 'failed'})`,
    );
  for (const assertion of report.assertions ?? [])
    console.log(`${assertion.ok ? '✓' : '✗'} ${assertion.name}`);
  if (report.error)
    console.error(
      `${report.failureKind ?? 'failure'}: ${includeOutput ? report.error : report.error.replace(/[\r\n]/g, ' ')}`,
    );
  console.log(`Completed in ${(report.durationMs / 1000).toFixed(1)}s`);
}

export async function main(args: string[]): Promise<number> {
  let json = args.includes('--json');
  let github = process.env.GITHUB_ACTIONS === 'true';
  let checking = false;
  let reportRoot = path.resolve('.');
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        scenario: { type: 'string' },
        json: { type: 'boolean' },
        github: { type: 'boolean' },
        quiet: { type: 'boolean' },
        interactive: { type: 'boolean' },
        'no-interactive': { type: 'boolean' },
        blocks: { type: 'string' },
        start: { type: 'string' },
        url: { type: 'string' },
        runtime: { type: 'string' },
        shell: { type: 'string' },
        image: { type: 'string' },
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
      const metadata = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      console.log(metadata.version);
      return 0;
    }
    const [command] = positionals;
    checking = command === 'check';
    github = values.github || github;
    if (positionals.length !== 1 || !['init', 'plan', 'doctor', 'check'].includes(command ?? ''))
      throw new Error(
        'Choose exactly one command: init, plan, doctor, or check. Use --help for usage.',
      );
    const initFlags = [
      'interactive',
      'no-interactive',
      'blocks',
      'start',
      'url',
      'runtime',
      'shell',
      'image',
    ] as const;
    if (command !== 'init' && initFlags.some((flag) => values[flag] !== undefined))
      throw new Error('Initialization options are only supported by init.');
    if (command !== 'check' && (values.github || values.quiet))
      throw new Error('--github and --quiet are only supported by check.');
    if (command === 'init' && values.scenario !== undefined)
      throw new Error('--scenario is supported by plan, doctor, and check.');
    const root = await realpath(path.resolve(values.root ?? '.'));
    reportRoot = root;
    const configPath = values.config ?? '.freshclone.yml';
    if (command === 'init') {
      if (json) throw new Error('--json is supported by plan, doctor, and check only.');
      if (values.interactive && values['no-interactive'])
        throw new Error('Choose --interactive or --no-interactive.');
      const interactive =
        values.interactive ||
        (!values['no-interactive'] && process.stdin.isTTY && process.stderr.isTTY);
      if (interactive && !process.stdin.isTTY)
        throw new Error(
          '--interactive requires a terminal. Use --blocks, --start, and --url for scripted initialization.',
        );
      const reader = interactive
        ? createInterface({ input: process.stdin, output: process.stderr })
        : undefined;
      try {
        await initProject(
          root,
          configPath,
          values,
          reader
            ? async (question, defaultValue) =>
                (
                  await reader.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `)
                ).trim() || defaultValue
            : undefined,
        );
      } finally {
        reader?.close();
      }
      console.log(
        `Created ${configPath}. Review the selected commands with freshclone plan before checking.`,
      );
      return 0;
    }
    if (command === 'doctor') {
      const report = await doctor(root, configPath, values.scenario);
      if (json) console.log(JSON.stringify(report, null, 2));
      else
        for (const check of report.checks)
          console.log(
            `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}${!check.ok && check.fix ? `\n  Fix: ${check.fix}` : ''}`,
          );
      return report.ok ? 0 : 1;
    }
    const project = await loadProject(root, configPath, values.scenario);
    if (command === 'plan') {
      const plan = {
        schemaVersion: 1,
        image: project.config.image,
        readme: project.readmePath,
        timeout: project.config.timeout,
        runtime: project.config.runtime ?? 'node',
        shell: project.config.shell ?? 'sh',
        scenario: project.config.scenario,
        services: project.config.services,
        env: project.config.env,
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
        console.log(
          `FreshClone plan — ${plan.image} (${plan.runtime} / ${plan.shell})${plan.scenario ? ` — ${plan.scenario}` : ''}`,
        );
        for (const step of plan.steps)
          console.log(
            `\n${step.block}${step.background ? ' (background)' : ''} — ${plan.readme}:${step.line}\n${step.command}`,
          );
        for (const [name, service] of Object.entries(plan.services ?? {}))
          console.log(`\nService ${name}: ${service.image}, TCP ${service.port}`);
        if (plan.expect) console.log(`\nExpectations: ${JSON.stringify(plan.expect)}`);
        console.log('\nNo commands executed.');
      }
      return 0;
    }
    const live = !json && !values.quiet;
    const started = Date.now();
    let current = 'Preparing check';
    const progress = live
      ? (message: string) => {
          current = message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
          process.stderr.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${current}\n`);
        }
      : undefined;
    const ticker = live ? setInterval(() => progress?.(current), 5000) : undefined;
    let report: CheckReport;
    try {
      report = await runCheck(root, project.config, project.blocks, project.readmePath, progress);
    } finally {
      clearInterval(ticker);
    }
    let reportingFailed = false;
    if (github) {
      try {
        await writeGithubReport(repositoryReport(report, root));
      } catch (error) {
        reportingFailed = true;
        console.error(`FreshClone reporting failed: ${(error as Error).message}`);
      }
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, !github);
    return report.ok && !reportingFailed ? 0 : 1;
  } catch (error) {
    const message = (error as Error).message;
    if (checking && github) {
      try {
        await writeGithubReport(
          repositoryReport(
            {
              schemaVersion: 1,
              ok: false,
              image: 'configuration unavailable',
              readme: '',
              steps: [],
              durationMs: 0,
              failureKind: 'configuration',
              error: message,
            },
            reportRoot,
          ),
        );
      } catch (reportError) {
        console.error(`FreshClone reporting failed: ${(reportError as Error).message}`);
      }
    }
    if (json)
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          failureKind: 'configuration',
          error: message,
        }),
      );
    else console.error(`FreshClone: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
