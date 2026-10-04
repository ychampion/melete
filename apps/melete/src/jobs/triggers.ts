import {
  CRON_FORMAT,
  compileWatchPattern,
  evaluateWatch,
  ID_PREFIXES,
  isTerminal,
  type JsonObject,
  jobState,
  jsonObject,
  PROCESS_LIMITS,
  type ProcessWatchKind,
  prefixedId,
  type TriggerSpec,
  triggerSpec,
  type WatchObservation,
  type WatchPredicate,
  waitSpec,
} from '@melete/contracts';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import { appendEvent as appendBrokerEvent, lockJob } from '../broker/records.ts';
import { connection, event, experienceTurn, job, space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { QUEUES } from './queue.ts';
import type { AttemptRunner } from './runner.ts';
import { jobMayUseConnection } from './scopes.ts';
import type { JobRow, JobService } from './service.ts';
import { personStarted } from './wake-guard.ts';

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

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const clipped = (text: string) => (text.length > 64 ? `${text.slice(0, 64)}…` : text);

/**
 * Refuses a trigger that could never fire as the person meant it: a watch
 * pattern that does not compile, or a schedule that is not a valid cron and
 * time zone.
 */
export function checkTriggerSpec(jobs: Pick<JobService, 'boss'>, spec: TriggerSpec): void {
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
    if (!knownTimeZone(spec.timezone))
      throw new ServiceError(
        'invalid_schedule',
        `"${clipped(spec.timezone)}" is not a time zone. Use a name such as "America/Los_Angeles".`,
        400,
      );
    try {
      jobs.boss.previewSchedule(spec.cron, { tz: spec.timezone, count: 1 });
    } catch {
      throw new ServiceError(
        'invalid_schedule',
        `"${clipped(spec.cron)}" is not a cron this can follow. ${CRON_FORMAT}`,
        400,
      );
    }
  }
}

type WatchScan = {
  job_id: string;
  trigger_id: string;
  after_seq: number;
  epoch: number;
  version: number;
};

/**
 * Watches on background processes in an agent's computer.
 *
 * They are ordinary `watch` triggers on the computer's sandbox connection,
 * with one difference: the service makes them, from the job's own tool call,
 * for a process that job's computer runs. The process monitor delivers what
 * happens in the process through `deliver`, and the trigger's predicate
 * decides. Each delivery names the one watch it is for, so two jobs watching
 * the same process each get their own lines, at their own pace. A job holds
 * a few of them at most, and each goes once its process has ended and the job
 * no longer needs it.
 */
export const PROCESS_EVENTS = {
  exit: 'process.exited',
  output: 'process.output',
  listening: 'process.listening',
} as const satisfies Record<ProcessWatchKind, string>;
const PROCESS_ID = /^prc_[A-Za-z0-9]{8,64}$/;

/** The process a service-made watch follows, and on what; null for any other trigger. */
export function watchedProcess(
  spec: unknown,
): { processId: string; kind: ProcessWatchKind; pattern: string | null } | null {
  const parsed = triggerSpec.safeParse(spec);
  if (!parsed.success || parsed.data.kind !== 'watch') return null;
  const eventName = parsed.data.event_name;
  const kind = (Object.keys(PROCESS_EVENTS) as ProcessWatchKind[]).find(
    (key) => PROCESS_EVENTS[key] === eventName,
  );
  const [first] = parsed.data.predicate.all;
  if (!kind || first?.field !== 'process_id' || first.op !== 'eq') return null;
  if (typeof first.value !== 'string' || !PROCESS_ID.test(first.value)) return null;
  const pattern = parsed.data.predicate.all.find(
    (clause) => clause.field === 'line' && clause.op === 'matches',
  );
  return {
    processId: first.value,
    kind,
    pattern: typeof pattern?.value === 'string' ? pattern.value : null,
  };
}

/** The trigger a watch is: the process, the watch itself, and for output the pattern a line must match. */
export function processWatchSpec(input: {
  connectionId: string;
  processId: string;
  triggerId: string;
  kind: ProcessWatchKind;
  pattern: string | null;
}): TriggerSpec {
  return triggerSpec.parse({
    kind: 'watch',
    connection_id: input.connectionId,
    event_name: PROCESS_EVENTS[input.kind],
    poll_seconds: 300,
    predicate: {
      all: [
        { field: 'process_id', op: 'eq', value: input.processId },
        { field: 'watch', op: 'eq', value: input.triggerId },
        ...(input.kind === 'output' && input.pattern !== null
          ? [{ field: 'line', op: 'matches', value: input.pattern }]
          : []),
      ],
    },
  });
}

