import {
  compileWatchPattern,
  evaluateWatch,
  ID_PREFIXES,
  isTerminal,
  jobState,
  jsonObject,
  prefixedId,
  type TriggerSpec,
  triggerSpec,
  type WatchObservation,
  type WatchPredicate,
  waitSpec,
} from '@melete/contracts';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import { connection, event, job, space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { QUEUES } from './queue.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobRow, JobService } from './service.ts';

export const eventDelivery = z.object({
  connection_id: prefixedId(ID_PREFIXES.connection),
  event_name: z.string().min(1).max(200),
  cursor: z.string().min(1).max(1000),
  dedup_key: z.string().min(1).max(1000),
  payload: jsonObject,
});
export type EventDelivery = z.infer<typeof eventDelivery>;
export type TriggerRow = typeof trigger.$inferSelect;

/**
 * How many unseen observations one delivery will test. A feed that has run
 * ahead is caught up over durable continuations rather than in one unbounded
 * transaction, and the cursor means none of them is tested twice.
 */
export const WATCH_SCAN_LIMIT = 200;

type WatchScan = {
  job_id: string;
  trigger_id: string;
  after_seq: number;
  epoch: number;
  version: number;
};

export class TriggerService {
  private started = false;

  constructor(
    readonly jobs: JobService,
    readonly runner: AttemptRunner,
  ) {
    runner.onWait = (tx, row) => this.registerWait(tx, row);
    runner.afterRecovery = () => this.syncSchedules();
  }

  async create(jobId: string, input: TriggerSpec): Promise<TriggerRow> {
    const spec = triggerSpec.parse(input);
    // A pattern that does not compile would silently never match, which reads
    // to a person as "the watch is broken" long after they set it. Refuse it now.
    if (spec.kind === 'watch') {
      for (const clause of spec.predicate.all) {
        if (clause.op !== 'matches') continue;
        try {
          if (typeof clause.value !== 'string') throw new Error('pattern must be text');
          compileWatchPattern(clause.value);
        } catch {
          throw new ServiceError(
            'invalid_predicate',
            `The pattern for ${clause.field} is not a supported regular expression.`,
            400,
          );
        }
      }
    }
    if (spec.kind === 'schedule') {
      try {
        this.jobs.boss.previewSchedule(spec.cron, { tz: spec.timezone, count: 1 });
      } catch {
        throw new ServiceError(
          'invalid_schedule',
          'Provide a valid cron expression and timezone.',
          400,
        );
      }
    }
    const created = await this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, jobId);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      if (isTerminal(jobState.parse(row.state)))
        throw new ServiceError('already_terminal', 'A finished job cannot add triggers.');
      if (spec.kind === 'event' || spec.kind === 'watch') {
        const [source] = await tx
          .select()
          .from(connection)
          .where(eq(connection.id, spec.connection_id));
        if (!source || source.spaceId !== row.spaceId || source.status !== 'active')
          throw new ServiceError(
            'unknown_connection',
            'Choose an active connection in the job space.',
            400,
          );
      }
      const [start] = await tx
        .select({ seq: event.seq })
        .from(event)
        .where(and(eq(event.jobId, row.id), eq(event.type, 'job_created')))
        .limit(1);
      const [created] = await tx
        .insert(trigger)
        .values({ id: newId('trg'), jobId, kind: spec.kind, spec, cursor: String(start?.seq ?? 0) })
        .returning();
      if (!created) throw new Error('trigger insert returned no row');
      await appendEvent(tx, {
        jobId,
        type: 'notice',
        payload: { kind: 'trigger_created', trigger_id: created.id, spec },
        dedupKey: `${created.id}:created`,
      });
      return created;
    });
    // pg-boss schedule() has no transaction adapter. The trigger row is authoritative;
    // startup and every recovery scan restore registrations after a crash here.
    if (spec.kind === 'schedule') await this.syncSchedules();
    return created;
  }

  /**
   * Walk the observations this watch has not seen, in order, and hand back the
   * first one its predicate accepts.
   *
   * Every observation it looks at advances the cursor and becomes the thing a
   * later `changed` clause compares against, whether it matched or not. That is
   * what makes a quiet feed free: a hundred observations that do not match cost
   * a hundred comparisons and no attempt, no model call and no row.
   */
  private async firstMatch(
    tx: Transaction,
    registration: TriggerRow,
    predicate: WatchPredicate,
    candidates: readonly (typeof event.$inferSelect)[],
  ): Promise<typeof event.$inferSelect | undefined> {
    let previous = (registration.lastObservation ?? null) as WatchObservation | null;
    let examined: typeof event.$inferSelect | null = null;
    let matched: typeof event.$inferSelect | undefined;
    for (const candidate of candidates) {
      const payload = jsonObject.parse(candidate.payload);
      // An operation event is this job's own bookkeeping, not an observation to
      // test; it wakes the job the way it always did.
      if (payload.kind !== 'connector_event') {
        matched = candidate;
        break;
      }
      const observed = jsonObject.safeParse(payload.payload);
      const observation = observed.success ? observed.data : {};
      examined = candidate;
      if (evaluateWatch(predicate, observation, previous)) {
        matched = candidate;
        break;
      }
      previous = observation;
    }
    // Nothing matched: remember where the scan reached, so the same
    // observations are not tested again on the next delivery.
    if (!matched && examined) {
      await tx
        .update(trigger)
        .set({ cursor: String(examined.seq), lastObservation: previous })
        .where(eq(trigger.id, registration.id));
      return undefined;
    }
    if (matched) {
      const payload = jsonObject.parse(matched.payload);
      const observed = jsonObject.safeParse(payload.payload);
      await tx
        .update(trigger)
        .set({ lastObservation: observed.success ? observed.data : previous })
        .where(eq(trigger.id, registration.id));
    }
    return matched;
  }

  async registerWait(tx: Transaction, row: JobRow): Promise<JobRow> {
    const wait = waitSpec.parse(row.wait);
    if (row.state !== 'waiting_for_event_or_time' || wait.kind !== 'event') return row;
    const [registration] = await tx
      .select()
      .from(trigger)
      .where(and(eq(trigger.id, wait.trigger_id), eq(trigger.jobId, row.id)));
    if (!registration?.enabled)
      throw new ServiceError('invalid_wait', 'Wait trigger is missing or disabled.');
    const spec = triggerSpec.parse(registration.spec);
    const source =
      spec.kind === 'schedule'
        ? and(
            sql`${event.payload}->>'kind' = 'schedule_event'`,
            sql`${event.payload}->>'trigger_id' = ${registration.id}`,
          )
        : and(
            sql`${event.payload}->>'kind' = 'connector_event'`,
            sql`${event.payload}->>'connection_id' = ${spec.connection_id}`,
            sql`${event.payload}->>'event_name' = ${spec.event_name}`,
          );
    const cursor = Number(registration.cursor ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ServiceError('invalid_cursor', 'Trigger cursor is invalid.');
    const candidates = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.type, 'notice'),
          gt(event.seq, cursor),
          or(
            source,
            and(
              eq(event.jobId, row.id),
              sql`${event.payload}->>'kind' = 'operation_event'`,
              sql`${event.payload}->>'trigger_id' = ${registration.id}`,
            ),
          ),
        ),
      )
      .orderBy(asc(event.seq))
      .limit(spec.kind === 'watch' ? WATCH_SCAN_LIMIT : 1);
    const received =
      spec.kind === 'watch'
        ? await this.firstMatch(tx, registration, spec.predicate, candidates)
        : candidates[0];
    if (!received) {
      const last = candidates.at(-1);
      if (spec.kind === 'watch' && candidates.length === WATCH_SCAN_LIMIT && last) {
        // Cursor and continuation commit together. A crash cannot leave a full
        // page consumed with no durable work to reach the next observation.
        await this.jobs.boss.send(
          QUEUES.triggerScan,
          {
            job_id: row.id,
            trigger_id: registration.id,
            after_seq: last.seq,
            epoch: row.leaseEpoch,
            version: row.stateVersion,
          } satisfies WatchScan,
          { db: fromDrizzle(tx, sql), retryLimit: 5, retryDelay: 1, retryBackoff: true },
        );
      }
      return row;
    }
    await tx
      .update(trigger)
      .set({ cursor: String(received.seq) })
      .where(eq(trigger.id, registration.id));
    const payload = jsonObject.parse(received.payload);
    if (
      registration.kind === 'schedule' &&
      payload.kind === 'schedule_event' &&
      row.scheduleSkipRemaining > 0 &&
      row.importance !== 'important'
    ) {
      const [updated] = await tx
        .update(job)
        .set({ scheduleSkipRemaining: row.scheduleSkipRemaining - 1 })
        .where(eq(job.id, row.id))
        .returning();
      await appendEvent(tx, {
        jobId: row.id,
        type: 'notice',
        payload: {
          kind: 'routine_check_deferred',
          trigger_id: registration.id,
          cadence_multiplier: row.cadenceMultiplier,
        },
        dedupKey: `${registration.id}:deferred:${received.seq}`,
      });
      return updated ?? row;
    }
    await appendEvent(tx, {
      jobId: row.id,
      type: 'notice',
      payload: {
        kind: 'trigger_event',
        trigger_id: registration.id,
        event: payload,
        // The observation that made this wake necessary, by handle. A watch
        // that woke a job can always say which observation did it.
        because: [`event:${received.seq}`],
      },
      dedupKey: `${registration.id}:consumed:${received.seq}`,
    });
    return this.jobs.move(
      tx,
      row,
      { kind: 'event_fired' },
      { reason: 'event', payload: { trigger_id: registration.id, source_seq: received.seq } },
    );
  }

  async deliver(input: EventDelivery): Promise<{ seq: number; duplicate: boolean }> {
    const value = eventDelivery.parse(input);
    return this.jobs.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, value.connection_id));
      if (source?.status !== 'active')
        throw new ServiceError('unknown_connection', 'Connection is not active.', 404);
      const dedupKey = `connector:${value.connection_id}:${value.dedup_key}`;
      const [existing] = await tx
        .select({ seq: event.seq })
        .from(event)
        .where(eq(event.dedupKey, dedupKey));
      if (existing) return { seq: existing.seq, duplicate: true };
      const [parent] = await tx.select().from(space).where(eq(space.id, source.spaceId));
      const received = await appendEvent(tx, {
        type: 'notice',
        payload: {
          kind: 'connector_event',
          ...value,
          connection_generation: source.generation,
          policy_generation: parent?.policyGeneration ?? 0,
        },
        dedupKey,
      });
      if (!received) throw new Error('serialized event insert lost');
      const registrations = await tx
        .select()
        .from(trigger)
        .where(
          and(
            eq(trigger.enabled, true),
            inArray(trigger.kind, ['event', 'watch']),
            sql`${trigger.spec}->>'connection_id' = ${value.connection_id}`,
            sql`${trigger.spec}->>'event_name' = ${value.event_name}`,
          ),
        );
      for (const registration of registrations) {
        const row = await this.jobs.lock(tx, registration.jobId);
        if (row?.spaceId === source.spaceId) await this.registerWait(tx, row);
      }
      return { seq: received.seq, duplicate: false };
    });
  }

  async fireSchedule(triggerId: string, occurrenceId: string): Promise<void> {
    await this.jobs.transaction(async (tx) => {
      const [registration] = await tx.select().from(trigger).where(eq(trigger.id, triggerId));
      if (!registration?.enabled || registration.kind !== 'schedule') return;
      const row = await this.jobs.lock(tx, registration.jobId);
      if (!row || isTerminal(jobState.parse(row.state))) return;
      const received = await appendEvent(tx, {
        type: 'notice',
        payload: {
          kind: 'schedule_event',
          trigger_id: registration.id,
          occurrence_id: occurrenceId,
        },
        dedupKey: `${registration.id}:schedule:${occurrenceId}`,
      });
      if (received) await this.registerWait(tx, row);
    });
  }

  async syncSchedules(): Promise<void> {
    const rows = await this.jobs.db.select().from(trigger).where(eq(trigger.kind, 'schedule'));
    const schedules = await this.jobs.boss.getSchedules(QUEUES.triggerSchedule);
    const desired = new Set<string>();
    for (const row of rows) {
      if (!row.enabled) continue;
      desired.add(row.id);
      const spec = triggerSpec.parse(row.spec);
      if (spec.kind !== 'schedule') continue;
      const current = schedules.find((schedule) => schedule.key === row.id);
      if (current?.cron === spec.cron && current.timezone === spec.timezone) continue;
      await this.jobs.boss.schedule(
        QUEUES.triggerSchedule,
        spec.cron,
        { trigger_id: row.id },
        { key: row.id, tz: spec.timezone, missed: 'once', retryLimit: 0 },
      );
    }
    for (const schedule of schedules)
      if (!desired.has(schedule.key))
        await this.jobs.boss.unschedule(QUEUES.triggerSchedule, schedule.key);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.syncSchedules();
    await this.jobs.boss.work<{ trigger_id: string }>(
      QUEUES.triggerSchedule,
      { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.fireSchedule(wake.data.trigger_id, wake.id);
      },
    );
    await this.jobs.boss.work<WatchScan>(
      QUEUES.triggerScan,
      { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes)
          await this.jobs.transaction(async (tx) => {
            const scan = wake.data;
            const row = await this.jobs.lock(tx, scan.job_id);
            if (
              row?.state !== 'waiting_for_event_or_time' ||
              row.leaseEpoch !== scan.epoch ||
              row.stateVersion !== scan.version
            )
              return;
            const wait = waitSpec.parse(row.wait);
            if (wait.kind !== 'event' || wait.trigger_id !== scan.trigger_id) return;
            const [registration] = await tx
              .select()
              .from(trigger)
              .where(and(eq(trigger.id, scan.trigger_id), eq(trigger.jobId, row.id)));
            if (!registration?.enabled || registration.kind !== 'watch') return;
            await this.registerWait(tx, row);
          });
      },
    );
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.jobs.boss.offWork(QUEUES.triggerSchedule, { wait: false });
      await this.jobs.boss.offWork(QUEUES.triggerScan, { wait: false });
    }
    this.started = false;
  }
}
