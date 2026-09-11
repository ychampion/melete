import {
  type AttemptOutcome,
  attemptOutcome,
  attemptUsage,
  type CapabilityClaims,
  type ContextAwareRuntimeAdapter,
  type ContextInvalidated,
  dedupKey,
  type JsonObject,
  jobBudget,
  type ResponsibilityAttemptBundle,
  type RuntimeAdapter,
  type RuntimeEvent,
  runtimeEvent,
  type TransitionInput,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { attempt, event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { buildBundle, completionFacts } from './bundle.ts';
import { CAPABILITY_TTL_SECONDS, signCapability } from './capability.ts';
import { requireCurrentAttempt } from './fence.ts';
import { readGenerations, requireGenerations } from './generations.ts';
import { type AttemptWake, QUEUES, RECOVERY_SCAN_SECONDS } from './queue.ts';
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

class AttemptBudgetExceeded extends Error {}

/** An adapter invocation is disposable; every decision around it is a short database transaction. */
export class AttemptRunner {
  private readonly active = new Map<
    string,
    { jobId: string; attemptId: string; controller: AbortController; done: Promise<void> }
  >();
  private workerStarted = false;
  /** Wait registration is supplied by the trigger service, inside the outcome transaction. */
  onWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  onApprovalWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  afterRecovery?: () => Promise<void>;
  readonly onFinished: Array<
    (tx: Transaction, row: JobRow, outcome: AttemptOutcome, attemptId: string) => Promise<void>
  > = [];

  constructor(
    readonly jobs: JobService,
    readonly runtime: RuntimeAdapter,
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

  async commitOutcome(claims: CapabilityClaims, input: AttemptOutcome): Promise<JobRow> {
    const outcome = attemptOutcome.parse(input);
    return this.jobs.transaction(async (tx) => {
      const active = await requireCurrentAttempt(tx, claims);
      return this.finish(tx, active.job, claims.attempt_id, outcome);
    });
  }

  private async finish(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    original: AttemptOutcome,
  ): Promise<JobRow> {
    const [counts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempt)
      .where(eq(attempt.jobId, row.id));
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
    let updated = await this.jobs.move(tx, row, input, { attemptId, wait, payload: { outcome } });
    await tx
      .update(attempt)
      .set({
        outcome: outcome.kind,
        outcomeDetail: outcome,
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
    for (const handler of this.onFinished) await handler(tx, updated, outcome, attemptId);
    return updated;
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
          sql`select id from pgboss.job where name = ${QUEUES.attempt} and state in ('created', 'retry', 'active') and data->>'job_id' = ${row.id} and (data->>'expected_epoch')::int = ${row.leaseEpoch} and (data->>'expected_version')::int = ${row.stateVersion} limit 1`,
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

  async handleWake(wake: AttemptWake): Promise<void> {
    const claim = await this.claim(wake);
    if (!claim) return;
    const { bundle, claims } = claim;
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
    await this.recover();
    await this.jobs.boss.work<AttemptWake>(
      QUEUES.attempt,
      { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.handleWake(wake.data);
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

  async stop(): Promise<void> {
    const active = [...this.active.values()];
    for (const { controller } of active) controller.abort(new Error('Service stopping'));
    if (this.workerStarted) {
      await this.jobs.boss.offWork(QUEUES.attempt, { wait: false });
      await this.jobs.boss.offWork(QUEUES.recoveryScan, { wait: false });
      this.workerStarted = false;
    }
    await Promise.all(active.map(({ done }) => done));
  }
}
