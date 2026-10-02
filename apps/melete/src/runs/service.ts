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
  type JobConstraints,
  type JobState,
  jobConstraints,
  RUN_ACTIVE_STEP_LIMIT,
  RUN_CHECK_LIMIT,
  RUN_IDLE_SHIFT_LIMIT,
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
  runView,
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
  or,
  sql,
} from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { databaseNow } from '../db/clock.ts';
import {
  action,
  agent,
  attempt,
  budgetLedger,
  event,
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
import { ownJob, principalContext, requestPrincipal } from '../principals/authority.ts';
import {
  clip,
  type Entry,
  gapsOf,
  object,
  runStatusOf,
  type State,
  stepsOfRuns,
  textOf,
  valueShown,
} from './record.ts';

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
/** Progress notifications one run sends at most this often; its result and questions always go. */
const PUSH_EVERY_MS = 30 * 60_000;
/** Kinds of entry that mark where a result stands: offered, checked, given. */
const RESULT_KINDS = ['proposed', 'check', 'finished'];

const missing = () => new ServiceError('not_found', 'That piece of work was not found.', 404);

export class RunService {
  constructor(readonly jobs: JobService) {}

  get db() {
    return this.jobs.db;
  }

  // -------------------------------------------------------------------------
  // Tools an attempt calls.

  async call(claims: CapabilityClaims, name: string, input: unknown): Promise<unknown> {
    if (!claims.scopes.includes(name))
      throw new ServiceError('scope_denied', `${name} is not available here.`, 403);
    return this.jobs.transaction(async (tx) => {
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
    origin: {
      conversation?: JobRow;
      agentId?: string | null;
      principalId?: string | null;
      /** The person typed the goal themselves. */
      typed?: boolean;
    },
  ) {
    const input = runCreateRequest.parse(raw);
    // Counted inside a service transaction, which holds the event order lock:
    // two starts at once are counted one after the other.
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
          constraints: carried(origin.conversation?.constraints),
        },
        { kind: 'run', agentId: origin.agentId ?? undefined },
        origin.typed ? 'owner_request' : 'derived',
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
      checkResult: input.check_result ?? true,
    });
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
    const data: Record<string, unknown> = input.dead_end ? { dead_end: true } : {};
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
    return rows.some((entry) => valueShown(value, textOf(entry.receipt)));
  }

  /**
   * A report reaches the person: noted on the run and sent as a notification.
   * Progress is sent at most once per `PUSH_EVERY_MS` for a run; the rest stays
   * in the record and the view. The result is always sent.
   */
  private async reported(
    tx: Transaction,
    run: string,
    row: JobRow,
    title: string,
    body: string,
    final = false,
  ) {
    await tx.update(runState).set({ lastReportAt: new Date() }).where(eq(runState.jobId, run));
    const [root] = await tx.select().from(job).where(eq(job.id, run));
    const principal = root?.principalId ?? row.principalId;
    if (!principal || !root) return;
    if (!final) {
      const since = new Date((await databaseNow(tx)).getTime() - PUSH_EVERY_MS);
      const [recent] = await tx
        .select({ id: pushIntent.id })
        .from(pushIntent)
        .where(
          and(
            eq(pushIntent.principalId, principal),
            gt(pushIntent.createdAt, since),
            sql`starts_with(${pushIntent.dedupKey}, ${`run-report:${run}:`})`,
          ),
        )
        .limit(1);
      if (recent) return;
    }
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
    const [given] = await tx
      .select({ id: runEntry.id })
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, row.id),
          eq(runEntry.attemptId, attemptId),
          inArray(runEntry.kind, ['proposed', 'finished']),
        ),
      )
      .limit(1);
    if (given)
      throw new ServiceError(
        'already_finished',
        'The result is already given in this shift, so no helper can start now. End the shift.',
        409,
      );
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
          constraints: carried(row.constraints),
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
    if (input.next_shift && !['now', 'when_helpers_finish'].includes(input.next_shift)) {
      if (Date.parse(input.next_shift) <= Date.now())
        throw new ServiceError('payload_invalid', 'next_shift must be in the future.', 400);
    }
    await this.write(tx, {
      run: this.rootOf(state),
      step: state.parentRunId ? row.id : null,
      attemptId,
      kind: 'checkpoint',
      title: clip(input.summary.split('\n')[0] ?? input.summary, 200),
      body: input.summary,
      data: { next: input.next, next_shift: input.next_shift ?? 'now' },
    });
    return { status: 'saved', instruction: 'Saved. End this shift now with one short line.' };
  }

  private async finish(tx: Transaction, row: JobRow, attemptId: string, raw: unknown) {
    const state = await this.stateOf(tx, row.id);
    const input = runFinishInput.parse(raw);
    const step = state.parentRunId ? row.id : null;
    if (state.checking) {
      if (!input.verdict || (input.verdict === 'gaps' && !input.gaps?.length))
        throw new ServiceError(
          'payload_invalid',
          'Give a verdict: "passes", or "gaps" with each gap named in gaps.',
          400,
        );
    } else if (input.verdict || input.gaps)
      throw new ServiceError(
        'payload_invalid',
        'A verdict is given only when checking a result. Leave out verdict and gaps.',
        400,
      );
    if (!step) {
      if (await this.checkUnderWay(tx, row.id))
        throw new ServiceError(
          'check_in_progress',
          'The result you gave is being checked right now. End this shift with run.checkpoint and next_shift "when_helpers_finish"; what the check finds comes back here.',
          409,
        );
      // A result written while helpers are still out would leave their findings behind.
      const working = await this.activeSteps(tx, row.id);
      if (working)
        throw new ServiceError(
          'helpers_working',
          `${working} helper${working === 1 ? ' is' : 's are'} still working. End this shift with run.checkpoint and next_shift "when_helpers_finish", and finish once their results are in.`,
          409,
        );
    }
    const title = clip(input.summary.split('\n')[0] ?? input.summary, 200);
    const data = {
      ...(input.evidence?.length ? { evidence: input.evidence } : {}),
      ...(input.verdict ? { verdict: input.verdict, gaps: input.gaps ?? [] } : {}),
    };
    // Work with a definition of done is not done on its own say-so: a
    // separate check confirms the result first.
    if (!step && state.checkResult && state.doneWhen) {
      const proposal = await this.write(tx, {
        run: row.id,
        attemptId,
        kind: 'proposed',
        title,
        body: input.summary,
        data,
      });
      await this.startCheck(tx, row, proposal);
      return {
        status: 'checking',
        instruction:
          'A separate check now confirms the result before it is given to the person. End this shift now with one short line.',
      };
    }
    await this.write(tx, {
      run: this.rootOf(state),
      step,
      attemptId,
      kind: 'finished',
      title,
      body: input.summary,
      data,
    });
    await tx.update(runState).set({ finishedAt: new Date() }).where(eq(runState.jobId, row.id));
    if (!step) await this.reported(tx, row.id, row, 'Done', input.summary, true);
    return {
      status: 'finished',
      instruction: 'Recorded. End now with the result in one or two sentences.',
    };
  }

  /** A helper with a fresh start checks a proposed result against the record. */
  private async startCheck(tx: Transaction, row: JobRow, proposal: Entry) {
    const title = 'Checking the result';
    const create = () =>
      this.jobs.createInTransaction(
        tx,
        {
          space_id: row.spaceId,
          title,
          objective: 'Check whether a result is really done before it is given to the person.',
          scheduling_class: 'background',
          importance: 'routine',
          budget: RUN_SHIFT_BUDGET,
          constraints: carried(row.constraints),
        },
        { kind: 'run_step', agentId: row.agentId ?? undefined },
      );
    const step = row.principalId
      ? await principalContext.run(row.principalId, create)
      : await create();
    await tx.insert(runState).values({
      jobId: step.id,
      spaceId: row.spaceId,
      parentRunId: row.id,
      goal: title,
      checking: proposal.id,
    });
    await this.write(tx, {
      run: row.id,
      step: step.id,
      attemptId: proposal.attemptId,
      kind: 'step_started',
      title,
      body: 'A separate check of the result before it is called done.',
      data: { check: true },
    });
  }

  /** Whether a check of this run's result is still going. */
  private async checkUnderWay(tx: Transaction, run: string): Promise<boolean> {
    const [row] = await tx
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
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Between shifts.

  /**
   * How many more failed shifts in a row this run may have before it stops to
   * ask. A finished shift resets the count; shifts that went well do not use it,
   * and the person's word ("continue", or anything else) starts it again.
   */
  async failuresRemaining(tx: Transaction, row: JobRow, budget: JobBudget): Promise<number> {
    const [answered] = await tx
      .select({ at: event.createdAt })
      .from(event)
      .where(
        and(
          eq(event.jobId, row.id),
          eq(event.type, 'notice'),
          sql`${event.payload}->>'kind' = 'user_message'`,
        ),
      )
      .orderBy(desc(event.seq))
      .limit(1);
    const recent = await tx
      .select({ outcome: attempt.outcome, lease: attempt.leaseStatus })
      .from(attempt)
      .where(
        and(
          eq(attempt.jobId, row.id),
          isNotNull(attempt.endedAt),
          answered ? gt(attempt.startedAt, answered.at) : undefined,
        ),
      )
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
    const askedNext = asked ? String(object(asked.data).next_shift ?? 'now') : 'now';
    const resting =
      askedNext === 'when_helpers_finish'
        ? !step && (await this.activeSteps(tx, row.id)) > 0
        : askedNext !== 'now' && Date.parse(askedNext) > (await databaseNow(tx)).getTime();
    const idle = progressed ? 0 : resting ? state.idleShifts : state.idleShifts + 1;
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
    if (step && outcome.kind === 'unknown_check')
      return ask(
        outcome.message,
        `It could not tell whether an action went through: ${clip(outcome.message, 1000)}`,
      );
    // The person or an approval is needed: that wait stands as it is.
    if (
      outcome.kind === 'waiting_for_input' ||
      outcome.kind === 'waiting_for_approval' ||
      outcome.kind === 'unknown_check' ||
      outcome.kind === 'waiting_for_event_or_time'
    )
      return outcome;

    // A result was given and is being checked: the run rests until the check
    // is done. Whatever else the shift ended with, the result stands.
    if (!step && mine.some((entry) => entry.kind === 'proposed')) {
      const now = (await databaseNow(tx)).getTime();
      const checking = await this.checkUnderWay(tx, row.id);
      if (checking)
        await tx.update(runState).set({ waitingOnSteps: true }).where(eq(runState.jobId, row.id));
      return {
        kind: 'waiting_for_event_or_time',
        wait: {
          kind: 'timer',
          wake_at: new Date(now + (checking ? HELPER_FALLBACK_MS : 1000)).toISOString(),
        },
      };
    }

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
        data: { next: 'Continue from the record.', next_shift: 'now', automatic: true },
      });
    }
    if (!step) await this.digest(tx, row, state, attemptId);
    const next = String(object(handoff.data).next_shift ?? 'now');
    const now = (await databaseNow(tx)).getTime();
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
   * A helper ending and its run ending a shift cannot interleave: both happen
   * in service transactions, which take the event order lock first.
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
    const ended =
      row.state === 'completed' ? 'done' : row.state === 'cancelled' ? 'stopped' : 'failed';
    await this.write(tx, {
      run,
      step: row.id,
      kind: 'step_finished',
      title: `${row.title}: ${ended}`,
      body: clip(said, 4000),
      data: { state: row.state },
    });
    const [root] = await tx.select({ state: job.state }).from(job).where(eq(job.id, run));
    if (!root || isTerminal(root.state as JobState)) return;
    if (state.checking) await this.checked(tx, run, state, row, result, said);
    const [parent] = await tx.select().from(runState).where(eq(runState.jobId, run));
    if (!parent?.waitingOnSteps || (await this.activeSteps(tx, run))) return;
    const locked = await this.jobs.lock(tx, run, true);
    if (locked?.state !== 'waiting_for_event_or_time' || locked.paused) return;
    await tx.update(runState).set({ waitingOnSteps: false }).where(eq(runState.jobId, run));
    await this.jobs.move(tx, locked, { kind: 'timer_fired' }, { reason: 'timer' });
  }

  /**
   * A check of a result ended. What it found goes into the record. The run is
   * given its result when the check passed, when it could not reach a verdict,
   * or when it has found gaps `RUN_CHECK_LIMIT` times: then the result says
   * plainly what could not be confirmed. Otherwise the gaps go back to the run.
   */
  private async checked(
    tx: Transaction,
    run: string,
    state: State,
    row: JobRow,
    result: Entry | undefined,
    said: string,
  ) {
    const [proposal] = state.checking
      ? await tx.select().from(runEntry).where(eq(runEntry.id, state.checking))
      : [];
    if (!proposal) return;
    const found = object(result?.data);
    const verdict =
      row.state === 'completed' && (found.verdict === 'passes' || found.verdict === 'gaps')
        ? found.verdict
        : null;
    const gaps = verdict === 'gaps' ? gapsOf(found) : [];
    // Checks that found gaps since the work was last given a result.
    const [given] = await tx
      .select({ seq: runEntry.seq })
      .from(runEntry)
      .where(
        and(eq(runEntry.runJobId, run), eq(runEntry.kind, 'finished'), isNull(runEntry.stepJobId)),
      )
      .orderBy(desc(runEntry.seq))
      .limit(1);
    const [before] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run),
          eq(runEntry.kind, 'check'),
          sql`${runEntry.data}->>'verdict' = 'gaps'`,
          gt(runEntry.seq, given?.seq ?? 0),
        ),
      );
    const settle = verdict !== 'gaps' || Number(before?.n ?? 0) + 1 >= RUN_CHECK_LIMIT;
    const listed = gaps.map((gap) => `- ${gap}`).join('\n');
    const final =
      verdict === 'passes'
        ? proposal.body
        : verdict === 'gaps'
          ? `${proposal.body}\n\nWhat a separate check could not confirm:\n${listed}`
          : `${proposal.body}\n\nA separate check of this could not be finished${said ? `: ${clip(said, 300)}` : '.'}`;
    await this.write(tx, {
      run,
      step: row.id,
      kind: 'check',
      title:
        verdict === 'passes'
          ? 'The result checks out'
          : verdict === 'gaps'
            ? `The check found ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`
            : 'The check could not be finished',
      body: verdict === 'gaps' ? listed : clip(said, 4000),
      data: {
        verdict,
        gaps,
        settle,
        proposal: proposal.id,
        ...(settle ? { result: final } : {}),
      },
    });
  }

  /** The newest entry that says where the run's result stands, if any. */
  private async lastResult(tx: Transaction, run: string): Promise<Entry | undefined> {
    const [last] = await tx
      .select()
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run),
          inArray(runEntry.kind, RESULT_KINDS),
          or(eq(runEntry.kind, 'check'), isNull(runEntry.stepJobId)),
        ),
      )
      .orderBy(desc(runEntry.seq))
      .limit(1);
    return last;
  }

  /**
   * A run whose result has been through its check is given it now, by a
   * shift that only records it: no model call. Null when there is work to do.
   */
  async settle(tx: Transaction, row: JobRow, attemptId: string): Promise<AttemptOutcome | null> {
    if (row.kind !== 'run') return null;
    const last = await this.lastResult(tx, row.id);
    const data = object(last?.data);
    if (last?.kind !== 'check' || data.settle !== true || typeof data.result !== 'string')
      return null;
    const [proposal] =
      typeof data.proposal === 'string'
        ? await tx.select().from(runEntry).where(eq(runEntry.id, data.proposal))
        : [];
    await this.write(tx, {
      run: row.id,
      attemptId,
      kind: 'finished',
      title: clip(data.result.split('\n')[0] ?? data.result, 200),
      body: data.result,
      data: {
        ...object(proposal?.data),
        check: data.verdict === 'passes' ? 'passed' : 'not_confirmed',
        gaps: gapsOf(data),
      },
    });
    await tx.update(runState).set({ finishedAt: new Date() }).where(eq(runState.jobId, row.id));
    await this.reported(tx, row.id, row, 'Done', data.result, true);
    return { kind: 'completed', summary: data.result, evidence: [] };
  }

  /**
   * What an attempt lost after it gave its result stands for: that result,
   * not a retry. Null when it gave none, or an action of the work is still
   * under way and the loss has to be handled as one.
   */
  async recordedFinish(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
  ): Promise<AttemptOutcome | null> {
    const [given] = await tx
      .select()
      .from(runEntry)
      .where(
        and(
          eq(runEntry.attemptId, attemptId),
          inArray(runEntry.kind, ['proposed', 'finished']),
          row.kind === 'run_step' ? eq(runEntry.stepJobId, row.id) : isNull(runEntry.stepJobId),
        ),
      )
      .limit(1);
    if (!given) return null;
    const [pending] = await tx
      .select({ id: action.id })
      .from(action)
      .where(
        and(
          eq(action.jobId, row.id),
          inArray(action.status, [
            'needs_approval',
            'approved',
            'admitted',
            'dispatched',
            'unknown',
            'unresolved',
          ]),
        ),
      )
      .limit(1);
    if (pending) return null;
    return { kind: 'completed', summary: given.body, evidence: [] };
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
    const [view] = await this.views([row]);
    if (!view) throw missing();
    return view;
  }

  /** Views of several runs, read together: the same few queries however many there are. */
  async views(rows: JobRow[]): Promise<RunView[]> {
    if (!rows.length) return [];
    const ids = rows.map((entry) => entry.id);
    return this.jobs.transaction(async (tx) => {
      const states = new Map(
        (await tx.select().from(runState).where(inArray(runState.jobId, ids))).map((state) => [
          state.jobId,
          state,
        ]),
      );
      const latest = await tx
        .selectDistinctOn([runEntry.runJobId, runEntry.kind])
        .from(runEntry)
        .where(
          and(
            inArray(runEntry.runJobId, ids),
            inArray(runEntry.kind, ['plan', 'report', 'checkpoint', 'finished']),
            isNull(runEntry.stepJobId),
          ),
        )
        .orderBy(runEntry.runJobId, runEntry.kind, desc(runEntry.seq));
      const results = await tx
        .selectDistinctOn([runEntry.runJobId])
        .from(runEntry)
        .where(
          and(
            inArray(runEntry.runJobId, ids),
            inArray(runEntry.kind, RESULT_KINDS),
            or(eq(runEntry.kind, 'check'), isNull(runEntry.stepJobId)),
          ),
        )
        .orderBy(runEntry.runJobId, desc(runEntry.seq));
      const counts = await tx
        .select({
          run: runEntry.runJobId,
          kind: runEntry.kind,
          n: sql<number>`count(*)::int`,
        })
        .from(runEntry)
        .where(
          and(inArray(runEntry.runJobId, ids), inArray(runEntry.kind, ['experiment', 'finding'])),
        )
        .groupBy(runEntry.runJobId, runEntry.kind);
      // The ten newest tries of each run.
      const ranked = tx
        .select({
          id: runEntry.id,
          rank: sql<number>`row_number() over (partition by ${runEntry.runJobId} order by ${runEntry.seq} desc)`.as(
            'rank',
          ),
        })
        .from(runEntry)
        .where(and(inArray(runEntry.runJobId, ids), eq(runEntry.kind, 'experiment')))
        .as('ranked');
      const recent = await tx
        .select({ entry: runEntry })
        .from(runEntry)
        .innerJoin(ranked, eq(ranked.id, runEntry.id))
        .where(sql`${ranked.rank} <= 10`)
        .orderBy(desc(runEntry.seq));
      // The best try of each run, ordered as `bestExperiment` orders them:
      // checked first, then the better value in the run's direction, then newest.
      const best = await tx
        .selectDistinctOn([runEntry.runJobId], { entry: runEntry })
        .from(runEntry)
        .innerJoin(runState, eq(runState.jobId, runEntry.runJobId))
        .where(
          and(
            inArray(runEntry.runJobId, ids),
            eq(runEntry.kind, 'experiment'),
            sql`jsonb_typeof(${runEntry.data}->'value') = 'number'`,
            sql`coalesce(${runEntry.data}->>'outcome', '') <> 'failed'`,
          ),
        )
        .orderBy(
          runEntry.runJobId,
          sql`coalesce(${runEntry.data}->'checked' = 'true'::jsonb, false) desc`,
          sql`case when ${runState.metric}->>'direction' = 'lower'
            then (${runEntry.data}->>'value')::float8
            else -((${runEntry.data}->>'value')::float8) end`,
          desc(runEntry.seq),
        );
      const open = await tx
        .selectDistinctOn([question.jobId], { job: question.jobId, text: question.text })
        .from(question)
        .where(and(inArray(question.jobId, ids), eq(question.state, 'open')))
        .orderBy(question.jobId);
      const helpers = await stepsOfRuns(tx, ids);
      const views: RunView[] = [];
      for (const row of rows) {
        const state = states.get(row.id);
        if (!state) continue;
        const newest = (kind: string) =>
          latest.find((entry) => entry.runJobId === row.id && entry.kind === kind);
        const count = (kind: string) =>
          Number(counts.find((entry) => entry.run === row.id && entry.kind === kind)?.n ?? 0);
        const tries = recent
          .filter(({ entry }) => entry.runJobId === row.id)
          .map(({ entry }) => entry);
        const top = best.find(({ entry }) => entry.runJobId === row.id)?.entry ?? null;
        const steps = helpers.get(row.id) ?? [];
        const status = runStatusOf(row.state, row.paused);
        const metric = state.metric ?? null;
        const check = checkOf(
          state,
          results.find((entry) => entry.runJobId === row.id),
        );
        const wait = object(row.wait);
        const asked = open.find((entry) => entry.job === row.id)?.text;
        const question_ =
          asked ??
          (wait.kind === 'user_input' && typeof wait.question === 'string' ? wait.question : null);
        const report = newest('report');
        const handoff = newest('checkpoint');
        const finished = newest('finished');
        const plan = newest('plan');
        views.push(
          runView.parse({
            id: row.id,
            title: row.title,
            goal: state.goal,
            done_when: state.doneWhen,
            status,
            status_line: statusLine({
              status,
              paused: row.paused,
              experiments: count('experiment'),
              best: top ? object(top.data).value : undefined,
              metric: metric?.name,
              helpersWorking: steps.filter(
                (entry) => entry.status === 'working' || entry.status === 'waiting',
              ).length,
              waitingOnSteps: state.waitingOnSteps,
              nextWakeAt: row.state === 'waiting_for_event_or_time' ? row.nextWakeAt : null,
              question: question_,
              check: check.state,
            }),
            conversation_id: state.conversationId,
            agent_id: row.agentId,
            started_at: state.createdAt.toISOString(),
            finished_at:
              state.finishedAt?.toISOString() ??
              (isTerminal(row.state as JobState) ? row.updatedAt.toISOString() : null),
            next_shift_at:
              row.state === 'waiting_for_event_or_time'
                ? (row.nextWakeAt?.toISOString() ?? null)
                : null,
            shifts: state.shifts,
            metric,
            limit: state.limit ? runLimit.parse(state.limit) : null,
            plan: plan ? plan.body || plan.title : null,
            latest_report: report
              ? {
                  title: report.title,
                  body: report.body,
                  created_at: report.createdAt.toISOString(),
                }
              : null,
            next: handoff ? String(object(handoff.data).next ?? '') || null : null,
            result: finished?.body ?? null,
            experiments: {
              count: count('experiment'),
              best: top ? experimentView(top) : null,
              recent: tries.map(experimentView),
            },
            findings: count('finding'),
            steps,
            question: status === 'needs_you' ? question_ : null,
            check,
          }),
        );
      }
      return views;
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
    return { runs: await this.views(rows.map((entry) => entry.job)) };
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
      lines.push(
        `## ${entry.createdAt.toISOString()} · ${ENTRY_LABELS[entry.kind] ?? 'Note'}${by}: ${entry.title}`,
        '',
      );
      if (entry.body) lines.push(entry.body, '');
      const data = object(entry.data);
      if (entry.kind === 'experiment') {
        const facts = [
          typeof data.hypothesis === 'string' ? `Idea: ${data.hypothesis}` : null,
          typeof data.value === 'number' ? `Value: ${data.value}` : null,
          `Outcome: ${String(data.outcome ?? '')}`,
          `Confirmed from its output: ${data.checked === true ? 'yes' : 'no'}`,
          Array.isArray(data.evidence) && data.evidence.length
            ? `Evidence: ${data.evidence.join(', ')}`
            : null,
        ].filter(Boolean);
        lines.push(...facts.map((fact) => `- ${fact}`), '');
      }
      if (entry.kind === 'checkpoint' && typeof data.next === 'string')
        lines.push(`Next: ${data.next}`, '');
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
    // The run first: once it is fenced it cannot start another helper, so the
    // helpers read after it are all there are.
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
    await this.jobs.transaction(async (tx) => {
      for (const id of ids) {
        const locked = await this.jobs.lock(tx, id);
        if (!locked || isTerminal(locked.state as JobState)) continue;
        await tx.update(job).set({ paused, updatedAt: new Date() }).where(eq(job.id, id));
        if (!paused && ['queued', 'waiting_for_event_or_time'].includes(locked.state)) {
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
    });
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

  /** The person's settings for the work: a limit (null clears it) and whether results are checked. */
  async setLimit(row: JobRow, settings: { limit?: RunLimit | null; check_result?: boolean }) {
    const changes = {
      ...(settings.limit !== undefined
        ? { limit: settings.limit ? runLimit.parse(settings.limit) : null }
        : {}),
      ...(settings.check_result !== undefined ? { checkResult: settings.check_result } : {}),
    };
    if (!Object.keys(changes).length) return;
    await this.db.update(runState).set(changes).where(eq(runState.jobId, row.id));
  }
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
  proposed: 'Result given for checking',
  check: 'Checked',
  finished: 'Done',
};

function experimentView(entry: Entry) {
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
}

/** Where the check of the run's result stands, from the newest entry about its result. */
function checkOf(state: State, last: Entry | undefined): RunView['check'] {
  const enabled = state.checkResult && Boolean(state.doneWhen);
  const data = object(last?.data);
  if (last?.kind === 'proposed') return { enabled, state: 'checking', gaps: [] };
  if (last?.kind === 'check')
    return {
      enabled,
      state: data.settle !== true ? 'gaps' : data.verdict === 'passes' ? 'passed' : 'not_confirmed',
      gaps: gapsOf(data),
    };
  if (last?.kind === 'finished' && (data.check === 'passed' || data.check === 'not_confirmed'))
    return { enabled, state: data.check, gaps: gapsOf(data) };
  return { enabled, state: null, gaps: [] };
}

/**
 * What a run keeps from the job it came from: which sites it may read and
 * whether it stays out of private knowledge. Not a deliverable: that one was
 * the conversation's own.
 */
function carried(constraints: unknown) {
  const parsed = jobConstraints.safeParse(constraints ?? {});
  if (!parsed.success) return {};
  const { allowed_domains, public_compartment, notes }: JobConstraints = parsed.data;
  return { allowed_domains, public_compartment, ...(notes ? { notes } : {}) };
}

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
  check: RunView['check']['state'];
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
      return join(
        'Done',
        input.check === 'passed'
          ? 'checked'
          : input.check === 'not_confirmed'
            ? 'not fully confirmed'
            : null,
        tried,
      );
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'It could not go on';
    case 'needs_you':
      return input.question ? clip(input.question, 200) : 'Waiting for you';
    case 'working':
      return join(input.check === 'checking' ? 'Checking the result' : 'Working on it', tried);
    default:
      if (input.paused) return join('Paused', tried);
      if (input.check === 'checking') return join('Checking the result', tried);
      if (input.waitingOnSteps)
        return join(
          `Waiting for ${input.helpersWorking} helper${input.helpersWorking === 1 ? '' : 's'}`,
          tried,
        );
      if (input.nextWakeAt && input.nextWakeAt.getTime() - Date.now() < 60_000)
        return join('Working on it', tried);
      return join(input.nextWakeAt ? 'Picks up again later' : 'Waiting', tried);
  }
}

export { isRunKind };

/**
 * Puts long work on a runner: its shifts are decided here, and a helper's
 * end, however it ends, wakes its run.
 */
export function attachRuns(runner: AttemptRunner, runs: RunService) {
  runner.runs = runs;
  runner.onFinished.push((tx, row, outcome) => runs.stepEnded(tx, row, outcome));
  runs.jobs.cancelledInTransaction.push((tx, row) =>
    runs.stepEnded(tx, row, { kind: 'failed', retryable: false, reason: 'It was stopped.' }),
  );
}
