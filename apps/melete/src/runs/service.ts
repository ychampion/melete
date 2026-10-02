/**
 * The loop that keeps long work going. A run is a job that works in shifts:
 * each shift is one ordinary bounded attempt, and between shifts this service
 * decides, from durable rows and without a model call, what happens next:
 *
 *  - the work said it is done (`run.finish`): the job completes;
 *  - it handed off (`run.checkpoint`) or simply stopped: the next shift starts
 *    now, at the time it asked for, or when its helpers are done;
 *  - it made no progress for several shifts, kept failing, or reached a limit
 *    the person set: it stops and asks, rather than spinning or dying.
 *
 * Whatever a run learns goes into its record (`run_entry`), which the next
 * shift starts from, so a run that goes on for weeks does not depend on a
 * transcript that keeps growing.
 */
import {
  type AttemptOutcome,
  type CapabilityClaims,
  isRunKind,
  isTerminal,
  type JobBudget,
  type JobState,
  RUN_ACTIVE_STEP_LIMIT,
  RUN_IDLE_SHIFT_LIMIT,
  RUN_TRY_LIMITS,
  type RunEntry,
  type RunLimit,
  type RunStatus,
  type RunView,
  runCheckpointInput,
  runCreateRequest,
  runDelegateInput,
  runFinishInput,
  runLimit,
  runLogInput,
  runStartInput,
  runTryInput,
  runView,
  waitSpec,
} from '@melete/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { databaseNow } from '../db/clock.ts';
import {
  action,
  agent,
  attempt,
  budgetLedger,
  experienceTurn,
  job,
  pushIntent,
  question,
  runEntry,
  runState,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { requireCurrentAttempt } from '../jobs/fence.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import { DEFAULT_BUDGET, type JobRow, type JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { ownJob, principalContext, requestPrincipal } from '../principals/authority.ts';
import {
  bestExperiment,
  clip,
  type Entry,
  object,
  runStatusOf,
  type State,
  stepsOf,
  valueShown,
} from './record.ts';
import {
  checkpointNext,
  ON_TRIGGER,
  restingOnTrigger,
  restOn,
  setStandingEnabled,
  stand,
  standingTrigger,
  standingView,
  unstand,
} from './standing.ts';
import {
  better,
  MAX_COMMAND_CHARS,
  metricValue,
  patternValue,
  type SandboxRun,
  type TrySandbox,
  tail,
  timeoutMs,
  tryCommand,
} from './try.ts';

/**
 * What one shift may use. These only stop a runaway shift: a run goes on in
 * the next one. `max_attempts` counts failed shifts in a row, not shifts.
 */
export const RUN_SHIFT_BUDGET: JobBudget = {
  ...DEFAULT_BUDGET,
  max_turns: 200,
  max_output_tokens: 400_000,
  max_wall_ms: 45 * 60_000,
  max_actions: 200,
  max_attempts: 3,
};

/** How long a run waiting on its helpers sleeps before it looks again by itself. */
const HELPER_FALLBACK_MS = 30 * 60_000;
/** A run that has not reported for this long gets a short summary written for it. */
const REPORT_EVERY_MS = 24 * 60 * 60_000;
/** Runs one space may have going at once. */
const ACTIVE_RUN_LIMIT = 10;

const missing = () => new ServiceError('not_found', 'That piece of work was not found.', 404);

export class RunService {
  /** Registers the schedules standing work rests on; set where triggers run. */
  triggers?: TriggerService;

  constructor(readonly jobs: JobService) {}

  /** Brings schedule registrations in line with the trigger rows, after they changed. */
  async syncSchedules() {
    await this.triggers?.syncSchedules();
  }

  get db() {
    return this.jobs.db;
  }

  // -------------------------------------------------------------------------
  // Tools an attempt calls.

  async call(claims: CapabilityClaims, name: string, input: unknown): Promise<unknown> {
    if (!claims.scopes.includes(name))
      throw new ServiceError('scope_denied', `${name} is not available here.`, 403);
    const result = await this.jobs.transaction(async (tx) => {
      const { job: row } = await requireCurrentAttempt(tx, claims);
      switch (name) {
        case 'run.start':
          return this.start(tx, row, input);
        case 'run.log':
          return this.log(tx, row, claims.attempt_id, input);
        case 'run.delegate':
          return this.delegate(tx, row, claims.attempt_id, input);
        case 'run.checkpoint':
          return this.checkpoint(tx, row, claims.attempt_id, input);
        case 'run.finish':
          return this.finish(tx, row, claims.attempt_id, input);
        default:
          throw new ServiceError('unknown_tool', `${name} is not a run tool.`, 404);
      }
    });
    if (name === 'run.start' || name === 'run.checkpoint') await this.syncSchedules();
    return result;
  }

  private async stateOf(tx: Transaction, jobId: string): Promise<State> {
    const [row] = await tx.select().from(runState).where(eq(runState.jobId, jobId));
    if (!row) throw missing();
    return row;
  }

  /** The run a job's entries are filed under: itself, or the run a helper works for. */
  private rootOf(state: State): string {
    return state.parentRunId ?? state.jobId;
  }

  private async write(
    tx: Transaction,
    values: {
      run: string;
      step?: string | null;
      attemptId?: string | null;
      kind: Entry['kind'];
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<Entry> {
    const [entry] = await tx
      .insert(runEntry)
      .values({
        id: newId('rune'),
        runJobId: values.run,
        stepJobId: values.step ?? null,
        attemptId: values.attemptId ?? null,
        kind: values.kind,
        title: clip(values.title.trim() || values.kind, 200),
        body: values.body ?? '',
        data: values.data ?? {},
      })
      .returning();
    if (!entry) throw new Error('run entry insert returned no row');
    return entry;
  }

  /** Start long work from a conversation, or from the person directly. */
  async create(
    tx: Transaction,
    spaceId: string,
    raw: unknown,
    origin: { conversation?: JobRow; agentId?: string | null; principalId?: string | null },
  ) {
    const input = runCreateRequest.parse(raw);
    const [active] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(job)
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'run'),
          notInArray(job.state, ['completed', 'failed', 'cancelled']),
        ),
      );
    if (Number(active?.n ?? 0) >= ACTIVE_RUN_LIMIT)
      throw new ServiceError(
        'too_many_runs',
        `There are already ${ACTIVE_RUN_LIMIT} pieces of long work going. Finish or stop one first.`,
        409,
      );
    const title = input.title ?? clip(input.goal.split('\n')[0] ?? input.goal, 120);
    const create = () =>
      this.jobs.createInTransaction(
        tx,
        {
          space_id: spaceId,
          title,
          objective: input.goal,
          scheduling_class: 'background',
          importance: 'routine',
          budget: RUN_SHIFT_BUDGET,
        },
        { kind: 'run', agentId: origin.agentId ?? undefined },
      );
    const principal = origin.principalId ?? null;
    const row = principal ? await principalContext.run(principal, create) : await create();
    await tx.insert(runState).values({
      jobId: row.id,
      spaceId,
      conversationId: origin.conversation?.id ?? null,
      goal: input.goal,
      doneWhen: input.done_when ?? null,
      metric: input.metric ?? null,
      limit: input.limit ?? null,
    });
    // Work that repeats stands on its schedule from the start; the caller
    // registers the schedule once this commits.
    if (input.repeat) await stand(tx, this.jobs, row, { kind: 'schedule', ...input.repeat });
    return row;
  }

  private async start(tx: Transaction, row: JobRow, raw: unknown) {
    if (row.kind !== 'chat')
      throw new ServiceError('scope_denied', 'Start long work from a conversation.', 403);
    const input = runStartInput.parse(raw);
    const [turn] = row.currentTurnId
      ? await tx.select().from(experienceTurn).where(eq(experienceTurn.id, row.currentTurnId))
      : [];
    const created = await this.create(tx, row.spaceId, input, {
      conversation: row,
      agentId: turn?.agentId ?? row.agentId,
      principalId: row.principalId,
    });
    return {
      status: 'started',
      run_id: created.id,
      instruction:
        'It is working in the background now and reports back as it goes. Tell the person in one short sentence; do not do the work in this reply.',
    };
  }

  private async log(tx: Transaction, row: JobRow, attemptId: string, raw: unknown) {
    const state = await this.stateOf(tx, row.id);
    const input = runLogInput.parse(raw);
    const run = this.rootOf(state);
    const data: Record<string, unknown> = {};
    if (input.kind === 'experiment') {
      if (input.hypothesis) data.hypothesis = input.hypothesis;
      if (input.value !== undefined) data.value = input.value;
      data.outcome = input.outcome ?? (input.value === undefined ? 'failed' : 'kept');
      const evidence = input.evidence ?? [];
      data.evidence = evidence;
      data.checked =
        input.value !== undefined && evidence.length > 0
          ? await this.shown(tx, run, input.value, evidence)
          : false;
    }
    const entry = await this.write(tx, {
      run,
      step: state.parentRunId ? row.id : null,
      attemptId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      data,
    });
    if (input.kind === 'report') await this.reported(tx, run, row, input.title, input.body ?? '');
    return {
      status: 'recorded',
      entry_id: entry.id,
      ...(input.kind === 'experiment'
        ? {
            checked: data.checked,
            ...(data.checked === false && input.value !== undefined
              ? {
                  note: 'The value was not found in the output of the actions given as evidence. Cite the action whose output shows it.',
                }
              : {}),
          }
        : {}),
    };
  }

  /**
   * A try the harness measures (`run.try`). The commands run in the space's
   * sandbox through the broker, outside any transaction here; the record is
   * then written from what they printed, never from what the model says. A
   * try is kept when it beats the best measured value so far.
   */
  async measure(claims: CapabilityClaims, raw: unknown, sandbox: TrySandbox): Promise<unknown> {
    if (!claims.scopes.includes('run.try'))
      throw new ServiceError('scope_denied', 'run.try is not available here.', 403);
    const input = runTryInput.parse(raw);
    const files = input.files ?? {};
    const tries = [
      { label: null as string | null, command: input.command },
      ...(input.variants ?? []),
    ];
    const first = tryCommand(input.command, files);
    if (first.length > MAX_COMMAND_CHARS)
      throw new ServiceError(
        'payload_invalid',
        `The files and command come to ${first.length} characters, more than the ${MAX_COMMAND_CHARS} one command may be. Write fewer or shorter files.`,
        400,
      );
    const metric = await this.jobs.transaction(async (tx) => {
      const { job: row } = await requireCurrentAttempt(tx, claims);
      const state = await this.stateOf(tx, row.id);
      const [root] = state.parentRunId
        ? await tx.select().from(runState).where(eq(runState.jobId, state.parentRunId))
        : [state];
      return root?.metric ?? null;
    });
    const timeout = timeoutMs(input.timeout_seconds, RUN_TRY_LIMITS.default_timeout_seconds);
    // The first command writes the files and opens the computer; the others
    // then run alongside each other in it.
    const ran: SandboxRun[] = [await sandbox({ command: first, timeout_ms: timeout })];
    ran.push(
      ...(await Promise.all(
        tries.slice(1).map((entry) =>
          sandbox({ command: entry.command, timeout_ms: timeout }).catch(
            (error): SandboxRun => ({
              status: 'failed',
              action_id: null,
              reason: (error as Error).message,
            }),
          ),
        ),
      )),
    );
    const results = await Promise.all(
      ran.map(async (result) => {
        if (result.status !== 'ran') return { result, value: null, error: null };
        if (result.timed_out)
          return { result, value: null, error: `It ran past its ${timeout / 1000}s limit.` };
        if (result.exit_code !== 0)
          return { result, value: null, error: `It exited with status ${result.exit_code}.` };
        let value: number | null;
        try {
          value = input.value_pattern
            ? await patternValue(result.output, input.value_pattern)
            : metricValue(result.output, metric?.name ?? null);
        } catch (error) {
          return { result, value: null, error: `${(error as Error).message}.` };
        }
        if (value !== null) return { result, value, error: null };
        const wanted = input.value_pattern
          ? 'Nothing in the output matched value_pattern.'
          : `No line \`METRIC ${metric?.name ?? '<name>'}=<number>\` was printed.`;
        return {
          result,
          value: null,
          error: result.truncated
            ? `${wanted} The output was longer than what is kept for reading; print the value near the start or print less.`
            : wanted,
        };
      }),
    );
    return this.jobs.transaction(async (tx) => {
      // Settling: a command the person must approve may have parked the job meanwhile.
      const { job: row } = await requireCurrentAttempt(tx, claims, { settling: true });
      const state = await this.stateOf(tx, row.id);
      const run = this.rootOf(state);
      // One writer at a time decides what is best.
      await tx.select().from(runState).where(eq(runState.jobId, run)).for('update');
      const direction = metric?.direction ?? 'higher';
      const previous = bestExperiment(
        await tx
          .select()
          .from(runEntry)
          .where(and(eq(runEntry.runJobId, run), eq(runEntry.kind, 'experiment'))),
        direction,
      );
      const before = previous ? object(previous.data) : null;
      const bestBefore =
        before?.checked === true && typeof before.value === 'number' ? before.value : null;
      // Only the best of this batch can be kept, and only if it beats the best so far.
      let winner = -1;
      let winning: number | null = null;
      for (const [index, entry] of results.entries()) {
        if (entry.value === null) continue;
        if (winning === null || better(entry.value, winning, direction)) {
          winner = index;
          winning = entry.value;
        }
      }
      const kept =
        winning !== null && (bestBefore === null || better(winning, bestBefore, direction));
      const tried = [];
      for (const [index, { result, value, error }] of results.entries()) {
        const label = tries[index]?.label ?? null;
        const title = label ? `${input.title}: ${label}` : input.title;
        if (result.status === 'waiting') {
          tried.push({ title, status: 'waiting_for_approval', action_id: result.action_id });
          continue;
        }
        const ok = result.status === 'ran' && value !== null;
        const outcome = !ok ? 'failed' : kept && index === winner ? 'kept' : 'discarded';
        const command = tries[index]?.command ?? input.command;
        const data: Record<string, unknown> = {
          measured: true,
          checked: ok,
          value: ok ? value : null,
          outcome,
          ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}),
          ...(label ? { variant: label } : {}),
          command,
          files,
          ...(metric && !input.value_pattern ? { metric: metric.name } : {}),
          ...(input.value_pattern ? { value_pattern: input.value_pattern } : {}),
          timeout_seconds: timeout / 1000,
          evidence: result.action_id ? [result.action_id] : [],
        };
        if (result.status === 'ran') {
          Object.assign(data, {
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            duration_ms: result.duration_ms,
            output_tail: tail(result.output),
          });
        }
        const why = result.status === 'failed' ? `It did not run: ${result.reason}` : error;
        if (why) data.error = why;
        const entry = await this.write(tx, {
          run,
          step: state.parentRunId ? row.id : null,
          attemptId: claims.attempt_id,
          kind: 'experiment',
          title,
          body: why ?? '',
          data,
        });
        tried.push({
          title,
          entry_id: entry.id,
          value: data.value,
          outcome,
          ...(why ? { error: why } : {}),
          ...(result.status === 'ran' && !ok ? { output_tail: tail(result.output, 600) } : {}),
        });
      }
      const waiting = tried.some((entry) => entry.status === 'waiting_for_approval');
      return {
        status: 'measured',
        tries: tried,
        new_best: kept,
        best: kept ? winning : bestBefore,
        ...(metric ? { metric: metric.name, direction } : {}),
        ...(waiting
          ? {
              instruction:
                "The person's approval rules ask them before this command runs, and nothing of it ran. Say in your handoff that it waits for them; once they approve, call run.try again with the same arguments to run and record it.",
            }
          : {}),
      };
    });
  }

  /** Whether a succeeded action of this run or its helpers shows the value in its output. */
  private async shown(tx: Transaction, run: string, value: number, ids: string[]) {
    const steps = tx
      .select({ id: runState.jobId })
      .from(runState)
      .where(eq(runState.parentRunId, run));
    const rows = await tx
      .select({ receipt: action.receipt })
      .from(action)
      .where(
        and(
          inArray(action.id, ids),
          eq(action.status, 'succeeded'),
          sql`(${action.jobId} = ${run} or ${action.jobId} in ${steps})`,
        ),
      );
    return rows.some((entry) => valueShown(value, JSON.stringify(entry.receipt ?? '')));
  }

  /** A report reaches the person: noted on the run and sent as a notification. */
  private async reported(tx: Transaction, run: string, row: JobRow, title: string, body: string) {
    await tx.update(runState).set({ lastReportAt: new Date() }).where(eq(runState.jobId, run));
    const [root] = await tx.select().from(job).where(eq(job.id, run));
    const principal = root?.principalId ?? row.principalId;
    if (!principal || !root) return;
    await tx
      .insert(pushIntent)
      .values({
        id: newId('pint'),
        principalId: principal,
        kind: 'progress',
        title: clip(`${root.title}: ${title}`, 120),
        body: clip(body || title, 300),
        because: 'Because it is working on this for you and has news.',
        url: `/#/runs/${run}`,
        dedupKey: `run-report:${run}:${newId('rune')}`,
      })
      .onConflictDoNothing({ target: pushIntent.dedupKey });
  }

  private async delegate(tx: Transaction, row: JobRow, attemptId: string, raw: unknown) {
    if (row.kind !== 'run')
      throw new ServiceError('scope_denied', 'A helper cannot start helpers of its own.', 403);
    const state = await this.stateOf(tx, row.id);
    const input = runDelegateInput.parse(raw);
    const [active] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runState)
      .innerJoin(job, eq(job.id, runState.jobId))
      .where(
        and(
          eq(runState.parentRunId, row.id),
          notInArray(job.state, ['completed', 'failed', 'cancelled']),
        ),
      );
    if (Number(active?.n ?? 0) >= RUN_ACTIVE_STEP_LIMIT)
      throw new ServiceError(
        'too_many_helpers',
        `${RUN_ACTIVE_STEP_LIMIT} helpers are already working. Wait for one to finish.`,
        409,
      );
    const assistant = await this.assistant(tx, row, input.assistant);
    const title = input.title ?? clip(input.task.split('\n')[0] ?? input.task, 120);
    const create = () =>
      this.jobs.createInTransaction(
        tx,
        {
          space_id: row.spaceId,
          title,
          objective: `${input.task}\n\nThis is one part of a larger piece of work: ${clip(state.goal, 1500)}`,
          scheduling_class: 'background',
          importance: 'routine',
          budget: RUN_SHIFT_BUDGET,
        },
        { kind: 'run_step', agentId: assistant ?? undefined },
      );
    const step = row.principalId
      ? await principalContext.run(row.principalId, create)
      : await create();
    await tx.insert(runState).values({
      jobId: step.id,
      spaceId: row.spaceId,
      parentRunId: row.id,
      goal: input.task,
    });
    await this.write(tx, {
      run: row.id,
      step: step.id,
      attemptId,
      kind: 'step_started',
      title,
      body: input.task,
      data: assistant ? { agent_id: assistant } : {},
    });
    return {
      status: 'started',
      helper_id: step.id,
      instruction:
        'The helper is working in parallel. To wait for it, end the shift with run.checkpoint and next_shift "when_helpers_finish".',
    };
  }

  /** The assistant named by name or role, or the run's own. */
  private async assistant(tx: Transaction, row: JobRow, wanted?: string) {
    if (!wanted) return row.agentId;
    const agents = await tx
      .select({ id: agent.id, name: agent.name, role: agent.role })
      .from(agent)
      .where(eq(agent.spaceId, row.spaceId));
    const needle = wanted.toLowerCase();
    const match =
      agents.find((entry) => entry.name.toLowerCase() === needle) ??
      agents.find((entry) => entry.role.toLowerCase() === needle) ??
      agents.find(
        (entry) =>
          entry.role.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle),
      );
    return match?.id ?? row.agentId;
  }

  private async checkpoint(tx: Transaction, row: JobRow, attemptId: string, raw: unknown) {
    const state = await this.stateOf(tx, row.id);
    const input = runCheckpointInput.parse(raw);
    if (
      typeof input.next_shift === 'string' &&
      !['now', 'when_helpers_finish', 'drop_trigger'].includes(input.next_shift)
    ) {
      if (Date.parse(input.next_shift) <= Date.now())
        throw new ServiceError('payload_invalid', 'next_shift must be in the future.', 400);
    }
    const nextShift = await checkpointNext(
      tx,
      this.jobs,
      row,
      Boolean(state.parentRunId),
      input.next_shift,
    );
    await this.write(tx, {
      run: this.rootOf(state),
      step: state.parentRunId ? row.id : null,
      attemptId,
      kind: 'checkpoint',
      title: clip(input.summary.split('\n')[0] ?? input.summary, 200),
      body: input.summary,
      data: { next: input.next, next_shift: nextShift },
    });
    return { status: 'saved', instruction: 'Saved. End this shift now with one short line.' };
  }

  private async finish(tx: Transaction, row: JobRow, attemptId: string, raw: unknown) {
    const state = await this.stateOf(tx, row.id);
    const input = runFinishInput.parse(raw);
    // A result written while helpers are still out would leave their findings behind.
    const working = state.parentRunId ? 0 : await this.activeSteps(tx, row.id);
    if (working)
      throw new ServiceError(
        'helpers_working',
        `${working} helper${working === 1 ? ' is' : 's are'} still working. End this shift with run.checkpoint and next_shift "when_helpers_finish", and finish once their results are in.`,
        409,
      );
    await this.write(tx, {
      run: this.rootOf(state),
      step: state.parentRunId ? row.id : null,
      attemptId,
      kind: 'finished',
      title: clip(input.summary.split('\n')[0] ?? input.summary, 200),
      body: input.summary,
    });
    await tx.update(runState).set({ finishedAt: new Date() }).where(eq(runState.jobId, row.id));
    if (!state.parentRunId) await this.reported(tx, row.id, row, 'Done', input.summary);
    return {
      status: 'finished',
      instruction: 'Recorded. End now with the result in one or two sentences.',
    };
  }

  // -------------------------------------------------------------------------
  // Between shifts.

  /**
   * How many more failed shifts in a row this run may have before it stops to
   * ask. A finished shift resets the count; shifts that went well do not use it.
   */
  async failuresRemaining(tx: Transaction, row: JobRow, budget: JobBudget): Promise<number> {
    const recent = await tx
      .select({ outcome: attempt.outcome, lease: attempt.leaseStatus })
      .from(attempt)
      .where(and(eq(attempt.jobId, row.id), isNotNull(attempt.endedAt)))
      .orderBy(desc(attempt.epoch))
      .limit(budget.max_attempts + 1);
    let streak = 0;
    for (const entry of recent) {
      if (entry.outcome !== 'failed' && entry.lease !== 'lost') break;
      streak++;
    }
    return Math.max(0, budget.max_attempts - streak);
  }

  /**
   * The outcome this shift's ending stands for, decided from the record. The
   * runner applies it exactly as it would any attempt's outcome.
   */
  async shiftEnded(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    outcome: AttemptOutcome,
  ): Promise<AttemptOutcome> {
    const [state] = await tx.select().from(runState).where(eq(runState.jobId, row.id));
    if (!state) return outcome;
    const run = this.rootOf(state);
    const step = state.parentRunId ? row.id : null;
    const shifts = state.shifts + 1;
    // Standing work rests on its trigger after a shift unless it asks otherwise.
    const stands = step ? null : await standingTrigger(tx, row.id);
    const mine = await tx
      .select()
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run),
          eq(runEntry.attemptId, attemptId),
          step ? eq(runEntry.stepJobId, step) : isNull(runEntry.stepJobId),
        ),
      )
      .orderBy(asc(runEntry.seq));
    const [acted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(action)
      .where(eq(action.attemptId, attemptId));
    // Anything recorded besides the handoff, a helper started, or an action.
    const [wrote] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run),
          eq(runEntry.attemptId, attemptId),
          ne(runEntry.kind, 'checkpoint'),
        ),
      );
    const progressed = Number(wrote?.n ?? 0) > 0 || Number(acted?.n ?? 0) > 0;
    // A shift that only handed off to a later time, or to helpers still out,
    // is resting rather than idle; one that only handed off to go on now is idle.
    const asked = [...mine].reverse().find((entry) => entry.kind === 'checkpoint');
    const askedNext = asked
      ? String(object(asked.data).next_shift ?? 'now')
      : stands
        ? ON_TRIGGER
        : 'now';
    const resting =
      askedNext === ON_TRIGGER
        ? Boolean(stands)
        : askedNext === 'when_helpers_finish'
          ? !step && (await this.activeSteps(tx, row.id)) > 0
          : askedNext !== 'now' && Date.parse(askedNext) > (await databaseNow(tx)).getTime();
    // Waiting on a trigger is not idling: a quiet day is the point of standing work.
    const idle =
      progressed || (askedNext === ON_TRIGGER && stands)
        ? 0
        : resting
          ? state.idleShifts
          : state.idleShifts + 1;
    await tx
      .update(runState)
      .set({ shifts, idleShifts: idle, waitingOnSteps: false })
      .where(eq(runState.jobId, row.id));

    // A helper has nobody to ask: the person does not see it, and its run
    // cannot finish while it waits. What would stop it to ask ends it instead,
    // and its run reads why with the helper's result.
    const ask = (question: string, why: string): AttemptOutcome =>
      step
        ? { kind: 'failed', retryable: false, reason: why }
        : { kind: 'waiting_for_input', question };

    const finished = mine.find((entry) => entry.kind === 'finished');
    if (finished) return { kind: 'completed', summary: finished.body, evidence: [] };
    if (step && outcome.kind === 'waiting_for_input')
      return ask(outcome.question, `It stopped to ask: ${clip(outcome.question, 1000)}`);
    // The person or an approval is needed: that wait stands as it is.
    if (
      outcome.kind === 'waiting_for_input' ||
      outcome.kind === 'waiting_for_approval' ||
      outcome.kind === 'unknown_check' ||
      outcome.kind === 'waiting_for_event_or_time'
    )
      return outcome;

    if (outcome.kind === 'failed') {
      const remaining = await this.failuresRemaining(tx, row, RUN_SHIFT_BUDGET);
      // This shift is not ended yet, so it is not in the count above.
      if (outcome.retryable && remaining > 1) return outcome;
      return ask(
        `I keep running into a problem with this: ${clip(outcome.reason, 300)} Say "continue" to try again, or tell me what to change.`,
        `It kept running into a problem: ${clip(outcome.reason, 1000)}`,
      );
    }

    // A helper that answered without asking to go on is done.
    if (
      step &&
      outcome.kind === 'completed' &&
      !mine.some((entry) => entry.kind === 'checkpoint')
    ) {
      await this.write(tx, {
        run,
        step,
        attemptId,
        kind: 'finished',
        title: clip(outcome.summary.split('\n')[0] || 'Finished', 200),
        body: outcome.summary,
      });
      return outcome;
    }

    if (idle >= RUN_IDLE_SHIFT_LIMIT)
      return ask(
        `I haven't made progress in my last ${RUN_IDLE_SHIFT_LIMIT} tries at this. What should I change, or should I stop?`,
        `It made no progress in ${RUN_IDLE_SHIFT_LIMIT} tries.`,
      );

    const over = await this.overLimit(tx, run, state, shifts);
    if (over)
      return {
        kind: 'waiting_for_input',
        question: `This reached the limit you set (${over}). Say "continue" to keep going.`,
      };

    // Every shift leaves a handoff. One the work did not write is written for it.
    let handoff = [...mine].reverse().find((entry) => entry.kind === 'checkpoint');
    if (!handoff) {
      const said = 'summary' in outcome ? outcome.summary.trim() : '';
      handoff = await this.write(tx, {
        run,
        step,
        attemptId,
        kind: 'checkpoint',
        title:
          outcome.kind === 'budget_exhausted'
            ? 'Paused at the time limit for one stretch of work'
            : 'Picked up where it stopped',
        body: said ? clip(said, 4000) : 'The shift ended without a handoff.',
        data: {
          next: 'Continue from the record.',
          next_shift: stands ? ON_TRIGGER : 'now',
          automatic: true,
        },
      });
    }
    // Standing work tells the person only what it reports: no daily summary
    // of quiet wakes.
    if (!step && !stands) await this.digest(tx, row, state, attemptId);
    const next = String(object(handoff.data).next_shift ?? 'now');
    const now = (await databaseNow(tx)).getTime();
    if (next === ON_TRIGGER && stands)
      return { kind: 'waiting_for_event_or_time', wait: await restOn(tx, stands) };
    if (next === 'when_helpers_finish' && !step) {
      if (await this.activeSteps(tx, row.id)) {
        await tx.update(runState).set({ waitingOnSteps: true }).where(eq(runState.jobId, row.id));
        return {
          kind: 'waiting_for_event_or_time',
          wait: { kind: 'timer', wake_at: new Date(now + HELPER_FALLBACK_MS).toISOString() },
        };
      }
    } else if (next !== 'now' && next !== 'when_helpers_finish' && Date.parse(next) > now) {
      return {
        kind: 'waiting_for_event_or_time',
        wait: { kind: 'timer', wake_at: new Date(Date.parse(next)).toISOString() },
      };
    }
    return {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'timer', wake_at: new Date(now + 1000).toISOString() },
    };
  }

  /** The limit the person set that this run has reached, in words, or null. */
  private async overLimit(tx: Transaction, run: string, state: State, shifts: number) {
    if (state.parentRunId) return null;
    const limit = runLimit.safeParse(state.limit ?? {});
    if (!limit.success) return null;
    const { max_hours, max_output_tokens, max_shifts } = limit.data;
    if (max_shifts !== undefined && shifts >= max_shifts) return `${max_shifts} rounds of work`;
    if (
      max_hours !== undefined &&
      Date.now() - state.createdAt.getTime() >= max_hours * 60 * 60_000
    )
      return `${max_hours} hours`;
    if (max_output_tokens !== undefined) {
      const jobs = [run, ...(await this.stepIds(tx, run))];
      const [used] = await tx
        .select({ n: sql<number>`coalesce(sum(coalesce(settled, reserved)), 0)::float8` })
        .from(budgetLedger)
        .where(and(inArray(budgetLedger.jobId, jobs), eq(budgetLedger.kind, 'tokens')));
      if (Number(used?.n ?? 0) >= max_output_tokens) return 'the amount of model use you allowed';
    }
    return null;
  }

  private async stepIds(tx: Transaction, run: string) {
    const rows = await tx
      .select({ id: runState.jobId })
      .from(runState)
      .where(eq(runState.parentRunId, run));
    return rows.map((entry) => entry.id);
  }

  private async activeSteps(tx: Transaction, run: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runState)
      .innerJoin(job, eq(job.id, runState.jobId))
      .where(
        and(
          eq(runState.parentRunId, run),
          notInArray(job.state, ['completed', 'failed', 'cancelled']),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * A run that has gone a day without telling the person anything gets a
   * short summary written from its record, with no model call.
   */
  private async digest(tx: Transaction, row: JobRow, state: State, attemptId: string) {
    const since = state.lastReportAt ?? state.createdAt;
    if (Date.now() - since.getTime() < REPORT_EVERY_MS) return;
    const entries = await tx
      .select()
      .from(runEntry)
      .where(and(eq(runEntry.runJobId, row.id), gt(runEntry.createdAt, since)))
      .orderBy(asc(runEntry.seq));
    if (!entries.length) return;
    const count = (kind: string) => entries.filter((entry) => entry.kind === kind).length;
    const parts = [
      count('experiment')
        ? `${count('experiment')} ${count('experiment') === 1 ? 'try' : 'tries'}`
        : null,
      count('finding') ? `${count('finding')} findings` : null,
      count('step_finished') ? `${count('step_finished')} from helpers` : null,
    ].filter(Boolean);
    const latest = [...entries].reverse().find((entry) => entry.kind === 'checkpoint');
    const next = latest ? String(object(latest.data).next ?? '') : '';
    const body = [
      parts.length ? `Since the last update: ${parts.join(', ')}.` : 'Still working on it.',
      next ? `Next: ${clip(next, 300)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    await this.write(tx, {
      run: row.id,
      attemptId,
      kind: 'report',
      title: 'Daily update',
      body,
      data: { automatic: true },
    });
    await this.reported(tx, row.id, row, 'Daily update', body);
  }

  /**
   * A helper ended. Its result goes into the run's record, and a run asleep
   * until its helpers are done is woken once none is left. The run's row is
   * taken only if it is free: a run busy right now looks at its helpers itself
   * at the end of its shift, and a sleeping one also wakes on its own timer.
   */
  async stepEnded(tx: Transaction, row: JobRow, outcome: AttemptOutcome) {
    if (row.kind !== 'run_step' || !isTerminal(row.state as JobState)) return;
    const [state] = await tx.select().from(runState).where(eq(runState.jobId, row.id));
    if (!state?.parentRunId) return;
    const run = state.parentRunId;
    const [result] = await tx
      .select()
      .from(runEntry)
      .where(and(eq(runEntry.stepJobId, row.id), eq(runEntry.kind, 'finished')))
      .orderBy(desc(runEntry.seq))
      .limit(1);
    const said =
      result?.body ??
      ('summary' in outcome ? outcome.summary : 'reason' in outcome ? outcome.reason : '');
    await this.write(tx, {
      run,
      step: row.id,
      kind: 'step_finished',
      title: `${row.title}: ${row.state === 'completed' ? 'done' : row.state}`,
      body: clip(said, 4000),
      data: { state: row.state },
    });
    const [parent] = await tx.select().from(runState).where(eq(runState.jobId, run));
    if (!parent?.waitingOnSteps || (await this.activeSteps(tx, run))) return;
    const locked = await this.jobs.lock(tx, run, true);
    if (locked?.state !== 'waiting_for_event_or_time' || locked.paused) return;
    await tx.update(runState).set({ waitingOnSteps: false }).where(eq(runState.jobId, run));
    await this.jobs.move(tx, locked, { kind: 'timer_fired' }, { reason: 'timer' });
  }

  private steps(tx: Transaction, run: string) {
    return stepsOf(tx, run);
  }

  // -------------------------------------------------------------------------
  // What a person reads.

  async requireRun(spaceId: string, id: string): Promise<JobRow> {
    const [row] = await this.db
      .select()
      .from(job)
      .where(and(eq(job.id, id), eq(job.spaceId, spaceId), eq(job.kind, 'run'), ownJob()));
    if (!row) throw missing();
    return row;
  }

  async view(row: JobRow): Promise<RunView> {
    return this.jobs.transaction(async (tx) => {
      const state = await this.stateOf(tx, row.id);
      const entries = await tx
        .select()
        .from(runEntry)
        .where(
          and(
            eq(runEntry.runJobId, row.id),
            inArray(runEntry.kind, ['plan', 'report', 'checkpoint', 'finished']),
            isNull(runEntry.stepJobId),
          ),
        )
        .orderBy(desc(runEntry.seq))
        .limit(200);
      const newest = (kind: string) => entries.find((entry) => entry.kind === kind);
      const experiments = await tx
        .select()
        .from(runEntry)
        .where(and(eq(runEntry.runJobId, row.id), eq(runEntry.kind, 'experiment')))
        .orderBy(desc(runEntry.seq));
      const [findings] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(runEntry)
        .where(and(eq(runEntry.runJobId, row.id), eq(runEntry.kind, 'finding')));
      const [open] = await tx
        .select({ text: question.text })
        .from(question)
        .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
        .limit(1);
      const steps = await this.steps(tx, row.id);
      const status = runStatusOf(row.state, row.paused);
      const metric = state.metric ?? null;
      const best = bestExperiment(experiments, metric?.direction ?? 'higher');
      const experimentView = (entry: Entry) => {
        const data = object(entry.data);
        return {
          id: entry.id,
          title: entry.title,
          value: typeof data.value === 'number' ? data.value : null,
          outcome: ['kept', 'discarded', 'failed'].includes(String(data.outcome))
            ? (data.outcome as 'kept' | 'discarded' | 'failed')
            : null,
          checked: data.checked === true,
          created_at: entry.createdAt.toISOString(),
        };
      };
      const wait = object(row.wait);
      const question_ =
        open?.text ??
        (wait.kind === 'user_input' && typeof wait.question === 'string' ? wait.question : null);
      const report = newest('report');
      const handoff = newest('checkpoint');
      const finished = newest('finished');
      const registration = isTerminal(row.state as JobState)
        ? null
        : await standingTrigger(tx, row.id);
      const standing = registration ? await standingView(tx, this.jobs, row, registration) : null;
      const onTrigger = Boolean(standing) && restingOnTrigger(row);
      return runView.parse({
        id: row.id,
        title: row.title,
        goal: state.goal,
        done_when: state.doneWhen,
        status,
        status_line: statusLine({
          status,
          paused: row.paused,
          experiments: experiments.length,
          best: best ? object(best.data).value : undefined,
          metric: metric?.name,
          helpersWorking: steps.filter(
            (entry) => entry.status === 'working' || entry.status === 'waiting',
          ).length,
          waitingOnSteps: state.waitingOnSteps,
          nextWakeAt: row.state === 'waiting_for_event_or_time' ? row.nextWakeAt : null,
          question: question_,
          standing: onTrigger ? (standing?.kind ?? null) : null,
        }),
        conversation_id: state.conversationId,
        agent_id: row.agentId,
        started_at: state.createdAt.toISOString(),
        finished_at:
          state.finishedAt?.toISOString() ??
          (isTerminal(row.state as JobState) ? row.updatedAt.toISOString() : null),
        next_shift_at: onTrigger
          ? (standing?.next_wake_at ?? null)
          : row.state === 'waiting_for_event_or_time'
            ? (row.nextWakeAt?.toISOString() ?? null)
            : null,
        standing,
        shifts: state.shifts,
        metric,
        limit: state.limit ? runLimit.parse(state.limit) : null,
        plan: (() => {
          const plan = newest('plan');
          return plan ? plan.body || plan.title : null;
        })(),
        latest_report: report
          ? { title: report.title, body: report.body, created_at: report.createdAt.toISOString() }
          : null,
        next: handoff ? String(object(handoff.data).next ?? '') || null : null,
        result: finished?.body ?? null,
        experiments: {
          count: experiments.length,
          best: best ? experimentView(best) : null,
          recent: experiments.slice(0, 10).map(experimentView),
        },
        findings: Number(findings?.n ?? 0),
        steps,
        question: status === 'needs_you' ? question_ : null,
      });
    });
  }

  async list(spaceId: string, conversationId?: string) {
    const rows = await this.db
      .select({ job })
      .from(job)
      .innerJoin(runState, eq(runState.jobId, job.id))
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'run'),
          ownJob(),
          conversationId ? eq(runState.conversationId, conversationId) : undefined,
        ),
      )
      .orderBy(desc(job.updatedAt))
      .limit(100);
    const runs = [];
    for (const entry of rows) runs.push(await this.view(entry.job));
    return { runs };
  }

  async record(row: JobRow, after?: string, limit = 100) {
    const cursor = after && /^\d+$/.test(after) ? Number(after) : 0;
    const entries = await this.db
      .select()
      .from(runEntry)
      .where(and(eq(runEntry.runJobId, row.id), gt(runEntry.seq, cursor)))
      .orderBy(asc(runEntry.seq))
      .limit(limit + 1);
    const page = entries.slice(0, limit);
    return {
      entries: page.map(entryView),
      next_cursor: entries.length > limit ? String(page.at(-1)?.seq ?? cursor) : null,
    };
  }

  /** The whole record as one Markdown document. */
  async markdown(row: JobRow): Promise<string> {
    const view = await this.view(row);
    const entries = await this.db
      .select()
      .from(runEntry)
      .where(eq(runEntry.runJobId, row.id))
      .orderBy(asc(runEntry.seq));
    const steps = new Map(view.steps.map((entry) => [entry.id, entry.title]));
    const lines = [
      `# ${view.title}`,
      '',
      `Goal: ${view.goal}`,
      ...(view.done_when ? [`Done when: ${view.done_when}`] : []),
      `Started: ${view.started_at}`,
      `Status: ${view.status_line}`,
      '',
    ];
    for (const entry of entries) {
      const by = entry.stepJobId
        ? ` (helper: ${steps.get(entry.stepJobId) ?? entry.stepJobId})`
        : '';
      const data = object(entry.data);
      const label =
        entry.kind === 'experiment' && data.measured === true
          ? 'Measured'
          : (ENTRY_LABELS[entry.kind] ?? 'Note');
      lines.push(`## ${entry.createdAt.toISOString()} · ${label}${by}: ${entry.title}`, '');
      if (entry.body) lines.push(entry.body, '');
      if (entry.kind === 'experiment') {
        const facts = [
          typeof data.hypothesis === 'string' ? `Idea: ${data.hypothesis}` : null,
          typeof data.value === 'number' ? `Value: ${data.value}` : null,
          `Outcome: ${String(data.outcome ?? '')}`,
          data.measured === true
            ? `Measured by Melete from the command's output${typeof data.exit_code === 'number' ? `, exit status ${data.exit_code}` : ''}${typeof data.duration_ms === 'number' ? `, ${data.duration_ms} ms` : ''}`
            : `Confirmed from its output: ${data.checked === true ? 'yes' : 'no'}`,
          Array.isArray(data.evidence) && data.evidence.length
            ? `Evidence: ${data.evidence.join(', ')}`
            : null,
        ].filter(Boolean);
        lines.push(...facts.map((fact) => `- ${fact}`), '');
        if (typeof data.command === 'string') lines.push(...fence('sh', data.command), '');
        if (typeof data.output_tail === 'string' && data.output_tail)
          lines.push('Output (the end):', '', ...fence('', data.output_tail), '');
      }
      if (entry.kind === 'checkpoint' && typeof data.next === 'string')
        lines.push(`Next: ${data.next}`, '');
    }
    const best = bestExperiment(
      entries.filter((entry) => entry.kind === 'experiment'),
      view.metric?.direction ?? 'higher',
    );
    const again = best ? object(best.data) : null;
    if (best && again?.measured === true && typeof again.command === 'string') {
      // The best measured try, as someone would run it again by hand.
      lines.push(
        '## Run the best try again',
        '',
        `${best.title}${typeof again.value === 'number' ? `, which measured ${again.value}` : ''}. In an empty folder, write these files and run the command:`,
        '',
      );
      for (const [path, text] of Object.entries(object(again.files)))
        lines.push(`\`${path}\`:`, '', ...fence('', String(text)), '');
      lines.push(...fence('sh', again.command), '');
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }

  // -------------------------------------------------------------------------
  // What a person does.

  async stop(row: JobRow) {
    const cancel = async (id: string) => {
      try {
        await this.jobs.cancel(id, 'run_stopped');
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'already_terminal') throw error;
      }
    };
    // What it stands on goes first, so nothing wakes it behind the stop. Then
    // the run: once it is fenced it cannot start another helper, so the
    // helpers read after it are all there are.
    if (await this.jobs.transaction((tx) => unstand(tx, row.id))) await this.syncSchedules();
    await cancel(row.id);
    const steps = await this.db
      .select({ id: job.id })
      .from(runState)
      .innerJoin(job, eq(job.id, runState.jobId))
      .where(
        and(
          eq(runState.parentRunId, row.id),
          notInArray(job.state, ['completed', 'failed', 'cancelled']),
        ),
      );
    for (const step of steps) await cancel(step.id);
  }

  /**
   * Pausing lets a shift under way finish and starts no new one; the run and
   * its helpers rest until resumed. Resuming starts the next shift now.
   */
  async setPaused(row: JobRow, paused: boolean) {
    // Helpers are locked before their run. A helper ending, or writing to the
    // record, holds its own row and then needs the run's row (the record's
    // foreign key), so taking the run first could deadlock with it.
    const ids = [...(await this.jobs.transaction((tx) => this.stepIds(tx, row.id))), row.id];
    const triggers = await this.jobs.transaction(async (tx) => {
      for (const id of ids) {
        const locked = await this.jobs.lock(tx, id);
        if (!locked || isTerminal(locked.state as JobState)) continue;
        await tx.update(job).set({ paused, updatedAt: new Date() }).where(eq(job.id, id));
        // Standing work resumed keeps resting on its trigger, which is on again.
        const onTrigger =
          locked.state === 'waiting_for_event_or_time' &&
          waitSpec.safeParse(locked.wait).data?.kind === 'event';
        if (
          !paused &&
          !onTrigger &&
          ['queued', 'waiting_for_event_or_time'].includes(locked.state)
        ) {
          const moved =
            locked.state === 'queued'
              ? { ...locked, paused: false, nextWakeAt: await databaseNow(tx) }
              : await this.jobs.move(
                  tx,
                  { ...locked, paused: false },
                  { kind: 'timer_fired' },
                  { reason: 'timer' },
                );
          if (locked.state === 'queued') {
            await tx.update(job).set({ nextWakeAt: moved.nextWakeAt }).where(eq(job.id, id));
            await this.jobs.enqueue(tx, moved, 'recovery');
          }
        }
      }
      await appendEvent(tx, {
        jobId: row.id,
        type: 'notice',
        payload: { kind: paused ? 'run_paused' : 'run_resumed' },
        dedupKey: `${row.id}:${paused ? 'paused' : 'resumed'}:${newId('op')}`,
      });
      return setStandingEnabled(tx, row.id, !paused);
    });
    if (triggers) await this.syncSchedules();
  }

  /**
   * The person's words for the work. A question it asked is answered; a run
   * resting between shifts starts its next one now; one in the middle of a
   * shift reads them at the next; a finished run takes them up again.
   */
  async message(row: JobRow, text: string) {
    await this.jobs.transaction(async (tx) => {
      const locked = await this.jobs.lock(tx, row.id);
      if (!locked) throw missing();
      // Decided under the lock: a shift that just ended with a question gets
      // this as its answer, not as a note it never reads.
      if (locked.state === 'waiting_for_input') {
        await this.jobs.inputInTransaction(tx, row.id, text);
        return;
      }
      if (locked.state === 'cancelled')
        throw new ServiceError(
          'run_stopped',
          'This work was stopped. Start it again instead.',
          409,
        );
      await appendEvent(tx, {
        jobId: row.id,
        type: 'notice',
        payload: {
          kind: 'user_message',
          text,
          principal_id: requestPrincipal() ?? locked.principalId ?? null,
        },
        dedupKey: `${row.id}:input:${newId('op')}`,
      });
      if (locked.state === 'completed' || locked.state === 'failed') {
        // Taking finished work up again also ends a pause it finished under:
        // resume skips finished work, so nothing else would ever lift it.
        await tx
          .update(runState)
          .set({ finishedAt: null, idleShifts: 0 })
          .where(eq(runState.jobId, row.id));
        if (locked.paused) await tx.update(job).set({ paused: false }).where(eq(job.id, row.id));
        await this.jobs.move(
          tx,
          { ...locked, paused: false },
          { kind: 'conversation_continued' },
          { reason: 'input' },
        );
      } else if (locked.paused) {
        return;
      } else if (locked.state === 'waiting_for_event_or_time') {
        await tx.update(runState).set({ waitingOnSteps: false }).where(eq(runState.jobId, row.id));
        await this.jobs.move(tx, locked, { kind: 'timer_fired' }, { reason: 'input' });
      }
    });
  }

  async setLimit(row: JobRow, limit: RunLimit | null) {
    await this.db
      .update(runState)
      .set({ limit: limit ? runLimit.parse(limit) : null })
      .where(eq(runState.jobId, row.id));
  }
}

/** A fenced block that the text inside cannot close early. */
function fence(language: string, text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return [`${ticks}${language}`, text.replace(/\n$/, ''), ticks];
}

function entryView(entry: Entry): RunEntry {
  return {
    id: entry.id,
    kind: entry.kind as RunEntry['kind'],
    title: entry.title,
    body: entry.body,
    step_id: entry.stepJobId,
    data: entry.data,
    created_at: entry.createdAt.toISOString(),
  };
}

/** How each kind of entry is named for a person reading the record. */
const ENTRY_LABELS: Record<string, string> = {
  plan: 'Plan',
  note: 'Note',
  finding: 'Found',
  decision: 'Decided',
  experiment: 'Tried',
  report: 'Update',
  checkpoint: 'Progress saved',
  step_started: 'Helper started',
  step_finished: 'Helper finished',
  finished: 'Done',
};

/** One line on where the work stands, in the person's words: no shifts, no internals. */
function statusLine(input: {
  status: RunStatus;
  paused: boolean;
  experiments: number;
  best: unknown;
  metric?: string;
  helpersWorking: number;
  waitingOnSteps: boolean;
  nextWakeAt: Date | null;
  question: string | null;
  /** Set while standing work rests on its trigger. */
  standing: 'schedule' | 'event' | 'watch' | null;
}): string {
  const tried =
    input.experiments > 0
      ? `${input.experiments} ${input.experiments === 1 ? 'try' : 'tries'}${
          typeof input.best === 'number'
            ? `, best ${input.metric ? `${input.metric} ` : ''}${input.best.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
            : ''
        }`
      : null;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  switch (input.status) {
    case 'done':
      return join('Done', tried);
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'It could not go on';
    case 'needs_you':
      return input.question ? clip(input.question, 200) : 'Waiting for you';
    case 'working':
      return join('Working on it', tried);
    default:
      if (input.paused) return join('Paused', tried);
      if (input.waitingOnSteps)
        return join(
          `Waiting for ${input.helpersWorking} helper${input.helpersWorking === 1 ? '' : 's'}`,
          tried,
        );
      if (input.standing)
        return join(input.standing === 'schedule' ? 'Waiting until next time' : 'Watching', tried);
      if (input.nextWakeAt && input.nextWakeAt.getTime() - Date.now() < 60_000)
        return join('Working on it', tried);
      return join(input.nextWakeAt ? 'Picks up again later' : 'Waiting', tried);
  }
}

export { isRunKind };

/** Puts long work on a runner: its shifts are decided here, and a helper's end wakes its run. */
export function attachRuns(runner: AttemptRunner, runs: RunService) {
  runner.runs = runs;
  runner.onFinished.push((tx, row, outcome) => runs.stepEnded(tx, row, outcome));
  // Finished work stands on nothing; taken up again, it can set a new trigger.
  runner.onFinished.push(async (tx, row) => {
    if (row.kind === 'run' && isTerminal(row.state as JobState)) await unstand(tx, row.id);
  });
}