/** A watch the service will not make; nothing was recorded. */
export class ProcessWatchRefusal extends Error {
  override readonly name = 'ProcessWatchRefusal';
  constructor(
    readonly code: 'invalid_pattern' | 'process_ended' | 'too_many_watches' | 'job_finished',
    message: string,
  ) {
    super(message);
  }
}

/** SQL for "this trigger is a watch on a background process". */
export const PROCESS_WATCH_SQL = (alias: string) =>
  `${alias}.kind = 'watch' and ${alias}.spec->>'event_name' in ('process.exited', 'process.output', 'process.listening') and ${alias}.spec #>> '{predicate,all,0,field}' = 'process_id'`;

/**
 * Make a watch on a process for the job that asked, from its own tool call.
 * The process must still run, and the job may hold only a few live watches.
 * Asking again for the same watch hands back the one already made. The watch
 * sees only what happens from now on, and for output, only what the process
 * prints after `fromCursor`.
 */
export async function createProcessWatch(
  sql: Sql,
  input: {
    jobId: string;
    spaceId: string;
    connectionId: string;
    processId: string;
    kind: ProcessWatchKind;
    pattern: string | null;
    fromCursor: number;
  },
): Promise<{ triggerId: string; eventName: string; created: boolean }> {
  const pattern = input.kind === 'output' ? input.pattern : null;
  if (pattern !== null) {
    try {
      compileWatchPattern(pattern);
    } catch {
      throw new ProcessWatchRefusal(
        'invalid_pattern',
        'The pattern is not a supported regular expression (RE2: no lookarounds or backreferences). Nothing is watched',
      );
    }
  }
  const eventName = PROCESS_EVENTS[input.kind];
  return (await sql.begin(async (tx) => {
    const job = await lockJob(tx, input.jobId);
    if (job.space_id !== input.spaceId || isTerminal(jobState.parse(job.state)))
      throw new ProcessWatchRefusal(
        'job_finished',
        'This job has finished, so nothing can wake it. Nothing is watched',
      );
    const [process] = await tx`select state from sandbox_process
      where id = ${input.processId} and space_id = ${input.spaceId}
        and connection_id = ${input.connectionId}
      for update`;
    if (!process || !['starting', 'running'].includes(String(process.state)))
      throw new ProcessWatchRefusal(
        'process_ended',
        `The process has ended (${String(process?.state ?? 'gone')}), so there is nothing to wait for. Read what it printed with process.read`,
      );
    const mine = await tx`select id, spec from trigger t
      where t.job_id = ${input.jobId} and t.enabled
        and ${tx.unsafe(PROCESS_WATCH_SQL('t'))}
        and t.spec #>> '{predicate,all,0,value}' = ${input.processId}`;
    for (const row of mine) {
      const watched = watchedProcess(row.spec);
      if (watched?.kind === input.kind && watched.pattern === pattern)
        return { triggerId: String(row.id), eventName, created: false };
    }
    const [counted] = await tx`select count(*)::int as n from trigger t
      join sandbox_process p on p.id = t.spec #>> '{predicate,all,0,value}'
      where t.job_id = ${input.jobId} and t.enabled and ${tx.unsafe(PROCESS_WATCH_SQL('t'))}
        and p.state in ('starting', 'running')`;
    if (Number(counted?.n ?? 0) >= PROCESS_LIMITS.watches_per_job)
      throw new ProcessWatchRefusal(
        'too_many_watches',
        `This job already watches ${PROCESS_LIMITS.watches_per_job} processes. Wait for one of them, or read the process with process.read`,
      );
    const triggerId = newId('trg');
    const spec = processWatchSpec({
      connectionId: input.connectionId,
      processId: input.processId,
      triggerId,
      kind: input.kind,
      pattern,
    });
    // From now on: lockJob holds the event order, so nothing below this
    // sequence number is still to commit.
    const [last] = await tx`select coalesce(max(seq), 0)::bigint as seq from event`;
    await tx`insert into trigger (id, job_id, kind, spec, cursor)
      values (${triggerId}, ${input.jobId}, 'watch', ${JSON.stringify(spec)}::jsonb,
        ${String(last?.seq ?? 0)})`;
    if (input.kind === 'output')
      await tx`update sandbox_process set notify = jsonb_set(
          coalesce(notify, '{}'::jsonb) || jsonb_build_object('watches', coalesce(notify->'watches', '{}'::jsonb)),
          ${['watches', triggerId]}::text[],
          ${JSON.stringify({ scanned: input.fromCursor, delivered_at: null })}::jsonb)
        where id = ${input.processId}`;
    await appendBrokerEvent(
      tx,
      input.jobId,
      null,
      'notice',
      { kind: 'trigger_created', trigger_id: triggerId, spec },
      `${triggerId}:created`,
    );
    return { triggerId, eventName, created: true };
  })) as { triggerId: string; eventName: string; created: boolean };
}

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
    checkTriggerSpec(this.jobs, spec);
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
        // A connection serves only the jobs the shared-use rule gives it to,
        // and watching what it receives is using it.
        if (
          !source ||
          source.spaceId !== row.spaceId ||
          source.status !== 'active' ||
          !(await jobMayUseConnection(tx, row.id, source.id))
        )
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
    // A paused routine rests on its own schedule until it is resumed, and
    // paused long work on whatever it stands on.
    if (
      registration &&
      !registration.enabled &&
      ((registration.kind === 'schedule' && row.kind === 'routine') || row.kind === 'run')
    )
      return row;
    if (!registration?.enabled)
      throw new ServiceError('invalid_wait', 'Wait trigger is missing or disabled.');
    const spec = triggerSpec.parse(registration.spec);
    // A trigger made before its connection stopped serving this job, or before
    // the rule existed, hears nothing more from it.
    if (spec.kind !== 'schedule' && !(await jobMayUseConnection(tx, row.id, spec.connection_id)))
      return row;
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
    // Each scheduled occurrence has its own attempt and spending allowance.
    if (row.kind === 'routine' && registration.kind === 'schedule') {
      const turnId = newId('turn');
      row = { ...row, currentTurnId: turnId };
      await tx.update(job).set({ currentTurnId: turnId }).where(eq(job.id, row.id));
      // Each run is a turn in the routine's own thread: the instruction it was
      // given, then its answer, cards and approvals, where the person can read them.
      if (row.agentId)
        await tx.insert(experienceTurn).values({
          id: turnId,
          jobId: row.id,
          agentId: row.agentId,
          submissionId: `routine:${registration.id}:${received.seq}`,
          text: row.objective,
        });
    }
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

  /**
   * A watched process has ended. A job waiting on a watch for a line or a
   * port that never came is woken with how the process ended, rather than
   * left to wait on a process that will print nothing more. Its end itself
   * reaches exit watches through `deliver`, before this. Then each watch on
   * the process goes, unless its job is in an attempt that may still wait on
   * it, or waits on it now: those go on a later pass. Returns how many are
   * left.
   */
  async processEnded(processId: string, observation: JsonObject): Promise<number> {
    return this.jobs.transaction(async (tx) => {
      const watches = await tx
        .select()
        .from(trigger)
        .where(
          and(
            sql.raw(PROCESS_WATCH_SQL('"trigger"')),
            sql`${trigger.spec} #>> '{predicate,all,0,value}' = ${processId}`,
          ),
        )
        .orderBy(asc(trigger.id));
      let left = 0;
      for (const watch of watches) {
        const row = await this.jobs.lock(tx, watch.jobId);
        const spec = triggerSpec.parse(watch.spec);
        if (
          row &&
          watch.enabled &&
          spec.kind === 'watch' &&
          spec.event_name !== PROCESS_EVENTS.exit &&
          !isTerminal(jobState.parse(row.state))
        ) {
          const [source] = await tx
            .select()
            .from(connection)
            .where(eq(connection.id, spec.connection_id));
          const [parent] = await tx.select().from(space).where(eq(space.id, row.spaceId));
          await appendEvent(tx, {
            jobId: row.id,
            type: 'notice',
            payload: {
              kind: 'operation_event',
              trigger_id: watch.id,
              connection_id: spec.connection_id,
              connection_generation: source?.generation ?? 0,
              policy_generation: parent?.policyGeneration ?? 0,
              event_name: 'process.ended',
              payload: { ...observation, watch: watch.id },
            },
            dedupKey: `${watch.id}:process-ended`,
          });
          await this.registerWait(tx, row);
        }
        const current = row ? await this.jobs.lock(tx, row.id) : undefined;
        const wait = current ? waitSpec.safeParse(current.wait) : null;
        const needed =
          current?.state === 'running' ||
          // A watch revocation disabled can no longer wake anything, so it is
          // not kept for a wait on it; the revocation answers that wait.
          (watch.enabled &&
            current?.state === 'waiting_for_event_or_time' &&
            wait?.success === true &&
            wait.data.kind === 'event' &&
            wait.data.trigger_id === watch.id);
        if (needed) {
          left += 1;
          continue;
        }
        await tx.delete(trigger).where(eq(trigger.id, watch.id));
      }
      return left;
    });
  }

  /**
   * One occurrence of a schedule. `byPerson` marks a run the person asked for
   * (a routine's test): it is recorded as theirs only when the run fires.
   */
  async fireSchedule(
    triggerId: string,
    occurrenceId: string,
    byPerson?: { principalId: string | null },
  ): Promise<void> {
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
      if (!received) return;
      const woke = await this.registerWait(tx, row);
      if (byPerson && woke.state === 'queued')
        await personStarted(tx, row.id, byPerson.principalId);
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
