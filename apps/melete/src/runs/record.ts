/**
 * Reading a run's record: the brief a shift starts from, its helpers and its
 * best experiment. Read-only, so the attempt bundle can use it without the
 * service that writes it.
 */
import { RUN_TRY_LIMITS, type RunStatus } from '@melete/contracts';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { action, job, runEntry, runState } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { standingBrief } from './standing.ts';

export const BRIEF_RECENT = 5;
/** Approaches that did not work, listed so later shifts do not repeat them. */
const BRIEF_DEAD_ENDS = 8;
/** Tries and findings a check is shown, newest first. */
const CHECK_SHOWN = 20;

export type Entry = typeof runEntry.$inferSelect;
export type State = typeof runState.$inferSelect;

export const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Every number written in a piece of text, each read whole: digits inside a
 * longer number, an identifier (`act_9`, `9f3a`), a date (`2026-09`) or a
 * version (`1.9.3`) are not numbers of their own. A unit may follow (`12ms`).
 */
function numbersIn(text: string): number[] {
  return [
    ...text.matchAll(/(?:(?<![\w.])-|(?<![\w.-]))\d+(?:\.\d+)?(?:e[-+]?\d+)?(?!\.\d|_|[a-z]*\d)/gi),
  ].map((match) => Number(match[0]));
}

