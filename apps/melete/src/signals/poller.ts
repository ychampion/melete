/**
 * Reading what changed in connected accounts.
 *
 * Something has to put a `mail.received` or a `calendar.event.changed` where a
 * waiting job or a standing run can hear it. This is that something. Once a
 * minute it looks for accounts that are due: a mailbox or calendar that some
 * live trigger listens to, whose job may use it. For each it reads what
 * changed since its cursor, through the connector's own read-only code, and
 * hands each observation to `TriggerService.deliver`, which dedupes and wakes.
 *
 * Properties it keeps:
 *
 * 1. **It only reads.** A connector's `signals` can list and fetch headers;
 *    nothing here sends, writes to the account, or proposes an effect.
 * 2. **One change is one event.** Every observation carries a key made of what
 *    it is about and its state (a message's id; an occurrence and the version
 *    of its fields), and `deliver` keeps one event per key, so a change read
 *    twice, by two polls or after a cursor reset, is delivered once.
 * 3. **Only what someone asked to hear.** An account is read only while a
 *    trigger listens for one of its kinds, and only for triggers whose job the
 *    connection serves under the shared-use rule. Delivery checks that rule
 *    again for each waiting job.
 * 4. **Quiet costs nothing.** An observation no trigger matches wakes nothing:
 *    no attempt, no model call.
 *
 * Accounts are claimed with `SKIP LOCKED` and a short lease, so several
 * instances can run the tick without reading one account twice at once.
 */
import {
  CALENDAR_EVENT_NAMES,
  isTerminal,
  jobState,
  MAIL_RECEIVED,
  triggerSpec,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { QUEUES } from '../jobs/queue.ts';
import { connectionServesJob, jobConnectionAudience } from '../jobs/scopes.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import {
  type CalendarCursor,
  diffCalendar,
  type KeptOccurrence,
  mailObservation,
  type Observation,
  type OccurrenceFields,
} from './observations.ts';
import type { SignalSource } from './types.ts';

export type Stream = SignalSource['stream'];

/** How far ahead calendar occurrences are watched. */
export const CALENDAR_WINDOW_DAYS = 14;
/** Most new messages one read of a mailbox takes; the cursor stops after the last. */
export const MAIL_READ_LIMIT = 50;
/** The shortest and longest time between two reads of one account. */
export const MIN_POLL_SECONDS = 60;
export const MAX_POLL_SECONDS = 3600;
/** How long a claimed account stays out of other instances' reach. */
export const CLAIM_SECONDS = 600;
/** Most accounts one tick reads. */
export const ACCOUNTS_PER_TICK = 20;

/** Which stream a trigger's event name is read from. */
export function streamOf(eventName: string): Stream | null {
  if (eventName === MAIL_RECEIVED) return 'mail';
  if ((CALENDAR_EVENT_NAMES as readonly string[]).includes(eventName)) return 'calendar';
  return null;
}

export type SignalPollerDeps = {
  sql: Sql;
  triggers: Pick<TriggerService, 'deliver'> & { jobs: { boss: TriggerService['jobs']['boss'] } };
  /** The registered connectors; an account whose connector reads nothing is never polled. */
  connectors: { get(id: string): { signals?: SignalSource } | undefined };
  now?: () => number;
};

type CursorRow = {
  connection_id: string;
  stream: Stream;
  space_id: string;
  cursor: unknown;
  interval_s: number;
  failures: number;
};

const clampInterval = (seconds: number) =>
  Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(seconds)));

/**
 * Why a read failed, as a fixed code. An account's error can carry an
 * address, a subject or a token in its words, so only its shape is logged.
 */
function failureCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `status_${status}`;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'read_failed';
}

export class SignalPoller {
  private started = false;

