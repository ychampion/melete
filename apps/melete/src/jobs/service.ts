import {
  type CreateResponsibilityRequest,
  createResponsibilityRequest,
  type JobBudget,
  type JobConstraints,
  type JobState,
  type JsonObject,
  jobBudget,
  jobConstraints,
  responsibilityJob,
  schedulingClass,
  type TransitionInput,
  transition,
  type WaitSpec,
} from '@melete/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { databaseNow } from '../db/clock.ts';
import { attempt, job, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { registerJobLearning } from '../learning/episodes.ts';
import { type ObjectiveOrigin, recordedObjectiveOrigin } from '../learning/provenance.ts';
import { derivedScope } from '../learning/scope.ts';
import {
  requestPrincipal,
  requireJobAccess,
  spaceAuthority,
  visibleJob,
} from '../principals/authority.ts';
import { type AttemptWake, enqueueWake } from './queue.ts';

export type JobRow = typeof job.$inferSelect;
export const DEFAULT_BUDGET: JobBudget = {
  max_turns: 20,
  max_output_tokens: 8000,
  max_wall_ms: 120000,
  max_actions: 10,
  max_attempts: 5,
  max_usd_est: 1,
};

export function jobView(row: JobRow) {
  return responsibilityJob.parse({
    id: row.id,
    space_id: row.spaceId,
    principal_id: row.principalId,
    title: row.title,
    objective: row.objective,
    constraints: row.constraints,
    state: row.state,
    revision: row.revision,
    lease_epoch: row.leaseEpoch,
    next_wake_at: row.nextWakeAt?.toISOString() ?? null,
    wait: row.wait,
    substrate_disposition: row.substrateDisposition,
    scheduling_class: row.schedulingClass,
    importance: row.importance,
    unread_results: row.unreadResults,
    unread_threshold: row.unreadThreshold,
    cadence_multiplier: row.cadenceMultiplier,
    attention_status: row.attentionStatus,
    visible_status: row.attentionStatus === 'normal' ? row.state : row.attentionStatus,
    deferred_questions: row.deferredQuestions,
    budget: row.budget,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    state_version: row.stateVersion,
  });
}

export type TransitionOptions = {
  attemptId?: string;
  wait?: WaitSpec;
  payload?: JsonObject;
  reason?: AttemptWake['reason'];
  bumpEpoch?: boolean;
};

export type JobFaults = {
  /** Tests kill or throw here, after state/event writes and before enqueue. */
  afterTransitionBeforeEnqueue?: (tx: Transaction, row: JobRow) => Promise<void>;
};

export class JobService {
  onCancelled?: (id: string) => void;
  constructor(
    readonly db: Database,
    readonly boss: PgBoss,
    readonly faults: JobFaults = {},
  ) {}

  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return serviceTransaction(this.db, operation);
  }

  async lock(tx: Transaction, id: string, skipLocked = false): Promise<JobRow | undefined> {
    const [row] = await tx
      .select()
      .from(job)
      .where(eq(job.id, id))
      .for('update', skipLocked ? { skipLocked: true } : {});
    if (row && requestPrincipal()) await spaceAuthority(tx, row.spaceId, requestPrincipal(), true);
    return row;
  }

  async get(id: string): Promise<JobRow> {
    return requireJobAccess(this.db, id);
  }

  async list(filters: { space_id?: string; state?: string; limit: number }): Promise<JobRow[]> {
    return this.db
      .select()
      .from(job)
      .where(
        and(
          visibleJob(job.id),
          filters.space_id ? eq(job.spaceId, filters.space_id) : undefined,
          filters.state ? eq(job.state, filters.state) : undefined,
        ),
      )
      .orderBy(desc(job.createdAt), desc(job.id))
      .limit(filters.limit);
  }

  async create(input: CreateResponsibilityRequest): Promise<JobRow> {
    return this.transaction((tx) => this.createInTransaction(tx, input));
  }

  /** Submission admission composes its receipt with the same job/wake transaction. */
  async createInTransaction(
    tx: Transaction,
    input: CreateResponsibilityRequest,
    experience?: {
      kind: 'chat' | 'plan' | 'routine' | 'milestone';
      agentId?: string;
      planId?: string;
      scheduledAt?: Date;
      dormant?: boolean;
    },
    /**
     * Whose words this objective is, for a job that carries text written
     * somewhere else: a correction of another job, or an evaluation arm running a
     * variant. Left out, it is decided from how this job is being made.
     */
    objectiveOrigin?: ObjectiveOrigin,
  ): Promise<JobRow> {
    const value = createResponsibilityRequest.parse(input);
    const [parent] = await tx
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, value.space_id));
    if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);
    const access = await spaceAuthority(tx, value.space_id, requestPrincipal(), true);
    const [row] = await tx
      .insert(job)
      .values({
        id: newId('job'),
        spaceId: value.space_id,
        principalId: access.principalId,
        title: value.title,
        objective: value.objective,
        objectiveOrigin: objectiveOrigin ?? recordedObjectiveOrigin(experience ?? {}),
        constraints: jobConstraints.parse(value.constraints ?? {}),
        budget: jobBudget.parse({ ...DEFAULT_BUDGET, ...value.budget }),
        nextWakeAt:
          experience && (experience.dormant || ['chat', 'plan'].includes(experience.kind))
            ? null
            : (experience?.scheduledAt ?? (await databaseNow(tx))),
        ...(experience
          ? {
              kind: experience.kind,
              agentId: experience.agentId,
              planId: experience.planId,
              ...(experience.dormant || ['chat', 'plan'].includes(experience.kind)
                ? {
                    state: 'waiting_for_input',
                    wait: { kind: 'user_input', question: 'What would you like to do next?' },
                  }
                : experience.scheduledAt
                  ? {
                      state: 'waiting_for_event_or_time',
                      wait: { kind: 'timer', wake_at: experience.scheduledAt.toISOString() },
                    }
                  : {}),
            }
          : {}),
        schedulingClass: value.scheduling_class,
        importance: value.importance,
        unreadThreshold: value.unread_threshold,
      })
      .returning();
    if (!row) throw new Error('job insert returned no row');
    if (value.learning) await registerJobLearning(tx, row, value.learning);
    // A correction made on an ordinary request has to be able to teach something.
    else if (row.principalId && !jobConstraints.parse(row.constraints).public_compartment)
      await registerJobLearning(tx, row, derivedScope(row.objective));
    await appendEvent(tx, {
      jobId: row.id,
      type: 'job_created',
      payload: { title: row.title },
      dedupKey: `${row.id}:created`,
    });
    await this.enqueue(tx, row, 'created');
    return row;
  }

  async enqueue(tx: Transaction, row: JobRow, reason: AttemptWake['reason']): Promise<void> {
    if (!row.nextWakeAt) return;
    await enqueueWake(
      this.boss,
      tx,
      {
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason,
      },
      row.nextWakeAt,
      schedulingClass.parse(row.schedulingClass),
    );
  }

  /** The only production write to job.state, including cancellation and recovery. */
  async move(
    tx: Transaction,
    row: JobRow,
    input: TransitionInput,
    options: TransitionOptions = {},
  ): Promise<JobRow> {
    const result = transition(row.state as JobState, input);
    if (!result.ok) throw new ServiceError(result.error.code, result.error.message);
    if (result.value === 'queued' && row.state !== 'running') {
      const [used] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(attempt)
        .where(
          and(
            eq(attempt.jobId, row.id),
            ['chat', 'routine'].includes(row.kind)
              ? row.currentTurnId
                ? eq(attempt.turnId, row.currentTurnId)
                : sql`false`
              : undefined,
          ),
        );
      if (Number(used?.count ?? 0) >= jobBudget.parse(row.budget).max_attempts)
        throw new ServiceError('budget_exhausted', 'This job has used its attempt budget.');
    }
    let wait = options.wait ?? { kind: 'none' };
    const baseWakeAt =
      result.value === 'queued'
        ? await databaseNow(tx)
        : result.value === 'waiting_for_event_or_time' && wait.kind === 'timer'
          ? new Date(wait.wake_at)
          : result.value === 'waiting_for_event_or_time' &&
              wait.kind === 'event' &&
              wait.deadline_at
            ? new Date(wait.deadline_at)
            : null;
    const nextWakeAt =
      result.value === 'waiting_for_event_or_time' &&
      wait.kind === 'timer' &&
      baseWakeAt &&
      row.cadenceMultiplier > 1
        ? new Date(
            Date.now() + Math.max(0, baseWakeAt.getTime() - Date.now()) * row.cadenceMultiplier,
          )
        : baseWakeAt;
    if (wait.kind === 'timer' && nextWakeAt) wait = { ...wait, wake_at: nextWakeAt.toISOString() };
    const [updated] = await tx
      .update(job)
      .set({
        state: result.value,
        stateVersion: row.stateVersion + 1,
        leaseEpoch: row.leaseEpoch + (options.bumpEpoch || input.kind === 'cancelled' ? 1 : 0),
        wait,
        substrateDisposition:
          result.value === 'running' ? 'local_process_interrupted' : 'timer_or_event',
        nextWakeAt,
        attentionBaseWakeAt: baseWakeAt,
        updatedAt: new Date(),
      })
      .where(eq(job.id, row.id))
      .returning();
    if (!updated) throw new Error('locked job disappeared');
    await appendEvent(tx, {
      jobId: row.id,
      attemptId: options.attemptId,
      type: 'job_state_changed',
      payload: {
        from: row.state,
        to: updated.state,
        input: input.kind,
        state_version: updated.stateVersion,
        ...options.payload,
      },
      dedupKey: `${row.id}:transition:${updated.stateVersion}`,
    });
    await this.faults.afterTransitionBeforeEnqueue?.(tx, updated);
    await this.enqueue(tx, updated, options.reason ?? 'recovery');
    return updated;
  }

  async input(id: string, text: string): Promise<JobRow> {
    return this.transaction((tx) => this.inputInTransaction(tx, id, text));
  }

  async inputInTransaction(tx: Transaction, id: string, text: string): Promise<JobRow> {
    const row = await this.lock(tx, id);
    if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
    if (row.kind === 'chat' && (row.state === 'running' || row.state === 'queued' || row.paused))
      throw new ServiceError('turn_in_progress', 'Wait for this turn to finish.', 409);
    // A new conversation turn has its own attempt allowance. Earlier receipts remain durable.
    if (row.kind === 'chat') row.currentTurnId = null;
    const updated = await this.move(tx, row, { kind: 'user_input_received' }, { reason: 'input' });
    await appendEvent(tx, {
      jobId: id,
      type: 'notice',
      payload: { kind: 'user_message', text },
      dedupKey: `${id}:input:${updated.stateVersion}`,
    });
    return updated;
  }

  async cancel(id: string, reason?: string): Promise<JobRow> {
    const cancelled = await this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      const updated = await this.move(
        tx,
        row,
        { kind: 'cancelled' },
        { payload: { reason: reason ?? null } },
      );
      const interrupted = await tx
        .update(attempt)
        .set({
          outcome: 'fenced',
          outcomeDetail: { kind: 'cancelled', reason: reason ?? null },
          endedAt: new Date(),
          leaseExpiresAt: null,
          leaseStatus: 'ended',
        })
        .where(and(eq(attempt.jobId, id), isNull(attempt.endedAt)))
        .returning({ id: attempt.id });
      for (const execution of interrupted)
        await appendEvent(tx, {
          jobId: id,
          attemptId: execution.id,
          type: 'attempt_ended',
          payload: { kind: 'cancelled', reason: reason ?? null },
          dedupKey: `${execution.id}:ended`,
        });
      return updated;
    });
    // The fence commits before a potentially slow runtime is signalled.
    this.onCancelled?.(id);
    return cancelled;
  }

  /** Objective edits invalidate approval bindings even if the state is unchanged. */
  async revise(
    id: string,
    changes: { objective?: string; constraints?: JobConstraints },
  ): Promise<JobRow> {
    return this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      const constraints = changes.constraints
        ? jobConstraints.parse(changes.constraints)
        : row.constraints;
      const objective = changes.objective ?? row.objective;
      if (!objective.trim())
        throw new ServiceError('invalid_request', 'Objective cannot be empty.', 400);
      if (
        objective === row.objective &&
        JSON.stringify(constraints) === JSON.stringify(row.constraints)
      )
        return row;
      const [updated] = await tx
        .update(job)
        .set({ objective, constraints, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(job.id, id))
        .returning();
      if (!updated) throw new Error('locked job disappeared');
      await appendEvent(tx, {
        jobId: id,
        type: 'notice',
        payload: { kind: 'job_revised', revision: updated.revision },
        dedupKey: `${id}:revision:${updated.revision}`,
      });
      return updated;
    });
  }
}
