import type { FeedbackReport } from '@melete/contracts';

const STATUS_LABEL: Record<FeedbackReport['status'], string> = {
  open: 'Open',
  fixing: 'Fixing',
  fixed: 'Fixed',
  wontfix: 'Won’t fix',
};

/** Keep a stored line from closing a code span or starting markup of its own. */
const inline = (value: string) => value.replace(/`/g, 'ʼ').replace(/\r?\n/g, ' ');

/** One line per report, for a list a person or a coding agent can scan. */
export function reportLine(report: FeedbackReport): string {
  const who = report.reporter.email ?? 'a removed account';
  return `${report.id}  ${STATUS_LABEL[report.status].padEnd(9)}  ${report.created_at}  ${
    report.route ?? '-'
  }  ${inline(report.summary)}  (${who})`;
}

/** The whole report as Markdown: what the person said, then what the page knew. */
export function reportMarkdown(report: FeedbackReport): string {
  const { context } = report;
  const lines: string[] = [
    `# ${report.id}: ${inline(report.summary) || 'No summary'}`,
    '',
    `- Status: ${STATUS_LABEL[report.status]}`,
    `- Reported: ${report.created_at} by ${report.reporter.email ?? 'a removed account'}`,
    `- Route: ${report.route ? `\`${inline(report.route)}\`` : 'not included'}`,
    `- Service version: ${report.app_version}`,
  ];
  if (context.user_agent) lines.push(`- Browser: ${inline(context.user_agent)}`);
  if (context.viewport)
    lines.push(
      `- Viewport: ${context.viewport.width}×${context.viewport.height}${
        context.viewport.pixel_ratio ? ` @${context.viewport.pixel_ratio}x` : ''
      }${context.color_scheme ? `, ${context.color_scheme}` : ''}`,
    );
  if (context.language || context.time_zone)
    lines.push(`- Locale: ${[context.language, context.time_zone].filter(Boolean).join(', ')}`);
  if (report.updated_at !== report.created_at) lines.push(`- Updated: ${report.updated_at}`);
  lines.push('', '## What went wrong', '', report.message.trim());
  if (report.note) lines.push('', '## Note', '', report.note.trim());
  const errors = context.console_errors ?? [];
  lines.push('', `## Console errors (${errors.length})`, '');
  if (errors.length === 0) lines.push('None recorded.');
  for (const entry of errors) lines.push(`- ${entry.at}: \`${inline(entry.message)}\``);
  const failed = context.failed_requests ?? [];
  lines.push('', `## Failed requests (${failed.length})`, '');
  if (failed.length === 0) lines.push('None recorded.');
  for (const entry of failed)
    lines.push(
      `- ${entry.at}: \`${entry.method} ${inline(entry.url)}\` → ${
        entry.status === null ? 'no answer' : entry.status
      }${entry.code ? ` (${inline(entry.code)})` : ''}`,
    );
  return `${lines.join('\n')}\n`;
}
