import {
  type AttemptOutcome,
  attemptOutcome,
  attemptUsage,
  type CapabilityClaims,
  type CommittedOutcome,
  type ContextAwareRuntimeAdapter,
  type ContextInvalidated,
  dedupKey,
  isOutcomeEnvelope,
  isTerminal,
  type JobState,
  type JsonObject,
  jobBudget,
  type QuestioningRuntimeAdapter,
  type QuestionSpec,
  type ResponsibilityAttemptBundle,
  type RuntimeAdapter,
  type RuntimeEvent,
  responsibilityAttemptOutcome,
  runtimeEvent,
  type SchedulingClass,
  type TransitionInput,
  unavailable,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { attempt, event, experienceTurn, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { type AttemptResult, attemptResult } from './attention.ts';
import { buildBundle, completionFacts } from './bundle.ts';
import { CAPABILITY_TTL_SECONDS, signCapability } from './capability.ts';
import { FairScheduler } from './fair-scheduler.ts';
import { requireCurrentAttempt } from './fence.ts';
import { readGenerations, requireGenerations } from './generations.ts';
import { persistQuestions, resolveQuestions } from './questions.ts';
import {
  ATTEMPT_QUEUES,
  type AttemptWake,
  attemptQueue,
  QUEUES,
  RECOVERY_SCAN_SECONDS,
} from './queue.ts';
import type { JobRow, JobService } from './service.ts';

export const HEARTBEAT_MS = 15_000;
export const LEASE_MS = 45_000;

export type RunnerOptions = {
  key: string;
  provider?: string;
  model?: string;
  scopes?: string[];
  heartbeatMs?: number;
  leaseMs?: number;
};
export type ClaimedAttempt = { bundle: ResponsibilityAttemptBundle; claims: CapabilityClaims };
/** What the attempt raised besides its outcome, handed to every finish handler. */
export type OutcomeContext = {
  questions: readonly QuestionSpec[];
  result: AttemptResult | null;
};

class AttemptBudgetExceeded extends Error {}

/** An adapter invocation is disposable; every decision around it is a short database transaction. */
export class AttemptRunner {
  private readonly active = new Map<
    string,
    { jobId: string; attemptId: string; controller: AbortController; done: Promise<void> }
  >();
  private workerStarted = false;
  private stopping = false;
  scheduler = new FairScheduler(2);
  private readonly wakes = new Set<Promise<void>>();
  /** Wait registration is supplied by the trigger service, inside the outcome transaction. */
  onWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  onApprovalWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  afterRecovery?: () => Promise<void>;
  readonly onFinished: Array<
    (
      tx: Transaction,
      row: JobRow,
      outcome: AttemptOutcome,
      attemptId: string,
      context: OutcomeContext,
    ) => Promise<void>
  > = [];

  constructor(
    readonly jobs: JobService,
    readonly runtime: RuntimeAdapter | QuestioningRuntimeAdapter,
    readonly options: RunnerOptions,
  ) {
    if (Buffer.byteLength(options.key) < 32)
      throw new Error('MELETE_CAPABILITY_KEY must be at least 32 bytes');
    jobs.onCancelled = (id) => this.interrupt(id);
  }

  private get leaseMs() {
    return this.options.leaseMs ?? LEASE_MS;
  }

  async claim(wake: AttemptWake): Promise<ClaimedAttempt | null> {
    const capabilities = await this.runtime.capabilities();
    return this.jobs.transaction(async (tx) => {
      let row = await this.jobs.lock(tx, wake.job_id, true);
      if (
        !row ||
        row.paused ||
        row.leaseEpoch !== wake.expected_epoch ||
        row.stateVersion !== wake.expected_version ||
        !row.nextWakeAt ||
        row.nextWakeAt.getTime() > Date.now()
      )
        return null;
      if (row.state === 'waiting_for_event_or_time') {
        row = await this.jobs.move(tx, row, { kind: 'timer_fired' }, { reason: 'timer' });
      }
      if (row.state !== 'queued') return null;
      const budget = jobBudget.parse(row.budget);
      const [previous] = await tx
        .select()
        .from(attempt)
        .where(eq(attempt.jobId, row.id))
        .orderBy(desc(attempt.epoch))
        .limit(1);
      const [latest] = await tx
        .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)::bigint` })
        .from(event)
        .where(eq(event.jobId, row.id));
      const attemptId = newId('att');
      const epoch = row.leaseEpoch + 1;
      const claims: CapabilityClaims = {
        job_id: row.id,
        attempt_id: attemptId,
        space_id: row.spaceId,
        epoch,
        revision: row.revision,
        scopes: this.options.scopes ?? [],
        budget: {
          max_actions: budget.max_actions,
          max_output_tokens: budget.max_output_tokens,
          max_usd_est: budget.max_usd_est,
        },
        exp: Math.floor(Date.now() / 1000) + CAPABILITY_TTL_SECONDS,
      };
      const model = {
        provider: this.options.provider ?? 'stub',
        model: this.options.model ?? 'script',
        fallback: null,
      };
      const generations = await readGenerations(tx, row.spaceId);
      const bundle = await buildBundle(
        tx,
        row,
        {
          id: attemptId,
          epoch,
          revision: row.revision,
          token: signCapability(claims, this.options.key),
        },
        model,
        previous?.inputCursor ?? 0,
        generations,
      );
      await tx.insert(attempt).values({
        id: attemptId,
        jobId: row.id,
        epoch,
        turnId: row.currentTurnId,
        revision: row.revision,
        policyGeneration: generations.policy_generation,
        connectionGenerations: generations.connection_generations,
        runtimeVersion: capabilities.version,
        provider: model.provider,
        model: model.model,
        usage: attemptUsage.parse({}),
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
        inputCursor: Number(latest?.seq ?? 0),
      });
      row = await this.jobs.move(
        tx,
        row,
        { kind: 'attempt_started' },
        { attemptId, bumpEpoch: true },
      );
      await appendEvent(tx, {
        jobId: row.id,
        attemptId,
        type: 'attempt_started',
        payload: { epoch, revision: row.revision },
        dedupKey: `${attemptId}:started`,
      });
      if (row.currentTurnId)
        await tx
          .update(experienceTurn)
          .set({ status: 'working' })
          .where(eq(experienceTurn.id, row.currentTurnId));
      return { bundle, claims };
    });
  }

  async heartbeat(claims: CapabilityClaims): Promise<boolean> {
    return this.jobs.transaction(async (tx) => {
      try {
        await requireCurrentAttempt(tx, claims);
      } catch (error) {
        if (error instanceof ServiceError) return false;
        throw error;
      }
      await tx
        .update(attempt)
        .set({ leaseExpiresAt: new Date(Date.now() + this.leaseMs) })
        .where(eq(attempt.id, claims.attempt_id));
      return true;
    });
  }

  async emit(claims: CapabilityClaims, input: RuntimeEvent): Promise<void> {
    const value = runtimeEvent.parse(input);
    if (
      value.attempt_id !== claims.attempt_id ||
      value.dedup_key !== dedupKey(claims.attempt_id, value.local_seq)
    )
      throw new ServiceError(
        'invalid_event',
        'Runtime event identity does not match this attempt.',
        400,
      );
    await this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, claims.job_id);
      const [execution] = await tx.select().from(attempt).where(eq(attempt.id, claims.attempt_id));
      if (!row || !execution || execution.jobId !== row.id)
        throw new ServiceError('stale_epoch', 'Attempt not found.');
      const [duplicate] = await tx.select().from(event).where(eq(event.dedupKey, value.dedup_key));
      if (duplicate) return;
      let current = true;
      try {
        await requireCurrentAttempt(tx, claims);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        current = false;
        if (value.type !== 'tool_result') throw error;
      }
      if (!current && value.type === 'tool_result') {
        const [proposal] = await tx
          .select({ seq: event.seq })
          .from(event)
          .where(
            and(
              eq(event.attemptId, execution.id),
              eq(event.type, 'tool_call_proposed'),
              sql`${event.payload}->>'call_id' = ${value.call_id}`,
            ),
          )
          .limit(1);
        if (!proposal)
          throw new ServiceError('stale_epoch', 'An old attempt cannot create a new tool result.');
        await appendEvent(tx, {
          jobId: row.id,
          attemptId: execution.id,
          type: 'notice',
          payload: { kind: 'receipt', late: true, call_id: value.call_id, result: value.result },
          dedupKey: `${value.dedup_key}:receipt`,
        });
      }
      if (value.local_seq <= execution.runtimeCursor)
        throw new ServiceError('invalid_event', 'Runtime events arrived out of order.', 400);
      if (value.local_seq > execution.runtimeCursor + 1) {
        await this.gap(
          tx,
          execution.id,
          row.id,
          `stream:${execution.runtimeCursor + 1}:${value.local_seq}`,
          { from_local_seq: execution.runtimeCursor + 1, to_local_seq: value.local_seq - 1 },
        );
      }
      if (value.type === 'turn_started' && current) {
        const [counts] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(event)
          .where(and(eq(event.attemptId, execution.id), eq(event.type, 'turn_started')));
        if (Number(counts?.n ?? 0) >= jobBudget.parse(row.budget).max_turns)
          throw new AttemptBudgetExceeded('The attempt turn budget is exhausted.');
      }
      if (
        value.type === 'attempt_outcome' &&
        value.usage &&
        value.usage.output_tokens > jobBudget.parse(row.budget).max_output_tokens
      )
        throw new AttemptBudgetExceeded('The attempt output-token budget is exhausted.');
      const type = value.type === 'attempt_outcome' ? 'notice' : value.type;
      if (current && row.currentTurnId && value.type === 'text_delta') {
        await tx
          .update(experienceTurn)
          .set({ answer: sql`${experienceTurn.answer} || ${value.text}`, status: 'streaming' })
          .where(eq(experienceTurn.id, row.currentTurnId));
      }
      const payload: JsonObject =
        value.type === 'attempt_outcome'
          ? { ...value, kind: 'attempt_outcome' }
          : { ...value, late: !current };
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: execution.id,
        type,
        payload,
        dedupKey: value.dedup_key,
      });
      await tx
        .update(attempt)
        .set({
          runtimeCursor: value.local_seq,
          ...(value.type === 'attempt_outcome' && value.usage ? { usage: value.usage } : {}),
        })
        .where(eq(attempt.id, execution.id));
    });
  }

  private async gap(
    tx: Transaction,
    attemptId: string,
    jobId: string,
    key: string,
    detail: JsonObject = {},
  ) {
    await appendEvent(tx, {
      jobId,
      attemptId,
      type: 'notice',
      payload: { kind: 'gap', reason: 'runtime_interrupted', ...detail },
      dedupKey: `${attemptId}:gap:${key}`,
    });
  }

  /**
   * An outcome alone, or an outcome with the questions the attempt wanted to
   * ask. A runtime that knows nothing about questions commits exactly what it
   * always did.
   */
  async commitOutcome(claims: CapabilityClaims, input: CommittedOutcome): Promise<JobRow> {
    const envelope = isOutcomeEnvelope(input)
      ? responsibilityAttemptOutcome.parse(input)
      : { outcome: attemptOutcome.parse(input), questions: [] as QuestionSpec[] };
    return this.jobs.transaction(async (tx) => {
      const active = await requireCurrentAttempt(tx, claims);
      return this.finish(tx, active.job, claims.attempt_id, envelope.outcome, envelope.questions);
    });
  }

  private async finish(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    original: AttemptOutcome,
    carried: readonly QuestionSpec[] = [],
  ): Promise<JobRow> {
    const [counts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempt)
      .where(
        and(
          eq(attempt.jobId, row.id),
          row.kind === 'chat' && row.currentTurnId
            ? eq(attempt.turnId, row.currentTurnId)
            : undefined,
        ),
      );
    const remaining = Math.max(
      0,
      jobBudget.parse(row.budget).max_attempts - Number(counts?.n ?? 0),
    );
    const outcome: AttemptOutcome =
      remaining === 0 && original.kind.startsWith('waiting_')
        ? { kind: 'budget_exhausted', summary: 'The job has used its attempt budget.' }
        : original;
    let input: TransitionInput;
    let wait: WaitSpec = { kind: 'none' };
    switch (outcome.kind) {
      case 'completed':
        input = { kind: 'attempt_completed', ...(await completionFacts(tx, row, outcome)) };
        break;
      case 'waiting_for_input':
        input = { kind: 'attempt_waiting_for_input' };
        wait = { kind: 'user_input', question: outcome.question };
        break;
      case 'waiting_for_approval':
        input = { kind: 'attempt_waiting_for_approval' };
        wait = { kind: 'approval', action_ids: outcome.action_ids };
        break;
      case 'waiting_for_event_or_time':
        input = { kind: 'attempt_waiting_for_event_or_time' };
        wait = waitSpec.parse(outcome.wait);
        if (wait.kind !== 'timer' && wait.kind !== 'event')
          throw new ServiceError('invalid_wait', 'Event/time waits must name a timer or trigger.');
        break;
      case 'failed':
        input = {
          kind: 'attempt_failed',
          retryable: outcome.retryable,
          attempts_remaining: remaining,
        };
        break;
      case 'budget_exhausted':
        input = { kind: 'attempt_budget_exhausted' };
        break;
    }
    const chatComplete =
      row.kind === 'chat' &&
      outcome.kind === 'completed' &&
      input.kind === 'attempt_completed' &&
      !input.has_unknown_action &&
      input.all_actions_terminal &&
      (!input.deliverable_declared || input.deliverable_satisfied);
    if (chatComplete) {
      input = { kind: 'attempt_waiting_for_input' };
      wait = { kind: 'user_input', question: 'What would you like to do next?' };
    }
    if (
      outcome.kind === 'completed' &&
      input.kind === 'attempt_completed' &&
      input.deliverable_declared &&
      !input.deliverable_satisfied &&
      !input.has_unknown_action
    )
      wait = {
        kind: 'user_input',
        question: 'The declared deliverable has no verified evidence. What should happen next?',
      };
    // Deciding the question before the move lets the wait name the one asked.
    const resolution = await resolveQuestions(tx, row, {
      attemptId,
      carried,
      askable: wait.kind === 'user_input' && !chatComplete,
      fallback: wait.kind === 'user_input' && !chatComplete ? wait.question : undefined,
    });
    if (resolution.asked && wait.kind === 'user_input')
      wait = { kind: 'user_input', question: resolution.asked.text };
    let updated = await this.jobs.move(tx, row, input, { attemptId, wait, payload: { outcome } });
    await tx
      .update(attempt)
      .set({
        outcome: outcome.kind,
        outcomeDetail: carried.length ? { ...outcome, questions: carried } : outcome,
        endedAt: new Date(),
        leaseStatus: 'ended',
        leaseExpiresAt: null,
      })
      .where(eq(attempt.id, attemptId));
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'attempt_ended',
      payload: { outcome },
      dedupKey: `${attemptId}:ended`,
    });
    if (updated.state === 'waiting_for_event_or_time' && this.onWait)
      updated = await this.onWait(tx, updated);
    if (updated.state === 'waiting_for_approval' && this.onApprovalWait)
      updated = await this.onApprovalWait(tx, updated);
    await persistQuestions(tx, updated, resolution, attemptId);
    updated = {
      ...updated,
      deferredQuestions: isTerminal(updated.state as JobState) ? [] : resolution.deferred,
    };
    // One reading of "is this news", shared by the attention counters and the outbox.
    const result = await attemptResult(tx, row, outcome, attemptId);
    for (const handler of this.onFinished)
      await handler(tx, updated, outcome, attemptId, { questions: carried, result });
    if (row.currentTurnId)
      await tx
        .update(experienceTurn)
        .set({
          status:
            outcome.kind === 'completed'
              ? 'done'
              : outcome.kind === 'failed' || outcome.kind === 'budget_exhausted'
                ? 'failed'
                : 'needs_you',
          ...('summary' in outcome
            ? { answer: outcome.summary }
            : outcome.kind === 'waiting_for_input' && outcome.draft
              ? { answer: outcome.draft }
              : {}),
          finishedAt: new Date(),
        })
        .where(eq(experienceTurn.id, row.currentTurnId));
    return updated;
  }

  /** Stop fences new effects before signalling the adapter, and retains each streamed byte. */
  async stopConversation(jobId: string): Promise<void> {
    await this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, jobId);
      if (row?.kind !== 'chat') throw new ServiceError('not_found', 'Conversation not found.', 404);
      if (!row.currentTurnId) return;
      const [turn] = await tx
        .select()
        .from(experienceTurn)
        .where(eq(experienceTurn.id, row.currentTurnId));
      if (!turn || ['done', 'stopped', 'failed'].includes(turn.status)) return;
      await tx
        .update(job)
        .set({
          state: 'waiting_for_input',
          wait: { kind: 'user_input', question: 'What would you like to do next?' },
          leaseEpoch: row.leaseEpoch + 1,
          stateVersion: row.stateVersion + 1,
          nextWakeAt: null,
          paused: false,
          pauseRequested: false,
        })
        .where(eq(job.id, row.id));
      await tx
        .update(experienceTurn)
        .set({ status: 'stopped', finishedAt: new Date() })
        .where(eq(experienceTurn.id, turn.id));
      await tx
        .update(attempt)
        .set({
          outcome: 'fenced',
          outcomeDetail: { kind: 'cancelled' },
          endedAt: new Date(),
          leaseExpiresAt: null,
          leaseStatus: 'ended',
        })
        .where(and(eq(attempt.jobId, jobId), isNull(attempt.endedAt)));
      await appendEvent(tx, {
        jobId,
        type: 'notice',
        payload: { kind: 'experience_stopped', turn_id: turn.id },
        dedupKey: `${turn.id}:stopped`,
      });
    });
    this.interrupt(jobId);
  }

  async pauseConversation(jobId: string, resume: boolean) {
    const row = await this.jobs.get(jobId);
    if (row.kind !== 'chat') throw new ServiceError('not_found', 'Conversation not found.', 404);
    const controls = this.runtime as RuntimeAdapter & {
      pause?: (id: string) => Promise<boolean>;
      resume?: (id: string) => Promise<boolean>;
    };
    if (row.state === 'running' && (!controls.pause || !controls.resume))
      return unavailable(
        'This assistant cannot pause and keep its place yet. You can stop this turn.',
      );
    if (!['queued', 'running'].includes(row.state))
      return unavailable('There is no active task to pause.');
    const [active] = await this.jobs.db
      .select()
      .from(attempt)
      .where(and(eq(attempt.jobId, jobId), isNull(attempt.endedAt)))
      .limit(1);
    if (active) {
      const accepted = resume
        ? await controls.resume?.(active.id)
        : await controls.pause?.(active.id);
      if (!accepted) return unavailable('The assistant could not keep its place.');
    }
    await this.jobs.transaction(async (tx) => {
      const current = await this.jobs.lock(tx, jobId);
      if (!current || current.leaseEpoch !== row.leaseEpoch)
        throw new ServiceError('state_changed', 'This turn has changed. Refresh it.', 409);
      const [updated] = await tx
        .update(job)
        .set({ paused: !resume, pauseRequested: !resume })
        .where(eq(job.id, jobId))
        .returning();
      await appendEvent(tx, {
        jobId,
        type: 'notice',
        payload: {
          kind: resume ? 'experience_resumed' : 'experience_paused',
          turn_id: row.currentTurnId,
        },
        dedupKey: newId('pause'),
      });
      if (resume && updated?.state === 'queued') await this.jobs.enqueue(tx, updated, 'input');
    });
    return null;
  }

  async loseAttempt(attemptId: string, reason: string): Promise<boolean> {
    return this.jobs.transaction(async (tx) => {
      const [execution] = await tx.select().from(attempt).where(eq(attempt.id, attemptId));
      if (!execution || execution.endedAt) return false;
      const row = await this.jobs.lock(tx, execution.jobId);
      if (!row || row.leaseEpoch !== execution.epoch || row.state !== 'running') return false;
      return this.lose(tx, row, attemptId, reason);
    });
  }

  private async lose(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    reason: string,
  ): Promise<boolean> {
    const [counts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempt)
      .where(eq(attempt.jobId, row.id));
    await tx
      .update(attempt)
      .set({
        outcome: 'fenced',
        outcomeDetail: { kind: 'lost', reason },
        endedAt: new Date(),
        leaseStatus: 'lost',
        leaseExpiresAt: null,
      })
      .where(eq(attempt.id, attemptId));
    await this.gap(tx, attemptId, row.id, 'lost');
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'attempt_ended',
      payload: { kind: 'lost', reason },
      dedupKey: `${attemptId}:ended`,
    });
    await this.jobs.move(
      tx,
      row,
      {
        kind: 'attempt_failed',
        retryable: true,
        attempts_remaining: Math.max(
          0,
          jobBudget.parse(row.budget).max_attempts - Number(counts?.n ?? 0),
        ),
      },
      { attemptId, reason: 'recovery' },
    );
    return true;
  }

  async recover(): Promise<void> {
    const expired = await this.jobs.db
      .select({ id: attempt.id, jobId: attempt.jobId })
      .from(attempt)
      .where(and(isNull(attempt.endedAt), lte(attempt.leaseExpiresAt, new Date())));
    for (const candidate of expired) {
      const fenced = await this.jobs
        .transaction(async (tx) => {
          const row = await this.jobs.lock(tx, candidate.jobId, true);
          const [execution] = await tx.select().from(attempt).where(eq(attempt.id, candidate.id));
          if (
            !row ||
            !execution ||
            execution.endedAt ||
            !execution.leaseExpiresAt ||
            execution.leaseExpiresAt.getTime() > Date.now() ||
            row.state !== 'running' ||
            row.leaseEpoch !== execution.epoch
          )
            return false;
          const [committed] = await tx
            .select()
            .from(event)
            .where(
              and(
                eq(event.attemptId, execution.id),
                eq(event.type, 'notice'),
                sql`${event.payload}->>'kind' = 'attempt_outcome'`,
              ),
            )
            .orderBy(desc(event.seq))
            .limit(1);
          const parsed = attemptOutcome.safeParse(
            (committed?.payload as JsonObject | undefined)?.outcome,
          );
          await requireGenerations(tx, row.spaceId, {
            policy_generation: execution.policyGeneration,
            connection_generations: execution.connectionGenerations,
          });
          if (parsed.success && execution.revision === row.revision)
            await this.finish(tx, row, execution.id, parsed.data);
          else await this.lose(tx, row, execution.id, 'lease_expired');
          return true;
        })
        .catch(async (error: unknown) => {
          // A rejected persisted outcome must not starve the remaining recovery candidates.
          if (!(error instanceof ServiceError)) throw error;
          return this.loseAttempt(candidate.id, error.code);
        });
      if (fenced) this.interrupt(candidate.jobId, candidate.id);
    }
    const due = await this.jobs.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          inArray(job.state, ['queued', 'waiting_for_event_or_time']),
          lte(job.nextWakeAt, new Date()),
        ),
      );
    for (const candidate of due) {
      await this.jobs.transaction(async (tx) => {
        const row = await this.jobs.lock(tx, candidate.id, true);
        if (
          !row?.nextWakeAt ||
          row.nextWakeAt.getTime() > Date.now() ||
          !['queued', 'waiting_for_event_or_time'].includes(row.state)
        )
          return;
        const live = await tx.execute(
          sql`select id from pgboss.job where name = ${attemptQueue(row.schedulingClass)} and state in ('created', 'retry', 'active') and data->>'job_id' = ${row.id} and (data->>'expected_epoch')::int = ${row.leaseEpoch} and (data->>'expected_version')::int = ${row.stateVersion} limit 1`,
        );
        if (live.length === 0) await this.jobs.enqueue(tx, row, 'recovery');
      });
    }
    await this.afterRecovery?.();
  }

  interrupt(jobId: string, attemptId?: string): void {
    for (const active of this.active.values())
      if (active.jobId === jobId && (!attemptId || active.attemptId === attemptId))
        active.controller.abort(new Error('Attempt interrupted'));
  }

  async invalidateContext(control: ContextInvalidated): Promise<void> {
    const active = this.active.get(control.attempt_id);
    if (active?.jobId === control.job_id) active.controller.abort(control);
    try {
      await (this.runtime as ContextAwareRuntimeAdapter).contextInvalidated?.(control);
    } catch {
      process.stderr.write(
        `runtime context invalidation acknowledgement failed for ${control.attempt_id}\n`,
      );
    }
  }

  handleWake(wake: AttemptWake): Promise<void> {
    const pending = this.runWake(wake);
    this.wakes.add(pending);
    return pending.finally(() => this.wakes.delete(pending));
  }

  private async runWake(wake: AttemptWake): Promise<void> {
    if (this.stopping) return;
    const claim = await this.claim(wake);
    if (!claim) return;
    const { bundle, claims } = claim;
    if (this.stopping) {
      await this.loseAttempt(claims.attempt_id, 'service_stopping');
      return;
    }
    const controller = new AbortController();
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    // A replacement can start between a fence commit and delivery of its predecessor's abort.
    this.active.set(claims.attempt_id, {
      jobId: claims.job_id,
      attemptId: claims.attempt_id,
      controller,
      done,
    });
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.heartbeat(claims)
        .then((current) => {
          if (!current) controller.abort(new Error('Lease lost'));
        })
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const wallLimit = new Promise<AttemptOutcome>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort(new AttemptBudgetExceeded('The attempt wall-time budget is exhausted.'));
          resolve({
            kind: 'budget_exhausted',
            summary: 'The attempt wall-time budget is exhausted.',
          });
        }, bundle.budget.max_wall_ms);
      });
      const result = await Promise.race([
        this.runtime.start(
          bundle,
          { emit: (event) => this.emit(claims, event) },
          controller.signal,
        ),
        wallLimit,
        interrupted,
      ]);
      await this.commitOutcome(claims, result);
    } catch (error) {
      if (error instanceof AttemptBudgetExceeded) {
        await this.commitOutcome(claims, {
          kind: 'budget_exhausted',
          summary: error.message,
        }).catch(async (failure: unknown) => {
          if (!(failure instanceof ServiceError)) throw failure;
        });
      } else if (
        !(
          error instanceof ServiceError && ['stale_epoch', 'revision_mismatch'].includes(error.code)
        )
      ) {
        await this.loseAttempt(
          claims.attempt_id,
          error instanceof Error ? error.message : 'runtime_crashed',
        );
      }
    } finally {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortListener);
      if (this.active.get(claims.attempt_id)?.controller === controller)
        this.active.delete(claims.attempt_id);
      finished();
    }
  }

  async start(): Promise<void> {
    if (this.workerStarted) return;
    this.workerStarted = true;
    this.stopping = false;
    this.scheduler = new FairScheduler(2);
    await this.recover();
    for (const [scheduling, queue] of Object.entries(ATTEMPT_QUEUES))
      await this.jobs.boss.work<AttemptWake>(
        queue,
        { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 0.5 },
        async (wakes) => {
          for (const wake of wakes)
            await this.scheduledWake(scheduling as SchedulingClass, wake.data);
        },
      );
    // Existing queued hints can drain after an upgrade; all new and recovered hints use the persisted class.
    await this.jobs.boss.work<AttemptWake>(
      QUEUES.legacyAttempt,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.scheduledWake('interactive', wake.data);
      },
    );
    await this.jobs.boss.work(
      QUEUES.recoveryScan,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async () => this.recover(),
    );
    await this.jobs.boss.schedule(QUEUES.recoveryScan, '* * * * *', {
      interval_seconds: RECOVERY_SCAN_SECONDS,
    });
  }

  private async scheduledWake(scheduling: SchedulingClass, wake: AttemptWake) {
    try {
      await this.scheduler.run(scheduling, () => this.handleWake(wake));
    } catch (error) {
      if (!this.stopping) throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.scheduler.close();
    const active = [...this.active.values()];
    for (const { controller } of active) controller.abort(new Error('Service stopping'));
    if (this.workerStarted) {
      for (const name of [...Object.values(ATTEMPT_QUEUES), QUEUES.legacyAttempt])
        await this.jobs.boss.offWork(name, { wait: false });
      await this.jobs.boss.offWork(QUEUES.recoveryScan, { wait: false });
      this.workerStarted = false;
    }
    await Promise.all(active.map(({ done }) => done));
    await Promise.allSettled([...this.wakes]);
    await this.scheduler.idle();
  }
}
