/**
 * What `melete <command> --json` prints, for a program that drives the command.
 * Every command that judges something reports a list of results keyed by a
 * stable rule id, such as `disk.free_mb` or `env.master_key`, so a caller can
 * act on one rule without parsing a sentence.
 */
import { z } from 'zod';

/**
 * `skip` is neutral: a rule that cannot be judged where the command runs, such
 * as a host check run inside the service container. It never fails a report.
 */
export const LEVELS = ['ok', 'warn', 'fail', 'skip'] as const;
export type Level = (typeof LEVELS)[number];

export const resultSchema = z.object({
  /** A stable, dotted rule id: `<area>.<rule>`. */
  id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/),
  level: z.enum(LEVELS),
  /** What was found, in one sentence. Never a secret's value. */
  detail: z.string(),
  /** What to do about it, when there is something to do. */
  fix: z.string().optional(),
});
export type Result = z.infer<typeof resultSchema>;

export const reportSchema = z.object({
  command: z.enum([
    'check',
    'doctor',
    'status',
    'deploy',
    'rollback',
    'backup',
    'restore',
    'remote',
  ]),
  /** No result failed. */
  ok: z.boolean(),
  results: z.array(resultSchema),
});
export type Report = z.infer<typeof reportSchema>;

const side = z.object({ tag: z.string(), revision: z.string().nullable() });

/** `deploy --json` and `rollback --json`: the report, how the run ended, and what it planned. */
export const deployReportSchema = reportSchema.extend({
  outcome: z.enum(['current', 'planned', 'deployed', 'refused', 'failed']),
  from: side.optional(),
  to: side.nullable().optional(),
  pulls: z.array(z.object({ ref: z.string(), service: z.string(), bytes: z.number() })).optional(),
  needed_mb: z.number().optional(),
});
export type DeployReport = z.infer<typeof deployReportSchema>;

/**
 * Exit codes shared by every command:
 * - 0: done, or every check passed;
 * - 1: at least one check failed;
 * - 2: refused to act, and nothing was changed;
 * - 3: acted, but did not finish; what was printed says what to do next.
 */
export const EXIT = { ok: 0, failed: 1, refused: 2, partial: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function report(command: Report['command'], results: Result[]): Report {
  return { command, ok: !results.some((result) => result.level === 'fail'), results };
}

/** A rule only the host can judge, reported from inside the service image without failing it. */
export const hostOnly = (id: string): Result => ({
  id,
  level: 'skip',
  detail: 'Skipped: run on the host to check this.',
});

/** The report as a person reads it: one line per rule, the fix under it, then a verdict. */
export function renderReport(value: Report): string {
  const width = Math.max(0, ...value.results.map((result) => result.id.length));
  const lines = value.results.flatMap((result) => [
    `  ${result.level.padEnd(4)}  ${result.id.padEnd(width)}  ${result.detail}`,
    ...(result.fix ? [`        ${' '.repeat(width)}  -> ${result.fix}`] : []),
  ]);
  const failed = value.results.filter((result) => result.level === 'fail').length;
  const warned = value.results.filter((result) => result.level === 'warn').length;
  const skipped = value.results.filter((result) => result.level === 'skip').length;
  const verdict =
    failed > 0
      ? `${value.command}: ${failed} failed.`
      : warned > 0
        ? `${value.command}: passed, with ${warned} warning(s).`
        : `${value.command}: passed.`;
  lines.push(
    skipped > 0
      ? `${verdict} ${skipped} skipped here; run it on the host to check those.`
      : verdict,
  );
  return `${lines.join('\n')}\n`;
}
