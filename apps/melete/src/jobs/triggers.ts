import {
  ID_PREFIXES,
  isTerminal,
  jobState,
  jsonObject,
  prefixedId,
  type TriggerSpec,
  triggerSpec,
  waitSpec,
} from '@melete/contracts';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import { connection, event, trigger } from '../db/schema.ts';
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
      if (spec.kind === 'event') {
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
      spec.kind === 'event'
        ? and(
            sql`${event.payload}->>'kind' = 'connector_event'`,
            sql`${event.payload}->>'connection_id' = ${spec.connection_id}`,
            sql`${event.payload}->>'event_name' = ${spec.event_name}`,
          )
        : and(
            sql`${event.payload}->>'kind' = 'schedule_event'`,
            sql`${event.payload}->>'trigger_id' = ${registration.id}`,
          );
    const cursor = Number(registration.cursor ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ServiceError('invalid_cursor', 'Trigger cursor is invalid.');
    const [received] = await tx
      .select()
      .from(event)
      .where(and(eq(event.type, 'notice'), gt(event.seq, cursor), source))
      .orderBy(asc(event.seq))
      .limit(1);
    if (!received) return row;
    await tx
      .update(trigger)
      .set({ cursor: String(received.seq) })
      .where(eq(trigger.id, registration.id));
    const payload = jsonObject.parse(received.payload);
    await appendEvent(tx, {
      jobId: row.id,
      type: 'notice',
      payload: { kind: 'trigger_event', trigger_id: registration.id, event: payload },
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
      const received = await appendEvent(tx, {
        type: 'notice',
        payload: { kind: 'connector_event', ...value },
        dedupKey,
      });
      if (!received) throw new Error('serialized event insert lost');
      const registrations = await tx
        .select()
        .from(trigger)
        .where(
          and(
            eq(trigger.enabled, true),
            eq(trigger.kind, 'event'),
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
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) await this.jobs.boss.offWork(QUEUES.triggerSchedule, { wait: false });
    this.started = false;
  }
}