/** The text of every value in a stored output, unescaped, one per line. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  return (Array.isArray(value) ? value : Object.values(value)).map(textOf).join('\n');
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
  if (step && state.checking) return checkBrief(tx, state, run, step);
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
  // Gaps a check found in the last result come first, until a new result is offered.
  if (!step) {
    const [last] = await tx
      .select()
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run),
          inArray(runEntry.kind, ['proposed', 'check', 'finished']),
          or(eq(runEntry.kind, 'check'), isNull(runEntry.stepJobId)),
        ),
      )
      .orderBy(desc(runEntry.seq))
      .limit(1);
    const data = object(last?.data);
    if (last?.kind === 'check' && data.verdict === 'gaps' && data.settle !== true) {
      // The work never disowns what its own record shows: a gap that calls
      // recorded reads unread is answered from the record, not believed.
      const read = await sourcesRead(tx, run);
      lines.push(
        [
          'A separate check of the result you gave found it is not done yet:',
          ...gapsOf(data).map((gap) => `- ${clip(gap, 500)}`),
          read.succeeded
            ? `Your own record shows what you read: ${readsText(read, 15)}\nThose reads happened. Where a gap says a source was not read and the record shows it was, the gap is wrong: keep the findings the record supports and do not take them back.`
            : null,
          'Close the gaps that stand, then call run.finish again with the result. If one cannot be closed, say so plainly in the result, with what the record does support.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    // A shift runs on a checked result only when the person wrote since a shift last read them.
    if (last?.kind === 'check' && data.settle === true && typeof data.result === 'string')
      lines.push(
        [
          'Your result has been through its check and is ready to be given to the person:',
          clip(data.result, 1500),
          'The person wrote since then; their words are in this conversation. If they change nothing, end this shift with one short line and this result is given. If they ask for a change, make it in this shift and call run.finish with the new result; it is checked again.',
        ].join('\n'),
      );
    const [checking] = await tx
      .select({ id: runState.jobId })
      .from(runState)
      .innerJoin(job, eq(job.id, runState.jobId))
      .where(
        and(
          eq(runState.parentRunId, run),
          isNotNull(runState.checking),
          notInArray(job.state, ['completed', 'failed', 'cancelled']),
        ),
      )
      .limit(1);
    if (checking)
      lines.push(
        'The result you gave is being checked right now by a separate check. Do not call run.finish again. When there is nothing else to do, end this shift with run.checkpoint and next_shift "when_helpers_finish"; what the check finds comes back to you.',
      );
  }
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
  const best = bestExperiment(experiments, metric?.direction ?? 'higher');
  // The best try that was kept; one discarded for only matching it is no dead end.
  const kept = bestExperiment(
    experiments.filter((entry) => object(entry.data).outcome === 'kept'),
    metric?.direction ?? 'higher',
  );
  const keptValue = kept ? Number(object(kept.data).value) : null;
  if (experiments.length) {
    const show = (entry: Entry) => {
      const data = object(entry.data);
      const value = typeof data.value === 'number' ? ` = ${data.value}` : '';
      const how = data.measured === true ? ', measured' : data.checked ? ', checked' : '';
      const command =
        typeof data.command === 'string'
          ? `
  command: ${clip(data.command, 300)}`
          : '';
      const error =
        typeof data.error === 'string'
          ? `
  ${clip(data.error, 200)}`
          : '';
      return `${clip(entry.title, 120)}${value} (${String(data.outcome ?? 'kept')}${how})${command}${error}`;
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
  const dead = await tx
    .select()
    .from(runEntry)
    .where(
      and(
        eq(runEntry.runJobId, run),
        or(
          and(eq(runEntry.kind, 'experiment'), sql`${runEntry.data}->>'outcome' = 'failed'`),
          // A try that only ties the best kept one (it measured again, say) is not a dead end.
          and(
            eq(runEntry.kind, 'experiment'),
            sql`${runEntry.data}->>'outcome' = 'discarded'`,
            sql`(case when jsonb_typeof(${runEntry.data}->'value') = 'number' then (${runEntry.data}->>'value')::float8 end) is distinct from ${keptValue}::float8`,
          ),
          sql`${runEntry.data}->>'dead_end' = 'true'`,
        ),
      ),
    )
    .orderBy(desc(runEntry.seq))
    .limit(BRIEF_DEAD_ENDS);
  if (dead.length)
    lines.push(
      [
        "Already tried, didn't work (do not repeat these):",
        ...dead.map((entry) => {
          const data = object(entry.data);
          const value = typeof data.value === 'number' ? ` = ${data.value}` : '';
          const why = entry.body || (typeof data.hypothesis === 'string' ? data.hypothesis : '');
          return `- ${clip(entry.title, 120)}${value}${why ? `: ${clip(why, 200)}` : ''}`;
        }),
      ].join('\n'),
    );
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
  lines.push(...(await standingBrief(tx, row)));
  lines.push(
    step
      ? 'Record what you learn with run.log. Call run.finish with the result when your part is done, or run.checkpoint to continue in another shift.'
      : 'Record what you learn with run.log. End each shift with run.checkpoint. Use run.delegate for parts that can go in parallel. Call run.finish once it is done.',
  );
  // The tool's own schema stays small in the shared catalog; how to use it is here.
  lines.push(
    `To test an idea, use run.try: it runs the command in the sandbox and records the value the command prints, so the result is measured rather than reported. Print a line \`METRIC ${metric?.name ?? '<name>'}=<number>\`, or give value_pattern, a regular expression with one capture group. files maps relative paths to text written before the command runs; variants, up to 4 of {label, command}, run alongside and are recorded as tries of their own; timeout_seconds is at most ${RUN_TRY_LIMITS.max_timeout_seconds}. Where there is no sandbox, log tries with run.log kind "experiment", citing the action whose output shows the value.`,
  );
  return lines.join('\n\n');
}

export async function stepsOf(tx: Transaction, run: string) {
  return (await stepsOfRuns(tx, [run])).get(run) ?? [];
}

type Step = { id: string; title: string; status: RunStatus; result: string | null };

/** The helpers of several runs at once, each with its result. */
export async function stepsOfRuns(tx: Transaction, runs: string[]) {
  const steps = new Map<string, Step[]>();
  if (!runs.length) return steps;
  const rows = await tx
    .select({
      id: job.id,
      run: runState.parentRunId,
      title: job.title,
      state: job.state,
      paused: job.paused,
    })
    .from(runState)
    .innerJoin(job, eq(job.id, runState.jobId))
    .where(inArray(runState.parentRunId, runs))
    .orderBy(asc(runState.createdAt));
  if (!rows.length) return steps;
  // Its own result, or, for a helper that ended without one, why it ended:
  // the newest of each kind per helper.
  const results = await tx
    .selectDistinctOn([runEntry.stepJobId, runEntry.kind], {
      step: runEntry.stepJobId,
      kind: runEntry.kind,
      body: runEntry.body,
    })
    .from(runEntry)
    .where(
      and(
        inArray(runEntry.runJobId, runs),
        inArray(runEntry.kind, ['finished', 'step_finished']),
        inArray(
          runEntry.stepJobId,
          rows.map((entry) => entry.id),
        ),
        or(eq(runEntry.kind, 'finished'), sql`${runEntry.body} <> ''`),
      ),
    )
    .orderBy(runEntry.stepJobId, runEntry.kind, desc(runEntry.seq));
  const resultOf = (id: string) =>
    (
      results.find((result) => result.step === id && result.kind === 'finished') ??
      results.find((result) => result.step === id)
    )?.body ?? null;
  for (const entry of rows) {
    const list = steps.get(entry.run ?? '') ?? [];
    list.push({
      id: entry.id,
      title: entry.title,
      status: runStatusOf(entry.state, entry.paused),
      result: resultOf(entry.id),
    });
    steps.set(entry.run ?? '', list);
  }
  return steps;
}

