/**
 * Reading a run's record: the brief a shift starts from, its helpers and its
 * best experiment. Read-only, so the attempt bundle can use it without the
 * service that writes it.
 */
import type { RunStatus } from '@melete/contracts';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { job, runEntry, runState } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';

export const BRIEF_RECENT = 5;

export type Entry = typeof runEntry.$inferSelect;
export type State = typeof runState.$inferSelect;

export const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Every number written in a piece of text. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)].map((match) => Number(match[0]));
}

/**
 * Whether a measured value is shown in some output: the same number, or the
 * same number rounded to two or more decimals (0.8731 reported as 0.873).
 */
export function valueShown(value: number, output: string): boolean {
  const decimals = (String(value).split('.')[1] ?? '').length;
  return numbersIn(output).some(
    (seen) =>
      Math.abs(seen - value) <= 1e-9 * Math.max(1, Math.abs(value)) ||
      (decimals >= 2 && Number(seen.toFixed(decimals)) === value),
  );
}

export function runStatusOf(state: string, paused: boolean): RunStatus {
  if (state === 'completed') return 'done';
  if (state === 'cancelled') return 'stopped';
  if (state === 'failed') return 'failed';
  if (['waiting_for_input', 'waiting_for_approval', 'needs_reconciliation'].includes(state))
    return 'needs_you';
  if (paused) return 'waiting';
  if (state === 'running' || state === 'queued') return 'working';
  return 'waiting';
}

/** The run's state, written for the attempt that continues it. Bounded. */
export async function runBrief(tx: Transaction, row: JobRow): Promise<string> {
  const [state] = await tx.select().from(runState).where(eq(runState.jobId, row.id));
  if (!state) return '';
  const run = state.parentRunId ?? state.jobId;
  const step = state.parentRunId ? row.id : null;
  const [root] = state.parentRunId
    ? await tx.select().from(runState).where(eq(runState.jobId, run))
    : [state];
  const latest = async (kind: string, own = true) =>
    (
      await tx
        .select()
        .from(runEntry)
        .where(
          and(
            eq(runEntry.runJobId, run),
            eq(runEntry.kind, kind),
            own ? (step ? eq(runEntry.stepJobId, step) : isNull(runEntry.stepJobId)) : undefined,
          ),
        )
        .orderBy(desc(runEntry.seq))
        .limit(1)
    )[0];
  const lines: string[] = [];
  const age = Math.max(0, Date.now() - state.createdAt.getTime());
  const days = Math.floor(age / 86_400_000);
  const hours = Math.floor(age / 3_600_000);
  lines.push(
    `${step ? 'You are a helper on' : 'This is'} long work done in shifts. This is shift ${state.shifts + 1}; it started ${days ? `${days} day${days === 1 ? '' : 's'}` : hours ? `${hours} hour${hours === 1 ? '' : 's'}` : 'less than an hour'} ago.`,
  );
  if (step && root) lines.push(`The whole work: ${clip(root.goal, 600)}`);
  if (!step && state.doneWhen) lines.push(`Done when: ${clip(state.doneWhen, 600)}`);
  const plan = await latest('plan', false);
  if (plan) lines.push(`Plan:\n${clip(plan.body || plan.title, 1500)}`);
  const handoff = await latest('checkpoint');
  if (handoff)
    lines.push(
      `Where the last shift left off: ${clip(handoff.body, 1500)}\nNext: ${clip(String(object(handoff.data).next ?? ''), 600)}`,
    );
  const metric = root?.metric ?? null;
  const experiments = await tx
    .select()
    .from(runEntry)
    .where(and(eq(runEntry.runJobId, run), eq(runEntry.kind, 'experiment')))
    .orderBy(desc(runEntry.seq));
  if (experiments.length) {
    const best = bestExperiment(experiments, metric?.direction ?? 'higher');
    const show = (entry: Entry) => {
      const data = object(entry.data);
      const value = typeof data.value === 'number' ? ` = ${data.value}` : '';
      return `${clip(entry.title, 120)}${value} (${String(data.outcome ?? 'kept')}${data.checked ? ', checked' : ''})`;
    };
    lines.push(
      [
        `Experiments so far: ${experiments.length}${metric ? `, measured by ${metric.name} (${metric.direction} is better)` : ''}.`,
        best ? `Best: ${show(best)}` : null,
        'Latest:',
        ...experiments.slice(0, BRIEF_RECENT).map((entry) => `- ${show(entry)}`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const findings = await tx
    .select({ title: runEntry.title })
    .from(runEntry)
    .where(and(eq(runEntry.runJobId, run), inArray(runEntry.kind, ['finding', 'decision'])))
    .orderBy(desc(runEntry.seq))
    .limit(BRIEF_RECENT);
  if (findings.length)
    lines.push(
      ['Recent findings:', ...findings.map((entry) => `- ${clip(entry.title, 160)}`)].join('\n'),
    );
  if (!step) {
    const steps = await stepsOf(tx, row.id);
    if (steps.length)
      lines.push(
        [
          'Helpers:',
          ...steps.map(
            (entry) =>
              `- ${clip(entry.title, 120)}: ${entry.status}${entry.result ? ` — ${clip(entry.result, 300)}` : ''}`,
          ),
        ].join('\n'),
      );
  }
  lines.push(
    step
      ? 'Record what you learn with run.log. Call run.finish with the result when your part is done, or run.checkpoint to continue in another shift.'
      : 'Record what you learn with run.log (measured results as experiments, citing the action that shows the value). End each shift with run.checkpoint. Use run.delegate for parts that can go in parallel. Call run.finish once it is done.',
  );
  return lines.join('\n\n');
}

export async function stepsOf(tx: Transaction, run: string) {
  const rows = await tx
    .select({ id: job.id, title: job.title, state: job.state, paused: job.paused })
    .from(runState)
    .innerJoin(job, eq(job.id, runState.jobId))
    .where(eq(runState.parentRunId, run))
    .orderBy(asc(runState.createdAt));
  if (!rows.length) return [];
  const results = await tx
    .select({
      step: runEntry.stepJobId,
      kind: runEntry.kind,
      body: runEntry.body,
      seq: runEntry.seq,
    })
    .from(runEntry)
    .where(
      and(
        eq(runEntry.runJobId, run),
        inArray(runEntry.kind, ['finished', 'step_finished']),
        inArray(
          runEntry.stepJobId,
          rows.map((entry) => entry.id),
        ),
      ),
    )
    .orderBy(desc(runEntry.seq));
  // Its own result, or, for a helper that ended without one, why it ended.
  const resultOf = (id: string) =>
    (
      results.find((result) => result.step === id && result.kind === 'finished') ??
      results.find((result) => result.step === id && result.body)
    )?.body ?? null;
  return rows.map((entry) => ({
    id: entry.id,
    title: entry.title,
    status: runStatusOf(entry.state, entry.paused),
    result: resultOf(entry.id),
  }));
}

/** The best kept experiment with a value: checked results first, then by the metric. */
export function bestExperiment(entries: readonly Entry[], direction: 'higher' | 'lower') {
  const candidates = entries.filter((entry) => {
    const data = object(entry.data);
    return typeof data.value === 'number' && data.outcome !== 'failed';
  });
  const value = (entry: Entry) => Number(object(entry.data).value);
  const checked = (entry: Entry) => (object(entry.data).checked === true ? 1 : 0);
  return (
    [...candidates].sort(
      (a, b) =>
        checked(b) - checked(a) ||
        (direction === 'higher' ? value(b) - value(a) : value(a) - value(b)),
    )[0] ?? null
  );
}