  constructor(readonly deps: SignalPollerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The accounts some live trigger listens to, by stream, with the shortest
   * interval any of those triggers asked for. A trigger counts only when its
   * job is live and the connection serves that job.
   */
  async demand(): Promise<Map<string, { spaceId: string; stream: Stream; seconds: number }>> {
    const rows = await this.deps.sql`
      select t.job_id, t.spec, j.state, c.id as connection_id, c.space_id, c.shared_use
      from trigger t
        join job j on j.id = t.job_id
        join connection c on c.id = t.spec->>'connection_id'
      where t.enabled and t.kind in ('event', 'watch')
        and c.status = 'active' and c.space_id = j.space_id
        and t.spec->>'event_name' in ${this.deps.sql([MAIL_RECEIVED, ...CALENDAR_EVENT_NAMES])}
      order by c.id, t.job_id`;
    const wanted = new Map<string, { spaceId: string; stream: Stream; seconds: number }>();
    for (const row of rows) {
      const state = jobState.safeParse(row.state);
      if (!state.success || isTerminal(state.data)) continue;
      const spec = triggerSpec.safeParse(row.spec);
      if (!spec.success || spec.data.kind === 'schedule') continue;
      const stream = streamOf(spec.data.event_name);
      if (!stream) continue;
      const connectionId = String(row.connection_id);
      if (this.deps.connectors.get(connectionId)?.signals?.stream !== stream) continue;
      const audience = await jobConnectionAudience(this.deps.sql, String(row.job_id));
      if (!audience || !connectionServesJob(audience, String(row.shared_use))) continue;
      const key = `${connectionId} ${stream}`;
      const seconds = clampInterval(spec.data.poll_seconds);
      const before = wanted.get(key);
      wanted.set(key, {
        spaceId: String(row.space_id),
        stream,
        seconds: Math.min(before?.seconds ?? seconds, seconds),
      });
    }
    return wanted;
  }

  /**
   * Keep one cursor for every account in demand, and none for any other. An
   * account nobody listens to any more loses its cursor and what was kept
   * about its calendar: when someone listens again, watching starts afresh.
   */
  async refresh(): Promise<void> {
    const wanted = await this.demand();
    const { sql } = this.deps;
    const at = new Date(this.now()).toISOString();
    await sql.begin(async (tx) => {
      const existing = await tx`select connection_id, stream from source_cursor`;
      for (const row of existing) {
        const key = `${row.connection_id} ${row.stream}`;
        if (wanted.has(key)) continue;
        await tx`delete from source_cursor
          where connection_id = ${row.connection_id} and stream = ${row.stream}`;
        if (row.stream === 'calendar')
          await tx`delete from subject_state
            where connection_id = ${row.connection_id} and type = 'calendar_occurrence'`;
      }
      for (const [key, value] of wanted) {
        const connectionId = key.split(' ')[0] ?? '';
        await tx`insert into source_cursor (connection_id, stream, space_id, interval_s, next_poll_at)
          values (${connectionId}, ${value.stream}, ${value.spaceId}, ${value.seconds}, ${at}::timestamptz)
          on conflict (connection_id, stream) do update set interval_s = excluded.interval_s`;
      }
    });
  }

  /** Take the accounts that are due, so no other instance reads them meanwhile. */
  private async claim(): Promise<CursorRow[]> {
    const at = new Date(this.now()).toISOString();
    const until = new Date(this.now() + CLAIM_SECONDS * 1000).toISOString();
    const rows = await this.deps.sql`
      update source_cursor s set next_poll_at = ${until}::timestamptz
      from (
        select connection_id, stream from source_cursor
        where next_poll_at <= ${at}::timestamptz
        order by next_poll_at
        limit ${ACCOUNTS_PER_TICK}
        for update skip locked
      ) due
      where s.connection_id = due.connection_id and s.stream = due.stream
      returning s.connection_id, s.stream, s.space_id, s.cursor, s.interval_s, s.failures`;
    return rows as unknown as CursorRow[];
  }

  /** One tick: refresh what is wanted, then read every account that is due. */
  async runOnce(): Promise<{ polled: number; delivered: number; failed: number }> {
    await this.refresh();
    let delivered = 0;
    let failed = 0;
    const claimed = await this.claim();
    for (const row of claimed) {
      try {
        const read = await this.poll(row);
        delivered += read.delivered;
        await this.deps.sql`update source_cursor
          set cursor = ${JSON.stringify(read.cursor)}::jsonb, failures = 0,
            last_ok_at = ${new Date(this.now()).toISOString()}::timestamptz,
            next_poll_at = ${new Date(this.now() + row.interval_s * 1000).toISOString()}::timestamptz
          where connection_id = ${row.connection_id} and stream = ${row.stream}`;
      } catch (error) {
        // One account that cannot be read must not stop the rest. Its cursor
        // stays where it was, so nothing it holds is skipped, and it is tried
        // again later, less often the longer it keeps failing.
        failed += 1;
        const wait = Math.min(
          MAX_POLL_SECONDS,
          row.interval_s * 2 ** Math.min(row.failures + 1, 6),
        );
        await this.deps.sql`update source_cursor
          set failures = failures + 1, next_poll_at = ${new Date(this.now() + wait * 1000).toISOString()}::timestamptz
          where connection_id = ${row.connection_id} and stream = ${row.stream}`;
        process.stderr.write(
          `signals: read_failed ${failureCode(error)} ${row.connection_id} ${row.stream}\n`,
        );
      }
    }
    return { polled: claimed.length, delivered, failed };
  }

  /** Deliver in order; a failure stops before the cursor moves, and the next read delivers the rest. */
  private async deliverAll(connectionId: string, cursor: string, observations: Observation[]) {
    let delivered = 0;
    for (const observation of observations) {
      const result = await this.deps.triggers.deliver({
        connection_id: connectionId,
        event_name: observation.event_name,
        cursor,
        dedup_key: observation.dedup_key,
        payload: observation.payload,
      });
      if (!result.duplicate) delivered += 1;
    }
    return delivered;
  }

  private async poll(row: CursorRow): Promise<{ cursor: object; delivered: number }> {
    const source = this.deps.connectors.get(row.connection_id)?.signals;
    if (!source || source.stream !== row.stream) throw new Error('no source');
    if (source.stream === 'mail') {
      const saved = (row.cursor as { value?: unknown } | null)?.value;
      const read = await source.changes(typeof saved === 'string' ? saved : null, {
        limit: MAIL_READ_LIMIT,
        now: this.now(),
        seen: async (key) => {
          const [found] = await this.deps.sql`select 1 from event
            where dedup_key = ${`connector:${row.connection_id}:${MAIL_RECEIVED}:${key}`}`;
          return Boolean(found);
        },
      });
      const readAt = new Date(this.now()).toISOString();
      const observations = read.messages.map((message) =>
        mailObservation(row.connection_id, message, readAt),
      );
      return {
        cursor: { value: read.cursor },
        delivered: await this.deliverAll(row.connection_id, read.cursor, observations),
      };
    }
    const now = this.now();
    const window = {
      from: new Date(now).toISOString(),
      to: new Date(now + CALENDAR_WINDOW_DAYS * 86_400_000).toISOString(),
    };
    const read = await source.occurrences(window);
    const kept = await this.deps.sql`select subject_key, version, fields from subject_state
      where connection_id = ${row.connection_id} and type = 'calendar_occurrence'`;
    const previous = row.cursor as CalendarCursor;
    const diff = diffCalendar({
      connectionId: row.connection_id,
      kept: kept.map((entry) => ({
        subject_key: String(entry.subject_key),
        version: String(entry.version),
        fields: entry.fields as OccurrenceFields,
      })) as KeptOccurrence[],
      read,
      previous: previous && typeof previous.window_end === 'string' ? previous : null,
      window,
      now,
    });
    const delivered = await this.deliverAll(row.connection_id, diff.window_end, diff.observations);
    // What was kept moves only after everything it led to was delivered. A
    // stop in between reads the same differences next time, with the same
    // keys, so nothing is delivered twice and nothing is lost.
    await this.deps.sql.begin(async (tx) => {
      const at = new Date(now).toISOString();
      for (const entry of diff.upsert)
        await tx`insert into subject_state
            (subject_key, space_id, connection_id, type, fields, version, origin, last_changed_at)
          values (${entry.subject_key}, ${row.space_id}, ${row.connection_id}, 'calendar_occurrence',
            ${JSON.stringify(entry.fields)}::jsonb, ${entry.version}, 'external_content', ${at}::timestamptz)
          on conflict (subject_key) do update
            set fields = excluded.fields, version = excluded.version,
              last_changed_at = excluded.last_changed_at`;
      if (diff.remove.length)
        await tx`delete from subject_state
          where connection_id = ${row.connection_id} and subject_key in ${tx(diff.remove)}`;
    });
    return { cursor: { window_end: diff.window_end }, delivered };
  }

  /** Reads on the service's own periodic scheduling, pg-boss, once a minute. */
  async start(): Promise<void> {
    if (this.started) return;
    const boss = this.deps.triggers.jobs.boss;
    await boss.work(QUEUES.triggerPoll, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => {
      await this.runOnce();
    });
    await boss.schedule(QUEUES.triggerPoll, '* * * * *', {});
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started)
      await this.deps.triggers.jobs.boss.offWork(QUEUES.triggerPoll, { wait: false });
    this.started = false;
  }
}