/** The gaps a check named, as text. */
export function gapsOf(data: Record<string, unknown>): string[] {
  return Array.isArray(data.gaps) ? data.gaps.map(String) : [];
}

/** Actions that read a page: what a source being read rests on. */
const READ_KINDS = [
  'web.fetch',
  'browser.open',
  'browser.read',
  'browser.observe',
  'computer.open',
];
/** Pages a brief lists one by one; the rest are counted. */
const READS_SHOWN = 40;

export type SourcesRead = {
  /** Distinct pages read, oldest first: each read that went through, once per address. */
  pages: { url: string; title: string; excerpt: string }[];
  /** Reads that went through, every one counted. */
  succeeded: number;
  /** Reads that did not go through. */
  failed: number;
  /** Web searches that went through. */
  searches: number;
};

const oneLine = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * What the work's own record shows it read: the reads Melete carried out and
 * recorded for the run and its helpers, with their receipts. Never what a
 * result says about itself. `except` leaves out a job's own reads (a check's).
 */
export async function sourcesRead(
  tx: Transaction,
  run: string,
  except?: string,
): Promise<SourcesRead> {
  const helpers = tx
    .select({ id: runState.jobId })
    .from(runState)
    .where(eq(runState.parentRunId, run));
  const rows = await tx
    .select({
      kind: action.kind,
      status: action.status,
      payload: action.canonicalPayload,
      receipt: action.receipt,
    })
    .from(action)
    .where(
      and(
        inArray(action.kind, [...READ_KINDS, 'web.search']),
        sql`(${action.jobId} = ${run} or ${action.jobId} in ${helpers})`,
        except ? sql`${action.jobId} <> ${except}` : undefined,
      ),
    )
    .orderBy(asc(action.createdAt));
  const found: SourcesRead = { pages: [], succeeded: 0, failed: 0, searches: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    const ok = row.status === 'succeeded';
    if (row.kind === 'web.search') {
      if (ok) found.searches++;
      continue;
    }
    if (!ok) {
      if (row.status === 'failed') found.failed++;
      continue;
    }
    found.succeeded++;
    const detail = object(object(row.receipt).detail);
    const url =
      oneLine(detail.final_url) || oneLine(detail.url) || oneLine(object(row.payload).url);
    const key = url || `${row.kind}:${found.succeeded}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.pages.push({
      url: url || 'a page in its browser',
      title: clip(oneLine(detail.title), 120),
      excerpt: clip(oneLine(detail.body) || oneLine(detail.text), 160),
    });
  }
  return found;
}

/** The reads in words, for a brief: counts, then each page read. */
export function readsText(read: SourcesRead, limit = READS_SHOWN): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const head = `${count(read.succeeded, 'page read that went through', 'page reads that went through')} (${count(read.pages.length, 'distinct page', 'distinct pages')})${read.failed ? `, ${count(read.failed, 'read', 'reads')} that did not` : ''}, and ${count(read.searches, 'web search', 'web searches')}.`;
  const shown = read.pages.slice(-limit);
  const lines = shown.map(
    (page) =>
      `- ${page.url}${page.title ? ` — ${page.title}` : ''}${page.excerpt ? `: ${page.excerpt}` : ''}`,
  );
  const more =
    read.pages.length > shown.length
      ? [`(${read.pages.length - shown.length} earlier pages read are not listed.)`]
      : [];
  return [head, ...more, ...lines].join('\n');
}

/**
 * What a helper checking a result is given: the goal, what done means, the
 * result offered and the evidence in the record. Not the work's own
 * reasoning: the check confirms the result, it does not redo the work.
 */
async function checkBrief(tx: Transaction, state: State, run: string, step: string) {
  const [root] = await tx.select().from(runState).where(eq(runState.jobId, run));
  const [proposal] = state.checking
    ? await tx.select().from(runEntry).where(eq(runEntry.id, state.checking))
    : [];
  const tries = await tx
    .select()
    .from(runEntry)
    .where(and(eq(runEntry.runJobId, run), eq(runEntry.kind, 'experiment')))
    .orderBy(desc(runEntry.seq))
    .limit(CHECK_SHOWN);
  const findings = await tx
    .select()
    .from(runEntry)
    .where(and(eq(runEntry.runJobId, run), eq(runEntry.kind, 'finding')))
    .orderBy(desc(runEntry.seq))
    .limit(CHECK_SHOWN);
  const evidence = object(proposal?.data).evidence;
  const cited = Array.isArray(evidence) ? evidence.map(String) : [];
  const helpers = tx
    .select({ id: runState.jobId })
    .from(runState)
    .where(eq(runState.parentRunId, run));
  const actions = cited.length
    ? await tx
        .select({
          id: action.id,
          kind: action.kind,
          status: action.status,
          receipt: action.receipt,
        })
        .from(action)
        .where(
          and(
            inArray(action.id, cited),
            sql`(${action.jobId} = ${run} or ${action.jobId} in ${helpers})`,
          ),
        )
    : [];
  const [handoff] = await tx
    .select()
    .from(runEntry)
    .where(
      and(
        eq(runEntry.runJobId, run),
        eq(runEntry.stepJobId, step),
        eq(runEntry.kind, 'checkpoint'),
      ),
    )
    .orderBy(desc(runEntry.seq))
    .limit(1);
  const lines = [
    'You are checking whether a piece of work is really done before it is given to the person. Do not redo the work: confirm the result against the evidence below, and read or fetch what you need to confirm it.',
    `The goal: ${clip(root?.goal ?? '', 1500)}`,
    `Done when: ${clip(root?.doneWhen ?? '', 1000)}`,
    `The result offered:\n${clip(proposal?.body ?? '', 6000)}`,
  ];
  if (handoff) lines.push(`Where your last shift left off: ${clip(handoff.body, 1500)}`);
  lines.push(
    tries.length
      ? [
          'Tries in the record, newest first ("measured" means the value was found in the output of the action it cites):',
          ...tries.map((entry) => {
            const data = object(entry.data);
            const value = typeof data.value === 'number' ? ` = ${data.value}` : '';
            return `- ${clip(entry.title, 160)}${value} (${String(data.outcome ?? 'kept')}, ${data.checked === true ? 'measured' : 'not measured'})`;
          }),
        ].join('\n')
      : 'There are no tries in the record.',
  );
  if (findings.length)
    lines.push(
      [
        'Findings in the record:',
        ...findings.map(
          (entry) => `- ${clip(entry.title, 160)}${entry.body ? `: ${clip(entry.body, 400)}` : ''}`,
        ),
      ].join('\n'),
    );
  // What was read is judged from what Melete recorded doing, not from the
  // result's own words or the few actions it happened to cite.
  lines.push(
    [
      'What the work’s own record shows it read (reads Melete carried out and recorded for this work and its helpers, with what each page said):',
      readsText(await sourcesRead(tx, run, step)),
      'Judge whether a source was read from this record, not from what the result’s text cites or the evidence it names. A page listed here was read: do not call it unread, unfetched or unsupported. Name a gap about sources only for a claim that no page read here supports, and say which claim.',
    ].join('\n'),
  );
  lines.push(
    actions.length
      ? [
          'Actions the result names as its evidence, with their output:',
          ...actions.map(
            (entry) =>
              `- ${entry.id} (${entry.kind}, ${entry.status}): ${clip(textOf(entry.receipt), 1500)}`,
          ),
        ].join('\n')
      : 'The result cites no actions as evidence.',
  );
  lines.push(
    'End with run.finish: verdict "passes" when the result meets what done means and the evidence holds it up, or verdict "gaps" with each specific gap (what is missing, wrong or not supported). Do not close the gaps yourself.',
  );
  return lines.join('\n\n');
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
