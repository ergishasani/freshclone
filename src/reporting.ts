import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckReport } from './runner.js';

const markdown = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replace(/[\\[\]!*_]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/[\r\n]/g, ' ');
const commandData = (value: string) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const commandProperty = (value: string) =>
  commandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function githubSummary(report: CheckReport): string {
  const lines = [
    `## FreshClone — ${report.ok ? 'PASSED' : 'FAILED'}`,
    '',
    `Image: ${markdown(report.image)}${report.scenario ? ` · Scenario: ${markdown(report.scenario)}` : ''}`,
    '',
    '| Step | Result | Duration | README |',
    '| --- | --- | --- | --- |',
  ];
  for (const step of report.steps)
    lines.push(
      `| ${markdown(step.block)} | ${step.status} | ${((step.durationMs ?? 0) / 1000).toFixed(1)}s | ${markdown(report.readme)}:${step.line} |`,
    );
  if (report.http)
    lines.push(
      '',
      `HTTP: ${markdown(report.http.url)} — ${report.http.status ?? 'unavailable'} (${report.http.ok ? 'passed' : 'failed'})`,
    );
  for (const assertion of report.assertions ?? [])
    lines.push('', `${assertion.ok ? '✓' : '✗'} ${markdown(assertion.name)}`);
  if (report.error)
    lines.push('', `**${report.failureKind ?? 'failure'}:** ${markdown(report.error)}`);
  for (const step of report.steps.filter((step) => step.status === 'failed' && step.output)) {
    lines.push(
      '',
      `<details><summary>${markdown(step.block)} — last 8 KiB of output</summary>`,
      '',
      '<pre>' +
        step.output
          .slice(-8192)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;') +
        '</pre>',
      '',
      '</details>',
    );
  }
  lines.push('', `Completed in ${(report.durationMs / 1000).toFixed(1)}s`, '');
  return lines.join('\n');
}

export function githubAnnotations(report: CheckReport): string[] {
  if (report.ok) return [];
  const failed = report.steps.filter((step) => step.status === 'failed');
  if (!failed.length || !report.readme)
    return [`::error title=FreshClone::${commandData(report.error ?? 'Onboarding check failed.')}`];
  return failed.map(
    (step) =>
      `::error file=${commandProperty(report.readme)},line=${Math.max(1, step.line)},title=FreshClone ${commandProperty(step.block)}::${commandData(report.error ?? `Step ${step.block} failed.`)}`,
  );
}

/** Annotations use checkout-relative paths, even when --root selects a subproject. */
export function repositoryReport(
  report: CheckReport,
  root: string,
  workspace = process.env.GITHUB_WORKSPACE,
): CheckReport {
  if (!workspace) return report;
  const relative = path.relative(path.resolve(workspace), path.resolve(root, report.readme));
  const inside =
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return { ...report, readme: inside ? relative.split(path.sep).join('/') : '' };
}

export async function writeGithubReport(
  report: CheckReport,
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
): Promise<void> {
  if (summaryFile) await appendFile(summaryFile, githubSummary(report));
  for (const annotation of githubAnnotations(report)) process.stderr.write(annotation + '\n');
}
