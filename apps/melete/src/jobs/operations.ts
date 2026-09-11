import { createHash, randomUUID } from 'node:crypto';
import {
  isTerminal,
  type JsonObject,
  jobState,
  type OperationRegistration,
  backgroundOperation as operationContract,
  operationRegistration,
} from '@melete/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { ServiceError } from '../api/errors.ts';
import { backgroundOperation, space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { QUEUES } from './queue.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobService } from './service.ts';

export type OperationRow = typeof backgroundOperation.$inferSelect;
type OperationWake = { id: string; version: number };
export function operationView(row: OperationRow) {
  return operationContract.parse({
    id: row.id,
    job_id: row.jobId,
    operation_key: row.operationKey,
    kind: row.kind,
    substrate_disposition: row.substrateDisposition,
    state: row.state,
    version: row.version,
    due_at: row.dueAt.toISOString(),
    remote_ref: row.remoteRef,
    result: row.result,
  });
}

/** Remote probes may inspect an already accepted reference; they must never create a fresh effect. */
export type RemoteProbe = (reference: string) => Promise<JsonObject | null>;
export class OperationService {
  readonly instance = randomUUID();
  private started = false;
  constructor(
    readonly jobs: JobService,
    readonly runner?: AttemptRunner,
    readonly probe?: RemoteProbe,
    readonly leaseMs = 45_000,
  ) {
    if (runner) {
      const previous = runner.afterRecovery;
      runner.afterRecovery = async () => {
        await previous?.();
        await this.recover();
      };
    }
  }

  async list(jobId?: string) {
    return this.jobs.db
      .select()
      .from(backgroundOperation)
      .where(jobId ? eq(backgroundOperation.jobId, jobId) : undefined);
  }
  async get(id: string) {
    const [row] = await this.jobs.db
      .select()
      .from(backgroundOperation)
      .where(eq(backgroundOperation.id, id));
    if (!row) throw new ServiceError('not_found', 'Operation not found.', 404);
    return row;
  }
  private async lock(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(backgroundOperation)
      .where(eq(backgroundOperation.id, id))
      .for('update');
    if (!row) throw new ServiceError('not_found', 'Operation not found.', 404);
    return row;
  }
  private async update(
    tx: Transaction,
    row: OperationRow,
    values: Partial<typeof backgroundOperation.$inferInsert>,
  ) {
    const [updated] = await tx
      .update(backgroundOperation)
      .set({ ...values, version: row.version + 1, updatedAt: new Date() })
      .where(eq(backgroundOperation.id, row.id))
      .returning();
    if (!updated) throw new Error('Locked operation disappeared');
    await appendEvent(tx, {
      jobId: row.jobId,
      type: 'notice',
      payload: {
        kind: 'operation_state',
        operation_id: row.id,
        state: updated.state,
        substrate_disposition: updated.substrateDisposition,
        version: updated.version,
      },
      dedupKey: `${row.id}:version:${updated.version}`,
    });
    return updated;
  }
  private async enqueue(tx: Transaction, row: OperationRow) {
    if (
      !['registered', 'ready'].includes(row.state) ||
      !['timer_or_event', 'remote_recoverable'].includes(row.substrateDisposition)
    )
      return;
    await this.jobs.boss.send(
      QUEUES.operation,
      { id: row.id, version: row.version },
      {
        db: fromDrizzle(tx, sql),
        startAfter: row.dueAt,
        retryLimit: 0,
      },
    );
  }

  async register(jobId: string, input: OperationRegistration) {
    const value = operationRegistration.parse(input);
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return this.jobs.transaction(async (tx) => {
      const job = await this.jobs.lock(tx, jobId);
      if (!job) throw new ServiceError('not_found', 'Job not found.', 404);
      const [parent] = await tx.select().from(space).where(eq(space.id, job.spaceId));
      const [existing] = await tx
        .select()
        .from(backgroundOperation)
        .where(
          and(
            eq(backgroundOperation.jobId, jobId),
            eq(backgroundOperation.operationKey, value.operation_key),
          ),
        );
      if (existing) {
        if (existing.inputDigest !== digest)
          throw new ServiceError(
            'operation_conflict',
            'Operation key already identifies different input.',
          );
        return existing;
      }
      if (isTerminal(jobState.parse(job.state)))
        throw new ServiceError('already_terminal', 'Finished jobs cannot register operations.');
      if (value.trigger_id) {
        const [target] = await tx
          .select()
          .from(trigger)
          .where(and(eq(trigger.id, value.trigger_id), eq(trigger.jobId, jobId)));
        if (!target?.enabled)
          throw new ServiceError('invalid_wait', 'Choose an enabled trigger on this job.');
      }
      const disposition =
        value.kind === 'timer'
          ? 'timer_or_event'
          : value.kind === 'local_process'
            ? 'local_process_interrupted'
            : value.remote_ref
              ? 'remote_recoverable'
              : 'external_uncertain';
      const [row] = await tx
        .insert(backgroundOperation)
        .values({
          id: newId('op'),
          jobId,
          operationKey: value.operation_key,
          inputDigest: digest,
          policyGeneration: parent?.policyGeneration ?? 0,
          kind: value.kind,
          substrateDisposition: disposition,
          state: disposition === 'external_uncertain' ? 'unknown' : 'registered',
          ownerInstance: value.kind === 'local_process' ? this.instance : null,
          leaseExpiresAt:
            value.kind === 'local_process' ? new Date(Date.now() + this.leaseMs) : null,
          dueAt: value.due_at ? new Date(value.due_at) : new Date(),
          remoteRef: value.remote_ref,
          triggerId: value.trigger_id,
        })
        .returning();
      if (!row) throw new Error('Operation insert returned no row');
      await appendEvent(tx, {
        jobId,
        type: 'notice',
        payload: {
          kind: 'operation_registered',
          operation_id: row.id,
          substrate_disposition: disposition,
        },
        dedupKey: `${row.id}:registered`,
      });
      await this.enqueue(tx, row);
      return row;
    });
  }
  async claim(id: string, version: number): Promise<OperationRow | null> {
    return this.jobs.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (
        row.version !== version ||
        !['registered', 'ready'].includes(row.state) ||
        row.dueAt.getTime() > Date.now()
      )
        return null;
      const job = await this.jobs.lock(tx, row.jobId);
      if (!job || isTerminal(jobState.parse(job.state))) return null;
      if (
        row.kind === 'local_process' &&
        (row.ownerInstance !== this.instance ||
          !row.leaseExpiresAt ||
          row.leaseExpiresAt.getTime() <= Date.now())
      )
        return null;
      return this.update(tx, row, {
        state: 'claimed',
        ownerInstance: this.instance,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
      });
    });
  }
  private requireLease(row: OperationRow, version: number) {
    if (
      row.version !== version ||
      row.state !== 'claimed' ||
      row.ownerInstance !== this.instance ||
      !row.leaseExpiresAt ||
      row.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new ServiceError('stale_operation', 'Operation ownership or lease changed.');
  }
  async rearm(id: string, version: number, dueAt: Date) {
    return this.jobs.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      this.requireLease(row, version);
      // A live local process may schedule its own continuation; recovery never does this.
      const updated = await this.update(tx, row, {
        state: 'registered',
        dueAt,
        leaseExpiresAt: row.kind === 'local_process' ? new Date(Date.now() + this.leaseMs) : null,
      });
      await this.enqueue(tx, updated);
      return updated;
    });
  }
  async settle(id: string, version: number, result: JsonObject) {
    return this.jobs.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (
        row.state === 'settled' &&
        row.version === version + 1 &&
        JSON.stringify(row.result) === JSON.stringify(result)
      )
        return row;
      this.requireLease(row, version);
      const updated = await this.update(tx, row, {
        state: 'settled',
        result,
        leaseExpiresAt: null,
      });
      if (row.triggerId) {
        await appendEvent(tx, {
          jobId: row.jobId,
          type: 'notice',
          payload: {
            kind: 'operation_event',
            policy_generation: row.policyGeneration,
            trigger_id: row.triggerId,
            operation_id: row.id,
            result,
          },
          dedupKey: `${row.id}:settled`,
        });
        const job = await this.jobs.lock(tx, row.jobId);
        if (job && this.runner?.onWait) await this.runner.onWait(tx, job);
      }
      return updated;
    });
  }

  async recover() {
    const candidates = await this.jobs.db
      .select({ id: backgroundOperation.id })
      .from(backgroundOperation)
      .where(inArray(backgroundOperation.state, ['registered', 'ready', 'claimed']));
    for (const candidate of candidates)
      await this.jobs.transaction(async (tx) => {
        let row = await this.lock(tx, candidate.id);
        if (!['registered', 'ready', 'claimed'].includes(row.state)) return;
        if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()) return;
        if (row.kind === 'local_process') {
          await this.update(tx, row, {
            state: 'interrupted',
            substrateDisposition: 'local_process_interrupted',
            leaseExpiresAt: null,
          });
          return;
        }
        if (
          row.substrateDisposition === 'external_uncertain' ||
          (row.kind === 'remote_task' && !row.remoteRef)
        ) {
          await this.update(tx, row, {
            state: 'unknown',
            substrateDisposition: 'external_uncertain',
            leaseExpiresAt: null,
          });
          return;
        }
        if (row.state === 'claimed')
          row = await this.update(tx, row, {
            state: 'ready',
            ownerInstance: null,
            leaseExpiresAt: null,
          });
        const live = await tx.execute(
          sql`select id from pgboss.job where name = ${QUEUES.operation} and state in ('created', 'retry', 'active') and data->>'id' = ${row.id} and (data->>'version')::int = ${row.version} limit 1`,
        );
        if (!live.length) await this.enqueue(tx, row);
      });
  }
  async handleWake(wake: OperationWake) {
    const candidate = await this.get(wake.id);
    // Without a connector probe the accepted remote reference remains available for explicit inspection.
    if (candidate.kind === 'remote_task' && !this.probe) return;
    const row = await this.claim(wake.id, wake.version);
    if (!row) return;
    const result =
      row.kind === 'timer'
        ? { fired_at: row.dueAt.toISOString() }
        : await this.probe?.(row.remoteRef ?? '');
    if (result) await this.settle(row.id, row.version, result);
    else await this.rearm(row.id, row.version, new Date(Date.now() + 60_000));
  }
  async start() {
    if (this.started) return;
    this.started = true;
    await this.recover();
    await this.jobs.boss.work<OperationWake>(
      QUEUES.operation,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.handleWake(wake.data);
      },
    );
  }
  async stop() {
    if (this.started) await this.jobs.boss.offWork(QUEUES.operation);
    this.started = false;
  }
}
