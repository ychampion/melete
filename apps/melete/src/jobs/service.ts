import {
  type CreateJobRequest,
  createJobRequest,
  type Job,
  type JobBudget,
  type JobConstraints,
  type JobState,
  type JsonObject,
  jobBudget,
  jobConstraints,
  job as jobContract,
  type TransitionInput,
  transition,
  type WaitSpec,
} from '@melete/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { job, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
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

export function jobView(row: JobRow): Job {
  return jobContract.parse({
    id: row.id,
    space_id: row.spaceId,
    title: row.title,
    objective: row.objective,
    constraints: row.constraints,
    state: row.state,
    revision: row.revision,
    lease_epoch: row.leaseEpoch,
    next_wake_at: row.nextWakeAt?.toISOString() ?? null,
    wait: row.wait,
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
    return row;
  }

  async get(id: string): Promise<JobRow> {
    const [row] = await this.db.select().from(job).where(eq(job.id, id));
    if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
    return row;
  }

  async list(filters: { space_id?: string; state?: string; limit: number }): Promise<JobRow[]> {
    return this.db
      .select()
      .from(job)
      .where(
        and(
          filters.space_id ? eq(job.spaceId, filters.space_id) : undefined,
          filters.state ? eq(job.state, filters.state) : undefined,
        ),
      )
      .orderBy(desc(job.createdAt), desc(job.id))
      .limit(filters.limit);
  }

  async create(input: CreateJobRequest): Promise<JobRow> {
    const value = createJobRequest.parse(input);
    return this.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: space.id })
        .from(space)
        .where(eq(space.id, value.space_id));
      if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);
      const [row] = await tx
        .insert(job)
        .values({
          id: newId('job'),
          spaceId: value.space_id,
          title: value.title,
          objective: value.objective,
          constraints: jobConstraints.parse(value.constraints ?? {}),
          budget: jobBudget.parse({ ...DEFAULT_BUDGET, ...value.budget }),
          nextWakeAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('job insert returned no row');
      await appendEvent(tx, {
        jobId: row.id,
        type: 'job_created',
        payload: { title: row.title },
        dedupKey: `${row.id}:created`,
      });
      await this.enqueue(tx, row, 'created');
      return row;
    });
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
    const wait = options.wait ?? { kind: 'none' };
    const nextWakeAt =
      result.value === 'queued'
        ? new Date()
        : result.value === 'waiting_for_event_or_time' && wait.kind === 'timer'
          ? new Date(wait.wake_at)
          : result.value === 'waiting_for_event_or_time' &&
              wait.kind === 'event' &&
              wait.deadline_at
            ? new Date(wait.deadline_at)
            : null;
    const [updated] = await tx
      .update(job)
      .set({
        state: result.value,
        stateVersion: row.stateVersion + 1,
        leaseEpoch: row.leaseEpoch + (options.bumpEpoch || input.kind === 'cancelled' ? 1 : 0),
        wait,
        nextWakeAt,
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
    return this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      const updated = await this.move(
        tx,
        row,
        { kind: 'user_input_received' },
        { reason: 'input' },
      );
      await appendEvent(tx, {
        jobId: id,
        type: 'notice',
        payload: { kind: 'user_message', text },
        dedupKey: `${id}:input:${updated.stateVersion}`,
      });
      return updated;
    });
  }

  async cancel(id: string, reason?: string): Promise<JobRow> {
    const cancelled = await this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      return this.move(tx, row, { kind: 'cancelled' }, { payload: { reason: reason ?? null } });
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
